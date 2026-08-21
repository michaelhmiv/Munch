import { describe, expect, test } from "bun:test";
import { recipeComposeInputFromBody, recipeInputFromBody } from "./routes.js";

describe("website recipe input", () => {
    test("maps the structured form payload to canonical recipe input", () => {
        expect(
            recipeInputFromBody({
                name: "Overnight oats",
                servings: "2",
                description: "A make-ahead breakfast",
                instructions: ["Mix", "Chill"],
                preparation_minutes: "5",
                cooking_minutes: 0,
                source_type: "user_entered",
                source_title: "Kitchen notes",
                source_url: "https://example.com/oats",
                ingredients: [
                    {
                        name: "Rolled oats",
                        quantity: "1",
                        unit: "cup",
                        preparation: "",
                        optional: false,
                        nutrients: { calories: 300, protein_g: 10 },
                        source_type: "usda",
                        provider: "usda",
                        provider_food_id: "123",
                        source_url: "https://example.com/food",
                        confidence: 0.9,
                        source_snapshot: { candidate_id: "usda:123" },
                    },
                ],
            }),
        ).toEqual({
            name: "Overnight oats",
            servings: 2,
            description: "A make-ahead breakfast",
            instructions: ["Mix", "Chill"],
            preparationMinutes: 5,
            cookingMinutes: 0,
            sourceType: "user_entered",
            sourceTitle: "Kitchen notes",
            sourceUrl: "https://example.com/oats",
            ingredients: [
                {
                    name: "Rolled oats",
                    quantity: 1,
                    unit: "cup",
                    preparation: "",
                    optional: false,
                    gramWeight: undefined,
                    nutrients: { calories: 300, protein_g: 10 },
                    provider: "usda",
                    providerFoodId: "123",
                    sourceType: "usda",
                    sourceUrl: "https://example.com/food",
                    confidence: 0.9,
                    sourceSnapshot: { candidate_id: "usda:123" },
                },
            ],
        });
    });

    test("rejects malformed recipe sections", () => {
        expect(() =>
            recipeInputFromBody({
                name: "Incomplete",
                servings: 2,
                instructions: [],
                source_type: "unknown",
                ingredients: "not an array",
            }),
        ).toThrow("Recipe ingredients are required");
    });

    test("maps the atomic recipe compose payload", () => {
        const result = recipeComposeInputFromBody({
            planned_date: "2026-08-24",
            meal_slot: "dinner",
            planned_servings: "2",
            note: "Use the fresh basil",
            grocery_items_needed: [
                {
                    name: "Fresh basil",
                    quantity: "1",
                    unit: "bunch",
                    note: "Only if not on hand",
                },
            ],
            recipe: {
                name: "Tomato pasta",
                servings: 2,
                instructions: ["Cook"],
                source_type: "user_entered",
                ingredients: [
                    {
                        name: "Pasta",
                        quantity: 8,
                        unit: "oz",
                        source_type: "user_supplied",
                    },
                ],
            },
        });

        expect(result.plannedDate).toBe("2026-08-24");
        expect(result.mealSlot).toBe("dinner");
        expect(result.plannedServings).toBe(2);
        expect(result.note).toBe("Use the fresh basil");
        expect(result.groceryItems).toEqual([
            {
                name: "Fresh basil",
                quantity: 1,
                unit: "bunch",
                note: "Only if not on hand",
                foodProvider: undefined,
                providerFoodId: undefined,
                sourceRecipeId: undefined,
                sourceRecipeRevisionId: undefined,
                sourcePlannedMealId: undefined,
                idempotencyKey: undefined,
            },
        ]);
    });

    test("rejects an invalid compose schedule", () => {
        expect(() =>
            recipeComposeInputFromBody({
                planned_date: "tomorrow",
                planned_servings: 1,
                grocery_items_needed: [],
                recipe: {
                    name: "Pasta",
                    servings: 1,
                    instructions: ["Cook"],
                    source_type: "user_entered",
                    ingredients: [
                        { name: "Pasta", source_type: "user_supplied" },
                    ],
                },
            }),
        ).toThrow("Planned date is required");
    });
});
