/**
 * A1 + A2 — recipe resolution accountability (Jev accountability
 * audit 2026-11-13, §2 Tier 1; §1.4 is the hole these seats close).
 *
 * WHERE: immediately after the deterministic resolver
 * (`resolveRecipeNutrition`, src/recipe-nutrition-resolution.ts)
 * returns, on the save / calculate / heal / compose paths that
 * thread `resolutionDependencies` — the resolver invokes the
 * `resolutionReview` hook this module provides. The hook is supplied
 * by website-side callers: the host-AI boundary law keeps model
 * clients and credentials out of the MCP dependency graph, so the
 * resolver itself never imports this module. (Verified coverage,
 * including the MCP paths this does NOT reach, is documented in the
 * seat's PR.)
 *
 * A1 — plausibility review, via THE SHARED CHECKER. The state
 * builder + Decisions call live in `src/decisions/plausibility.ts`,
 * the exact module the stored-data sweep (audit §3) runs, so a
 * verdict means the same thing live and retrospectively — there is
 * no second plausibility implementation. This module's A1 work is
 * only the wiring: adapt the resolution to the shared state shape,
 * run the checker when `MUNCH_JEV_PLAUSIBILITY_ENABLED`, and store
 * flags in each flagged ingredient's `source_snapshot` alongside the
 * resolution record (model, verdict, p(implausible), threshold) —
 * the accountability trail lives with the data it judged. A flag
 * NEVER blocks the save.
 *
 * A2 — unresolved-ingredient estimate rung. Wherever resolution ends
 * `unresolved`, a batched defensibility call asks whether a clearly
 * labelled model estimate is DEFENSIBLE for that ingredient (name,
 * quantity, unit, sibling-ingredient context, failure reason, and
 * the explicit fact that it is counted in the totals as exactly
 * 0 kcal — the field the sweep found Jev needs to see the flour
 * case). When defensible, the existing generative estimate
 * machinery (meal-photo estimate seat: Ember → Luna → DeepSeek via
 * `runAiModelChain`) supplies values stored as
 * `source_type: "model_estimate"` — permanently labelled, per PR
 * #294's precedent. Jev decides; Ember estimates; neither does the
 * other's job; neither does arithmetic. An A1-flagged ingredient
 * re-runs through this same rung (a second defensibility call
 * covering only the flagged set): defensible → the labelled
 * estimate replaces the implausible values, with the original
 * resolution preserved in the snapshot; not defensible → the
 * ingredient keeps its values and its review flag — visibly marked
 * for review.
 *
 * FAIL-OPEN everywhere: flags off, no config, a down chain, an
 * unparseable answer, or a down estimate chain all leave the recipe
 * EXACTLY as the deterministic resolver produced it (verdicts are
 * logged `unchecked`). When the estimate chain is down for one
 * defensible ingredient, that ingredient stays unresolved and the
 * recipe keeps its `partial` status, which the recipe surface
 * already renders (D2's unresolved state).
 *
 * PRIVACY: the states carry ingredient names, quantities, and
 * nutrition numbers only — no name, email, account identifier, or
 * recipe title — the categories the privacy page already discloses
 * for AI features and decision-model checking. No image data;
 * allergies remain a hard code filter, untouched.
 */
import {
    estimateMealPhotoNutrients,
    type MealPhotoEstimate,
} from "../meal-photo/estimate.js";
import {
    mealPhotoVisionConfig,
    type MealPhotoVisionConfig,
    type MealPhotoVisionDependencies,
} from "../meal-photo/vision.js";
import type {
    RecipeNutritionIngredientPayload,
    RecipeNutritionResolution,
    RecipeNutrientFacts,
} from "../recipe-nutrition-resolution.js";
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    decisionsConfig,
    estimateDefensibleThresholdForModel,
    estimateRungEnabled,
    resolutionReviewTimeoutMs,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";
import {
    reviewRecipePlausibility,
    type PlausibilityIngredientState,
} from "./plausibility.js";

/** TypeSafe's per-request question limit (decider precedent). */
const MAX_QUESTIONS_PER_CALL = 8;

const RESOLVED_KINDS = new Set(["provider_match", "assumed_provider_match"]);

/**
 * The per-ingredient review state for a live resolution — the
 * resolver-side companion to the shared checker's
 * `PlausibilityIngredientState` (the sweep builds that shape from
 * stored rows; this builder produces it from a fresh resolution,
 * and `toPlausibilityIngredients` adapts one to the other so both
 * feed the identical checker).
 */
export interface ResolutionReviewIngredientState {
    /** Position of the ingredient in the recipe's ingredient list. */
    position: number;
    name: string;
    quantity: number | null;
    unit: string | null;
    /** The resolver's recorded outcome for this ingredient. */
    resolution: string;
    /** For `unresolved`: the resolver's recorded failure reason. */
    failure_reason: string | null;
    provider_food_name: string | null;
    provider_data_kind: string | null;
    portion_label: string | null;
    gram_weight: number | null;
    /** Gram weight implied for ONE stated unit (gram_weight /
     * quantity) — the milk signature lives here. */
    implied_grams_per_unit: number | null;
    calories: number | null;
    implied_kcal_per_100g: number | null;
    per_100g: {
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
        fiber_g: number | null;
        sugar_g: number | null;
        sodium_mg: number | null;
    } | null;
}

interface AutomaticNutritionRecord {
    resolution?: unknown;
    reason?: unknown;
    provider_food_name?: unknown;
    provider_data_kind?: unknown;
    portion_label?: unknown;
    implied_grams_per_unit?: unknown;
    [key: string]: unknown;
}

function automaticNutritionOf(
    ingredient: RecipeNutritionIngredientPayload,
): AutomaticNutritionRecord | null {
    const record = ingredient.source_snapshot?.automatic_nutrition;
    if (!record || typeof record !== "object") return null;
    return record as AutomaticNutritionRecord;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Build the review states for one resolution. Only ingredients the
 * resolver actually adjudicated appear: provider/assumed matches
 * (A1's subjects) and unresolved records (A2's subjects).
 * `low_impact_zero` seasonings are a deterministic zero by design —
 * there is no resolution to judge — and ingredients whose nutrition
 * the user supplied verbatim were never resolved, so neither is a
 * state.
 */
export function buildResolutionReviewStates(
    resolution: RecipeNutritionResolution,
): ResolutionReviewIngredientState[] {
    const states: ResolutionReviewIngredientState[] = [];
    resolution.recipe.ingredients.forEach((ingredient, position) => {
        const record = automaticNutritionOf(ingredient);
        if (!record) return;
        const kind = stringOrNull(record.resolution);
        if (!kind || (kind !== "unresolved" && !RESOLVED_KINDS.has(kind))) {
            return;
        }
        const gramWeight =
            typeof ingredient.gram_weight === "number" &&
            ingredient.gram_weight > 0
                ? ingredient.gram_weight
                : null;
        const calories =
            typeof ingredient.nutrients?.calories === "number"
                ? ingredient.nutrients.calories
                : null;
        let per100g: ResolutionReviewIngredientState["per_100g"] = null;
        let impliedKcalPer100g: number | null = null;
        if (gramWeight !== null && ingredient.nutrients) {
            const scale = 100 / gramWeight;
            const field = (value: number | undefined): number | null =>
                typeof value === "number" ? round2(value * scale) : null;
            per100g = {
                protein_g: field(ingredient.nutrients.protein_g),
                carbs_g: field(ingredient.nutrients.carbs_g),
                fat_g: field(ingredient.nutrients.fat_g),
                fiber_g: field(ingredient.nutrients.fiber_g),
                sugar_g: field(ingredient.nutrients.sugar_g),
                sodium_mg: field(ingredient.nutrients.sodium_mg),
            };
            impliedKcalPer100g =
                calories !== null ? round2(calories * scale) : null;
        }
        states.push({
            position,
            name: ingredient.name,
            quantity:
                typeof ingredient.quantity === "number"
                    ? ingredient.quantity
                    : null,
            unit: stringOrNull(ingredient.unit),
            resolution: kind,
            failure_reason:
                kind === "unresolved" ? stringOrNull(record.reason) : null,
            provider_food_name: stringOrNull(record.provider_food_name),
            provider_data_kind: stringOrNull(record.provider_data_kind),
            portion_label: stringOrNull(record.portion_label),
            gram_weight: gramWeight,
            implied_grams_per_unit:
                numberOrNull(record.implied_grams_per_unit) ??
                (gramWeight !== null &&
                typeof ingredient.quantity === "number" &&
                ingredient.quantity > 0
                    ? round2(gramWeight / ingredient.quantity)
                    : null),
            calories,
            implied_kcal_per_100g: impliedKcalPer100g,
            per_100g: per100g,
        });
    });
    return states;
}

/** Adapt live states to the shared checker's input shape + the
 * per-100 g profiles its WithProfiles variant carries. */
export function toPlausibilityIngredients(
    states: ResolutionReviewIngredientState[],
): {
    ingredients: PlausibilityIngredientState[];
    profiles: Array<Record<string, number> | null>;
} {
    return {
        ingredients: states.map((state) => ({
            name: state.name,
            quantity: state.quantity,
            unit: state.unit,
            resolution: state.resolution,
            providerFoodName: state.provider_food_name,
            providerDataKind: state.provider_data_kind,
            portionLabel: state.portion_label,
            gramWeight: state.gram_weight,
            kcal: state.calories,
            impliedGramsPerUnit: state.implied_grams_per_unit,
        })),
        profiles: states.map((state) => {
            if (!state.per_100g && state.implied_kcal_per_100g === null) {
                return null;
            }
            const profile: Record<string, number> = {};
            if (state.implied_kcal_per_100g !== null) {
                profile.calories = state.implied_kcal_per_100g;
            }
            if (state.per_100g) {
                for (const [key, value] of Object.entries(state.per_100g)) {
                    if (typeof value === "number") profile[key] = value;
                }
            }
            return Object.keys(profile).length > 0 ? profile : null;
        }),
    };
}

export interface DefensibilityVerdict {
    position: number;
    /** p(estimate defensible) from the answering model. */
    probability: number;
    threshold: number;
    defensible: boolean;
}

export interface DefensibilityCheckResult {
    status: "checked" | "unchecked";
    model: string | null;
    reportedCostUsd: number | null;
    verdicts: DefensibilityVerdict[];
}

function amountText(state: ResolutionReviewIngredientState): string {
    if (state.quantity === null) return "an unspecified amount";
    return state.unit ? `${state.quantity} ${state.unit}` : `${state.quantity}`;
}

function defensibilityQuestion(
    state: ResolutionReviewIngredientState,
    siblingNames: string[],
): Record<string, unknown> {
    return {
        type: "noul",
        instructions:
            `A recipe ingredient "${state.name}" (${amountText(state)}) in a recipe containing ${siblingNames.join(", ")} could not be matched to any food-database entry (failure reason: ${state.failure_reason ?? "unknown"}), so it is counted in the recipe's totals as exactly 0 kcal. ` +
            "Is a clearly labelled model estimate of this ingredient's nutrition defensible here — is the ingredient a real, identifiable food whose typical composition for the stated amount is reasonably standard, so that an estimate would be more truthful than counting it as zero? " +
            "An estimate is not defensible when the ingredient is unidentifiable, the stated amount is missing or meaningless for pricing it, or the item is so variable that any single estimate would be a fabrication.",
    };
}

/**
 * The A2 defensibility call — one batched Decisions call over the
 * given unresolved (or A1-flagged) states, chunked at the request
 * limit. Never throws: a down chain returns `unchecked`.
 */
export async function checkEstimateDefensibility(
    states: ResolutionReviewIngredientState[],
    input: {
        siblingNames: string[];
        config: DecisionsConfig;
        fetcher?: DecisionsFetcher;
    },
): Promise<DefensibilityCheckResult> {
    if (states.length === 0) {
        return {
            status: "checked",
            model: null,
            reportedCostUsd: null,
            verdicts: [],
        };
    }
    const verdicts: DefensibilityVerdict[] = [];
    let model: string | null = null;
    let reportedCostUsd: number | null = null;
    try {
        for (
            let offset = 0;
            offset < states.length;
            offset += MAX_QUESTIONS_PER_CALL
        ) {
            const chunk = states.slice(offset, offset + MAX_QUESTIONS_PER_CALL);
            const questions: Record<string, unknown> = {};
            chunk.forEach((state, index) => {
                questions[`q${index}`] = defensibilityQuestion(
                    state,
                    input.siblingNames,
                );
            });
            const call = await callDecisionsWithFallback(input.config, {
                seat: "estimate_rung",
                timeoutMs: resolutionReviewTimeoutMs(input.config),
                includeImageHeader: false,
                fetcher: input.fetcher,
                state: {
                    task: "Judge whether a labelled model estimate is defensible for each unresolved recipe ingredient.",
                    ingredients: chunk.map((state, index) => ({
                        question: `q${index}`,
                        name: state.name,
                        quantity: state.quantity,
                        unit: state.unit,
                        failure_reason: state.failure_reason,
                        // The sweep's finding, applied: an unresolved
                        // ingredient is counted as exactly zero — stated
                        // explicitly, because a null kcal otherwise
                        // reads as "unknown" and the model misses the
                        // flour-class case.
                        counted_in_totals_as_kcal: 0,
                    })),
                },
                questions,
            });
            model = call.model;
            if (call.reportedCostUsd !== null) {
                reportedCostUsd = (reportedCostUsd ?? 0) + call.reportedCostUsd;
            }
            const threshold = estimateDefensibleThresholdForModel(call.model);
            chunk.forEach((state, index) => {
                const probability = noulProbability(call.answers[`q${index}`]);
                if (probability === null) return;
                verdicts.push({
                    position: state.position,
                    probability,
                    threshold,
                    defensible: probability >= threshold,
                });
            });
        }
    } catch (error) {
        console.info(
            `[decisions] seat=estimate_rung status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return {
            status: "unchecked",
            model: null,
            reportedCostUsd: null,
            verdicts: [],
        };
    }
    return { status: "checked", model, reportedCostUsd, verdicts };
}

export interface ResolutionReviewDependencies {
    fetcher?: DecisionsFetcher;
    /** Test/drill seam: supply a config instead of reading the env. */
    config?: DecisionsConfig | null;
    /** Estimate-supply seams (A2): the generative chain's config and
     * fetcher, forwarded to the meal-photo estimate machinery. */
    estimateConfig?: MealPhotoVisionConfig | null;
    estimateFetcher?: MealPhotoVisionDependencies["fetcher"];
    /** Test/drill seam: replace the estimate supply outright. */
    estimateNutrients?: (
        requests: Array<{
            position: number;
            name: string;
            quantity: number;
            unit: string;
        }>,
    ) => Promise<Map<number, MealPhotoEstimate>>;
}

const ESTIMATE_NUTRIENT_FIELDS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
] as const;

function estimateToRecipeFacts(
    estimate: MealPhotoEstimate,
): RecipeNutrientFacts {
    const facts: RecipeNutrientFacts = {};
    for (const field of ESTIMATE_NUTRIENT_FIELDS) {
        const value = estimate.nutrients[field];
        if (typeof value === "number" && Number.isFinite(value)) {
            facts[field] = value;
        }
    }
    return facts;
}

interface EstimateCandidate {
    state: ResolutionReviewIngredientState;
    verdict: DefensibilityVerdict;
    /** The A1 record when this candidate is a flagged resolution
     * being re-run through the rung (null for unresolved A2). */
    flaggedRecord: AutomaticNutritionRecord | null;
    verdictModel: string;
    /** For flagged candidates: the A1 p(implausible) that flagged it. */
    pImplausible?: number | null;
}

/**
 * The wired A1+A2 pass — the resolver's `resolutionReview` hook.
 * Fail-open: returns the input resolution unchanged whenever the
 * seats are off, unconfigured, or the chains are down, and never
 * throws. When estimates land, the returned resolution's counts and
 * position lists are recomputed so downstream status (complete vs
 * partial) reflects them.
 */
export async function reviewRecipeResolution(
    resolution: RecipeNutritionResolution,
    dependencies: ResolutionReviewDependencies = {},
): Promise<RecipeNutritionResolution> {
    try {
        const config =
            dependencies.config !== undefined
                ? dependencies.config
                : decisionsConfig();
        if (!config) return resolution;
        const a1 = config.plausibilityEnabled === true;
        const a2 = estimateRungEnabled(config);
        if (!a1 && !a2) return resolution;

        const states = buildResolutionReviewStates(resolution);
        if (states.length === 0) return resolution;
        const siblingNames = resolution.recipe.ingredients.map(
            (ingredient) => ingredient.name,
        );

        const ingredients = resolution.recipe.ingredients.map((ingredient) => ({
            ...ingredient,
        }));
        const flaggedPositions: number[] = [];
        const flaggedPImplausible = new Map<number, number | null>();
        const estimateCandidates: EstimateCandidate[] = [];
        let reviewModel: string | null = null;
        let reviewCostUsd: number | null = null;
        // Set whenever any verdict is actually applied. When nothing
        // was reviewed (every chain unchecked), the pass returns the
        // input untouched — byte-identical fail-open.
        let modified = false;

        // A1 — the shared checker over the resolved states.
        if (a1) {
            const resolvedStates = states.filter(
                (state) => state.resolution !== "unresolved",
            );
            if (resolvedStates.length > 0) {
                const { ingredients: sharedStates, profiles } =
                    toPlausibilityIngredients(resolvedStates);
                const review = await reviewRecipePlausibility(
                    sharedStates,
                    config,
                    { fetcher: dependencies.fetcher },
                    profiles,
                );
                if (review.status === "reviewed") {
                    reviewModel = review.model;
                    reviewCostUsd = review.reportedCostUsd;
                    modified = true;
                    for (const verdict of review.verdicts) {
                        const state = resolvedStates[verdict.index]!;
                        const ingredient = ingredients[state.position]!;
                        const record = automaticNutritionOf(ingredient);
                        if (!record) continue;
                        const flagged = verdict.confirmedImplausible;
                        ingredients[state.position] = {
                            ...ingredient,
                            source_snapshot: {
                                ...(ingredient.source_snapshot ?? {}),
                                automatic_nutrition: {
                                    ...record,
                                    review: {
                                        seat: "A1",
                                        model: review.model,
                                        verdict: flagged
                                            ? "flagged"
                                            : "plausible",
                                        p_implausible: verdict.pImplausible,
                                        threshold: review.threshold,
                                    },
                                },
                            },
                        };
                        if (flagged) {
                            flaggedPositions.push(state.position);
                            flaggedPImplausible.set(
                                state.position,
                                verdict.pImplausible,
                            );
                        }
                    }
                }
            }
        }

        if (a2) {
            // A2 — defensibility for the unresolved states.
            const unresolvedStates = states.filter(
                (state) => state.resolution === "unresolved",
            );
            const defensibility = await checkEstimateDefensibility(
                unresolvedStates,
                {
                    siblingNames,
                    config,
                    fetcher: dependencies.fetcher,
                },
            );
            if (defensibility.status === "checked" && defensibility.model) {
                if (defensibility.verdicts.length > 0) modified = true;
                for (const verdict of defensibility.verdicts) {
                    const state = unresolvedStates.find(
                        (entry) => entry.position === verdict.position,
                    )!;
                    if (verdict.defensible) {
                        estimateCandidates.push({
                            state,
                            verdict,
                            flaggedRecord: null,
                            verdictModel: defensibility.model,
                        });
                    } else {
                        // Jev says no estimate is defensible: stays
                        // unresolved, verdict surfaced in the snapshot.
                        const ingredient = ingredients[state.position]!;
                        const record = automaticNutritionOf(ingredient);
                        if (!record) continue;
                        ingredients[state.position] = {
                            ...ingredient,
                            source_snapshot: {
                                ...(ingredient.source_snapshot ?? {}),
                                automatic_nutrition: {
                                    ...record,
                                    review: {
                                        seat: "A2",
                                        model: defensibility.model,
                                        verdict: "estimate_not_defensible",
                                        probability: verdict.probability,
                                        threshold: verdict.threshold,
                                    },
                                },
                            },
                        };
                    }
                }
            }

            // A1-flagged ingredients re-run through the rung: one
            // defensibility call covering only the flagged set.
            if (flaggedPositions.length > 0) {
                const flaggedStates = states
                    .filter((state) =>
                        flaggedPositions.includes(state.position),
                    )
                    .map((state) => ({
                        ...state,
                        failure_reason: "a1_plausibility_flag",
                    }));
                const rerun = await checkEstimateDefensibility(flaggedStates, {
                    siblingNames,
                    config,
                    fetcher: dependencies.fetcher,
                });
                if (rerun.status === "checked" && rerun.model) {
                    for (const verdict of rerun.verdicts) {
                        if (!verdict.defensible) continue;
                        const state = flaggedStates.find(
                            (entry) => entry.position === verdict.position,
                        )!;
                        const record = automaticNutritionOf(
                            ingredients[state.position]!,
                        );
                        estimateCandidates.push({
                            state,
                            verdict,
                            flaggedRecord: record,
                            verdictModel: rerun.model,
                            pImplausible: flaggedPImplausible.get(
                                state.position,
                            ),
                        });
                    }
                }
            }
        }

        if (!modified) return resolution;

        // Estimate supply: ONE batched generative call for every
        // defensible candidate that carries a priceable amount.
        const priceable = estimateCandidates.filter(
            (candidate) =>
                candidate.state.quantity !== null &&
                candidate.state.quantity > 0,
        );
        if (priceable.length > 0) {
            let estimates: Map<number, MealPhotoEstimate> | null = null;
            try {
                if (dependencies.estimateNutrients) {
                    estimates = await dependencies.estimateNutrients(
                        priceable.map((candidate) => ({
                            position: candidate.state.position,
                            name: candidate.state.name,
                            quantity: candidate.state.quantity!,
                            unit: candidate.state.unit ?? "",
                        })),
                    );
                } else {
                    const visionConfig =
                        dependencies.estimateConfig !== undefined
                            ? dependencies.estimateConfig
                            : mealPhotoVisionConfig();
                    if (visionConfig) {
                        const byKey = await estimateMealPhotoNutrients(
                            priceable.map((candidate) => ({
                                key: String(candidate.state.position),
                                name: candidate.state.name,
                                cookingMethod: null,
                                quantity: candidate.state.quantity!,
                                unit: candidate.state.unit ?? "",
                                assumptions: [
                                    `Recipe ingredients: ${siblingNames.join(", ")}. This ingredient's provider resolution was ${candidate.flaggedRecord ? "flagged as implausible by review" : `unresolved (${candidate.state.failure_reason ?? "no match"})`}; this labelled model estimate replaces it.`,
                                ],
                                gramWeightNeeded: true,
                            })),
                            visionConfig,
                            { fetcher: dependencies.estimateFetcher },
                        );
                        estimates = new Map(
                            [...byKey.entries()].map(([key, value]) => [
                                Number(key),
                                value,
                            ]),
                        );
                    }
                }
            } catch (error) {
                console.info(
                    `[decisions] seat=estimate_rung status=estimate_chain_unavailable reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
                );
                estimates = null;
            }
            if (estimates) {
                for (const candidate of priceable) {
                    const estimate = estimates.get(candidate.state.position);
                    if (!estimate) continue;
                    const facts = estimateToRecipeFacts(estimate);
                    if (facts.calories === undefined) continue;
                    const ingredient = ingredients[candidate.state.position]!;
                    const record = automaticNutritionOf(ingredient) ?? {};
                    ingredients[candidate.state.position] = {
                        ...ingredient,
                        gram_weight:
                            estimate.gramWeight ?? ingredient.gram_weight,
                        nutrients: facts,
                        provider: undefined,
                        provider_food_id: undefined,
                        source_type: "model_estimate",
                        source_url: undefined,
                        confidence: Math.max(ingredient.confidence ?? 0, 0.5),
                        source_snapshot: {
                            ...(ingredient.source_snapshot ?? {}),
                            automatic_nutrition: {
                                ...record,
                                resolution: "model_estimate",
                                estimated: true,
                                estimate_source: "generative_chain",
                                ...(candidate.flaggedRecord
                                    ? {
                                          replaced_resolution:
                                              candidate.flaggedRecord
                                                  .resolution ?? null,
                                          replaced_provider_food_name:
                                              candidate.flaggedRecord
                                                  .provider_food_name ?? null,
                                      }
                                    : {
                                          unresolved_reason:
                                              candidate.state.failure_reason,
                                      }),
                                review: {
                                    seat: candidate.flaggedRecord
                                        ? "A1+A2"
                                        : "A2",
                                    model: candidate.verdictModel,
                                    verdict: "estimate_defensible",
                                    probability: candidate.verdict.probability,
                                    threshold: candidate.verdict.threshold,
                                    ...(candidate.flaggedRecord
                                        ? {
                                              p_implausible:
                                                  candidate.pImplausible ??
                                                  null,
                                          }
                                        : {}),
                                },
                            },
                        },
                    };
                }
            }
        }

        // Recompute the resolution tallies so downstream status sees
        // estimates as resolved (labelled) and flags are reported.
        let unresolved = 0;
        const unresolvedPositions: number[] = [];
        const estimatedPositions = [...resolution.estimatedPositions];
        ingredients.forEach((ingredient, position) => {
            const record = automaticNutritionOf(ingredient);
            if (record && record.resolution === "unresolved") {
                unresolved += 1;
                unresolvedPositions.push(position);
            }
            if (
                record &&
                record.resolution === "model_estimate" &&
                !estimatedPositions.includes(position)
            ) {
                estimatedPositions.push(position);
            }
        });
        const modelEstimates = estimatedPositions.filter((position) =>
            resolution.unresolvedPositions.includes(position),
        ).length;
        console.info(
            `[decisions] seat=resolution_review status=reviewed model=${reviewModel ?? "none"} flagged=${flaggedPositions.length} model_estimates=${modelEstimates} cost_usd=${reviewCostUsd ?? "null"}`,
        );
        return {
            ...resolution,
            recipe: { ...resolution.recipe, ingredients },
            unresolved,
            unresolvedPositions,
            estimatedPositions,
            modelEstimates,
            flaggedReviewPositions: flaggedPositions,
        };
    } catch (error) {
        console.info(
            `[decisions] seat=resolution_review status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
        return resolution;
    }
}
