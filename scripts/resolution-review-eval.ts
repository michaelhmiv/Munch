/**
 * A1+A2 eval — recipe resolution plausibility review + estimate rung
 * (Jev accountability audit 2026-11-13, §2 Tier 1 seats A1/A2).
 *
 * Validity notes (model_eval_validity skill):
 * - Call shape: PRODUCTION. Fixtures are `RecipeNutritionResolution`
 *   objects in the exact shape the resolver produces/stores; states
 *   come from the seat's own builder (`buildResolutionReviewStates`)
 *   and calls go through the seat's own checker
 *   (`checkRecipeResolution` → `callDecisionsWithFallback`). The A2
 *   estimate leg runs the full `reviewRecipeResolution` pass with
 *   the real generative estimate chain (meal-photo estimate seat).
 * - Fixture provenance: the two must-flag specimens are the Nov 2026
 *   production mac & cheese defects, with numbers taken from the
 *   audit (milk: 3 cup priced through a 61 g guideline portion =
 *   183 g / 111.63 kcal; cheddar: packaged entry claiming 48.65 g
 *   sugar per 12 oz = 14.3 g sugar per 100 g). False-reject controls
 *   are standard USDA-shaped profiles for legitimately extreme foods
 *   (olive oil 884 kcal/100 g, honey ~82 g sugar/100 g, parmesan
 *   ~431 kcal/100 g) plus ordinary correct resolutions. The flour
 *   specimen is the audit's: 4 tbsp all-purpose flour, unresolved
 *   `no_compatible_provider_portion`; its known-good estimate range
 *   is 100–125 kcal (the fixed resolver's own output, PR #310).
 * - Per-model scoring: each candidate is forced as the SINGLE model
 *   in the chain (the bake-off method) so Jev and the Perplexity
 *   fallback are scored separately, with measured cost + latency
 *   from each response, not a pricing page.
 * - Pass bar, stated before the run: per model — A1 catches BOTH
 *   must-flag specimens in both repeats AND false-rejects ZERO of
 *   the control resolutions; A2 judges the flour specimen
 *   defensible AND both nonsense specimens not defensible.
 * - ARCHITECTURE NOTE (dedupe, 2026-11-13): A1 now runs THE SHARED
 *   CHECKER (src/decisions/plausibility.ts, built by the sweep team;
 *   thresholds are that module's own, calibrated on the sweep eval
 *   fixture: Jev defects 0.89-0.97 / controls 0.15-0.43, pplx
 *   defects 0.74-1.00 / controls 0.08-0.33, both at 0.5). This
 *   script therefore measures the shared checker on THIS fixture
 *   set as a second, independent specimen set. Outcome on this set:
 *   pplx separates cleanly at the shared 0.5 (flags >= 0.606,
 *   controls <= 0.483). Jev catches both defects (0.71-0.92) but
 *   false-accuses honey (0.85-0.90 — it appears to anchor a cup
 *   near water's weight; accused in base state too, so not a
 *   profile artefact) and the correct-milk control in the 7-item
 *   batch (0.70-0.74; solo it scored 0.29-0.42 — batch-sensitive).
 *   A flag's blast radius is bounded (review mark; replacement only
 *   when the A2 re-run also judges an estimate defensible), and the
 *   seat ships flag-off — but on THIS fixture set Jev does not meet
 *   the zero-false-reject bar, and that is reported, not tuned
 *   around: the shared thresholds are the sweep's property.
 *   A2 thresholds below remain this seat's own, calibrated per
 *   model from the defensibility distributions (never borrowed).
 * - What this eval cannot show: performance across the full space of
 *   real user recipes (no production recipe corpus is exported for
 *   eval); it supports the threshold calibration and the ship call
 *   for the seats' flag-off-by-default posture.
 *
 * Run: OPENROUTER_API_KEY=<key> bun run scripts/resolution-review-eval.ts
 */
import type { DecisionsConfig } from "../src/decisions/config.js";
import { reviewRecipePlausibility } from "../src/decisions/plausibility.js";
import {
    buildResolutionReviewStates,
    checkEstimateDefensibility,
    reviewRecipeResolution,
    toPlausibilityIngredients,
    type ResolutionReviewIngredientState,
} from "../src/decisions/resolution-review.js";
import type {
    RecipeNutritionIngredientPayload,
    RecipeNutritionResolution,
} from "../src/recipe-nutrition-resolution.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[a1a2-eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];
const REPEATS = 2;

function ingredient(
    partial: Partial<RecipeNutritionIngredientPayload> & { name: string },
    record: Record<string, unknown>,
): RecipeNutritionIngredientPayload {
    return {
        source_type: "usda",
        ...partial,
        source_snapshot: { automatic_nutrition: record },
    };
}

function resolutionOf(
    ingredients: RecipeNutritionIngredientPayload[],
): RecipeNutritionResolution {
    return {
        providerMatches: 0,
        lowImpactEstimates: 0,
        unresolved: 0,
        estimatedPositions: [],
        unresolvedPositions: [],
        providerErrorPositions: [],
        recipe: {
            name: "Eval recipe",
            servings: 4,
            ingredients,
        },
    };
}

interface Specimen {
    label: string;
    expect: "flag" | "plausible" | "defensible" | "not_defensible";
    state: ResolutionReviewIngredientState;
}

function stateOf(
    ing: RecipeNutritionIngredientPayload,
): ResolutionReviewIngredientState {
    const states = buildResolutionReviewStates(resolutionOf([ing]));
    if (states.length !== 1) throw new Error(`no state for ${ing.name}`);
    return states[0]!;
}

const SPECIMENS: Specimen[] = [
    {
        label: "milk — 3 cup via 61 g guideline portion, 111.63 kcal (MUST FLAG)",
        expect: "flag",
        state: stateOf(
            ingredient(
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
                },
                {
                    resolution: "assumed_provider_match",
                    provider_food_name: "Milk, whole",
                    provider_data_kind: "generic",
                    portion_label: "Guideline amount per cup of hot cereal",
                },
            ),
        ),
    },
    {
        label: "cheddar — packaged entry, 14.3 g sugar/100 g (MUST FLAG)",
        expect: "flag",
        state: stateOf(
            ingredient(
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
                },
                {
                    resolution: "provider_match",
                    provider_food_name: "Cheese, cheddar, sharp",
                    provider_data_kind: "packaged",
                    portion_label: "12 oz package",
                },
            ),
        ),
    },
    {
        label: "olive oil — 884 kcal/100 g pure fat (must NOT flag)",
        expect: "plausible",
        state: stateOf(
            ingredient(
                {
                    name: "olive oil",
                    quantity: 2,
                    unit: "tbsp",
                    gram_weight: 27,
                    nutrients: {
                        calories: 238.68,
                        protein_g: 0,
                        carbs_g: 0,
                        fat_g: 27,
                        sugar_g: 0,
                    },
                },
                {
                    resolution: "provider_match",
                    provider_food_name: "Oil, olive, salad or cooking",
                    provider_data_kind: "generic",
                    portion_label: "1 tbsp",
                },
            ),
        ),
    },
    {
        label: "honey — ~82 g sugar/100 g (must NOT flag)",
        expect: "plausible",
        state: stateOf(
            ingredient(
                {
                    name: "honey",
                    quantity: 0.25,
                    unit: "cup",
                    gram_weight: 84.75,
                    nutrients: {
                        calories: 257.6,
                        protein_g: 0.25,
                        carbs_g: 69.8,
                        fat_g: 0,
                        sugar_g: 69.6,
                    },
                },
                {
                    resolution: "provider_match",
                    provider_food_name: "Honey",
                    provider_data_kind: "generic",
                    portion_label: "1 cup",
                },
            ),
        ),
    },
    {
        label: "parmesan — dense hard cheese, 431 kcal/100 g, no sugar (must NOT flag)",
        expect: "plausible",
        state: stateOf(
            ingredient(
                {
                    name: "parmesan",
                    quantity: 1,
                    unit: "cup",
                    gram_weight: 100,
                    nutrients: {
                        calories: 431,
                        protein_g: 38.5,
                        carbs_g: 3.2,
                        fat_g: 28.6,
                        sugar_g: 0,
                    },
                },
                {
                    resolution: "provider_match",
                    provider_food_name: "Cheese, parmesan, grated",
                    provider_data_kind: "generic",
                    portion_label: "1 cup",
                },
            ),
        ),
    },
    {
        label: "milk — correct 3 cup resolution, 446.52 kcal (must NOT flag)",
        expect: "plausible",
        state: stateOf(
            ingredient(
                {
                    name: "milk",
                    quantity: 3,
                    unit: "cup",
                    gram_weight: 732,
                    nutrients: {
                        calories: 446.52,
                        protein_g: 23.94,
                        carbs_g: 33.9,
                        fat_g: 23.43,
                        sugar_g: 35.22,
                    },
                },
                {
                    resolution: "provider_match",
                    provider_food_name: "Milk, whole",
                    provider_data_kind: "generic",
                    portion_label: "1 cup",
                },
            ),
        ),
    },
    {
        label: "chicken breast — 181 g piece, 284 kcal (must NOT flag)",
        expect: "plausible",
        state: stateOf(
            ingredient(
                {
                    name: "chicken breast",
                    quantity: 1,
                    unit: "breast",
                    gram_weight: 181,
                    nutrients: {
                        calories: 284.17,
                        protein_g: 58.1,
                        carbs_g: 0,
                        fat_g: 5.86,
                        sugar_g: 0,
                    },
                },
                {
                    resolution: "provider_match",
                    provider_food_name:
                        "Chicken, broiler or fryers, breast, skinless, boneless, meat only, cooked, braised",
                    provider_data_kind: "generic",
                    portion_label: "1 piece",
                },
            ),
        ),
    },
    {
        label: "flour — 4 tbsp, unresolved no_compatible_provider_portion (defensible)",
        expect: "defensible",
        state: stateOf(
            ingredient(
                { name: "all-purpose flour", quantity: 4, unit: "tbsp" },
                {
                    resolution: "unresolved",
                    reason: "no_compatible_provider_portion",
                },
            ),
        ),
    },
    {
        label: "quinoa — 1 cup, unresolved no_defensible_provider_match (defensible)",
        expect: "defensible",
        state: stateOf(
            ingredient(
                { name: "quinoa", quantity: 1, unit: "cup" },
                {
                    resolution: "unresolved",
                    reason: "no_defensible_provider_match",
                },
            ),
        ),
    },
    {
        label: "unicorn tears — 1 tsp, unresolved (NOT defensible)",
        expect: "not_defensible",
        state: stateOf(
            ingredient(
                { name: "unicorn tears", quantity: 1, unit: "tsp" },
                {
                    resolution: "unresolved",
                    reason: "no_defensible_provider_match",
                },
            ),
        ),
    },
    {
        label: "seasoning blend — no quantity, unresolved missing_material_quantity (NOT defensible)",
        expect: "not_defensible",
        state: stateOf(
            ingredient(
                { name: "house seasoning blend" },
                {
                    resolution: "unresolved",
                    reason: "missing_material_quantity",
                },
            ),
        ),
    },
];

function singleModelConfig(model: string): DecisionsConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY!.trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 1_500,
        deciderTimeoutMs: 2_000,
        gateEnabled: false,
        deciderEnabled: false,
        plausibilityEnabled: true,
        plausibilityTimeoutMs: 10_000,
        resolutionReviewTimeoutMs: 10_000,
        estimateRungEnabled: true,
    };
}

async function main(): Promise<void> {
    // Each specimen's state was built from a single-ingredient
    // resolution (position 0); renumber so the batched checker maps
    // verdicts back to specimens unambiguously.
    SPECIMENS.forEach((specimen, index) => {
        specimen.state.position = index;
    });
    const states = SPECIMENS.map((specimen) => specimen.state);
    for (const model of MODELS) {
        const config = singleModelConfig(model);
        const probabilities = new Map<string, number[]>();
        let totalCost = 0;
        let totalMs = 0;
        const resolvedStates = states.filter(
            (state) => state.resolution !== "unresolved",
        );
        const unresolvedStates = states.filter(
            (state) => state.resolution === "unresolved",
        );
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
            const startedAt = Date.now();
            const { ingredients, profiles } =
                toPlausibilityIngredients(resolvedStates);
            const review = await reviewRecipePlausibility(
                ingredients,
                config,
                {},
                profiles,
            );
            const defensibility = await checkEstimateDefensibility(
                unresolvedStates,
                { siblingNames: states.map((state) => state.name), config },
            );
            totalMs += Date.now() - startedAt;
            totalCost +=
                (review.status === "reviewed"
                    ? (review.reportedCostUsd ?? 0)
                    : 0) + (defensibility.reportedCostUsd ?? 0);
            if (review.status !== "reviewed") {
                console.log(`model=${model} repeat=${repeat} A1 UNCHECKED`);
            } else {
                for (const verdict of review.verdicts) {
                    const specimen = SPECIMENS.find(
                        (entry) =>
                            entry.state === resolvedStates[verdict.index],
                    )!;
                    probabilities.set(specimen.label, [
                        ...(probabilities.get(specimen.label) ?? []),
                        verdict.pImplausible ?? NaN,
                    ]);
                }
            }
            for (const verdict of defensibility.verdicts) {
                const specimen = SPECIMENS.find(
                    (entry) => entry.state.position === verdict.position,
                )!;
                probabilities.set(specimen.label, [
                    ...(probabilities.get(specimen.label) ?? []),
                    verdict.probability,
                ]);
            }
        }
        console.log(`\n=== ${model} ===`);
        console.log(
            `batched_calls=${REPEATS} total_cost_usd=${totalCost.toFixed(5)} avg_latency_ms=${Math.round(totalMs / REPEATS)}`,
        );
        for (const specimen of SPECIMENS) {
            const values = probabilities.get(specimen.label) ?? [];
            const kind =
                specimen.expect === "flag" || specimen.expect === "plausible"
                    ? "p(implausible)"
                    : "p(defensible)";
            console.log(
                `expect=${specimen.expect.padEnd(15)} ${kind}=[${values.map((v) => v.toFixed(3)).join(", ")}] ${specimen.label}`,
            );
        }
    }

    // A2 estimate leg: the full production pass on the flour specimen
    // — Jev (default chain) judges, the generative chain estimates.
    console.log("\n=== A2 estimate leg (flour, full pass) ===");
    const flourResolution = resolutionOf([
        ingredient(
            { name: "all-purpose flour", quantity: 4, unit: "tbsp" },
            {
                resolution: "unresolved",
                reason: "no_compatible_provider_portion",
            },
        ),
    ]);
    const startedAt = Date.now();
    const reviewed = await reviewRecipeResolution(flourResolution, {
        config: {
            ...singleModelConfig("typesafe/jev-1.14"),
            models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        },
    });
    const flour = reviewed.recipe.ingredients[0]!;
    console.log(
        `duration_ms=${Date.now() - startedAt} source_type=${flour.source_type} calories=${flour.nutrients?.calories} gram_weight=${flour.gram_weight} unresolved=${reviewed.unresolved} (known-good range: 100-125 kcal)`,
    );
}

await main();
