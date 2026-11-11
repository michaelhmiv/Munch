/**
 * Full-pipeline photo eval on the REAL-photo fixture set (Michael
 * directive, 2026-11-10 ~22:51 ET): every configuration runs the TRUE
 * production pipeline — identify (vision) → database search/grounding
 * → candidate tie-break DECIDER → labelled estimate fallback → filled
 * meal draft — against fixtures/photo-eval-real (30 real photographs,
 * conservative human-verified expectations; portions scored only on
 * the portion-bearing items, the rest portion: null = unscored).
 *
 * Wiring mirrors production (src/app/routes.ts): ONE role model drives
 * identify + decider + estimate in single-model configs. The only
 * harness differences, all labelled in the report:
 *  - Grounding search is the live USDA + Open Food Facts provider
 *    registry (same as scripts/photo-eval-live.ts); the local catalog
 *    layer needs Postgres and is skipped in this lane.
 *  - Hybrid configs wire the DECIDER role to a different model than
 *    identify/estimate — that split happens here, in the harness's
 *    dependency wiring, exactly where production injects its deps.
 *    No src/ code changes for any config.
 *  - Draft persistence (createMealPhotoDraft's DB writes) is out of
 *    scope for a CI lane; the scored artifact is the grounded draft
 *    item set groundMealPhotoItems produces — the exact items the
 *    production draft is filled with.
 *
 * Metrics per config (Michael's headline three first): cost per
 * completed draft — ALL model calls summed (identify + decider +
 * estimate), computed from tokens × the catalog price table AND
 * API-reported where the API returns a cost; end-to-end wall time per
 * photo (median/p95); accuracy = item recall, precision, grounded %,
 * portion-in-range on the scored subset, fabricated provider IDs /
 * nutrition (hard bar: must be 0). Per-fixture draft calorie estimates
 * are reported with their cross-model spread as a COMPARISON — the
 * real set has no calorie ground truth, so calorie figures are never
 * presented as accuracy.
 *
 * Jev (owner correction, 2026-11-10 ~22:56 ET): Michael wants
 * TypeSafe's DECISION MODEL sampled directly — typesafe/jev-1.14 —
 * in the DECIDER seat, not the router (jev-router routes to other
 * models; measuring it measures someone else's model). Verified
 * against OpenRouter's public endpoints API 2026-11-10: jev-1.14
 * does not appear in the /models list, but it HAS a live endpoint
 * (TypeSafe | typesafe/jev-1.14-20261014, status 0, modality
 * text+image -> decisions, $0.042 per 1M input tokens, $0 output).
 * The harness probes jev-1.14 with the REAL production decider and
 * identify call shapes before the matrix runs and records the
 * literal outcomes; there is NO fallback substitution — if the
 * endpoint rejects the production shapes, the hybrid tasks record
 * those rejections (the observing fetcher captures error bodies)
 * and the report says so plainly. typesafe/jev-router additionally
 * runs as ONE clearly-labelled decider config (it does not count as
 * the Jev result); every call records which model actually served
 * it. Jev-router pricing is dynamic (-1/-1), so its computed cost
 * is n/a and the API-reported cost is the figure of record.
 *
 * GLM is EXCLUDED from this matrix by design: the production call
 * shape cannot drive it (reasoning-mandatory endpoint; its earlier
 * full-pipeline attempt scored 0/40 on HTTP 400s). Its Layer-1 numbers
 * live in the bake-off reports on PR #235.
 *
 * Knobs (env): FULLEVAL_CONFIGS (comma-separated config specs —
 * "single:<slug>" or "hybrid:<identifySlug>+<deciderSlug>", where the
 * token "jev" resolves via the probe; default the full matrix),
 * FULLEVAL_REPEATS (default 2), FULLEVAL_CONCURRENCY (default 4),
 * FULLEVAL_FIXTURE_IDS (comma-separated subset), FULLEVAL_OUT
 * (default ./fulleval-report). Exit 0 when a report was produced — a
 * failing config is data, not a harness failure. Exit 2 when the API
 * keys are not configured.
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
import { namesMatch, scoreFixture } from "../src/meal-photo/scoring.js";
import {
    chooseMealPhotoCandidates,
    identifyMealPhoto,
    mealPhotoVisionConfig,
    MealPhotoNoFoodError,
    type MealPhotoVisionConfig,
    type MealPhotoVisionItem,
} from "../src/meal-photo/vision.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures", "photo-eval-real");
const OUT = process.env.FULLEVAL_OUT ?? join(ROOT, "fulleval-report");

/** Catalog prices, USD per 1M tokens (input / output). Ember/Luna/
 * Nova-Lite as briefed for the Layer-1 bake-off 2026-11-10;
 * deepseek-v4-flash-vision-exp and nova-2-lite verified against the
 * OpenRouter catalog by Jeff 2026-11-10 ~22:51 ET. The DeepSeek v4.1
 * slot is the PINNED dated snapshot deepseek-v4.1-flash-1017 at
 * $0.01/$0.50 (owner correction 2026-11-10 ~22:53 ET), not the
 * rolling alias. deepseek-v4-flash (no suffix) is TEXT-ONLY and
 * cannot appear here — vision-exp is the Flash-4 family's vision
 * member. typesafe/jev-1.14's price is from its endpoints-API record
 * ($0.000000042/token prompt, $0 completion). typesafe/jev-router is
 * absent on purpose: dynamic pricing, API-reported cost only. */
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
    "meta/muse-ember": { input: 0.1, output: 0.5 },
    "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "deepseek/deepseek-v4.1-flash": { input: 0.05, output: 0.57 },
    "deepseek/deepseek-v4.1-flash-1017": { input: 0.01, output: 0.5 },
    "deepseek/deepseek-v4-flash-vision-exp": { input: 0.44, output: 1.32 },
    "amazon/nova-lite-v1": { input: 0.06, output: 0.24 },
    "amazon/nova-2-lite-v1": { input: 0.3, output: 2.5 },
    "qwen/qwen3.7-flash": { input: 0.03, output: 0.13 },
    "z-ai/glm-5.3-flash": { input: 0.04, output: 0.08 },
    "typesafe/jev-1.14": { input: 0.042, output: 0 },
};

const JEV_SLUG = "typesafe/jev-1.14";
const JEV_ROUTER_SLUG = "typesafe/jev-router";

const DEFAULT_CONFIGS = [
    "single:meta/muse-ember",
    "single:openai/gpt-5.6-luna",
    "single:deepseek/deepseek-v4.1-flash-1017",
    "single:deepseek/deepseek-v4-flash-vision-exp",
    "single:amazon/nova-lite-v1",
    "single:amazon/nova-2-lite-v1",
    // Jev-1.14 in the decider seat (first-class requirement).
    "hybrid:meta/muse-ember+jev114",
    "hybrid:openai/gpt-5.6-luna+jev114",
    "hybrid:deepseek/deepseek-v4.1-flash-1017+jev114",
    // Bonus: Jev-1.14 in both roles, if its endpoint takes the
    // identify call shape — the probe records whether it does.
    "single:jev114",
    // The router, as ONE clearly-labelled extra config. NOT the Jev
    // result: it routes per call to other models.
    "hybrid:meta/muse-ember+jevrouter",
];
const parsedConfigs = (
    process.env.FULLEVAL_CONFIGS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []
).filter((spec, index, all) => all.indexOf(spec) === index);
const configSpecs = parsedConfigs.length > 0 ? parsedConfigs : DEFAULT_CONFIGS;
const repeats = Math.max(
    1,
    Math.min(5, Number(process.env.FULLEVAL_REPEATS ?? 2) || 2),
);
const concurrency = Math.max(
    1,
    Math.min(8, Number(process.env.FULLEVAL_CONCURRENCY ?? 4) || 4),
);
const fixtureFilter = new Set(
    (process.env.FULLEVAL_FIXTURE_IDS?.split(",") ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
);

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
    console.error("[fulleval] No fixtures selected; nothing to run.");
    process.exit(2);
}
if (
    !process.env.OPENROUTER_API_KEY?.trim() ||
    !process.env.USDA_FDC_API_KEY?.trim()
) {
    console.error(
        "[fulleval] OPENROUTER_API_KEY and USDA_FDC_API_KEY are required; the full-pipeline lane cannot run.",
    );
    process.exit(2);
}

const registry = new FoodProviderRegistry([
    new UsdaFoodDataCentralProvider({ timeoutMs: 10_000 }),
    new OpenFoodFactsProvider({ timeoutMs: 10_000 }),
]);

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
    /** Literal API error message for non-2xx responses — the evidence
     * channel for calls whose exceptions are swallowed downstream
     * (the grounding layer catches decider failures by design). */
    errorExcerpt: string | null;
}

/** A fetcher that performs the real request and records what the API
 * actually returned (usage, provider, served model, cost) from a
 * clone, leaving the production caller's response untouched. Same
 * observing pattern as scripts/photo-model-bakeoff.ts. */
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
                // Non-JSON body: usage stays null; the caller handles
                // the response as-is.
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

function configFor(model: string): MealPhotoVisionConfig {
    const config = mealPhotoVisionConfig({
        ...process.env,
        MUNCH_AI_MODEL: model,
        MUNCH_MEAL_PHOTO_ENABLED: "true",
        // Per-call timeout capped at 60s (bake-off rule); the
        // production default of 30s would punish slower models.
        MUNCH_MEAL_PHOTO_TIMEOUT_MS: "60000",
    });
    if (!config) throw new Error("vision config unavailable (missing API key)");
    return config;
}

// ---------------------------------------------------------------------------
// Jev-1.14 probes: before the matrix runs, exercise the endpoint with
// the REAL production call shapes — the decider function with a
// synthetic two-candidate request, and the identify function on a
// real fixture photo. Literal outcomes (including error bodies) are
// recorded in the report. NO substitution: if these shapes are
// rejected, the matrix records the same rejections per task.
// ---------------------------------------------------------------------------

interface ShapeProbe {
    shape: "decider" | "identify";
    ok: boolean;
    detail: string;
    httpStatuses: Array<number | null>;
    servedModels: string[];
    errorExcerpts: string[];
}

function summarizeProbe(
    shape: ShapeProbe["shape"],
    sink: CallObservation[],
    ok: boolean,
    detail: string,
): ShapeProbe {
    return {
        shape,
        ok,
        detail,
        httpStatuses: sink.map((observation) => observation.httpStatus),
        servedModels: [
            ...new Set(
                sink
                    .map((observation) => observation.responseModel)
                    .filter((value): value is string => value !== null),
            ),
        ],
        errorExcerpts: [
            ...new Set(
                sink
                    .map((observation) => observation.errorExcerpt)
                    .filter((value): value is string => value !== null),
            ),
        ],
    };
}

async function probeJevDecider(): Promise<ShapeProbe> {
    const sink: CallObservation[] = [];
    try {
        const choices = await chooseMealPhotoCandidates(
            [
                {
                    key: "item:0",
                    itemName: "grilled chicken breast",
                    cookingMethod: "grilled",
                    candidates: [
                        {
                            candidateId: "probe:usda-chicken-breast",
                            name: "Chicken breast, grilled",
                            brand: null,
                            provider: "usda",
                        },
                        {
                            candidateId: "probe:off-chicken-nuggets",
                            name: "Chicken nuggets",
                            brand: "Probe Brand",
                            provider: "open_food_facts",
                        },
                    ],
                },
            ],
            configFor(JEV_SLUG),
            { fetcher: observingFetcher("probe", sink) },
        );
        const choice = choices.get("item:0");
        return summarizeProbe(
            "decider",
            sink,
            true,
            `decider call accepted; selection=${choice ? `candidate_id=${choice.candidateId} confidence=${choice.confidence}` : "no selection returned for the key"}`,
        );
    } catch (error) {
        return summarizeProbe(
            "decider",
            sink,
            false,
            error instanceof Error ? error.message : String(error),
        );
    }
}

async function probeJevIdentify(bytes: Uint8Array): Promise<ShapeProbe> {
    const sink: CallObservation[] = [];
    try {
        const vision = await identifyMealPhoto(
            { mimeType: "image/jpeg", bytes },
            configFor(JEV_SLUG),
            { fetcher: observingFetcher("probe", sink) },
        );
        return summarizeProbe(
            "identify",
            sink,
            true,
            `identify call accepted; ${vision.items.length} item(s) returned`,
        );
    } catch (error) {
        if (error instanceof MealPhotoNoFoodError) {
            return summarizeProbe(
                "identify",
                sink,
                true,
                "identify call accepted; model reported no food in the probe photo",
            );
        }
        return summarizeProbe(
            "identify",
            sink,
            false,
            error instanceof Error ? error.message : String(error),
        );
    }
}

const needsJev114 = configSpecs.some((spec) => spec.includes("jev114"));
const jevProbes: ShapeProbe[] = [];
if (needsJev114) {
    jevProbes.push(await probeJevDecider());
    const probeFixture = fixtures[0]!;
    jevProbes.push(
        await probeJevIdentify(
            new Uint8Array(await readFile(join(FIXTURES, probeFixture.file))),
        ),
    );
    for (const probe of jevProbes) {
        console.info(
            `[fulleval] Jev-1.14 ${probe.shape} probe: ${probe.ok ? "OK" : "FAILED"} — ${probe.detail} (http=${probe.httpStatuses.join(",")}${probe.errorExcerpts.length ? ` errors=${probe.errorExcerpts.join(" | ")}` : ""})`,
        );
    }
}

function resolveSlug(token: string): string {
    if (token === "jev114") return JEV_SLUG;
    if (token === "jevrouter") return JEV_ROUTER_SLUG;
    return token;
}

interface ParsedConfig {
    spec: string;
    kind: "single" | "hybrid";
    identifyModel: string;
    deciderModel: string;
    /** Display name with the RESOLVED Jev slug substituted. */
    label: string;
}

function parseConfig(spec: string): ParsedConfig {
    if (spec.startsWith("hybrid:")) {
        const [identifyToken, deciderToken] = spec
            .slice("hybrid:".length)
            .split("+");
        const identifyModel = resolveSlug(identifyToken ?? "");
        const deciderModel = resolveSlug(deciderToken ?? "");
        return {
            spec,
            kind: "hybrid",
            identifyModel,
            deciderModel,
            label: `${identifyModel} (identify+estimate) + ${deciderModel} (decider)${deciderModel === JEV_ROUTER_SLUG ? " — ROUTER: routes per call, NOT the decision model" : ""}`,
        };
    }
    const model = resolveSlug(spec.replace(/^single:/, ""));
    return {
        spec,
        kind: "single",
        identifyModel: model,
        deciderModel: model,
        label:
            model === JEV_ROUTER_SLUG
                ? `${model} — ROUTER: routes per call, NOT the decision model`
                : model,
    };
}

// ---------------------------------------------------------------------------
// One task = one photo through the full pipeline under one config.
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

interface TaskResult {
    fixtureId: string;
    repeat: number;
    ok: boolean;
    failure: string | null;
    wallMs: number;
    callsByRole: Record<CallRole, number>;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    /** null when any role's model has no catalog price (Jev). */
    computedCostUsd: number | null;
    reportedCostUsd: number | null;
    servedModels: string[];
    providersSeen: string[];
    deciderCallsOk: number;
    deciderErrorSamples: string[];
    tieBreakUsed: boolean;
    estimatedItems: number;
    blockingItems: number;
    searchFailures: string[];
    score: TaskScore | null;
    draftItems: Array<{
        visionName: string;
        draftName: string;
        source: string;
        calories: number | null;
    }>;
}

/** Draft-level scoring. Recall/precision/portions use the same greedy
 * one-to-one namesMatch semantics as the Layer-1 report (an expected
 * item is recalled when a draft entry's vision name OR provider draft
 * name matches it); fabrication + grounded counts reuse scoring.ts
 * scoreFixture verbatim against the same grounded entries, with
 * portion-null expectations passed a sentinel unit so they never
 * enter scoreFixture's portion denominator (portions are scored here,
 * in-range against the authored [min, max], Layer-1 semantics). */
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

async function runTask(
    config: ParsedConfig,
    fixture: ExpectationFixture,
    repeat: number,
    bytes: Uint8Array,
): Promise<TaskResult> {
    const observations: CallObservation[] = [];
    const identifyConfig = configFor(config.identifyModel);
    const deciderConfig = configFor(config.deciderModel);
    const returnedProviderIds = new Set<string>();
    const searchFailures: string[] = [];
    const deps: MealPhotoGroundingDeps = {
        search: async (query: string, limit = 10) => {
            const result = await registry.search({ query, limit });
            for (const candidate of result.candidates) {
                returnedProviderIds.add(candidate.providerFoodId);
            }
            for (const failure of result.failures) {
                searchFailures.push(
                    `${failure.provider}:${failure.code}:${failure.message.slice(0, 120)}`,
                );
            }
            return result;
        },
        chooseCandidates: (requests) =>
            chooseMealPhotoCandidates(requests, deciderConfig, {
                fetcher: observingFetcher("decider", observations),
            }),
        estimateNutrients: (requests) =>
            estimateMealPhotoNutrients(requests, identifyConfig, {
                fetcher: observingFetcher("estimate", observations),
            }),
    };
    const startedAt = performance.now();
    let grounded: GroundedMealPhotoItem[] = [];
    let failure: string | null = null;
    try {
        let visionItems: MealPhotoVisionItem[] = [];
        try {
            const vision = await identifyMealPhoto(
                { mimeType: "image/jpeg", bytes },
                identifyConfig,
                { fetcher: observingFetcher("identify", observations) },
            );
            visionItems = vision.items;
        } catch (error) {
            if (!(error instanceof MealPhotoNoFoodError)) throw error;
            visionItems = [];
        }
        grounded = await groundMealPhotoItems(visionItems, deps);
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
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let computedCostUsd = 0;
    let computedComplete = true;
    let reportedCostUsd: number | null = null;
    const servedModels = new Set<string>();
    const providersSeen = new Set<string>();
    let deciderCallsOk = 0;
    const deciderErrorSamples: string[] = [];
    for (const observation of observations) {
        callsByRole[observation.role] += 1;
        if (observation.role === "decider") {
            if (
                observation.httpStatus !== null &&
                observation.httpStatus >= 200 &&
                observation.httpStatus < 300
            ) {
                deciderCallsOk += 1;
            }
            const sample =
                observation.errorExcerpt ?? observation.transportError;
            if (
                sample &&
                observation.httpStatus !== 200 &&
                !deciderErrorSamples.includes(sample)
            ) {
                deciderErrorSamples.push(sample);
            }
        }
        promptTokens += observation.promptTokens ?? 0;
        completionTokens += observation.completionTokens ?? 0;
        reasoningTokens += observation.reasoningTokens ?? 0;
        const modelForRole =
            observation.role === "decider"
                ? config.deciderModel
                : config.identifyModel;
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
            // Tokens spent on a model with no catalog price (Jev):
            // the computed total cannot be completed honestly.
            computedComplete = false;
        }
        if (observation.reportedCostUsd !== null) {
            reportedCostUsd =
                (reportedCostUsd ?? 0) + observation.reportedCostUsd;
        }
        if (observation.responseModel)
            servedModels.add(observation.responseModel);
        if (observation.provider) providersSeen.add(observation.provider);
    }
    return {
        fixtureId: fixture.id,
        repeat,
        ok: failure === null,
        failure,
        wallMs,
        callsByRole,
        promptTokens,
        completionTokens,
        reasoningTokens,
        computedCostUsd: computedComplete ? computedCostUsd : null,
        reportedCostUsd,
        servedModels: [...servedModels],
        providersSeen: [...providersSeen],
        deciderCallsOk,
        deciderErrorSamples,
        tieBreakUsed: grounded.some((entry) => entry.tieBreakUsed),
        estimatedItems: grounded.filter((entry) => entry.estimated).length,
        blockingItems: grounded.filter((entry) => entry.question?.blocking)
            .length,
        searchFailures,
        score:
            failure === null
                ? scoreTask(fixture, grounded, returnedProviderIds)
                : null,
        draftItems: grounded.map((entry) => ({
            visionName: entry.vision.name,
            draftName: entry.draftItem.name,
            source: entry.groundingSource,
            calories: entry.draftItem.nutrients.calories ?? null,
        })),
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
// Run every config, aggregate, and write the combined report.
// ---------------------------------------------------------------------------

const bytesByFixture = new Map<string, Uint8Array>();
for (const fixture of fixtures) {
    bytesByFixture.set(
        fixture.id,
        new Uint8Array(await readFile(join(FIXTURES, fixture.file))),
    );
}

interface ConfigReport {
    spec: string;
    label: string;
    kind: "single" | "hybrid";
    identifyModel: string;
    deciderModel: string;
    tasksAttempted: number;
    tasksCompleted: number;
    tasksFailed: number;
    failures: Array<{ fixtureId: string; repeat: number; error: string }>;
    totalComputedCostUsd: number | null;
    totalReportedCostUsd: number | null;
    costPerCompletedDraftComputedUsd: number | null;
    costPerCompletedDraftReportedUsd: number | null;
    wallMs: { median: number | null; p95: number | null; mean: number | null };
    accuracy: {
        expectedItems: number;
        expectedItemsCompleted: number;
        matchedItems: number;
        draftItems: number;
        groundedItems: number;
        recall: number;
        recallCompletedTasksOnly: number;
        precision: number | null;
        groundedShare: number | null;
        portionChecked: number;
        portionInRange: number;
        portionInRangeRate: number | null;
        fabricatedIds: number;
        fabricatedNutrition: number;
    };
    callsByRole: Record<CallRole, number>;
    deciderCallsOk: number;
    deciderErrorSamples: string[];
    tasksWithTieBreak: number;
    tasksWithEstimate: number;
    estimatedItems: number;
    blockingItems: number;
    searchFailureCount: number;
    searchFailureSamples: string[];
    servedModels: Record<string, number>;
    providersSeen: Record<string, number>;
    meanDraftCaloriesByFixture: Record<string, number | null>;
    tasks: TaskResult[];
}

const configReports: ConfigReport[] = [];
const runStartedAt = new Date().toISOString();
for (const spec of configSpecs) {
    const config = parseConfig(spec);
    const jobs: Array<() => Promise<TaskResult>> = [];
    for (const fixture of fixtures) {
        for (let repeat = 0; repeat < repeats; repeat += 1) {
            jobs.push(() =>
                runTask(
                    config,
                    fixture,
                    repeat,
                    bytesByFixture.get(fixture.id)!,
                ).then((result) => {
                    console.info(
                        `[fulleval] ${config.label} ${fixture.id} r${repeat} ${result.ok ? `ok items=${result.score?.draftItems ?? 0} matched=${result.score?.matched ?? 0} grounded=${result.score?.groundedItems ?? 0}` : `FAIL ${result.failure}`} ${result.wallMs}ms`,
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
    let draftItems = 0;
    let groundedItems = 0;
    let portionChecked = 0;
    let portionInRange = 0;
    let fabricatedIds = 0;
    let fabricatedNutrition = 0;
    for (const fixture of fixtures) {
        expectedItems += fixture.items.length * repeats;
    }
    for (const task of completed) {
        if (!task.score) continue;
        expectedCompleted += task.score.expected;
        matchedItems += task.score.matched;
        draftItems += task.score.draftItems;
        groundedItems += task.score.groundedItems;
        portionChecked += task.score.portionChecked;
        portionInRange += task.score.portionInRange;
        fabricatedIds += task.score.fabricatedIds;
        fabricatedNutrition += task.score.fabricatedNutrition;
    }
    let totalComputedCostUsd: number | null = 0;
    let totalReportedCostUsd: number | null = null;
    for (const task of tasks) {
        if (task.computedCostUsd === null) {
            totalComputedCostUsd = null;
        } else if (totalComputedCostUsd !== null) {
            totalComputedCostUsd += task.computedCostUsd;
        }
        if (task.reportedCostUsd !== null) {
            totalReportedCostUsd =
                (totalReportedCostUsd ?? 0) + task.reportedCostUsd;
        }
    }
    const callsByRole: Record<CallRole, number> = {
        identify: 0,
        decider: 0,
        estimate: 0,
        probe: 0,
    };
    const servedModels: Record<string, number> = {};
    const providersSeen: Record<string, number> = {};
    const searchFailureSamples: string[] = [];
    let searchFailureCount = 0;
    for (const task of tasks) {
        for (const role of Object.keys(callsByRole) as CallRole[]) {
            callsByRole[role] += task.callsByRole[role];
        }
        for (const model of task.servedModels) {
            servedModels[model] = (servedModels[model] ?? 0) + 1;
        }
        for (const provider of task.providersSeen) {
            providersSeen[provider] = (providersSeen[provider] ?? 0) + 1;
        }
        searchFailureCount += task.searchFailures.length;
        for (const sample of task.searchFailures) {
            if (
                searchFailureSamples.length < 5 &&
                !searchFailureSamples.includes(sample)
            ) {
                searchFailureSamples.push(sample);
            }
        }
    }
    const meanDraftCaloriesByFixture: Record<string, number | null> = {};
    for (const fixture of fixtures) {
        const values = completed
            .filter((task) => task.fixtureId === fixture.id)
            .map((task) => task.score?.draftCalories)
            .filter(
                (value): value is number =>
                    value !== null && value !== undefined,
            );
        meanDraftCaloriesByFixture[fixture.id] = values.length
            ? Math.round(
                  (values.reduce((sum, value) => sum + value, 0) /
                      values.length) *
                      10,
              ) / 10
            : null;
    }
    const walls = completed.map((task) => task.wallMs);
    const report: ConfigReport = {
        spec,
        label: config.label,
        kind: config.kind,
        identifyModel: config.identifyModel,
        deciderModel: config.deciderModel,
        tasksAttempted: tasks.length,
        tasksCompleted: completed.length,
        tasksFailed: failed.length,
        failures: failed.map((task) => ({
            fixtureId: task.fixtureId,
            repeat: task.repeat,
            error: task.failure ?? "unknown",
        })),
        totalComputedCostUsd,
        totalReportedCostUsd,
        costPerCompletedDraftComputedUsd:
            totalComputedCostUsd !== null && completed.length
                ? totalComputedCostUsd / completed.length
                : null,
        costPerCompletedDraftReportedUsd:
            totalReportedCostUsd !== null && completed.length
                ? totalReportedCostUsd / completed.length
                : null,
        wallMs: {
            median: percentile(walls, 50),
            p95: percentile(walls, 95),
            mean: walls.length
                ? Math.round(
                      walls.reduce((sum, value) => sum + value, 0) /
                          walls.length,
                  )
                : null,
        },
        accuracy: {
            expectedItems,
            expectedItemsCompleted: expectedCompleted,
            matchedItems,
            draftItems,
            groundedItems,
            recall: expectedItems ? matchedItems / expectedItems : 0,
            recallCompletedTasksOnly: expectedCompleted
                ? matchedItems / expectedCompleted
                : 0,
            precision: draftItems ? matchedItems / draftItems : null,
            groundedShare: draftItems ? groundedItems / draftItems : null,
            portionChecked,
            portionInRange,
            portionInRangeRate: portionChecked
                ? portionInRange / portionChecked
                : null,
            fabricatedIds,
            fabricatedNutrition,
        },
        callsByRole,
        deciderCallsOk: tasks.reduce(
            (sum, task) => sum + task.deciderCallsOk,
            0,
        ),
        deciderErrorSamples: [
            ...new Set(tasks.flatMap((task) => task.deciderErrorSamples)),
        ].slice(0, 5),
        tasksWithTieBreak: completed.filter((task) => task.tieBreakUsed).length,
        tasksWithEstimate: completed.filter((task) => task.estimatedItems > 0)
            .length,
        estimatedItems: completed.reduce(
            (sum, task) => sum + task.estimatedItems,
            0,
        ),
        blockingItems: completed.reduce(
            (sum, task) => sum + task.blockingItems,
            0,
        ),
        searchFailureCount,
        searchFailureSamples,
        servedModels,
        providersSeen,
        meanDraftCaloriesByFixture,
        tasks,
    };
    configReports.push(report);
    console.info(
        `[fulleval] ${config.label} DONE recall=${report.accuracy.recall.toFixed(3)} precision=${report.accuracy.precision?.toFixed(3) ?? "n/a"} grounded=${report.accuracy.groundedShare?.toFixed(3) ?? "n/a"} failures=${report.tasksFailed}/${report.tasksAttempted}`,
    );
}

// Cross-config calorie spread per fixture (comparison only — the real
// set carries no calorie ground truth).
const calorieSpread = fixtures.map((fixture) => {
    const perConfig: Record<string, number | null> = {};
    const values: number[] = [];
    for (const report of configReports) {
        const value = report.meanDraftCaloriesByFixture[fixture.id] ?? null;
        perConfig[report.label] = value;
        if (value !== null) values.push(value);
    }
    return {
        fixtureId: fixture.id,
        perConfig,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        mean: values.length
            ? Math.round(
                  (values.reduce((sum, value) => sum + value, 0) /
                      values.length) *
                      10,
              ) / 10
            : null,
        spreadPctOfMean:
            values.length && Math.min(...values) > 0
                ? (Math.max(...values) - Math.min(...values)) /
                  (values.reduce((sum, value) => sum + value, 0) /
                      values.length)
                : null,
    };
});

const ranked = [...configReports].sort(
    (a, b) =>
        b.accuracy.recall - a.accuracy.recall ||
        (b.accuracy.precision ?? 0) - (a.accuracy.precision ?? 0),
);
const totalReportedSpend = configReports.reduce(
    (sum, report) => sum + (report.totalReportedCostUsd ?? 0),
    0,
);
const totalComputedSpend = configReports.reduce(
    (sum, report) => sum + (report.totalComputedCostUsd ?? 0),
    0,
);

const reportJson = {
    run_at: runStartedAt,
    lane: "full-pipeline-real-photos",
    fixtures_dir: "fixtures/photo-eval-real",
    fixtures: fixtures.length,
    repeats,
    concurrency,
    grounding:
        "live USDA + Open Food Facts via FoodProviderRegistry (local catalog layer skipped: no Postgres in this lane)",
    prices_per_million_tokens: PRICE_TABLE,
    jev_1_14: {
        slug: JEV_SLUG,
        endpoints_api:
            "Not present in the OpenRouter /models list, but the endpoints API returns a live endpoint: TypeSafe | typesafe/jev-1.14-20261014 (status 0), modality text+image -> decisions, pricing $0.042 per 1M input tokens / $0 output, supported_parameters listed as [].",
        shape_probes: jevProbes,
        note: "Sampled DIRECTLY as Michael directed — no router substitution. If the probes show the production call shapes are rejected, the decider-seat numbers for its hybrids reflect deterministic fallback (grounding catches decider errors by design) and the per-config decider call stats + error samples in this report are the evidence.",
    },
    jev_router: {
        slug: JEV_ROUTER_SLUG,
        note: "Runs as ONE extra, clearly-labelled decider config. It routes per call to other models and does NOT count as the Jev result; servedModels per config show what actually served its calls. Pricing is dynamic: computed cost n/a, API-reported cost is the figure of record.",
    },
    glm_note:
        "z-ai/glm-5.3-flash excluded: the production call shape cannot drive it (reasoning-mandatory endpoint, HTTP 400); see its Layer-1 results in the bake-off reports.",
    flash4_note:
        "deepseek/deepseek-v4-flash is TEXT-ONLY (no image modality in the OpenRouter catalog) and cannot be tested on photos; deepseek/deepseek-v4-flash-vision-exp is the Flash-4 family's vision member and is the 'Flash 4' entry in this matrix.",
    caveat: "Real photographs from openly licensed sources; expectations are conservative (visible items only) so precision is a lower bound; portions scored only on the portion-bearing subset (25 of 67 items); draft calories have NO ground truth in this set and are reported as cross-model comparison only.",
    total_computed_spend_usd: totalComputedSpend,
    total_reported_spend_usd: totalReportedSpend,
    ranked_configs: ranked.map((report) => report.label),
    configs: configReports,
    calorie_spread_by_fixture: calorieSpread,
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "report.json"), JSON.stringify(reportJson, null, 2));

const pct = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) =>
    value === null ? "n/a" : `${value.toLocaleString()} ms`;
const usd = (value: number | null) =>
    value === null ? "n/a" : `$${value.toFixed(5)}`;
const lines = [
    `# Full-pipeline photo eval — real-photo set`,
    ``,
    `Run: ${runStartedAt} · Fixtures: ${fixtures.length} real photographs · Repeats: ${repeats} · Tasks per config: ${fixtures.length * repeats} · Grounding: live USDA + Open Food Facts via the provider registry (local catalog skipped — no Postgres in this lane) · Total spend: $${totalComputedSpend.toFixed(4)} computed / $${totalReportedSpend.toFixed(4)} API-reported`,
    ``,
    `Every config ran the true production pipeline (identify → database search/grounding → decider tie-break → labelled estimate fallback → filled draft items), wired as production wires it (src/app/routes.ts). Hybrid configs differ ONLY in the harness's dependency wiring: the decider role is routed to the second model; identify + estimate stay with the first. Cost per completed draft sums ALL model calls (identify + decider + estimate).`,
    ``,
    `> **Jev-1.14 (the decision model, sampled directly):** endpoint live on OpenRouter (\`TypeSafe | typesafe/jev-1.14-20261014\`, modality text+image → decisions, $0.042/1M input, $0 output) though absent from the /models list. Shape probes with the REAL production calls: ${jevProbes.map((probe) => `**${probe.shape}** ${probe.ok ? `OK — ${probe.detail}` : `FAILED — ${probe.detail}${probe.errorExcerpts.length ? ` · API errors: ${probe.errorExcerpts.join(" | ")}` : ""}`}`).join("; ") || "not run"}. No router substitution anywhere in the Jev rows.`,
    ``,
    `> **jev-router** appears in exactly one config, labelled ROUTER wherever it appears: it routes per call to other models (see its served-models note) and does **not** count as the Jev result. Its pricing is dynamic, so its computed cost is n/a; API-reported cost is its figure of record.`,
    ``,
    `> **Flash 4:** \`deepseek/deepseek-v4-flash\` is TEXT-ONLY (no image modality) and cannot be tested on photos; \`deepseek/deepseek-v4-flash-vision-exp\` is the family's vision member and is the Flash-4 entry below. **GLM** is excluded: the production call shape cannot drive it (HTTP 400, reasoning-mandatory) — see its Layer-1 results.`,
    ``,
    `| Rank | Config | Cost/draft (computed) | Cost/draft (reported) | Median | p95 | Recall | Precision | Grounded | Portions in range | Fabrications | Failures |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...ranked.map(
        (report, index) =>
            `| ${index + 1} | ${report.label} | ${usd(report.costPerCompletedDraftComputedUsd)} | ${usd(report.costPerCompletedDraftReportedUsd)} | ${ms(report.wallMs.median)} | ${ms(report.wallMs.p95)} | ${pct(report.accuracy.recall)} | ${pct(report.accuracy.precision)} | ${pct(report.accuracy.groundedShare)} | ${pct(report.accuracy.portionInRangeRate)} (${report.accuracy.portionInRange}/${report.accuracy.portionChecked}) | ${report.accuracy.fabricatedIds + report.accuracy.fabricatedNutrition} | ${report.tasksFailed}/${report.tasksAttempted} |`,
    ),
    ``,
    `## Per-config notes`,
    ``,
    ...configReports.flatMap((report) => {
        const notes: string[] = [
            `- **${report.label}** — calls: identify ${report.callsByRole.identify}, decider ${report.callsByRole.decider} attempted / ${report.deciderCallsOk} HTTP-ok (a selection was applied in ${report.tasksWithTieBreak}/${report.tasksCompleted} completed tasks), estimate ${report.callsByRole.estimate} (${report.estimatedItems} items estimate-filled, ${report.blockingItems} blocking). Served models: ${
                Object.entries(report.servedModels)
                    .map(([model, count]) => `${model} (${count} tasks)`)
                    .join(", ") || "none recorded"
            }.`,
        ];
        if (report.deciderErrorSamples.length > 0) {
            notes.push(
                `  Decider call errors: ${report.deciderErrorSamples.join(" · ")}`,
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
            notes.push(`  Failures: ${report.tasksFailed}. First: ${sample}`);
        }
        if (report.searchFailureCount > 0) {
            notes.push(
                `  Provider search failures recorded: ${report.searchFailureCount}. Samples: ${report.searchFailureSamples.join(" · ")}`,
            );
        }
        return notes;
    }),
    ``,
    `## Draft calorie estimates by fixture (comparison only — no ground truth)`,
    ``,
    `Mean draft calories per config across repeats; spread shows how far apart the configs land on the same photo.`,
    ``,
    `| Fixture | Min | Mean | Max | Spread (% of mean) |`,
    `|---|---|---|---|---|`,
    ...[...calorieSpread]
        .sort((a, b) => (b.spreadPctOfMean ?? 0) - (a.spreadPctOfMean ?? 0))
        .map(
            (row) =>
                `| ${row.fixtureId} | ${row.min ?? "n/a"} | ${row.mean ?? "n/a"} | ${row.max ?? "n/a"} | ${pct(row.spreadPctOfMean)} |`,
        ),
    ``,
    `> **Caveat:** ${reportJson.caveat}`,
    ``,
    `Full per-task detail (draft items, served models, search failures): report.json.`,
    ``,
];
await writeFile(join(OUT, "report.md"), lines.join("\n"));
console.info(lines.join("\n"));
