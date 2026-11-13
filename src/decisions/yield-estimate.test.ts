import { describe, expect, test } from "bun:test";
import type {
    RecipeNutritionResolution,
    RecipeYieldEstimate,
} from "../recipe-nutrition-resolution.js";
import type { DecisionsConfig } from "./config.js";
import {
    computeYieldAnchor,
    estimateYieldForResolution,
    extractMethodCues,
    extractPanSize,
    reviewRecipeYield,
} from "./yield-estimate.js";

const BASE_CONFIG: DecisionsConfig = {
    apiKey: "test-key",
    apiUrl: "https://example.invalid/decisions",
    models: ["typesafe/jev-1.14"],
    gateTimeoutMs: 1_000,
    deciderTimeoutMs: 1_000,
    gateEnabled: false,
    deciderEnabled: false,
    plausibilityEnabled: false,
    plausibilityTimeoutMs: 1_000,
    yieldEstimateEnabled: true,
    yieldEstimateTimeoutMs: 1_000,
};

function macResolution(
    yieldEstimate?: RecipeYieldEstimate | null,
): RecipeNutritionResolution {
    return {
        providerMatches: 5,
        lowImpactEstimates: 0,
        unresolved: 0,
        estimatedPositions: [0, 1, 2, 3, 4],
        unresolvedPositions: [],
        providerErrorPositions: [],
        recipe: {
            name: "Smoked Mac and Cheese",
            servings: 12,
            instructions: [
                "Parboil the macaroni in well-salted water until just shy of done; drain.",
                "Melt the butter, whisk in the flour and milk, simmer until thick.",
                "Stir in the cheddar until melted, fold in the pasta, and bake in a 9x13 inch dish until bubbling.",
            ],
            yield_estimate: yieldEstimate ?? undefined,
            ingredients: [
                {
                    name: "elbow macaroni",
                    quantity: 16,
                    unit: "oz",
                    gram_weight: 453.59,
                    source_type: "usda",
                },
                {
                    name: "milk",
                    quantity: 3,
                    unit: "cup",
                    gram_weight: 732,
                    source_type: "usda",
                },
                {
                    name: "sharp cheddar",
                    quantity: 12,
                    unit: "oz",
                    gram_weight: 340.19,
                    source_type: "usda",
                },
                {
                    name: "all-purpose flour",
                    quantity: 4,
                    unit: "tbsp",
                    gram_weight: 31.25,
                    source_type: "usda",
                },
                {
                    name: "butter",
                    quantity: 4,
                    unit: "tbsp",
                    gram_weight: 56.8,
                    source_type: "usda",
                },
            ],
        },
    };
}

function yieldFetcher(input: {
    defensible: number;
    weightBand: string;
    volumeBand?: string;
    calls?: number[];
}) {
    return async (_url: unknown, init?: RequestInit) => {
        input.calls?.push(1);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
            questions: Record<string, unknown>;
        };
        const answers: Record<string, unknown> = {
            defensible: { type: "noul", noul: input.defensible },
            weight_band: { type: "choice", choice: input.weightBand },
        };
        if (body.questions.volume_band && input.volumeBand) {
            answers.volume_band = { type: "choice", choice: input.volumeBand };
        }
        return new Response(
            JSON.stringify({ answers, usage: { cost: 0.00004 } }),
            { status: 200 },
        );
    };
}

describe("computeYieldAnchor", () => {
    test("sums resolver gram weights and volume-measured ingredient volumes", () => {
        const anchor = computeYieldAnchor(macResolution());
        expect(anchor.weight_g).toBe(1613.8);
        // milk 3 cup (709.76) + flour 4 tbsp (59.15) + butter 4 tbsp (59.15)
        expect(anchor.volume_ml).toBe(828.1);
        expect(anchor.weight_coverage).toBe(1);
    });

    test("no gram weights and no volume units: no anchor", () => {
        const resolution = macResolution();
        resolution.recipe.ingredients = [
            { name: "salt", quantity: 1, unit: "tsp", source_type: "usda" },
        ];
        const anchor = computeYieldAnchor(resolution);
        expect(anchor.weight_g).toBeNull();
        expect(anchor.volume_ml).toBe(4.9);
    });
});

describe("method cues and pan size", () => {
    test("extracts cues and pan size deterministically", () => {
        const instructions = macResolution().recipe.instructions!;
        expect(extractMethodCues(instructions)).toEqual(
            expect.arrayContaining([
                "parboil",
                "simmer",
                "melt",
                "bake",
                "drain",
            ]),
        );
        expect(extractPanSize(instructions)).toBe("9x13 inch");
    });
});

describe("estimateYieldForResolution", () => {
    test("defensible + bands: labelled estimate with anchor and factors in provenance", async () => {
        const result = await estimateYieldForResolution(macResolution(), {
            config: BASE_CONFIG,
            fetcher: yieldFetcher({
                defensible: 0.97,
                weightBand: "f125",
                volumeBand: "f200",
            }) as never,
        });
        expect(result.status).toBe("estimated");
        expect(result.yieldEstimate?.source).toBe("estimate");
        expect(result.yieldEstimate?.model).toBe("typesafe/jev-1.14");
        expect(result.yieldEstimate?.weight_g).toBe(2017.3);
        expect(result.yieldEstimate?.volume_ml).toBe(1656.2);
        expect(result.yieldEstimate?.anchor?.weight_g).toBe(1613.8);
        expect(result.yieldEstimate?.anchor?.weight_factor).toBe(1.25);
        expect(result.yieldEstimate?.anchor?.volume_factor).toBe(2.0);
        expect(result.reportedCostUsd).toBe(0.00004);
    });

    test("not defensible: no estimate, nothing stored", async () => {
        const result = await estimateYieldForResolution(macResolution(), {
            config: BASE_CONFIG,
            fetcher: yieldFetcher({
                defensible: 0.1,
                weightBand: "f125",
            }) as never,
        });
        expect(result.status).toBe("not_defensible");
        expect(result.yieldEstimate).toBeNull();
    });

    test("flag off: zero calls", async () => {
        const calls: number[] = [];
        const result = await estimateYieldForResolution(macResolution(), {
            config: { ...BASE_CONFIG, yieldEstimateEnabled: false },
            fetcher: yieldFetcher({
                defensible: 0.97,
                weightBand: "f125",
                calls,
            }) as never,
        });
        expect(result.status).toBe("disabled");
        expect(calls).toHaveLength(0);
    });

    test("chain down: fail-open unchecked", async () => {
        const result = await estimateYieldForResolution(macResolution(), {
            config: BASE_CONFIG,
            fetcher: (async () =>
                new Response("down", { status: 500 })) as never,
        });
        expect(result.status).toBe("unchecked");
        expect(result.yieldEstimate).toBeNull();
    });

    test("USER CORRECTION IS PERMANENT: user-set yield short-circuits with zero calls", async () => {
        const calls: number[] = [];
        const userYield: RecipeYieldEstimate = {
            source: "user",
            weight_g: 1800,
            volume_ml: 1700,
        };
        const result = await estimateYieldForResolution(
            macResolution(userYield),
            {
                config: BASE_CONFIG,
                fetcher: yieldFetcher({
                    defensible: 0.99,
                    weightBand: "f300",
                    volumeBand: "f300",
                    calls,
                }) as never,
            },
        );
        expect(result.status).toBe("user_set");
        expect(calls).toHaveLength(0);
        const reviewed = await reviewRecipeYield(macResolution(userYield), {
            config: BASE_CONFIG,
            fetcher: yieldFetcher({
                defensible: 0.99,
                weightBand: "f300",
                volumeBand: "f300",
                calls,
            }) as never,
        });
        expect(reviewed.recipe.yield_estimate).toEqual(userYield);
        expect(calls).toHaveLength(0);
    });

    test("an uncorrected estimate may refresh on revision", async () => {
        const prior: RecipeYieldEstimate = {
            source: "estimate",
            weight_g: 1700,
            volume_ml: 1500,
            anchor: {
                weight_g: 1613.8,
                volume_ml: 828.1,
                weight_factor: 1.1,
                volume_factor: 1.75,
            },
            model: "typesafe/jev-1.14",
            probability: 0.9,
        };
        const reviewed = await reviewRecipeYield(macResolution(prior), {
            config: BASE_CONFIG,
            fetcher: yieldFetcher({
                defensible: 0.97,
                weightBand: "f125",
                volumeBand: "f200",
            }) as never,
        });
        expect(reviewed.recipe.yield_estimate?.weight_g).toBe(2017.3);
        expect(reviewed.recipe.yield_estimate?.source).toBe("estimate");
    });

    test("failed refresh keeps the prior estimate", async () => {
        const prior: RecipeYieldEstimate = {
            source: "estimate",
            weight_g: 1700,
            volume_ml: 1500,
            model: "typesafe/jev-1.14",
        };
        const reviewed = await reviewRecipeYield(macResolution(prior), {
            config: BASE_CONFIG,
            fetcher: (async () =>
                new Response("down", { status: 500 })) as never,
        });
        expect(reviewed.recipe.yield_estimate).toEqual(prior);
    });
});
