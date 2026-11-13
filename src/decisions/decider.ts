/**
 * S2 — the meal-photo candidate decider (approved brief, seat S2).
 *
 * `chooseCandidatesViaDecisions` productionizes the harness adapter
 * from scripts/photo-full-eval.ts (PR #235) — the exact
 * `MealPhotoGroundingDeps.chooseCandidates` contract, the same wire
 * shape, the same answer mapping, including the fabrication bar: an
 * option key outside the request's candidate list is discarded, never
 * honoured. One Decisions call carries up to 8 Choice questions
 * (TypeSafe's per-request question limit); larger batches chunk.
 *
 * `chooseCandidatesForMealPhoto` is the seat the routes wire. With the
 * seat disabled it calls the legacy Ember chooser exactly as before —
 * byte-identical behaviour. With the seat enabled it tries the
 * Decisions chain first; on terminal chain exhaustion it logs the
 * terminal fallback and calls the legacy chooser — today's pre-existing
 * behaviour, zero new code on the fallback path (fallback law).
 */
import {
    chooseMealPhotoCandidates,
    type MealPhotoCandidateChoice,
    type MealPhotoCandidateChoiceRequest,
    type MealPhotoVisionConfig,
    type MealPhotoVisionDependencies,
} from "../meal-photo/vision.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import { decisionsConfig, type DecisionsConfig } from "./config.js";

/** TypeSafe's per-request question limit. */
const MAX_QUESTIONS_PER_CALL = 8;

export interface DecisionsDeciderDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
    /** Log/timeout seat label. Defaults to S2's "decider"; seat B2
     * (src/decisions/match.ts) passes "match" so its engagements are
     * distinguishable in the Decisions logs while riding the exact
     * same adapter, state shape, and chain. */
    seat?: "decider" | "match";
}

function buildDeciderQuestions(
    requests: MealPhotoCandidateChoiceRequest[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    requests.forEach((request, index) => {
        const criteria: Record<string, string> = {};
        request.candidates.forEach((candidate, candidateIndex) => {
            criteria[`c${candidateIndex}`] =
                `${candidate.name}${candidate.brand ? ` — brand: ${candidate.brand}` : ""} (source database: ${candidate.provider})`;
        });
        criteria["none"] =
            "No candidate is a defensible match for this photographed item.";
        questions[`q${index}`] = {
            type: "choice",
            instructions:
                `A meal photo was analysed and one photographed food item is "${request.itemName}"${request.cookingMethod ? ` (cooking method: ${request.cookingMethod})` : ""}. ` +
                "Several food-database entries were found for it. Select the single entry that best represents the photographed food. " +
                'Prefer a generic ingredient over a clearly wrong branded or prepared-food match. Select "none" if no entry is a defensible match.',
            criteria,
        };
    });
    return questions;
}

function buildDeciderState(
    requests: MealPhotoCandidateChoiceRequest[],
): unknown {
    return {
        task: "Choose the best food-database candidate for each photographed meal item.",
        items: requests.map((request, index) => ({
            question: `q${index}`,
            photographed_item: request.itemName,
            cooking_method: request.cookingMethod,
            candidates: request.candidates.map((candidate, candidateIndex) => ({
                option: `c${candidateIndex}`,
                name: candidate.name,
                brand: candidate.brand,
                source_database: candidate.provider,
            })),
        })),
    };
}

function mapDeciderAnswers(
    requests: MealPhotoCandidateChoiceRequest[],
    answers: Record<string, unknown>,
): Map<string, MealPhotoCandidateChoice> {
    const result = new Map<string, MealPhotoCandidateChoice>();
    requests.forEach((request, index) => {
        const answer = answers[`q${index}`] as Record<string, any> | undefined;
        if (
            !answer ||
            answer.type !== "choice" ||
            typeof answer.choice !== "string"
        ) {
            return;
        }
        const confidence =
            typeof answer.confidence === "number"
                ? answer.confidence
                : typeof answer.probabilities?.[answer.choice] === "number"
                  ? answer.probabilities[answer.choice]
                  : 0;
        if (answer.choice === "none") {
            result.set(request.key, {
                candidateId: null,
                confidence,
                rationale: null,
            });
            return;
        }
        const match = /^c(\d+)$/.exec(answer.choice);
        const candidate = match
            ? request.candidates[Number(match[1])]
            : undefined;
        if (!candidate) return;
        result.set(request.key, {
            candidateId: candidate.candidateId,
            confidence,
            rationale: null,
        });
    });
    return result;
}

/**
 * The Decisions-API implementation of the chooseCandidates contract.
 * Throws (DecisionsChainExhaustedError) when the whole model chain is
 * down — the seat wrapper owns the terminal fallback.
 */
export async function chooseCandidatesViaDecisions(
    requests: MealPhotoCandidateChoiceRequest[],
    config: DecisionsConfig,
    dependencies: DecisionsDeciderDependencies = {},
): Promise<Map<string, MealPhotoCandidateChoice>> {
    const chunks: MealPhotoCandidateChoiceRequest[][] = [];
    for (
        let offset = 0;
        offset < requests.length;
        offset += MAX_QUESTIONS_PER_CALL
    ) {
        chunks.push(requests.slice(offset, offset + MAX_QUESTIONS_PER_CALL));
    }
    // Chunks are independent calls (photo-latency fix, 2026-11-12):
    // they used to run sequentially, so a photo with more than
    // MAX_QUESTIONS_PER_CALL ambiguous items paid one full model
    // round trip per chunk inside draft_build. They now run
    // concurrently and merge in chunk order — the same requests,
    // the same mapping, the same result.
    const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
            const call = await callDecisionsWithFallback(config, {
                seat: dependencies.seat ?? "decider",
                timeoutMs:
                    dependencies.seat === "match"
                        ? config.matchTimeoutMs
                        : config.deciderTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
                state: buildDeciderState(chunk),
                questions: buildDeciderQuestions(chunk),
            });
            return mapDeciderAnswers(chunk, call.answers);
        }),
    );
    const result = new Map<string, MealPhotoCandidateChoice>();
    for (const chunkResult of chunkResults) {
        for (const [key, choice] of chunkResult) {
            result.set(key, choice);
        }
    }
    return result;
}

/**
 * The wired seat: Decisions chain when enabled, the legacy Ember
 * chooser when disabled or on terminal chain failure.
 */
export async function chooseCandidatesForMealPhoto(
    requests: MealPhotoCandidateChoiceRequest[],
    visionConfig: MealPhotoVisionConfig,
    dependencies: DecisionsDeciderDependencies & {
        visionDependencies?: MealPhotoVisionDependencies;
    } = {},
): Promise<Map<string, MealPhotoCandidateChoice>> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.deciderEnabled || requests.length === 0) {
        return chooseMealPhotoCandidates(
            requests,
            visionConfig,
            dependencies.visionDependencies ?? {},
        );
    }
    try {
        return await chooseCandidatesViaDecisions(requests, config, {
            fetcher: dependencies.fetcher,
        });
    } catch (error) {
        console.info(
            `[decisions] seat=decider event=terminal_fallback target=legacy_chooser reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return chooseMealPhotoCandidates(
            requests,
            visionConfig,
            dependencies.visionDependencies ?? {},
        );
    }
}
