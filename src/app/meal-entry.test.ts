import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getFoodSearchService } from "../food-providers/service.js";
import type { FoodCandidate } from "../food-providers/types.js";
import type { RecentMealItemMemory } from "../saved-foods/repository.js";
import * as mealEntry from "./meal-entry.js";
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

describe("recents re-add parity — quantity and per-quantity nutrients (W2 Finding 1)", () => {
    // Lead fail-before test for Finding 1: a recent logged at quantity
    // 2 stores quantity-scaled totals (300 kcal). The serializer must
    // emit the logged quantity AND per-quantity nutrients (150 kcal),
    // so the composer prefill (quantity 2 × per-quantity 150) and the
    // server rescale land back on 300 — never 600. Accessed via the
    // module namespace: on unmodified main serializeRecentMealItem is
    // not exported (and emits no quantity), which is the fail-before.
    const serializeRecentMealItem = (mealEntry as Record<string, unknown>)
        .serializeRecentMealItem as
        | ((record: RecentMealItemMemory) => {
              quantity: number;
              nutrients: Record<string, number>;
              name: string;
              portionLabel: string | null;
          })
        | undefined;

    const yogurtRecent: RecentMealItemMemory = {
        mealId: "m1",
        itemId: "i1",
        name: "Greek yogurt",
        quantity: 2,
        portionLabel: "1 cup",
        nutrients: { calories: 300, protein_g: 20, carbs_g: 16, fat_g: 8 },
        sourceType: "usda",
        provider: "usda",
        providerFoodId: "123",
        confidence: 0.95,
        loggedAt: "2026-11-10T12:00:00.000Z",
    };

    test("a recent originally logged at quantity 2 re-added at quantity 2 saves the original total, and at quantity 1 saves the per-quantity value", async () => {
        expect(typeof serializeRecentMealItem).toBe("function");
        const serialized = serializeRecentMealItem!(yogurtRecent);
        expect(serialized.quantity).toBe(2);
        expect(serialized.nutrients).toEqual({
            calories: 150,
            protein_g: 10,
            carbs_g: 8,
            fat_g: 4,
        });

        const atTwo = await resolveWebMealItem("user-1", {
            name: serialized.name,
            quantity: 2,
            portion_label: serialized.portionLabel,
            nutrients: serialized.nutrients,
            source_type: "past_meal",
        });
        expect(atTwo.nutrients).toEqual({
            calories: 300,
            protein_g: 20,
            carbs_g: 16,
            fat_g: 8,
        });

        const atOne = await resolveWebMealItem("user-1", {
            name: serialized.name,
            quantity: 1,
            portion_label: serialized.portionLabel,
            nutrients: serialized.nutrients,
            source_type: "past_meal",
        });
        expect(atOne.nutrients).toEqual({
            calories: 150,
            protein_g: 10,
            carbs_g: 8,
            fat_g: 4,
        });
    });

    test("handles null/missing and fractional logged quantities cleanly", async () => {
        expect(typeof serializeRecentMealItem).toBe("function");
        const nullQuantity = serializeRecentMealItem!({
            ...yogurtRecent,
            quantity: null,
            nutrients: { calories: 300 },
        });
        expect(nullQuantity.quantity).toBe(1);
        expect(nullQuantity.nutrients).toEqual({ calories: 300 });

        const half = serializeRecentMealItem!({
            ...yogurtRecent,
            quantity: 0.5,
            nutrients: { calories: 75 },
        });
        expect(half.quantity).toBe(0.5);
        expect(half.nutrients).toEqual({ calories: 150 });

        const atHalf = await resolveWebMealItem("user-1", {
            name: half.name,
            quantity: 0.5,
            portion_label: half.portionLabel,
            nutrients: half.nutrients,
            source_type: "past_meal",
        });
        expect(atHalf.nutrients.calories).toBe(75);
        const atOne = await resolveWebMealItem("user-1", {
            name: half.name,
            quantity: 1,
            portion_label: half.portionLabel,
            nutrients: half.nutrients,
            source_type: "past_meal",
        });
        expect(atOne.nutrients.calories).toBe(150);
    });
});

describe("custom portion gram weight (W2 logging math Finding 2)", () => {
    test("custom portion gram weight at half the listed portion logs half the nutrients", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "medium",
            quantity: 1,
            portion_label: "Half apple",
            gram_weight: 91,
        });

        expect(item.nutrients).toEqual({
            calories: 47.5,
            protein_g: 0.25,
            carbs_g: 12.5,
            fat_g: 0.15,
        });
        expect(item.gramWeight).toBe(91);
        expect(item.portionLabel).toBe("Half apple");
        expect(item.sourceSnapshot?.resolution_layer).toBe(
            "food_search_custom_portion",
        );
        expect(item.sourceSnapshot?.custom_gram_weight).toBe(91);
        expect(item.sourceSnapshot?.selected_portion_id).toBe("medium");
        expect(item.sourceSnapshot?.selected_portion_gram_weight).toBe(182);
    });

    test("custom portion gram weight multiplies cleanly with quantity > 1 without double rounding", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "medium",
            quantity: 2,
            gram_weight: 91,
        });

        expect(item.nutrients.calories).toBe(95);
        expect(item.gramWeight).toBe(182);
        // No custom label was supplied, so the gram weight names the portion.
        expect(item.portionLabel).toBe("91 g");
    });

    test("custom portion falls back to nutrientsPer100g when chosen portion has no gramWeight", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate({
                portions: [
                    {
                        id: "blob",
                        amount: 1,
                        unit: "serving",
                        label: "1 serving",
                        nutrients: { calories: 60, carbs_g: 15 },
                    },
                ],
                nutrientsPer100g: { calories: 52, carbs_g: 13.8 },
            }),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "blob",
            quantity: 1,
            gram_weight: 50,
        });

        expect(item.nutrients).toEqual({ calories: 26, carbs_g: 6.9 });
        expect(item.gramWeight).toBe(50);
        expect(item.sourceSnapshot?.custom_gram_weight).toBe(50);
    });

    test("custom portion with label only (no gram_weight) preserves portion nutrients and uses custom label", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "medium",
            quantity: 1,
            portion_label: "My apple",
        });

        expect(item.nutrients.calories).toBe(95);
        expect(item.gramWeight).toBe(182);
        expect(item.portionLabel).toBe("My apple");
        expect(item.sourceSnapshot?.resolution_layer).toBe(
            "food_search_custom_portion",
        );
        expect(item.sourceSnapshot?.custom_gram_weight).toBeUndefined();
    });

    test("non-positive custom gram_weight fails loudly", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        await expect(
            resolveWebMealItem("user-1", {
                candidate_id: "usda:171688",
                portion_id: "medium",
                quantity: 1,
                gram_weight: 0,
            }),
        ).rejects.toThrow("Meal item gram weight must be positive");
        await expect(
            resolveWebMealItem("user-1", {
                candidate_id: "usda:171688",
                portion_id: "medium",
                quantity: 1,
                gram_weight: -50,
            }),
        ).rejects.toThrow("Meal item gram weight must be positive");
    });

    test("non-custom candidate items keep their source snapshot unchanged", async () => {
        detailsSpy = spyOn(getFoodSearchService(), "details").mockResolvedValue(
            appleCandidate(),
        );

        const item = await resolveWebMealItem("user-1", {
            candidate_id: "usda:171688",
            portion_id: "medium",
            quantity: 1,
        });

        expect(item.sourceSnapshot?.resolution_layer).toBe("food_search");
        expect(
            item.sourceSnapshot?.selected_portion_gram_weight,
        ).toBeUndefined();
        expect(item.sourceSnapshot?.custom_gram_weight).toBeUndefined();
    });
});
