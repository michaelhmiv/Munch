/**
 * B1 receipt-correlation eval (Jev accountability audit §2 seat B1;
 * model-integration brief seat S3, re-measured for the B1 build).
 *
 * WHY THIS EXISTS alongside scripts/receipt-correlation-probe.ts:
 * the Nov 11 probe asked a strict same-food question through a
 * hand-rolled fetch and every model abstained on rank-1 layups
 * (Jev 50.0% vs rank-1 baseline 95.0% — ship bar NOT met, PR #249).
 * B1 ships S2's best-match adapter shape instead, so this harness
 * re-measures through the PRODUCTION call shape: the real Decisions
 * client (`callDecisionsWithFallback`, via the seat in
 * src/decisions/receipt.ts), the real state/question builders, and
 * the seat's real answer mapping. A result from any other shape
 * would not be a property of the seat that ships.
 *
 * PRE-REGISTERED SHIP BAR (from the brief, unchanged): the primary
 * model's pick accuracy >= the deterministic rank-1 baseline's pick
 * accuracy, on food lines where the correct food was in the
 * shortlist. Pick errors are split into ABSTENTIONS (the arm chose
 * "none" or gave no usable answer) and WRONG PICKS (it chose a
 * different entry) — the two failure classes fail in opposite
 * directions and are never blended. Search misses (correct food
 * absent from the shortlist) are reported separately from pick
 * errors, exactly as in the probe.
 *
 * Arms, each scored separately (per model, never pooled):
 *   baseline            — rank-1 of the production search, no call
 *   typesafe/jev-1.14   — single-model Decisions chain (the seat)
 *   perplexity/pplx-decider-v1.2 — single-model chain (fallback #1)
 *   production chain    — jev-1.14 -> pplx-decider-v1.2, as shipped
 *
 * False-pick discipline: non-food + trap lines (expected pick:
 * none) are run through the seat as a SEPARATE arm — production
 * wiring only sends food lines, so this measures the seat's
 * none-discipline if a mis-extracted line ever reached it; it is
 * never blended into the ship-bar numbers.
 *
 * Plausibility: fixture quantities are ground-truth sane (or
 * unstated), so the plausibility question is scored as a
 * false-alarm check on those lines (probability assigned to
 * "sane"), PLUS a clearly-labelled harness-only sanity probe: four
 * food lines re-asked with an absurd quantity (e.g. 400 gallons of
 * milk). The mutated lines are synthetic, check only that the
 * question discriminates, and support no shipping conclusion.
 *
 * Shortlists mirror the probe's wiring: live USDA + Open Food
 * Facts through the production FoodProviderRegistry ranking; the
 * local catalog layer needs Postgres and is skipped in this lane,
 * and the report says so.
 *
 * Cost/latency are measured from the run itself: the production
 * client logs `cost_usd` (API-reported usage.cost) per successful
 * call; this harness captures those log lines per arm.
 *
 * Knobs (env): B1_EVAL_OUT (default ./receipt-b1-report). Exit 0
 * when a report was produced — a failing arm is data, not a harness
 * failure. Exit 2 when the API keys are not configured.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenFoodFactsProvider } from "../src/food-providers/open-food-facts.js";
import { FoodProviderRegistry } from "../src/food-providers/registry.js";
import { UsdaFoodDataCentralProvider } from "../src/food-providers/usda.js";
import type { FoodCandidate } from "../src/food-providers/types.js";
import { encodeFoodCandidateId } from "../src/food-providers/service.js";
import {
    correlateReceiptLinesViaDecisions,
    type ReceiptCorrelation,
    type ReceiptCorrelationRequest,
} from "../src/decisions/receipt.js";
import type { DecisionsConfig } from "../src/decisions/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(
    ROOT,
    "fixtures",
    "receipt-correlation",
    "lines.json",
);
const OUT = process.env.B1_EVAL_OUT ?? join(ROOT, "receipt-b1-report");
const SHORTLIST_LIMIT = 8;

if (
    !process.env.OPENROUTER_API_KEY?.trim() ||
    !process.env.USDA_FDC_API_KEY?.trim()
) {
    console.error(
        "[b1-eval] OPENROUTER_API_KEY and USDA_FDC_API_KEY are required; the eval lane cannot run.",
    );
    process.exit(2);
}
const API_KEY = process.env.OPENROUTER_API_KEY;

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
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureFile;
const lines = fixture.lines;

// --- Matching rule: implemented exactly as the probe implements it
// (verbatim from fixtures/receipt-correlation/lines.json). ---
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

// --- Shortlists via the production registry (probe wiring). ---
const registry = new FoodProviderRegistry([
    new UsdaFoodDataCentralProvider({ timeoutMs: 10_000 }),
    new OpenFoodFactsProvider({ timeoutMs: 10_000 }),
]);

interface ShortlistEntry {
    rank: number;
    provider: string;
    providerFoodId: string;
    candidateId: string;
    name: string;
    brand: string | null;
    matchesExpected: boolean;
}
interface LineSearch {
    line: FixtureLine;
    candidates: ShortlistEntry[];
    foodInShortlist: boolean | null;
    matchingRanks: number[];
}

const searches: LineSearch[] = [];
for (const line of lines) {
    const result = await registry.search({
        query: line.name,
        limit: SHORTLIST_LIMIT,
    });
    const candidates: ShortlistEntry[] = result.candidates.map(
        (candidate: FoodCandidate, index) => ({
            rank: index + 1,
            provider: candidate.provider,
            providerFoodId: candidate.providerFoodId,
            candidateId: encodeFoodCandidateId(candidate),
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
        candidates,
        foodInShortlist: line.kind === "food" ? matchingRanks.length > 0 : null,
        matchingRanks,
    });
    console.info(
        `[b1-eval] search "${line.name}" -> ${candidates.length} candidates${line.kind === "food" ? `, expected in shortlist: ${matchingRanks.length > 0 ? `yes (rank ${matchingRanks.join(",")})` : "NO (search miss)"}` : ""}`,
    );
}

function toRequest(
    search: LineSearch,
    keyPrefix: string,
    index: number,
): ReceiptCorrelationRequest {
    return {
        key: `${keyPrefix}:${index}`,
        rawLabel: search.line.raw_label,
        itemName: search.line.name,
        quantity: search.line.quantity,
        unit: search.line.unit,
        candidates: search.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            name: candidate.name,
            brand: candidate.brand,
            provider: candidate.provider,
            providerFoodId: candidate.providerFoodId,
        })),
    };
}

// --- Cost capture: the production client logs cost_usd per call. ---
let capturedCosts: number[] = [];
const originalInfo = console.info;
console.info = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    const match = /seat=receipt status=success .*cost_usd=([0-9.]+)/.exec(text);
    if (match) capturedCosts.push(Number(match[1]));
    originalInfo(...args);
};

function seatConfig(models: string[]): DecisionsConfig {
    return {
        apiKey: API_KEY,
        apiUrl: "https://openrouter.ai/api/alpha/decisions",
        models,
        gateTimeoutMs: 1_500,
        deciderTimeoutMs: 15_000,
        gateEnabled: false,
        deciderEnabled: false,
        receiptEnabled: true,
    };
}

interface ArmRun {
    arm: string;
    /** key -> correlation, for every line the arm was asked about. */
    results: Map<string, ReceiptCorrelation>;
    totalCostUsd: number | null;
    callsMade: number;
    durationMs: number;
    error: string | null;
}

async function runArm(
    arm: string,
    models: string[],
    subset: LineSearch[],
    keyPrefix: string,
): Promise<ArmRun> {
    const requests = subset
        .map((search, index) => ({ search, index }))
        .filter(({ search }) => search.candidates.length > 0)
        .map(({ search, index }) => toRequest(search, keyPrefix, index));
    capturedCosts = [];
    const startedAt = Date.now();
    try {
        const results = await correlateReceiptLinesViaDecisions(
            requests,
            seatConfig(models),
            {},
        );
        return {
            arm,
            results,
            totalCostUsd: capturedCosts.reduce((sum, cost) => sum + cost, 0),
            callsMade: capturedCosts.length,
            durationMs: Date.now() - startedAt,
            error: null,
        };
    } catch (error) {
        return {
            arm,
            results: new Map(),
            totalCostUsd: null,
            callsMade: capturedCosts.length,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

const foodSearches = searches.filter((search) => search.line.kind === "food");
const noneSearches = searches.filter((search) => search.line.kind !== "food");

const MODEL_ARMS: Array<{ arm: string; models: string[] }> = [
    { arm: "typesafe/jev-1.14", models: ["typesafe/jev-1.14"] },
    {
        arm: "perplexity/pplx-decider-v1.2",
        models: ["perplexity/pplx-decider-v1.2"],
    },
    {
        arm: "production chain (jev -> pplx)",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
    },
];

const foodRuns: ArmRun[] = [];
for (const { arm, models } of MODEL_ARMS) {
    foodRuns.push(await runArm(arm, models, foodSearches, "food"));
    console.info(`[b1-eval] arm ${arm}: food lines done`);
}
const noneRuns: ArmRun[] = [];
for (const { arm, models } of MODEL_ARMS) {
    noneRuns.push(await runArm(arm, models, noneSearches, "none"));
    console.info(`[b1-eval] arm ${arm}: none-expected lines done`);
}

// --- Scoring (failure classes never blended). ---
interface PickScore {
    pickCandidateId: string | null;
    correct: boolean;
    abstained: boolean;
}
function scoreFoodPick(
    arm: string,
    search: LineSearch,
    index: number,
): PickScore {
    if (arm === "baseline") {
        const first = search.candidates[0];
        return {
            pickCandidateId: first?.candidateId ?? null,
            correct: first?.matchesExpected === true,
            abstained: false,
        };
    }
    const run = foodRuns.find((entry) => entry.arm === arm)!;
    const correlation = run.results.get(`food:${index}`);
    if (!correlation || correlation.candidateId === null) {
        return { pickCandidateId: null, correct: false, abstained: true };
    }
    const picked = search.candidates.find(
        (candidate) => candidate.candidateId === correlation.candidateId,
    );
    return {
        pickCandidateId: correlation.candidateId,
        correct: picked?.matchesExpected === true,
        abstained: false,
    };
}

interface ArmReport {
    arm: string;
    foodLinesInShortlist: number;
    foodCorrectInShortlist: number;
    pickAccuracyInShortlist: number | null;
    abstentionsInShortlist: number;
    wrongPicksInShortlist: number;
    foodCorrectOverall: number;
    foodAccuracyOverall: number | null;
    attachedCorrect: number;
    attachedWrong: number;
    pickProbabilities: {
        correct: number[];
        wrong: number[];
        abstained: number[];
    };
    plausibilityOnSaneLines: number[];
    noneLines: number;
    noneCorrect: number;
    falsePickRate: number | null;
    callsMade: number;
    totalCostUsd: number | null;
    meanCostPerLineUsd: number | null;
    durationMs: number | null;
    error: string | null;
}

function buildArmReport(arm: string): ArmReport {
    let inShortlist = 0;
    let correctIn = 0;
    let abstentions = 0;
    let wrongPicks = 0;
    let correctOverall = 0;
    let attachedCorrect = 0;
    let attachedWrong = 0;
    const pickProbabilities = {
        correct: [] as number[],
        wrong: [] as number[],
        abstained: [] as number[],
    };
    const plausibilityOnSaneLines: number[] = [];
    foodSearches.forEach((search, index) => {
        const score = scoreFoodPick(arm, search, index);
        if (score.correct) correctOverall += 1;
        if (arm !== "baseline") {
            const run = foodRuns.find((entry) => entry.arm === arm)!;
            const correlation = run.results.get(`food:${index}`);
            if (correlation) {
                if (typeof correlation.plausibilityProbability === "number")
                    plausibilityOnSaneLines.push(
                        correlation.plausibilityProbability,
                    );
                if (correlation.providerFoodId !== null) {
                    if (score.correct) attachedCorrect += 1;
                    else if (!score.abstained) attachedWrong += 1;
                }
            }
        }
        if (!search.foodInShortlist) return;
        inShortlist += 1;
        if (score.correct) {
            correctIn += 1;
            if (arm !== "baseline") {
                const correlation = foodRuns
                    .find((entry) => entry.arm === arm)!
                    .results.get(`food:${index}`);
                if (correlation)
                    pickProbabilities.correct.push(correlation.pickProbability);
            }
        } else if (score.abstained) {
            abstentions += 1;
            const correlation = foodRuns
                .find((entry) => entry.arm === arm)!
                .results.get(`food:${index}`);
            if (correlation)
                pickProbabilities.abstained.push(correlation.pickProbability);
        } else {
            wrongPicks += 1;
            if (arm !== "baseline") {
                const correlation = foodRuns
                    .find((entry) => entry.arm === arm)!
                    .results.get(`food:${index}`);
                if (correlation)
                    pickProbabilities.wrong.push(correlation.pickProbability);
            }
        }
    });
    let noneCorrect = 0;
    noneSearches.forEach((search, index) => {
        if (arm === "baseline") {
            // The baseline force-picks rank-1 whenever a shortlist
            // exists — it can only be "correct" on an empty shortlist.
            if (search.candidates.length === 0) noneCorrect += 1;
            return;
        }
        const run = noneRuns.find((entry) => entry.arm === arm)!;
        const correlation = run.results.get(`none:${index}`);
        if (!correlation || correlation.candidateId === null) noneCorrect += 1;
    });
    const run = foodRuns.find((entry) => entry.arm === arm);
    const foodTotal = foodSearches.length;
    return {
        arm,
        foodLinesInShortlist: inShortlist,
        foodCorrectInShortlist: correctIn,
        pickAccuracyInShortlist: inShortlist ? correctIn / inShortlist : null,
        abstentionsInShortlist: abstentions,
        wrongPicksInShortlist: wrongPicks,
        foodCorrectOverall: correctOverall,
        foodAccuracyOverall: foodTotal ? correctOverall / foodTotal : null,
        attachedCorrect,
        attachedWrong,
        pickProbabilities,
        plausibilityOnSaneLines,
        noneLines: noneSearches.length,
        noneCorrect,
        falsePickRate: noneSearches.length
            ? 1 - noneCorrect / noneSearches.length
            : null,
        callsMade: run?.callsMade ?? 0,
        totalCostUsd: arm === "baseline" ? 0 : (run?.totalCostUsd ?? null),
        meanCostPerLineUsd:
            arm === "baseline" || !run || run.callsMade === 0
                ? arm === "baseline"
                    ? 0
                    : null
                : (run.totalCostUsd ?? 0) / Math.max(1, foodSearches.length),
        durationMs: arm === "baseline" ? null : (run?.durationMs ?? null),
        error: run?.error ?? null,
    };
}

const armReports = ["baseline", ...MODEL_ARMS.map(({ arm }) => arm)].map(
    buildArmReport,
);
const primaryReport = armReports.find(
    (report) => report.arm === "typesafe/jev-1.14",
);
const baselineReport = armReports.find((report) => report.arm === "baseline");
const shipBarPassed =
    primaryReport?.pickAccuracyInShortlist != null &&
    baselineReport?.pickAccuracyInShortlist != null &&
    primaryReport.pickAccuracyInShortlist >=
        baselineReport.pickAccuracyInShortlist;

// --- Plausibility sanity probe (harness-only, synthetic mutations).
const MUTATIONS: Array<{ namePart: string; quantity: number; unit: string }> = [
    { namePart: "milk", quantity: 400, unit: "gallon" },
    { namePart: "cucumber", quantity: 900, unit: "count" },
    { namePart: "cola", quantity: 250, unit: "count" },
    { namePart: "banana", quantity: 120, unit: "kg" },
];
const mutationSearches = foodSearches.filter((search) =>
    MUTATIONS.some((mutation) =>
        search.line.name.toLowerCase().includes(mutation.namePart),
    ),
);
interface MutationResult {
    line: string;
    mutatedQuantity: string;
    plausibilityProbability: number | null;
    model: string | null;
}
const mutationResults: MutationResult[] = [];
for (const { arm, models } of MODEL_ARMS.slice(0, 2)) {
    const requests = mutationSearches.map((search, index) => {
        const mutation = MUTATIONS.find((entry) =>
            search.line.name.toLowerCase().includes(entry.namePart),
        )!;
        const request = toRequest(search, "mut", index);
        return {
            ...request,
            key: `${arm}:${index}`,
            quantity: mutation.quantity,
            unit: mutation.unit,
        };
    });
    if (requests.length === 0) continue;
    try {
        const results = await correlateReceiptLinesViaDecisions(
            requests,
            seatConfig(models),
            {},
        );
        requests.forEach((request, index) => {
            const search = mutationSearches[index]!;
            const mutation = MUTATIONS.find((entry) =>
                search.line.name.toLowerCase().includes(entry.namePart),
            )!;
            const correlation = results.get(request.key);
            mutationResults.push({
                line: `${search.line.name} [${arm}]`,
                mutatedQuantity: `${mutation.quantity} ${mutation.unit}`,
                plausibilityProbability:
                    correlation?.plausibilityProbability ?? null,
                model: correlation?.model ?? null,
            });
        });
    } catch {
        // Recorded as nulls below via absence; a dead chain here is
        // reported in the arm errors, not hidden.
    }
}
console.info = originalInfo;

// --- Report. ---
function pct(value: number | null): string {
    return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
function usd(value: number | null): string {
    return value === null ? "n/a" : `$${value.toFixed(5)}`;
}
function distribution(values: number[]): string {
    if (values.length === 0) return "—";
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return `min ${sorted[0]!.toFixed(2)} / median ${median.toFixed(2)} / max ${sorted[sorted.length - 1]!.toFixed(2)} (n=${values.length})`;
}

const searchMisses = foodSearches.filter(
    (search) => search.foodInShortlist === false,
);
const resultsJson = {
    generatedAt: new Date().toISOString(),
    fixture: {
        source: fixture.source,
        version: fixture.version,
        totalLines: lines.length,
        foodLines: foodSearches.length,
        noneLines: noneSearches.length,
        matchingRule: fixture.matching_rule,
        provenance: fixture.provenance,
    },
    callShape:
        "Production: src/decisions/receipt.ts state/question builders + src/decisions/client.ts callDecisionsWithFallback, single-model chains per arm (plus the shipped jev->pplx chain arm). Shortlists: live USDA + Open Food Facts via the production FoodProviderRegistry ranking; local catalog (Postgres) skipped in this lane, as in the Nov 11 probe.",
    shipBar: {
        rule: "Jev (typesafe/jev-1.14) pick accuracy >= rank-1 baseline pick accuracy, on food lines where the correct food was in the shortlist",
        primaryAccuracy: primaryReport?.pickAccuracyInShortlist ?? null,
        baselineAccuracy: baselineReport?.pickAccuracyInShortlist ?? null,
        passed: shipBarPassed,
    },
    arms: armReports,
    searchMissCount: searchMisses.length,
    searchMisses: searchMisses.map((search) => ({
        name: search.line.name,
        rawLabel: search.line.raw_label,
        expected: search.line.expected,
        shortlist: search.candidates.map((candidate) => candidate.name),
    })),
    plausibilitySanityProbe: {
        note: "Synthetic quantity mutations of real fixture lines — harness discrimination check ONLY; supports no shipping conclusion.",
        results: mutationResults,
    },
};

const md: string[] = [];
md.push("# B1 receipt-correlation eval — report");
md.push("");
md.push(
    `Generated ${resultsJson.generatedAt}. Fixture: fixtures/receipt-correlation/lines.json (${lines.length} lines: ${foodSearches.length} food, ${noneSearches.length} expected-none) built from the hand-labelled fixtures/receipt-eval set (real receipt photos, CC BY-SA 4.0). Call shape: the PRODUCTION B1 seat (src/decisions/receipt.ts) through the real Decisions client — not the Nov 11 probe's hand-rolled fetch or its strict same-food framing.`,
);
md.push("");
md.push("## Ship bar (pre-registered, from the brief)");
md.push("");
md.push(
    `Jev pick accuracy >= rank-1 baseline, on food lines where the correct food was in the shortlist. **typesafe/jev-1.14: ${pct(primaryReport?.pickAccuracyInShortlist ?? null)} vs baseline ${pct(baselineReport?.pickAccuracyInShortlist ?? null)} — ${shipBarPassed ? "SHIP BAR PASSED" : "SHIP BAR NOT MET"}.**`,
);
md.push("");
md.push("## Per-arm results (scored per model, never pooled)");
md.push("");
md.push(
    "| Arm | Pick accuracy (in-shortlist) | Correct / in-shortlist | Abstentions | Wrong picks | Overall food accuracy | NONE accuracy (separate arm) | False-pick rate | Attached correct / wrong | Total cost (food arm) | Mean cost / line | Food-arm wall time |",
);
md.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
);
for (const report of armReports) {
    md.push(
        `| ${report.arm} | ${pct(report.pickAccuracyInShortlist)} | ${report.foodCorrectInShortlist} / ${report.foodLinesInShortlist} | ${report.abstentionsInShortlist} | ${report.wrongPicksInShortlist} | ${pct(report.foodAccuracyOverall)} | ${pct(report.noneLines ? report.noneCorrect / report.noneLines : null)} | ${pct(report.falsePickRate)} | ${report.attachedCorrect} / ${report.attachedWrong} | ${usd(report.totalCostUsd)} | ${usd(report.meanCostPerLineUsd)} | ${report.durationMs === null ? "—" : `${report.durationMs} ms`} |`,
    );
}
md.push("");
md.push(
    "Abstentions and wrong picks are reported separately: an abstention leaves the line to human review by name; a wrong pick files a wrong provider identity if it also clears the attachment threshold (attached correct/wrong). A failed Decisions call counts as an abstention and is never silently dropped.",
);
md.push("");
md.push("## Pick-probability distributions (in-shortlist food lines)");
md.push("");
for (const report of armReports) {
    if (report.arm === "baseline") continue;
    md.push(
        `- **${report.arm}** — correct picks: ${distribution(report.pickProbabilities.correct)}; wrong picks: ${distribution(report.pickProbabilities.wrong)}; abstentions (p of "none"): ${distribution(report.pickProbabilities.abstained)}`,
    );
}
md.push("");
md.push(
    "## Plausibility question — false-alarm check on ground-truth sane lines",
);
md.push("");
for (const report of armReports) {
    if (report.arm === "baseline") continue;
    const values = report.plausibilityOnSaneLines;
    const alarms = values.filter((value) => value < 0.5).length;
    md.push(
        `- **${report.arm}** — p(sane) distribution: ${distribution(values)}; false alarms (< 0.5): ${alarms} / ${values.length}`,
    );
}
md.push("");
md.push(
    "## Plausibility sanity probe (synthetic mutations — harness check only)",
);
md.push("");
if (mutationResults.length === 0) {
    md.push("No mutation lines ran.");
} else {
    for (const result of mutationResults) {
        md.push(
            `- **${result.line}** mutated to ${result.mutatedQuantity} — p(sane) = ${result.plausibilityProbability === null ? "n/a" : result.plausibilityProbability.toFixed(2)}`,
        );
    }
}
md.push("");
md.push(
    `## Search misses (${searchMisses.length} food lines — correct food NOT in the top-8 shortlist; arm-independent)`,
);
md.push("");
if (searchMisses.length === 0) md.push("None.");
for (const search of searchMisses) {
    md.push(
        `- **${search.line.name}** (raw: "${search.line.raw_label}", expected: "${search.line.expected}")`,
    );
}
md.push("");
md.push("## What this eval cannot show");
md.push("");
md.push(
    "- Shortlists are the provider-only form of production search (the local catalog layer needs Postgres and is skipped, as in the Nov 11 probe), so absolute accuracies may shift against the full production search; the ship bar is a comparison on identical shortlists, which this does establish.",
);
md.push(
    "- The fixture's quantities are ground-truth sane or unstated, so plausibility is measured only as a false-alarm rate plus a synthetic discrimination check — not as accuracy on real mis-extracted quantities.",
);
md.push(
    "- Lines are the labelled extraction ground truth; no fresh extraction is run, so extraction errors are out of scope for this seat's numbers.",
);

await mkdir(OUT, { recursive: true });
await writeFile(
    join(OUT, "results.json"),
    JSON.stringify(resultsJson, null, 2),
);
await writeFile(join(OUT, "report.md"), md.join("\n"));
console.info(
    `[b1-eval] done. ship bar: ${shipBarPassed ? "PASSED" : "NOT MET"} (jev ${pct(primaryReport?.pickAccuracyInShortlist ?? null)} vs baseline ${pct(baselineReport?.pickAccuracyInShortlist ?? null)}); report at ${OUT}`,
);
