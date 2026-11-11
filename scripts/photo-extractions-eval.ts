/**
 * Extraction-model eval for the meal-photo IDENTIFY step (Michael
 * directive, 2026-11-11): benchmark OpenRouter EXTRACTION models
 * (POST /api/alpha/extractions) head-to-head against the chat-model
 * numbers already measured on PR #235, on the SAME real-photo fixture
 * set with the SAME scorer (fixtures/photo-eval-real, 30 photos,
 * expectations in expectations.json).
 *
 * Lane A — Layer-1 identify: each extraction model reads each photo
 * (30 fixtures x repeats) and returns typed fields that assemble into
 * the production MealPhotoVisionItem shape ({name, quantity, unit});
 * scored with the bake-off's scoreIdentify semantics verbatim
 * (scoring.ts namesMatch, greedy one-to-one, portion in range only
 * where units agree).
 *
 * Lane B — full pipeline ("extraction coupled with decision"): the
 * best extraction identifier from Lane A feeds the TRUE production
 * pipeline — groundMealPhotoItems (live USDA + Open Food Facts
 * registry; the local catalog layer needs Postgres and is skipped,
 * same labelled harness difference as photo-full-eval.ts) with the
 * DECIDER seat served by typesafe/jev-1.14 through the proven
 * Decisions-API adapter copied from scripts/photo-full-eval.ts, and
 * the labelled estimate fallback served by meta/muse-ember (extraction
 * models expose no generative estimate path; the estimate role fires
 * only for items grounding leaves unresolved — in production wiring
 * it would remain a chat-model role).
 *
 * FIELD SHAPES (the Extractions API has no list-of-objects type; list
 * items are text/number/date only), so per-item structure is carried
 * by PARALLEL typed lists, zipped positionally:
 *  - cloudflare/clairic (supports every field type):
 *      items:      list<text>   — one concise generic food name per
 *                                 visible item, production identify
 *                                 semantics (cooking method in the name
 *                                 only when part of the food's identity)
 *      quantities: list<number> — estimated amount per item, SAME
 *                                 ORDER as items
 *      units:      list<text>   — unit per quantity, SAME ORDER
 *                                 (g for weighed solids, ml for drinks,
 *                                 cup/tbsp/piece/slice/bar for servings)
 *    Assembly: positional zip; a missing/non-positive quantity entry
 *    defaults to 1 and a missing unit entry to "serving" (both
 *    counted in report.json alignment stats). portion_confidence is
 *    the items list's per-item confidence when the answer carries
 *    one, else 0.5.
 *  - scaledown/extract (field types: text and list<text> ONLY):
 *      items:      list<text>   — names only. Its typing cannot carry
 *                                 per-item quantity/unit, so portions
 *                                 are n/a for this model by design
 *                                 (quantity=1, unit="serving"
 *                                 placeholders; the scorer's portion
 *                                 check requires unit agreement, so
 *                                 nothing is portion-scored).
 * Requests carry NO state text: the single photo goes in the assets
 * map ({photo: {type:"image", format:"jpeg", data_base64}}), which
 * the API reads unreferenced when state is empty/omitted — also the
 * only form ScaleDown accepts (file-only).
 *
 * Cost: the Extractions response carries usage.cost (API-reported,
 * the figure of record) plus token detail; computed cost uses the
 * price table below (input-only pricing: clairic $0.10/1M input,
 * output free; scaledown $0.04-0.05/1M input, output free — computed
 * at the $0.045 midpoint and flagged).
 *
 * Knobs (env): EXTRACT_PHASE (probe|layer1|full|all, default all),
 * EXTRACT_MODELS (default "cloudflare/clairic,scaledown/extract"),
 * EXTRACT_FULL_MODEL (default: best Lane-A model by recall, then
 * precision), EXTRACT_REPEATS (default 2), EXTRACT_CONCURRENCY
 * (default 4), EXTRACT_FIXTURE_IDS, EXTRACT_OUT (default
 * ./extractions-report). Exit 0 when a report was produced — a failing
 * model is data, not a harness failure. Exit 2 when keys are missing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenFoodFactsProvider } from "../src/food-providers/open-food-facts.js";
import { FoodProviderRegistry } from "../src/food-providers/registry.js";
import { UsdaFoodDataCentralProvider } from "../src/food-providers/usda.js";
import { estimateMealPhotoNutrients } from "../src/meal-photo/estimate.js";
import {
    groundMealPhotoItems,
    type GroundedMealPhotoItem,
    type MealPhotoGroundingDeps,
} from "../src/meal-photo/grounding.js";
import { scoreFixture, namesMatch } from "../src/meal-photo/scoring.js";
import {
    mealPhotoVisionConfig,
    type MealPhotoCandidateChoice,
    type MealPhotoCandidateChoiceRequest,
    type MealPhotoVisionConfig,
    type MealPhotoVisionItem,
} from "../src/meal-photo/vision.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const openRouterKey = process.env.OPENROUTER_API_KEY ?? "";
const openRouterAuth = "Bearer " + openRouterKey;
const FIXTURES = join(HERE, "..", "fixtures", "photo-eval-real");
const OUT = process.env.EXTRACT_OUT ?? join(HERE, "..", "extractions-report");
const EXTRACTIONS_URL = "https://openrouter.ai/api/alpha/extractions";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_SLUG = "typesafe/jev-1.14";
const EMBER_SLUG = "meta/muse-ember";
const PROBE_FIXTURE_ID = "mixed-03-full-english-breakfast";

const phase = (process.env.EXTRACT_PHASE ?? "all").trim().toLowerCase();
const models = (
    process.env.EXTRACT_MODELS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []
).filter((value, index, all) => all.indexOf(value) === index);
const modelSlugs = models.length
    ? models
    : ["cloudflare/clairic", "scaledown/extract"];
const repeats = Math.max(
    1,
    Math.min(5, Number(process.env.EXTRACT_REPEATS ?? 2) || 2),
);
const concurrency = Math.max(
    1,
    Math.min(8, Number(process.env.EXTRACT_CONCURRENCY ?? 4) || 4),
);
const fixtureFilter = new Set(
    (process.env.EXTRACT_FIXTURE_IDS?.split(",") ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
);
const runStartedAt = new Date().toISOString();

/** USD per 1M tokens. Extraction models are input-priced with free
 * output; jev-1.14 from its endpoints-API record ($0.042/1M in, $0
 * out); ember from the OpenRouter catalog (photo-full-eval.ts). */
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
    "meta/muse-ember": { input: 0.1, output: 0.5 },
    "cloudflare/clairic": { input: 0.1, output: 0 },
    "scaledown/extract": { input: 0.045, output: 0 },
    "typesafe/jev-1.14": { input: 0.042, output: 0 },
};

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error("[extractions] OPENROUTER_API_KEY is required.");
    process.exit(2);
}
const needsFull = phase === "full" || phase === "all";
if (needsFull && !process.env.USDA_FDC_API_KEY?.trim()) {
    console.error(
        "[extractions] USDA_FDC_API_KEY is required for the full-pipeline lane.",
    );
    process.exit(2);
}

interface ExpectationFixture {
    id: string;
    file: string;
    source: string;
    items: Array<{
        name: string;
        portion: {
            min_quantity: number;
            max_quantity: number;
            unit: string;
        } | null;
        expected_provider: string;
    }>;
}

const expectations = JSON.parse(
    await readFile(join(FIXTURES, "expectations.json"), "utf8"),
) as { fixtures: ExpectationFixture[] };
const fixtures = expectations.fixtures.filter(
    (fixture) => fixtureFilter.size === 0 || fixtureFilter.has(fixture.id),
);
if (fixtures.length === 0) {
    console.error("[extractions] No fixtures selected; nothing to run.");
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

async function runPool<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    async function worker() {
        while (next < tasks.length) {
            const index = next;
            next += 1;
            results[index] = await tasks[index]!();
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
    );
    return results;
}

// ---------------------------------------------------------------------------
// Extractions API client + per-model field shapes.
// ---------------------------------------------------------------------------

interface ExtractionUsage {
    cost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    imageTokens: number | null;
    passes: number | null;
}

interface ExtractionOutcome {
    answers: Record<string, any>;
    usage: ExtractionUsage;
    latencyMs: number;
    provider: string | null;
    responseModel: string | null;
    rawExcerpt: string;
}

const ITEMS_INSTRUCTIONS =
    "List every food and drink visibly present in the meal photo, one entry per distinct item. Use concise generic food names; include the cooking method in the name only when it is part of the food's identity (for example 'fried eggs'). Do not list anything that is not visible. If no food is visible, return an empty list.";
const QUANTITIES_INSTRUCTIONS =
    "For each entry in the items list, in exactly the same order, the estimated amount of that item that will be eaten, as a single number. Count partially eaten food at the amount remaining, not the amount originally served.";
const UNITS_INSTRUCTIONS =
    "For each entry in the items list, in exactly the same order, the unit of the corresponding quantity: use g for weighed solids, ml for drinks, and cup, tbsp, tsp, piece, slice, or bar for countable servings. One unit per item, in the same order as the items list.";

function fieldsFor(model: string): Record<string, unknown> {
    if (model === "cloudflare/clairic") {
        return {
            items: {
                type: "list",
                items: "text",
                instructions: ITEMS_INSTRUCTIONS,
            },
            quantities: {
                type: "list",
                items: "number",
                decimals: 2,
                instructions: QUANTITIES_INSTRUCTIONS,
            },
            units: {
                type: "list",
                items: "text",
                instructions: UNITS_INSTRUCTIONS,
            },
        };
    }
    if (model === "scaledown/extract") {
        return {
            items: {
                type: "list",
                items: "text",
                instructions: ITEMS_INSTRUCTIONS,
            },
        };
    }
    throw new Error(`No extraction field shape defined for model ${model}`);
}

async function callExtractions(
    model: string,
    bytes: Uint8Array,
): Promise<ExtractionOutcome> {
    const startedAt = performance.now();
    const response = await fetch(EXTRACTIONS_URL, {
        method: "POST",
        headers: {
            authorization: openRouterAuth,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model,
            fields: fieldsFor(model),
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
    const latencyMs = Math.round(performance.now() - startedAt);
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
    const usage = payload.usage ?? {};
    return {
        answers: payload.answers,
        usage: {
            cost: typeof usage.cost === "number" ? usage.cost : null,
            inputTokens:
                typeof usage.input_tokens === "number"
                    ? usage.input_tokens
                    : null,
            outputTokens:
                typeof usage.output_tokens === "number"
                    ? usage.output_tokens
                    : null,
            imageTokens:
                typeof usage.image_tokens === "number"
                    ? usage.image_tokens
                    : null,
            passes: typeof usage.passes === "number" ? usage.passes : null,
        },
        latencyMs,
        provider:
            typeof payload.provider === "string" ? payload.provider : null,
        responseModel: typeof payload.model === "string" ? payload.model : null,
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

interface AssembledItems {
    items: MealPhotoVisionItem[];
    alignment: {
        nameCount: number;
        quantityCount: number | null;
        unitCount: number | null;
        quantityDefaulted: number;
        unitDefaulted: number;
    };
}

function assembleItems(
    model: string,
    answers: Record<string, any>,
): AssembledItems {
    const names = stringList(answers.items).filter(
        (name) => name.trim().length > 0,
    );
    const confidences = Array.isArray(answers.items?.confidences)
        ? (answers.items.confidences as Array<unknown>)
        : [];
    const confidenceAt = (index: number): number =>
        typeof confidences[index] === "number"
            ? (confidences[index] as number)
            : 0.5;
    if (model === "cloudflare/clairic") {
        const quantities = numberList(answers.quantities);
        const units = stringList(answers.units);
        let quantityDefaulted = 0;
        let unitDefaulted = 0;
        const items = names.map((name, index) => {
            const quantity = quantities[index];
            const unit = units[index]?.trim();
            if (quantity === null || quantity === undefined || quantity <= 0) {
                quantityDefaulted += 1;
            }
            if (!unit) unitDefaulted += 1;
            return {
                name,
                cooking_method: null,
                quantity:
                    quantity !== null && quantity !== undefined && quantity > 0
                        ? quantity
                        : 1,
                unit: unit ? unit : "serving",
                portion_confidence: confidenceAt(index),
                assumptions: [],
            } satisfies MealPhotoVisionItem;
        });
        return {
            items,
            alignment: {
                nameCount: names.length,
                quantityCount: quantities.length,
                unitCount: units.length,
                quantityDefaulted,
                unitDefaulted,
            },
        };
    }
    // scaledown/extract: names only (typing limit — see header).
    return {
        items: names.map((name, index) => ({
            name,
            cooking_method: null,
            quantity: 1,
            unit: "serving",
            portion_confidence: confidenceAt(index),
            assumptions: [],
        })),
        alignment: {
            nameCount: names.length,
            quantityCount: null,
            unitCount: null,
            quantityDefaulted: 0,
            unitDefaulted: 0,
        },
    };
}

// ---------------------------------------------------------------------------
// Probe + Lane A (Layer-1 identify).
// ---------------------------------------------------------------------------

interface IdentifyScore {
    expected: number;
    returned: number;
    matched: number;
    extras: number;
    portionChecked: number;
    portionInRange: number;
}

/** Verbatim scorer semantics from scripts/photo-model-bakeoff.ts. */
function scoreIdentify(
    expected: ExpectationFixture["items"],
    returned: MealPhotoVisionItem[],
): IdentifyScore {
    const used = new Set<number>();
    let matched = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    for (const item of expected) {
        const index = returned.findIndex(
            (candidate, candidateIndex) =>
                !used.has(candidateIndex) &&
                namesMatch(item.name, candidate.name),
        );
        if (index === -1) continue;
        used.add(index);
        matched += 1;
        const found = returned[index]!;
        if (item.portion && found.unit === item.portion.unit) {
            portionChecked += 1;
            if (
                found.quantity >= item.portion.min_quantity &&
                found.quantity <= item.portion.max_quantity
            ) {
                portionInRange += 1;
            }
        }
    }
    return {
        expected: expected.length,
        returned: returned.length,
        matched,
        extras: returned.length - matched,
        portionChecked,
        portionInRange,
    };
}

interface ProbeResult {
    model: string;
    ok: boolean;
    detail: string;
    latencyMs: number | null;
    reportedCostUsd: number | null;
    items: Array<{ name: string; quantity: number; unit: string }> | null;
    rawExcerpt: string | null;
}

async function probeModel(
    model: string,
    bytesByFixture: Map<string, Uint8Array>,
): Promise<ProbeResult> {
    const bytes = bytesByFixture.get(PROBE_FIXTURE_ID);
    if (!bytes) {
        return {
            model,
            ok: false,
            detail: `probe fixture ${PROBE_FIXTURE_ID} not in the selected set`,
            latencyMs: null,
            reportedCostUsd: null,
            items: null,
            rawExcerpt: null,
        };
    }
    try {
        const outcome = await callExtractions(model, bytes);
        const { items } = assembleItems(model, outcome.answers);
        return {
            model,
            ok: true,
            detail: `extractions request accepted; ${items.length} item(s) assembled from the typed fields`,
            latencyMs: outcome.latencyMs,
            reportedCostUsd: outcome.usage.cost,
            items: items.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
            })),
            rawExcerpt: outcome.rawExcerpt,
        };
    } catch (error) {
        return {
            model,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            latencyMs: null,
            reportedCostUsd: null,
            items: null,
            rawExcerpt: null,
        };
    }
}

interface Layer1Task {
    fixtureId: string;
    repeat: number;
    ok: boolean;
    failure: string | null;
    latencyMs: number | null;
    reportedCostUsd: number | null;
    computedCostUsd: number | null;
    items: Array<{ name: string; quantity: number; unit: string }>;
    alignment: AssembledItems["alignment"] | null;
    score: IdentifyScore | null;
}

async function runLayer1(
    model: string,
    bytesByFixture: Map<string, Uint8Array>,
): Promise<{ tasks: Layer1Task[] }> {
    const price = PRICE_TABLE[model];
    const taskFns: Array<() => Promise<Layer1Task>> = [];
    for (const fixture of fixtures) {
        for (let repeat = 1; repeat <= repeats; repeat++) {
            taskFns.push(async (): Promise<Layer1Task> => {
                const bytes = bytesByFixture.get(fixture.id)!;
                try {
                    const outcome = await callExtractions(model, bytes);
                    const assembled = assembleItems(model, outcome.answers);
                    return {
                        fixtureId: fixture.id,
                        repeat,
                        ok: true,
                        failure: null,
                        latencyMs: outcome.latencyMs,
                        reportedCostUsd: outcome.usage.cost,
                        computedCostUsd:
                            price && outcome.usage.inputTokens !== null
                                ? (outcome.usage.inputTokens / 1_000_000) *
                                  price.input
                                : null,
                        items: assembled.items.map((item) => ({
                            name: item.name,
                            quantity: item.quantity,
                            unit: item.unit,
                        })),
                        alignment: assembled.alignment,
                        score: scoreIdentify(fixture.items, assembled.items),
                    };
                } catch (error) {
                    return {
                        fixtureId: fixture.id,
                        repeat,
                        ok: false,
                        failure:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        latencyMs: null,
                        reportedCostUsd: null,
                        computedCostUsd: null,
                        items: [],
                        alignment: null,
                        score: null,
                    };
                }
            });
        }
    }
    const tasks = await runPool(taskFns, concurrency);
    return { tasks };
}

interface Layer1Summary {
    model: string;
    tasksAttempted: number;
    tasksCompleted: number;
    tasksFailed: number;
    recall: number;
    precision: number | null;
    portionInRangeRate: number | null;
    portionChecked: number;
    portionInRange: number;
    extraItems: number;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
    reportedCostPerTaskUsd: number | null;
    computedCostPerTaskUsd: number | null;
    alignedTasks: number;
    tasksWithAlignment: number;
    quantityDefaulted: number;
    unitDefaulted: number;
    failures: Array<{ fixtureId: string; repeat: number; error: string }>;
}

function summarizeLayer1(model: string, tasks: Layer1Task[]): Layer1Summary {
    const completed = tasks.filter((task) => task.ok && task.score !== null);
    const failed = tasks.filter((task) => !task.ok);
    let expectedItems = 0;
    let matchedItems = 0;
    let returnedItems = 0;
    let extraItems = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    for (const task of tasks) {
        // Headline recall counts failed tasks as zero-recall, exactly
        // like the bake-off report.
        const fixture = fixtures.find((entry) => entry.id === task.fixtureId);
        expectedItems += fixture?.items.length ?? 0;
        if (task.score) {
            matchedItems += task.score.matched;
            returnedItems += task.score.returned;
            extraItems += task.score.extras;
            portionChecked += task.score.portionChecked;
            portionInRange += task.score.portionInRange;
        }
    }
    const latencies = completed
        .map((task) => task.latencyMs)
        .filter((value): value is number => value !== null);
    const reportedCosts = tasks
        .map((task) => task.reportedCostUsd)
        .filter((value): value is number => value !== null);
    const computedCosts = tasks
        .map((task) => task.computedCostUsd)
        .filter((value): value is number => value !== null);
    const withAlignment = completed.filter((task) => task.alignment !== null);
    return {
        model,
        tasksAttempted: tasks.length,
        tasksCompleted: completed.length,
        tasksFailed: failed.length,
        recall: expectedItems ? matchedItems / expectedItems : 0,
        precision: returnedItems ? matchedItems / returnedItems : null,
        portionInRangeRate: portionChecked
            ? portionInRange / portionChecked
            : null,
        portionChecked,
        portionInRange,
        extraItems,
        medianLatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        reportedCostPerTaskUsd: reportedCosts.length
            ? reportedCosts.reduce((sum, value) => sum + value, 0) /
              tasks.length
            : null,
        computedCostPerTaskUsd: computedCosts.length
            ? computedCosts.reduce((sum, value) => sum + value, 0) /
              tasks.length
            : null,
        alignedTasks: withAlignment.filter(
            (task) =>
                task.alignment!.quantityCount === null ||
                (task.alignment!.quantityCount === task.alignment!.nameCount &&
                    task.alignment!.unitCount === task.alignment!.nameCount),
        ).length,
        tasksWithAlignment: withAlignment.length,
        quantityDefaulted: withAlignment.reduce(
            (sum, task) => sum + (task.alignment?.quantityDefaulted ?? 0),
            0,
        ),
        unitDefaulted: withAlignment.reduce(
            (sum, task) => sum + (task.alignment?.unitDefaulted ?? 0),
            0,
        ),
        failures: failed.map((task) => ({
            fixtureId: task.fixtureId,
            repeat: task.repeat,
            error: task.failure ?? "unknown",
        })),
    };
}

// ---------------------------------------------------------------------------
// Lane B machinery: config builder, observing fetcher, Jev decider
// adapter (copied from scripts/photo-full-eval.ts — the proven adapter,
// harness-only, implementing the production chooseCandidates contract
// against POST /api/alpha/decisions).
// ---------------------------------------------------------------------------

type CallRole = "identify" | "decider" | "estimate" | "probe";

interface CallObservation {
    role: CallRole;
    latencyMs: number;
    httpStatus: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    reportedCostUsd: number | null;
    provider: string | null;
    responseModel: string | null;
    transportError: string | null;
    errorExcerpt: string | null;
}

function configFor(model: string): MealPhotoVisionConfig {
    const config = mealPhotoVisionConfig({
        ...process.env,
        MUNCH_AI_MODEL: model,
        MUNCH_MEAL_PHOTO_ENABLED: "true",
        MUNCH_MEAL_PHOTO_TIMEOUT_MS: "60000",
    });
    if (!config) throw new Error("vision config unavailable (missing API key)");
    return config;
}

function observingFetcher(role: CallRole, sink: CallObservation[]) {
    return async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const startedAt = performance.now();
        try {
            const response = await fetch(input, init);
            const observation: CallObservation = {
                role,
                latencyMs: Math.round(performance.now() - startedAt),
                httpStatus: response.status,
                promptTokens: null,
                completionTokens: null,
                reasoningTokens: null,
                reportedCostUsd: null,
                provider: null,
                responseModel: null,
                transportError: null,
                errorExcerpt: null,
            };
            try {
                const payload = (await response.clone().json()) as any;
                const usage = payload?.usage;
                observation.errorExcerpt =
                    typeof payload?.error?.message === "string"
                        ? payload.error.message.slice(0, 300)
                        : null;
                observation.promptTokens =
                    typeof usage?.prompt_tokens === "number"
                        ? usage.prompt_tokens
                        : null;
                observation.completionTokens =
                    typeof usage?.completion_tokens === "number"
                        ? usage.completion_tokens
                        : null;
                observation.reasoningTokens =
                    typeof usage?.completion_tokens_details
                        ?.reasoning_tokens === "number"
                        ? usage.completion_tokens_details.reasoning_tokens
                        : null;
                observation.reportedCostUsd =
                    typeof usage?.cost === "number" ? usage.cost : null;
                observation.provider =
                    typeof payload?.provider === "string"
                        ? payload.provider
                        : null;
                observation.responseModel =
                    typeof payload?.model === "string" ? payload.model : null;
            } catch {
                // Non-JSON response: the observation keeps its nulls.
            }
            sink.push(observation);
            return response;
        } catch (error) {
            sink.push({
                role,
                latencyMs: Math.round(performance.now() - startedAt),
                httpStatus: null,
                promptTokens: null,
                completionTokens: null,
                reasoningTokens: null,
                reportedCostUsd: null,
                provider: null,
                responseModel: null,
                transportError:
                    error instanceof Error ? error.message : String(error),
                errorExcerpt: null,
            });
            throw error;
        }
    };
}

let lastJevDecisionsResponse: string | null = null;

async function chooseCandidatesViaJevDecisions(
    requests: MealPhotoCandidateChoiceRequest[],
    sink: CallObservation[],
): Promise<Map<string, MealPhotoCandidateChoice>> {
    if (requests.length === 0) return new Map();
    const config = configFor(JEV_SLUG);
    const questions: Record<string, unknown> = {};
    requests.forEach((request, index) => {
        const criteria: Record<string, string> = {};
        request.candidates.forEach((candidate, candidateIndex) => {
            criteria[`c${candidateIndex}`] =
                `${candidate.name}${candidate.brand ? ` — brand: ${candidate.brand}` : ""} (source database: ${candidate.provider})`;
        });
        criteria["none"] =
            "No candidate is a defensible match for this photographed item.";
        questions[`q${index}`] = {
            type: "choice",
            instructions:
                `A meal photo was analysed and one photographed food item is "${request.itemName}"${request.cookingMethod ? ` (cooking method: ${request.cookingMethod})` : ""}. ` +
                "Several food-database entries were found for it. Select the single entry that best represents the photographed food. " +
                'Prefer a generic ingredient over a clearly wrong branded or prepared-food match. Select "none" if no entry is a defensible match.',
            criteria,
        };
    });
    const state = {
        task: "Choose the best food-database candidate for each photographed meal item.",
        items: requests.map((request, index) => ({
            question: `q${index}`,
            photographed_item: request.itemName,
            cooking_method: request.cookingMethod,
            candidates: request.candidates.map((candidate, candidateIndex) => ({
                option: `c${candidateIndex}`,
                name: candidate.name,
                brand: candidate.brand,
                source_database: candidate.provider,
            })),
        })),
    };
    const startedAt = performance.now();
    let httpStatus: number | null = null;
    let rawText = "";
    let payload: any = null;
    try {
        const response = await fetch(DECISIONS_URL, {
            method: "POST",
            headers: {
                authorization: openRouterAuth,
                "content-type": "application/json",
            },
            body: JSON.stringify({ model: JEV_SLUG, state, questions }),
            signal: AbortSignal.timeout(60_000),
        });
        httpStatus = response.status;
        rawText = await response.text();
        lastJevDecisionsResponse = rawText.slice(0, 1_200);
        try {
            payload = JSON.parse(rawText);
        } catch {
            payload = null;
        }
    } catch (error) {
        sink.push({
            role: "decider",
            latencyMs: Math.round(performance.now() - startedAt),
            httpStatus: null,
            promptTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            reportedCostUsd: null,
            provider: null,
            responseModel: null,
            transportError:
                error instanceof Error ? error.message : String(error),
            errorExcerpt: null,
        });
        throw error;
    }
    const usage = payload?.usage ?? {};
    sink.push({
        role: "decider",
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus,
        promptTokens:
            typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        completionTokens:
            typeof usage.output_tokens === "number"
                ? usage.output_tokens
                : null,
        reasoningTokens: null,
        reportedCostUsd: typeof usage.cost === "number" ? usage.cost : null,
        provider:
            typeof payload?.provider === "string" ? payload.provider : null,
        responseModel:
            typeof payload?.model === "string" ? payload.model : null,
        transportError: null,
        errorExcerpt:
            httpStatus !== null && httpStatus >= 300
                ? typeof payload?.error?.message === "string"
                    ? payload.error.message
                    : rawText.slice(0, 300)
                : null,
    });
    if (
        httpStatus === null ||
        httpStatus < 200 ||
        httpStatus >= 300 ||
        !payload?.answers
    ) {
        throw new Error(
            `Jev decisions request failed (HTTP ${httpStatus}): ${rawText.slice(0, 300)}`,
        );
    }
    const result = new Map<string, MealPhotoCandidateChoice>();
    requests.forEach((request, index) => {
        const answer = payload.answers[`q${index}`];
        if (
            !answer ||
            answer.type !== "choice" ||
            typeof answer.choice !== "string"
        ) {
            return;
        }
        const confidence =
            typeof answer.confidence === "number"
                ? answer.confidence
                : typeof answer.probabilities?.[answer.choice] === "number"
                  ? answer.probabilities[answer.choice]
                  : 0;
        if (answer.choice === "none") {
            result.set(request.key, {
                candidateId: null,
                confidence,
                rationale: null,
            });
            return;
        }
        const match = /^c(\d+)$/.exec(answer.choice);
        const candidate = match
            ? request.candidates[Number(match[1])]
            : undefined;
        if (!candidate) return;
        result.set(request.key, {
            candidateId: candidate.candidateId,
            confidence,
            rationale: null,
        });
    });
    return result;
}

// ---------------------------------------------------------------------------
// Lane B (full pipeline) — scoring copied from photo-full-eval.ts.
// ---------------------------------------------------------------------------

interface TaskScore {
    expected: number;
    matched: number;
    draftItems: number;
    groundedItems: number;
    portionChecked: number;
    portionInRange: number;
    fabricatedIds: number;
    fabricatedNutrition: number;
    draftCalories: number | null;
}

function scoreTask(
    fixture: ExpectationFixture,
    grounded: GroundedMealPhotoItem[],
    returnedProviderIds: ReadonlySet<string>,
): TaskScore {
    const adaptedExpected = fixture.items.map((item) => ({
        name: item.name,
        portion: item.portion ?? {
            min_quantity: 0,
            max_quantity: 0,
            unit: "__unscored__",
        },
        expected_provider: item.expected_provider,
    }));
    const fixtureScore = scoreFixture({
        fixtureId: fixture.id,
        source: fixture.source,
        expected: adaptedExpected,
        grounded,
        returnedProviderIds,
        referenceCalories: null,
    });
    const used = new Set<number>();
    let matched = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    for (const item of fixture.items) {
        const index = grounded.findIndex(
            (entry, entryIndex) =>
                !used.has(entryIndex) &&
                (namesMatch(item.name, entry.vision.name) ||
                    namesMatch(item.name, entry.draftItem.name)),
        );
        if (index === -1) continue;
        used.add(index);
        matched += 1;
        const entry = grounded[index]!;
        if (item.portion && entry.vision.unit === item.portion.unit) {
            portionChecked += 1;
            if (
                entry.vision.quantity >= item.portion.min_quantity &&
                entry.vision.quantity <= item.portion.max_quantity
            ) {
                portionInRange += 1;
            }
        }
    }
    return {
        expected: fixture.items.length,
        matched,
        draftItems: grounded.length,
        groundedItems: fixtureScore.groundedItems,
        portionChecked,
        portionInRange,
        fabricatedIds: fixtureScore.fabricatedIds,
        fabricatedNutrition: fixtureScore.fabricatedNutrition,
        draftCalories: fixtureScore.predictedCalories,
    };
}

interface FullTask {
    fixtureId: string;
    repeat: number;
    ok: boolean;
    failure: string | null;
    wallMs: number;
    callsByRole: Record<CallRole, number>;
    computedCostUsd: number | null;
    reportedCostUsd: number | null;
    deciderCalls: number;
    deciderSelections: number;
    score: TaskScore | null;
}

async function runFullTask(
    identifyModel: string,
    registry: FoodProviderRegistry,
    fixture: ExpectationFixture,
    repeat: number,
    bytes: Uint8Array,
): Promise<FullTask> {
    const observations: CallObservation[] = [];
    const returnedProviderIds = new Set<string>();
    let deciderCalls = 0;
    let deciderSelections = 0;
    const deps: MealPhotoGroundingDeps = {
        search: async (query: string, limit = 10) => {
            const result = await registry.search({ query, limit });
            for (const candidate of result.candidates) {
                returnedProviderIds.add(candidate.providerFoodId);
            }
            return result;
        },
        chooseCandidates: async (requests) => {
            deciderCalls += 1;
            const choices = await chooseCandidatesViaJevDecisions(
                requests,
                observations,
            );
            deciderSelections += choices.size;
            return choices;
        },
        estimateNutrients: (requests) =>
            estimateMealPhotoNutrients(requests, configFor(EMBER_SLUG), {
                fetcher: observingFetcher("estimate", observations),
            }),
    };
    const startedAt = performance.now();
    let grounded: GroundedMealPhotoItem[] = [];
    let failure: string | null = null;
    try {
        const outcome = await callExtractions(identifyModel, bytes);
        observations.push({
            role: "identify",
            latencyMs: outcome.latencyMs,
            httpStatus: 200,
            promptTokens: outcome.usage.inputTokens,
            completionTokens: outcome.usage.outputTokens,
            reasoningTokens: null,
            reportedCostUsd: outcome.usage.cost,
            provider: outcome.provider,
            responseModel: outcome.responseModel,
            transportError: null,
            errorExcerpt: null,
        });
        const { items } = assembleItems(identifyModel, outcome.answers);
        grounded = await groundMealPhotoItems(items, deps);
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    const wallMs = Math.round(performance.now() - startedAt);
    const callsByRole: Record<CallRole, number> = {
        identify: 0,
        decider: 0,
        estimate: 0,
        probe: 0,
    };
    let computedCostUsd = 0;
    let computedComplete = true;
    let reportedCostUsd: number | null = null;
    for (const observation of observations) {
        callsByRole[observation.role] += 1;
        const modelForRole =
            observation.role === "decider"
                ? JEV_SLUG
                : observation.role === "estimate"
                  ? EMBER_SLUG
                  : identifyModel;
        const price = PRICE_TABLE[modelForRole];
        if (price) {
            computedCostUsd +=
                ((observation.promptTokens ?? 0) / 1_000_000) * price.input +
                ((observation.completionTokens ?? 0) / 1_000_000) *
                    price.output;
        } else if (
            (observation.promptTokens ?? 0) > 0 ||
            (observation.completionTokens ?? 0) > 0
        ) {
            computedComplete = false;
        }
        if (observation.reportedCostUsd !== null) {
            reportedCostUsd =
                (reportedCostUsd ?? 0) + observation.reportedCostUsd;
        }
    }
    return {
        fixtureId: fixture.id,
        repeat,
        ok: failure === null,
        failure,
        wallMs,
        callsByRole,
        computedCostUsd: computedComplete ? computedCostUsd : null,
        reportedCostUsd,
        deciderCalls,
        deciderSelections,
        score:
            failure === null
                ? scoreTask(fixture, grounded, returnedProviderIds)
                : null,
    };
}

interface FullSummary {
    identifyModel: string;
    tasksAttempted: number;
    tasksCompleted: number;
    tasksFailed: number;
    recall: number;
    precision: number | null;
    groundedRate: number | null;
    portionInRangeRate: number | null;
    fabricatedIds: number;
    fabricatedNutrition: number;
    medianWallMs: number | null;
    p95WallMs: number | null;
    reportedCostPerDraftUsd: number | null;
    computedCostPerDraftUsd: number | null;
    deciderCalls: number;
    deciderSelections: number;
    failures: Array<{ fixtureId: string; repeat: number; error: string }>;
}

function summarizeFull(identifyModel: string, tasks: FullTask[]): FullSummary {
    const completed = tasks.filter((task) => task.ok && task.score !== null);
    const failed = tasks.filter((task) => !task.ok);
    let expected = 0;
    let matched = 0;
    let draftItems = 0;
    let groundedItems = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    let fabricatedIds = 0;
    let fabricatedNutrition = 0;
    for (const task of tasks) {
        const fixture = fixtures.find((entry) => entry.id === task.fixtureId);
        expected += fixture?.items.length ?? 0;
        if (task.score) {
            matched += task.score.matched;
            draftItems += task.score.draftItems;
            groundedItems += task.score.groundedItems;
            portionChecked += task.score.portionChecked;
            portionInRange += task.score.portionInRange;
            fabricatedIds += task.score.fabricatedIds;
            fabricatedNutrition += task.score.fabricatedNutrition;
        }
    }
    const walls = completed.map((task) => task.wallMs);
    const reported = tasks
        .map((task) => task.reportedCostUsd)
        .filter((value): value is number => value !== null);
    const computed = tasks
        .map((task) => task.computedCostUsd)
        .filter((value): value is number => value !== null);
    return {
        identifyModel,
        tasksAttempted: tasks.length,
        tasksCompleted: completed.length,
        tasksFailed: failed.length,
        recall: expected ? matched / expected : 0,
        precision: draftItems ? matched / draftItems : null,
        groundedRate: draftItems ? groundedItems / draftItems : null,
        portionInRangeRate: portionChecked
            ? portionInRange / portionChecked
            : null,
        fabricatedIds,
        fabricatedNutrition,
        medianWallMs: percentile(walls, 50),
        p95WallMs: percentile(walls, 95),
        reportedCostPerDraftUsd: reported.length
            ? reported.reduce((sum, value) => sum + value, 0) / tasks.length
            : null,
        computedCostPerDraftUsd: computed.length
            ? computed.reduce((sum, value) => sum + value, 0) / tasks.length
            : null,
        deciderCalls: tasks.reduce((sum, task) => sum + task.deciderCalls, 0),
        deciderSelections: tasks.reduce(
            (sum, task) => sum + task.deciderSelections,
            0,
        ),
        failures: failed.map((task) => ({
            fixtureId: task.fixtureId,
            repeat: task.repeat,
            error: task.failure ?? "unknown",
        })),
    };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const bytesByFixture = new Map<string, Uint8Array>();
for (const fixture of fixtures) {
    bytesByFixture.set(
        fixture.id,
        new Uint8Array(await readFile(join(FIXTURES, fixture.file))),
    );
}
// The probe needs its fixture even when a subset filter is in play.
if (!bytesByFixture.has(PROBE_FIXTURE_ID)) {
    const probeFixture = expectations.fixtures.find(
        (fixture) => fixture.id === PROBE_FIXTURE_ID,
    );
    if (probeFixture) {
        bytesByFixture.set(
            probeFixture.id,
            new Uint8Array(await readFile(join(FIXTURES, probeFixture.file))),
        );
    }
}

const probes: ProbeResult[] = [];
const layer1Summaries: Layer1Summary[] = [];
const layer1TasksByModel: Record<string, Layer1Task[]> = {};
let fullSummary: FullSummary | null = null;
let fullTasks: FullTask[] = [];
let fullModel: string | null = null;

if (phase === "probe" || phase === "all" || phase === "layer1") {
    for (const model of modelSlugs) {
        const probe = await probeModel(model, bytesByFixture);
        probes.push(probe);
        console.info(
            `[extractions] probe ${model}: ${probe.ok ? "OK" : "FAILED"} — ${probe.detail}`,
        );
    }
}

if (phase === "layer1" || phase === "all") {
    for (const model of modelSlugs) {
        const { tasks } = await runLayer1(model, bytesByFixture);
        layer1TasksByModel[model] = tasks;
        const summary = summarizeLayer1(model, tasks);
        layer1Summaries.push(summary);
        console.info(
            `[extractions] layer1 ${model} DONE recall=${summary.recall.toFixed(3)} precision=${summary.precision?.toFixed(3) ?? "n/a"} reported/task=$${summary.reportedCostPerTaskUsd?.toFixed(5) ?? "n/a"} failures=${summary.tasksFailed}/${summary.tasksAttempted}`,
        );
    }
}

if (needsFull) {
    const requested = process.env.EXTRACT_FULL_MODEL?.trim();
    if (requested) {
        fullModel = requested;
    } else if (layer1Summaries.length > 0) {
        const ranked = [...layer1Summaries]
            .filter((summary) => summary.tasksCompleted > 0)
            .sort(
                (a, b) =>
                    b.recall - a.recall ||
                    (b.precision ?? 0) - (a.precision ?? 0),
            );
        fullModel = ranked[0]?.model ?? null;
    }
    if (!fullModel) {
        console.error(
            "[extractions] No viable extraction model for the full-pipeline lane (set EXTRACT_FULL_MODEL or run layer1 first).",
        );
    } else {
        const registry = new FoodProviderRegistry([
            new UsdaFoodDataCentralProvider({ timeoutMs: 10_000 }),
            new OpenFoodFactsProvider({ timeoutMs: 10_000 }),
        ]);
        const taskFns: Array<() => Promise<FullTask>> = [];
        for (const fixture of fixtures) {
            for (let repeat = 1; repeat <= repeats; repeat++) {
                taskFns.push(() =>
                    runFullTask(
                        fullModel!,
                        registry,
                        fixture,
                        repeat,
                        bytesByFixture.get(fixture.id)!,
                    ),
                );
            }
        }
        fullTasks = await runPool(taskFns, concurrency);
        fullSummary = summarizeFull(fullModel, fullTasks);
        console.info(
            `[extractions] full ${fullModel} + jev decider DONE recall=${fullSummary.recall.toFixed(3)} grounded=${fullSummary.groundedRate?.toFixed(3) ?? "n/a"} median=${fullSummary.medianWallMs ?? "n/a"}ms reported/draft=$${fullSummary.reportedCostPerDraftUsd?.toFixed(5) ?? "n/a"} fabrications=${fullSummary.fabricatedIds + fullSummary.fabricatedNutrition}`,
        );
    }
}

const pct = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
    value === null ? "n/a" : `${value.toLocaleString()} ms`;
const usd = (value: number | null) =>
    value === null ? "n/a" : `$${value.toFixed(5)}`;

const totalReportedSpend =
    layer1Summaries.reduce(
        (sum, summary) =>
            sum +
            (summary.reportedCostPerTaskUsd ?? 0) * summary.tasksAttempted,
        0,
    ) +
    probes.reduce((sum, probe) => sum + (probe.reportedCostUsd ?? 0), 0) +
    (fullSummary
        ? (fullSummary.reportedCostPerDraftUsd ?? 0) *
          fullSummary.tasksAttempted
        : 0);

const reportJson = {
    run_at: runStartedAt,
    lane: "extractions",
    phase,
    fixtures: fixtures.length,
    repeats,
    concurrency,
    prices_per_million_tokens: PRICE_TABLE,
    field_shapes: Object.fromEntries(
        modelSlugs.map((model) => {
            try {
                return [model, fieldsFor(model)];
            } catch {
                return [model, null];
            }
        }),
    ),
    probes,
    layer1: layer1Summaries.map((summary) => ({
        ...summary,
        tasks: layer1TasksByModel[summary.model] ?? [],
    })),
    full_pipeline: fullSummary
        ? {
              ...fullSummary,
              decider: JEV_SLUG,
              estimate_fallback: EMBER_SLUG,
              tasks: fullTasks,
          }
        : null,
    total_reported_spend_usd: totalReportedSpend,
    last_jev_decisions_response: lastJevDecisionsResponse,
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), JSON.stringify(reportJson, null, 2));

const lines: string[] = [
    `# Extraction models — meal-photo identify eval`,
    ``,
    `Run: ${runStartedAt} · Fixture set: fixtures/photo-eval-real · Fixtures: ${fixtures.length} · Repeats: ${repeats} · Tasks per model: ${fixtures.length * repeats} · Total API-reported spend: $${totalReportedSpend.toFixed(4)}`,
    ``,
    `Extraction models were called through POST /api/alpha/extractions with the photo in the assets map and NO state text. The API has no list-of-objects field type, so per-item structure is carried by parallel typed lists zipped positionally (full field specs in report.json). Reference rows are the prior PR #235 real-photo runs — different run, same fixtures and scorer.`,
    ``,
    `## Probe (one photo: ${PROBE_FIXTURE_ID})`,
    ``,
    ...probes.flatMap((probe) => [
        `- **${probe.model}**: ${probe.ok ? "OK" : "FAILED"} — ${probe.detail}${probe.ok ? ` · ${ms(probe.latencyMs)} · ${usd(probe.reportedCostUsd)}` : ""}`,
        ...(probe.items
            ? [
                  `  - Items: ${probe.items.map((item) => `${item.name} (${item.quantity} ${item.unit})`).join("; ") || "(none)"}`,
              ]
            : []),
    ]),
    ``,
    `## Layer 1 — identify only`,
    ``,
    `| Model | Cost/task (reported) | Cost/task (computed) | Median | p95 | Recall | Precision | Portion in range | Extra items | Failures |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...[...layer1Summaries]
        .sort((a, b) => b.recall - a.recall)
        .map(
            (summary) =>
                `| ${summary.model} | ${usd(summary.reportedCostPerTaskUsd)} | ${usd(summary.computedCostPerTaskUsd)} | ${ms(summary.medianLatencyMs)} | ${ms(summary.p95LatencyMs)} | ${pct(summary.recall)} | ${pct(summary.precision)} | ${summary.model === "scaledown/extract" ? "n/a (names-only typing)" : `${pct(summary.portionInRangeRate)} (${summary.portionInRange}/${summary.portionChecked})`} | ${summary.extraItems} | ${summary.tasksFailed}/${summary.tasksAttempted} |`,
        ),
    `| meta/muse-ember (reference, PR #235 real-photo Layer 1) | $0.00031 | n/a | ~1,800 ms | n/a | 78.4% | see PR #235 report | n/a | n/a | 0/60 |`,
    `| openai/gpt-5.6-luna (reference, PR #235 real-photo Layer 1) | $0.00048 | n/a | ~2,800 ms | n/a | 83.6% | see PR #235 report | n/a | n/a | n/a |`,
    ``,
    ...layer1Summaries.flatMap((summary) => {
        const notes: string[] = [];
        if (summary.model === "cloudflare/clairic") {
            notes.push(
                `- ${summary.model}: parallel lists aligned by position in ${summary.alignedTasks}/${summary.tasksWithAlignment} completed tasks; ${summary.quantityDefaulted} item(s) needed the quantity default and ${summary.unitDefaulted} the unit default across the run.`,
            );
        }
        if (summary.model === "scaledown/extract") {
            notes.push(
                `- ${summary.model}: names-only by typing (text + list<text> are its only field types) — quantity/unit placeholders (1 / "serving") are never portion-scored; computed cost uses the $0.045/1M midpoint of its $0.04-0.05/1M input range.`,
            );
        }
        if (summary.failures.length > 0) {
            notes.push(
                `- ${summary.model}: ${summary.failures.length} failed task(s). First failures: ${summary.failures
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
];
if (fullSummary) {
    lines.push(
        `## Full pipeline — extraction identify + Jev-1.14 decider`,
        ``,
        `Identify: ${fullSummary.identifyModel} (Extractions API) → grounding (live USDA + OFF) → decider: ${JEV_SLUG} via /api/alpha/decisions → labelled estimate fallback: ${EMBER_SLUG}. Decider selections applied: ${fullSummary.deciderSelections} across ${fullSummary.deciderCalls} decider call(s). Fabricated provider IDs: ${fullSummary.fabricatedIds} · fabricated nutrition: ${fullSummary.fabricatedNutrition}.`,
        ``,
        `| Config | Cost/draft (reported) | Cost/draft (computed) | Median | p95 | Recall | Precision | Grounded | Portions | Failures |`,
        `|---|---|---|---|---|---|---|---|---|---|`,
        `| ${fullSummary.identifyModel} + jev-1.14 decider | ${usd(fullSummary.reportedCostPerDraftUsd)} | ${usd(fullSummary.computedCostPerDraftUsd)} | ${ms(fullSummary.medianWallMs)} | ${ms(fullSummary.p95WallMs)} | ${pct(fullSummary.recall)} | ${pct(fullSummary.precision)} | ${pct(fullSummary.groundedRate)} | ${pct(fullSummary.portionInRangeRate)} | ${fullSummary.tasksFailed}/${fullSummary.tasksAttempted} |`,
        `| meta/muse-ember + jev-1.14 decider (reference, PR #235 full eval) | $0.00034 | n/a | 2,922 ms | n/a | 82.1% | 55.8% | 85.8% | 86.7% | n/a |`,
        ``,
        ...(fullSummary.failures.length > 0
            ? [
                  `Failed tasks: ${fullSummary.failures
                      .slice(0, 3)
                      .map(
                          (failure) =>
                              `${failure.fixtureId} r${failure.repeat}: ${failure.error.slice(0, 200)}`,
                      )
                      .join(" · ")}`,
                  ``,
              ]
            : []),
    );
}
lines.push(`Full per-task detail: report.json.`, ``);
await writeFile(join(OUT, "report.md"), lines.join("\n"));
console.info(lines.join("\n"));
