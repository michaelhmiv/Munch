/**
 * B1 — receipt correlation (the model-integration brief's S3 seat,
 * re-opened by the 2026-11-13 Jev accountability audit, §2 seat B1).
 *
 * Per extracted receipt line, a Decisions-API model picks the best
 * food-database entry from the production food-search shortlist
 * (text state, S2's adapter shape — see decider.ts), and answers one
 * plausibility question: is the line's quantity/unit sane for the
 * item? The pick's probability REPLACES the extraction
 * self-confidence as the review trigger (the brief's S3 rule): the
 * caller stores it in the preview line's `confidence`, which the
 * review UI and the reconcile path already gate on at 0.85.
 *
 * FRAMING: the Nov 11 S3 probe (scripts/receipt-correlation-probe.ts,
 * PR #249) asked a strict same-food question and every model
 * abstained on rank-1 layups — Jev 50.0% vs the rank-1 baseline's
 * 95.0%, ship bar NOT met. This seat uses S2's measured best-match
 * framing instead ("select the single entry that best represents
 * the item; prefer a generic ingredient over a clearly wrong branded
 * or prepared-food match; select none only when no entry is a
 * defensible match") and was re-measured through this production
 * call shape before shipping (scripts/receipt-b1-eval.ts).
 *
 * FAIL-OPEN: every receipt line already lands in human review. When
 * the seat is off, unconfigured, or the whole Decisions chain is
 * down, `correlateReceiptLines` returns null and the caller leaves
 * the preview exactly as extraction produced it — today's
 * deterministic behaviour, zero new code on the fallback path.
 *
 * PRIVACY: the state sent is the extracted line (printed label, item
 * name, quantity, unit) plus candidate names/brands/providers —
 * food names and quantities only, the categories the privacy page
 * already discloses for decision models ("small decision models
 * (TypeSafe Jev, with Perplexity as its fallback) to check and
 * choose between food matches"). No image, name, email, or account
 * identifier is ever included.
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    receiptPickThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** TypeSafe's per-request question limit (shared with S2). Each
 * receipt line asks TWO questions (pick + plausibility), so a call
 * carries at most 4 lines. */
const MAX_QUESTIONS_PER_CALL = 8;
const LINES_PER_CALL = 4;

export interface ReceiptCandidate {
    candidateId: string;
    name: string;
    brand: string | null;
    provider: string;
    /** The provider's own food id, split out of `candidateId` by the
     * caller so a confirmed pick can be stored on the pantry line. */
    providerFoodId: string;
}

export interface ReceiptCorrelationRequest {
    key: string;
    rawLabel: string | null;
    itemName: string;
    quantity: number | null;
    unit: string | null;
    candidates: ReceiptCandidate[];
}

export interface ReceiptCorrelation {
    /** The model's raw pick, or null when it chose "none" or the
     * answer was unusable. Kept separate from the provider fields
     * below so the pick can be scored (eval) independently of the
     * filing threshold. */
    candidateId: string | null;
    /** Provider identity of the pick, set ONLY when the pick
     * probability clears the serving model's calibrated threshold.
     * Below it, no provider identity is attached to the line — it
     * is filed by name, as today. */
    provider: string | null;
    providerFoodId: string | null;
    /** Probability the model assigned to its pick (or to "none").
     * This replaces extraction self-confidence as the review
     * trigger, per the brief. */
    pickProbability: number;
    /** Probability that the line's quantity/unit are plausible for
     * the item (null when the answer was unparseable). */
    plausibilityProbability: number | null;
    /** The model that actually answered (chain fallback included). */
    model: string;
}

export interface ReceiptDeciderDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
}

export function buildReceiptQuestions(
    requests: ReceiptCorrelationRequest[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    requests.forEach((request, index) => {
        const criteria: Record<string, string> = {};
        request.candidates.forEach((candidate, candidateIndex) => {
            criteria[`c${candidateIndex}`] =
                `${candidate.name}${candidate.brand ? ` — brand: ${candidate.brand}` : ""} (source database: ${candidate.provider})`;
        });
        criteria["none"] =
            "No candidate is a defensible match for this receipt line's item.";
        questions[`q${index}`] = {
            type: "choice",
            instructions:
                `A grocery receipt line reads "${request.rawLabel ?? request.itemName}" and names the purchased item "${request.itemName}". ` +
                "Several food-database entries were found for it. Select the single entry that best represents the purchased food. " +
                'Prefer a generic ingredient over a clearly wrong branded or prepared-food match. Select "none" if no entry is a defensible match.',
            criteria,
        };
        questions[`p${index}`] = {
            type: "noul",
            instructions:
                `A grocery receipt line names the purchased item "${request.itemName}" with quantity ${request.quantity ?? "not stated"} and unit ${request.unit ?? "not stated"}. ` +
                "Is that quantity and unit plausible for this item as ordinarily sold? A missing quantity or unit is not implausible by itself.",
        };
    });
    return questions;
}

export function buildReceiptState(
    requests: ReceiptCorrelationRequest[],
): unknown {
    return {
        task: "Choose the best food-database candidate for each grocery receipt line, and judge whether each line's quantity and unit are plausible.",
        items: requests.map((request, index) => ({
            question: `q${index}`,
            plausibility_question: `p${index}`,
            receipt_line: {
                printed_label: request.rawLabel,
                item: request.itemName,
                quantity: request.quantity,
                unit: request.unit,
            },
            candidates: request.candidates.map((candidate, candidateIndex) => ({
                option: `c${candidateIndex}`,
                name: candidate.name,
                brand: candidate.brand,
                source_database: candidate.provider,
            })),
        })),
    };
}

function mapReceiptAnswers(
    requests: ReceiptCorrelationRequest[],
    answers: Record<string, unknown>,
    model: string,
): Map<string, ReceiptCorrelation> {
    const result = new Map<string, ReceiptCorrelation>();
    const pickMin = receiptPickThresholdForModel(model);
    requests.forEach((request, index) => {
        const answer = answers[`q${index}`] as Record<string, any> | undefined;
        const plausibilityProbability = noulProbability(answers[`p${index}`]);
        if (
            !answer ||
            answer.type !== "choice" ||
            typeof answer.choice !== "string"
        ) {
            return;
        }
        const pickProbability =
            typeof answer.probabilities?.[answer.choice] === "number"
                ? answer.probabilities[answer.choice]
                : typeof answer.confidence === "number"
                  ? answer.confidence
                  : 0;
        if (answer.choice === "none") {
            result.set(request.key, {
                candidateId: null,
                provider: null,
                providerFoodId: null,
                pickProbability,
                plausibilityProbability,
                model,
            });
            return;
        }
        const match = /^c(\d+)$/.exec(answer.choice);
        const candidate = match
            ? request.candidates[Number(match[1])]
            : undefined;
        // Fabrication bar (S2's rule): an option key outside the
        // request's candidate list is discarded, never honoured.
        if (!candidate) return;
        // Below the serving model's calibrated pick threshold the
        // pick is not attached: a low-confidence guess must not
        // file a provider identity into the pantry. The line still
        // carries the pick probability as its review trigger.
        const attached = pickProbability >= pickMin;
        result.set(request.key, {
            candidateId: candidate.candidateId,
            provider: attached ? candidate.provider : null,
            providerFoodId: attached ? candidate.providerFoodId : null,
            pickProbability,
            plausibilityProbability,
            model,
        });
    });
    return result;
}

/**
 * The Decisions-API implementation. Throws
 * (DecisionsChainExhaustedError) when the whole model chain is
 * down — the seat wrapper owns the terminal fallback.
 */
export async function correlateReceiptLinesViaDecisions(
    requests: ReceiptCorrelationRequest[],
    config: DecisionsConfig,
    dependencies: ReceiptDeciderDependencies = {},
): Promise<Map<string, ReceiptCorrelation>> {
    const chunks: ReceiptCorrelationRequest[][] = [];
    for (let offset = 0; offset < requests.length; offset += LINES_PER_CALL) {
        chunks.push(requests.slice(offset, offset + LINES_PER_CALL));
    }
    // Chunks are independent calls and run concurrently, exactly as
    // in S2's decider; results merge in chunk order.
    const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
            const call = await callDecisionsWithFallback(config, {
                seat: "receipt",
                timeoutMs: config.deciderTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
                state: buildReceiptState(chunk),
                questions: buildReceiptQuestions(chunk),
            });
            return mapReceiptAnswers(chunk, call.answers, call.model);
        }),
    );
    const result = new Map<string, ReceiptCorrelation>();
    for (const chunkResult of chunkResults) {
        for (const [key, correlation] of chunkResult) {
            result.set(key, correlation);
        }
    }
    return result;
}

/**
 * The wired seat: Decisions chain when enabled, otherwise null —
 * the caller leaves the preview untouched (fail-open to today's
 * deterministic behaviour). Also returns null on terminal chain
 * exhaustion, after logging the terminal fallback.
 */
export async function correlateReceiptLines(
    requests: ReceiptCorrelationRequest[],
    dependencies: ReceiptDeciderDependencies = {},
): Promise<Map<string, ReceiptCorrelation> | null> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.receiptEnabled || requests.length === 0) {
        return null;
    }
    try {
        return await correlateReceiptLinesViaDecisions(requests, config, {
            fetcher: dependencies.fetcher,
        });
    } catch (error) {
        console.info(
            `[decisions] seat=receipt event=terminal_fallback target=deterministic_preview reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return null;
    }
}
