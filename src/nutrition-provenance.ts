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
    return summarizeNutritionProvenance(normalizedMeals, items);
}

export { CONTRIBUTOR_NUTRIENTS };
