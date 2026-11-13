import { describe, expect, spyOn, test } from "bun:test";
import type { FoodCandidate } from "./food-providers/types.js";
import {
    logRecipeNutritionResolution,
    resolvePlanningRecipeNutrition,
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
                onePortion("82238", "1 pie crust (average weight)", 229, {
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
            nutrientsPer100g: {
                calories: 364,
                protein_g: 10.3,
                carbs_g: 76.3,
                fat_g: 0.98,
                fiber_g: 2.7,
                sugar_g: 0.27,
                sodium_mg: 2,
            },
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
        {
            name: "pie crusts",
            quantity: 2,
            unit: "crusts",
            source_type: "user_supplied",
        },
        {
            name: "butter",
            quantity: 1 / 3,
            unit: "cup",
            source_type: "user_supplied",
        },
        {
            name: "onion",
            quantity: 1 / 3,
            unit: "cup",
            preparation: "chopped",
            source_type: "user_supplied",
        },
        {
            name: "all-purpose flour",
            quantity: 1 / 3,
            unit: "cup",
            source_type: "user_supplied",
        },
        {
            name: "chicken broth",
            quantity: 1.75,
            unit: "cups",
            source_type: "user_supplied",
        },
        {
            name: "milk",
            quantity: 0.5,
            unit: "cup",
            source_type: "user_supplied",
        },
        {
            name: "frozen mixed vegetables",
            quantity: 2.5,
            unit: "cups",
            source_type: "user_supplied",
        },
        {
            name: "chicken breasts",
            quantity: 2,
            unit: "breasts",
            preparation: "cooked shredded",
            source_type: "user_supplied",
        },
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
            .reduce(
                (total, ingredient) =>
                    total + (ingredient.nutrients?.[key] ?? 0),
                0,
            )
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
        expect(sum(result.recipe, "calories")).toBe(3726.22);
        expect(sum(result.recipe, "protein_g")).toBe(154.78);
        expect(sum(result.recipe, "carbs_g")).toBe(336.46);
        expect(sum(result.recipe, "fat_g")).toBe(195.85);
        expect(Number((sum(result.recipe, "calories") / 6).toFixed(2))).toBe(
            621.04,
        );
        expect(Number((sum(result.recipe, "protein_g") / 6).toFixed(2))).toBe(
            25.8,
        );
        expect(Number((sum(result.recipe, "carbs_g") / 6).toFixed(2))).toBe(
            56.08,
        );
        expect(Number((sum(result.recipe, "fat_g") / 6).toFixed(2))).toBe(
            32.64,
        );

        expect(result.recipe.ingredients[0]?.provider_food_id).toBe("167932");
        expect(result.recipe.ingredients[0]?.gram_weight).toBe(458);
        expect(result.recipe.ingredients[2]?.provider_food_id).toBe("2709795");
        expect(result.recipe.ingredients[5]?.provider_food_id).toBe("2705385");
        expect(result.recipe.ingredients[7]?.gram_weight).toBe(362);
        expect(result.recipe.ingredients[8]?.source_type).toBe(
            "model_estimate",
        );
        expect(result.recipe.ingredients[8]?.nutrients?.calories).toBe(0);
        expect(
            (
                result.recipe.ingredients[5]?.source_snapshot
                    ?.automatic_nutrition as {
                    assumptions?: string[];
                }
            )?.assumptions?.[0],
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
            {
                foodSearch: {
                    async search() {
                        return { candidates: [], failures: [] };
                    },
                },
            },
        );
        expect(result.unresolved).toBe(1);
        expect(result.recipe.ingredients[0]?.nutrients).toBeUndefined();
    });

    test("resolves import-shaped typed lines through the planning save-path entry", async () => {
        // The shape an import/manual save actually carries: plain
        // typed ingredient lines, sourceType user_supplied, no
        // nutrients. The save paths call
        // resolvePlanningRecipeNutrition; common ingredients must
        // come back resolved, not silently stored unresolved.
        const resolved = await resolvePlanningRecipeNutrition(
            {
                name: "Simple Typed Recipe",
                servings: 2,
                ingredients: [
                    {
                        name: "Butter",
                        quantity: 0.5,
                        unit: "cup",
                        sourceType: "user_supplied",
                    },
                    {
                        name: "Onion",
                        quantity: 1,
                        unit: "cup",
                        preparation: "chopped",
                        sourceType: "user_supplied",
                    },
                    { name: "Salt", sourceType: "user_supplied" },
                ],
            },
            {
                foodSearch: {
                    async search(query: string) {
                        return {
                            candidates: fixtures[query.toLowerCase()] ?? [],
                            failures: [],
                        };
                    },
                },
            },
        );
        expect(resolved.ingredients[0]?.sourceType).toBe("usda");
        expect(resolved.ingredients[0]?.nutrients?.calories).toBeGreaterThan(0);
        expect(resolved.ingredients[1]?.sourceType).toBe("usda");
        expect(resolved.ingredients[1]?.nutrients?.calories).toBeGreaterThan(0);
        expect(resolved.ingredients[2]?.sourceType).toBe("model_estimate");
        expect(resolved.ingredients[2]?.nutrients?.calories).toBe(0);
    });

    test("wholesale provider failure is reported as provider errors, not silent no-matches", async () => {
        const result = await resolveRecipeNutrition(
            {
                name: "Outage Recipe",
                servings: 1,
                ingredients: [
                    {
                        name: "Butter",
                        quantity: 0.5,
                        unit: "cup",
                        source_type: "user_supplied",
                    },
                    { name: "Salt", source_type: "user_supplied" },
                ],
            },
            {
                foodSearch: {
                    async search(): Promise<never> {
                        throw new Error("food_provider circuit_open");
                    },
                },
            },
        );
        // The butter could not be checked at all: it stays
        // unresolved, but the failure is accounted separately so a
        // save path can surface/retry it. The salt never reaches
        // the provider (unmeasured low-impact) and still resolves.
        expect(result.unresolved).toBe(1);
        expect(result.unresolvedPositions).toEqual([0]);
        expect(result.providerErrorPositions).toEqual([0]);
        expect(result.lowImpactEstimates).toBe(1);
        expect(
            (
                result.recipe.ingredients[0]?.source_snapshot
                    ?.automatic_nutrition as { reason?: string } | undefined
            )?.reason,
        ).toBe("provider_resolution_error");
    });

    test("provider errors are separated from genuine no-match unresolved ingredients", async () => {
        const result = await resolveRecipeNutrition(
            {
                name: "Mixed Recipe",
                servings: 1,
                ingredients: [
                    {
                        name: "Butter",
                        quantity: 0.5,
                        unit: "cup",
                        source_type: "user_supplied",
                    },
                    {
                        name: "Onion",
                        quantity: 1,
                        unit: "cup",
                        source_type: "user_supplied",
                    },
                ],
            },
            {
                foodSearch: {
                    async search(query: string) {
                        if (query.toLowerCase() === "butter") {
                            throw new Error("food_provider circuit_open");
                        }
                        return { candidates: [], failures: [] };
                    },
                },
            },
        );
        expect(result.unresolved).toBe(2);
        expect(result.unresolvedPositions).toEqual([0, 1]);
        expect(result.providerErrorPositions).toEqual([0]);
        expect(
            (
                result.recipe.ingredients[1]?.source_snapshot
                    ?.automatic_nutrition as { reason?: string } | undefined
            )?.reason,
        ).toBe("no_defensible_provider_match");
    });

    test("the save-path log warns only when the provider failed", async () => {
        const info = spyOn(console, "info").mockImplementation(() => {});
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
            const base = {
                recipe: potPie,
                providerMatches: 8,
                lowImpactEstimates: 2,
                unresolved: 0,
                estimatedPositions: [0, 1],
                unresolvedPositions: [] as number[],
                providerErrorPositions: [] as number[],
            };
            logRecipeNutritionResolution("save_recipe", base);
            expect(info).toHaveBeenCalledTimes(1);
            expect(String(info.mock.calls[0]?.[0])).toContain(
                "provider_errors=0",
            );
            expect(warn).not.toHaveBeenCalled();

            logRecipeNutritionResolution("save_recipe", {
                ...base,
                unresolved: 2,
                unresolvedPositions: [1, 3],
                providerErrorPositions: [1, 3],
            });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain(
                "provider_failure",
            );
            expect(String(warn.mock.calls[0]?.[0])).toContain(
                "unresolved_due_to_provider_error=2",
            );
        } finally {
            info.mockRestore();
            warn.mockRestore();
        }
    });

    test("rejects the guideline portion that priced 3 cups of milk at 183 g", async () => {
        // Production shape (Nov 2026 mac & cheese save): the milk
        // candidate's guideline reference portion was listed FIRST
        // and its label mentions "cup", so the old label match priced
        // 3 cups at 61 g each — 111.63 kcal for what is really ~450.
        const resolution = await resolveRecipeNutrition(
            {
                name: "Milk regression",
                servings: 1,
                ingredients: [{ name: "Whole milk", quantity: 3, unit: "cup" }],
            },
            {
                foodSearch: {
                    async search(query) {
                        if (query === "Whole milk") {
                            return {
                                candidates: [
                                    candidate({
                                        id: "2705385",
                                        name: "Milk, whole",
                                        nutrientsPer100g: {
                                            calories: 61,
                                            protein_g: 3.27,
                                            carbs_g: 4.63,
                                            fat_g: 3.2,
                                            fiber_g: 0,
                                            sugar_g: 4.81,
                                            sodium_mg: 38,
                                        },
                                        portions: [
                                            onePortion(
                                                "290519",
                                                "Guideline amount per cup of hot cereal",
                                                61,
                                                {
                                                    calories: 37.21,
                                                    protein_g: 2,
                                                    carbs_g: 2.83,
                                                    fat_g: 1.95,
                                                    fiber_g: 0,
                                                    sugar_g: 2.93,
                                                    sodium_mg: 23.18,
                                                },
                                            ),
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
                                totalResults: 1,
                            };
                        }
                        return { candidates: [], totalResults: 0 };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(0);
        expect(resolution.providerMatches).toBe(1);
        const milk = resolution.recipe.ingredients[0]!;
        expect(milk.provider_food_id).toBe("2705385");
        expect(milk.gram_weight).toBe(732);
        expect(milk.nutrients?.calories).toBe(446.52);
        expect(milk.nutrients!.calories).toBeGreaterThanOrEqual(400);
        expect(milk.nutrients!.calories).toBeLessThanOrEqual(500);
        const snapshot = (
            milk.source_snapshot as {
                automatic_nutrition: Record<string, unknown>;
            }
        ).automatic_nutrition;
        expect(snapshot.portion_id).toBe("290515");
        expect(snapshot.implied_grams_per_unit).toBe(244);
        expect(snapshot.assumptions).not.toContain(
            'Used provider portion "Guideline amount per cup of hot cereal" to interpret 3 cup.',
        );
    });

    test("resolves tablespoons of flour through the cup portion by volume ratio", async () => {
        const resolution = await resolveRecipeNutrition(
            {
                name: "Flour regression",
                servings: 1,
                ingredients: [
                    { name: "all-purpose flour", quantity: 4, unit: "tbsp" },
                ],
            },
            {
                foodSearch: {
                    async search(query) {
                        const candidates = fixtures[query.toLowerCase()] ?? [];
                        return { candidates, totalResults: candidates.length };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(0);
        const flour = resolution.recipe.ingredients[0]!;
        expect(flour.nutrients?.calories).toBe(113.75);
        expect(flour.nutrients!.calories).toBeGreaterThanOrEqual(100);
        expect(flour.nutrients!.calories).toBeLessThanOrEqual(125);
        expect(flour.gram_weight).toBe(31.25);
        const snapshot = (
            flour.source_snapshot as {
                automatic_nutrition: Record<string, unknown>;
            }
        ).automatic_nutrition;
        expect(snapshot.portion_id).toBe("83944");
        expect(snapshot.implied_grams_per_unit).toBe(7.81);
    });

    test("still accepts an assumed portion inside the sane range", async () => {
        const resolution = await resolveRecipeNutrition(
            {
                name: "Control",
                servings: 1,
                ingredients: [{ name: "milk", quantity: 2, unit: "cup" }],
            },
            {
                foodSearch: {
                    async search(query) {
                        const candidates = fixtures[query.toLowerCase()] ?? [];
                        return { candidates, totalResults: candidates.length };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(0);
        const milk = resolution.recipe.ingredients[0]!;
        expect(milk.nutrients?.calories).toBe(297.68);
        expect(milk.gram_weight).toBe(488);
        const snapshot = (
            milk.source_snapshot as {
                automatic_nutrition: Record<string, unknown>;
            }
        ).automatic_nutrition;
        expect(snapshot.resolution).toBe("assumed_provider_match");
        expect(snapshot.portion_id).toBe("290515");
        expect(snapshot.implied_grams_per_unit).toBe(244);
    });

    test("falls to the next portion when the first implies an insane weight", async () => {
        // The first "1 cup" portion claims 12 g — an implied weight
        // no cup of juice can have. The gate refuses it and the sane
        // 248 g cup portion on the same candidate prices the juice.
        const badCup = onePortion("oj-bad-cup", "1 cup", 12, {
            calories: 5.4,
            protein_g: 0.08,
            carbs_g: 1.25,
            fat_g: 0.02,
            fiber_g: 0.02,
            sugar_g: 1.01,
            sodium_mg: 0.12,
        });
        const goodCup = onePortion("oj-cup", "1 cup", 248, {
            calories: 111.6,
            protein_g: 1.74,
            carbs_g: 25.79,
            fat_g: 0.5,
            fiber_g: 0.5,
            sugar_g: 20.83,
            sodium_mg: 2.48,
        });
        const resolution = await resolveRecipeNutrition(
            {
                name: "Juice portions",
                servings: 1,
                ingredients: [
                    { name: "orange juice", quantity: 2, unit: "cup" },
                ],
            },
            {
                foodSearch: {
                    async search(query) {
                        if (query === "orange juice") {
                            return {
                                candidates: [
                                    candidate({
                                        id: "92007",
                                        name: "Orange juice, raw",
                                        nutrientsPer100g: {
                                            calories: 45,
                                            protein_g: 0.7,
                                            carbs_g: 10.4,
                                            fat_g: 0.2,
                                            fiber_g: 0.2,
                                            sugar_g: 8.4,
                                            sodium_mg: 1,
                                        },
                                        portions: [badCup, goodCup],
                                    }),
                                ],
                                totalResults: 1,
                            };
                        }
                        return { candidates: [], totalResults: 0 };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(0);
        const juice = resolution.recipe.ingredients[0]!;
        expect(juice.nutrients?.calories).toBe(223.2);
        expect(juice.gram_weight).toBe(496);
        const snapshot = (
            juice.source_snapshot as {
                automatic_nutrition: {
                    portion_id: string;
                    rejected_portions: {
                        portion_id: string;
                        implied_grams_per_unit: number | null;
                        reason: string;
                    }[];
                };
            }
        ).automatic_nutrition;
        expect(snapshot.portion_id).toBe("oj-cup");
        expect(snapshot.rejected_portions).toHaveLength(1);
        expect(snapshot.rejected_portions[0]!.portion_id).toBe("oj-bad-cup");
        expect(snapshot.rejected_portions[0]!.implied_grams_per_unit).toBe(12);
        expect(snapshot.rejected_portions[0]!.reason).toBe(
            "implied_grams_per_cup_out_of_range",
        );
    });

    test("leaves the ingredient unresolved when the only portion is insane", async () => {
        const badCup = onePortion("oj-bad-cup", "1 cup", 12, {
            calories: 5.4,
            protein_g: 0.08,
            carbs_g: 1.25,
            fat_g: 0.02,
            fiber_g: 0.02,
            sugar_g: 1.01,
            sodium_mg: 0.12,
        });
        const resolution = await resolveRecipeNutrition(
            {
                name: "Juice unresolved",
                servings: 1,
                ingredients: [
                    { name: "orange juice", quantity: 2, unit: "cup" },
                ],
            },
            {
                foodSearch: {
                    async search(query) {
                        if (query === "orange juice") {
                            return {
                                candidates: [
                                    candidate({
                                        id: "92007",
                                        name: "Orange juice, raw",
                                        portions: [badCup],
                                    }),
                                ],
                                totalResults: 1,
                            };
                        }
                        return { candidates: [], totalResults: 0 };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(1);
        const juice = resolution.recipe.ingredients[0]!;
        expect(juice.nutrients).toBeUndefined();
        const snapshot = (
            juice.source_snapshot as {
                automatic_nutrition: {
                    reason: string;
                    rejected_portions: { portion_id: string }[];
                };
            }
        ).automatic_nutrition;
        expect(snapshot.reason).toBe("no_compatible_provider_portion");
        expect(snapshot.rejected_portions).toHaveLength(1);
        expect(snapshot.rejected_portions[0]!.portion_id).toBe("oj-bad-cup");
    });

    test("tries the next candidate when the top candidate's portions are all insane", async () => {
        const resolution = await resolveRecipeNutrition(
            {
                name: "Juice candidates",
                servings: 1,
                ingredients: [
                    { name: "apple juice", quantity: 1, unit: "cup" },
                ],
            },
            {
                foodSearch: {
                    async search(query) {
                        if (query === "apple juice") {
                            return {
                                candidates: [
                                    candidate({
                                        id: "bad-top",
                                        name: "Apple juice",
                                        portions: [
                                            onePortion(
                                                "aj-bad-cup",
                                                "1 cup",
                                                12,
                                                {
                                                    calories: 5.4,
                                                    protein_g: 0.1,
                                                    carbs_g: 1.3,
                                                    fat_g: 0.02,
                                                    fiber_g: 0.02,
                                                    sugar_g: 1.1,
                                                    sodium_mg: 0.1,
                                                },
                                            ),
                                        ],
                                    }),
                                    candidate({
                                        id: "good-second",
                                        name: "Apple juice, unsweetened",
                                        nutrientsPer100g: {
                                            calories: 45,
                                            protein_g: 0.7,
                                            carbs_g: 10.4,
                                            fat_g: 0.2,
                                            fiber_g: 0.2,
                                            sugar_g: 8.4,
                                            sodium_mg: 1,
                                        },
                                        portions: [
                                            onePortion("aj-cup", "1 cup", 248, {
                                                calories: 111.6,
                                                protein_g: 1.74,
                                                carbs_g: 25.79,
                                                fat_g: 0.5,
                                                fiber_g: 0.5,
                                                sugar_g: 20.83,
                                                sodium_mg: 2.48,
                                            }),
                                        ],
                                    }),
                                ],
                                totalResults: 2,
                            };
                        }
                        return { candidates: [], totalResults: 0 };
                    },
                },
            },
        );

        expect(resolution.unresolved).toBe(0);
        const juice = resolution.recipe.ingredients[0]!;
        expect(juice.provider_food_id).toBe("good-second");
        expect(juice.nutrients?.calories).toBe(111.6);
    });
});
