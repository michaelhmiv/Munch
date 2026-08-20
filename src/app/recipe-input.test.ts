import { describe, expect, test } from "bun:test";
import { recipeInputFromBody } from "./routes.js";

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
});
