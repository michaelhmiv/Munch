/**
 * S3 receipt-correlation probe (model-integration brief, seat S3 —
 * PROBE FIRST, Michael directive 2026-11-11: "follow their docs best
 * practices and thoroughly test everything, fallbacks, everything").
 *
 * The question: production receipt flow today files pantry items BY
 * NAME (reconcilePurchase); extraction never sets a provider food ID,
 * so there is no server-side line-to-database correlation. The S3 seat
 * would add one: given an extracted receipt line, a Decisions-API
 * model picks the correct food from a candidate shortlist produced by
 * the production food search. This probe measures whether that pick
 * beats the free deterministic alternative — the search's own rank-1
 * result — on a hand-labelled set built from fixtures/receipt-eval
 * (see fixtures/receipt-correlation/lines.json for provenance and the
 * matching rule).
 *
 * PRE-REGISTERED SHIP BAR (from the approved brief): Jev pick
 * accuracy >= the deterministic baseline (rank-1) pick accuracy, both
 * measured on the food lines where the correct food WAS in the
 * shortlist. If Jev cannot at least match rank-1, the seat does not
 * ship. The two failure classes are never blended: a food line whose
 * correct entry is absent from the shortlist is a SEARCH MISS (a
 * search problem, identical for every arm) and is reported separately
 * from PICK ERRORS (the food was there and the arm chose wrong or
 * "none").
 *
 * Arms: baseline rank-1 (no model call) + three Decisions-API models
 * through the identical Choice question per line — typesafe/jev-1.14
 * (the seat candidate) and the two DESIGNATED FALLBACKS from the
 * Nov 11 bake-off (perplexity/pplx-decider-v1.2, liquid/d1-ultra), so
 * the fallback law's calibration continuity holds for this seat too.
 * Questions are written as descriptions, not commands (TypeSafe docs);
 * state stays small (one line + at most 8 candidates, text only);
 * raw probabilities and usage.cost are stored for every call.
 *
 * Search wiring mirrors scripts/photo-full-eval.ts exactly: the live
 * USDA + Open Food Facts provider registry with production ranking
 * (src/food-providers/registry.ts) — the local catalog layer needs
 * Postgres and is skipped in this lane, and the report says so. The
 * search input is the labelled extracted `name` from the fixture (no
 * fresh extraction is run); trap lines feed their printed label.
 *
 * Knobs (env): CORRELATION_OUT (default ./correlation-report),
 * CORRELATION_MODELS (comma-separated Decisions slugs replacing the
 * three model arms; the baseline arm always runs). Exit 0 when a
 * report was produced — a failing arm is data, not a harness failure.
 * Exit 2 when the API keys are not configured.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenFoodFactsProvider } from "../src/food-providers/open-food-facts.js";
import { FoodProviderRegistry } from "../src/food-providers/registry.js";
import { UsdaFoodDataCentralProvider } from "../src/food-providers/usda.js";
import type { FoodCandidate } from "../src/food-providers/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(
    ROOT,
    "fixtures",
    "receipt-correlation",
    "lines.json",
);
const OUT = process.env.CORRELATION_OUT ?? join(ROOT, "correlation-report");
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const SHORTLIST_LIMIT = 8;
const CALL_TIMEOUT_MS = 30_000;

const DEFAULT_MODELS = [
    "typesafe/jev-1.14",
    "perplexity/pplx-decider-v1.2",
    "liquid/d1-ultra",
];
const modelSlugs = (
    process.env.CORRELATION_MODELS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []
).filter((slug, index, all) => all.indexOf(slug) === index);
const MODELS = modelSlugs.length > 0 ? modelSlugs : DEFAULT_MODELS;
/** The seat candidate whose accuracy the ship bar judges. */
const PRIMARY_MODEL = MODELS.includes("typesafe/jev-1.14")
    ? "typesafe/jev-1.14"
    : MODELS[0]!;

interface FixtureLine {
    receipt_id: string;
    raw_label: string;
    name: string;
    kind: "food" | "non_food" | "trap";
    is_food: boolean;
    quantity: number | null;
    unit: string | null;
    expected: string | null;
    ambiguity: string | null;
}

interface FixtureFile {
    source: string;
    version: number;
    provenance: string;
    matching_rule: string;
    lines: FixtureLine[];
}

if (
    !process.env.OPENROUTER_API_KEY?.trim() ||
    !process.env.USDA_FDC_API_KEY?.trim()
) {
    console.error(
        "[correlation] OPENROUTER_API_KEY and USDA_FDC_API_KEY are required; the correlation lane cannot run.",
    );
    process.exit(2);
}
const API_KEY = process.env.OPENROUTER_API_KEY;

const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureFile;
const lines = fixture.lines;
if (lines.length === 0) {
    console.error("[correlation] Fixture has no lines; nothing to run.");
    process.exit(2);
}

// ---------------------------------------------------------------------------
// The deterministic matching rule — implemented exactly as documented
// in fixtures/receipt-correlation/lines.json (`matching_rule`, printed
// verbatim in the report). A candidate matches a line's expected
// description when EVERY expected token is present in the candidate
// name's token set after identical normalization of both sides.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
    "with",
    "and",
    "of",
    "the",
    "a",
    "an",
    "in",
    "on",
    "for",
]);

function singularize(token: string): string {
    if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -2);
    if (token.length > 4 && token.endsWith("ies"))
        return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss"))
        return token.slice(0, -1);
    return token;
}

function normalizeTokens(text: string): Set<string> {
    const cleaned = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ");
    const tokens = new Set<string>();
    for (const raw of cleaned.split(" ")) {
        if (!raw || STOPWORDS.has(raw)) continue;
        tokens.add(singularize(raw));
    }
    return tokens;
}

function candidateMatches(candidateName: string, expected: string): boolean {
    const candidateTokens = normalizeTokens(candidateName);
    for (const token of normalizeTokens(expected)) {
        if (!candidateTokens.has(token)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Shortlists: the production food search, exactly as the fulleval lane
// wires it (live USDA + OFF registry, production ranking; the local
// catalog layer needs Postgres and is skipped — labelled in the
// report). One search per line, shared by every arm.
// ---------------------------------------------------------------------------

const registry = new FoodProviderRegistry([
    new UsdaFoodDataCentralProvider({ timeoutMs: 10_000 }),
    new OpenFoodFactsProvider({ timeoutMs: 10_000 }),
]);

interface ShortlistEntry {
    rank: number;
    provider: string;
    providerFoodId: string;
    name: string;
    brand: string | null;
    matchesExpected: boolean;
}

interface LineSearch {
    line: FixtureLine;
    query: string;
    latencyMs: number;
    candidates: ShortlistEntry[];
    failures: string[];
    /** Food lines only: the correct food is among the candidates. */
    foodInShortlist: boolean | null;
    matchingRanks: number[];
}

// ---------------------------------------------------------------------------
// One Decisions-API Choice call per (line, model): description-style
// question, options = candidate names in ranked order + "None of
// these". Bounded timeout, at most one retry on a transient failure
// (the fallback law's call discipline), raw probabilities stored.
// ---------------------------------------------------------------------------

interface DecisionCall {
    model: string;
    ok: boolean;
    /** Candidate index picked, or null for "none" / no answer. */
    pickIndex: number | null;
    pickName: string | null;
    /** Raw probability the model assigned to its chosen option. */
    pickProbability: number | null;
    probabilities: Record<string, number> | null;
    latencyMs: number;
    httpStatus: number | null;
    reportedCostUsd: number | null;
    inputTokens: number | null;
    attempts: number;
    error: string | null;
}

async function decideOnce(
    model: string,
    line: FixtureLine,
    candidates: ShortlistEntry[],
): Promise<DecisionCall> {
    const criteria: Record<string, string> = {};
    candidates.forEach((candidate, index) => {
        criteria[`c${index}`] =
            `${candidate.name}${candidate.brand ? ` — brand: ${candidate.brand}` : ""} (source database: ${candidate.provider})`;
    });
    criteria["none"] =
        "No listed entry is the same food as the receipt line's item.";
    const state = {
        receipt_line: {
            printed_label: line.raw_label,
            item: line.name,
            quantity: line.quantity,
            unit: line.unit,
        },
        options: candidates.map((candidate, index) => ({
            option: `c${index}`,
            name: candidate.name,
            brand: candidate.brand,
            source_database: candidate.provider,
        })),
    };
    const questions = {
        pick: {
            type: "choice",
            instructions:
                `A grocery receipt line reads "${line.raw_label}" and names the purchased item "${line.name}". ` +
                "The listed options are food-database entries found for that item. The correct option is the entry that is the same food as the receipt line's item. " +
                'If no listed entry is the same food, the correct option is "None of these".',
            criteria,
        },
    };
    const startedAt = performance.now();
    let lastError: string | null = null;
    let httpStatus: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        let rawText = "";
        try {
            const response = await fetch(DECISIONS_URL, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${API_KEY}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ model, state, questions }),
                signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            });
            httpStatus = response.status;
            rawText = await response.text();
            let payload: any = null;
            try {
                payload = JSON.parse(rawText);
            } catch {
                payload = null;
            }
            const latencyMs = Math.round(performance.now() - startedAt);
            const usage = payload?.usage ?? {};
            const answer = payload?.answers?.pick;
            if (
                httpStatus >= 200 &&
                httpStatus < 300 &&
                answer &&
                answer.type === "choice" &&
                typeof answer.choice === "string"
            ) {
                const probabilities =
                    answer.probabilities &&
                    typeof answer.probabilities === "object"
                        ? (answer.probabilities as Record<string, number>)
                        : null;
                const pickProbability =
                    probabilities &&
                    typeof probabilities[answer.choice] === "number"
                        ? probabilities[answer.choice]
                        : typeof answer.confidence === "number"
                          ? answer.confidence
                          : null;
                if (answer.choice === "none") {
                    return {
                        model,
                        ok: true,
                        pickIndex: null,
                        pickName: null,
                        pickProbability,
                        probabilities,
                        latencyMs,
                        httpStatus,
                        reportedCostUsd:
                            typeof usage.cost === "number" ? usage.cost : null,
                        inputTokens:
                            typeof usage.input_tokens === "number"
                                ? usage.input_tokens
                                : null,
                        attempts: attempt,
                        error: null,
                    };
                }
                const match = /^c(\d+)$/.exec(answer.choice);
                const index = match ? Number(match[1]) : -1;
                const candidate = candidates[index];
                if (!candidate) {
                    // An option key outside the shortlist is discarded,
                    // never honoured (the production fabrication bar).
                    lastError = `model returned unknown option "${answer.choice}"`;
                    continue;
                }
                return {
                    model,
                    ok: true,
                    pickIndex: index,
                    pickName: candidate.name,
                    pickProbability,
                    probabilities,
                    latencyMs,
                    httpStatus,
                    reportedCostUsd:
                        typeof usage.cost === "number" ? usage.cost : null,
                    inputTokens:
                        typeof usage.input_tokens === "number"
                            ? usage.input_tokens
                            : null,
                    attempts: attempt,
                    error: null,
                };
            }
            lastError =
                httpStatus !== null && httpStatus >= 300
                    ? `HTTP ${httpStatus}: ${typeof payload?.error?.message === "string" ? payload.error.message : rawText.slice(0, 200)}`
                    : `unparseable decisions response: ${rawText.slice(0, 200)}`;
            // Retry only transient-looking failures (5xx / 429), once.
            if (httpStatus !== null && httpStatus < 500 && httpStatus !== 429)
                break;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    return {
        model,
        ok: false,
        pickIndex: null,
        pickName: null,
        pickProbability: null,
        probabilities: null,
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus,
        reportedCostUsd: null,
        inputTokens: null,
        attempts: 2,
        error: lastError,
    };
}

async function runPool<T>(
    jobs: Array<() => Promise<T>>,
    limit: number,
): Promise<T[]> {
    const results: T[] = new Array(jobs.length);
    let next = 0;
    async function worker() {
        while (next < jobs.length) {
            const index = next;
            next += 1;
            results[index] = await jobs[index]!();
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
    );
    return results;
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[index]!;
}

// ---------------------------------------------------------------------------
// Run: searches first (sequential — 34 lines, shared by all arms),
// then one Decisions call per (line, model) for lines with a non-empty
// shortlist. Baseline = rank-1, no call.
// ---------------------------------------------------------------------------

const runStartedAt = new Date().toISOString();
const searches: LineSearch[] = [];
for (const line of lines) {
    const startedAt = performance.now();
    const result = await registry.search({
        query: line.name,
        limit: SHORTLIST_LIMIT,
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const candidates: ShortlistEntry[] = result.candidates.map(
        (candidate: FoodCandidate, index) => ({
            rank: index + 1,
            provider: candidate.provider,
            providerFoodId: candidate.providerFoodId,
            name: candidate.name,
            brand: candidate.brand ?? null,
            matchesExpected:
                line.kind === "food" && line.expected !== null
                    ? candidateMatches(candidate.name, line.expected)
                    : false,
        }),
    );
    const matchingRanks = candidates
        .filter((candidate) => candidate.matchesExpected)
        .map((candidate) => candidate.rank);
    searches.push({
        line,
        query: line.name,
        latencyMs,
        candidates,
        failures: result.failures.map(
            (failure) =>
                `${failure.provider}:${failure.code}:${failure.message.slice(0, 120)}`,
        ),
        foodInShortlist: line.kind === "food" ? matchingRanks.length > 0 : null,
        matchingRanks,
    });
    console.info(
        `[correlation] search "${line.name}" -> ${candidates.length} candidates${line.kind === "food" ? `, expected in shortlist: ${matchingRanks.length > 0 ? `yes (rank ${matchingRanks.join(",")})` : "NO (search miss)"}` : ""} (${latencyMs}ms)`,
    );
}

interface LineOutcome {
    search: LineSearch;
    /** Per-arm pick: candidate index, or null for none / no call. */
    picks: Record<string, number | null>;
    calls: Record<string, DecisionCall | null>;
}

const outcomes: LineOutcome[] = searches.map((search) => ({
    search,
    picks: { baseline: search.candidates[0] ? 0 : null },
    calls: {},
}));

const callJobs: Array<() => Promise<void>> = [];
for (const outcome of outcomes) {
    if (outcome.search.candidates.length === 0) {
        for (const model of MODELS) {
            outcome.picks[model] = null;
            outcome.calls[model] = null;
        }
        continue;
    }
    for (const model of MODELS) {
        callJobs.push(async () => {
            const call = await decideOnce(
                model,
                outcome.search.line,
                outcome.search.candidates,
            );
            outcome.calls[model] = call;
            // A failed call records pick=null AND ok=false; scoring
            // counts it as an incorrect pick (never silently dropped).
            outcome.picks[model] = call.pickIndex;
            console.info(
                `[correlation] ${model} "${outcome.search.line.name}" -> ${call.ok ? (call.pickIndex === null ? "none" : `c${call.pickIndex} "${call.pickName}"`) : `FAILED (${call.error})`} ${call.latencyMs}ms`,
            );
        });
    }
}
await runPool(callJobs, 3);

// ---------------------------------------------------------------------------
// Score. Failure classes stay separate: SEARCH MISS (food absent from
// the shortlist) vs PICK ERROR (food present, arm chose wrong/none)
// vs FALSE PICK (NONE-expected line, arm picked an entry).
// ---------------------------------------------------------------------------

const ARM_NAMES = ["baseline", ...MODELS];

interface ArmReport {
    arm: string;
    foodLinesInShortlist: number;
    foodCorrectInShortlist: number;
    pickAccuracyInShortlist: number | null;
    foodCorrectOverall: number;
    foodAccuracyOverall: number | null;
    noneLines: number;
    noneCorrect: number;
    noneAccuracy: number | null;
    falsePickRate: number | null;
    pickErrors: Array<{
        rawLabel: string;
        name: string;
        expected: string | null;
        picked: string | null;
        matchingRanks: number[];
    }>;
    falsePicks: Array<{
        rawLabel: string;
        name: string;
        kind: string;
        picked: string | null;
    }>;
    callFailures: number;
    callsMade: number;
    totalCostUsd: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
}

function scoreArm(arm: string): ArmReport {
    let inShortlist = 0;
    let correctIn = 0;
    let correctOverall = 0;
    let noneLines = 0;
    let noneCorrect = 0;
    let callFailures = 0;
    let callsMade = 0;
    let totalCost = 0;
    let costComplete = true;
    const latencies: number[] = [];
    const pickErrors: ArmReport["pickErrors"] = [];
    const falsePicks: ArmReport["falsePicks"] = [];
    for (const outcome of outcomes) {
        const { line, candidates, foodInShortlist, matchingRanks } =
            outcome.search;
        const pick = outcome.picks[arm] ?? null;
        const pickedEntry = pick !== null ? (candidates[pick] ?? null) : null;
        if (arm !== "baseline") {
            const call = outcome.calls[arm];
            if (call) {
                callsMade += 1;
                latencies.push(call.latencyMs);
                if (!call.ok) callFailures += 1;
                if (call.reportedCostUsd !== null)
                    totalCost += call.reportedCostUsd;
                else costComplete = false;
            }
        }
        if (line.kind === "food") {
            const correct = pickedEntry?.matchesExpected === true;
            if (correct) correctOverall += 1;
            if (foodInShortlist) {
                inShortlist += 1;
                if (correct) {
                    correctIn += 1;
                } else {
                    pickErrors.push({
                        rawLabel: line.raw_label,
                        name: line.name,
                        expected: line.expected,
                        picked: pickedEntry
                            ? `${pickedEntry.name} (rank ${pickedEntry.rank})`
                            : "(none)",
                        matchingRanks,
                    });
                }
            }
        } else {
            noneLines += 1;
            if (pick === null) {
                noneCorrect += 1;
            } else {
                falsePicks.push({
                    rawLabel: line.raw_label,
                    name: line.name,
                    kind: line.kind,
                    picked: pickedEntry
                        ? `${pickedEntry.name} (rank ${pickedEntry.rank})`
                        : "(unknown)",
                });
            }
        }
    }
    const foodTotal = outcomes.filter(
        (outcome) => outcome.search.line.kind === "food",
    ).length;
    return {
        arm,
        foodLinesInShortlist: inShortlist,
        foodCorrectInShortlist: correctIn,
        pickAccuracyInShortlist: inShortlist ? correctIn / inShortlist : null,
        foodCorrectOverall: correctOverall,
        foodAccuracyOverall: foodTotal ? correctOverall / foodTotal : null,
        noneLines,
        noneCorrect,
        noneAccuracy: noneLines ? noneCorrect / noneLines : null,
        falsePickRate: noneLines ? 1 - noneCorrect / noneLines : null,
        pickErrors,
        falsePicks,
        callFailures,
        callsMade,
        totalCostUsd: arm === "baseline" ? 0 : costComplete ? totalCost : null,
        medianLatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
    };
}

const armReports = ARM_NAMES.map(scoreArm);
const searchMisses = outcomes.filter(
    (outcome) =>
        outcome.search.line.kind === "food" &&
        outcome.search.foodInShortlist === false,
);
const primaryReport = armReports.find((report) => report.arm === PRIMARY_MODEL);
const baselineReport = armReports.find((report) => report.arm === "baseline");
const shipBarPassed =
    primaryReport?.pickAccuracyInShortlist !== null &&
    primaryReport?.pickAccuracyInShortlist !== undefined &&
    baselineReport?.pickAccuracyInShortlist !== null &&
    baselineReport?.pickAccuracyInShortlist !== undefined &&
    primaryReport.pickAccuracyInShortlist >=
        baselineReport.pickAccuracyInShortlist;

// ---------------------------------------------------------------------------
// Outputs: correlation-report/results.json + report.md
// ---------------------------------------------------------------------------

const resultsJson = {
    generatedAt: runStartedAt,
    fixture: {
        source: fixture.source,
        version: fixture.version,
        totalLines: lines.length,
        foodLines: lines.filter((line) => line.kind === "food").length,
        nonFoodLines: lines.filter((line) => line.kind === "non_food").length,
        trapLines: lines.filter((line) => line.kind === "trap").length,
        matchingRule: fixture.matching_rule,
    },
    search: {
        wiring: "Live USDA + Open Food Facts via the production FoodProviderRegistry ranking (src/food-providers/registry.ts), identical to scripts/photo-full-eval.ts; the local catalog layer needs Postgres and is skipped in this lane.",
        shortlistLimit: SHORTLIST_LIMIT,
        searchMissCount: searchMisses.length,
        searchMisses: searchMisses.map((outcome) => ({
            receiptId: outcome.search.line.receipt_id,
            rawLabel: outcome.search.line.raw_label,
            name: outcome.search.line.name,
            expected: outcome.search.line.expected,
            shortlist: outcome.search.candidates.map(
                (candidate) => candidate.name,
            ),
        })),
    },
    shipBar: {
        rule: `Pick accuracy of ${PRIMARY_MODEL} >= pick accuracy of the rank-1 baseline, on food lines where the correct food was in the shortlist`,
        primaryModel: PRIMARY_MODEL,
        primaryAccuracy: primaryReport?.pickAccuracyInShortlist ?? null,
        baselineAccuracy: baselineReport?.pickAccuracyInShortlist ?? null,
        passed: shipBarPassed,
    },
    arms: armReports,
    lines: outcomes.map((outcome) => ({
        receiptId: outcome.search.line.receipt_id,
        rawLabel: outcome.search.line.raw_label,
        name: outcome.search.line.name,
        kind: outcome.search.line.kind,
        expected: outcome.search.line.expected,
        ambiguity: outcome.search.line.ambiguity,
        foodInShortlist: outcome.search.foodInShortlist,
        matchingRanks: outcome.search.matchingRanks,
        searchLatencyMs: outcome.search.latencyMs,
        searchFailures: outcome.search.failures,
        shortlist: outcome.search.candidates,
        picks: outcome.picks,
        calls: outcome.calls,
    })),
};

function pct(value: number | null): string {
    return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
function usd(value: number | null): string {
    return value === null ? "n/a" : `$${value.toFixed(5)}`;
}

const md: string[] = [];
md.push("# S3 receipt-correlation probe — report");
md.push("");
md.push(
    `Generated ${runStartedAt}. Fixture: fixtures/receipt-correlation/lines.json (${lines.length} lines: ${resultsJson.fixture.foodLines} food, ${resultsJson.fixture.nonFoodLines} non-food, ${resultsJson.fixture.trapLines} traps) built from the hand-labelled fixtures/receipt-eval set.`,
);
md.push("");
md.push(
    "What this measures: whether a Decisions-API model, given an extracted receipt line and the top-8 candidate shortlist from the production food search, picks the correct database entry more accurately than the deterministic baseline — the search's own rank-1 result. Shortlists come from the live USDA + Open Food Facts providers through the production registry ranking (the same wiring as scripts/photo-full-eval.ts); the local catalog layer needs Postgres and is skipped in this lane, so shortlists are the provider-only form of production search.",
);
md.push("");
md.push("## Matching rule (verbatim from the fixture)");
md.push("");
md.push(fixture.matching_rule);
md.push("");
md.push("## Ship bar (pre-registered)");
md.push("");
md.push(
    `Jev pick accuracy >= rank-1 baseline pick accuracy, on food lines where the correct food was in the shortlist. **${PRIMARY_MODEL}: ${pct(primaryReport?.pickAccuracyInShortlist ?? null)} vs baseline ${pct(baselineReport?.pickAccuracyInShortlist ?? null)} — ${shipBarPassed ? "SHIP BAR PASSED" : "SHIP BAR NOT MET"}.**`,
);
md.push("");
md.push("## Per-arm results");
md.push("");
md.push(
    "| Arm | Pick accuracy (in-shortlist) | Correct / in-shortlist | Overall food accuracy | NONE accuracy (traps + non-food) | False-pick rate | Call failures | Median latency | p95 latency | Total cost |",
);
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const report of armReports) {
    md.push(
        `| ${report.arm} | ${pct(report.pickAccuracyInShortlist)} | ${report.foodCorrectInShortlist} / ${report.foodLinesInShortlist} | ${pct(report.foodAccuracyOverall)} | ${pct(report.noneAccuracy)} | ${pct(report.falsePickRate)} | ${report.arm === "baseline" ? "—" : `${report.callFailures} / ${report.callsMade}`} | ${report.medianLatencyMs === null ? "—" : `${report.medianLatencyMs} ms`} | ${report.p95LatencyMs === null ? "—" : `${report.p95LatencyMs} ms`} | ${usd(report.totalCostUsd)} |`,
    );
}
md.push("");
md.push(
    "Pick accuracy is scored only where the correct food was in the shortlist; overall food accuracy divides by all food lines (search misses included). A failed Decisions call counts as an incorrect pick and is also counted under call failures. Baseline latency/cost: the search is shared by all arms and the baseline makes no model call.",
);
md.push("");
md.push(
    `## Search misses (${searchMisses.length} food lines — the correct food was NOT in the top-8 shortlist)`,
);
md.push("");
if (searchMisses.length === 0) {
    md.push("None.");
} else {
    for (const outcome of searchMisses) {
        md.push(
            `- **${outcome.search.line.name}** (raw: "${outcome.search.line.raw_label}", expected: "${outcome.search.line.expected}") — shortlist: ${outcome.search.candidates.length ? outcome.search.candidates.map((candidate) => candidate.name).join(" · ") : "(empty)"}`,
        );
    }
}
md.push("");
for (const report of armReports) {
    md.push(`## Pick errors — ${report.arm} (${report.pickErrors.length})`);
    md.push("");
    if (report.pickErrors.length === 0) {
        md.push("None.");
    } else {
        for (const error of report.pickErrors) {
            md.push(
                `- **${error.name}** (raw: "${error.rawLabel}", expected: "${error.expected}", correct at rank ${error.matchingRanks.join(",")}) — picked: ${error.picked}`,
            );
        }
    }
    md.push("");
    md.push(
        `## False picks on NONE-expected lines — ${report.arm} (${report.falsePicks.length})`,
    );
    md.push("");
    if (report.falsePicks.length === 0) {
        md.push("None.");
    } else {
        for (const error of report.falsePicks) {
            md.push(
                `- **${error.name}** (${error.kind}, raw: "${error.rawLabel}") — picked: ${error.picked}`,
            );
        }
    }
    md.push("");
}
md.push("## Per-line detail");
md.push("");
md.push(
    "| Line (extracted name) | Kind | Expected | In shortlist (rank) | " +
        ARM_NAMES.map(
            (arm) => `Pick: ${arm === "baseline" ? "baseline rank-1" : arm}`,
        ).join(" | ") +
        " |",
);
md.push(
    "| --- | --- | --- | --- | " +
        ARM_NAMES.map(() => "---").join(" | ") +
        " |",
);
for (const outcome of outcomes) {
    const { line, candidates, foodInShortlist, matchingRanks } = outcome.search;
    const pickCell = (arm: string): string => {
        const pick = outcome.picks[arm] ?? null;
        if (pick === null) return "none";
        const entry = candidates[pick];
        return entry ? `#${entry.rank} ${entry.name}` : "none";
    };
    md.push(
        `| ${line.name} | ${line.kind} | ${line.expected ?? "NONE"} | ${line.kind === "food" ? (foodInShortlist ? `yes (${matchingRanks.join(",")})` : "NO — search miss") : "—"} | ${ARM_NAMES.map(pickCell).join(" | ")} |`,
    );
}
md.push("");
md.push(
    "Full shortlists, raw probabilities, per-call cost and latency are in results.json.",
);

await mkdir(OUT, { recursive: true });
await writeFile(
    join(OUT, "results.json"),
    JSON.stringify(resultsJson, null, 2),
);
await writeFile(join(OUT, "report.md"), md.join("\n"));
console.info(
    `[correlation] done. ship bar: ${shipBarPassed ? "PASSED" : "NOT MET"} (${PRIMARY_MODEL} ${pct(primaryReport?.pickAccuracyInShortlist ?? null)} vs baseline ${pct(baselineReport?.pickAccuracyInShortlist ?? null)}); search misses=${searchMisses.length}; report at ${OUT}`,
);
