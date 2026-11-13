import { describe, expect, test } from "bun:test";
import type { FoodCandidate } from "../food-providers/types.js";
import {
    resolveRecipeNutrition,
    type RecipeNutritionResolution,
} from "../recipe-nutrition-resolution.js";
import type { DecisionsConfig } from "./config.js";
import { reviewRecipePlausibility } from "./plausibility.js";
import {
    buildResolutionReviewStates,
    checkEstimateDefensibility,
    reviewRecipeResolution,
    toPlausibilityIngredients,
} from "./resolution-review.js";

const BASE_CONFIG: DecisionsConfig = {
    apiKey: "test-key",
    apiUrl: "https://example.invalid/decisions",
    models: ["typesafe/jev-1.14"],
    gateTimeoutMs: 1_000,
    deciderTimeoutMs: 1_000,
    gateEnabled: false,
    deciderEnabled: false,
    plausibilityTimeoutMs: 1_000,
    plausibilityEnabled: true,
    matchTimeoutMs: 1_000,
    matchEnabled: true,
    pantryMatchEnabled: true,
    pantryMatchTimeoutMs: 1_000,
    drawdownReviewEnabled: true,
    drawdownReviewTimeoutMs: 1_000,
    draftReviewTimeoutMs: 1_000,
    draftReviewEnabled: true,
    resolutionReviewTimeoutMs: 1_000,
    estimateRungEnabled: true,
};

function configWith(overrides: Partial<DecisionsConfig>): DecisionsConfig {
    return { ...BASE_CONFIG, ...overrides };
}

/** A Decisions fetcher for the two call shapes the pass makes:
 * the shared plausibility checker (answers are p(implausible)) and
 * the A2 defensibility call (answers are p(defensible)), told apart
 * by the state task. Probabilities are keyed by ingredient name. */
function decisionsFetcher(
    probabilities: (ingredientName: string) => number,
    calls?: Array<{ questions: number; model: string }>,
) {
    return reviewFetcher({
        implausible: probabilities,
        defensible: probabilities,
        calls,
    });
}

function reviewFetcher(input: {
    implausible: (ingredientName: string) => number;
    defensible: (ingredientName: string) => number;
    calls?: Array<{ questions: number; model: string }>;
}) {
    return async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
            model: string;
            state: { task: string; ingredients: Array<{ name: string }> };
            questions: Record<string, unknown>;
        };
        input.calls?.push({
            questions: Object.keys(body.questions).length,
            model: body.model,
        });
        const isPlausibility = body.state.task.includes(
            "stored nutrition resolution",
        );
        const answers: Record<string, unknown> = {};
        body.state.ingredients.forEach((ingredient, index) => {
            answers[`q${index}`] = {
                type: "noul",
                noul: isPlausibility
                    ? input.implausible(ingredient.name)
                    : input.defensible(ingredient.name),
            };
        });
        return new Response(
            JSON.stringify({ answers, usage: { cost: 0.00005 } }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
}

function failingFetcher() {
    return async () =>
        new Response(JSON.stringify({ error: { message: "down" } }), {
            status: 500,
        });
}

/** The Nov 2026 mac & cheese save, as the PRE-#310 resolver stored
 * it: milk priced through the 61 g guideline portion, cheddar on a
 * sugary packaged entry, flour unresolved. This is the stored shape
 * the sweep will feed the checker, so the builder is tested on it
 * directly. */
function macAndCheeseResolution(): RecipeNutritionResolution {
    return {
        providerMatches: 2,
        lowImpactEstimates: 0,
        unresolved: 1,
        estimatedPositions: [0, 1],
        unresolvedPositions: [2],
        providerErrorPositions: [],
        recipe: {
            name: "Smoked Mac and Cheese",
            servings: 12,
            ingredients: [
                {
                    name: "milk",
                    quantity: 3,
                    unit: "cup",
                    gram_weight: 183,
                    nutrients: {
                        calories: 111.63,
                        protein_g: 6,
                        carbs_g: 8.49,
                        fat_g: 5.85,
                        sugar_g: 8.79,
                    },
                    source_type: "usda",
                    source_snapshot: {
                        automatic_nutrition: {
                            resolver_version: 1,
                            resolution: "assumed_provider_match",
                            provider_food_name: "Milk, whole",
                            provider_data_kind: "generic",
                            portion_label:
                                "Guideline amount per cup of hot cereal",
                            gram_weight: 183,
                        },
                    },
                },
                {
                    name: "sharp cheddar",
                    quantity: 12,
                    unit: "oz",
                    gram_weight: 340.19,
                    nutrients: {
                        calories: 1370,
                        protein_g: 85,
                        carbs_g: 50,
                        fat_g: 110,
                        sugar_g: 48.65,
                    },
                    source_type: "usda",
                    source_snapshot: {
                        automatic_nutrition: {
                            resolver_version: 1,
                            resolution: "provider_match",
                            provider_food_name: "Cheese, cheddar, sharp",
                            provider_data_kind: "packaged",
                            portion_label: "12 oz package",
                            gram_weight: 340.19,
                        },
                    },
                },
                {
                    name: "all-purpose flour",
                    quantity: 4,
                    unit: "tbsp",
                    source_type: "user_supplied",
                    source_snapshot: {
                        automatic_nutrition: {
                            resolver_version: 1,
                            resolution: "unresolved",
                            reason: "no_compatible_provider_portion",
                        },
                    },
                },
                {
                    // User-supplied verbatim nutrition: never resolved,
                    // never a review state.
                    name: "elbow macaroni",
                    quantity: 16,
                    unit: "oz",
                    nutrients: {
                        calories: 1680,
                        protein_g: 58,
                        carbs_g: 338,
                        fat_g: 7,
                    },
                    source_type: "user_supplied",
                },
            ],
        },
    };
}

describe("buildResolutionReviewStates", () => {
    test("builds the audit state shape from stored snapshots", () => {
        const states = buildResolutionReviewStates(macAndCheeseResolution());
        expect(states).toHaveLength(3);
        const milk = states[0]!;
        expect(milk.position).toBe(0);
        expect(milk.name).toBe("milk");
        expect(milk.quantity).toBe(3);
        expect(milk.unit).toBe("cup");
        expect(milk.resolution).toBe("assumed_provider_match");
        expect(milk.portion_label).toBe(
            "Guideline amount per cup of hot cereal",
        );
        expect(milk.gram_weight).toBe(183);
        expect(milk.implied_grams_per_unit).toBe(61);
        expect(milk.calories).toBe(111.63);
        expect(milk.implied_kcal_per_100g).toBe(61);
        expect(milk.per_100g?.sugar_g).toBe(4.8);
        const flour = states[2]!;
        expect(flour.resolution).toBe("unresolved");
        expect(flour.failure_reason).toBe("no_compatible_provider_portion");
    });
});

describe("shared checker + defensibility call", () => {
    test("A1 runs through the SHARED plausibility module (one batched call, per-model threshold)", async () => {
        const calls: Array<{ questions: number; model: string }> = [];
        const states = buildResolutionReviewStates(macAndCheeseResolution());
        const resolved = states.filter(
            (state) => state.resolution !== "unresolved",
        );
        const { ingredients, profiles } = toPlausibilityIngredients(resolved);
        const result = await reviewRecipePlausibility(
            ingredients,
            BASE_CONFIG,
            {
                fetcher: reviewFetcher({
                    implausible: () => 0.97,
                    defensible: () => 0,
                    calls,
                }) as never,
            },
            profiles,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]!.questions).toBe(2);
        if (result.status !== "reviewed") throw new Error("expected reviewed");
        expect(result.model).toBe("typesafe/jev-1.14");
        expect(result.threshold).toBe(0.5);
        expect(result.reportedCostUsd).toBe(0.00005);
        expect(result.verdicts.every((v) => v.confirmedImplausible)).toBe(true);
    });

    test("defensibility call maps verdicts and states counted_in_totals_as_kcal explicitly", async () => {
        const states = buildResolutionReviewStates(macAndCheeseResolution());
        const unresolved = states.filter(
            (state) => state.resolution === "unresolved",
        );
        let seenState: { ingredients: Array<Record<string, unknown>> } | null =
            null;
        const result = await checkEstimateDefensibility(unresolved, {
            siblingNames: ["milk", "sharp cheddar", "all-purpose flour"],
            config: BASE_CONFIG,
            fetcher: (async (_url: unknown, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? "{}")) as {
                    state: { ingredients: Array<Record<string, unknown>> };
                };
                seenState = body.state;
                return new Response(
                    JSON.stringify({
                        answers: { q0: { type: "noul", noul: 0.96 } },
                        usage: { cost: 0.00005 },
                    }),
                    { status: 200 },
                );
            }) as never,
        });
        expect(result.status).toBe("checked");
        expect(result.verdicts[0]?.defensible).toBe(true);
        expect(seenState!.ingredients[0]!.counted_in_totals_as_kcal).toBe(0);
    });

    test("defensibility chain exhaustion returns unchecked, never throws", async () => {
        const states = buildResolutionReviewStates(macAndCheeseResolution());
        const result = await checkEstimateDefensibility(
            states.filter((state) => state.resolution === "unresolved"),
            {
                siblingNames: ["milk"],
                config: BASE_CONFIG,
                fetcher: failingFetcher() as never,
            },
        );
        expect(result.status).toBe("unchecked");
        expect(result.verdicts).toEqual([]);
    });
});

describe("reviewRecipeResolution", () => {
    test("flags off: zero calls, resolution returned byte-identical", async () => {
        const calls: Array<{ questions: number; model: string }> = [];
        const input = macAndCheeseResolution();
        const output = await reviewRecipeResolution(input, {
            config: configWith({
                plausibilityEnabled: false,
                estimateRungEnabled: false,
            }),
            fetcher: decisionsFetcher(() => 0.01, calls) as never,
        });
        expect(calls).toHaveLength(0);
        expect(JSON.stringify(output)).toBe(JSON.stringify(input));
    });

    test("no config: resolution unchanged", async () => {
        const input = macAndCheeseResolution();
        const output = await reviewRecipeResolution(input, { config: null });
        expect(output).toBe(input);
    });

    test("chain down: fail-open, recipe saves exactly as resolved", async () => {
        const input = macAndCheeseResolution();
        const output = await reviewRecipeResolution(input, {
            config: BASE_CONFIG,
            fetcher: failingFetcher() as never,
        });
        expect(JSON.stringify(output)).toBe(JSON.stringify(input));
    });

    test("A1 flags the milk and cheddar resolutions in their snapshots; the save is never blocked", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: configWith({ estimateRungEnabled: false }),
            fetcher: reviewFetcher({
                implausible: () => 0.97,
                defensible: () => 0,
            }) as never,
        });
        const milk = output.recipe.ingredients[0]!;
        const record = (
            milk.source_snapshot as {
                automatic_nutrition: { review: { verdict: string } };
            }
        ).automatic_nutrition;
        expect(record.review.verdict).toBe("flagged");
        // Values untouched while the rung is off — marked, not changed.
        expect(milk.nutrients?.calories).toBe(111.63);
        expect(output.flaggedReviewPositions).toEqual([0, 1]);
        expect(output.unresolved).toBe(1);
    });

    test("A2 fills a defensible unresolved ingredient with a permanently labelled model estimate", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: BASE_CONFIG,
            fetcher: reviewFetcher({
                implausible: () => 0.03,
                defensible: (name) =>
                    name === "all-purpose flour" ? 0.96 : 0.5,
            }) as never,
            estimateNutrients: async (requests) => {
                expect(requests).toHaveLength(1);
                expect(requests[0]!.name).toBe("all-purpose flour");
                return new Map([
                    [
                        2,
                        {
                            nutrients: {
                                calories: 113.75,
                                protein_g: 3.22,
                                carbs_g: 23.85,
                                fat_g: 0.31,
                            },
                            gramWeight: 31.25,
                        },
                    ],
                ]);
            },
        });
        const flour = output.recipe.ingredients[2]!;
        expect(flour.source_type).toBe("model_estimate");
        expect(flour.nutrients?.calories).toBe(113.75);
        expect(flour.gram_weight).toBe(31.25);
        const record = (
            flour.source_snapshot as {
                automatic_nutrition: Record<string, unknown>;
            }
        ).automatic_nutrition;
        expect(record.resolution).toBe("model_estimate");
        expect(record.unresolved_reason).toBe("no_compatible_provider_portion");
        expect(output.unresolved).toBe(0);
        expect(output.modelEstimates).toBe(1);
        expect(output.estimatedPositions).toContain(2);
    });

    test("A2 non-defensible verdict: ingredient stays unresolved and the verdict is surfaced in its snapshot", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: BASE_CONFIG,
            fetcher: reviewFetcher({
                implausible: () => 0.03,
                defensible: (name) =>
                    name === "all-purpose flour" ? 0.04 : 0.5,
            }) as never,
            estimateNutrients: async () => {
                throw new Error("must not be called");
            },
        });
        const flour = output.recipe.ingredients[2]!;
        expect(flour.nutrients).toBeUndefined();
        const record = (
            flour.source_snapshot as {
                automatic_nutrition: {
                    resolution: string;
                    review: { verdict: string };
                };
            }
        ).automatic_nutrition;
        expect(record.resolution).toBe("unresolved");
        expect(record.review.verdict).toBe("estimate_not_defensible");
        expect(output.unresolved).toBe(1);
    });

    test("estimate chain down: defensible ingredient stays unresolved, recipe keeps its partial shape", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: BASE_CONFIG,
            fetcher: reviewFetcher({
                implausible: () => 0.03,
                defensible: (name) =>
                    name === "all-purpose flour" ? 0.96 : 0.5,
            }) as never,
            estimateNutrients: async () => {
                throw new Error("chain down");
            },
        });
        const flour = output.recipe.ingredients[2]!;
        expect(flour.nutrients).toBeUndefined();
        expect(output.unresolved).toBe(1);
    });

    test("A1-flagged but NOT defensible on re-run: values kept, flag stays, no estimate", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: BASE_CONFIG,
            fetcher: reviewFetcher({
                implausible: (name) => (name === "milk" ? 0.97 : 0.03),
                defensible: () => 0.03,
            }) as never,
            estimateNutrients: async () => {
                throw new Error("must not be called");
            },
        });
        const milk = output.recipe.ingredients[0]!;
        expect(milk.nutrients?.calories).toBe(111.63);
        expect(milk.source_type).toBe("usda");
        expect(output.flaggedReviewPositions).toContain(0);
        const record = (
            milk.source_snapshot as {
                automatic_nutrition: { review: { verdict: string } };
            }
        ).automatic_nutrition;
        expect(record.review.verdict).toBe("flagged");
    });

    test("A1-flagged + defensible on re-run: estimate replaces the implausible values with provenance", async () => {
        const output = await reviewRecipeResolution(macAndCheeseResolution(), {
            config: BASE_CONFIG,
            fetcher: reviewFetcher({
                implausible: (name) => (name === "milk" ? 0.97 : 0.03),
                defensible: () => 0.95,
            }) as never,
            estimateNutrients: async (requests) =>
                new Map(
                    requests.map((request) => [
                        request.position,
                        {
                            nutrients: {
                                calories: 446.52,
                                protein_g: 23.94,
                                carbs_g: 33.9,
                                fat_g: 23.43,
                            },
                            gramWeight: 732,
                        },
                    ]),
                ),
        });
        const milk = output.recipe.ingredients[0]!;
        expect(milk.source_type).toBe("model_estimate");
        expect(milk.nutrients?.calories).toBe(446.52);
        const record = (
            milk.source_snapshot as {
                automatic_nutrition: Record<string, unknown>;
            }
        ).automatic_nutrition;
        expect(record.resolution).toBe("model_estimate");
        expect(record.replaced_resolution).toBe("assumed_provider_match");
        expect(record.replaced_provider_food_name).toBe("Milk, whole");
    });
});

describe("resolver hook integration", () => {
    const flourCandidate: FoodCandidate = {
        provider: "usda",
        providerFoodId: "168894",
        name: "Wheat flour, white, all-purpose, enriched, bleached",
        dataKind: "generic",
        confidence: 0.98,
        attribution: { label: "USDA FoodData Central" },
        portions: [
            {
                id: "piece",
                amount: 1,
                unit: "undetermined",
                label: "1 piece",
                gramWeight: 30,
                nutrients: {
                    calories: 109,
                    protein_g: 3.1,
                    carbs_g: 22.9,
                    fat_g: 0.3,
                },
            },
        ],
        nutrientsPer100g: {
            calories: 364,
            protein_g: 10.3,
            carbs_g: 76.3,
            fat_g: 0.98,
        },
    };

    test("resolveRecipeNutrition runs the review hook; without it the outcome is the pre-A1/A2 one", async () => {
        const foodSearch = {
            async search() {
                return { candidates: [flourCandidate], totalResults: 1 };
            },
        };
        const recipe = {
            name: "Flour integration",
            servings: 1,
            ingredients: [
                {
                    name: "all-purpose flour",
                    quantity: 4,
                    unit: "tbsp",
                    source_type: "user_supplied",
                },
            ],
        };
        const plain = await resolveRecipeNutrition(recipe, { foodSearch });
        expect(plain.unresolved).toBe(1);

        const reviewed = await resolveRecipeNutrition(recipe, {
            foodSearch,
            resolutionReview: (resolution) =>
                reviewRecipeResolution(resolution, {
                    config: BASE_CONFIG,
                    fetcher: reviewFetcher({
                        implausible: () => 0.03,
                        defensible: () => 0.96,
                    }) as never,
                    estimateNutrients: async () =>
                        new Map([
                            [
                                0,
                                {
                                    nutrients: {
                                        calories: 113.75,
                                        protein_g: 3.22,
                                        carbs_g: 23.85,
                                        fat_g: 0.31,
                                    },
                                    gramWeight: 31.25,
                                },
                            ],
                        ]),
                }),
        });
        expect(reviewed.unresolved).toBe(0);
        expect(reviewed.recipe.ingredients[0]!.source_type).toBe(
            "model_estimate",
        );
    });
});
