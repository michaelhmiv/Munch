/**
 * Jev BOX verification probe (Nov 11, 2026; Michael's direction: "try
 * box and no box and see if it improves things").
 *
 * Question under test: the Nov 11 front-door probe measured Jev
 * presence-Noul verification of Ember's photo identifications as
 * essentially useless (precision 0.552 -> 0.558 at the harshest
 * threshold; Jev shares Ember's plausible hallucinations). Box is a
 * DIFFERENT mechanism: instead of asking "is X present?", Jev must
 * LOCATE X (bounding box + confidence). This probe measures whether
 * Box confidence separates Ember's true items from its hallucinated
 * ones well enough to act as a verification filter.
 *
 * Arms (all over the same Ember identifications, REPEATS pooled):
 *   - baseline: no verification (everything kept)
 *   - noul-only: presence Noul >= t (in-run replication of the probe)
 *   - box-only: Box confidence >= t
 *   - box+noul: Box confidence >= t AND presence Noul >= 0.5
 *     (TypeSafe's prescribed composition: Box has no "not found"
 *     answer, so presence is checked with a paired Noul)
 * Thresholds t in {0.3, 0.5, 0.7, 0.9}. Scoring is identify-level
 * (namesMatch greedy one-to-one vs the real-photo expectations),
 * identical semantics to the front-door probe's verification pass.
 *
 * Pre-registered bar: Box "improves things" only if some arm buys
 * >= +8 precision points over baseline for <= 2 recall points.
 *
 * Knobs (env): BOXVERIFY_OUT (default ./boxverify-report),
 * BOXVERIFY_REPEATS (default 2), BOXVERIFY_CONCURRENCY (default 4).
 * Exit 0 when a report was produced; exit 2 without an API key.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { namesMatch } from "../src/meal-photo/scoring.js";
import {
    identifyMealPhoto,
    mealPhotoVisionConfig,
    MealPhotoNoFoodError,
    type MealPhotoVisionItem,
} from "../src/meal-photo/vision.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POS_DIR = join(ROOT, "fixtures", "photo-eval-real");
const OUT = process.env.BOXVERIFY_OUT ?? join(ROOT, "boxverify-report");
const REPEATS = Math.max(1, Number(process.env.BOXVERIFY_REPEATS ?? 2) || 2);
const CONCURRENCY = Math.max(
    1,
    Math.min(8, Number(process.env.BOXVERIFY_CONCURRENCY ?? 4) || 4),
);
const JEV_SLUG = "typesafe/jev-1.14";
const EMBER_SLUG = "meta/muse-ember";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const THRESHOLDS = [0.3, 0.5, 0.7, 0.9];
const ITEMS_PER_REQUEST = 4; // Box + Noul pair per item, <= 8 questions

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[boxverify] OPENROUTER_API_KEY is required.");
    process.exit(2);
}
const API_KEY = process.env.OPENROUTER_API_KEY.trim();

interface PosFixture {
    id: string;
    file: string;
    items: Array<{ name: string }>;
}
const posExpectations = JSON.parse(
    await readFile(join(POS_DIR, "expectations.json"), "utf8"),
) as { fixtures: PosFixture[] };

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    // Minimal JPEG SOF scan, mirrored from photo-jev-probe.ts.
    let i = 2;
    while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
            const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
            return { width, height };
        }
        const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

interface JevCall {
    latencyMs: number;
    httpStatus: number | null;
    reportedCostUsd: number | null;
    transportError: string | null;
    errorExcerpt: string | null;
    answers: Record<string, any> | null;
    rawExcerpt: string | null;
}

async function jevDecisions(input: {
    state: unknown;
    questions: Record<string, unknown>;
}): Promise<JevCall> {
    const startedAt = performance.now();
    let httpStatus: number | null = null;
    let rawText = "";
    let payload: any = null;
    try {
        const response = await fetch(DECISIONS_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${API_KEY}`,
                "content-type": "application/json",
                "TypeSafe-Danger-Zone-Images": "true",
            },
            body: JSON.stringify({
                model: JEV_SLUG,
                state: input.state,
                questions: input.questions,
            }),
            signal: AbortSignal.timeout(60_000),
        });
        httpStatus = response.status;
        rawText = await response.text();
        try {
            payload = JSON.parse(rawText);
        } catch {
            payload = null;
        }
    } catch (error) {
        return {
            latencyMs: Math.round(performance.now() - startedAt),
            httpStatus: null,
            reportedCostUsd: null,
            transportError: error instanceof Error ? error.message : String(error),
            errorExcerpt: null,
            answers: null,
            rawExcerpt: null,
        };
    }
    const usage = payload?.usage ?? {};
    return {
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus,
        reportedCostUsd: typeof usage.cost === "number" ? usage.cost : null,
        transportError: null,
        errorExcerpt:
            httpStatus !== null && httpStatus >= 300
                ? typeof payload?.error?.message === "string"
                    ? payload.error.message
                    : rawText.slice(0, 300)
                : null,
        answers:
            payload?.answers && typeof payload.answers === "object"
                ? (payload.answers as Record<string, any>)
                : null,
        rawExcerpt: rawText.slice(0, 1_200),
    };
}

function noulProbability(answer: any): number | null {
    if (!answer || typeof answer !== "object") return null;
    if (typeof answer.noul === "number") return answer.noul;
    if (typeof answer.probability === "number") return answer.probability;
    const probs = answer.probabilities;
    if (probs && typeof probs === "object") {
        for (const key of ["true", "yes", "True", "Yes"]) {
            if (typeof probs[key] === "number") return probs[key];
        }
    }
    const value =
        typeof answer.value === "boolean"
            ? answer.value
            : typeof answer.answer === "boolean"
              ? answer.answer
              : null;
    if (value !== null && typeof answer.confidence === "number") {
        return value ? answer.confidence : 1 - answer.confidence;
    }
    return null;
}

interface BoxParse {
    confidence: number | null;
    area: number | null;
    edges: { top: number; bottom: number; left: number; right: number } | null;
}

function parseBox(answer: any): BoxParse {
    if (!answer || typeof answer !== "object") {
        return { confidence: null, area: null, edges: null };
    }
    const box = answer.box && typeof answer.box === "object" ? answer.box : null;
    const edges =
        box &&
        typeof box.top === "number" &&
        typeof box.bottom === "number" &&
        typeof box.left === "number" &&
        typeof box.right === "number"
            ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
            : null;
    const confidence =
        typeof answer.confidence === "number"
            ? answer.confidence
            : box && typeof box.confidence === "number"
              ? box.confidence
              : null;
    const area = edges
        ? Math.max(0, edges.right - edges.left) * Math.max(0, edges.bottom - edges.top)
        : null;
    return { confidence, area, edges };
}

function imageState(bytes: Uint8Array, text: string): Array<Record<string, unknown> | string> {
    return [
        {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` },
        },
        text,
    ];
}

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const index = next++;
            results[index] = await tasks[index]!();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
function median(values: number[]): number | null {
    return percentile(values, 0.5);
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

function emberConfig() {
    const config = mealPhotoVisionConfig({
        ...process.env,
        MUNCH_AI_MODEL: EMBER_SLUG,
        MUNCH_MEAL_PHOTO_ENABLED: "true",
        MUNCH_MEAL_PHOTO_TIMEOUT_MS: "60000",
    });
    if (!config) throw new Error("vision config unavailable (missing API key)");
    return config;
}

interface ItemRecord {
    name: string;
    matched: boolean;
    pPresent: number | null;
    boxConfidence: number | null;
    boxArea: number | null;
    boxRaw: any;
    noulRaw: any;
}
interface PhotoRecord {
    fixtureId: string;
    repeat: number;
    expectedCount: number;
    emberFailure: string | null;
    emberNoFood: boolean;
    emberCostUsd: number;
    items: ItemRecord[];
    jevCalls: Array<Omit<JevCall, "answers" | "rawExcerpt"> & { rawExcerpt: string | null }>;
    imageSkipped: string | null;
}

const bytesById = new Map<string, Uint8Array>();
for (const fixture of posExpectations.fixtures) {
    bytesById.set(fixture.id, new Uint8Array(await readFile(join(POS_DIR, fixture.file))));
}

const config = emberConfig();
const tasks: Array<() => Promise<PhotoRecord>> = [];
for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const fixture of posExpectations.fixtures) {
        tasks.push(async (): Promise<PhotoRecord> => {
            const bytes = bytesById.get(fixture.id)!;
            let emberCostUsd = 0;
            const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const response = await fetch(input, init);
                try {
                    const payload = (await response.clone().json()) as any;
                    if (typeof payload?.usage?.cost === "number") emberCostUsd += payload.usage.cost;
                } catch {
                    // usage stays uncounted for non-JSON bodies
                }
                return response;
            };
            let visionItems: MealPhotoVisionItem[] = [];
            let failure: string | null = null;
            let noFood = false;
            try {
                const vision = await identifyMealPhoto({ mimeType: "image/jpeg", bytes }, config, { fetcher });
                visionItems = vision.items;
            } catch (error) {
                if (error instanceof MealPhotoNoFoodError) {
                    noFood = true;
                } else {
                    failure = error instanceof Error ? error.message : String(error);
                }
            }
            const names = visionItems.map((item) => item.name);
            // Greedy one-to-one matching (fulleval scoreTask semantics).
            const used = new Set<number>();
            const matchedIndices = new Set<number>();
            for (const expected of fixture.items) {
                const idx = names.findIndex((name, nameIndex) => !used.has(nameIndex) && namesMatch(expected.name, name));
                if (idx >= 0) {
                    used.add(idx);
                    matchedIndices.add(idx);
                }
            }
            const items: ItemRecord[] = names.map((name, index) => ({
                name,
                matched: matchedIndices.has(index),
                pPresent: null,
                boxConfidence: null,
                boxArea: null,
                boxRaw: null,
                noulRaw: null,
            }));
            const jevCalls: PhotoRecord["jevCalls"] = [];
            let imageSkipped: string | null = null;
            const dims = jpegDimensions(bytes);
            if (!dims || dims.width < 280 || dims.height < 280 || dims.width > 1568 || dims.height > 1568) {
                imageSkipped = `image dims ${dims ? `${dims.width}x${dims.height}` : "unknown"} outside Jev's 280-1568px window`;
            } else if (names.length > 0) {
                const listText = `Items already identified in this photo: ${names.join("; ")}.`;
                for (let start = 0; start < names.length; start += ITEMS_PER_REQUEST) {
                    const slice = names.slice(start, start + ITEMS_PER_REQUEST);
                    const questions: Record<string, unknown> = {};
                    slice.forEach((name, position) => {
                        questions[`item_${position}_box`] = {
                            type: "box",
                            instructions: `the food or drink item "${name}" in this photo`,
                        };
                        questions[`item_${position}_present`] = {
                            type: "noul",
                            instructions: `A meal-photo analysis identified an item named "${name}" in this photo. Is an item matching "${name}" actually visibly present in this photo?`,
                            criteria: {
                                true: `An item matching "${name}" is visibly present in the photo.`,
                                false: `No item matching "${name}" is visibly present in the photo.`,
                            },
                        };
                    });
                    const call = await jevDecisions({ state: imageState(bytes, listText), questions });
                    const { answers, ...meta } = call;
                    jevCalls.push(meta);
                    if (answers) {
                        slice.forEach((_, position) => {
                            const itemIndex = start + position;
                            const boxParsed = parseBox(answers[`item_${position}_box`]);
                            items[itemIndex]!.boxConfidence = boxParsed.confidence;
                            items[itemIndex]!.boxArea = boxParsed.area;
                            items[itemIndex]!.boxRaw = answers[`item_${position}_box`] ?? null;
                            items[itemIndex]!.pPresent = noulProbability(answers[`item_${position}_present`]);
                            items[itemIndex]!.noulRaw = answers[`item_${position}_present`] ?? null;
                        });
                    }
                }
            }
            return {
                fixtureId: fixture.id,
                repeat,
                expectedCount: fixture.items.length,
                emberFailure: failure,
                emberNoFood: noFood,
                emberCostUsd,
                items,
                jevCalls,
                imageSkipped,
            };
        });
    }
}
const photos = await runPool(tasks, CONCURRENCY);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const totals = { expected: 0, predicted: 0, matched: 0 };
for (const photo of photos) {
    totals.expected += photo.expectedCount;
    totals.predicted += photo.items.length;
    totals.matched += photo.items.filter((i) => i.matched).length;
}
const baseline = {
    precision: totals.predicted > 0 ? totals.matched / totals.predicted : null,
    recall: totals.expected > 0 ? totals.matched / totals.expected : null,
};

type KeepFn = (item: ItemRecord, t: number) => boolean;
const ARMS: Array<{ id: string; label: string; keep: KeepFn | null }> = [
    { id: "noul", label: "Noul-only (presence >= t)", keep: (i, t) => i.pPresent !== null && i.pPresent >= t },
    { id: "box", label: "Box-only (box confidence >= t)", keep: (i, t) => i.boxConfidence !== null && i.boxConfidence >= t },
    { id: "box+noul", label: "Box+Noul (box >= t AND presence >= 0.5)", keep: (i, t) => i.boxConfidence !== null && i.boxConfidence >= t && i.pPresent !== null && i.pPresent >= 0.5 },
];
interface ArmRow {
    threshold: number;
    kept: number;
    matchedKept: number;
    precision: number | null;
    recall: number | null;
    precisionDelta: number | null;
    recallDelta: number | null;
}
const armResults: Record<string, ArmRow[]> = {};
for (const arm of ARMS) {
    armResults[arm.id] = THRESHOLDS.map((t) => {
        let kept = 0;
        let matchedKept = 0;
        for (const photo of photos) {
            for (const item of photo.items) {
                if (arm.keep!(item, t)) {
                    kept += 1;
                    if (item.matched) matchedKept += 1;
                }
            }
        }
        const precision = kept > 0 ? matchedKept / kept : null;
        const recall = totals.expected > 0 ? matchedKept / totals.expected : null;
        return {
            threshold: t,
            kept,
            matchedKept,
            precision,
            recall,
            precisionDelta: precision !== null && baseline.precision !== null ? precision - baseline.precision : null,
            recallDelta: recall !== null && baseline.recall !== null ? recall - baseline.recall : null,
        };
    });
}

// Separation diagnostics: does the signal rank true items above false ones?
function mean(values: number[]): number | null {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
const allItems = photos.flatMap((p) => p.items);
const sep = {
    boxConfMatched: mean(allItems.filter((i) => i.matched && i.boxConfidence !== null).map((i) => i.boxConfidence!)),
    boxConfUnmatched: mean(allItems.filter((i) => !i.matched && i.boxConfidence !== null).map((i) => i.boxConfidence!)),
    pPresentMatched: mean(allItems.filter((i) => i.matched && i.pPresent !== null).map((i) => i.pPresent!)),
    pPresentUnmatched: mean(allItems.filter((i) => !i.matched && i.pPresent !== null).map((i) => i.pPresent!)),
    boxAreaMatched: median(allItems.filter((i) => i.matched && i.boxArea !== null).map((i) => i.boxArea!)),
    boxAreaUnmatched: median(allItems.filter((i) => !i.matched && i.boxArea !== null).map((i) => i.boxArea!)),
    boxParsed: allItems.filter((i) => i.boxConfidence !== null).length,
    noulParsed: allItems.filter((i) => i.pPresent !== null).length,
    itemsTotal: allItems.length,
};
const jevLatencies = photos.flatMap((p) => p.jevCalls.map((c) => c.latencyMs));
const jevCost = photos.reduce((s, p) => s + p.jevCalls.reduce((a, c) => a + (c.reportedCostUsd ?? 0), 0), 0);
const emberCost = photos.reduce((s, p) => s + p.emberCostUsd, 0);
const jevFailures = photos.flatMap((p) => p.jevCalls).filter((c) => c.httpStatus === null || (c.httpStatus !== null && c.httpStatus >= 300)).length;
const jevCallCount = photos.reduce((s, p) => s + p.jevCalls.length, 0);

// Pre-registered bar: >= +8 precision points for <= 2 recall points.
let bestArm: { arm: string; row: ArmRow } | null = null;
for (const arm of ARMS) {
    for (const row of armResults[arm.id]!) {
        if (row.precisionDelta !== null && row.recallDelta !== null && row.precisionDelta >= 0.08 && row.recallDelta >= -0.02) {
            if (!bestArm || row.precisionDelta > bestArm.row.precisionDelta!) bestArm = { arm: arm.id, row };
        }
    }
}
const verdict = bestArm
    ? `BOX IMPROVES THINGS at arm ${bestArm.arm} t=${bestArm.row.threshold}: precision ${fmtPct(bestArm.row.precisionDelta)} for recall ${fmtPct(bestArm.row.recallDelta)} vs baseline (bar: >= +8 pts precision, <= 2 pts recall).`
    : "BOX DOES NOT CLEAR THE BAR: no arm buys >= +8 precision points for <= 2 recall points. Verification stays dead in all three measured mechanisms (presence Noul, anything-missing Noul, Box).";

function fmt(value: number | null, digits = 3): string {
    return value === null ? "n/a" : value.toFixed(digits);
}
function fmtPct(value: number | null): string {
    return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
}

const report = {
    generatedAt: new Date().toISOString(),
    model: JEV_SLUG,
    identifier: EMBER_SLUG,
    repeats: REPEATS,
    photosScored: photos.length,
    totals,
    baseline,
    arms: armResults,
    separation: sep,
    costs: { emberUsd: emberCost, jevUsd: jevCost, totalUsd: emberCost + jevCost },
    jevLatencyMs: { median: median(jevLatencies), p95: percentile(jevLatencies, 0.95) },
    jevCallCount,
    jevFailures,
    emberFailures: photos.filter((p) => p.emberFailure !== null).length,
    imagesSkipped: photos.filter((p) => p.imageSkipped !== null).map((p) => ({ fixture: p.fixtureId, repeat: p.repeat, reason: p.imageSkipped })),
    verdict,
    photos,
};

const lines: string[] = [];
lines.push("# Jev Box verification probe — results");
lines.push("");
lines.push(`Identifier: \`${EMBER_SLUG}\` (production identify path) · Verifier: \`${JEV_SLUG}\` via POST /api/alpha/decisions (image in state, danger-zone header sent) · ${photos.length} photo-runs (${posExpectations.fixtures.length} fixtures x ${REPEATS} repeats) · Jev calls: ${jevCallCount} (${jevFailures} failed) · Cost: Ember $${emberCost.toFixed(4)} + Jev $${jevCost.toFixed(4)} · Jev latency median ${fmt(jevLatencyMsSafe(jevLatencies, "median"), 0)} ms, p95 ${fmt(jevLatencyMsSafe(jevLatencies, "p95"), 0)} ms.`);
lines.push("");
lines.push(`**Verdict: ${verdict}**`);
lines.push("");
lines.push(`Baseline (no verification): predicted ${totals.predicted}, matched ${totals.matched} of ${totals.expected} expected — **precision ${fmt(baseline.precision)}**, **recall ${fmt(baseline.recall)}**.`);
lines.push("");
lines.push("| Arm | t | Kept | Precision (Δ) | Recall (Δ) |");
lines.push("|---|---|---|---|---|");
for (const arm of ARMS) {
    for (const row of armResults[arm.id]!) {
        lines.push(`| ${arm.label} | ${row.threshold} | ${row.kept} | ${fmt(row.precision)} (${fmtPct(row.precisionDelta)}) | ${fmt(row.recall)} (${fmtPct(row.recallDelta)}) |`);
    }
}
lines.push("");
lines.push("## Separation diagnostics (mean signal, matched vs hallucinated items)");
lines.push("");
lines.push(`- Box confidence: matched ${fmt(sep.boxConfMatched)} vs hallucinated ${fmt(sep.boxConfUnmatched)} (parsed ${sep.boxParsed}/${sep.itemsTotal} items)`);
lines.push(`- Presence Noul: matched ${fmt(sep.pPresentMatched)} vs hallucinated ${fmt(sep.pPresentUnmatched)} (parsed ${sep.noulParsed}/${sep.itemsTotal})`);
lines.push(`- Box area (median fraction of frame): matched ${fmt(sep.boxAreaMatched)} vs hallucinated ${fmt(sep.boxAreaUnmatched)}`);
lines.push("");
lines.push("## Hallucinated items detail (name, box conf, presence, box area)");
lines.push("");
for (const photo of photos) {
    for (const item of photo.items) {
        if (!item.matched) {
            lines.push(`- ${photo.fixtureId} (repeat ${photo.repeat}): "${item.name}" — box ${fmt(item.boxConfidence)}, noul ${fmt(item.pPresent)}, area ${fmt(item.boxArea)}`);
        }
    }
}
if (report.imagesSkipped.length > 0) {
    lines.push("");
    lines.push(`Images skipped for Jev (dims outside 280-1568): ${report.imagesSkipped.map((s) => `${s.fixture}#${s.repeat}`).join(", ")}`);
}
lines.push("");
lines.push("Measurement only — no product code touched. Per-item raw Box/Noul answers: `results.json`.");

function jevLatencyMsSafe(values: number[], which: "median" | "p95"): number | null {
    return which === "median" ? median(values) : percentile(values, 0.95);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "results.json"), JSON.stringify(report, null, 2));
await writeFile(join(OUT, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
