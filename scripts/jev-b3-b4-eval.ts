/**
 * Eval for seats B3 + B4 (jev-accountability-audit §2) — run BEFORE
 * the PR, per the model_eval_validity skill:
 *
 * - Fixtures are production-shaped pairs/anomalies with ground truth
 *   from culinary fact (broth-class synonyms merge; prepared products
 *   made FROM an ingredient do not; mass cannot merge with volume).
 * - Every candidate is exercised through the EXACT production call
 *   shape: the seat modules' own state/question builders and
 *   `callDecisionsWithFallback`, one model at a time, scored PER
 *   MODEL (Jev primary, Perplexity fallback) with the serving
 *   model's own thresholds from `src/decisions/config.ts`.
 * - B3 fixtures carry the identity score the production scorer
 *   (`inventoryIdentityScore`) assigns; band membership is printed
 *   for every fixture. Unit-incompatible fixtures use identical
 *   names (score 0.95 — the resolver's deterministic path refuses
 *   them on unit grounds before any call), so they are evaluated at
 *   the seat level: what is being measured is the units question.
 * - Cost and latency are the API-reported values from the run.
 *
 * PASS BARS (stated before the run):
 * - B3 same-item recall ≥ 80% (≥4/5); false merges ≤ 1/6 (target 0);
 *   unit-incompatible pairs rejected ≥ 2/3 (target 3/3).
 * - B4 genuine anomalies flagged ≥ 3/4; benign false alarms ≤ 1/4.
 *
 * Usage: OPENROUTER_API_KEY=... bun run scripts/jev-b3-b4-eval.ts
 */
import {
    decisionsConfig,
    type DecisionsConfig,
} from "../src/decisions/config.js";
import {
    pantryPairMerges,
    reviewPantryIdentityPair,
    type PantryIdentityPair,
} from "../src/decisions/pantry-match.js";
import {
    drawdownAnomalyFlagged,
    reviewDrawdownAnomaly,
} from "../src/decisions/drawdown-review.js";
import {
    inventoryIdentityScore,
    isPantryGreyBandScore,
} from "../src/inventory/matching.js";
import type { DrawdownAnomaly } from "../src/inventory/drawdown.js";

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];

function modelConfig(model: string): DecisionsConfig {
    const base = decisionsConfig({
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
        MUNCH_JEV_ENABLED: "true",
    });
    if (!base) throw new Error("OPENROUTER_API_KEY is required");
    return { ...base, models: [model] };
}

// ---------------------------------------------------------------- B3
interface B3Fixture {
    label: string;
    category: "same" | "different" | "unit_incompatible";
    incoming: { name: string; quantity: number; unit: string };
    existing: { name: string; quantity: number; unit: string };
}

const B3_FIXTURES: B3Fixture[] = [
    // True-same pairs in the band — must merge.
    {
        label: "cheddar cheese ~ cheddar aged cheese",
        category: "same",
        incoming: { name: "cheddar cheese", quantity: 1, unit: "cup" },
        existing: { name: "cheddar aged cheese", quantity: 2, unit: "cup" },
    },
    {
        label: "shredded ~ sliced cheddar cheese",
        category: "same",
        incoming: { name: "shredded cheddar cheese", quantity: 2, unit: "cup" },
        existing: { name: "sliced cheddar cheese", quantity: 1, unit: "cup" },
    },
    {
        label: "ground beef chuck ~ ground beef sirloin",
        category: "same",
        incoming: { name: "ground beef chuck", quantity: 1, unit: "lb" },
        existing: { name: "ground beef sirloin", quantity: 2, unit: "lb" },
    },
    {
        label: "swiss cheese slices ~ swiss aged cheese slices",
        category: "same",
        incoming: { name: "swiss cheese slices", quantity: 4, unit: "count" },
        existing: {
            name: "swiss aged cheese slices",
            quantity: 8,
            unit: "count",
        },
    },
    {
        label: "brown rice ~ brown basmati rice",
        category: "same",
        incoming: { name: "brown rice", quantity: 2, unit: "cup" },
        existing: { name: "brown basmati rice", quantity: 3, unit: "cup" },
    },
    // True-different pairs in the band — must NOT merge (headline metric).
    {
        label: "cheddar cheese spread ~ cheddar aged cheese",
        category: "different",
        incoming: { name: "cheddar cheese spread", quantity: 1, unit: "cup" },
        existing: { name: "cheddar aged cheese", quantity: 2, unit: "cup" },
    },
    {
        label: "peanut butter cups ~ peanut butter creamy",
        category: "different",
        incoming: { name: "peanut butter cups", quantity: 6, unit: "count" },
        existing: { name: "peanut butter creamy", quantity: 1, unit: "cup" },
    },
    {
        label: "cream cheese frosting ~ cream cheese block",
        category: "different",
        incoming: { name: "cream cheese frosting", quantity: 1, unit: "cup" },
        existing: { name: "cream cheese block", quantity: 2, unit: "count" },
    },
    {
        label: "whole milk ~ whole goat milk",
        category: "different",
        incoming: { name: "whole milk", quantity: 4, unit: "cup" },
        existing: { name: "whole goat milk", quantity: 4, unit: "cup" },
    },
    {
        label: "ground beef patties ~ ground beef chuck",
        category: "different",
        incoming: { name: "ground beef patties", quantity: 4, unit: "count" },
        existing: { name: "ground beef chuck", quantity: 2, unit: "lb" },
    },
    {
        label: "coconut milk powder ~ coconut milk canned",
        category: "different",
        incoming: { name: "coconut milk powder", quantity: 1, unit: "cup" },
        existing: { name: "coconut milk canned", quantity: 2, unit: "count" },
    },
    // Same name, units that cannot be added — the units question must say no.
    {
        label: "chicken breast lb ~ chicken breast count",
        category: "unit_incompatible",
        incoming: { name: "chicken breast", quantity: 2, unit: "lb" },
        existing: { name: "chicken breast", quantity: 4, unit: "count" },
    },
    {
        label: "rice lb ~ rice cup",
        category: "unit_incompatible",
        incoming: { name: "rice", quantity: 5, unit: "lb" },
        existing: { name: "rice", quantity: 10, unit: "cup" },
    },
    {
        label: "flour kg ~ flour cup",
        category: "unit_incompatible",
        incoming: { name: "flour", quantity: 2, unit: "kg" },
        existing: { name: "flour", quantity: 8, unit: "cup" },
    },
];

// ---------------------------------------------------------------- B4
interface B4Fixture {
    label: string;
    category: "genuine" | "benign";
    anomaly: DrawdownAnomaly;
}

function anomaly(partial: Partial<DrawdownAnomaly>): DrawdownAnomaly {
    return {
        index: 0,
        kind: "draw_exceeds_stock",
        ingredient: "Rice",
        ingredientQuantity: 2,
        ingredientUnit: "cup",
        requestedQuantity: 2,
        requestedUnit: "cup",
        pantryItemId: "id-x",
        pantryName: "Rice",
        recordedQuantity: 6,
        recordedUnit: "cup",
        quantityMode: "exact",
        identityScore: 0.95,
        ...partial,
    };
}

const B4_FIXTURES: B4Fixture[] = [
    {
        label: "broth drawn from chicken breast (wrong match)",
        category: "genuine",
        anomaly: anomaly({
            ingredient: "chicken broth",
            ingredientQuantity: 8,
            ingredientUnit: "cup",
            requestedQuantity: 8,
            requestedUnit: "lb",
            pantryName: "chicken breast",
            recordedQuantity: 2,
            recordedUnit: "lb",
            identityScore: 0.67,
        }),
    },
    {
        label: "16 cups olive oil from a 1-cup bottle",
        category: "genuine",
        anomaly: anomaly({
            ingredient: "olive oil",
            ingredientQuantity: 16,
            ingredientUnit: "cup",
            requestedQuantity: 16,
            pantryName: "olive oil",
            recordedQuantity: 1,
        }),
    },
    {
        label: "3 cups garlic powder from a half-cup jar",
        category: "genuine",
        anomaly: anomaly({
            ingredient: "garlic powder",
            ingredientQuantity: 3,
            ingredientUnit: "cup",
            requestedQuantity: 3,
            pantryName: "garlic powder",
            recordedQuantity: 0.5,
        }),
    },
    {
        label: "20 cups milk from a 4-cup carton",
        category: "genuine",
        anomaly: anomaly({
            ingredient: "milk",
            ingredientQuantity: 20,
            ingredientUnit: "cup",
            requestedQuantity: 20,
            pantryName: "milk",
            recordedQuantity: 4,
        }),
    },
    {
        label: "2 cups butter from 1.5 cups (holiday baking)",
        category: "benign",
        anomaly: anomaly({
            ingredient: "butter",
            ingredientQuantity: 2,
            ingredientUnit: "cup",
            requestedQuantity: 2,
            pantryName: "butter",
            recordedQuantity: 1.5,
        }),
    },
    {
        label: "24 eggs from 18 (big breakfast event)",
        category: "benign",
        anomaly: anomaly({
            ingredient: "eggs",
            ingredientQuantity: 24,
            ingredientUnit: "count",
            requestedQuantity: 24,
            requestedUnit: "count",
            pantryName: "eggs",
            recordedQuantity: 18,
            recordedUnit: "count",
        }),
    },
    {
        label: "approximate rice 4 cups drawn from ~4 cups (family dinner)",
        category: "benign",
        anomaly: anomaly({
            kind: "approximate_remainder_flip",
            ingredient: "rice",
            ingredientQuantity: 4,
            requestedQuantity: 4,
            recordedQuantity: 4,
            quantityMode: "approximate",
        }),
    },
    {
        label: "6 cups flour from 5 cups (bread baking)",
        category: "benign",
        anomaly: anomaly({
            ingredient: "flour",
            ingredientQuantity: 6,
            ingredientUnit: "cup",
            requestedQuantity: 6,
            pantryName: "flour",
            recordedQuantity: 5,
        }),
    },
];

// ---------------------------------------------------------------- run
async function main() {
    const report: Record<string, unknown> = {};
    for (const model of MODELS) {
        const config = modelConfig(model);
        const b3Rows: Array<Record<string, unknown>> = [];
        let b3Cost = 0;
        for (const fixture of B3_FIXTURES) {
            const score = inventoryIdentityScore(
                {
                    normalized_name: fixture.existing.name.toLowerCase(),
                    food_provider: null,
                    provider_food_id: null,
                },
                { name: fixture.incoming.name },
            );
            const pair: PantryIdentityPair = {
                incoming: fixture.incoming,
                existing: {
                    id: "eval",
                    name: fixture.existing.name,
                    quantity: fixture.existing.quantity,
                    unit: fixture.existing.unit,
                    quantityMode: "exact",
                },
                identityScore: score,
            };
            const started = Date.now();
            const review = await reviewPantryIdentityPair(pair, config);
            b3Cost += review.reportedCostUsd ?? 0;
            b3Rows.push({
                label: fixture.label,
                category: fixture.category,
                identity_score: Number(score.toFixed(3)),
                in_grey_band: isPantryGreyBandScore(score),
                p_same_item: review.pSameItem,
                p_units_compatible: review.pUnitsCompatible,
                merges: pantryPairMerges(pair, review),
                latency_ms: Date.now() - started,
                cost_usd: review.reportedCostUsd,
            });
        }
        const b4Rows: Array<Record<string, unknown>> = [];
        let b4Cost = 0;
        for (const fixture of B4_FIXTURES) {
            const started = Date.now();
            const review = await reviewDrawdownAnomaly(fixture.anomaly, config);
            b4Cost += review.reportedCostUsd ?? 0;
            b4Rows.push({
                label: fixture.label,
                category: fixture.category,
                p_match_correct: review.pMatchCorrect,
                p_quantity_plausible: review.pQuantityPlausible,
                flagged: drawdownAnomalyFlagged(review),
                latency_ms: Date.now() - started,
                cost_usd: review.reportedCostUsd,
            });
        }
        const same = b3Rows.filter((r) => r.category === "same");
        const different = b3Rows.filter((r) => r.category === "different");
        const unit = b3Rows.filter((r) => r.category === "unit_incompatible");
        const genuine = b4Rows.filter((r) => r.category === "genuine");
        const benign = b4Rows.filter((r) => r.category === "benign");
        report[model] = {
            b3: {
                same_recall: `${same.filter((r) => r.merges).length}/${same.length}`,
                false_merges: `${different.filter((r) => r.merges).length}/${different.length}`,
                unit_incompatible_rejected: `${unit.filter((r) => !r.merges).length}/${unit.length}`,
                total_cost_usd: Number(b3Cost.toFixed(6)),
                rows: b3Rows,
            },
            b4: {
                genuine_flagged: `${genuine.filter((r) => r.flagged).length}/${genuine.length}`,
                benign_false_alarms: `${benign.filter((r) => r.flagged).length}/${benign.length}`,
                total_cost_usd: Number(b4Cost.toFixed(6)),
                rows: b4Rows,
            },
        };
        console.log(`\n=== ${model} ===`);
        console.log(
            `B3 same recall ${report[model]!.b3.same_recall} · false merges ${(report[model] as any).b3.false_merges} · unit-incompatible rejected ${(report[model] as any).b3.unit_incompatible_rejected} · cost $${b3Cost.toFixed(5)}`,
        );
        console.log(
            `B4 genuine flagged ${(report[model] as any).b4.genuine_flagged} · benign false alarms ${(report[model] as any).b4.benign_false_alarms} · cost $${b4Cost.toFixed(5)}`,
        );
    }
    console.log("\n=== FULL JSON ===");
    console.log(JSON.stringify(report, null, 2));
}

await main();
