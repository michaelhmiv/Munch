/**
 * S2 — the meal-photo candidate & portion decider (model-first
 * grounding, 2026-11-22 eval; approved brief seat S2).
 *
 * `chooseCandidatesViaDecisions` runs the Decisions-API pick call for
 * EVERY photo item (batched up to 8 Choice questions per call; larger
 * batches chunk concurrently), using the photo-grounding lane order
 * (Jev `typesafe/jev-1.14` lead, Perplexity `perplexity/pplx-decider-v1.2`
 * fallback via `photoGroundingModelOrder`). Fabrication bar: an option
 * key outside the request's candidate list is discarded, never honoured.
 *
 * `choosePortionsViaDecisions` batches portion choices for all picked
 * candidates in one call (again chunked at 8, real candidate portions
 * only). Callers validate the returned portion ID against the candidate's
 * real portion list and fall back to deterministic `resolveGroundedPortion`
 * on miss, invalid ID, or unit-kind conflict.
 *
 * `chooseCandidatesForMealPhoto` and `choosePortionsForMealPhoto` are the
 * wired seats. With the seat disabled or unconfigured, candidate selection
 * calls the legacy Ember chooser and portion selection returns empty
 * (deterministic resolution stands). On terminal Decisions chain exhaustion,
 * callers fail open safely.
 */
import {
    chooseMealPhotoCandidates,
    type MealPhotoCandidateChoice,
    type MealPhotoCandidateChoiceRequest,
    type MealPhotoPortionChoice,
    type MealPhotoPortionChoiceRequest,
    type MealPhotoVisionConfig,
    type MealPhotoVisionDependencies,
} from "../meal-photo/vision.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    photoGroundingModelOrder,
    type DecisionsConfig,
} from "./config.js";

/** TypeSafe's per-request question limit. */
const MAX_QUESTIONS_PER_CALL = 8;

/**
 * Tuned photo-grounding pick instruction (2026-11-22 eval):
 * teaches that the plain generic form of the SAME food is an
 * acceptable ground across cooking methods and minor state
 * differences (fixing Jev/Perplexity's only baseline misses on
 * fried egg and grilled chicken breast without regressing traps).
 */
export const PHOTO_GROUNDING_PICK_INSTRUCTION =
    "A food photo was analyzed and one item was identified as in the state " +
    "(name and cooking method). Choose the single candidate that is that " +
    "photographed food. Prefer the plain, generic form of the food over branded, " +
    "flavored, prepared-dish, specialty-variant, or different-food candidates. " +
    "The plain generic form of the SAME food is an acceptable ground across " +
    "cooking methods and minor state differences (for example, a fried egg " +
    "grounds to a generic whole-egg entry, and grilled chicken breast grounds " +
    "to a plain skinless chicken-breast entry). Choose none only when no " +
    "candidate is that same plain food.";

export const PHOTO_GROUNDING_PORTION_INSTRUCTION =
    "The photographed amount of the chosen food is in the state. Choose the " +
    "portion a person would most naturally log for that amount — prefer the " +
    "count or size portion that matches the amount over a volume measure " +
    "for whole foods.";

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
    seat: "decider" | "match",
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    requests.forEach((request, index) => {
        const criteria: Record<string, string> = {};
        request.candidates.forEach((candidate, candidateIndex) => {
            criteria[`c${candidateIndex}`] =
                `${candidate.name}${candidate.brand ? ` — brand: ${candidate.brand}` : ""} (source database: ${candidate.provider})`;
        });
        criteria["none"] =
            seat === "match"
                ? "No candidate is a defensible match for this photographed item."
                : "No candidate is this photographed food.";
        const instructions =
            seat === "match"
                ? `A meal photo was analysed and one photographed food item is "${request.itemName}"${request.cookingMethod ? ` (cooking method: ${request.cookingMethod})` : ""}. ` +
                  "Several food-database entries were found for it. Select the single entry that best represents the photographed food. " +
                  'Prefer a generic ingredient over a clearly wrong branded or prepared-food match. Select "none" if no entry is a defensible match.'
                : PHOTO_GROUNDING_PICK_INSTRUCTION;
        questions[`q${index}`] = {
            type: "choice",
            instructions,
            criteria,
        };
    });
    return questions;
}

function buildDeciderState(
    requests: MealPhotoCandidateChoiceRequest[],
    seat: "decider" | "match",
): unknown {
    return {
        task:
            seat === "match"
                ? "Choose the best food-database candidate for each photographed meal item."
                : "Choose the food-database candidate that is each photographed food item.",
        items: requests.map((request, index) => ({
            question: `q${index}`,
            photographed_item: request.itemName,
            cooking_method: request.cookingMethod ?? "unspecified",
            ...(request.photographedAmount
                ? { photographed_amount: request.photographedAmount }
                : {}),
            candidates: request.candidates.map((candidate, candidateIndex) => ({
                option: `c${candidateIndex}`,
                name: candidate.name,
                brand: candidate.brand,
                source_database: candidate.provider,
                ...(candidate.dataKind !== undefined
                    ? { data_kind: candidate.dataKind }
                    : {}),
                ...(candidate.defaultPortionLabel !== undefined
                    ? { default_portion: candidate.defaultPortionLabel }
                    : {}),
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

function buildPortionQuestions(
    requests: MealPhotoPortionChoiceRequest[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    requests.forEach((request, index) => {
        const criteria: Record<string, string> = {};
        request.portions.forEach((portion, portionIndex) => {
            criteria[`p${portionIndex}`] = portion.label;
        });
        questions[`q${index}`] = {
            type: "choice",
            instructions: PHOTO_GROUNDING_PORTION_INSTRUCTION,
            criteria,
        };
    });
    return questions;
}

function buildPortionState(requests: MealPhotoPortionChoiceRequest[]): unknown {
    return {
        task: "Choose the portion matching the photographed amount for each chosen food.",
        items: requests.map((request, index) => ({
            question: `q${index}`,
            food: request.foodName,
            photographed_amount: request.photographedAmount,
            portions: request.portions.map((portion, portionIndex) => ({
                option: `p${portionIndex}`,
                label: portion.label,
                gram_weight: portion.gramWeight,
                calories: portion.calories,
            })),
        })),
    };
}

function mapPortionAnswers(
    requests: MealPhotoPortionChoiceRequest[],
    answers: Record<string, unknown>,
): Map<string, MealPhotoPortionChoice> {
    const result = new Map<string, MealPhotoPortionChoice>();
    requests.forEach((request, index) => {
        const answer = answers[`q${index}`] as Record<string, any> | undefined;
        if (
            !answer ||
            answer.type !== "choice" ||
            typeof answer.choice !== "string"
        ) {
            return;
        }
        const match = /^p(\d+)$/.exec(answer.choice);
        const portion = match ? request.portions[Number(match[1])] : undefined;
        if (!portion) return;
        const confidence =
            typeof answer.confidence === "number"
                ? answer.confidence
                : typeof answer.probabilities?.[answer.choice] === "number"
                  ? answer.probabilities[answer.choice]
                  : 0;
        result.set(request.key, {
            portionId: portion.id,
            confidence,
        });
    });
    return result;
}

function photoGroundingModelsFor(config: DecisionsConfig): string[] {
    return (
        config.photoGroundingModels ?? photoGroundingModelOrder(config.models)
    );
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
    const seat = dependencies.seat ?? "decider";
    const chunks: MealPhotoCandidateChoiceRequest[][] = [];
    for (
        let offset = 0;
        offset < requests.length;
        offset += MAX_QUESTIONS_PER_CALL
    ) {
        chunks.push(requests.slice(offset, offset + MAX_QUESTIONS_PER_CALL));
    }
    const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
            const call = await callDecisionsWithFallback(config, {
                seat,
                timeoutMs:
                    seat === "match"
                        ? config.matchTimeoutMs
                        : config.deciderTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
                state: buildDeciderState(chunk, seat),
                questions: buildDeciderQuestions(chunk, seat),
                ...(seat === "decider"
                    ? { models: photoGroundingModelsFor(config) }
                    : {}),
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
 * Batched Decisions-API portion chooser for picked photo candidates.
 * Offers ONLY each candidate's real portions; discards any key outside
 * the offered list. Uses the photo-grounding lane (Jev lead, Perplexity
 * fallback).
 */
export async function choosePortionsViaDecisions(
    requests: MealPhotoPortionChoiceRequest[],
    config: DecisionsConfig,
    dependencies: DecisionsDeciderDependencies = {},
): Promise<Map<string, MealPhotoPortionChoice>> {
    const usable = requests.filter((request) => request.portions.length > 0);
    if (usable.length === 0) return new Map();
    const chunks: MealPhotoPortionChoiceRequest[][] = [];
    for (
        let offset = 0;
        offset < usable.length;
        offset += MAX_QUESTIONS_PER_CALL
    ) {
        chunks.push(usable.slice(offset, offset + MAX_QUESTIONS_PER_CALL));
    }
    const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
            const call = await callDecisionsWithFallback(config, {
                seat: "decider",
                timeoutMs: config.deciderTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
                state: buildPortionState(chunk),
                questions: buildPortionQuestions(chunk),
                models: photoGroundingModelsFor(config),
            });
            return mapPortionAnswers(chunk, call.answers);
        }),
    );
    const result = new Map<string, MealPhotoPortionChoice>();
    for (const chunkResult of chunkResults) {
        for (const [key, choice] of chunkResult) {
            result.set(key, choice);
        }
    }
    return result;
}

/**
 * The wired candidate seat: Decisions chain when enabled, the legacy
 * Ember chooser when disabled or on terminal chain failure.
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

/**
 * The wired portion seat: Decisions chain when enabled, failing open
 * to an empty map (so deterministic `resolveGroundedPortion` stands)
 * whenever the seat is disabled, unconfigured, or errors out.
 */
export async function choosePortionsForMealPhoto(
    requests: MealPhotoPortionChoiceRequest[],
    dependencies: DecisionsDeciderDependencies = {},
): Promise<Map<string, MealPhotoPortionChoice>> {
    const config =
        dependencies.config !== undefined
            ? dependencies.config
            : decisionsConfig();
    if (!config || !config.deciderEnabled || requests.length === 0) {
        return new Map();
    }
    try {
        return await choosePortionsViaDecisions(requests, config, {
            fetcher: dependencies.fetcher,
        });
    } catch (error) {
        console.info(
            `[decisions] seat=decider phase=portion event=terminal_fallback target=deterministic_portion reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return new Map();
    }
}
