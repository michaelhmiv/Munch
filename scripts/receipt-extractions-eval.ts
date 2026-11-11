/**
 * Extraction models vs the incumbent on the RECEIPT function (Michael
 * directive, 2026-11-11): receipts are the Extractions API's home
 * turf, so benchmark them there too, against what production does
 * TODAY.
 *
 * Fixtures: fixtures/receipt-eval — 3 real, openly licensed grocery
 * receipt photos (Wikimedia Commons, CC BY-SA 4.0; provenance in
 * fixtures/receipt-eval/README.md), hand-labelled under a
 * conservative rule (only legibly printed purchased lines are items;
 * totals/tax/payment/loyalty/discount lines are traps that count as
 * spurious when returned). 28 expected lines total.
 *
 * Contenders (each receipt x repeats):
 *  (a) ember-production — the INCUMBENT: src/inventory/vision.ts
 *      previewInventoryImage with mode "receipt", called with the
 *      exact production configuration (model meta/muse-ember, the
 *      production prompt + strict JSON preview schema inside that
 *      function; 60s harness timeout in place of the 30s production
 *      default, the bake-off fairness rule). This is the production
 *      code path itself, not a re-implementation.
 *  (b) cloudflare/clairic via POST /api/alpha/extractions with
 *      receipt-shaped fields mirroring the production preview schema.
 *      The API has no list-of-objects type, so the schema's per-line
 *      object is carried by PARALLEL typed lists zipped positionally:
 *        raw_labels: list<text>   — labels exactly as printed
 *        names:      list<text>   — expanded names, same order
 *        quantities: list<number> — printed quantity per line
 *                                   (multiplier or weighed amount),
 *                                   1 when none is printed
 *        units:      list<text>   — kg/g/l/ml or "each", same order
 *        is_food:    list<text>   — "food" / "non-food", same order
 *        locations:  list<text>   — pantry/fridge/freezer/
 *                                   unspecified, same order
 *      Per-line confidence is not a field: the names answer's
 *      per-item `confidences` array is recorded when present.
 *  (c) scaledown/extract — labels-only contender. Gate per Michael's
 *      rule: it joins because its typing carried the photo identify
 *      items passably in the photo lane (70.9% recall, names-only,
 *      0/60 failures — measured on PR #244's run 43017200257). Its
 *      field typing (text + list<text>) can carry the raw labels and
 *      nothing else structured, so quantity/unit/is_food are n/a.
 *
 * Scoring: greedy one-to-one line matching with scoring.ts
 * namesMatch — an expected line is found when any returned name or
 * raw label matches the expected name or raw label. Recall = found /
 * expected; precision = found / returned (spurious lines, including
 * any totals/tax lines a contender returns, are listed); quantity+
 * unit correctness over matched lines whose expectation carries a
 * printed quantity; is_food accuracy over matched lines.
 *
 * Knobs (env): RECEIPT_MODELS (default "ember,clairic,scaledown"),
 * RECEIPT_REPEATS (default 2), RECEIPT_OUT (default
 * ./receipt-report). Exit 0 when a report was produced; exit 2 when
 * the API key is missing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    previewInventoryImage,
    type InventoryVisionConfig,
} from "../src/inventory/vision.js";
import { namesMatch } from "../src/meal-photo/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const openRouterKey = process.env.OPENROUTER_API_KEY ?? "";
const openRouterAuth = "Bearer " + openRouterKey;
const FIXTURES = join(HERE, "..", "fixtures", "receipt-eval");
const OUT = process.env.RECEIPT_OUT ?? join(HERE, "..", "receipt-report");
const EXTRACTIONS_URL = "https://openrouter.ai/api/alpha/extractions";
const EMBER_SLUG = "meta/muse-ember";
const EMBER_PRICE = { input: 0.1, output: 0.5 };
const CLAIRIC_PRICE = { input: 0.1, output: 0 };
const SCALEDOWN_PRICE = { input: 0.045, output: 0 };

const repeats = Math.max(
    1,
    Math.min(5, Number(process.env.RECEIPT_REPEATS ?? 2) || 2),
);
const contenderTokens = (
    process.env.RECEIPT_MODELS?.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean) ?? []
).filter((value, index, all) => all.indexOf(value) === index);
const contendersWanted = contenderTokens.length
    ? contenderTokens
    : ["ember", "clairic", "scaledown"];
const runStartedAt = new Date().toISOString();

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[receipts] OPENROUTER_API_KEY is required.");
    process.exit(2);
}

interface ExpectedLine {
    raw_label: string;
    name: string;
    quantity: number | null;
    unit: string | null;
    is_food: boolean;
}

interface ReceiptFixture {
    id: string;
    file: string;
    store: string;
    lines: ExpectedLine[];
}

const expectations = JSON.parse(
    await readFile(join(FIXTURES, "expectations.json"), "utf8"),
) as { fixtures: ReceiptFixture[] };
const fixtures = expectations.fixtures;
if (fixtures.length === 0) {
    console.error("[receipts] No receipt fixtures; nothing to run.");
    process.exit(2);
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[index] ?? null;
}

interface FoundLine {
    raw_label: string | null;
    name: string;
    quantity: number | null;
    unit: string | null;
    is_food: boolean | null;
}

// ---------------------------------------------------------------------------
// Contender (a): the production Ember call shape, via the production
// function itself.
// ---------------------------------------------------------------------------

interface ChatObservation {
    reportedCostUsd: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
}

async function runEmberReceipt(bytes: Uint8Array): Promise<{
    lines: FoundLine[];
    reportedCostUsd: number | null;
    computedCostUsd: number | null;
}> {
    const observations: ChatObservation[] = [];
    const fetcher = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const response = await fetch(input, init);
        const observation: ChatObservation = {
            reportedCostUsd: null,
            promptTokens: null,
            completionTokens: null,
        };
        try {
            const payload = (await response.clone().json()) as any;
            const usage = payload?.usage;
            observation.reportedCostUsd =
                typeof usage?.cost === "number" ? usage.cost : null;
            observation.promptTokens =
                typeof usage?.prompt_tokens === "number"
                    ? usage.prompt_tokens
                    : null;
            observation.completionTokens =
                typeof usage?.completion_tokens === "number"
                    ? usage.completion_tokens
                    : null;
        } catch {
            // keep nulls
        }
        observations.push(observation);
        return response;
    };
    const config: InventoryVisionConfig = {
        apiKey: openRouterKey,
        model: EMBER_SLUG,
        baseUrl: "https://openrouter.ai/api/v1",
        timeoutMs: 60_000,
        maxTokens: 4_000,
    };
    const preview = await previewInventoryImage(
        { mode: "receipt", mimeType: "image/jpeg", bytes },
        config,
        { fetcher },
    );
    let reportedCostUsd: number | null = null;
    let computedCostUsd = 0;
    for (const observation of observations) {
        if (observation.reportedCostUsd !== null) {
            reportedCostUsd =
                (reportedCostUsd ?? 0) + observation.reportedCostUsd;
        }
        computedCostUsd +=
            ((observation.promptTokens ?? 0) / 1_000_000) * EMBER_PRICE.input +
            ((observation.completionTokens ?? 0) / 1_000_000) *
                EMBER_PRICE.output;
    }
    return {
        lines: preview.lines.map((line) => ({
            raw_label: line.raw_label,
            name: line.name,
            quantity: line.quantity,
            unit: line.unit,
            is_food: line.is_food,
        })),
        reportedCostUsd,
        computedCostUsd,
    };
}

// ---------------------------------------------------------------------------
// Contenders (b)/(c): the Extractions API.
// ---------------------------------------------------------------------------

const RAW_LABELS_INSTRUCTIONS =
    "Every purchased line item printed on the receipt, in receipt order, with the product label exactly as printed (including abbreviations). Do not include subtotal, total, tax, payment, change, loyalty, coupon, or discount lines.";
const NAMES_INSTRUCTIONS =
    "For each entry in raw_labels, in exactly the same order, a concise expanded product name: expand obvious receipt abbreviations when reasonably confident, but do not invent brands.";
const QUANTITIES_INSTRUCTIONS =
    "For each entry in raw_labels, in exactly the same order, the purchased quantity when the receipt prints one (a multiplier such as 2x, or a weighed amount such as 1.204); when no quantity is printed for that line, use 1.";
const UNITS_INSTRUCTIONS =
    "For each entry in raw_labels, in exactly the same order, the unit of the corresponding quantity: kg, g, l, or ml for weighed or measured amounts, or 'each' when the quantity is a count or no unit is printed.";
const IS_FOOD_INSTRUCTIONS =
    "For each entry in raw_labels, in exactly the same order, 'food' if the item is human food or drink, otherwise 'non-food' (household goods, pet food, toiletries, and anything else that is not human food).";
const LOCATIONS_INSTRUCTIONS =
    "For each entry in raw_labels, in exactly the same order, the most plausible storage location: exactly one of pantry, fridge, freezer, unspecified. Use fridge, freezer, or pantry only when strongly implied by the food; otherwise unspecified.";

const CLAIRIC_RECEIPT_FIELDS: Record<string, unknown> = {
    raw_labels: {
        type: "list",
        items: "text",
        instructions: RAW_LABELS_INSTRUCTIONS,
    },
    names: { type: "list", items: "text", instructions: NAMES_INSTRUCTIONS },
    quantities: {
        type: "list",
        items: "number",
        decimals: 3,
        instructions: QUANTITIES_INSTRUCTIONS,
    },
    units: { type: "list", items: "text", instructions: UNITS_INSTRUCTIONS },
    is_food: {
        type: "list",
        items: "text",
        instructions: IS_FOOD_INSTRUCTIONS,
    },
    locations: {
        type: "list",
        items: "text",
        instructions: LOCATIONS_INSTRUCTIONS,
    },
};

const SCALEDOWN_RECEIPT_FIELDS: Record<string, unknown> = {
    raw_labels: {
        type: "list",
        items: "text",
        instructions: RAW_LABELS_INSTRUCTIONS,
    },
};

async function callExtractions(
    model: string,
    fields: Record<string, unknown>,
    bytes: Uint8Array,
): Promise<{
    answers: Record<string, any>;
    usageCost: number | null;
    usageInputTokens: number | null;
    rawExcerpt: string;
}> {
    const response = await fetch(EXTRACTIONS_URL, {
        method: "POST",
        headers: {
            authorization: openRouterAuth,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model,
            fields,
            assets: {
                photo: {
                    type: "image",
                    format: "jpeg",
                    data_base64: Buffer.from(bytes).toString("base64"),
                },
            },
        }),
        signal: AbortSignal.timeout(60_000),
    });
    const rawText = await response.text();
    let payload: any = null;
    try {
        payload = JSON.parse(rawText);
    } catch {
        payload = null;
    }
    if (!response.ok || !payload?.answers) {
        throw new Error(
            `Extractions request failed (HTTP ${response.status}): ${rawText.slice(0, 400)}`,
        );
    }
    return {
        answers: payload.answers,
        usageCost:
            typeof payload.usage?.cost === "number" ? payload.usage.cost : null,
        usageInputTokens:
            typeof payload.usage?.input_tokens === "number"
                ? payload.usage.input_tokens
                : null,
        rawExcerpt: rawText.slice(0, 1_200),
    };
}

function stringList(answer: any): string[] {
    const raw = answer?.value ?? answer?.guess;
    if (!Array.isArray(raw)) return [];
    return raw.map((value) => (typeof value === "string" ? value : ""));
}

function numberList(answer: any): Array<number | null> {
    const raw = answer?.value ?? answer?.guess;
    if (!Array.isArray(raw)) return [];
    return raw.map((value) =>
        typeof value === "number" && Number.isFinite(value) ? value : null,
    );
}

function parseIsFood(value: string | undefined): boolean | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "food" || normalized === "true") return true;
    if (
        normalized === "non-food" ||
        normalized === "nonfood" ||
        normalized === "not food" ||
        normalized === "false"
    ) {
        return false;
    }
    return null;
}

async function runClairicReceipt(bytes: Uint8Array): Promise<{
    lines: FoundLine[];
    reportedCostUsd: number | null;
    computedCostUsd: number | null;
    alignment: Record<string, number>;
    confidencesSeen: boolean;
}> {
    const outcome = await callExtractions(
        "cloudflare/clairic",
        CLAIRIC_RECEIPT_FIELDS,
        bytes,
    );
    const rawLabels = stringList(outcome.answers.raw_labels);
    const names = stringList(outcome.answers.names);
    const quantities = numberList(outcome.answers.quantities);
    const units = stringList(outcome.answers.units);
    const isFood = stringList(outcome.answers.is_food);
    const lines: FoundLine[] = rawLabels.map((rawLabel, index) => ({
        raw_label: rawLabel || null,
        name: names[index]?.trim() ? names[index]! : rawLabel,
        quantity: quantities[index] ?? null,
        unit: units[index]?.trim() ? units[index]! : null,
        is_food: parseIsFood(isFood[index]),
    }));
    return {
        lines,
        reportedCostUsd: outcome.usageCost,
        computedCostUsd:
            outcome.usageInputTokens !== null
                ? (outcome.usageInputTokens / 1_000_000) * CLAIRIC_PRICE.input
                : null,
        alignment: {
            raw_labels: rawLabels.length,
            names: names.length,
            quantities: quantities.length,
            units: units.length,
            is_food: isFood.length,
        },
        confidencesSeen: Array.isArray(outcome.answers.names?.confidences),
    };
}

async function runScaleDownReceipt(bytes: Uint8Array): Promise<{
    lines: FoundLine[];
    reportedCostUsd: number | null;
    computedCostUsd: number | null;
}> {
    const outcome = await callExtractions(
        "scaledown/extract",
        SCALEDOWN_RECEIPT_FIELDS,
        bytes,
    );
    const rawLabels = stringList(outcome.answers.raw_labels);
    return {
        lines: rawLabels.map((rawLabel) => ({
            raw_label: rawLabel || null,
            name: rawLabel,
            quantity: null,
            unit: null,
            is_food: null,
        })),
        reportedCostUsd: outcome.usageCost,
        computedCostUsd:
            outcome.usageInputTokens !== null
                ? (outcome.usageInputTokens / 1_000_000) * SCALEDOWN_PRICE.input
                : null,
    };
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

function normalizeUnit(unit: string | null): string | null {
    if (!unit) return null;
    const normalized = unit.trim().toLowerCase();
    if (["kg", "kilogram", "kilograms", "kilo", "kilos"].includes(normalized))
        return "kg";
    if (["g", "gram", "grams", "gr"].includes(normalized)) return "g";
    if (["l", "liter", "liters", "litre", "litres"].includes(normalized))
        return "l";
    if (["ml", "milliliter", "milliliters"].includes(normalized)) return "ml";
    if (
        [
            "each",
            "ea",
            "count",
            "piece",
            "pieces",
            "pc",
            "pcs",
            "x",
            "",
        ].includes(normalized)
    )
        return "each";
    return normalized;
}

function unitCorrect(expected: ExpectedLine, found: FoundLine): boolean {
    const expectedUnit = normalizeUnit(expected.unit);
    const foundUnit = normalizeUnit(found.unit);
    if (expectedUnit === null)
        return foundUnit === null || foundUnit === "each";
    return foundUnit === expectedUnit;
}

function quantityCorrect(expected: ExpectedLine, found: FoundLine): boolean {
    if (expected.quantity === null) return true;
    if (found.quantity === null) return false;
    return (
        Math.abs(found.quantity - expected.quantity) <=
        Math.max(0.02, expected.quantity * 0.02)
    );
}

interface ReceiptScore {
    expected: number;
    returned: number;
    matched: number;
    spuriousNames: string[];
    quantityScored: number;
    quantityUnitCorrect: number;
    isFoodScored: number;
    isFoodCorrect: number;
}

function scoreReceipt(
    expected: ExpectedLine[],
    found: FoundLine[],
): ReceiptScore {
    const used = new Set<number>();
    let matched = 0;
    let quantityScored = 0;
    let quantityUnitCorrect = 0;
    let isFoodScored = 0;
    let isFoodCorrect = 0;
    for (const line of expected) {
        const index = found.findIndex((candidate, candidateIndex) => {
            if (used.has(candidateIndex)) return false;
            const foundNames = [candidate.name, candidate.raw_label].filter(
                (value): value is string => Boolean(value),
            );
            return foundNames.some((foundName) =>
                [line.name, line.raw_label].some((expectedName) =>
                    namesMatch(expectedName, foundName),
                ),
            );
        });
        if (index === -1) continue;
        used.add(index);
        matched += 1;
        const candidate = found[index]!;
        if (line.quantity !== null) {
            quantityScored += 1;
            if (
                quantityCorrect(line, candidate) &&
                unitCorrect(line, candidate)
            ) {
                quantityUnitCorrect += 1;
            }
        }
        if (candidate.is_food !== null) {
            isFoodScored += 1;
            if (candidate.is_food === line.is_food) isFoodCorrect += 1;
        }
    }
    return {
        expected: expected.length,
        returned: found.length,
        matched,
        spuriousNames: found
            .filter((_, index) => !used.has(index))
            .map((line) => line.raw_label ?? line.name),
        quantityScored,
        quantityUnitCorrect,
        isFoodScored,
        isFoodCorrect,
    };
}

// ---------------------------------------------------------------------------
// Runner + report.
// ---------------------------------------------------------------------------

interface ReceiptTask {
    fixtureId: string;
    repeat: number;
    ok: boolean;
    failure: string | null;
    latencyMs: number | null;
    reportedCostUsd: number | null;
    computedCostUsd: number | null;
    lines: FoundLine[];
    score: ReceiptScore | null;
}

interface ContenderDef {
    token: string;
    label: string;
    run: (bytes: Uint8Array) => Promise<{
        lines: FoundLine[];
        reportedCostUsd: number | null;
        computedCostUsd: number | null;
    }>;
}

const CONTENDERS: Record<string, ContenderDef> = {
    ember: {
        token: "ember",
        label: `${EMBER_SLUG} — production call shape (incumbent)`,
        run: runEmberReceipt,
    },
    clairic: {
        token: "clairic",
        label: "cloudflare/clairic — Extractions API",
        run: runClairicReceipt,
    },
    scaledown: {
        token: "scaledown",
        label: "scaledown/extract — Extractions API (labels only)",
        run: runScaleDownReceipt,
    },
};

const bytesByFixture = new Map<string, Uint8Array>();
for (const fixture of fixtures) {
    bytesByFixture.set(
        fixture.id,
        new Uint8Array(await readFile(join(FIXTURES, fixture.file))),
    );
}

interface ContenderSummary {
    token: string;
    label: string;
    tasksAttempted: number;
    tasksCompleted: number;
    tasksFailed: number;
    recall: number;
    precision: number | null;
    quantityUnitRate: number | null;
    quantityScored: number;
    isFoodRate: number | null;
    isFoodScored: number;
    medianLatencyMs: number | null;
    reportedCostPerReceiptUsd: number | null;
    computedCostPerReceiptUsd: number | null;
    spurious: string[];
    failures: Array<{ fixtureId: string; repeat: number; error: string }>;
    tasks: ReceiptTask[];
}

const summaries: ContenderSummary[] = [];
for (const token of contendersWanted) {
    const contender = CONTENDERS[token];
    if (!contender) {
        console.error(`[receipts] unknown contender token: ${token}`);
        continue;
    }
    const tasks: ReceiptTask[] = [];
    for (const fixture of fixtures) {
        for (let repeat = 1; repeat <= repeats; repeat++) {
            const bytes = bytesByFixture.get(fixture.id)!;
            const startedAt = performance.now();
            try {
                const outcome = await contender.run(bytes);
                tasks.push({
                    fixtureId: fixture.id,
                    repeat,
                    ok: true,
                    failure: null,
                    latencyMs: Math.round(performance.now() - startedAt),
                    reportedCostUsd: outcome.reportedCostUsd,
                    computedCostUsd: outcome.computedCostUsd,
                    lines: outcome.lines,
                    score: scoreReceipt(fixture.lines, outcome.lines),
                });
            } catch (error) {
                tasks.push({
                    fixtureId: fixture.id,
                    repeat,
                    ok: false,
                    failure:
                        error instanceof Error ? error.message : String(error),
                    latencyMs: null,
                    reportedCostUsd: null,
                    computedCostUsd: null,
                    lines: [],
                    score: null,
                });
            }
        }
    }
    const completed = tasks.filter((task) => task.ok && task.score !== null);
    const failed = tasks.filter((task) => !task.ok);
    let expected = 0;
    let matched = 0;
    let returned = 0;
    let quantityScored = 0;
    let quantityUnitCorrect = 0;
    let isFoodScored = 0;
    let isFoodCorrect = 0;
    const spurious: string[] = [];
    for (const task of tasks) {
        const fixture = fixtures.find((entry) => entry.id === task.fixtureId);
        expected += fixture?.lines.length ?? 0;
        if (task.score) {
            matched += task.score.matched;
            returned += task.score.returned;
            quantityScored += task.score.quantityScored;
            quantityUnitCorrect += task.score.quantityUnitCorrect;
            isFoodScored += task.score.isFoodScored;
            isFoodCorrect += task.score.isFoodCorrect;
            for (const name of task.score.spuriousNames) {
                if (!spurious.includes(name)) spurious.push(name);
            }
        }
    }
    const latencies = completed
        .map((task) => task.latencyMs)
        .filter((value): value is number => value !== null);
    const reported = tasks
        .map((task) => task.reportedCostUsd)
        .filter((value): value is number => value !== null);
    const computed = tasks
        .map((task) => task.computedCostUsd)
        .filter((value): value is number => value !== null);
    const summary: ContenderSummary = {
        token,
        label: contender.label,
        tasksAttempted: tasks.length,
        tasksCompleted: completed.length,
        tasksFailed: failed.length,
        recall: expected ? matched / expected : 0,
        precision: returned ? matched / returned : null,
        quantityUnitRate: quantityScored
            ? quantityUnitCorrect / quantityScored
            : null,
        quantityScored,
        isFoodRate: isFoodScored ? isFoodCorrect / isFoodScored : null,
        isFoodScored,
        medianLatencyMs: percentile(latencies, 50),
        reportedCostPerReceiptUsd: reported.length
            ? reported.reduce((sum, value) => sum + value, 0) / tasks.length
            : null,
        computedCostPerReceiptUsd: computed.length
            ? computed.reduce((sum, value) => sum + value, 0) / tasks.length
            : null,
        spurious,
        failures: failed.map((task) => ({
            fixtureId: task.fixtureId,
            repeat: task.repeat,
            error: task.failure ?? "unknown",
        })),
        tasks,
    };
    summaries.push(summary);
    console.info(
        `[receipts] ${token} DONE recall=${summary.recall.toFixed(3)} precision=${summary.precision?.toFixed(3) ?? "n/a"} reported/receipt=$${summary.reportedCostPerReceiptUsd?.toFixed(5) ?? "n/a"} failures=${summary.tasksFailed}/${summary.tasksAttempted}`,
    );
}

const pct = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
    value === null ? "n/a" : `${value.toLocaleString()} ms`;
const usd = (value: number | null) =>
    value === null ? "n/a" : `$${value.toFixed(5)}`;

const totalReportedSpend = summaries.reduce(
    (sum, summary) =>
        sum + (summary.reportedCostPerReceiptUsd ?? 0) * summary.tasksAttempted,
    0,
);

const reportJson = {
    run_at: runStartedAt,
    lane: "receipt-extractions",
    fixtures: fixtures.length,
    expected_lines: fixtures.reduce(
        (sum, fixture) => sum + fixture.lines.length,
        0,
    ),
    repeats,
    clairic_fields: CLAIRIC_RECEIPT_FIELDS,
    total_reported_spend_usd: totalReportedSpend,
    contenders: summaries,
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), JSON.stringify(reportJson, null, 2));

const lines = [
    `# Receipt extraction — extraction models vs the production incumbent`,
    ``,
    `Run: ${runStartedAt} · Fixtures: fixtures/receipt-eval (${fixtures.length} receipts, ${reportJson.expected_lines} hand-labelled lines) · Repeats: ${repeats} · Tasks per contender: ${fixtures.length * repeats} · Total API-reported spend: $${totalReportedSpend.toFixed(4)}`,
    ``,
    `The incumbent runs the production code path (src/inventory/vision.ts previewInventoryImage, mode "receipt", meta/muse-ember, production prompt + strict preview schema). Clairic runs the Extractions API with receipt-shaped parallel typed lists mirroring the preview schema (no list-of-objects type exists; full field specs in report.json).`,
    ``,
    `| Contender | Cost/receipt (reported) | Cost/receipt (computed) | Median latency | Line recall | Line precision | Qty+unit correct | is_food accuracy | Failures |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...summaries.map(
        (summary) =>
            `| ${summary.label} | ${usd(summary.reportedCostPerReceiptUsd)} | ${usd(summary.computedCostPerReceiptUsd)} | ${ms(summary.medianLatencyMs)} | ${pct(summary.recall)} | ${pct(summary.precision)} | ${summary.quantityScored ? `${pct(summary.quantityUnitRate)} (${summary.quantityScored} scored)` : "n/a"} | ${summary.isFoodScored ? `${pct(summary.isFoodRate)} (${summary.isFoodScored} scored)` : "n/a"} | ${summary.tasksFailed}/${summary.tasksAttempted} |`,
    ),
    ``,
    ...summaries.flatMap((summary) => {
        const notes: string[] = [];
        if (summary.spurious.length > 0) {
            notes.push(
                `- ${summary.label}: spurious returned lines (deduped): ${summary.spurious.map((name) => `"${name}"`).join(", ")}.`,
            );
        }
        if (summary.failures.length > 0) {
            notes.push(
                `- ${summary.label}: ${summary.failures.length} failed task(s). First failures: ${summary.failures
                    .slice(0, 3)
                    .map(
                        (failure) =>
                            `${failure.fixtureId} r${failure.repeat}: ${failure.error.slice(0, 200)}`,
                    )
                    .join(" · ")}`,
            );
        }
        return notes;
    }),
    ``,
    `Full per-task detail: report.json.`,
    ``,
];
await writeFile(join(OUT, "report.md"), lines.join("\n"));
console.info(lines.join("\n"));
