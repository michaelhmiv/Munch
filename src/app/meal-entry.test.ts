import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getFoodSearchService } from "../food-providers/service.js";
import type { FoodCandidate } from "../food-providers/types.js";
import { resolveWebMealItem, scaleNutrients } from "./meal-entry.js";

function appleCandidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "171688",
        name: "Apples, raw, with skin",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 52,
            protein_g: 0.3,
            carbs_g: 13.8,
            fat_g: 0.2,
        },
        portions: [
            {
                id: "no-cal",
                amount: 1,
                unit: "serving",
                label: "1 serving",
                gramWeight: 182,
                nutrients: {
                    protein_g: 0.5,
                    carbs_g: 25,
                    fat_g: 0.3,
                },
            },
            {
                id: "medium",
                amount: 1,
                unit: "piece",
                label: "1 medium apple",
                gramWeight: 182,
                nutrients: {
                    calories: 95,
                    protein_g: 0.5,
                    carbs_g: 25,
                    fat_g: 0.3,
                },
            },
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients: {
                    calories: 52,
                    protein_g: 0.3,
                    carbs_g: 13.8,
                    fat_g: 0.2,
                },
            },
        ],
        attribution: {
            label: "USDA FoodData Central",
            license: "CC0 / public domain",
        },
        confidence: 0.95,
        ...overrides,
    };
}

let detailsSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
    detailsSpy?.mockRestore();
    detailsSpy = null;
});

describe("web meal entry nutrition", () => {
    test("scales every reported nutrient without inventing missing values", () => {
        expect(
            scaleNutrients(
                {
                    calories: 95,
                    protein_g: 3.2,
                    sodium_mg: 140,
                },
                1.5,
            ),
        ).toEqual({
            calories: 142.5,
            protein_g: 4.8,
            sodium_mg: 210,
        });
    });

    test("rejects a non-positive scale", () => {
        expect(() => scaleNutrients({ calories: 1 }, 0)).toThrow(
            "Nutrition scale must be positive",
        );
    });
});

describe("calorie guard — never save a silent zero (W1a two-apples regression)", () => {
    test("falls back to a calorie-bearing portion of the same food when the chosen portion has no calories", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "no-cal",
            quantity: 2,
        });

        expect(item.portionLabel).toBe("1 medium apple");
        expect(item.nutrients.calories).toBe(190);
        expect(item.sourceSnapshot?.selected_portion_id).toBe("medium");
    });

    test("falls back to per-100g nutrients when all declared portions lack calories", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate({
                portions: [
                    {
                        id: "no-cal",
                        amount: 1,
                        unit: "serving",
                        label: "1 serving",
                        gramWeight: 182,
                        nutrients: { carbs_g: 25 },
                    },
                ],
                nutrientsPer100g: { calories: 52, carbs_g: 13.8 },
            }),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "no-cal",
            quantity: 2,
        });

        expect(item.portionLabel).toBe("100 g");
        expect(item.nutrients.calories).toBe(104);
        expect(item.sourceSnapshot?.selected_portion_id).toBe("100g");
    });

    test("fails loudly when neither portions nor per-100g carry calories", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate({
                portions: [
                    {
                        id: "no-cal",
                        amount: 1,
                        unit: "serving",
                        label: "1 serving",
                        gramWeight: 182,
                        nutrients: { carbs_g: 25 },
                    },
                ],
                nutrientsPer100g: { carbs_g: 13.8 },
            }),
        );

        await expect(
            resolveWebMealItem("user-1", {
                candidate_id: "usda:171688",
                portion_id: "no-cal",
                quantity: 1,
            }),
        ).rejects.toThrow("Food candidate has no usable portion with calories");
    });

    test("supplied meal item without calories fails loudly instead of saving NULL calories", async () => {
        await expect(
            resolveWebMealItem("user-1", {
                name: "Apples, raw, with skin",
                quantity: 1,
                portion_label: "1 medium apple",
                nutrients: { carbs_g: 25, fiber_g: 4.4 },
                source_type: "past_meal",
            }),
        ).rejects.toThrow(
            "Nutrition calories are required for Apples, raw, with skin",
        );
    });

    test("explicitly zero-calorie foods (e.g. black coffee, water) are still accepted", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate({
                providerFoodId: "171890",
                name: "Coffee, brewed, black",
                nutrientsPer100g: { calories: 0 },
                portions: [
                    {
                        id: "cup",
                        amount: 1,
                        unit: "cup",
                        label: "1 cup",
                        gramWeight: 237,
                        nutrients: { calories: 0 },
                    },
                ],
            }),
        );

        const candidateItem = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171890",
            portion_id: "cup",
            quantity: 1,
        });
        expect(candidateItem.nutrients.calories).toBe(0);

        const suppliedItem = await resolveWebMealItem("user-1", {
            name: "Water",
            quantity: 1,
            portion_label: "1 glass",
            nutrients: { calories: 0 },
            source_type: "user_supplied",
        });
        expect(suppliedItem.nutrients.calories).toBe(0);
    });
});
