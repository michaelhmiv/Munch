import { withUserDatabase } from "./platform/database.js";
import { getMealsInRange } from "./storage.js";

const CONTRIBUTOR_NUTRIENTS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
] as const;

export type ContributorNutrient = (typeof CONTRIBUTOR_NUTRIENTS)[number];

export interface ProvenanceItem {
    id: string;
    mealId: string;
    name: string;
    sourceType: string;
    provider: string | null;
    sourceUrl: string | null;
    confidence: number | null;
    sourceSnapshot: Record<string, unknown>;
    nutrients: Partial<Record<ContributorNutrient, number | null>>;
}

export interface ProvenanceMeal {
    id: string;
    description: string;
    calories: number | null;
}

/**
 * Stored-data sweep surface (audit §3): the user-facing side of the
 * Jev sweep. `healedRecipes` backs the one visible line — "We fixed
 * the nutrition on N recipes" — with before/after per-serving totals
 * available per recipe. `checkEntries` is the "check these entries"
 * list: logged-meal items the sweep confirmed as implausible. Meals
 * are NEVER rewritten by the sweep; an entry here is a prompt for the
 * user to confirm any correction themselves.
 */
export interface SweepChecksSummary {
    healedRecipeCount: number;
    healedRecipes: Array<{
        recipeId: string;
        beforeRevisionId: string;
        afterRevisionId: string;
        confirmedIngredients: string[];
        perServingBefore: Record<string, number | null>;
        perServingAfter: Record<string, number | null>;
    }>;
    flaggedRecipes: Array<{
        recipeId: string;
        confirmedIngredients: string[];
        signatures: string[];
    }>;
    checkEntries: Array<{
        mealId: string;
        itemId: string;
        itemName: string;
        signatures: string[];
    }>;
}

export interface StoredSweepFinding {
    kind: "recipe_healed" | "recipe_flagged" | "meal_check";
    payload: Record<string, unknown>;
}

export function summarizeSweepChecks(
    findings: StoredSweepFinding[],
): SweepChecksSummary {
    const summary: SweepChecksSummary = {
        healedRecipeCount: 0,
        healedRecipes: [],
        flaggedRecipes: [],
        checkEntries: [],
    };
    for (const finding of findings) {
        const payload = finding.payload ?? {};
        if (finding.kind === "recipe_healed") {
            summary.healedRecipes.push({
                recipeId: String(payload.recipe_id ?? ""),
                beforeRevisionId: String(payload.before_revision_id ?? ""),
                afterRevisionId: String(payload.after_revision_id ?? ""),
                confirmedIngredients: Array.isArray(
                    payload.confirmed_ingredients,
                )
                    ? payload.confirmed_ingredients.map(String)
                    : [],
                perServingBefore:
                    (payload.per_serving_before as Record<
                        string,
                        number | null
                    >) ?? {},
                perServingAfter:
                    (payload.per_serving_after as Record<
                        string,
                        number | null
                    >) ?? {},
            });
        } else if (finding.kind === "recipe_flagged") {
            summary.flaggedRecipes.push({
                recipeId: String(payload.recipe_id ?? ""),
                confirmedIngredients: Array.isArray(
                    payload.confirmed_ingredients,
                )
                    ? payload.confirmed_ingredients.map(String)
                    : [],
                signatures: Array.isArray(payload.signatures)
                    ? payload.signatures.map(String)
                    : [],
            });
        } else if (finding.kind === "meal_check") {
            summary.checkEntries.push({
                mealId: String(payload.meal_id ?? ""),
                itemId: String(payload.item_id ?? ""),
                itemName: String(payload.item_name ?? ""),
                signatures: Array.isArray(payload.signatures)
                    ? payload.signatures.map(String)
                    : [],
            });
        }
    }
    summary.healedRecipeCount = summary.healedRecipes.length;
    return summary;
}

export const EMPTY_SWEEP_CHECKS: SweepChecksSummary = {
    healedRecipeCount: 0,
    healedRecipes: [],
    flaggedRecipes: [],
    checkEntries: [],
};

export interface NutritionProvenanceAnalysis {
    coverage: {
        mealCount: number;
        structuredMealCount: number;
        legacyMealCount: number;
        itemCount: number;
        totalCalories: number;
        itemizedCalories: number;
        itemizedCaloriePercent: number;
    };
    sources: Array<{
        source: string;
        itemCount: number;
        calories: number;
        percentOfItems: number;
    }>;
    confidence: {
        recordedItemCount: number;
        average: number | null;
        highConfidenceItemCount: number;
        estimatedItemCount: number;
    };
    contributors: Record<
        ContributorNutrient,
        Array<{
            mealId: string;
            itemId: string;
            name: string;
            value: number;
            source: string;
            provider: string | null;
        }>
    >;
    sweepChecks: SweepChecksSummary;
}

function finite(value: unknown): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function provenanceSource(item: ProvenanceItem): string {
    if (
        item.sourceType === "user_supplied" &&
        item.sourceSnapshot.resolution_layer === "external_web"
    ) {
        return "external_web";
    }
    return item.sourceType || "unknown";
}

export function summarizeNutritionProvenance(
    meals: ProvenanceMeal[],
    items: ProvenanceItem[],
    sweepFindings: StoredSweepFinding[] = [],
): NutritionProvenanceAnalysis {
    const itemizedMealIds = new Set(items.map((item) => item.mealId));
    const totalCalories = meals.reduce(
        (sum, meal) => sum + Math.max(0, meal.calories ?? 0),
        0,
    );
    const itemizedCalories = items.reduce(
        (sum, item) => sum + Math.max(0, item.nutrients.calories ?? 0),
        0,
    );

    const sources = new Map<string, { itemCount: number; calories: number }>();
    const confidences: number[] = [];
    let highConfidenceItemCount = 0;
    let estimatedItemCount = 0;

    for (const item of items) {
        const source = provenanceSource(item);
        const group = sources.get(source) ?? { itemCount: 0, calories: 0 };
        group.itemCount += 1;
        group.calories += Math.max(0, item.nutrients.calories ?? 0);
        sources.set(source, group);
        if (item.confidence != null && Number.isFinite(item.confidence)) {
            confidences.push(item.confidence);
            if (item.confidence >= 0.82) highConfidenceItemCount += 1;
        }
        if (source === "model_estimate") estimatedItemCount += 1;
    }

    const contributors = Object.fromEntries(
        CONTRIBUTOR_NUTRIENTS.map((nutrient) => {
            const ranked = items
                .map((item) => ({
                    mealId: item.mealId,
                    itemId: item.id,
                    name: item.name,
                    value: Math.max(0, item.nutrients[nutrient] ?? 0),
                    source: provenanceSource(item),
                    provider: item.provider,
                }))
                .filter((entry) => entry.value > 0)
                .sort((left, right) => right.value - left.value)
                .slice(0, 8);
            return [nutrient, ranked];
        }),
    ) as NutritionProvenanceAnalysis["contributors"];

    return {
        coverage: {
            mealCount: meals.length,
            structuredMealCount: itemizedMealIds.size,
            legacyMealCount: Math.max(0, meals.length - itemizedMealIds.size),
            itemCount: items.length,
            totalCalories: Number(totalCalories.toFixed(1)),
            itemizedCalories: Number(itemizedCalories.toFixed(1)),
            itemizedCaloriePercent:
                totalCalories <= 0
                    ? items.length > 0
                        ? 100
                        : 0
                    : Number(
                          Math.min(
                              100,
                              (itemizedCalories / totalCalories) * 100,
                          ).toFixed(1),
                      ),
        },
        sources: [...sources.entries()]
            .map(([source, value]) => ({
                source,
                itemCount: value.itemCount,
                calories: Number(value.calories.toFixed(1)),
                percentOfItems:
                    items.length === 0
                        ? 0
                        : Number(
                              ((value.itemCount / items.length) * 100).toFixed(
                                  1,
                              ),
                          ),
            }))
            .sort((left, right) => right.itemCount - left.itemCount),
        confidence: {
            recordedItemCount: confidences.length,
            average:
                confidences.length === 0
                    ? null
                    : Number(
                          (
                              confidences.reduce(
                                  (sum, value) => sum + value,
                                  0,
                              ) / confidences.length
                          ).toFixed(3),
                      ),
            highConfidenceItemCount,
            estimatedItemCount,
        },
        contributors,
        sweepChecks: summarizeSweepChecks(sweepFindings),
    };
}

async function loadProvenanceItems(
    userId: string,
    mealIds: string[],
): Promise<ProvenanceItem[]> {
    if (mealIds.length === 0) return [];
    const idJson = JSON.stringify(mealIds);
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<Record<string, unknown>>>`
            select
                id, meal_id, name, source_type, provider, source_url,
                confidence, source_snapshot,
                calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg
            from munch.meal_items
            where meal_id in (
                select value::uuid
                from jsonb_array_elements_text((${idJson}::text)::jsonb)
            )
            order by meal_id, position
        `;
        return rows.map((row) => ({
            id: String(row.id),
            mealId: String(row.meal_id),
            name: String(row.name),
            sourceType: String(row.source_type ?? "unknown"),
            provider: row.provider == null ? null : String(row.provider),
            sourceUrl: row.source_url == null ? null : String(row.source_url),
            confidence: finite(row.confidence),
            sourceSnapshot:
                row.source_snapshot && typeof row.source_snapshot === "object"
                    ? (row.source_snapshot as Record<string, unknown>)
                    : {},
            nutrients: {
                calories: finite(row.calories),
                protein_g: finite(row.protein_g),
                carbs_g: finite(row.carbs_g),
                fat_g: finite(row.fat_g),
                fiber_g: finite(row.fiber_g),
                sugar_g: finite(row.sugar_g),
                sodium_mg: finite(row.sodium_mg),
            },
        }));
    });
}

async function loadSweepFindings(
    userId: string,
): Promise<StoredSweepFinding[]> {
    try {
        return await withUserDatabase(userId, async (tx) => {
            const rows = await tx<Array<Record<string, unknown>>>`
                select kind, payload
                from munch.jev_sweep_findings
                where user_id = ${userId}::uuid
                  and acknowledged_at is null
                order by created_at desc
                limit 100
            `;
            return rows.map((row) => ({
                kind: String(row.kind) as StoredSweepFinding["kind"],
                payload:
                    row.payload && typeof row.payload === "object"
                        ? (row.payload as Record<string, unknown>)
                        : {},
            }));
        });
    } catch {
        // The findings table lands with migration 0030; an analysis
        // must never fail because the sweep surface is unavailable.
        return [];
    }
}

export async function getNutritionProvenanceAnalysis(
    userId: string,
    startDate: string,
    endDate: string,
    timezone: string,
): Promise<NutritionProvenanceAnalysis> {
    const meals = await getMealsInRange(userId, startDate, endDate, timezone);
    const normalizedMeals: ProvenanceMeal[] = meals.map((meal) => ({
        id: meal.id,
        description: meal.description,
        calories: meal.calories,
    }));
    const items = await loadProvenanceItems(
        userId,
        normalizedMeals.map((meal) => meal.id),
    );
    const sweepFindings = await loadSweepFindings(userId);
    return summarizeNutritionProvenance(normalizedMeals, items, sweepFindings);
}

export { CONTRIBUTOR_NUTRIENTS };
