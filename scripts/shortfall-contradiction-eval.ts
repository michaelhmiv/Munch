/**
 * C2 eval — plan/shortfall contradiction check (audit §2 seat C2).
 *
 * Validity notes (model_eval_validity skill):
 * - Call shape: PRODUCTION. Fixtures are rundown rows in the exact
 *   `ShortfallItemWithFlag` shape `getPlanShortfall` produces; state
 *   and questions come from the seat's own builders
 *   (`buildShortfallCheckState` / `buildShortfallCheckQuestions`);
 *   calls go through the shared `callDecisionsWithFallback` client.
 * - Per-model scoring: each candidate is forced as the SINGLE model
 *   in the chain (the bake-off method) so Jev and the Perplexity
 *   fallback are scored separately, with measured cost + latency
 *   from each response's `usage.cost`, not a pricing page.
 * - Fixture provenance: rows are constructed from the production
 *   shapes — planted contradictions (flag "have" + row "buy, pantry
 *   has none"; row claiming exact stock + flag "none"; an on-list
 *   item duplicated as a second buy row) and consistent-but-odd rows
 *   whose ground truth is fixed by the governing laws, not by hand
 *   guess: a "short" row with flag "have" is CORRECT by #283 /
 *   presence-only flag law (the headline false-alarm shape); a
 *   single "listed" row is already handled, not a contradiction.
 * - Pass bar, stated before the run: per model, catch rate >= 80%
 *   of planted contradiction rows AND false-alarm rate <= 12.5% of
 *   consistent rows, at that model's calibrated threshold. Errors
 *   split into abstentions (no parseable probability — fail-open,
 *   never a flag) vs wrong answers.
 * - What this eval cannot show: performance on real user rundowns
 *   (no production rundown corpus exists yet); it supports the
 *   threshold calibration and the ship/no-ship call for the seat's
 *   flag-on default OFF posture only.
 *
 * Run: OPENROUTER_API_KEY=... bun scripts/shortfall-contradiction-eval.ts
 */
import { callDecisionsWithFallback } from "../src/decisions/client.js";
import type { DecisionsConfig } from "../src/decisions/config.js";
import { noulProbability } from "../src/decisions/gate.js";
import {
    buildShortfallCheckQuestions,
    buildShortfallCheckState,
    type ShortfallCheckRow,
} from "../src/decisions/shortfall-check.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[c2-eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

type Row = ShortfallCheckRow & { expectContradiction: boolean; note: string };

function row(
    partial: Partial<ShortfallCheckRow> & { name: string },
    expectContradiction: boolean,
    note: string,
): Row {
    return {
        normalized_name: partial.name.toLowerCase(),
        need_quantity: 1,
        need_unit: "unit",
        have_quantity: 0,
        short_quantity: 1,
        pantry_state: "none",
        on_list: false,
        pantry_flag: { state: "none", pantry_item_id: null, pantry_name: null },
        ...partial,
        expectContradiction,
        note,
    } as Row;
}

const have = (name: string) => ({
    state: "have" as const,
    pantry_item_id: `inv-${name}`,
    pantry_name: name,
});
const none = {
    state: "none" as const,
    pantry_item_id: null,
    pantry_name: null,
};
const listed = (name: string) => ({
    state: "listed" as const,
    pantry_item_id: `inv-${name}`,
    pantry_name: name,
});

const RUNDOWNS: Array<{ name: string; rows: Row[] }> = [
    {
        name: "consistent-odd (low stock flagged have + buy row is CORRECT)",
        rows: [
            row(
                {
                    name: "Flour",
                    need_quantity: 500,
                    need_unit: "g",
                    have_quantity: 200,
                    short_quantity: 300,
                    pantry_state: "short",
                    pantry_flag: have("Flour"),
                },
                false,
                "short+have: presence-only flag, exact stock insufficient",
            ),
            row(
                {
                    name: "Chicken stock",
                    need_quantity: 4,
                    need_unit: "cup",
                    have_quantity: 1,
                    short_quantity: 3,
                    pantry_state: "short",
                    pantry_flag: have("Chicken stock"),
                },
                false,
                "short+have",
            ),
            row(
                {
                    name: "Milk",
                    need_quantity: 1,
                    need_unit: "l",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
            row(
                {
                    name: "Eggs",
                    need_quantity: 12,
                    need_unit: "count",
                    on_list: true,
                    pantry_flag: listed("Eggs"),
                },
                false,
                "single listed row: already handled",
            ),
        ],
    },
    {
        name: "consistent plain",
        rows: [
            row(
                {
                    name: "Rice",
                    need_quantity: 2,
                    need_unit: "cup",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
            row(
                {
                    name: "Pasta",
                    need_quantity: 500,
                    need_unit: "g",
                    have_quantity: 100,
                    short_quantity: 400,
                    pantry_state: "short",
                    pantry_flag: have("Pasta"),
                },
                false,
                "short+have",
            ),
            row(
                {
                    name: "Salt",
                    need_quantity: 1,
                    need_unit: "tbsp",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
        ],
    },
    {
        name: "planted: flag says have-it, row says buy (pantry none)",
        rows: [
            row(
                {
                    name: "Milk",
                    need_quantity: 1,
                    need_unit: "l",
                    pantry_flag: have("Milk"),
                },
                true,
                "none+have",
            ),
            row(
                {
                    name: "Flour",
                    need_quantity: 500,
                    need_unit: "g",
                    have_quantity: 200,
                    short_quantity: 300,
                    pantry_state: "short",
                    pantry_flag: have("Flour"),
                },
                false,
                "short+have",
            ),
            row(
                {
                    name: "Sugar",
                    need_quantity: 200,
                    need_unit: "g",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
        ],
    },
    {
        name: "planted: row claims exact stock, flag says not in pantry",
        rows: [
            row(
                {
                    name: "Butter",
                    need_quantity: 250,
                    need_unit: "g",
                    have_quantity: 100,
                    short_quantity: 150,
                    pantry_state: "short",
                    pantry_flag: none,
                },
                true,
                "short+none (reverse)",
            ),
            row(
                {
                    name: "Rice",
                    need_quantity: 2,
                    need_unit: "cup",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
        ],
    },
    {
        name: "planted: on-list item duplicated as a second buy row",
        rows: [
            row(
                {
                    name: "Eggs",
                    need_quantity: 12,
                    need_unit: "count",
                    on_list: true,
                    pantry_flag: listed("Eggs"),
                },
                false,
                "the listed row itself: already handled",
            ),
            row(
                {
                    name: "Eggs",
                    normalized_name: "eggs",
                    need_quantity: 12,
                    need_unit: "count",
                    pantry_flag: none,
                },
                true,
                "duplicate buy row for an already-listed item",
            ),
            row(
                {
                    name: "Milk",
                    need_quantity: 1,
                    need_unit: "l",
                    have_quantity: 0,
                    short_quantity: 1,
                    pantry_state: "none",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
        ],
    },
    {
        name: "mixed: two planted among consistent rows",
        rows: [
            row(
                {
                    name: "Cheese",
                    need_quantity: 200,
                    need_unit: "g",
                    pantry_flag: have("Cheese"),
                },
                true,
                "none+have",
            ),
            row(
                {
                    name: "Butter",
                    need_quantity: 250,
                    need_unit: "g",
                    have_quantity: 100,
                    short_quantity: 150,
                    pantry_state: "short",
                    pantry_flag: none,
                },
                true,
                "short+none (reverse)",
            ),
            row(
                {
                    name: "Flour",
                    need_quantity: 500,
                    need_unit: "g",
                    have_quantity: 200,
                    short_quantity: 300,
                    pantry_state: "short",
                    pantry_flag: have("Flour"),
                },
                false,
                "short+have",
            ),
            row(
                {
                    name: "Rice",
                    need_quantity: 2,
                    need_unit: "cup",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
            row(
                {
                    name: "Eggs",
                    need_quantity: 12,
                    need_unit: "count",
                    on_list: true,
                    pantry_flag: listed("Eggs"),
                },
                false,
                "single listed row",
            ),
            row(
                {
                    name: "Olive oil",
                    need_quantity: 250,
                    need_unit: "ml",
                    pantry_flag: none,
                },
                false,
                "none+none",
            ),
        ],
    },
];

const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];
const REPEATS = 2;
const THRESHOLDS_TO_TRY = [0.3, 0.5, 0.7];

function configFor(model: string): DecisionsConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY!.trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 10_000,
        deciderTimeoutMs: 10_000,
        gateEnabled: true,
        deciderEnabled: true,
        shortfallCheckEnabled: true,
        shortfallCheckTimeoutMs: 10_000,
    };
}

interface ScoredRow {
    rundown: string;
    item: string;
    note: string;
    expectContradiction: boolean;
    probability: number | null;
}

for (const model of MODELS) {
    const scored: ScoredRow[] = [];
    let totalCost = 0;
    let totalMs = 0;
    let calls = 0;
    for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (const rundown of RUNDOWNS) {
            const result = await callDecisionsWithFallback(configFor(model), {
                seat: "shortfall_check",
                timeoutMs: 10_000,
                includeImageHeader: false,
                state: buildShortfallCheckState(rundown.rows),
                questions: buildShortfallCheckQuestions(rundown.rows),
            });
            calls += 1;
            totalCost += result.reportedCostUsd ?? 0;
            totalMs += result.durationMs;
            rundown.rows.forEach((r, index) => {
                scored.push({
                    rundown: rundown.name,
                    item: r.name,
                    note: r.note,
                    expectContradiction: r.expectContradiction,
                    probability: noulProbability(result.answers[`r${index}`]),
                });
            });
        }
    }
    const positives = scored.filter((s) => s.expectContradiction);
    const negatives = scored.filter((s) => !s.expectContradiction);
    const abstentions = scored.filter((s) => s.probability === null).length;
    console.log(`\n=== ${model} ===`);
    console.log(
        `calls=${calls} rows_scored=${scored.length} abstentions=${abstentions} total_cost_usd=${totalCost.toFixed(6)} avg_ms=${Math.round(totalMs / calls)}`,
    );
    for (const s of scored) {
        console.log(
            `  p=${s.probability === null ? "null" : s.probability.toFixed(3)} expect=${s.expectContradiction ? "CONTRADICTION" : "consistent"} [${s.rundown}] ${s.item} — ${s.note}`,
        );
    }
    for (const threshold of THRESHOLDS_TO_TRY) {
        const caught = positives.filter(
            (s) => s.probability !== null && s.probability >= threshold,
        ).length;
        const falseAlarms = negatives.filter(
            (s) => s.probability !== null && s.probability >= threshold,
        ).length;
        console.log(
            `  threshold=${threshold}: catch=${caught}/${positives.length} (${((caught / positives.length) * 100).toFixed(1)}%) false_alarms=${falseAlarms}/${negatives.length} (${((falseAlarms / negatives.length) * 100).toFixed(1)}%)`,
        );
    }
}
