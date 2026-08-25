import { describe, expect, test } from "bun:test";
import {
    pantryPlanningModelConfig,
    validateMealIdeaGrounding,
    type PantryMealIdeasResponse,
} from "./meal-ideas.js";

const context = {
    request: {
        goal: "high_protein" as const,
        meal_type: "dinner",
        servings: 2,
        max_minutes: 45,
        allow_missing_items: 1,
        assumed_staples: ["salt", "black pepper"],
    },
    pantry: [
        {
            name: "ground beef",
            quantity: 1,
            unit: "lb",
            quantity_mode: "exact",
            stock_state: "available",
            location: "fridge",
            category: "protein",
            culinary_roles: ["protein", "main"],
            nutrition_basis: {
                quantity: 100,
                unit: "g",
                grams: 100,
                calories: 200,
                protein_g: 26,
                carbs_g: 0,
                fat_g: 10,
                fiber_g: 0,
                sugar_g: 0,
                sodium_mg: 70,
                status: "resolved",
            },
        },
        {
            name: "smoked paprika",
            quantity: null,
            unit: null,
            quantity_mode: "presence_only",
            stock_state: "available",
            location: "pantry",
            category: "spice",
            culinary_roles: ["seasoning", "smoky"],
            nutrition_basis: {
                quantity: null,
                unit: null,
                grams: null,
                calories: null,
                protein_g: null,
                carbs_g: null,
                fat_g: null,
                fiber_g: null,
                sugar_g: null,
                sodium_mg: null,
                status: "partial",
            },
        },
    ],
    pantry_enrichment: { resolved: 1, partial: 1, unresolved: 0 },
    saved_recipe_candidates: [
        {
            recipe_id: "11111111-1111-4111-8111-111111111111",
            name: "Smoky beef bowl",
            nutrition_per_serving: {},
            total_minutes: 30,
            readiness: "ready_now",
            matched_ingredients: ["ground beef", "smoked paprika"],
            missing_required: [],
            missing_optional: [],
            shortages: [],
            flavor_support: {
                matched: ["smoked paprika"],
                missing: [],
                coverage: 1,
            },
            score: 90,
            score_reasons: ["strong seasoning/sauce support from Pantry"],
        },
    ],
};

function response(
    overrides: Partial<PantryMealIdeasResponse["candidates"][number]> = {},
): PantryMealIdeasResponse {
    return {
        candidates: [
            {
                name: "Smoky beef bowl",
                description: "Seasoned beef bowl",
                source: "saved_recipe",
                saved_recipe_id: "11111111-1111-4111-8111-111111111111",
                readiness: "ready_now",
                estimated_nutrition: {
                    calories: 550,
                    protein_g: 45,
                    carbs_g: 40,
                    fat_g: 22,
                    fiber_g: 5,
                },
                total_minutes: 30,
                on_hand_ingredients: ["ground beef", "smoked paprika"],
                assumed_staples: ["salt"],
                missing_required: [],
                missing_optional: [],
                flavor_system: ["smoked paprika", "black pepper"],
                why_it_fits: ["High protein and fully supported by Pantry"],
                confidence: 0.93,
                ...overrides,
            },
        ],
        planning_notes: [],
    };
}

describe("Pantry meal idea grounding", () => {
    test("accepts on-hand foods and explicitly configured staples", () => {
        const result = validateMealIdeaGrounding(response(), context as any);
        expect(result.candidates).toHaveLength(1);
    });

    test("rejects hallucinated on-hand ingredients", () => {
        expect(() =>
            validateMealIdeaGrounding(
                response({ on_hand_ingredients: ["ground beef", "avocado"] }),
                context as any,
            ),
        ).toThrow("no grounded meal candidates");
    });

    test("rejects invented assumed staples", () => {
        expect(() =>
            validateMealIdeaGrounding(
                response({ assumed_staples: ["soy sauce"] }),
                context as any,
            ),
        ).toThrow("no grounded meal candidates");
    });

    test("enforces the missing-item budget", () => {
        expect(() =>
            validateMealIdeaGrounding(
                response({ missing_required: ["lime", "cilantro"] }),
                context as any,
            ),
        ).toThrow("no grounded meal candidates");
    });
});

test("website planning requires both the feature flag and OpenRouter key", () => {
    expect(
        pantryPlanningModelConfig({
            MUNCH_PANTRY_PLANNING_ENABLED: "true",
            OPENROUTER_API_KEY: "test-key",
        })?.model,
    ).toBe("openai/gpt-5.6-luna");
    expect(
        pantryPlanningModelConfig({
            MUNCH_PANTRY_PLANNING_ENABLED: "false",
            OPENROUTER_API_KEY: "test-key",
        }),
    ).toBeNull();
    expect(
        pantryPlanningModelConfig({ MUNCH_PANTRY_PLANNING_ENABLED: "true" }),
    ).toBeNull();
});
