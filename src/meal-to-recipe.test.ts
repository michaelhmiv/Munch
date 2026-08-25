import { describe, expect, test } from "bun:test";
import { calculateNutrition } from "./planning/repository.js";
import {
    buildMealDerivedRecipe,
    mealRecipeIdempotencyKey,
    saveMealAsRecipe,
    type MealToRecipeDependencies,
} from "./meal-to-recipe.js";
import type { StructuredMealRecord } from "./structured-meals/types.js";

const userId = "11111111-1111-4111-8111-111111111111";
const mealId = "22222222-2222-4222-8222-222222222222";

const meal: StructuredMealRecord = {
    id: mealId,
    userId,
    loggedAt: "2026-08-24T21:32:00.000Z",
    mealType: "dinner",
    description: "Ground beef, sweet potato, cottage cheese, and avocado bowl",
    calories: 840,
    proteinG: 68,
    carbsG: 54,
    fatG: 40,
    fiberG: 11,
    sugarG: 15,
    alcoholG: null,
    notes: "Photo estimate",
    idempotencyKey: "meal-key",
    sourceRecipeId: null,
    sourceRecipeRevisionId: null,
    sourcePlannedMealId: null,
    items: [
        {
            id: "33333333-3333-4333-8333-333333333331",
            mealId,
            userId,
            position: 0,
            name: "Cooked ground beef",
            quantity: 1,
            portionLabel: "about 6 oz cooked",
            gramWeight: 170,
            nutrients: { calories: 390, protein_g: 44, carbs_g: 0, fat_g: 23 },
            sourceType: "model_estimate",
            provider: "visual estimate",
            providerFoodId: null,
            providerRevision: null,
            sourceUrl: null,
            sourceUpdatedAt: null,
            confidence: 0.72,
            assumptions: ["90% lean; cooking fat unknown"],
            sourceSnapshot: { established_facts: { lean_percentage: 90 } },
            createdAt: "2026-08-24T21:32:00.000Z",
        },
        {
            id: "33333333-3333-4333-8333-333333333332",
            mealId,
            userId,
            position: 1,
            name: "Roasted sweet potato",
            quantity: 1,
            portionLabel: "about 1 cup",
            gramWeight: 180,
            nutrients: {
                calories: 180,
                protein_g: 3,
                carbs_g: 41,
                fat_g: 1,
                fiber_g: 6,
                sugar_g: 9,
            },
            sourceType: "usda",
            provider: "USDA FoodData Central",
            providerFoodId: "sweet-potato",
            providerRevision: "2026-01",
            sourceUrl: null,
            sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
            confidence: 0.95,
            assumptions: [],
            sourceSnapshot: { fdc_id: "sweet-potato" },
            createdAt: "2026-08-24T21:32:00.000Z",
        },
        {
            id: "33333333-3333-4333-8333-333333333333",
            mealId,
            userId,
            position: 2,
            name: "Cottage cheese",
            quantity: 1,
            portionLabel: "about 3/4 cup",
            gramWeight: 170,
            nutrients: {
                calories: 150,
                protein_g: 19,
                carbs_g: 7,
                fat_g: 5,
                sugar_g: 5,
            },
            sourceType: "user_supplied",
            provider: null,
            providerFoodId: null,
            providerRevision: null,
            sourceUrl: null,
            sourceUpdatedAt: null,
            confidence: 1,
            assumptions: [],
            sourceSnapshot: { entered_by_user: true },
            createdAt: "2026-08-24T21:32:00.000Z",
        },
        {
            id: "33333333-3333-4333-8333-333333333334",
            mealId,
            userId,
            position: 3,
            name: "Avocado",
            quantity: 1,
            portionLabel: "about 1/2 medium avocado",
            gramWeight: 75,
            nutrients: {
                calories: 120,
                protein_g: 2,
                carbs_g: 6,
                fat_g: 11,
                fiber_g: 5,
                sugar_g: 1,
            },
            sourceType: "model_estimate",
            provider: "visual estimate",
            providerFoodId: null,
            providerRevision: null,
            sourceUrl: null,
            sourceUpdatedAt: null,
            confidence: 0.8,
            assumptions: ["Estimated half medium avocado"],
            sourceSnapshot: {},
            createdAt: "2026-08-24T21:32:00.000Z",
        },
    ],
};

function dependenciesFor(sourceMeal: StructuredMealRecord | null) {
    const calls: Array<Record<string, unknown>> = [];
    const dependencies: MealToRecipeDependencies = {
        getMeal: async (requestUserId, requestMealId) =>
            requestUserId === userId && requestMealId === mealId
                ? sourceMeal
                : null,
        saveRecipe: async (input) => {
            calls.push(input as unknown as Record<string, unknown>);
            const nutrition = calculateNutrition(input.recipe);
            return {
                recipeId: "44444444-4444-4444-8444-444444444444",
                revisionId: "55555555-5555-4555-8555-555555555555",
                revisionNumber: 1,
                nutritionStatus: nutrition.nutritionStatus,
                totals: nutrition.totals,
                perServing: nutrition.perServing,
                deduplicated: calls.length > 1,
            };
        },
    };
    return { dependencies, calls };
}

describe("meal to recipe conversion", () => {
    test("preserves four structured items, quantities, provenance, and nutrition", () => {
        const recipe = buildMealDerivedRecipe(meal, { servings: 1 });
        expect(recipe.ingredients).toHaveLength(4);
        expect(recipe.instructions).toEqual([]);
        expect(recipe.ingredients[0]).toMatchObject({
            name: "Cooked ground beef",
            quantity: 1,
            unit: "about 6 oz cooked",
            gramWeight: 170,
            sourceType: "model_estimate",
            provider: "visual estimate",
            confidence: 0.72,
        });
        expect(recipe.ingredients[1]).toMatchObject({
            sourceType: "usda",
            provider: "USDA FoodData Central",
            providerFoodId: "sweet-potato",
        });
        expect(recipe.ingredients[2]?.sourceType).toBe("user_supplied");
        expect(recipe.ingredients[0]?.sourceSnapshot).toMatchObject({
            established_facts: { lean_percentage: 90 },
            _munch: {
                source_meal_id: mealId,
                source_meal_item_id: "33333333-3333-4333-8333-333333333331",
                source_meal_assumptions: ["90% lean; cooking fat unknown"],
            },
        });

        const nutrition = calculateNutrition(recipe);
        expect(nutrition.totals).toEqual({
            calories: 840,
            protein_g: 68,
            carbs_g: 54,
            fat_g: 40,
            fiber_g: 11,
            sugar_g: 15,
        });
        expect(nutrition.perServing).toEqual(nutrition.totals);
    });

    test("uses a server-derived stable idempotency key on retries", async () => {
        const { dependencies, calls } = dependenciesFor(meal);
        const input = {
            userId,
            mealId,
            scope: { type: "personal" as const },
        };
        const first = await saveMealAsRecipe(input, dependencies);
        const retry = await saveMealAsRecipe(input, dependencies);
        expect(first.recipeId).toBe(retry.recipeId);
        expect(retry.deduplicated).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.idempotencyKey).toBe(
            mealRecipeIdempotencyKey(mealId, { type: "personal" }),
        );
        expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    });

    test("does not expose another user's meal", async () => {
        const { dependencies } = dependenciesFor(meal);
        await expect(
            saveMealAsRecipe(
                {
                    userId: "99999999-9999-4999-8999-999999999999",
                    mealId,
                    scope: { type: "personal" },
                },
                dependencies,
            ),
        ).rejects.toThrow("Meal not found");
    });

    test("returns a clean invalid meal id error", async () => {
        const { dependencies } = dependenciesFor(meal);
        await expect(
            saveMealAsRecipe(
                {
                    userId,
                    mealId: "not-a-uuid",
                    scope: { type: "personal" },
                },
                dependencies,
            ),
        ).rejects.toThrow("Invalid meal ID");
    });

    test("rejects unstructured legacy aggregate provenance", () => {
        expect(() =>
            buildMealDerivedRecipe({
                ...meal,
                items: [
                    {
                        ...meal.items[0]!,
                        sourceType: "legacy_aggregate",
                    },
                ],
            }),
        ).toThrow("does not have recipe-safe item provenance");
    });
});
