/**
 * A2b eval — recipe yield estimate seat (Jev accountability program).
 *
 * Validity notes (model_eval_validity skill):
 * - Call shape: PRODUCTION. Fixtures are `RecipeNutritionResolution`
 *   objects in the exact stored shape the resolver produces
 *   (resolver-realistic gram weights); the anchor comes from the
 *   seat's own `computeYieldAnchor`, the call from the seat's own
 *   `estimateYieldForResolution` through the shared Decisions
 *   client, per model forced as the single chain model.
 * - Ground truth provenance: yields are STANDARD CULINARY REFERENCE
 *   values, not measurements of these exact pots — flagged as such.
 *   Dry pasta cooked yield ~2.25x dry weight (USDA-style yield
 *   tables); 1 cup dry long-grain rice -> ~3 cups cooked / ~555 g;
 *   a sauce the method says to "reduce by half" yields ~half its
 *   starting volume less solids loss; melting/mixing conserves mass
 *   within a few percent (fondue, soup with a short simmer ~3%
 *   evaporation). Errors are therefore meaningful at the 5-10%
 *   level, not the 1% level.
 * - Pass bar, stated before the run: per model — (a) aggregate
 *   adjusted WEIGHT MAE% strictly below the raw anchor's; (b) both
 *   absorption/reduction cases (mac & cheese, wine reduction)
 *   individually improve on weight; (c) simple cases (soup, fondue)
 *   do not get wrecked: adjusted weight error <= anchor error + 5
 *   points (false-adjustment discipline). Volume is reported the
 *   same way but the bar is on weight: the volume anchor is
 *   structurally partial (only volume-measured ingredients count),
 *   so volume is the seat's stretch metric. If the bar fails, the
 *   seat does not ship — the result is reported instead.
 * - What this eval cannot show: accuracy across the full space of
 *   real user recipes; five reference cases support the calibration
 *   and ship call for a flag-off-by-default seat only.
 *
 * Run: OPENROUTER_API_KEY=<key> bun run scripts/yield-estimate-eval.ts
 */
import type { DecisionsConfig } from "../src/decisions/config.js";
import {
    computeYieldAnchor,
    estimateYieldForResolution,
} from "../src/decisions/yield-estimate.js";
import type {
    RecipeNutritionIngredientPayload,
    RecipeNutritionResolution,
} from "../src/recipe-nutrition-resolution.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[a2b-eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];
const REPEATS = 2;

function ing(
    name: string,
    quantity: number,
    unit: string,
    gramWeight: number,
): RecipeNutritionIngredientPayload {
    return {
        name,
        quantity,
        unit,
        gram_weight: gramWeight,
        nutrients: { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 },
        source_type: "usda",
        source_snapshot: {
            automatic_nutrition: { resolution: "provider_match" },
        },
    };
}

interface YieldCase {
    label: string;
    kind: "absorption" | "reduction" | "simple";
    knownWeightG: number;
    knownVolumeMl: number;
    resolution: RecipeNutritionResolution;
}

function resolutionOf(
    name: string,
    instructions: string[],
    ingredients: RecipeNutritionIngredientPayload[],
): RecipeNutritionResolution {
    return {
        providerMatches: ingredients.length,
        lowImpactEstimates: 0,
        unresolved: 0,
        estimatedPositions: ingredients.map((_, index) => index),
        unresolvedPositions: [],
        providerErrorPositions: [],
        recipe: { name, servings: 4, instructions, ingredients },
    };
}

const CASES: YieldCase[] = [
    {
        label: "mac & cheese (parboiled pasta + sauce, baked)",
        kind: "absorption",
        knownWeightG: 2050,
        knownVolumeMl: 1890,
        resolution: resolutionOf(
            "Smoked Mac and Cheese",
            [
                "Parboil the macaroni in well-salted water until just shy of done; drain.",
                "Melt the butter, whisk in the flour and milk, simmer until thick.",
                "Stir in the cheddar until melted, fold in the pasta, and bake in a 9x13 inch dish until bubbling.",
            ],
            [
                ing("elbow macaroni", 16, "oz", 453.59),
                ing("milk", 3, "cup", 732),
                ing("sharp cheddar", 12, "oz", 340.19),
                ing("all-purpose flour", 4, "tbsp", 31.25),
                ing("butter", 4, "tbsp", 56.8),
            ],
        ),
    },
    {
        label: "rice pilaf (dry rice + listed water, simmered covered)",
        kind: "absorption",
        knownWeightG: 555,
        knownVolumeMl: 710,
        resolution: resolutionOf(
            "Rice Pilaf",
            [
                "Melt the butter, toast the rice for 2 minutes.",
                "Add the water and salt, cover, and simmer on low for 18 minutes without lifting the lid.",
                "Rest 10 minutes off the heat, then fluff with a fork.",
            ],
            [
                ing("long-grain white rice", 1, "cup", 185),
                ing("water", 1.5, "cup", 354.9),
                ing("butter", 1, "tbsp", 14.2),
            ],
        ),
    },
    {
        label: "tomato soup (simmer 20 minutes, no reduction)",
        kind: "simple",
        knownWeightG: 1510,
        knownVolumeMl: 1460,
        resolution: resolutionOf(
            "Tomato Soup",
            [
                "Soften the onion in a little oil.",
                "Add the tomatoes and broth, simmer gently for 20 minutes.",
                "Stir in the cream, warm through, and serve.",
            ],
            [
                ing("crushed tomatoes", 28, "oz", 793.8),
                ing("chicken broth", 2, "cup", 488),
                ing("heavy cream", 0.5, "cup", 119),
                ing("onion", 1, "cup", 160),
            ],
        ),
    },
    {
        label: "red wine sauce (reduce by half)",
        kind: "reduction",
        knownWeightG: 360,
        knownVolumeMl: 355,
        resolution: resolutionOf(
            "Red Wine Pan Sauce",
            [
                "Sear the shallots in butter.",
                "Add the wine and stock and reduce by half over medium heat, until syrupy.",
                "Swirl in the remaining butter and serve immediately.",
            ],
            [
                ing("red wine", 2, "cup", 472),
                ing("beef stock", 1, "cup", 240),
                ing("shallot", 0.25, "cup", 40),
                ing("butter", 2, "tbsp", 28.4),
            ],
        ),
    },
    {
        label: "cheese fondue (melt only)",
        kind: "simple",
        knownWeightG: 690,
        knownVolumeMl: 640,
        resolution: resolutionOf(
            "Cheese Fondue",
            [
                "Warm the wine until steaming, do not boil.",
                "Toss the grated cheese with the cornstarch, then stir it into the wine a handful at a time until melted and smooth.",
                "Serve immediately with bread for dipping.",
            ],
            [
                ing("gruyere", 1, "lb", 453.59),
                ing("dry white wine", 1, "cup", 236),
                ing("cornstarch", 1, "tbsp", 8),
            ],
        ),
    },
];

/** Defensibility control: no method at all — the seat should
 * decline (or nearly) rather than invent a yield. Excluded from the
 * MAE scoring; only p(defensible) is read. */
const NO_METHOD_CASE = resolutionOf(
    "Mystery Casserole",
    [],
    [
        ing("ground beef", 1, "lb", 453.59),
        ing("rice", 2, "cup", 370),
        ing("tomato sauce", 15, "oz", 425),
    ],
);

function singleModelConfig(model: string): DecisionsConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY!.trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 1_500,
        deciderTimeoutMs: 2_000,
        gateEnabled: false,
        deciderEnabled: false,
        plausibilityEnabled: false,
        plausibilityTimeoutMs: 10_000,
        yieldEstimateEnabled: true,
        yieldEstimateTimeoutMs: 10_000,
    };
}

function pctError(estimate: number | null, known: number): number | null {
    if (estimate === null) return null;
    return (Math.abs(estimate - known) / known) * 100;
}

async function main(): Promise<void> {
    for (const model of MODELS) {
        const config = singleModelConfig(model);
        console.log(`\n=== ${model} ===`);
        let anchorWeightErrs: number[] = [];
        let adjustedWeightErrs: number[] = [];
        let anchorVolumeErrs: number[] = [];
        let adjustedVolumeErrs: number[] = [];
        let totalCost = 0;
        for (const testCase of CASES) {
            const anchor = computeYieldAnchor(testCase.resolution);
            const anchorW = pctError(anchor.weight_g, testCase.knownWeightG);
            const anchorV = pctError(anchor.volume_ml, testCase.knownVolumeMl);
            const adjusted: Array<{
                w: number | null;
                v: number | null;
                p?: number | null;
                f?: string;
            }> = [];
            for (let repeat = 0; repeat < REPEATS; repeat += 1) {
                const result = await estimateYieldForResolution(
                    testCase.resolution,
                    { config },
                );
                totalCost += result.reportedCostUsd ?? 0;
                const estimate = result.yieldEstimate;
                // A missing estimate scores at the ANCHOR's error:
                // fail-open means the user gets no adjustment, so the
                // seat earns no credit for the case.
                adjusted.push({
                    w: estimate
                        ? pctError(estimate.weight_g, testCase.knownWeightG)
                        : anchorW,
                    v: estimate
                        ? pctError(estimate.volume_ml, testCase.knownVolumeMl)
                        : anchorV,
                    p: result.probability ?? estimate?.probability ?? null,
                    f: `${result.status} ${estimate?.anchor?.weight_factor ?? "?"}/${estimate?.anchor?.volume_factor ?? "?"}`,
                });
            }
            if (anchorW !== null) anchorWeightErrs.push(anchorW);
            if (anchorV !== null) anchorVolumeErrs.push(anchorV);
            for (const entry of adjusted) {
                if (entry.w !== null) adjustedWeightErrs.push(entry.w);
                if (entry.v !== null) adjustedVolumeErrs.push(entry.v);
            }
            console.log(
                `[${testCase.kind}] ${testCase.label}\n  anchor err: weight ${anchorW?.toFixed(1)}% volume ${anchorV?.toFixed(1)}% | adjusted: ${adjusted.map((e) => `w ${e.w?.toFixed(1)}% v ${e.v?.toFixed(1)}% (p=${e.p}, factors ${e.f})`).join(" ; ")}`,
            );
        }
        const mae = (values: number[]) =>
            values.length
                ? values.reduce((sum, v) => sum + v, 0) / values.length
                : NaN;
        console.log(
            `  WEIGHT MAE: anchor ${mae(anchorWeightErrs).toFixed(1)}% -> adjusted ${mae(adjustedWeightErrs).toFixed(1)}% | VOLUME MAE: anchor ${mae(anchorVolumeErrs).toFixed(1)}% -> adjusted ${mae(adjustedVolumeErrs).toFixed(1)}% | total_cost_usd=${totalCost.toFixed(5)}`,
        );
        const control = await estimateYieldForResolution(NO_METHOD_CASE, {
            config,
        });
        console.log(
            `  defensibility control (no method): status=${control.status} p=${control.probability ?? "null"}`,
        );
    }
}

await main();
