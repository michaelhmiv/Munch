/**
 * Vision model bake-off, Layer 1 (Michael directive, 2026-11-10):
 * compare cheap/fast OpenRouter vision models against the production
 * model on the golden meal-photo fixtures. Every model runs the
 * PRODUCTION identify path (src/meal-photo/vision.ts identifyMealPhoto —
 * same prompt, strict JSON schema, reasoning params, response-healing
 * plugin, retry semantics); only the model slug varies, through the
 * same MUNCH_AI_MODEL override production uses. A wrapping fetcher
 * observes the raw OpenRouter responses to capture per-call token
 * usage, serving provider, and any API-reported cost WITHOUT changing
 * the request or its parsing.
 *
 * Headline metrics per model: cost per task (token usage × the catalog
 * price table below), time per task (wall-clock latency of one
 * identify call), and accuracy against
 * fixtures/photo-eval/expectations.json — item recall, item precision,
 * extra (hallucinated) items, and portion-in-range rate — using the
 * same name matching as src/meal-photo/scoring.ts.
 *
 * CAVEAT, carried into every output: the DEFAULT fixture set is 100%
 * synthetic illustrations; scores on it rank models against each other
 * on identical inputs and are NOT real-photo accuracy. The real-photo
 * set (fixtures/photo-eval-real, BAKEOFF_FIXTURES_DIR) is real
 * photographs from openly licensed sources with conservative,
 * human-verified expectations; its report carries its own caveat.
 *
 * Layer 2 (finalists through the full grounding pipeline) reuses
 * scripts/photo-eval-live.ts via its existing MUNCH_AI_MODEL override;
 * see .github/workflows/photo-model-bakeoff.yml.
 *
 * Knobs (env): BAKEOFF_MODELS (comma-separated slugs; default the full
 * slate), BAKEOFF_FIXTURES_DIR (repo-relative fixture set directory;
 * default fixtures/photo-eval), BAKEOFF_FIXTURE_IDS (comma-separated
 * subset), BAKEOFF_REPEATS
 * (default 2), BAKEOFF_CONCURRENCY (default 4), BAKEOFF_OUT (default
 * ./bakeoff-report), BAKEOFF_GLM_REASONING (GLM accommodation shape:
 * omit | minimal; default omit — see REQUEST_ACCOMMODATIONS). Exit 0
 * when a report was produced — an individual
 * model failing is data, not a harness failure. Exit 2 when
 * OPENROUTER_API_KEY is not configured.
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
const FIXTURES_DIR_REL =
    process.env.BAKEOFF_FIXTURES_DIR?.trim() || "fixtures/photo-eval";
const FIXTURES = join(ROOT, FIXTURES_DIR_REL);
const OUT = process.env.BAKEOFF_OUT ?? join(ROOT, "bakeoff-report");

/** Catalog prices, USD per 1M tokens (input / output), as briefed
 * 2026-11-10. Cost per task is computed from these; any cost the API
 * itself reports is recorded alongside and disagreements > 20% are
 * flagged in the report. */
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
    "meta/muse-ember": { input: 0.1, output: 0.5 },
    "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "deepseek/deepseek-v4.1-flash": { input: 0.05, output: 0.57 },
    "qwen/qwen3.7-flash": { input: 0.03, output: 0.13 },
    "z-ai/glm-5.3-flash": { input: 0.04, output: 0.08 },
    "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
    "amazon/nova-lite-v1": { input: 0.06, output: 0.24 },
    "openai/gpt-5-nano": { input: 0.05, output: 0.4 },
};
const DEFAULT_MODELS = Object.keys(PRICE_TABLE);

/** BAKE-OFF-ONLY per-model request accommodations. Production sends
 * reasoning:{enabled:false} for every non-Muse model; the GLM endpoint
 * is reasoning-mandatory and rejected that on all 80 calls of the first
 * Layer 1 run with HTTP 400 ("Reasoning is mandatory for this endpoint
 * and cannot be disabled."). To measure GLM at all, the harness rewrites
 * ONLY the reasoning field of the outgoing request body for this slug —
 * prompt, schema, and image payload stay identical, and no production
 * code (src/) changes. GLM's measured cost/time therefore include any
 * reasoning tokens it spends; that is its real operating profile, and
 * the report carries this note wherever GLM appears. Shape knob:
 * BAKEOFF_GLM_REASONING=omit (drop the field; the endpoint's own
 * default applies) | minimal (reasoning:{effort:"minimal"}). */
const GLM_MODEL = "z-ai/glm-5.3-flash";
const GLM_REASONING_SHAPE =
    (process.env.BAKEOFF_GLM_REASONING ?? "omit").trim().toLowerCase() ===
    "minimal"
        ? "minimal"
        : "omit";
const REQUEST_ACCOMMODATIONS: Record<string, string> = {
    [GLM_MODEL]: `Bake-off-only request accommodation: the GLM endpoint is reasoning-mandatory and rejects the production reasoning:{enabled:false} with HTTP 400, so the harness rewrote ONLY the reasoning field of the outgoing request (shape: ${
        GLM_REASONING_SHAPE === "minimal"
            ? 'reasoning:{effort:"minimal"}'
            : "reasoning field omitted; endpoint default applies"
    }). Prompt, schema, and image payload identical; no production code changed. GLM cost/time include its reasoning tokens — its real operating profile.`,
};

/** BAKE-OFF-ONLY strict-prompt variant (Michael's over-naming question,
 * 2026-11-11): for slugs listed in BAKEOFF_STRICT_PROMPT_MODELS, the
 * harness appends ONE visible-evidence instruction to the user message
 * text of the outgoing identify request. Everything else — schema,
 * image payload, reasoning params — stays the production shape, and no
 * production code (src/) changes. The report discloses the variant and
 * quotes the appended instruction verbatim wherever the model appears. */
const STRICT_PROMPT_INSTRUCTION =
    "STRICT VISIBILITY RULE: List an item only when you can point to exactly where it is visible in this photo. When you are unsure whether something is present, leave it out. Do not list items that are merely typical, expected, or implied by the dish — only what is actually visible.";
const STRICT_PROMPT_MODELS = new Set(
    (process.env.BAKEOFF_STRICT_PROMPT_MODELS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
);
const PROMPT_ACCOMMODATIONS: Record<string, string> = Object.fromEntries(
    [...STRICT_PROMPT_MODELS].map((model) => [
        model,
        `Bake-off-only prompt variant: the harness appended one instruction to the production identify prompt for this run — verbatim: "${STRICT_PROMPT_INSTRUCTION}" Schema, image payload, and reasoning params identical; no production code changed.`,
    ]),
);

function appendStrictPrompt(body: string): string {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const messages = parsed.messages as
            | Array<Record<string, unknown>>
            | undefined;
        if (!Array.isArray(messages)) return body;
        const userMessage = [...messages]
            .reverse()
            .find((message) => message.role === "user");
        if (!userMessage) return body;
        const content = userMessage.content;
        if (typeof content === "string") {
            userMessage.content = `${content}\n\n${STRICT_PROMPT_INSTRUCTION}`;
            return JSON.stringify(parsed);
        }
        if (Array.isArray(content)) {
            const textPart = content.find(
                (part) =>
                    part &&
                    typeof part === "object" &&
                    (part as Record<string, unknown>).type === "text",
            ) as Record<string, unknown> | undefined;
            if (textPart && typeof textPart.text === "string") {
                textPart.text = `${textPart.text}\n\n${STRICT_PROMPT_INSTRUCTION}`;
                return JSON.stringify(parsed);
            }
        }
        return body;
    } catch {
        return body;
    }
}

function rewriteReasoningField(body: string): string {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (GLM_REASONING_SHAPE === "minimal") {
            parsed.reasoning = { effort: "minimal" };
        } else {
            delete parsed.reasoning;
        }
        return JSON.stringify(parsed);
    } catch {
        return body;
    }
}

/** The fetcher a model's tasks run through: the plain observing fetcher,
 * wrapped with the request-rewrite above for accommodated slugs. */
function bakeoffFetcher(model: string, sink: CallObservation[]) {
    const inner = observingFetcher(sink);
    const rewriteReasoning = model in REQUEST_ACCOMMODATIONS;
    const strictPrompt = STRICT_PROMPT_MODELS.has(model);
    if (!rewriteReasoning && !strictPrompt) return inner;
    return async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        if (init && typeof init.body === "string") {
            let body = init.body;
            if (rewriteReasoning) body = rewriteReasoningField(body);
            if (strictPrompt) body = appendStrictPrompt(body);
            return inner(input, { ...init, body });
        }
        return inner(input, init);
    };
}

const parsedModels = (
    process.env.BAKEOFF_MODELS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []
).filter((slug, index, all) => all.indexOf(slug) === index);
const models = parsedModels.length > 0 ? parsedModels : DEFAULT_MODELS;
const repeats = Math.max(
    1,
    Math.min(5, Number(process.env.BAKEOFF_REPEATS ?? 2) || 2),
);
const concurrency = Math.max(
    1,
    Math.min(8, Number(process.env.BAKEOFF_CONCURRENCY ?? 4) || 4),
);
const fixtureFilter = new Set(
    (process.env.BAKEOFF_FIXTURE_IDS?.split(",") ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
);

interface ExpectationFixture {
    id: string;
    file: string;
    source: string;
    items: Array<{
        name: string;
        /** null = portion deliberately unscored (the real-photo set
         * scores a portion only where the photo honestly supports a
         * range — see fixtures/photo-eval-real/README.md). */
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
    console.error("[bakeoff] No fixtures selected; nothing to run.");
    process.exit(2);
}
const IS_REAL_SET = fixtures.some((fixture) => fixture.source === "real");
const SET_CAVEAT = IS_REAL_SET
    ? "The fixture set is REAL photographs from openly licensed sources (per-photo provenance in the set's manifest.json). Expectations are conservative — only items a careful human can clearly see are expected, and portions are scored only where the photo honestly supports a range (portion: null = unscored) — so these scores are photographic accuracy evidence on this set, still a small sample (see the set README)."
    : "The fixture set is 100% synthetic illustrations. Scores rank models against each other on identical inputs; they are not real-photo accuracy.";
if (!process.env.OPENROUTER_API_KEY?.trim()) {
    console.error(
        "[bakeoff] OPENROUTER_API_KEY is not configured; the bake-off cannot run.",
    );
    process.exit(2);
}

interface CallObservation {
    latencyMs: number;
    httpStatus: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    reportedCostUsd: number | null;
    provider: string | null;
    responseModel: string | null;
    transportError: string | null;
}

/** A fetcher that performs the real request and records what the API
 * actually returned (usage, provider, cost) from a clone, leaving the
 * production caller's response untouched. */
function observingFetcher(sink: CallObservation[]) {
    return async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const startedAt = performance.now();
        try {
            const response = await fetch(input, init);
            const observation: CallObservation = {
                latencyMs: Math.round(performance.now() - startedAt),
                httpStatus: response.status,
                promptTokens: null,
                completionTokens: null,
                reasoningTokens: null,
                reportedCostUsd: null,
                provider: null,
                responseModel: null,
                transportError: null,
            };
            try {
                const payload = (await response.clone().json()) as any;
                const usage = payload?.usage;
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
                // Non-JSON body (e.g. an error page): usage stays null
                // and the production path handles the response as-is.
            }
            sink.push(observation);
            return response;
        } catch (error) {
            sink.push({
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
            });
            throw error;
        }
    };
}

interface IdentifyScore {
    expected: number;
    returned: number;
    matched: number;
    extras: number;
    portionChecked: number;
    portionInRange: number;
}

/** Identify-only scoring with scoring.ts name matching: greedy
 * one-to-one expected→returned matching, extras = returned items no
 * expected item claims, portion-in-range = matched quantity inside the
 * expected min–max where the units agree. */
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

interface TaskResult {
    fixtureId: string;
    repeat: number;
    ok: boolean;
    failure: string | null;
    latencyMs: number;
    httpCalls: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    computedCostUsd: number;
    reportedCostUsd: number | null;
    providers: string[];
    items: Array<{ name: string; quantity: number; unit: string }>;
    score: IdentifyScore | null;
}

async function runTask(
    model: string,
    fixture: ExpectationFixture,
    repeat: number,
    bytes: Uint8Array,
): Promise<TaskResult> {
    const price = PRICE_TABLE[model] ?? { input: 0, output: 0 };
    const config = mealPhotoVisionConfig({
        ...process.env,
        MUNCH_AI_MODEL: model,
        MUNCH_MEAL_PHOTO_ENABLED: "true",
        // Per-call timeout capped at 60s (bake-off rule); the
        // production default of 30s would punish slower models.
        MUNCH_MEAL_PHOTO_TIMEOUT_MS: "60000",
    });
    if (!config) {
        return {
            fixtureId: fixture.id,
            repeat,
            ok: false,
            failure: "vision config unavailable (missing API key?)",
            latencyMs: 0,
            httpCalls: 0,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            computedCostUsd: 0,
            reportedCostUsd: null,
            providers: [],
            items: [],
            score: null,
        };
    }
    const observations: CallObservation[] = [];
    const startedAt = performance.now();
    let items: MealPhotoVisionItem[] = [];
    let failure: string | null = null;
    try {
        const result = await identifyMealPhoto(
            { mimeType: "image/jpeg", bytes },
            config,
            { fetcher: bakeoffFetcher(model, observations) },
        );
        items = result.items;
    } catch (error) {
        if (error instanceof MealPhotoNoFoodError) {
            // A legitimate empty identification, scored as zero items —
            // not a failure.
            items = [];
        } else {
            failure = error instanceof Error ? error.message : String(error);
        }
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let computedCostUsd = 0;
    let reportedCostUsd: number | null = null;
    const providers = new Set<string>();
    for (const observation of observations) {
        promptTokens += observation.promptTokens ?? 0;
        completionTokens += observation.completionTokens ?? 0;
        reasoningTokens += observation.reasoningTokens ?? 0;
        computedCostUsd +=
            ((observation.promptTokens ?? 0) / 1_000_000) * price.input +
            ((observation.completionTokens ?? 0) / 1_000_000) * price.output;
        if (observation.reportedCostUsd !== null) {
            reportedCostUsd =
                (reportedCostUsd ?? 0) + observation.reportedCostUsd;
        }
        if (observation.provider) providers.add(observation.provider);
    }
    return {
        fixtureId: fixture.id,
        repeat,
        ok: failure === null,
        failure,
        latencyMs,
        httpCalls: observations.length,
        promptTokens,
        completionTokens,
        reasoningTokens,
        computedCostUsd,
        reportedCostUsd,
        providers: [...providers],
        items: items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
        })),
        score: failure === null ? scoreIdentify(fixture.items, items) : null,
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

const bytesByFixture = new Map<string, Uint8Array>();
for (const fixture of fixtures) {
    bytesByFixture.set(
        fixture.id,
        new Uint8Array(await readFile(join(FIXTURES, fixture.file))),
    );
}

interface ModelReport {
    model: string;
    pricePerMillion: { input: number; output: number } | null;
    tasksAttempted: number;
    tasksCompleted: number;
    tasksFailed: number;
    failureRate: number;
    failures: Array<{ fixtureId: string; repeat: number; error: string }>;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalReasoningTokens: number;
    requestAccommodation: string | null;
    totalComputedCostUsd: number;
    costPerTaskUsd: number;
    totalReportedCostUsd: number | null;
    callsWithReportedCost: number;
    costDisagreementCalls: number;
    latencyMs: {
        median: number | null;
        p95: number | null;
        mean: number | null;
    };
    accuracy: {
        expectedItems: number;
        matchedItems: number;
        returnedItems: number;
        extraItems: number;
        recall: number;
        recallCompletedTasksOnly: number;
        precision: number | null;
        portionChecked: number;
        portionInRange: number;
        portionInRangeRate: number | null;
    };
    providersSeen: Record<string, number>;
    perFixture: Array<{
        fixtureId: string;
        source: string;
        expectedItems: number;
        meanRecall: number | null;
        runs: TaskResult[];
    }>;
}

const modelReports: ModelReport[] = [];
const runStartedAt = new Date().toISOString();
for (const model of models) {
    const jobs: Array<() => Promise<TaskResult>> = [];
    for (const fixture of fixtures) {
        for (let repeat = 0; repeat < repeats; repeat += 1) {
            jobs.push(() =>
                runTask(
                    model,
                    fixture,
                    repeat,
                    bytesByFixture.get(fixture.id)!,
                ).then((result) => {
                    console.info(
                        `[bakeoff] ${model} ${fixture.id} r${repeat} ${result.ok ? `ok items=${result.items.length} matched=${result.score?.matched ?? 0}` : `FAIL ${result.failure}`} ${result.latencyMs}ms`,
                    );
                    return result;
                }),
            );
        }
    }
    const tasks = await runPool(jobs, concurrency);
    const completed = tasks.filter((task) => task.ok);
    const failed = tasks.filter((task) => !task.ok);
    let expectedItems = 0;
    let expectedCompleted = 0;
    let matchedItems = 0;
    let returnedItems = 0;
    let extraItems = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    for (const fixture of fixtures) {
        expectedItems += fixture.items.length * repeats;
    }
    for (const task of completed) {
        if (!task.score) continue;
        expectedCompleted += task.score.expected;
        matchedItems += task.score.matched;
        returnedItems += task.score.returned;
        extraItems += task.score.extras;
        portionChecked += task.score.portionChecked;
        portionInRange += task.score.portionInRange;
    }
    // Cost disagreement: recompute per task is not possible from the
    // task rollup alone, so compare the model's totals where reported
    // costs exist; per-call detail lives in the task rows.
    let callsWithReportedCost = 0;
    let costDisagreementCalls = 0;
    let totalReportedCostUsd: number | null = null;
    for (const task of tasks) {
        if (task.reportedCostUsd !== null) {
            totalReportedCostUsd =
                (totalReportedCostUsd ?? 0) + task.reportedCostUsd;
            callsWithReportedCost += task.httpCalls;
            if (
                task.computedCostUsd > 0 &&
                Math.abs(task.reportedCostUsd - task.computedCostUsd) /
                    task.computedCostUsd >
                    0.2
            ) {
                costDisagreementCalls += 1;
            }
        }
    }
    const providersSeen: Record<string, number> = {};
    for (const task of tasks) {
        for (const provider of task.providers) {
            providersSeen[provider] = (providersSeen[provider] ?? 0) + 1;
        }
    }
    const latencies = completed.map((task) => task.latencyMs);
    const totalComputedCostUsd = tasks.reduce(
        (sum, task) => sum + task.computedCostUsd,
        0,
    );
    modelReports.push({
        model,
        pricePerMillion: PRICE_TABLE[model] ?? null,
        tasksAttempted: tasks.length,
        tasksCompleted: completed.length,
        tasksFailed: failed.length,
        failureRate: tasks.length ? failed.length / tasks.length : 0,
        failures: failed.map((task) => ({
            fixtureId: task.fixtureId,
            repeat: task.repeat,
            error: task.failure ?? "unknown",
        })),
        totalPromptTokens: tasks.reduce(
            (sum, task) => sum + task.promptTokens,
            0,
        ),
        totalCompletionTokens: tasks.reduce(
            (sum, task) => sum + task.completionTokens,
            0,
        ),
        totalReasoningTokens: tasks.reduce(
            (sum, task) => sum + task.reasoningTokens,
            0,
        ),
        requestAccommodation: REQUEST_ACCOMMODATIONS[model] ?? null,
        promptAccommodation: PROMPT_ACCOMMODATIONS[model] ?? null,
        totalComputedCostUsd,
        costPerTaskUsd: tasks.length ? totalComputedCostUsd / tasks.length : 0,
        totalReportedCostUsd,
        callsWithReportedCost,
        costDisagreementCalls,
        latencyMs: {
            median: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            mean: latencies.length
                ? Math.round(
                      latencies.reduce((sum, value) => sum + value, 0) /
                          latencies.length,
                  )
                : null,
        },
        accuracy: {
            expectedItems,
            matchedItems,
            returnedItems,
            extraItems,
            recall: expectedItems ? matchedItems / expectedItems : 0,
            recallCompletedTasksOnly: expectedCompleted
                ? matchedItems / expectedCompleted
                : 0,
            precision: returnedItems ? matchedItems / returnedItems : null,
            portionChecked,
            portionInRange,
            portionInRangeRate: portionChecked
                ? portionInRange / portionChecked
                : null,
        },
        providersSeen,
        perFixture: fixtures.map((fixture) => {
            const runs = tasks.filter((task) => task.fixtureId === fixture.id);
            const scored = runs.filter((task) => task.score !== null);
            return {
                fixtureId: fixture.id,
                source: fixture.source,
                expectedItems: fixture.items.length,
                meanRecall: scored.length
                    ? scored.reduce(
                          (sum, task) =>
                              sum +
                              (task.score!.expected
                                  ? task.score!.matched / task.score!.expected
                                  : 0),
                          0,
                      ) / scored.length
                    : null,
                runs,
            };
        }),
    });
    const report = modelReports.at(-1)!;
    console.info(
        `[bakeoff] ${model} DONE recall=${report.accuracy.recall.toFixed(3)} precision=${report.accuracy.precision?.toFixed(3) ?? "n/a"} cost/task=$${report.costPerTaskUsd.toFixed(5)} failures=${report.tasksFailed}/${report.tasksAttempted}`,
    );
}

const ranked = [...modelReports].sort(
    (a, b) =>
        b.accuracy.recall - a.accuracy.recall ||
        (b.accuracy.precision ?? 0) - (a.accuracy.precision ?? 0),
);
const totalSpendUsd = modelReports.reduce(
    (sum, report) => sum + report.totalComputedCostUsd,
    0,
);
const reportJson = {
    run_at: runStartedAt,
    layer: "1-identify",
    fixtures: fixtures.length,
    repeats,
    concurrency,
    prices_per_million_tokens: PRICE_TABLE,
    request_accommodations: REQUEST_ACCOMMODATIONS,
    prompt_accommodations: PROMPT_ACCOMMODATIONS,
    fixtures_dir: FIXTURES_DIR_REL,
    caveat: SET_CAVEAT,
    total_computed_spend_usd: totalSpendUsd,
    ranked_models: ranked.map((report) => report.model),
    models: modelReports,
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), JSON.stringify(reportJson, null, 2));

const pct = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
    value === null ? "n/a" : `${value.toLocaleString()} ms`;
const lines = [
    `# Vision model bake-off — Layer 1 (identify only)`,
    ``,
    `Run: ${runStartedAt} · Fixture set: ${FIXTURES_DIR_REL} · Fixtures: ${fixtures.length} · Repeats: ${repeats} · Tasks per model: ${fixtures.length * repeats} · Total computed spend: $${totalSpendUsd.toFixed(4)}`,
    ``,
    `Every model ran the production identify path (same prompt, schema, reasoning params); only the model slug varied — with ONE disclosed exception: a model whose endpoint rejects the production request shape outright is measured through the bake-off-only request accommodation recorded in report.json (request_accommodations), which rewrites only the rejected field; its cost/time include whatever that shape makes it spend. Cost = token usage × catalog prices (see report.json). Accuracy uses scoring.ts name matching; failed/timed-out tasks count as zero-recall in the headline recall (see recallCompletedTasksOnly in report.json for the completed-only figure).`,
    ``,
    `> **Caveat:** ${SET_CAVEAT}`,
    ``,
    `| Rank | Model | Cost/task | Median | p95 | Recall | Precision | Portion in range | Extra items | Failures |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...ranked.map(
        (report, index) =>
            `| ${index + 1} | ${report.model} | $${report.costPerTaskUsd.toFixed(5)} | ${ms(report.latencyMs.median)} | ${ms(report.latencyMs.p95)} | ${pct(report.accuracy.recall)} | ${pct(report.accuracy.precision)} | ${pct(report.accuracy.portionInRangeRate)} (${report.accuracy.portionInRange}/${report.accuracy.portionChecked}) | ${report.accuracy.extraItems} | ${report.tasksFailed}/${report.tasksAttempted} |`,
    ),
    ``,
    `## Notes`,
    ``,
    ...modelReports.flatMap((report) => {
        const notes: string[] = [];
        if (report.requestAccommodation) {
            notes.push(
                `- ${report.model}: ${report.requestAccommodation} Reasoning tokens spent across its tasks: ${report.totalReasoningTokens.toLocaleString()}.`,
            );
        }
        if (report.costDisagreementCalls > 0) {
            notes.push(
                `- ${report.model}: API-reported cost disagreed with the catalog-price computation by >20% on ${report.costDisagreementCalls} task(s) — trust the reported figure for those.`,
            );
        }
        const providers = Object.keys(report.providersSeen);
        if (providers.length > 0) {
            notes.push(
                `- ${report.model}: served by ${providers
                    .map(
                        (provider) =>
                            `${provider} (${report.providersSeen[provider]} tasks)`,
                    )
                    .join(", ")}.`,
            );
        }
        if (report.tasksFailed > 0) {
            const sample = report.failures
                .slice(0, 3)
                .map(
                    (failure) =>
                        `${failure.fixtureId} r${failure.repeat}: ${failure.error.slice(0, 160)}`,
                )
                .join(" · ");
            notes.push(
                `- ${report.model}: ${report.tasksFailed} failed task(s). First failures: ${sample}`,
            );
        }
        return notes;
    }),
    ``,
    `Full per-fixture detail: report.json.`,
    ``,
];
await writeFile(join(OUT, "report.md"), lines.join("\n"));
console.info(lines.join("\n"));
