/**
 * Stored-data sweep — orchestration (audit §3).
 *
 * Pass 1 (deterministic pre-filter, `prefilter.ts`) finds suspects for
 * free; Pass 2 confirms them through the SHARED A1 checker
 * (`src/decisions/plausibility.ts`) — one batched call per suspect
 * recipe, suspects only. Deterministic flags alone never accuse data.
 *
 * HEALING RULES (the accountability line, non-negotiable):
 * - Recipes confirmed as resolver defects (the milk/flour classes:
 *   `assumed_portion_implausible`, `unresolved_in_totals`) heal ONLY
 *   through the injected heal function, which re-runs the current
 *   resolver via the existing Calculate path as a NEW revision — the
 *   old revision is never rewritten in place. The packaged-profile
 *   class (cheddar) is a provider-data/ranking defect, not a resolver
 *   defect: re-running the resolver would re-pick the same entry, so
 *   it is reported, not auto-healed.
 * - LOGGED MEALS ARE NEVER REWRITTEN. Confirmed meal findings become
 *   "check these entries" findings for the user to confirm or dismiss;
 *   this module contains no meal-write path at all.
 * - Estimates stay labeled `model_estimate` wherever the heal's
 *   resolver run uses the A2 rung (the resolver owns that labeling).
 *
 * CADENCE: `backfill` scans everything; `incremental` scans records
 * changed since the stored watermark and advances it on success.
 * `dryRun` performs Pass 1 + Pass 2 and reports projected heals while
 * writing NOTHING (no heals, no findings, no watermark move) — the
 * tests pin this.
 *
 * All persistence goes through the injected `SweepStore`, so the whole
 * orchestration is testable without a database; the production wiring
 * lives in `scripts/jev-sweep.ts`.
 */
import {
    per100gProfile,
    type PlausibilityIngredientState,
    type PlausibilityReview,
} from "../decisions/plausibility.js";
import {
    automaticNutrition,
    scanMealItem,
    scanRecipe,
    type StoredIngredientRecord,
    type StoredMealItemRecord,
    type SweepSignature,
} from "./prefilter.js";

export interface SweepRecipeRecord {
    recipeId: string;
    userId: string;
    /** Opaque ownership scope, passed through to the heal function. */
    scope: unknown;
    version: number;
    revisionId: string;
    revisionNumber: number;
    nutritionStatus: string;
    /** Per-serving totals before any heal (for the before/after line). */
    perServingBefore: Record<string, number | null>;
    ingredients: StoredIngredientRecord[];
    updatedAt: Date;
}

export interface SweepMealItemWithContext extends StoredMealItemRecord {
    itemId: string;
    mealId: string;
    userId: string;
    updatedAt: Date;
}

export interface SweepHealOutcome {
    healed: boolean;
    newRevisionId: string;
    newRevisionNumber: number;
    nutritionStatus: string;
    perServingAfter: Record<string, number | null>;
}

export type SweepFinding =
    | {
          kind: "recipe_healed";
          userId: string;
          recipeId: string;
          beforeRevisionId: string;
          afterRevisionId: string;
          confirmedIngredients: string[];
          perServingBefore: Record<string, number | null>;
          perServingAfter: Record<string, number | null>;
      }
    | {
          kind: "recipe_flagged";
          userId: string;
          recipeId: string;
          confirmedIngredients: string[];
          signatures: SweepSignature[];
      }
    | {
          kind: "meal_check";
          userId: string;
          mealId: string;
          itemId: string;
          itemName: string;
          signatures: SweepSignature[];
      };

export interface SweepStore {
    listRecipes(since: Date | null): Promise<SweepRecipeRecord[]>;
    listMealItems(since: Date | null): Promise<SweepMealItemWithContext[]>;
    /** Re-run the current resolver via the Calculate path (new revision). */
    healRecipe(input: {
        recipe: SweepRecipeRecord;
        confirmedIngredientIndexes: number[];
        idempotencyKey: string;
    }): Promise<SweepHealOutcome>;
    recordFindings(findings: SweepFinding[]): Promise<void>;
    getWatermark(): Promise<Date | null>;
    setWatermark(at: Date): Promise<void>;
}

export type PlausibilityReviewer = (
    ingredients: PlausibilityIngredientState[],
    profiles: Array<Record<string, number> | null>,
) => Promise<PlausibilityReview>;

export interface SweepReport {
    mode: "backfill" | "incremental";
    dryRun: boolean;
    scannedRecipes: number;
    scannedMealItems: number;
    suspectRecipes: number;
    suspectMealItems: number;
    suspectsBySignature: Record<string, number>;
    confirmedRecipes: number;
    confirmedMealItems: number;
    uncheckedRecipes: number;
    healedRecipes: number;
    projectedHeals: number;
    model: string | null;
    totalCostUsd: number;
    findings: SweepFinding[];
    watermarkBefore: string | null;
    watermarkAfter: string | null;
}

/** Signatures whose confirmation marks a RESOLVER defect (auto-heal). */
export const HEALABLE_SIGNATURES: ReadonlySet<SweepSignature> = new Set([
    "assumed_portion_implausible",
    "unresolved_in_totals",
]);

function ingredientState(
    ingredient: StoredIngredientRecord,
    flags: string[],
): PlausibilityIngredientState {
    const auto = automaticNutrition(ingredient);
    return {
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        resolution:
            typeof auto?.resolution === "string" ? auto.resolution : null,
        providerFoodName:
            typeof auto?.provider_food_name === "string"
                ? auto.provider_food_name
                : null,
        providerDataKind:
            typeof auto?.provider_data_kind === "string"
                ? auto.provider_data_kind
                : null,
        portionLabel:
            typeof auto?.portion_label === "string" ? auto.portion_label : null,
        gramWeight: ingredient.gramWeight,
        kcal:
            typeof ingredient.nutrients.calories === "number"
                ? ingredient.nutrients.calories
                : null,
        impliedGramsPerUnit:
            typeof auto?.implied_grams_per_unit === "number"
                ? auto.implied_grams_per_unit
                : null,
        deterministicFlags: flags,
    };
}

export async function runSweep(input: {
    mode: "backfill" | "incremental";
    dryRun: boolean;
    store: SweepStore;
    review: PlausibilityReviewer;
    now?: Date;
}): Promise<SweepReport> {
    const now = input.now ?? new Date();
    const watermarkBefore =
        input.mode === "incremental" ? await input.store.getWatermark() : null;
    const since = input.mode === "incremental" ? watermarkBefore : null;
    const recipes = await input.store.listRecipes(since);
    const mealItems = await input.store.listMealItems(since);

    const suspectsBySignature: Record<string, number> = {};
    const countSignature = (signature: SweepSignature) => {
        suspectsBySignature[signature] =
            (suspectsBySignature[signature] ?? 0) + 1;
    };

    const findings: SweepFinding[] = [];
    let suspectRecipes = 0;
    let confirmedRecipes = 0;
    let uncheckedRecipes = 0;
    let healedRecipes = 0;
    let projectedHeals = 0;
    let model: string | null = null;
    let totalCostUsd = 0;

    for (const recipe of recipes) {
        const scan = scanRecipe(recipe);
        if (!scan.suspect) continue;
        suspectRecipes += 1;
        for (const flag of scan.flagged) {
            for (const signature of flag.signatures) countSignature(signature);
        }
        for (const signature of scan.recipeLevelSignatures) {
            countSignature(signature);
        }

        // Pass 2 reviews the FLAGGED ingredients; a recipe-level-only
        // suspicion (partial, no flagged row) reviews every ingredient.
        const reviewIndexes =
            scan.flagged.length > 0
                ? scan.flagged.map((flag) => flag.index)
                : recipe.ingredients.map((_, index) => index);
        const flagsByIndex = new Map(
            scan.flagged.map((flag) => [flag.index, flag.signatures]),
        );
        const states = reviewIndexes.map((index) =>
            ingredientState(
                recipe.ingredients[index]!,
                (flagsByIndex.get(index) ?? []).map(String),
            ),
        );
        const profiles = reviewIndexes.map((index) =>
            per100gProfile(
                recipe.ingredients[index]!.nutrients,
                recipe.ingredients[index]!.gramWeight,
            ),
        );
        const review = await input.review(states, profiles);
        if (review.status !== "reviewed") {
            uncheckedRecipes += 1;
            continue;
        }
        model = review.model;
        totalCostUsd += review.reportedCostUsd ?? 0;

        const confirmedIndexes: number[] = [];
        const confirmedNames: string[] = [];
        const confirmedSignatures = new Set<SweepSignature>();
        review.verdicts.forEach((verdict, position) => {
            if (!verdict.confirmedImplausible) return;
            const recipeIndex = reviewIndexes[position]!;
            confirmedIndexes.push(recipeIndex);
            confirmedNames.push(recipe.ingredients[recipeIndex]!.name);
            for (const signature of flagsByIndex.get(recipeIndex) ?? []) {
                confirmedSignatures.add(signature);
            }
            if (scan.flagged.length === 0) {
                // Recipe-level suspicion: the confirmed row's own scan
                // signatures (none) — treat status class as unresolved.
                confirmedSignatures.add("unresolved_in_totals");
            }
        });
        if (confirmedIndexes.length === 0) continue;
        confirmedRecipes += 1;

        const healable =
            confirmedIndexes.some((recipeIndex) =>
                (flagsByIndex.get(recipeIndex) ?? []).some((signature) =>
                    HEALABLE_SIGNATURES.has(signature),
                ),
            ) || scan.flagged.length === 0;
        if (healable) {
            if (input.dryRun) {
                projectedHeals += 1;
            } else {
                const outcome = await input.store.healRecipe({
                    recipe,
                    confirmedIngredientIndexes: confirmedIndexes,
                    idempotencyKey: `jev-sweep:${recipe.recipeId}:${recipe.revisionId}`,
                });
                if (outcome.healed) {
                    healedRecipes += 1;
                    findings.push({
                        kind: "recipe_healed",
                        userId: recipe.userId,
                        recipeId: recipe.recipeId,
                        beforeRevisionId: recipe.revisionId,
                        afterRevisionId: outcome.newRevisionId,
                        confirmedIngredients: confirmedNames,
                        perServingBefore: recipe.perServingBefore,
                        perServingAfter: outcome.perServingAfter,
                    });
                }
            }
        }
        if (!healable || input.dryRun) {
            // Non-healable confirmations (cheddar class) are reported to
            // the user as flagged data, never silently dropped.
            if (!healable) {
                findings.push({
                    kind: "recipe_flagged",
                    userId: recipe.userId,
                    recipeId: recipe.recipeId,
                    confirmedIngredients: confirmedNames,
                    signatures: [...confirmedSignatures],
                });
            }
        }
    }

    // Meal items: Pass 1 + Pass 2 grouped per meal (one call per meal,
    // the meal-level analog of one call per recipe). Findings only —
    // meals are NEVER healed or rewritten.
    let suspectMealItems = 0;
    let confirmedMealItems = 0;
    const mealGroups = new Map<string, SweepMealItemWithContext[]>();
    for (const item of mealItems) {
        const { signatures } = scanMealItem(item);
        if (signatures.length === 0) continue;
        suspectMealItems += 1;
        for (const signature of signatures) countSignature(signature);
        const group = mealGroups.get(item.mealId) ?? [];
        group.push(item);
        mealGroups.set(item.mealId, group);
    }
    for (const items of mealGroups.values()) {
        const states: PlausibilityIngredientState[] = items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit: null,
            resolution: null,
            providerFoodName: null,
            providerDataKind: null,
            portionLabel: item.portionLabel,
            gramWeight: item.gramWeight,
            kcal:
                typeof item.nutrients.calories === "number"
                    ? item.nutrients.calories
                    : null,
            impliedGramsPerUnit: null,
            deterministicFlags: scanMealItem(item).signatures.map(String),
        }));
        const profiles = items.map((item) =>
            per100gProfile(item.nutrients, item.gramWeight),
        );
        const review = await input.review(states, profiles);
        if (review.status !== "reviewed") continue;
        model = review.model;
        totalCostUsd += review.reportedCostUsd ?? 0;
        review.verdicts.forEach((verdict, position) => {
            if (!verdict.confirmedImplausible) return;
            confirmedMealItems += 1;
            const item = items[position]!;
            findings.push({
                kind: "meal_check",
                userId: item.userId,
                mealId: item.mealId,
                itemId: item.itemId,
                itemName: item.name,
                signatures: scanMealItem(item).signatures,
            });
        });
    }

    let watermarkAfter: string | null = watermarkBefore?.toISOString() ?? null;
    if (!input.dryRun) {
        if (findings.length > 0) {
            await input.store.recordFindings(findings);
        }
        if (input.mode === "incremental") {
            await input.store.setWatermark(now);
            watermarkAfter = now.toISOString();
        }
    }

    return {
        mode: input.mode,
        dryRun: input.dryRun,
        scannedRecipes: recipes.length,
        scannedMealItems: mealItems.length,
        suspectRecipes,
        suspectMealItems,
        suspectsBySignature,
        confirmedRecipes,
        confirmedMealItems,
        uncheckedRecipes,
        healedRecipes,
        projectedHeals,
        model,
        totalCostUsd: Number(totalCostUsd.toFixed(6)),
        findings: input.dryRun ? findings : findings,
        watermarkBefore: watermarkBefore?.toISOString() ?? null,
        watermarkAfter,
    };
}
