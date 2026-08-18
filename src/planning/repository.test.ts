import { describe, expect, test } from "bun:test";
import {
    calculateNutrition,
    scaleNutrients,
    validateRecipe,
    type RecipeInput,
} from "./repository.js";

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
