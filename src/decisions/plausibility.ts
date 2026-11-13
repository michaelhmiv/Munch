/**
 * A1 — recipe resolution plausibility review (Jev accountability audit
 * §2 seat A1), built as ONE shared checker: the live seat (reviewing a
 * resolution at save/calculate time) and the retrospective stored-data
 * sweep (`src/jev-sweep/`) call this exact module with this exact state
 * shape, so a verdict means the same thing in both places. If the live
 * A1 seat lands separately it must consume this module rather than
 * growing a second checker.
 *
 * State per ingredient (audit §2 A1, verbatim): name, quantity, unit,
 * chosen provider food name + data kind, portion label, gram weight,
 * kcal, implied kcal/100 g and macro profile per 100 g. The sweep
 * additionally attaches the deterministic Pass-1 signature names that
 * flagged the ingredient (`deterministic_flags`); the live seat passes
 * none. ANONYMITY DISCIPLINE: the state carries ingredient names and
 * numbers ONLY — never a user name, email, account ID, recipe ID or
 * recipe title. The unit tests inspect the wire payload for this.
 *
 * ONE batched call per recipe (chunked at the Decisions per-request
 * question limit). FAIL-OPEN: any chain failure, timeout or unparseable
 * answer returns `unchecked` — a down chain never accuses data and
 * never blocks a flow. Deterministic flags alone never accuse either:
 * an ingredient is `confirmed_implausible` only when the answering
 * model's p(implausible) meets ITS OWN calibrated threshold
 * (config.ts, never borrowed across models).
 */
import { callDecisionsWithFallback, type DecisionsFetcher } from "./client.js";
import {
    plausibilityThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import { noulProbability } from "./gate.js";

/** TypeSafe's per-request question limit (shared with the decider). */
const MAX_QUESTIONS_PER_CALL = 8;

export interface PlausibilityIngredientState {
    /** Ingredient name as the user wrote it. */
    name: string;
    quantity: number | null;
    unit: string | null;
    /** Resolver outcome recorded in the snapshot, when one exists
     * (provider_match / assumed_provider_match / unresolved / …). */
    resolution: string | null;
    /** Chosen provider food name + data kind (generic / packaged). */
    providerFoodName: string | null;
    providerDataKind: string | null;
    portionLabel: string | null;
    gramWeight: number | null;
    kcal: number | null;
    /** Gram weight one requested unit implies, when recorded. */
    impliedGramsPerUnit: number | null;
    /** Deterministic Pass-1 signature names (sweep only). */
    deterministicFlags?: string[];
}

export interface PlausibilityIngredientVerdict {
    index: number;
    name: string;
    /** p(implausible) from the answering model; null on abstention. */
    pImplausible: number | null;
    confirmedImplausible: boolean;
}

export type PlausibilityReview =
    | {
          status: "reviewed";
          model: string;
          threshold: number;
          reportedCostUsd: number | null;
          verdicts: PlausibilityIngredientVerdict[];
      }
    | { status: "unchecked"; reason: string };

function round2(value: number): number {
    return Number(value.toFixed(2));
}

/** Per-100 g nutrient profile derived from stored totals + gram weight. */
export function per100gProfile(
    nutrients: Partial<Record<string, number | null | undefined>>,
    gramWeight: number | null | undefined,
): Record<string, number> | null {
    if (!gramWeight || !(gramWeight > 0)) return null;
    const profile: Record<string, number> = {};
    for (const key of [
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugar_g",
    ] as const) {
        const value = nutrients[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            profile[key] = round2((value * 100) / gramWeight);
        }
    }
    return Object.keys(profile).length > 0 ? profile : null;
}

/**
 * The A1 state shape. Pure and payload-auditable: the returned object
 * is exactly what goes on the wire as `state`.
 */
export function buildPlausibilityState(
    ingredients: PlausibilityIngredientState[],
): Record<string, unknown> {
    return {
        task: "Judge whether each ingredient's stored nutrition resolution is plausible for that food and amount.",
        ingredients: ingredients.map((ingredient, index) => {
            const profile = per100gProfile(
                { calories: ingredient.kcal },
                ingredient.gramWeight,
            );
            return {
                question: `q${index}`,
                name: ingredient.name,
                quantity: ingredient.quantity,
                unit: ingredient.unit,
                resolution: ingredient.resolution,
                provider_food_name: ingredient.providerFoodName,
                provider_data_kind: ingredient.providerDataKind,
                portion_label: ingredient.portionLabel,
                gram_weight: ingredient.gramWeight,
                kcal: ingredient.kcal,
                implied_kcal_per_100g: profile?.calories ?? null,
                implied_grams_per_unit: ingredient.impliedGramsPerUnit,
                // What the stored totals actually count for this
                // ingredient: an unresolved ingredient contributes
                // exactly zero — the fact the flour signature turns on,
                // stated explicitly because a null kcal otherwise reads
                // as "unknown" rather than "counted as zero".
                counted_in_totals_as_kcal:
                    ingredient.kcal ??
                    (ingredient.resolution === "unresolved" ? 0 : null),
                deterministic_flags: ingredient.deterministicFlags ?? [],
            };
        }),
    };
}

/**
 * State with the full macro profile per 100 g attached. The builder
 * above derives kcal/100 g from the minimal A1 fields; callers that
 * hold full stored nutrients (the sweep) use this variant so the model
 * also sees protein/carbs/fat/sugar per 100 g — the cheddar signature
 * (double-digit sugar on a hard cheese) is invisible without it.
 */
export function buildPlausibilityStateWithProfiles(
    ingredients: Array<
        PlausibilityIngredientState & {
            nutrientsPer100g: Record<string, number> | null;
        }
    >,
): Record<string, unknown> {
    const state = buildPlausibilityState(ingredients);
    const rows = state.ingredients as Array<Record<string, unknown>>;
    ingredients.forEach((ingredient, index) => {
        rows[index]!.macro_profile_per_100g = ingredient.nutrientsPer100g;
        if (ingredient.nutrientsPer100g?.calories !== undefined) {
            rows[index]!.implied_kcal_per_100g =
                ingredient.nutrientsPer100g.calories;
        }
    });
    return state;
}

export function buildPlausibilityQuestions(
    ingredients: PlausibilityIngredientState[],
): Record<string, unknown> {
    const questions: Record<string, unknown> = {};
    ingredients.forEach((ingredient, index) => {
        questions[`q${index}`] = {
            type: "noul",
            instructions:
                `Is the stored nutrition resolution for the ingredient "${ingredient.name}" implausible — meaning the numbers are wrong for this food and amount (a portion conversion that implies a physically wrong gram weight, a nutrient profile that does not fit the named food, or a material ingredient counted as zero) rather than merely unusual? ` +
                "Dense but real foods (oils, butter, honey, hard cheeses, nuts) are plausible at high kcal per 100 g. A trace seasoning or garnish counted as zero is plausible; a staple ingredient (a flour, grain, dairy, protein or fat used in a measured amount) counted as exactly zero in the totals is not.",
        };
    });
    return questions;
}

export interface PlausibilityReviewDependencies {
    fetcher?: DecisionsFetcher;
}

/**
 * Review one recipe's ingredients. Never throws. Chunks at the
 * per-request question limit; if any chunk's chain is exhausted the
 * whole review is `unchecked` (partial accusations are worse than
 * none — the sweep retries the recipe on its next pass).
 */
export async function reviewRecipePlausibility(
    ingredients: PlausibilityIngredientState[],
    config: DecisionsConfig,
    dependencies: PlausibilityReviewDependencies = {},
    profiles?: Array<Record<string, number> | null>,
): Promise<PlausibilityReview> {
    if (ingredients.length === 0) {
        return { status: "unchecked", reason: "no_ingredients" };
    }
    const verdicts: PlausibilityIngredientVerdict[] = [];
    let model = "";
    let threshold = 0;
    let reportedCostUsd: number | null = null;
    try {
        for (
            let offset = 0;
            offset < ingredients.length;
            offset += MAX_QUESTIONS_PER_CALL
        ) {
            const chunk = ingredients.slice(
                offset,
                offset + MAX_QUESTIONS_PER_CALL,
            );
            const chunkProfiles = profiles?.slice(
                offset,
                offset + MAX_QUESTIONS_PER_CALL,
            );
            const state =
                chunkProfiles !== undefined
                    ? buildPlausibilityStateWithProfiles(
                          chunk.map((ingredient, i) => ({
                              ...ingredient,
                              nutrientsPer100g: chunkProfiles[i] ?? null,
                          })),
                      )
                    : buildPlausibilityState(chunk);
            const result = await callDecisionsWithFallback(config, {
                seat: "plausibility",
                state,
                questions: buildPlausibilityQuestions(chunk),
                timeoutMs: config.plausibilityTimeoutMs,
                includeImageHeader: false,
                fetcher: dependencies.fetcher,
            });
            model = result.model;
            threshold = plausibilityThresholdForModel(result.model);
            if (result.reportedCostUsd !== null) {
                reportedCostUsd =
                    (reportedCostUsd ?? 0) + result.reportedCostUsd;
            }
            chunk.forEach((ingredient, i) => {
                const pImplausible = noulProbability(result.answers[`q${i}`]);
                verdicts.push({
                    index: offset + i,
                    name: ingredient.name,
                    pImplausible,
                    confirmedImplausible:
                        pImplausible !== null && pImplausible >= threshold,
                });
            });
        }
    } catch (error) {
        console.info(
            `[decisions] seat=plausibility status=unchecked reason=${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        );
        return { status: "unchecked", reason: "chain_exhausted" };
    }
    return { status: "reviewed", model, threshold, reportedCostUsd, verdicts };
}
