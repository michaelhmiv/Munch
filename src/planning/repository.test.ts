import { describe, expect, test } from "bun:test";
import {
    calculateNutrition,
    recipeMealItems,
    recipeMealItemsForShare,
    scaleNutrients,
    validateRecipe,
    type RecipeInput,
} from "./repository.js";
import type { RecipePortionRecord } from "./recipe-yield.js";

const lunchRecipe: RecipeInput = {
    name: "My Peanut Butter Sandwich Lunch",
    servings: 1,
    instructions: [],
    sourceType: "user_entered",
    ingredients: [
        {
            name: "Simply Nature Graintastic Organic Bread",
            quantity: 2,
            unit: "slices",
            nutrients: {
                calories: 140,
                protein_g: 6,
                carbs_g: 26,
                fat_g: 2,
            },
            sourceType: "saved_food",
            sourceSnapshot: { saved_food_id: "bread" },
        },
        {
            name: "Simply Nature Organic Creamy Peanut Butter",
            quantity: 4,
            unit: "tbsp",
            nutrients: {
                calories: 480,
                protein_g: 16,
                carbs_g: 14,
                fat_g: 32,
            },
            sourceType: "saved_food",
            sourceSnapshot: { saved_food_id: "peanut-butter" },
        },
        {
            name: "Chia seeds",
            quantity: 2,
            unit: "tbsp",
            nutrients: {
                calories: 118,
                protein_g: 8.7,
                carbs_g: 27.9,
                fat_g: 9.7,
            },
            sourceType: "user_supplied",
            sourceSnapshot: { entered_by_user: true },
        },
    ],
};

describe("recipe nutrition primitives", () => {
    test("calculates stored total and per-serving nutrition", () => {
        expect(calculateNutrition(lunchRecipe)).toEqual({
            totals: {
                calories: 738,
                protein_g: 30.7,
                carbs_g: 67.9,
                fat_g: 43.7,
            },
            perServing: {
                calories: 738,
                protein_g: 30.7,
                carbs_g: 67.9,
                fat_g: 43.7,
            },
            nutritionStatus: "complete",
        });
    });

    test("scales every saved nutrient without re-estimating it", () => {
        expect(
            scaleNutrients(
                {
                    calories: 380,
                    protein_g: 16,
                    carbs_g: 14,
                    fat_g: 32,
                },
                0.5,
            ),
        ).toEqual({
            calories: 190,
            protein_g: 8,
            carbs_g: 7,
            fat_g: 16,
        });
    });

    test("rejects non-finite recipe quantities and oversize snapshots", () => {
        expect(() =>
            validateRecipe({
                ...lunchRecipe,
                ingredients: [
                    {
                        ...lunchRecipe.ingredients[0]!,
                        quantity: Number.NaN,
                    },
                ],
            }),
        ).toThrow("Recipe ingredient quantity must be positive");

        expect(() =>
            validateRecipe({
                ...lunchRecipe,
                ingredients: [
                    {
                        ...lunchRecipe.ingredients[0]!,
                        sourceSnapshot: { raw: "x".repeat(50_001) },
                    },
                ],
            }),
        ).toThrow("Recipe source snapshot is too large");
    });
});

describe("recipe yields and share-based meal items (unit logging)", () => {
    test("validateRecipe accepts yields in their slots and rejects cross-family yields", () => {
        expect(() =>
            validateRecipe({
                ...lunchRecipe,
                yieldVolume: { quantity: 12, unit: "cups" },
                yieldWeight: { quantity: 1800, unit: "g" },
            }),
        ).not.toThrow();
        expect(() =>
            validateRecipe({
                ...lunchRecipe,
                yieldVolume: { quantity: 12, unit: "g" },
            }),
        ).toThrow(/volume yield/);
        expect(() =>
            validateRecipe({
                ...lunchRecipe,
                yieldWeight: { quantity: 0, unit: "g" },
            }),
        ).toThrow(/positive/);
    });

    const storedRecipe = {
        id: "11111111-1111-4111-8111-111111111111",
        revision_id: "22222222-2222-4222-8222-222222222222",
        revision_number: 2,
        servings: 12,
        nutrition_total: { calories: 5960 },
        nutrition_per_serving: { calories: 496.67 },
        ingredients: [
            {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Whole milk",
                quantity: 3,
                unit: "cup",
                preparation: null,
                gram_weight: 732,
                nutrients: { calories: 446.52 },
                provider: "usda",
                provider_food_id: "2705385",
                source_type: "usda",
                source_url: null,
                confidence: null,
                source_snapshot: {},
            },
            {
                id: "44444444-4444-4444-8444-444444444444",
                name: "Elbow macaroni",
                quantity: 1,
                unit: "lb",
                preparation: null,
                gram_weight: 453.59,
                nutrients: { calories: 1619.32 },
                provider: "usda",
                provider_food_id: "2044931",
                source_type: "usda",
                source_url: null,
                confidence: null,
                source_snapshot: {},
            },
        ],
    } as unknown as Parameters<typeof recipeMealItems>[0];

    test("share-based items are identical to the servings path at the same share", () => {
        const byShare = recipeMealItemsForShare(storedRecipe, 1 / 12);
        const byServings = recipeMealItems(storedRecipe, 1);
        expect(byShare).toEqual(byServings);
        expect(byShare[0]?.nutrients.calories).toBe(37.21);
        expect(byShare[0]?.gramWeight).toBe(61);
        // No portion record rides along for the legacy construction path.
        expect(byShare[0]?.sourceSnapshot).not.toHaveProperty("recipe_portion");
    });

    test("the portion record is stamped into every item snapshot", () => {
        const record: RecipePortionRecord = {
            mode: "amount",
            entered_amount: 1,
            entered_unit: "cup",
            fraction_numerator: null,
            fraction_denominator: null,
            share: 0.083333,
            yield_snapshot: {
                quantity: 12,
                unit: "cup",
                family: "volume",
                source: "set",
            },
            servings_equivalent: 1,
        };
        const items = recipeMealItemsForShare(storedRecipe, 1 / 12, record);
        expect(items).toHaveLength(2);
        for (const item of items) {
            expect(item.sourceSnapshot?.recipe_portion).toEqual(record);
        }
    });
});
