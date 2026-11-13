/**
 * A3 draft numeric-review eval (model_eval_validity skill; ship gate 1
 * for seat A3, jev-accountability-audit 2026-11-13 §2).
 *
 * Call shape: the PRODUCTION shape — the same seat functions
 * (`reviewDraftNumbers`, `reviewBulkImportRows`), state/question
 * builders, thresholds (src/decisions/config.ts) and Decisions client
 * the seat ships with. Each model is scored SEPARATELY by restricting
 * the chain to that single model, because Jev and the Perplexity
 * fallback have different probability distributions and thresholds
 * are per-model.
 *
 * PIXEL-FREE: no fixture carries an image and the seat has no image
 * input — every case is the grounded draft's numbers, exactly as
 * production sends them.
 *
 * Fixtures: PRODUCTION-SHAPED constructed groundings. There is no
 * pool of real mis-grounded drafts to sample (the defect class is
 * rare and unlabelled in production), so ground truth is BY
 * CONSTRUCTION from reference values: a real cup of olive oil is
 * ~216 g / ~884 kcal per 100 g (USDA olive oil), a tablespoon of
 * ketchup ~17 g, a cup of milk ~244 g (the PR #310 specimen inverted:
 * 61 g per cup was the defect). "Insane" cases take a correct food
 * and break ONLY the portion conversion, under the deterministic
 * MAX_GENERIC_PORTION_FACTOR cap — the exact class A3 exists to
 * catch. "Correct" cases include legitimately extreme items (a real
 * cup of oil IS ~1,900 kcal) — false-flag discipline on those is
 * the headline metric.
 *
 * PASS BAR (stated before the run): per model, draft catch rate on
 * insane items >= 75% AND false-flag rate on correct items <= 25%;
 * bulk: insane outlier candidates flagged >= 75%, genuine feast
 * candidates false-flagged <= 25%. This measures separation on
 * plausible production inputs; it does NOT measure the real-world
 * false-flag rate, and the report says so.
 *
 * Env: OPENROUTER_API_KEY required. A3EVAL_OUT for the report dir.
 * Exit 2 without a key; exit 0 when a report was produced.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionsConfig } from "../src/decisions/config.js";
import {
    reviewBulkImportRows,
    reviewDraftNumbers,
    type BulkReviewRow,
    type DraftReviewItem,
} from "../src/decisions/draft-review.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[a3eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

const OUT = process.env.A3EVAL_OUT ?? join(process.cwd(), "a3-eval-report");
const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];

function configFor(model: string): DecisionsConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY!.trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 2_000,
        deciderTimeoutMs: 2_000,
        gateEnabled: false,
        deciderEnabled: false,
        draftReviewTimeoutMs: 10_000,
        draftReviewEnabled: true,
    };
}

interface DraftFixture {
    id: string;
    items: DraftReviewItem[];
    /** Per-item expected label, aligned with items. */
    labels: Array<"insane" | "correct">;
}

const DRAFTS: DraftFixture[] = [
    {
        id: "insane-oil-milk-condiment",
        items: [
            {
                foodName: "Olive oil",
                portionLabel: "1 cup",
                grams: 32,
                kcal: 283,
                groundingSource: "USDA",
            },
            {
                foodName: "Whole milk",
                portionLabel: "3 cup",
                grams: 183,
                kcal: 112,
                groundingSource: "USDA",
            },
            {
                foodName: "Ketchup",
                portionLabel: "1 tbsp",
                grams: 240,
                kcal: 228,
                groundingSource: "Open Food Facts",
            },
        ],
        labels: ["insane", "insane", "insane"],
    },
    {
        id: "insane-beverage-butter-sauce",
        items: [
            {
                foodName: "Orange juice",
                portionLabel: "1 glass",
                grams: 620,
                kcal: 279,
                groundingSource: "USDA",
            },
            {
                foodName: "Butter",
                portionLabel: "1 tbsp",
                grams: 100,
                kcal: 717,
                groundingSource: "USDA",
            },
            {
                foodName: "Soy sauce",
                portionLabel: "1 tbsp",
                grams: 250,
                kcal: 133,
                groundingSource: "Open Food Facts",
            },
        ],
        labels: ["insane", "insane", "insane"],
    },
    {
        id: "correct-extremes",
        items: [
            {
                foodName: "Olive oil",
                portionLabel: "1 cup",
                grams: 216,
                kcal: 1909,
                groundingSource: "USDA",
            },
            {
                foodName: "Peanut butter",
                portionLabel: "2 tbsp",
                grams: 32,
                kcal: 188,
                groundingSource: "USDA",
            },
            {
                foodName: "Cheddar cheese",
                portionLabel: "1 oz",
                grams: 28,
                kcal: 113,
                groundingSource: "USDA",
            },
        ],
        labels: ["correct", "correct", "correct"],
    },
    {
        id: "correct-plate",
        items: [
            {
                foodName: "Chicken breast, grilled",
                portionLabel: "1 breast",
                grams: 172,
                kcal: 284,
                groundingSource: "USDA",
            },
            {
                foodName: "White rice, cooked",
                portionLabel: "1 cup",
                grams: 186,
                kcal: 242,
                groundingSource: "USDA",
            },
            {
                foodName: "Honey",
                portionLabel: "1 tbsp",
                grams: 21,
                kcal: 64,
                groundingSource: "USDA",
            },
            {
                foodName: "Avocado",
                portionLabel: "1 whole",
                grams: 150,
                kcal: 240,
                groundingSource: "USDA",
            },
            {
                foodName: "Salmon fillet, baked",
                portionLabel: "1 fillet",
                grams: 170,
                kcal: 354,
                groundingSource: "USDA",
            },
        ],
        labels: ["correct", "correct", "correct", "correct", "correct"],
    },
    {
        id: "mixed-plate",
        items: [
            {
                foodName: "Chicken breast, grilled",
                portionLabel: "1 breast",
                grams: 172,
                kcal: 284,
                groundingSource: "USDA",
            },
            {
                foodName: "Olive oil",
                portionLabel: "1 cup",
                grams: 32,
                kcal: 283,
                groundingSource: "USDA",
            },
            {
                foodName: "White rice, cooked",
                portionLabel: "1 cup",
                grams: 186,
                kcal: 242,
                groundingSource: "USDA",
            },
        ],
        labels: ["correct", "insane", "correct"],
    },
];

function bulkRow(partial: Partial<BulkReviewRow>): BulkReviewRow {
    return {
        description: "Meal",
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        alcohol_g: null,
        ...partial,
    };
}

const NORMAL_BATCH: BulkReviewRow[] = [
    bulkRow({ description: "Oatmeal and fruit", kcal: 420 }),
    bulkRow({ description: "Chicken sandwich", kcal: 560 }),
    bulkRow({ description: "Pasta with tomato sauce", kcal: 640 }),
    bulkRow({ description: "Green salad with egg", kcal: 380 }),
    bulkRow({ description: "Beef stew", kcal: 590 }),
    bulkRow({ description: "Yogurt and granola", kcal: 450 }),
];

interface BulkFixture {
    id: string;
    rows: BulkReviewRow[];
    insaneDescriptions: string[];
    genuineDescriptions: string[];
}

const BULK_SETS: BulkFixture[] = [
    {
        id: "bulk-insane",
        rows: [
            ...NORMAL_BATCH,
            bulkRow({ description: "Side salad", kcal: 6200 }),
            bulkRow({
                description: "Grilled chicken plate",
                kcal: 1800,
                protein_g: 40,
                carbs_g: 30,
                fat_g: 20,
            }),
        ],
        insaneDescriptions: ["Side salad", "Grilled chicken plate"],
        genuineDescriptions: [],
    },
    {
        id: "bulk-genuine-feasts",
        rows: [
            ...NORMAL_BATCH,
            bulkRow({ description: "Thanksgiving feast plate", kcal: 4300 }),
            bulkRow({ description: "Whole large pizza", kcal: 2800 }),
        ],
        insaneDescriptions: [],
        genuineDescriptions: ["Thanksgiving feast plate", "Whole large pizza"],
    },
];

interface ItemScore {
    draft: string;
    food: string;
    label: "insane" | "correct";
    pPlausible: number | null;
    flagged: boolean | null;
}

const report: Record<string, unknown> = { models: {} };

for (const model of MODELS) {
    const startedAt = Date.now();
    const itemScores: ItemScore[] = [];
    let draftCost = 0;
    let draftCalls = 0;
    for (const draft of DRAFTS) {
        const outcome = await reviewDraftNumbers(draft.items, {
            config: configFor(model),
        });
        if (outcome.status === "reviewed") {
            draftCalls += 1;
            draftCost += outcome.reportedCostUsd ?? 0;
            for (const verdict of outcome.verdicts) {
                itemScores.push({
                    draft: draft.id,
                    food: draft.items[verdict.index]!.foodName,
                    label: draft.labels[verdict.index]!,
                    pPlausible: verdict.pPlausible,
                    flagged: verdict.flagged,
                });
            }
        } else {
            for (const [i, item] of draft.items.entries()) {
                itemScores.push({
                    draft: draft.id,
                    food: item.foodName,
                    label: draft.labels[i]!,
                    pPlausible: null,
                    flagged: null,
                });
            }
        }
    }
    const insane = itemScores.filter((s) => s.label === "insane");
    const correct = itemScores.filter((s) => s.label === "correct");
    const caught = insane.filter((s) => s.flagged === true).length;
    const falseFlags = correct.filter((s) => s.flagged === true).length;

    const bulkScores: Array<{
        set: string;
        description: string;
        kind: "insane" | "genuine";
        flagged: boolean;
    }> = [];
    let bulkCost = 0;
    for (const set of BULK_SETS) {
        const outcome = await reviewBulkImportRows(set.rows, {
            config: configFor(model),
        });
        bulkCost += outcome.reportedCostUsd ?? 0;
        const flaggedNames = new Set(outcome.flagged.map((f) => f.description));
        for (const name of set.insaneDescriptions) {
            bulkScores.push({
                set: set.id,
                description: name,
                kind: "insane",
                flagged: flaggedNames.has(name),
            });
        }
        for (const name of set.genuineDescriptions) {
            bulkScores.push({
                set: set.id,
                description: name,
                kind: "genuine",
                flagged: flaggedNames.has(name),
            });
        }
    }
    const bulkInsane = bulkScores.filter((s) => s.kind === "insane");
    const bulkGenuine = bulkScores.filter((s) => s.kind === "genuine");
    const bulkCaught = bulkInsane.filter((s) => s.flagged).length;
    const bulkFalse = bulkGenuine.filter((s) => s.flagged).length;

    (report.models as Record<string, unknown>)[model] = {
        draft: {
            insane_total: insane.length,
            insane_caught: caught,
            catch_rate: insane.length ? caught / insane.length : null,
            correct_total: correct.length,
            correct_false_flagged: falseFlags,
            false_flag_rate: correct.length
                ? falseFlags / correct.length
                : null,
            calls: draftCalls,
            total_cost_usd: draftCost,
            items: itemScores,
        },
        bulk: {
            insane_total: bulkInsane.length,
            insane_caught: bulkCaught,
            genuine_total: bulkGenuine.length,
            genuine_false_flagged: bulkFalse,
            total_cost_usd: bulkCost,
            rows: bulkScores,
        },
        duration_ms: Date.now() - startedAt,
    };
    console.log(
        `[a3eval] ${model}: draft catch ${caught}/${insane.length}, false-flag ${falseFlags}/${correct.length}, bulk catch ${bulkCaught}/${bulkInsane.length}, bulk false ${bulkFalse}/${bulkGenuine.length}, cost $${(draftCost + bulkCost).toFixed(5)}`,
    );
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "results.json"), JSON.stringify(report, null, 2));
const lines: string[] = [
    "# A3 draft numeric-review eval — results",
    "",
    "Production call shape (reviewDraftNumbers / reviewBulkImportRows, per-model single-model chains), constructed production-shaped fixtures; ground truth by construction from reference values. This measures separation on plausible inputs, NOT the real-world false-flag rate.",
    "",
];
for (const [model, result] of Object.entries(
    report.models as Record<string, any>,
)) {
    lines.push(
        `## ${model}`,
        "",
        `- Draft insane catch: ${result.draft.insane_caught}/${result.draft.insane_total} (${result.draft.catch_rate})`,
        `- Draft correct false-flag: ${result.draft.correct_false_flagged}/${result.draft.correct_total} (${result.draft.false_flag_rate}) — headline metric`,
        `- Draft calls: ${result.draft.calls}, API-reported cost: $${result.draft.total_cost_usd}`,
        `- Bulk insane catch: ${result.bulk.insane_caught}/${result.bulk.insane_total}; genuine false-flag: ${result.bulk.genuine_false_flagged}/${result.bulk.genuine_total}; cost: $${result.bulk.total_cost_usd}`,
        "",
        "| draft | food | label | p(plausible) | flagged |",
        "|---|---|---|---|---|",
        ...result.draft.items.map(
            (s: ItemScore) =>
                `| ${s.draft} | ${s.food} | ${s.label} | ${s.pPlausible ?? "unchecked"} | ${s.flagged ?? "unchecked"} |`,
        ),
        "",
    );
}
await writeFile(join(OUT, "report.md"), lines.join("\n"));
console.log(`[a3eval] report written to ${OUT}`);
