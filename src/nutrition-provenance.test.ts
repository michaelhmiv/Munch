import { describe, expect, test } from "bun:test";
import {
    provenanceSource,
    summarizeNutritionProvenance,
    type ProvenanceItem,
} from "./nutrition-provenance.js";

function item(
    partial: Partial<ProvenanceItem> &
        Pick<ProvenanceItem, "id" | "mealId" | "name">,
): ProvenanceItem {
    return {
        sourceType: "usda",
        provider: "usda",
        sourceUrl: null,
        confidence: 0.95,
        sourceSnapshot: {},
        nutrients: {},
        ...partial,
    };
}

describe("nutrition provenance summary", () => {
    test("distinguishes external web fallback from ordinary user supplied data", () => {
        expect(
            provenanceSource(
                item({
                    id: "i1",
                    mealId: "m1",
                    name: "Branded bread",
                    sourceType: "user_supplied",
                    provider: "manufacturer_web",
                    sourceSnapshot: { resolution_layer: "external_web" },
                }),
            ),
        ).toBe("external_web");
    });

    test("reports itemized coverage, source mix, confidence, and contributors", () => {
        const summary = summarizeNutritionProvenance(
            [
                { id: "m1", description: "Lunch", calories: 500 },
                { id: "m2", description: "Legacy snack", calories: 100 },
            ],
            [
                item({
                    id: "i1",
                    mealId: "m1",
                    name: "Chicken",
                    nutrients: {
                        calories: 300,
                        protein_g: 50,
                        sodium_mg: 200,
                    },
                }),
                item({
                    id: "i2",
                    mealId: "m1",
                    name: "Rice",
                    sourceType: "model_estimate",
                    provider: null,
                    confidence: 0.7,
                    nutrients: {
                        calories: 200,
                        protein_g: 4,
                        carbs_g: 44,
                    },
                }),
            ],
        );

        expect(summary.coverage).toEqual({
            mealCount: 2,
            structuredMealCount: 1,
            legacyMealCount: 1,
            itemCount: 2,
            totalCalories: 600,
            itemizedCalories: 500,
            itemizedCaloriePercent: 83.3,
        });
        expect(summary.sources).toEqual([
            { source: "usda", itemCount: 1, calories: 300, percentOfItems: 50 },
            {
                source: "model_estimate",
                itemCount: 1,
                calories: 200,
                percentOfItems: 50,
            },
        ]);
        expect(summary.confidence).toEqual({
            recordedItemCount: 2,
            average: 0.825,
            highConfidenceItemCount: 1,
            estimatedItemCount: 1,
        });
        expect(summary.contributors.protein_g[0]?.name).toBe("Chicken");
        expect(summary.contributors.carbs_g[0]?.name).toBe("Rice");
    });
});
