/**
 * Jev-1.14 front-door probe (Michael directive, 2026-11-11): a
 * MEASUREMENT, not a product build. Three questions, all answered by
 * typesafe/jev-1.14 sampled DIRECTLY via the OpenRouter Decisions API
 * (POST /api/alpha/decisions) with the photo carried as an image_url
 * part in the top-level `state` array — the multimodal shape
 * OpenRouter's Multimodal Decisions doc specifies — plus the
 * `TypeSafe-Danger-Zone-Images: true` header TypeSafe's docs require
 * for image requests.
 *
 *  1. FRONT-DOOR GATE: one Jev request per photo carrying three
 *     questions — (a) Noul: the photo shows food or drink someone
 *     would log as a meal; (b) Choice: plated meal / drink / packaged
 *     product / receipt / something else; (c) Noul: the photo is
 *     clear enough to identify what is in it. Positive set: the 30
 *     real food photos of fixtures/photo-eval-real. Negative set:
 *     the 12 non-food photos of fixtures/photo-eval-negative (openly
 *     licensed, per-photo provenance + labels in its manifest.json;
 *     borderline fixtures are labelled and excluded from the
 *     headline rates, then reported individually).
 *  2. RECEIPT ROUTING: how the route Choice handles the receipt
 *     fixture specifically (a slice of the gate data, reported
 *     separately).
 *  3. VERIFICATION PASS: Ember identifies each positive photo's
 *     items (production identifyMealPhoto, one run per photo); Jev
 *     then answers, per identified item, a Noul "is <item> visibly
 *     in this photo?" (batched at most 8 questions per request, the
 *     image resent per request), plus one Noul per photo asking
 *     whether the photo shows food or drink NOT in Ember's list.
 *     Ember's precision/recall (namesMatch matcher, identify level)
 *     are rescored after dropping items below each threshold.
 *
 * Raw answers (including probabilities) are kept for every call in
 * results.json. Costs are the API-reported usage.cost figures;
 * latencies are client-observed wall times per call. Jev image
 * dimensions are verified at run time against the 280-1568 px/side
 * acceptance range and recorded (the negative set was normalized
 * into range at build time; the positive set already sits inside it
 * as committed — no runtime transform is applied to any photo).
 *
 * Knobs (env): JEVPROBE_OUT (default ./jevprobe-report),
 * JEVPROBE_CONCURRENCY (default 4). Exit 0 when a report was
 * produced — a failed call is data, not a harness failure. Exit 2
 * when OPENROUTER_API_KEY is not configured.
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
const NEG_DIR = join(ROOT, "fixtures", "photo-eval-negative");
const OUT = process.env.JEVPROBE_OUT ?? join(ROOT, "jevprobe-report");
const CONCURRENCY = Math.max(
    1,
    Math.min(8, Number(process.env.JEVPROBE_CONCURRENCY ?? 4) || 4),
);
const JEV_SLUG = "typesafe/jev-1.14";
const EMBER_SLUG = "meta/muse-ember";
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const EMBER_PRICE = { input: 0.1, output: 0.5 }; // USD per 1M tokens

if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error(
        "[jevprobe] OPENROUTER_API_KEY is required; the probe cannot run.",
    );
    process.exit(2);
}
const API_KEY = process.env.OPENROUTER_API_KEY.trim();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PosFixture {
    id: string;
    file: string;
    items: Array<{ name: string }>;
}
interface NegFixture {
    id: string;
    file: string;
    category: string;
    saved_size_px: [number, number];
    expected: {
        gate_food: boolean;
        borderline: boolean;
        expected_route: string;
        rationale: string;
    };
}

const posExpectations = JSON.parse(
    await readFile(join(POS_DIR, "expectations.json"), "utf8"),
) as { fixtures: PosFixture[] };
const negManifest = JSON.parse(
    await readFile(join(NEG_DIR, "manifest.json"), "utf8"),
) as { fixtures: NegFixture[] };

/** Route ground truth for the positive set, derived from the fixture
 * id family (documented harness convention): drinks-* are beverages,
 * packaged-* are retail-packaged products, everything else is a
 * plated/served meal (single food items use the nearest option). */
function positiveRoute(id: string): string {
    if (id.startsWith("drinks-")) return "drink";
    if (id.startsWith("packaged-")) return "packaged_product";
    return "plated_meal";
}

/** Minimal JPEG SOF parser: returns {width, height} from the first
 * Start-Of-Frame marker, or null when unparseable. */
function jpegDimensions(bytes: Uint8Array): {
    width: number;
    height: number;
} | null {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        if (marker === 0xda) return null; // SOS: no SOF before scan data
        const length =
            ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
        if (length < 2) return null;
        if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
        ) {
            const height =
                ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
            const width =
                ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
            return { width, height };
        }
        offset += 2 + length;
    }
    return null;
}

function dimsInRange(dims: { width: number; height: number } | null): boolean {
    return (
        dims !== null &&
        dims.width >= 280 &&
        dims.width <= 1568 &&
        dims.height >= 280 &&
        dims.height <= 1568
    );
}

// ---------------------------------------------------------------------------
// Decisions API client (metered)
// ---------------------------------------------------------------------------

interface JevCall {
    latencyMs: number;
    httpStatus: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reportedCostUsd: number | null;
    servedModel: string | null;
    provider: string | null;
    transportError: string | null;
    errorExcerpt: string | null;
    /** Raw `answers` object exactly as returned (null on failure). */
    answers: Record<string, any> | null;
    /** Raw response excerpt for the format-discovery attempts. */
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
            inputTokens: null,
            outputTokens: null,
            reportedCostUsd: null,
            servedModel: null,
            provider: null,
            transportError:
                error instanceof Error ? error.message : String(error),
            errorExcerpt: null,
            answers: null,
            rawExcerpt: null,
        };
    }
    const usage = payload?.usage ?? {};
    return {
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus,
        inputTokens:
            typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        outputTokens:
            typeof usage.output_tokens === "number"
                ? usage.output_tokens
                : null,
        reportedCostUsd: typeof usage.cost === "number" ? usage.cost : null,
        servedModel: typeof payload?.model === "string" ? payload.model : null,
        provider: typeof payload?.provider === "string" ? payload.provider : null,
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

/** Probability-of-yes extraction for a Noul answer. The live shape
 * (observed in the probe's first run and kept raw in results.json)
 * is {"type":"noul","noul":<probability>}; the remaining cascade
 * covers the other documented fields (probability /
 * probabilities{true,yes} / boolean value+confidence) defensively.
 * Returns null when nothing parseable is present. */
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

function imageState(
    bytes: Uint8Array,
    text: string,
): Array<Record<string, unknown> | string> {
    return [
        {
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
            },
        },
        text,
    ];
}

// ---------------------------------------------------------------------------
// Gate questions — two request styles for format discovery. "plain"
// sends Noul as {type, instructions}; "described" additionally gives
// Noul a criteria map (the choice question carries criteria in both —
// that shape is proven by the production decider adapter in
// scripts/photo-full-eval.ts).
// ---------------------------------------------------------------------------

type QuestionStyle = "plain" | "described";

function gateQuestions(style: QuestionStyle): Record<string, unknown> {
    const food: Record<string, unknown> = {
        type: "noul",
        instructions:
            "Does this photo show food or drink that someone would log as a meal in a nutrition-tracking app? Consider only what is visibly present in the photo itself.",
    };
    const clear: Record<string, unknown> = {
        type: "noul",
        instructions:
            "Is this photo clear and well-lit enough that a person could identify what food or drink it shows?",
    };
    if (style === "described") {
        food.criteria = {
            true: "Actual food or drink items are visibly present as the subject of the photo.",
            false: "No actual food or drink items are visibly present as the subject of the photo.",
        };
        clear.criteria = {
            true: "The photo is sharp and lit well enough to identify its contents.",
            false: "The photo is too blurry, dark, or obscured to identify its contents.",
        };
    }
    return {
        food,
        route: {
            type: "choice",
            instructions:
                "Which one of these best describes what this photo shows?",
            criteria: {
                plated_meal:
                    "A prepared meal or dish, served and ready to eat (on a plate, in a bowl, or as presented food items, including a single food item photographed as the subject).",
                drink: "A served beverage as the main subject (a glass, cup, or mug of a drink).",
                packaged_product:
                    "A retail-packaged food or drink product as the main subject (a sealed can, bottle, box, or wrapper, shown as a product).",
                receipt:
                    "A receipt or bill, on paper or on a screen, listing purchased items or a payment transaction.",
                other: "Something else — none of the other descriptions fit this photo.",
            },
        },
        clear,
    };
}

const ROUTE_OPTIONS = [
    "plated_meal",
    "drink",
    "packaged_product",
    "receipt",
    "other",
];

interface GateAttempt {
    style: QuestionStyle;
    httpStatus: number | null;
    transportError: string | null;
    errorExcerpt: string | null;
    parsed: boolean;
    parseDetail: string;
    rawExcerpt: string | null;
}

interface GateResult {
    fixtureId: string;
    set: "positive" | "negative";
    dims: { width: number; height: number } | null;
    dimsInRange: boolean;
    call: Omit<JevCall, "answers" | "rawExcerpt">;
    pFood: number | null;
    pClear: number | null;
    routeChoice: string | null;
    routeConfidence: number | null;
    routeProbabilities: Record<string, number> | null;
    rawAnswers: Record<string, any> | null;
}

function parseGateAnswers(call: JevCall): {
    ok: boolean;
    detail: string;
    pFood: number | null;
    pClear: number | null;
    routeChoice: string | null;
    routeConfidence: number | null;
    routeProbabilities: Record<string, number> | null;
} {
    const fail = (detail: string) => ({
        ok: false,
        detail,
        pFood: null,
        pClear: null,
        routeChoice: null,
        routeConfidence: null,
        routeProbabilities: null,
    });
    if (!call.answers) {
        return fail(
            `no answers object (http=${call.httpStatus}${call.errorExcerpt ? `, error=${call.errorExcerpt}` : ""}${call.transportError ? `, transport=${call.transportError}` : ""})`,
        );
    }
    const pFood = noulProbability(call.answers.food);
    const pClear = noulProbability(call.answers.clear);
    const route = call.answers.route;
    if (pFood === null || pClear === null) {
        return fail(
            `noul answers not parseable (food=${JSON.stringify(call.answers.food)?.slice(0, 160)}, clear=${JSON.stringify(call.answers.clear)?.slice(0, 160)})`,
        );
    }
    if (
        !route ||
        route.type !== "choice" ||
        typeof route.choice !== "string" ||
        !ROUTE_OPTIONS.includes(route.choice)
    ) {
        return fail(
            `route answer not a valid choice (${JSON.stringify(route)?.slice(0, 160)})`,
        );
    }
    const routeProbabilities =
        route.probabilities && typeof route.probabilities === "object"
            ? (route.probabilities as Record<string, number>)
            : null;
    const routeConfidence =
        typeof route.confidence === "number"
            ? route.confidence
            : routeProbabilities && typeof routeProbabilities[route.choice] === "number"
              ? routeProbabilities[route.choice]
              : null;
    return {
        ok: true,
        detail: "answers parsed",
        pFood,
        pClear,
        routeChoice: route.choice,
        routeConfidence,
        routeProbabilities,
    };
}

// ---------------------------------------------------------------------------
// Pool + percentiles
// ---------------------------------------------------------------------------

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
function median(values: number[]): number | null {
    return percentile(values, 50);
}
function fmt(value: number | null, digits = 3): string {
    return value === null ? "n/a" : value.toFixed(digits);
}
function pct(part: number, whole: number): string {
    return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Phase 0: format discovery on the first positive fixture
// ---------------------------------------------------------------------------

const allFixtures: Array<{
    id: string;
    set: "positive" | "negative";
    path: string;
}> = [
    ...posExpectations.fixtures.map((fixture) => ({
        id: fixture.id,
        set: "positive" as const,
        path: join(POS_DIR, fixture.file),
    })),
    ...negManifest.fixtures.map((fixture) => ({
        id: fixture.id,
        set: "negative" as const,
        path: join(NEG_DIR, fixture.file),
    })),
];
const bytesById = new Map<string, Uint8Array>();
for (const fixture of allFixtures) {
    bytesById.set(
        fixture.id,
        new Uint8Array(await readFile(fixture.path)),
    );
}

const gateAttempts: GateAttempt[] = [];
let gateStyle: QuestionStyle | null = null;
{
    const probeFixture = allFixtures[0]!;
    const probeBytes = bytesById.get(probeFixture.id)!;
    for (const style of ["plain", "described"] as QuestionStyle[]) {
        const call = await jevDecisions({
            state: imageState(
                probeBytes,
                "A user uploaded this photo to a meal-logging app.",
            ),
            questions: gateQuestions(style),
        });
        const parsed = parseGateAnswers(call);
        gateAttempts.push({
            style,
            httpStatus: call.httpStatus,
            transportError: call.transportError,
            errorExcerpt: call.errorExcerpt,
            parsed: parsed.ok,
            parseDetail: parsed.detail,
            rawExcerpt: call.rawExcerpt,
        });
        console.info(
            `[jevprobe] format attempt style=${style}: http=${call.httpStatus} parsed=${parsed.ok} — ${parsed.detail}`,
        );
        if (parsed.ok) {
            gateStyle = style;
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 1: the gate over all 42 photos
// ---------------------------------------------------------------------------

const gateResults: GateResult[] = [];
if (gateStyle !== null) {
    const style = gateStyle;
    const results = await runPool(
        allFixtures.map((fixture) => async (): Promise<GateResult> => {
            const bytes = bytesById.get(fixture.id)!;
            const dims = jpegDimensions(bytes);
            const call = await jevDecisions({
                state: imageState(
                    bytes,
                    "A user uploaded this photo to a meal-logging app.",
                ),
                questions: gateQuestions(style),
            });
            const parsed = parseGateAnswers(call);
            const { answers, rawExcerpt: _rawExcerpt, ...callMeta } = call;
            return {
                fixtureId: fixture.id,
                set: fixture.set,
                dims,
                dimsInRange: dimsInRange(dims),
                call: callMeta,
                pFood: parsed.ok ? parsed.pFood : null,
                pClear: parsed.ok ? parsed.pClear : null,
                routeChoice: parsed.ok ? parsed.routeChoice : null,
                routeConfidence: parsed.ok ? parsed.routeConfidence : null,
                routeProbabilities: parsed.ok
                    ? parsed.routeProbabilities
                    : null,
                rawAnswers: answers,
            };
        }),
        CONCURRENCY,
    );
    gateResults.push(...results);
    const ok = results.filter((result) => result.pFood !== null).length;
    console.info(
        `[jevprobe] gate: ${ok}/${results.length} calls parsed; total reported cost $${results.reduce((sum, r) => sum + (r.call.reportedCostUsd ?? 0), 0).toFixed(5)}`,
    );
}

// ---------------------------------------------------------------------------
// Phase 3: verification pass (Ember identify + Jev per-item Nouls)
// ---------------------------------------------------------------------------

interface EmberObservation {
    latencyMs: number;
    httpStatus: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    reportedCostUsd: number | null;
}

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

interface VerifyItem {
    name: string;
    pPresent: number | null;
    rawAnswer: any;
}
interface VerifyPhoto {
    fixtureId: string;
    ember: {
        items: string[];
        observation: EmberObservation | null;
        noFood: boolean;
        failure: string | null;
    };
    expectedCount: number;
    /** Indices into ember.items matched to an expected item (greedy). */
    matchedEmberIndices: number[];
    missedExpected: string[];
    items: VerifyItem[];
    pMissing: number | null;
    missingRawAnswer: any;
    jevCalls: Array<Omit<JevCall, "answers" | "rawExcerpt">>;
}

const verifyPhotos: VerifyPhoto[] = [];
if (gateStyle !== null) {
    const config = emberConfig();
    const results = await runPool(
        posExpectations.fixtures.map((fixture) => async (): Promise<VerifyPhoto> => {
            const bytes = bytesById.get(fixture.id)!;
            const observations: EmberObservation[] = [];
            const fetcher = async (
                input: RequestInfo | URL,
                init?: RequestInit,
            ): Promise<Response> => {
                const startedAt = performance.now();
                const response = await fetch(input, init);
                const observation: EmberObservation = {
                    latencyMs: Math.round(performance.now() - startedAt),
                    httpStatus: response.status,
                    promptTokens: null,
                    completionTokens: null,
                    reportedCostUsd: null,
                };
                try {
                    const payload = (await response.clone().json()) as any;
                    observation.promptTokens =
                        typeof payload?.usage?.prompt_tokens === "number"
                            ? payload.usage.prompt_tokens
                            : null;
                    observation.completionTokens =
                        typeof payload?.usage?.completion_tokens === "number"
                            ? payload.usage.completion_tokens
                            : null;
                    observation.reportedCostUsd =
                        typeof payload?.usage?.cost === "number"
                            ? payload.usage.cost
                            : null;
                } catch {
                    // Non-JSON body: usage stays null.
                }
                observations.push(observation);
                return response;
            };
            let visionItems: MealPhotoVisionItem[] = [];
            let noFood = false;
            let failure: string | null = null;
            try {
                const vision = await identifyMealPhoto(
                    { mimeType: "image/jpeg", bytes },
                    config,
                    { fetcher },
                );
                visionItems = vision.items;
            } catch (error) {
                if (error instanceof MealPhotoNoFoodError) {
                    noFood = true;
                    visionItems = [];
                } else {
                    failure =
                        error instanceof Error ? error.message : String(error);
                }
            }
            const names = visionItems.map((item) => item.name);
            // Greedy one-to-one matching, fulleval scoreTask semantics
            // at the identify level (vision names only).
            const used = new Set<number>();
            const matchedEmberIndices: number[] = [];
            const missedExpected: string[] = [];
            for (const expected of fixture.items) {
                const index = names.findIndex(
                    (name, nameIndex) =>
                        !used.has(nameIndex) && namesMatch(expected.name, name),
                );
                if (index === -1) {
                    missedExpected.push(expected.name);
                } else {
                    used.add(index);
                    matchedEmberIndices.push(index);
                }
            }
            // Jev verification: batches of at most 8 questions per
            // request (item Nouls first, the anything-missing Noul
            // appended to the final batch when it fits, else its own
            // request). The image is resent with every request.
            const items: VerifyItem[] = names.map((name) => ({
                name,
                pPresent: null,
                rawAnswer: null,
            }));
            let pMissing: number | null = null;
            let missingRawAnswer: any = null;
            const jevCalls: VerifyPhoto["jevCalls"] = [];
            const questionBatches: Array<{
                questions: Record<string, unknown>;
                itemIndices: number[];
                hasMissing: boolean;
            }> = [];
            const MAX_Q = 8;
            if (names.length === 0) {
                questionBatches.push({
                    questions: {},
                    itemIndices: [],
                    hasMissing: true,
                });
            } else {
                for (let start = 0; start < names.length; start += MAX_Q - 1) {
                    const slice = names.slice(start, start + (MAX_Q - 1));
                    const isLast = start + (MAX_Q - 1) >= names.length;
                    questionBatches.push({
                        questions: {},
                        itemIndices: slice.map((_, i) => start + i),
                        hasMissing: isLast,
                    });
                }
            }
            for (const batch of questionBatches) {
                const questions: Record<string, unknown> = {};
                batch.itemIndices.forEach((itemIndex, position) => {
                    const q: Record<string, unknown> = {
                        type: "noul",
                        instructions: `A meal-photo analysis identified an item named "${names[itemIndex]}" in this photo. Is an item matching "${names[itemIndex]}" actually visibly present in this photo?`,
                    };
                    if (gateStyle === "described") {
                        q.criteria = {
                            true: `An item matching "${names[itemIndex]}" is visibly present in the photo.`,
                            false: `No item matching "${names[itemIndex]}" is visibly present in the photo.`,
                        };
                    }
                    questions[`item_${position}`] = q;
                });
                if (batch.hasMissing) {
                    const q: Record<string, unknown> = {
                        type: "noul",
                        instructions:
                            "The state lists the food and drink items already identified in this photo. Does the photo visibly show any food or drink item that is NOT in that list?",
                    };
                    if (gateStyle === "described") {
                        q.criteria = {
                            true: "The photo visibly shows at least one food or drink item that is not in the list.",
                            false: "Every food or drink item visible in the photo is in the list.",
                        };
                    }
                    questions["missing"] = q;
                }
                const listText =
                    names.length > 0
                        ? `Items already identified in this photo: ${names.join("; ")}.`
                        : "No items were identified in this photo.";
                const call = await jevDecisions({
                    state: imageState(bytes, listText),
                    questions,
                });
                const { answers, rawExcerpt: _rawExcerpt, ...callMeta } =
                    call;
                jevCalls.push(callMeta);
                if (answers) {
                    batch.itemIndices.forEach((itemIndex, position) => {
                        const answer = answers[`item_${position}`];
                        items[itemIndex] = {
                            name: names[itemIndex]!,
                            pPresent: noulProbability(answer),
                            rawAnswer: answer ?? null,
                        };
                    });
                    if (batch.hasMissing) {
                        missingRawAnswer = answers["missing"] ?? null;
                        pMissing = noulProbability(answers["missing"]);
                    }
                }
            }
            return {
                fixtureId: fixture.id,
                ember: {
                    items: names,
                    observation: observations[0] ?? null,
                    noFood,
                    failure,
                },
                expectedCount: fixture.items.length,
                matchedEmberIndices,
                missedExpected,
                items,
                pMissing,
                missingRawAnswer,
                jevCalls,
            };
        }),
        CONCURRENCY,
    );
    verifyPhotos.push(...results);
    const jevCost = results.reduce(
        (sum, photo) =>
            sum +
            photo.jevCalls.reduce(
                (inner, call) => inner + (call.reportedCostUsd ?? 0),
                0,
            ),
        0,
    );
    console.info(
        `[jevprobe] verification: ${results.length} photos; Jev verification reported cost $${jevCost.toFixed(5)}`,
    );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const GATE_THRESHOLDS = [0.5, 0.3, 0.1, 0.05];
const VERIFY_THRESHOLDS = [0.3, 0.5, 0.7];

const negById = new Map(negManifest.fixtures.map((f) => [f.id, f]));
const gatePos = gateResults.filter((r) => r.set === "positive");
const gateNeg = gateResults.filter((r) => r.set === "negative");
const gateNegHeadline = gateNeg.filter((r) => {
    const fixture = negById.get(r.fixtureId);
    return fixture && !fixture.expected.gate_food && !fixture.expected.borderline;
});
const gateNegBorderline = gateNeg.filter(
    (r) => negById.get(r.fixtureId)?.expected.borderline,
);

function falseRejects(results: GateResult[], threshold: number): number {
    return results.filter(
        (r) => r.pFood !== null && r.pFood < threshold,
    ).length;
}
function correctRejects(results: GateResult[], threshold: number): number {
    return results.filter(
        (r) => r.pFood !== null && r.pFood < threshold,
    ).length;
}

const routeConfusion = new Map<string, number>();
let routeCorrectPos = 0;
let routeScoredPos = 0;
for (const result of gatePos) {
    if (result.routeChoice === null) continue;
    routeScoredPos += 1;
    const expected = positiveRoute(result.fixtureId);
    if (result.routeChoice === expected) routeCorrectPos += 1;
    const key = `${expected} -> ${result.routeChoice}`;
    routeConfusion.set(key, (routeConfusion.get(key) ?? 0) + 1);
}
let routeCorrectNeg = 0;
let routeScoredNeg = 0;
for (const result of gateNeg) {
    if (result.routeChoice === null) continue;
    routeScoredNeg += 1;
    if (result.routeChoice === negById.get(result.fixtureId)?.expected.expected_route) {
        routeCorrectNeg += 1;
    }
}
const receiptResult = gateNeg.find((r) => r.fixtureId === "neg-01-receipt");

// Verification aggregates (identify level, micro-averaged).
const verifyTotals = {
    expected: 0,
    predicted: 0,
    matched: 0,
};
for (const photo of verifyPhotos) {
    verifyTotals.expected += photo.expectedCount;
    verifyTotals.predicted += photo.ember.items.length;
    verifyTotals.matched += photo.matchedEmberIndices.length;
}
interface VerifyThresholdRow {
    threshold: number;
    kept: number;
    matchedKept: number;
    precision: number | null;
    recall: number | null;
    itemsWithProbability: number;
}
const verifyRows: VerifyThresholdRow[] = VERIFY_THRESHOLDS.map((threshold) => {
    let kept = 0;
    let matchedKept = 0;
    let itemsWithProbability = 0;
    for (const photo of verifyPhotos) {
        photo.items.forEach((item, index) => {
            if (item.pPresent !== null) itemsWithProbability += 1;
            if (item.pPresent !== null && item.pPresent >= threshold) {
                kept += 1;
                if (photo.matchedEmberIndices.includes(index)) {
                    matchedKept += 1;
                }
            }
        });
    }
    return {
        threshold,
        kept,
        matchedKept,
        precision: kept > 0 ? matchedKept / kept : null,
        recall:
            verifyTotals.expected > 0
                ? matchedKept / verifyTotals.expected
                : null,
        itemsWithProbability,
    };
});
const missingPhotos = verifyPhotos.filter((p) => p.missedExpected.length > 0);
const noMissingPhotos = verifyPhotos.filter(
    (p) => p.missedExpected.length === 0,
);
const missingFlagged = missingPhotos.filter(
    (p) => p.pMissing !== null && p.pMissing >= 0.5,
).length;
const missingFlaggedFalse = noMissingPhotos.filter(
    (p) => p.pMissing !== null && p.pMissing >= 0.5,
).length;

// Cost + latency totals
const gateLatencies = gateResults.map((r) => r.call.latencyMs);
const gateCost = gateResults.reduce(
    (sum, r) => sum + (r.call.reportedCostUsd ?? 0),
    0,
);
const verifyJevLatencies = verifyPhotos.flatMap((p) =>
    p.jevCalls.map((c) => c.latencyMs),
);
const verifyJevCost = verifyPhotos.reduce(
    (sum, p) =>
        sum + p.jevCalls.reduce((s, c) => s + (c.reportedCostUsd ?? 0), 0),
    0,
);
const verifyJevPerPhoto = verifyPhotos.map((p) => ({
    fixtureId: p.fixtureId,
    addedLatencyMs: p.jevCalls.reduce((s, c) => s + c.latencyMs, 0),
    addedCostUsd: p.jevCalls.reduce(
        (s, c) => s + (c.reportedCostUsd ?? 0),
        0,
    ),
    requests: p.jevCalls.length,
}));
const emberObservations = verifyPhotos
    .map((p) => p.ember.observation)
    .filter((o): o is EmberObservation => o !== null);
const emberComputedCost = emberObservations.reduce(
    (sum, o) =>
        sum +
        ((o.promptTokens ?? 0) / 1_000_000) * EMBER_PRICE.input +
        ((o.completionTokens ?? 0) / 1_000_000) * EMBER_PRICE.output,
    0,
);
const emberReportedCost = emberObservations.reduce(
    (sum, o) => sum + (o.reportedCostUsd ?? 0),
    0,
);
const totalSpend = gateCost + verifyJevCost + emberReportedCost;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const lines: string[] = [];
lines.push("# Jev-1.14 front-door probe — results");
lines.push("");
lines.push(
    `Model under test: \`${JEV_SLUG}\` via POST https://openrouter.ai/api/alpha/decisions (image as an \`image_url\` part in the top-level \`state\` array; \`TypeSafe-Danger-Zone-Images: true\` header sent). Measurement only — no product code touched. Raw answers with probabilities: \`results.json\`.`,
);
lines.push("");
lines.push("## Format discovery");
lines.push("");
if (gateAttempts.length === 0) {
    lines.push("No attempts recorded.");
} else {
    lines.push("| Style | HTTP | Parsed | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const attempt of gateAttempts) {
        lines.push(
            `| ${attempt.style} | ${attempt.httpStatus ?? "transport error"} | ${attempt.parsed ? "yes" : "no"} | ${attempt.parseDetail.replace(/\|/g, "/")} |`,
        );
    }
    lines.push("");
    lines.push(
        gateStyle !== null
            ? `Winning style: **${gateStyle}** (used for every call below).`
            : "**No style parsed — the probe stopped here. Verbatim excerpts:**",
    );
    if (gateStyle === null) {
        for (const attempt of gateAttempts) {
            lines.push("");
            lines.push(
                `Style \`${attempt.style}\` error: ${attempt.errorExcerpt ?? attempt.transportError ?? "(none)"}`,
            );
            lines.push("```");
            lines.push(attempt.rawExcerpt ?? "(no body)");
            lines.push("```");
        }
    }
}

if (gateStyle !== null) {
    lines.push("");
    lines.push("## 1. Front-door gate");
    lines.push("");
    lines.push(
        `Calls: ${gateResults.length} (${gatePos.length} positive, ${gateNeg.length} negative); parsed ${gateResults.filter((r) => r.pFood !== null).length}/${gateResults.length}. All photos verified inside the 280–1568 px/side range: ${gateResults.every((r) => r.dimsInRange) ? "yes" : "NO — see results.json"}. Per-call latency: median ${fmt(median(gateLatencies), 0)} ms, p95 ${fmt(percentile(gateLatencies, 95), 0)} ms. Reported cost: $${gateCost.toFixed(5)} total ($${gateResults.length ? (gateCost / gateResults.length).toFixed(5) : "0"}/call).`,
    );
    lines.push("");
    lines.push("### Gate food probability — threshold table");
    lines.push("");
    lines.push(
        "Reject = p(food) strictly below the threshold. Positive false-rejects are the dangerous direction (a real meal turned away); the conservative operating point Jeff specified is 0.10.",
    );
    lines.push("");
    lines.push(
        `| Threshold | Positives falsely rejected (of ${gatePos.filter((r) => r.pFood !== null).length} scored) | Headline negatives correctly rejected (of ${gateNegHeadline.length}) |`,
    );
    lines.push("| --- | --- | --- |");
    for (const threshold of GATE_THRESHOLDS) {
        lines.push(
            `| ${threshold.toFixed(2)} | ${falseRejects(gatePos, threshold)} (${pct(falseRejects(gatePos, threshold), gatePos.filter((r) => r.pFood !== null).length)}) | ${correctRejects(gateNegHeadline, threshold)} (${pct(correctRejects(gateNegHeadline, threshold), gateNegHeadline.length)}) |`,
        );
    }
    lines.push("");
    lines.push("### Route choice accuracy");
    lines.push("");
    lines.push(
        `Positives (ground truth from fixture family: drinks→drink, packaged→packaged product, else plated meal): **${routeCorrectPos}/${routeScoredPos}** correct. Negatives (manifest labels): **${routeCorrectNeg}/${routeScoredNeg}** correct.`,
    );
    lines.push("");
    lines.push("Positive-set confusion (expected -> chosen):");
    lines.push("");
    for (const [key, count] of [...routeConfusion.entries()].sort()) {
        lines.push(`- ${key}: ${count}`);
    }
    lines.push("");
    lines.push("### Clarity question (no ground truth — distribution only)");
    lines.push("");
    const clearValues = gatePos
        .map((r) => r.pClear)
        .filter((v): v is number => v !== null);
    lines.push(
        `Positives: median p(clear) ${fmt(median(clearValues))}, min ${fmt(Math.min(...clearValues))}. Poorly-lit fixtures: ${gatePos
            .filter((r) => r.fixtureId.startsWith("poorly-lit"))
            .map((r) => `${r.fixtureId} = ${fmt(r.pClear)}`)
            .join(", ")}.`,
    );
    lines.push("");
    lines.push("### Borderline negatives — individually");
    lines.push("");
    for (const result of gateNegBorderline) {
        const fixture = negById.get(result.fixtureId)!;
        lines.push(
            `- **${result.fixtureId}** (${fixture.category}; label call: gate_food=${fixture.expected.gate_food}, route=${fixture.expected.expected_route}): p(food)=${fmt(result.pFood)}, route=${result.routeChoice ?? "n/a"}, p(clear)=${fmt(result.pClear)}. ${fixture.expected.rationale}`,
        );
    }
    lines.push("");
    lines.push("### Per-photo gate detail");
    lines.push("");
    lines.push("| Fixture | Set | p(food) | Route (conf) | p(clear) | Latency ms | Cost $ |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const result of gateResults) {
        lines.push(
            `| ${result.fixtureId} | ${result.set} | ${fmt(result.pFood)} | ${result.routeChoice ?? "n/a"} (${fmt(result.routeConfidence, 2)}) | ${fmt(result.pClear)} | ${result.call.latencyMs} | ${fmt(result.call.reportedCostUsd, 5)} |`,
        );
    }
    lines.push("");
    lines.push("## 2. Receipt routing reality check");
    lines.push("");
    if (receiptResult) {
        lines.push(
            `The receipt fixture (neg-01-receipt — itemized paper restaurant receipt) was routed as **${receiptResult.routeChoice ?? "n/a"}** (confidence ${fmt(receiptResult.routeConfidence)}, route probabilities ${JSON.stringify(receiptResult.routeProbabilities)}), with p(food)=${fmt(receiptResult.pFood)}. ${receiptResult.routeChoice === "receipt" ? "The front door recognises the receipt for what it is." : "The front door does NOT recognise the receipt as a receipt."}`,
        );
    } else {
        lines.push("Receipt fixture produced no parsed gate result.");
    }
    lines.push("");
    lines.push("## 3. Verification pass over Ember identifications");
    lines.push("");
    lines.push(
        `Ember (${EMBER_SLUG}) identified the 30 positive photos once each (production identify path). Identify-level scoring with the existing namesMatch matcher: expected ${verifyTotals.expected} items, predicted ${verifyTotals.predicted}, matched ${verifyTotals.matched} → **precision ${fmt(verifyTotals.predicted ? verifyTotals.matched / verifyTotals.predicted : null)} / recall ${fmt(verifyTotals.expected ? verifyTotals.matched / verifyTotals.expected : null)}** before any Jev filtering.`,
    );
    lines.push("");
    lines.push(
        "Jev per-item presence probabilities (drop = p(present) below threshold; items whose call failed keep p=null and are never dropped):",
    );
    lines.push("");
    lines.push("| Drop threshold | Items kept | Matched kept | Precision after | Recall after |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of verifyRows) {
        lines.push(
            `| ${row.threshold.toFixed(1)} | ${row.kept} | ${row.matchedKept} | ${fmt(row.precision)} | ${fmt(row.recall)} |`,
        );
    }
    lines.push("");
    lines.push(
        `Anything-missing Noul (flag at p ≥ 0.5): Ember actually missed ≥1 expected item in ${missingPhotos.length} photos; Jev flagged ${missingFlagged}/${missingPhotos.length} of those (hit rate ${pct(missingFlagged, missingPhotos.length)}). False flags on the ${noMissingPhotos.length} photos where Ember missed nothing: ${missingFlaggedFalse} (${pct(missingFlaggedFalse, noMissingPhotos.length)}).`,
    );
    lines.push("");
    const addedLat = verifyJevPerPhoto.map((p) => p.addedLatencyMs);
    const addedCost = verifyJevPerPhoto.map((p) => p.addedCostUsd);
    lines.push(
        `Added verification cost per photo: Jev latency median ${fmt(median(addedLat), 0)} ms / p95 ${fmt(percentile(addedLat, 95), 0)} ms (summed across the photo's batched calls — the sequential figure; wall time is lower under concurrency), Jev cost median $${fmt(median(addedCost), 5)} per photo. Verification Jev calls: ${verifyJevLatencies.length} requests, reported cost $${verifyJevCost.toFixed(5)} total. Ember identify: ${emberObservations.length} calls, computed cost $${emberComputedCost.toFixed(5)} (tokens × catalog price), API-reported $${emberReportedCost.toFixed(5)}.`,
    );
    lines.push("");
    lines.push("## Spend");
    lines.push("");
    lines.push(
        `Gate $${gateCost.toFixed(5)} + verification Jev $${verifyJevCost.toFixed(5)} + Ember identify (API-reported) $${emberReportedCost.toFixed(5)} = **$${totalSpend.toFixed(5)}** total reported spend for the probe (the 1–2 format-discovery attempts are extra calls of gate-call size, itemised in results.json \`formatAttempts\`).`,
    );
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.md"), lines.join("\n") + "\n");
await writeFile(
    join(OUT, "results.json"),
    JSON.stringify(
        {
            generatedAt: new Date().toISOString(),
            model: JEV_SLUG,
            endpoint: DECISIONS_URL,
            formatAttempts: gateAttempts,
            gateStyle,
            gate: gateResults,
            verification: verifyPhotos,
            aggregates: {
                gateThresholds: GATE_THRESHOLDS.map((threshold) => ({
                    threshold,
                    positiveFalseRejects: falseRejects(gatePos, threshold),
                    positiveScored: gatePos.filter((r) => r.pFood !== null)
                        .length,
                    headlineNegativeCorrectRejects: correctRejects(
                        gateNegHeadline,
                        threshold,
                    ),
                    headlineNegativeTotal: gateNegHeadline.length,
                })),
                route: {
                    positiveCorrect: routeCorrectPos,
                    positiveScored: routeScoredPos,
                    negativeCorrect: routeCorrectNeg,
                    negativeScored: routeScoredNeg,
                    positiveConfusion: Object.fromEntries(routeConfusion),
                },
                verifyBefore: verifyTotals,
                verifyThresholds: verifyRows,
                missingCheck: {
                    photosWithMisses: missingPhotos.length,
                    flagged: missingFlagged,
                    photosWithoutMisses: noMissingPhotos.length,
                    falseFlagged: missingFlaggedFalse,
                },
                costs: {
                    gateUsd: gateCost,
                    verificationJevUsd: verifyJevCost,
                    emberComputedUsd: emberComputedCost,
                    emberReportedUsd: emberReportedCost,
                    totalReportedUsd: totalSpend,
                },
                latenciesMs: {
                    gateMedian: median(gateLatencies),
                    gateP95: percentile(gateLatencies, 95),
                    verificationAddedPerPhotoMedian: median(
                        verifyJevPerPhoto.map((p) => p.addedLatencyMs),
                    ),
                    verificationAddedPerPhotoP95: percentile(
                        verifyJevPerPhoto.map((p) => p.addedLatencyMs),
                        95,
                    ),
                },
            },
        },
        null,
        2,
    ),
);
console.info(`[jevprobe] report written to ${OUT}`);
