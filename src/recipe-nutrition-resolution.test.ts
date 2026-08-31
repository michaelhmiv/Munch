import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "./food-providers/types.js";
import {
    resolveRecipeNutrition,
    type RecipeNutritionPayload,
} from "./recipe-nutrition-resolution.js";

function candidate(input: {
    id: string;
    name: string;
    confidence?: number;
    dataKind?: FoodCandidate["dataKind"];
    portions: FoodCandidate["portions"];
    nutrientsPer100g?: FoodCandidate["nutrientsPer100g"];
}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: input.id,
        name: input.name,
        dataKind: input.dataKind ?? "generic",
        confidence: input.confidence ?? 0.98,
        attribution: {
            label: "USDA FoodData Central",
            url: `https://fdc.nal.usda.gov/fdc-app.html#/food-details/${input.id}/nutrients`,
        },
        portions: input.portions,
        nutrientsPer100g: input.nutrientsPer100g,
    };
}

function onePortion(
    id: string,
    label: string,
    gramWeight: number,
    nutrients: FoodCandidate["portions"][number]["nutrients"],
) {
    return {
        id,
        amount: 1,
        unit: "undetermined",
        label,
        gramWeight,
        nutrients,
    };
}

const fixtures: Record<string, FoodCandidate[]> = {
    "pie crust refrigerated regular unbaked": [
        candidate({
            id: "167932",
            name: "Pie crust, refrigerated, regular, unbaked",
            portions: [
                onePortion("82238", '1 pie crust (average weight)', 229, {
                    calories: 1019.05,
                    protein_g: 6.8,
                    carbs_g: 117.02,
                    fat_g: 58.4,
                    fiber_g: 4.12,
                    sodium_mg: 936.61,
                }),
            ],
        }),
    ],
    butter: [
        candidate({
            id: "2710154",
            name: "Butter, NFS",
            portions: [
                onePortion("309443", "1 cup", 224, {
                    calories: 1664.32,
                    protein_g: 1.9,
                    carbs_g: 0.13,
                    fat_g: 184.13,
                    fiber_g: 0,
                    sugar_g: 1.3,
                    sodium_mg: 1173.76,
                }),
            ],
        }),
    ],
    "onions raw": [
        candidate({
            id: "wrong-onion",
            name: "Livers, chicken, chopped, with eggs and onion",
            portions: [
                onePortion("wrong", "1 cup", 200, {
                    calories: 350,
                    protein_g: 20,
                    carbs_g: 4,
                    fat_g: 28,
                }),
            ],
        }),
        candidate({
            id: "2709795",
            name: "Onions, raw",
            portions: [
                onePortion("308297", "1 cup", 160, {
                    calories: 60.8,
                    protein_g: 1.38,
                    carbs_g: 13.54,
                    fat_g: 0.13,
                    fiber_g: 2.72,
                    sugar_g: 9.28,
                    sodium_mg: 1.6,
                }),
            ],
        }),
    ],
    "wheat flour white all-purpose enriched": [
        candidate({
            id: "168894",
            name: "Wheat flour, white, all-purpose, enriched, bleached",
            portions: [
                onePortion("83944", "1 cup", 125, {
                    calories: 455,
                    protein_g: 12.88,
                    carbs_g: 95.38,
                    fat_g: 1.23,
                    fiber_g: 3.38,
                    sugar_g: 0.34,
                    sodium_mg: 2.5,
                }),
            ],
        }),
    ],
    "chicken broth ready to serve": [
        candidate({
            id: "174536",
            name: "Soup, chicken broth, ready-to-serve",
            portions: [
                onePortion("94531", "1 cup", 249, {
                    calories: 14.94,
                    protein_g: 1.59,
                    carbs_g: 1.1,
                    fat_g: 0.52,
                    fiber_g: 0,
                    sugar_g: 1.07,
                    sodium_mg: 923.79,
                }),
            ],
        }),
    ],
    "milk whole": [
        candidate({
            id: "packaged-milk",
            name: "Whole Milk",
            dataKind: "packaged",
            confidence: 0.92,
            portions: [
                onePortion("packaged", "1 cup", 244, {
                    calories: 160,
                    protein_g: 8,
                    carbs_g: 12,
                    fat_g: 9,
                }),
            ],
        }),
        candidate({
            id: "2705385",
            name: "Milk, whole",
            portions: [
                onePortion("290515", "1 cup", 244, {
                    calories: 148.84,
                    protein_g: 7.98,
                    carbs_g: 11.3,
                    fat_g: 7.81,
                    fiber_g: 0,
                    sugar_g: 11.74,
                    sodium_mg: 92.72,
                }),
            ],
        }),
    ],
    "classic mixed vegetables frozen cooked no added fat": [
        candidate({
            id: "2710013",
            name: "Classic mixed vegetables, frozen, cooked, no added fat",
            portions: [
                onePortion("308992", "1 cup", 180, {
                    calories: 117,
                    protein_g: 5.13,
                    carbs_g: 23.4,
                    fat_g: 0.27,
                    fiber_g: 7.92,
                    sugar_g: 5.6,
                    sodium_mg: 271.8,
                }),
            ],
        }),
    ],
    "chicken breast skinless boneless cooked braised": [
        candidate({
            id: "171140",
            name: "Chicken, broiler or fryers, breast, skinless, boneless, meat only, cooked, braised",
            portions: [
                onePortion("88054", "1 piece", 181, {
                    calories: 284.17,
                    protein_g: 58.1,
                    carbs_g: 0,
                    fat_g: 5.86,
                    fiber_g: 0,
                    sugar_g: 0,
                    sodium_mg: 85.07,
                }),
            ],
        }),
    ],
};

const potPie: RecipeNutritionPayload = {
    name: "Chicken Pot Pie",
    servings: 6,
    source_type: "user_entered",
    instructions: ["Bake until golden."],
    ingredients: [
        { name: "pie crusts", quantity: 2, unit: "crusts", source_type: "user_supplied" },
        { name: "butter", quantity: 1 / 3, unit: "cup", source_type: "user_supplied" },
        { name: "onion", quantity: 1 / 3, unit: "cup", preparation: "chopped", source_type: "user_supplied" },
        { name: "all-purpose flour", quantity: 1 / 3, unit: "cup", source_type: "user_supplied" },
        { name: "chicken broth", quantity: 1.75, unit: "cups", source_type: "user_supplied" },
        { name: "milk", quantity: 0.5, unit: "cup", source_type: "user_supplied" },
        { name: "frozen mixed vegetables", quantity: 2.5, unit: "cups", source_type: "user_supplied" },
        { name: "chicken breasts", quantity: 2, unit: "breasts", preparation: "cooked shredded", source_type: "user_supplied" },
        { name: "salt", source_type: "user_supplied" },
        { name: "black pepper", source_type: "user_supplied" },
    ],
};

function sum(
    recipe: RecipeNutritionPayload,
    key: "calories" | "protein_g" | "carbs_g" | "fat_g",
): number {
    return Number(
        recipe.ingredients
            .reduce((total, ingredient) => total + (ingredient.nutrients?.[key] ?? 0), 0)
            .toFixed(2),
    );
}

describe("recipe nutrition resolution", () => {
    test("resolves the Chicken Pot Pie fixture with provider-backed assumptions", async () => {
        const foodSearch = {
            async search(query: string) {
                return { candidates: fixtures[query] ?? [], failures: [] };
            },
        };
        const result = await resolveRecipeNutrition(potPie, { foodSearch });

        expect(result.providerMatches).toBe(8);
        expect(result.lowImpactEstimates).toBe(2);
        expect(result.unresolved).toBe(0);
        expect(sum(result.recipe, "calories")).toBe(3726.21);
        expect(sum(result.recipe, "protein_g")).toBe(154.78);
        expect(sum(result.recipe, "carbs_g")).toBe(336.47);
        expect(sum(result.recipe, "fat_g")).toBe(195.84);
        expect(Number((sum(result.recipe, "calories") / 6).toFixed(2))).toBe(621.04);
        expect(Number((sum(result.recipe, "protein_g") / 6).toFixed(2))).toBe(25.8);
        expect(Number((sum(result.recipe, "carbs_g") / 6).toFixed(2))).toBe(56.08);
        expect(Number((sum(result.recipe, "fat_g") / 6).toFixed(2))).toBe(32.64);

        expect(result.recipe.ingredients[0]?.provider_food_id).toBe("167932");
        expect(result.recipe.ingredients[0]?.gram_weight).toBe(458);
        expect(result.recipe.ingredients[2]?.provider_food_id).toBe("2709795");
        expect(result.recipe.ingredients[5]?.provider_food_id).toBe("2705385");
        expect(result.recipe.ingredients[7]?.gram_weight).toBe(362);
        expect(result.recipe.ingredients[8]?.source_type).toBe("model_estimate");
        expect(result.recipe.ingredients[8]?.nutrients?.calories).toBe(0);
        expect(
            (result.recipe.ingredients[5]?.source_snapshot?.automatic_nutrition as {
                assumptions?: string[];
            })?.assumptions?.[0],
        ).toContain("whole milk");
    });

    test("preserves already complete ingredient nutrition without provider work", async () => {
        let searches = 0;
        const foodSearch = {
            async search() {
                searches += 1;
                return { candidates: [], failures: [] };
            },
        };
        const result = await resolveRecipeNutrition(
            {
                name: "Known recipe",
                servings: 1,
                ingredients: [
                    {
                        name: "Known food",
                        quantity: 1,
                        source_type: "user_supplied",
                        nutrients: {
                            calories: 100,
                            protein_g: 10,
                            carbs_g: 12,
                            fat_g: 2,
                        },
                    },
                ],
            },
            { foodSearch },
        );
        expect(searches).toBe(0);
        expect(result.providerMatches).toBe(0);
        expect(result.recipe.ingredients[0]?.nutrients?.calories).toBe(100);
    });

    test("leaves a material ingredient unresolved when quantity is absent", async () => {
        const result = await resolveRecipeNutrition(
            {
                name: "Ambiguous",
                servings: 1,
                ingredients: [
                    {
                        name: "chicken breast",
                        source_type: "user_supplied",
                    },
                ],
            },
            { foodSearch: { async search() { return { candidates: [], failures: [] }; } } },
        );
        expect(result.unresolved).toBe(1);
        expect(result.recipe.ingredients[0]?.nutrients).toBeUndefined();
    });
});
