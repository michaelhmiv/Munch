import { describe, expect, test } from "bun:test";
import { evaluateRecipeAvailability } from "./matching.js";
import { scorePantryRecipe } from "./meal-planning.js";

const inventory = [
    {
        id: "1",
        name: "ground beef",
        normalized_name: "ground beef",
        quantity: 1,
        unit: "lb",
        quantity_mode: "exact" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "2",
        name: "rice",
        normalized_name: "rice",
        quantity: 2,
        unit: "cup",
        quantity_mode: "exact" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "3",
        name: "soy sauce",
        normalized_name: "soy sauce",
        quantity: null,
        unit: null,
        quantity_mode: "presence_only" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "4",
        name: "garlic",
        normalized_name: "garlic",
        quantity: null,
        unit: null,
        quantity_mode: "presence_only" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
    {
        id: "5",
        name: "ginger",
        normalized_name: "ginger",
        quantity: null,
        unit: null,
        quantity_mode: "presence_only" as const,
        stock_state: "available" as const,
        food_provider: null,
        provider_food_id: null,
    },
];

function row(input: {
    name: string;
    protein: number;
    calories?: number;
    ingredients: Array<{ name: string; optional?: boolean }>;
}) {
    return {
        recipe_id: "11111111-1111-4111-8111-111111111111",
        revision_id: "22222222-2222-4222-8222-222222222222",
        name: input.name,
        servings: 1,
        nutrition_status: "complete",
        calories_per_serving: input.calories ?? 550,
        protein_g_per_serving: input.protein,
        carbs_g_per_serving: 45,
        fat_g_per_serving: 20,
        fiber_g_per_serving: 5,
        preparation_minutes: 10,
        cooking_minutes: 20,
        ingredients: input.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: null,
            unit: null,
            optional: ingredient.optional ?? false,
            provider: null,
            provider_food_id: null,
        })),
    };
}

describe("Pantry deliberate recipe scoring", () => {
    test("rewards a coherent flavor system, not just protein grams", () => {
        const coherent = row({
            name: "Ginger soy beef bowl",
            protein: 45,
            ingredients: [
                { name: "ground beef" },
                { name: "rice" },
                { name: "soy sauce" },
                { name: "garlic" },
                { name: "ginger" },
            ],
        });
        const plain = row({
            name: "Plain beef and rice",
            protein: 50,
            ingredients: [{ name: "ground beef" }, { name: "rice" }],
        });
        const coherentAvailability = evaluateRecipeAvailability(
            coherent.ingredients,
            inventory,
        );
        const plainAvailability = evaluateRecipeAvailability(
            plain.ingredients,
            inventory,
        );
        const coherentScore = scorePantryRecipe({
            goal: "high_protein",
            row: coherent as any,
            availability: coherentAvailability,
        });
        const plainScore = scorePantryRecipe({
            goal: "high_protein",
            row: plain as any,
            availability: plainAvailability,
        });
        expect(coherentScore.flavor.coverage).toBe(1);
        expect(coherentScore.score).toBeGreaterThan(plainScore.score);
        expect(coherentScore.reasons).toContain(
            "strong seasoning/sauce support from Pantry",
        );
    });

    test("missing core ingredients outweigh optional garnish", () => {
        const garnishMissing = row({
            name: "Beef bowl",
            protein: 45,
            ingredients: [
                { name: "ground beef" },
                { name: "rice" },
                { name: "scallions", optional: true },
            ],
        });
        const proteinMissing = row({
            name: "Chicken bowl",
            protein: 55,
            ingredients: [
                { name: "chicken breast" },
                { name: "rice" },
                { name: "garlic" },
            ],
        });
        const garnishAvailability = evaluateRecipeAvailability(
            garnishMissing.ingredients,
            inventory,
        );
        const proteinAvailability = evaluateRecipeAvailability(
            proteinMissing.ingredients,
            inventory,
        );
        expect(garnishAvailability.missing_required).toHaveLength(0);
        expect(garnishAvailability.missing_optional).toEqual(["scallions"]);
        expect(proteinAvailability.missing_required).toContain("chicken breast");
        expect(
            scorePantryRecipe({
                goal: "high_protein",
                row: garnishMissing as any,
                availability: garnishAvailability,
            }).score,
        ).toBeGreaterThan(
            scorePantryRecipe({
                goal: "high_protein",
                row: proteinMissing as any,
                availability: proteinAvailability,
            }).score,
        );
    });

    test("assumed staples do not become actual Pantry claims", () => {
        const recipe = row({
            name: "Simple beef bowl",
            protein: 42,
            ingredients: [
                { name: "ground beef" },
                { name: "rice" },
                { name: "salt" },
            ],
        });
        const availability = evaluateRecipeAvailability(
            recipe.ingredients,
            inventory,
            ["salt"],
        );
        expect(availability.missing_required).toEqual([]);
        expect(availability.matched.map((match) => match.ingredient)).not.toContain(
            "salt",
        );
    });
});
