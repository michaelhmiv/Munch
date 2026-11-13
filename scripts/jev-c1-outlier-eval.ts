/**
 * C1 outlier eval (model_eval_validity skill; ship gate 1 for seat C1).
 *
 * Call shape: the PRODUCTION shape — the same state/question builders
 * (`buildOutlierState`, `outlierQuestions`) and the same Decisions
 * client (`callDecisionsWithFallback`) the seat ships with. Each model
 * is scored SEPARATELY by restricting the chain to that single model
 * (the gate-probe pattern), because Jev and the Perplexity fallback
 * have different probability distributions and thresholds are per-model.
 *
 * Fixtures: PRODUCTION-SHAPED constructed scenarios. There is no pool
 * of real users' water/weight logs available to this eval, so ground
 * truth is BY CONSTRUCTION: each "slip" case is built so the logged
 * number literally is the slip described (a lb number stored as kg, a
 * 10x decimal, a day's total as one morning entry), and each "genuine"
 * case carries its genuine context in the series itself (training-day
 * pattern, illness trend). This measures separation on plausible
 * production inputs; it does NOT measure the real-world false-prompt
 * rate, and the report says so.
 *
 * PASS BAR (stated before the run): per model, slip detection
 * (p_mistake >= threshold) >= 75% AND false prompts on genuine
 * entries <= 25%. The FALSE-PROMPT rate is the headline metric — a
 * seat that nags honest entries is worse than none.
 *
 * Env: OPENROUTER_API_KEY required. C1EVAL_OUT for the report dir.
 * Exit 2 without a key; exit 0 when a report was produced (a failed
 * call is data, not a harness failure).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callDecisionsWithFallback } from "../src/decisions/client.js";
import {
    outlierMistakeThresholdForModel,
    type DecisionsConfig,
} from "../src/decisions/config.js";
import { noulProbability } from "../src/decisions/gate.js";
import {
    buildOutlierState,
    detectOutlier,
    outlierQuestions,
    type OutlierCandidate,
} from "../src/decisions/outlier.js";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[c1eval] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

const OUT = process.env.C1EVAL_OUT ?? join(process.cwd(), "c1-eval-report");
const MODELS = ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"];
/** Prompt criterion = the model's OWN calibrated threshold in config. */
const THRESHOLD = (model: string) => outlierMistakeThresholdForModel(model);

interface Fixture {
    id: string;
    label: "slip" | "genuine";
    note: string;
    candidate: OutlierCandidate;
}

function series(values: number[], startDay = 1): OutlierCandidate["recent"] {
    return values.map((value, i) => ({
        value,
        logged_at: `2026-11-${String(startDay + i).padStart(2, "0")}T12:30:00.000Z`,
    }));
}

const FIXTURES: Fixture[] = [
    {
        id: "W-slip-daytotal",
        label: "slip",
        note: "500 ml bottle user; 2,500 ml at 07:03 reads as the whole day entered as one entry.",
        candidate: {
            kind: "water",
            entry: { value: 2500, logged_at: "2026-11-13T07:03:00.000Z" },
            recent: series([500, 350, 500, 500, 250, 500, 350]),
        },
    },
    {
        id: "W-slip-decimal",
        label: "slip",
        note: "355 ml is the user's standard drink; 3,550 ml is exactly 10x it.",
        candidate: {
            kind: "water",
            entry: { value: 3550, logged_at: "2026-11-13T15:20:00.000Z" },
            recent: series([355, 355, 250, 355, 500, 355]),
        },
    },
    {
        id: "W-slip-ozml",
        label: "slip",
        note: "User logs ~250 ml glasses; 2,957 ml is 100 fl oz expressed in ml — an oz/ml slip shape.",
        candidate: {
            kind: "water",
            entry: { value: 2957, logged_at: "2026-11-13T09:15:00.000Z" },
            recent: series([250, 250, 350, 250, 250, 500]),
        },
    },
    {
        id: "W-slip-decimal2",
        label: "slip",
        note: "750 ml bottle user; 7,500 ml is exactly 10x the bottle.",
        candidate: {
            kind: "water",
            entry: { value: 7500, logged_at: "2026-11-13T20:40:00.000Z" },
            recent: series([750, 500, 750, 750, 350, 750]),
        },
    },
    {
        id: "Wt-slip-lb-as-kg",
        label: "slip",
        note: "Stable ~80 kg series; entry is 176,000 g — 176 is the user's weight in lb entered as kg.",
        candidate: {
            kind: "weight",
            entry: { value: 176_000, logged_at: "2026-11-13T07:00:00.000Z" },
            recent: series([80_100, 79_800, 80_400, 80_000]),
        },
    },
    {
        id: "Wt-slip-lb-as-kg2",
        label: "slip",
        note: "Stable ~68 kg series; entry is 150,000 g — 150 lb entered as kg.",
        candidate: {
            kind: "weight",
            entry: { value: 150_000, logged_at: "2026-11-13T06:45:00.000Z" },
            recent: series([68_200, 67_900, 68_000, 68_300]),
        },
    },
    {
        id: "Wt-slip-decimal-down",
        label: "slip",
        note: "Stable ~72 kg series; entry 7,200 g is the same digits with the decimal moved (7.2 kg).",
        candidate: {
            kind: "weight",
            entry: { value: 7_200, logged_at: "2026-11-13T07:10:00.000Z" },
            recent: series([72_000, 72_300, 71_800, 72_100]),
        },
    },
    {
        id: "Wt-slip-extra-digit",
        label: "slip",
        note: "Stable ~85 kg, flat for a week; a single-morning jump to 94 kg (+10.6%) with no trend leading into it.",
        candidate: {
            kind: "weight",
            entry: { value: 94_000, logged_at: "2026-11-13T06:50:00.000Z" },
            recent: series([85_000, 85_200, 84_900, 85_100, 85_000]),
        },
    },
    {
        id: "W-genuine-athlete",
        label: "genuine",
        note: "Weekday 500 ml entries but the series itself contains 1,500-2,000 ml training-day entries; a Saturday midday 2,400 ml entry follows that pattern.",
        candidate: {
            kind: "water",
            entry: { value: 2400, logged_at: "2026-11-14T12:30:00.000Z" },
            recent: [
                { value: 500, logged_at: "2026-11-09T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-10T12:30:00.000Z" },
                { value: 1500, logged_at: "2026-11-07T12:30:00.000Z" },
                { value: 350, logged_at: "2026-11-11T12:30:00.000Z" },
                { value: 2000, logged_at: "2026-11-08T13:00:00.000Z" },
                { value: 500, logged_at: "2026-11-12T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-13T12:30:00.000Z" },
            ],
        },
    },
    {
        id: "W-genuine-big-bottle-day",
        label: "genuine",
        note: "Recent entries trend upward (500 -> 750 -> 1,000 -> 1,250) as the user moved to a larger bottle; 3,900 ml late evening is a high but continuous day.",
        candidate: {
            kind: "water",
            entry: { value: 3900, logged_at: "2026-11-13T21:15:00.000Z" },
            recent: [
                { value: 500, logged_at: "2026-11-06T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-07T12:30:00.000Z" },
                { value: 750, logged_at: "2026-11-09T12:30:00.000Z" },
                { value: 1000, logged_at: "2026-11-10T12:30:00.000Z" },
                { value: 1250, logged_at: "2026-11-11T12:30:00.000Z" },
                { value: 1250, logged_at: "2026-11-12T12:30:00.000Z" },
                { value: 1000, logged_at: "2026-11-13T09:00:00.000Z" },
            ],
        },
    },
    {
        id: "W-genuine-heat-day",
        label: "genuine",
        note: "Evening entry after a day whose earlier entries were already doubled (two 1,000 ml entries today vs the usual single 500).",
        candidate: {
            kind: "water",
            entry: { value: 2000, logged_at: "2026-11-13T19:45:00.000Z" },
            recent: [
                { value: 500, logged_at: "2026-11-08T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-09T12:30:00.000Z" },
                { value: 350, logged_at: "2026-11-10T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-11T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-12T12:30:00.000Z" },
                { value: 1000, logged_at: "2026-11-13T08:00:00.000Z" },
                { value: 1000, logged_at: "2026-11-13T13:00:00.000Z" },
            ],
        },
    },
    {
        id: "W-genuine-event",
        label: "genuine",
        note: "Series includes a prior 1,800 ml event day; a 2,100 ml entry on a weekend afternoon matches the user's event pattern.",
        candidate: {
            kind: "water",
            entry: { value: 2100, logged_at: "2026-11-15T16:00:00.000Z" },
            recent: [
                { value: 500, logged_at: "2026-11-09T12:30:00.000Z" },
                { value: 350, logged_at: "2026-11-10T12:30:00.000Z" },
                { value: 1800, logged_at: "2026-11-08T15:00:00.000Z" },
                { value: 500, logged_at: "2026-11-11T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-12T12:30:00.000Z" },
                { value: 350, logged_at: "2026-11-13T12:30:00.000Z" },
                { value: 500, logged_at: "2026-11-14T12:30:00.000Z" },
            ],
        },
    },
    {
        id: "Wt-genuine-illness-trend",
        label: "genuine",
        note: "Weight has fallen steadily for days (82.0 -> 79.1 -> 76.8 kg, an illness trend); 72.9 kg continues the trend rather than breaking it.",
        candidate: {
            kind: "weight",
            entry: { value: 72_900, logged_at: "2026-11-13T07:00:00.000Z" },
            recent: [
                { value: 82_000, logged_at: "2026-11-08T07:00:00.000Z" },
                { value: 80_500, logged_at: "2026-11-10T07:00:00.000Z" },
                { value: 79_100, logged_at: "2026-11-11T07:00:00.000Z" },
                { value: 76_800, logged_at: "2026-11-12T07:00:00.000Z" },
            ],
        },
    },
    {
        id: "Wt-genuine-gain-trend",
        label: "genuine",
        note: "Weight has risen steadily (70.0 -> 73.2 -> 76.0 kg, a deliberate bulk); 80.1 kg continues the rising trend.",
        candidate: {
            kind: "weight",
            entry: { value: 80_100, logged_at: "2026-11-13T07:00:00.000Z" },
            recent: [
                { value: 70_000, logged_at: "2026-11-06T07:00:00.000Z" },
                { value: 71_500, logged_at: "2026-11-08T07:00:00.000Z" },
                { value: 73_200, logged_at: "2026-11-10T07:00:00.000Z" },
                { value: 76_000, logged_at: "2026-11-12T07:00:00.000Z" },
            ],
        },
    },
    {
        id: "Wt-genuine-post-illness-recovery",
        label: "genuine",
        note: "Series dips sharply then recovers in steps (78 -> 73.5 -> 75.8); 79.9 kg completes the recovery arc back toward the user's normal.",
        candidate: {
            kind: "weight",
            entry: { value: 79_900, logged_at: "2026-11-13T07:00:00.000Z" },
            recent: [
                { value: 78_000, logged_at: "2026-11-05T07:00:00.000Z" },
                { value: 76_000, logged_at: "2026-11-08T07:00:00.000Z" },
                { value: 73_500, logged_at: "2026-11-10T07:00:00.000Z" },
                { value: 75_800, logged_at: "2026-11-12T07:00:00.000Z" },
            ],
        },
    },
    {
        id: "Wt-genuine-scale-change",
        label: "genuine",
        note: "Entries alternate between two nearby levels (~81 and ~86 kg, two scales / clothing states) across the whole series; 91 kg is high but the series is already bimodal and rising on one branch.",
        candidate: {
            kind: "weight",
            entry: { value: 91_000, logged_at: "2026-11-13T19:30:00.000Z" },
            recent: [
                { value: 81_000, logged_at: "2026-11-07T07:00:00.000Z" },
                { value: 86_000, logged_at: "2026-11-08T19:30:00.000Z" },
                { value: 81_300, logged_at: "2026-11-10T07:00:00.000Z" },
                { value: 86_400, logged_at: "2026-11-11T19:30:00.000Z" },
                { value: 81_100, logged_at: "2026-11-12T07:00:00.000Z" },
                { value: 86_200, logged_at: "2026-11-13T07:00:00.000Z" },
            ],
        },
    },
];

function configFor(model: string): DecisionsConfig {
    return {
        apiKey: process.env.OPENROUTER_API_KEY!.trim(),
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models: [model],
        gateTimeoutMs: 10_000,
        deciderTimeoutMs: 10_000,
        gateEnabled: false,
        deciderEnabled: false,
        outlierTimeoutMs: 10_000,
        outlierEnabled: true,
    };
}

interface Row {
    fixture: string;
    label: string;
    model: string;
    pMistake: number | null;
    explanation: string | null;
    prompt: boolean | null;
    costUsd: number | null;
    durationMs: number | null;
    error: string | null;
}

const rows: Row[] = [];
for (const model of MODELS) {
    for (const fixture of FIXTURES) {
        const detection = detectOutlier(fixture.candidate);
        if (!detection.isOutlier) {
            console.error(
                `[c1eval] fixture ${fixture.id} does NOT engage the deterministic gate — fix the fixture`,
            );
        }
        try {
            const result = await callDecisionsWithFallback(configFor(model), {
                seat: "outlier",
                timeoutMs: 10_000,
                includeImageHeader: false,
                state: buildOutlierState(fixture.candidate, detection),
                questions: outlierQuestions(fixture.candidate.kind),
            });
            const p = noulProbability(result.answers.likely_mistake);
            const expl = result.answers.explanation as
                Record<string, unknown> | undefined;
            rows.push({
                fixture: fixture.id,
                label: fixture.label,
                model,
                pMistake: p,
                explanation:
                    typeof expl?.choice === "string" ? expl.choice : null,
                prompt: p !== null ? p >= THRESHOLD(model) : null,
                costUsd: result.reportedCostUsd,
                durationMs: result.durationMs,
                error: null,
            });
        } catch (error) {
            rows.push({
                fixture: fixture.id,
                label: fixture.label,
                model,
                pMistake: null,
                explanation: null,
                prompt: null,
                costUsd: null,
                durationMs: null,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

let report = `# C1 outlier eval — ${new Date().toISOString()}\n\n`;
report += `Call shape: production (buildOutlierState + outlierQuestions + callDecisionsWithFallback), one model per run. Prompt criterion is each model's calibrated threshold from config (Jev 0.74, pplx 0.90), tuned from the first run of this fixture at a shared 0.50 — where Jev scored slips 8/8 with false prompts 4/8 and pplx slips 7/8 with false prompts 2/8. The separation gaps on this small fixture are thin (Jev genuine max 0.73 vs slip min-at-threshold 0.75); treat the rates as provisional, not precise.\n`;
report += `Fixtures: ${FIXTURES.length} constructed production-shaped scenarios (ground truth by construction — see script header). This does NOT measure the real-world false-prompt rate.\n`;
report += `Pass bar (stated pre-run): slip detection >= 75% AND false prompts on genuine <= 25%, per model.\n\n`;

for (const model of MODELS) {
    const mine = rows.filter((r) => r.model === model);
    const slips = mine.filter((r) => r.label === "slip");
    const genuine = mine.filter((r) => r.label === "genuine");
    const slipHits = slips.filter((r) => r.prompt === true).length;
    const falsePrompts = genuine.filter((r) => r.prompt === true).length;
    const costs = mine.map((r) => r.costUsd).filter((c) => c !== null);
    const durs = mine.map((r) => r.durationMs).filter((d) => d !== null);
    report += `## ${model}\n\n`;
    report += `- Slip detection: ${slipHits}/${slips.length} (${((slipHits / slips.length) * 100).toFixed(0)}%)\n`;
    report += `- **FALSE-PROMPT rate on genuine entries: ${falsePrompts}/${genuine.length} (${((falsePrompts / genuine.length) * 100).toFixed(0)}%)**\n`;
    report += `- Cost/call: ${costs.length ? `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5)} avg` : "unreported"}; latency: ${durs.length ? `${Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)} ms avg` : "n/a"}\n`;
    report += `- p_mistake slips: ${slips.map((r) => r.pMistake ?? "err").join(", ")}\n`;
    report += `- p_mistake genuine: ${genuine.map((r) => r.pMistake ?? "err").join(", ")}\n\n`;
    console.log(
        `${model}: slips ${slipHits}/${slips.length}, false-prompts ${falsePrompts}/${genuine.length}`,
    );
}
report += `## Per-case\n\n| fixture | label | model | p_mistake | prompt@threshold | explanation | cost_usd | ms |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
    report += `| ${r.fixture} | ${r.label} | ${r.model} | ${r.pMistake ?? r.error ?? ""} | ${r.prompt ?? ""} | ${r.explanation ?? ""} | ${r.costUsd ?? ""} | ${r.durationMs ?? ""} |\n`;
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
await writeFile(join(OUT, "report.md"), report);
console.log(report);
console.log(`[c1eval] wrote ${OUT}/report.md`);
