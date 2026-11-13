#!/usr/bin/env bun
/**
 * Stored-data sweep eval — ship gate for Pass 1 + Pass 2 (audit §3).
 *
 * Validity notes (model_eval_validity skill):
 * - Call shape: PRODUCTION. Pass 2 goes through the shared A1 checker
 *   (`reviewRecipePlausibility`) and the shared Decisions client
 *   (`callDecisionsWithFallback`) — the exact state, questions and wire
 *   shape the sweep ships. Each candidate model is forced as the
 *   SINGLE model in the chain and scored separately (the bake-off
 *   method); cost + latency are the API-reported `usage.cost` and
 *   measured wall time, not pricing-page estimates.
 * - Fixture provenance: specimens are STORED-shape records built from
 *   the real mac & cheese defect (PR #310's evidence: milk 61 g/cup at
 *   111.63 kcal, cheddar packaged at 48.65 g sugar/12 oz, flour
 *   unresolved via no_compatible_provider_portion) and from real
 *   nutrient profiles for the legitimately-unusual controls (olive oil
 *   ~884 kcal/100 g, honey ~1.42 g/ml, parmesan, butter). Ground truth
 *   is by construction: the three defect specimens ARE the documented
 *   corruption; the controls are real foods with real profiles.
 * - Pass bar (stated BEFORE the run):
 *   Pass 1: catches all three signatures; silent on every clean fixture.
 *   Pass 2, PER MODEL: confirms 3/3 defect specimens AND falsely
 *   accuses 0 legitimately-unusual specimens (false-accusation
 *   discipline is the headline metric).
 * - What this cannot show: accuracy on the real stored corpus (no
 *   production data is read here; the first live step is the dry-run
 *   the coordinator reviews). Constructed-fixture rates are provisional.
 *
 * Env: OPENROUTER_API_KEY required. SWEEP_EVAL_OUT for the report dir.
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
    reviewRecipePlausibility,
    per100gProfile,
    type PlausibilityIngredientState,
} from "../src/decisions/plausibility.js";
import type { DecisionsConfig } from "../src/decisions/config.js";
import {
    scanRecipe,
    type StoredIngredientRecord,
} from "../src/jev-sweep/prefilter.js";
import { automaticNutrition } from "../src/jev-sweep/prefilter.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[sweep-eval] OPENROUTER_API_KEY is required.");
    process.exit(1);
}

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];
const REPEATS = 2;

function ing(
    overrides: Partial<StoredIngredientRecord>,
): StoredIngredientRecord {
    return {
        name: "ingredient",
        quantity: 1,
        unit: null,
        gramWeight: 100,
        nutrients: { calories: 100 },
        sourceSnapshot: {},
        ...overrides,
    };
}

/** The real defect recipe (mac & cheese shape, PR #310 evidence). */
const DEFECT_RECIPES: Array<{
    id: string;
    expectSignature: string;
    recipe: { nutritionStatus: string; ingredients: StoredIngredientRecord[] };
}> = [
    {
        id: "milk-cup-61g",
        expectSignature: "assumed_portion_implausible",
        recipe: {
            nutritionStatus: "complete",
            ingredients: [
                ing({
                    name: "Whole Milk",
                    quantity: 3,
                    unit: "cup",
                    gramWeight: 183,
                    nutrients: {
                        calories: 111.63,
                        protein_g: 6,
                        carbs_g: 9,
                        fat_g: 6,
                    },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "assumed_provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Milk, whole, 3.25% milkfat",
                            portion_label:
                                "Guideline amount per cup of hot cereal",
                            implied_grams_per_unit: 61,
                        },
                    },
                }),
                ing({
                    name: "Elbow Macaroni",
                    quantity: 16,
                    unit: "oz",
                    gramWeight: 454,
                    nutrients: { calories: 1680 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Pasta, dry, enriched",
                        },
                    },
                }),
            ],
        },
    },
    {
        id: "cheddar-sugar-packaged",
        expectSignature: "packaged_profile_implausible",
        recipe: {
            nutritionStatus: "complete",
            ingredients: [
                ing({
                    name: "Sharp Cheddar Cheese",
                    quantity: 12,
                    unit: "oz",
                    gramWeight: 340,
                    nutrients: {
                        calories: 1370,
                        protein_g: 81,
                        carbs_g: 49,
                        fat_g: 108,
                        sugar_g: 48.65,
                    },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "packaged",
                            provider_food_name: "Sharp Cheddar Cheese",
                        },
                    },
                }),
            ],
        },
    },
    {
        id: "flour-unresolved",
        expectSignature: "unresolved_in_totals",
        recipe: {
            nutritionStatus: "partial",
            ingredients: [
                ing({
                    name: "All-Purpose Flour",
                    quantity: 4,
                    unit: "tbsp",
                    gramWeight: null,
                    nutrients: {},
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "unresolved",
                            reason: "no_compatible_provider_portion",
                        },
                    },
                }),
                ing({
                    name: "Butter",
                    quantity: 8,
                    unit: "tbsp",
                    gramWeight: 113,
                    nutrients: { calories: 810 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Butter, salted",
                        },
                    },
                }),
            ],
        },
    },
];

/** Legitimately unusual stored data — must NOT be accused. */
const CLEAN_RECIPES: Array<{
    id: string;
    note: string;
    /** Whether Pass 1 flags it (only the immaterial-partial case). */
    pass1Flags: boolean;
    recipe: { nutritionStatus: string; ingredients: StoredIngredientRecord[] };
}> = [
    {
        id: "real-olive-oil",
        note: "olive oil at ~884 kcal/100 g is real (pure fat)",
        pass1Flags: false,
        recipe: {
            nutritionStatus: "complete",
            ingredients: [
                ing({
                    name: "Olive Oil",
                    quantity: 2,
                    unit: "tbsp",
                    gramWeight: 27,
                    nutrients: { calories: 239, fat_g: 27 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Oil, olive, salad or cooking",
                        },
                    },
                }),
            ],
        },
    },
    {
        id: "real-honey-assumed",
        note: "honey assumed match at 21 g/tbsp (density 1.42) is real",
        pass1Flags: false,
        recipe: {
            nutritionStatus: "complete",
            ingredients: [
                ing({
                    name: "Honey",
                    quantity: 2,
                    unit: "tbsp",
                    gramWeight: 42,
                    nutrients: { calories: 128, sugar_g: 34 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "assumed_provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Honey",
                            implied_grams_per_unit: 21,
                        },
                    },
                }),
            ],
        },
    },
    {
        id: "real-parmesan-packaged",
        note: "packaged parmesan, dense + salty, trace sugar — real",
        pass1Flags: false,
        recipe: {
            nutritionStatus: "complete",
            ingredients: [
                ing({
                    name: "Parmesan Cheese",
                    quantity: 1,
                    unit: "cup",
                    gramWeight: 100,
                    nutrients: {
                        calories: 431,
                        protein_g: 38,
                        fat_g: 29,
                        sugar_g: 0.8,
                    },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "packaged",
                            provider_food_name: "Parmesan Cheese, grated",
                        },
                    },
                }),
            ],
        },
    },
    {
        id: "partial-immaterial-unresolved",
        note: "partial recipe whose only unresolved line is a 1 tsp dried herb garnish — immaterial",
        pass1Flags: true,
        recipe: {
            nutritionStatus: "partial",
            ingredients: [
                ing({
                    name: "Dried Parsley Flakes",
                    quantity: 1,
                    unit: "tsp",
                    gramWeight: null,
                    nutrients: {},
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "unresolved",
                            reason: "no_compatible_provider_portion",
                        },
                    },
                }),
                ing({
                    name: "Chicken Breast",
                    quantity: 1,
                    unit: "lb",
                    gramWeight: 454,
                    nutrients: { calories: 748, protein_g: 141 },
                    sourceSnapshot: {
                        automatic_nutrition: {
                            resolution: "provider_match",
                            provider_data_kind: "generic",
                            provider_food_name: "Chicken breast, raw",
                        },
                    },
                }),
            ],
        },
    },
];

function toState(
    ingredient: StoredIngredientRecord,
    flags: string[],
): PlausibilityIngredientState {
    const auto = automaticNutrition(ingredient);
    return {
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        resolution:
            typeof auto?.resolution === "string" ? auto.resolution : null,
        providerFoodName:
            typeof auto?.provider_food_name === "string"
                ? auto.provider_food_name
                : null,
        providerDataKind:
            typeof auto?.provider_data_kind === "string"
                ? auto.provider_data_kind
                : null,
        portionLabel:
            typeof auto?.portion_label === "string" ? auto.portion_label : null,
        gramWeight: ingredient.gramWeight,
        kcal:
            typeof ingredient.nutrients.calories === "number"
                ? ingredient.nutrients.calories
                : null,
        impliedGramsPerUnit:
            typeof auto?.implied_grams_per_unit === "number"
                ? auto.implied_grams_per_unit
                : null,
        deterministicFlags: flags,
    };
}

function configFor(model: string): DecisionsConfig {
    return {
        apiKey: String(process.env["OPENROUTER" + "_API_KEY"]).trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 1500,
        deciderTimeoutMs: 2000,
        gateEnabled: true,
        deciderEnabled: true,
        plausibilityTimeoutMs: 15_000,
        plausibilityEnabled: true,
    };
}

// ---------- Pass 1 ----------
const pass1Rows: Array<Record<string, unknown>> = [];
let pass1Pass = true;
for (const specimen of DEFECT_RECIPES) {
    const scan = scanRecipe(specimen.recipe);
    const caught = scan.flagged.some((flag) =>
        flag.signatures.includes(specimen.expectSignature as never),
    );
    if (!caught) pass1Pass = false;
    pass1Rows.push({ id: specimen.id, kind: "defect", caught, scan });
}
for (const specimen of CLEAN_RECIPES) {
    const scan = scanRecipe(specimen.recipe);
    const silent = specimen.pass1Flags ? scan.suspect : !scan.suspect;
    if (!silent) pass1Pass = false;
    pass1Rows.push({
        id: specimen.id,
        kind: "clean",
        expectedFlag: specimen.pass1Flags,
        suspect: scan.suspect,
        ok: silent,
    });
}

// ---------- Pass 2 (per model) ----------
interface CaseResult {
    id: string;
    truth: "defect" | "legit";
    pImplausible: number | null;
    confirmed: boolean;
    costUsd: number | null;
    ms: number;
}

const perModel: Record<string, CaseResult[]> = {};
for (const model of MODELS) {
    const results: CaseResult[] = [];
    const config = configFor(model);
    const cases: Array<{
        id: string;
        truth: "defect" | "legit";
        states: PlausibilityIngredientState[];
        profiles: Array<Record<string, number> | null>;
        targetIndex: number;
    }> = [];
    for (const specimen of DEFECT_RECIPES) {
        const scan = scanRecipe(specimen.recipe);
        const flagged = scan.flagged;
        cases.push({
            id: specimen.id,
            truth: "defect",
            states: flagged.map((flag) =>
                toState(
                    specimen.recipe.ingredients[flag.index]!,
                    flag.signatures.map(String),
                ),
            ),
            profiles: flagged.map((flag) =>
                per100gProfile(
                    specimen.recipe.ingredients[flag.index]!.nutrients,
                    specimen.recipe.ingredients[flag.index]!.gramWeight,
                ),
            ),
            targetIndex: 0,
        });
    }
    for (const specimen of CLEAN_RECIPES) {
        if (specimen.pass1Flags) {
            const scan = scanRecipe(specimen.recipe);
            cases.push({
                id: specimen.id,
                truth: "legit",
                states: scan.flagged.map((flag) =>
                    toState(
                        specimen.recipe.ingredients[flag.index]!,
                        flag.signatures.map(String),
                    ),
                ),
                profiles: scan.flagged.map((flag) =>
                    per100gProfile(
                        specimen.recipe.ingredients[flag.index]!.nutrients,
                        specimen.recipe.ingredients[flag.index]!.gramWeight,
                    ),
                ),
                targetIndex: 0,
            });
        } else {
            // Direct-checker probe: the live A1 seat sees EVERY
            // ingredient, so measure the checker itself on unusual-but-
            // real data even though Pass 1 would never flag it.
            cases.push({
                id: `${specimen.id} (direct)`,
                truth: "legit",
                states: specimen.recipe.ingredients.map((ingredient) =>
                    toState(ingredient, []),
                ),
                profiles: specimen.recipe.ingredients.map((ingredient) =>
                    per100gProfile(ingredient.nutrients, ingredient.gramWeight),
                ),
                targetIndex: 0,
            });
        }
    }
    for (const testCase of cases) {
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
            const started = Date.now();
            const review = await reviewRecipePlausibility(
                testCase.states,
                config,
                {},
                testCase.profiles,
            );
            const ms = Date.now() - started;
            if (review.status !== "reviewed") {
                results.push({
                    id: testCase.id,
                    truth: testCase.truth,
                    pImplausible: null,
                    confirmed: false,
                    costUsd: null,
                    ms,
                });
                continue;
            }
            const verdict = review.verdicts[testCase.targetIndex]!;
            results.push({
                id: testCase.id,
                truth: testCase.truth,
                pImplausible: verdict.pImplausible,
                confirmed: verdict.confirmedImplausible,
                costUsd: review.reportedCostUsd,
                ms,
            });
        }
    }
    perModel[model] = results;
}

// ---------- Report ----------
const lines: string[] = [];
lines.push(`# Jev sweep eval — ${new Date().toISOString()}`);
lines.push("");
lines.push(
    "Call shape: production (scanRecipe Pass 1; reviewRecipePlausibility + callDecisionsWithFallback Pass 2), one model per run, 2 repeats per case.",
);
lines.push(
    "Pass bar (stated pre-run): Pass 1 catches 3/3 signatures and stays silent on clean fixtures (except the by-design partial flag); Pass 2 per model confirms 3/3 defects and falsely accuses 0 legit specimens.",
);
lines.push("");
lines.push(`## Pass 1 (deterministic): ${pass1Pass ? "PASS" : "FAIL"}`);
for (const row of pass1Rows) lines.push(`- ${JSON.stringify(row)}`);
lines.push("");
for (const model of MODELS) {
    const results = perModel[model]!;
    const defects = results.filter((r) => r.truth === "defect");
    const legit = results.filter((r) => r.truth === "legit");
    const confirmed = defects.filter((r) => r.confirmed).length;
    const falseAccusations = legit.filter((r) => r.confirmed).length;
    const abstentions = results.filter((r) => r.pImplausible === null).length;
    const costs = results
        .map((r) => r.costUsd)
        .filter((c): c is number => c !== null);
    const avgCost =
        costs.length > 0
            ? costs.reduce((a, b) => a + b, 0) / costs.length
            : null;
    const avgMs = Math.round(
        results.reduce((sum, r) => sum + r.ms, 0) / Math.max(1, results.length),
    );
    lines.push(`## ${model}`);
    lines.push(
        `- Defect confirmation: ${confirmed}/${defects.length} (bar: all defect runs confirm)`,
    );
    lines.push(
        `- **FALSE-ACCUSATION count on legitimately unusual data: ${falseAccusations}/${legit.length} (bar: 0)**`,
    );
    lines.push(`- Abstentions: ${abstentions}/${results.length}`);
    lines.push(
        `- Cost/call: ${avgCost !== null ? `$${avgCost.toFixed(5)}` : "n/a"} avg (API-reported usage.cost); latency ${avgMs} ms avg`,
    );
    for (const r of results) {
        lines.push(
            `  - ${r.id} [${r.truth}] p_implausible=${r.pImplausible ?? "abstain"} confirmed=${r.confirmed} cost=${r.costUsd ?? "n/a"} ms=${r.ms}`,
        );
    }
    lines.push("");
}
lines.push(
    "What this cannot show: behaviour on the real stored corpus (constructed stored-shape fixtures only, ground truth by construction from PR #310's documented defect). The seat ships flag-off; the first live step is a reviewed dry-run.",
);

const report = lines.join("\n");
console.info(report);
const outDir = process.env.SWEEP_EVAL_OUT ?? "evidence/jev-sweep-eval";
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/report.md`, report);
await writeFile(
    `${outDir}/results.json`,
    JSON.stringify({ pass1Pass, pass1Rows, perModel }, null, 2),
);
