import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DecisionsFetcher } from "../decisions/client.js";
import type { DecisionsConfig } from "../decisions/config.js";
import {
    DeciderChoiceCache,
    chooseCandidatesViaDecisions,
} from "../decisions/decider.js";
import { reviewDraftNumbers } from "../decisions/draft-review.js";
import type {
    CatalogHit,
    FoodCatalogRepository,
} from "../food-providers/catalog-repository.js";
import { FoodProviderRegistry } from "../food-providers/registry.js";
import { FoodSearchService } from "../food-providers/service.js";
import type { FoodCandidate, FoodProvider } from "../food-providers/types.js";
import { UsdaFoodDataCentralProvider } from "../food-providers/usda.js";
import { needsPortionChoice, resolveMealPhotoPicks } from "./grounding.js";
import {
    groundAndReviewMealPhotoItems,
    identifyWithMealPhotoGate,
} from "./pipeline.js";
import { MealPhotoNoFoodError, type MealPhotoVisionItem } from "./vision.js";

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "2707152",
        name: "Grilled chicken breast, cooked",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 165,
            protein_g: 31,
            carbs_g: 0,
            fat_g: 3.6,
        },
        portions: [
            {
                id: "breast-1",
                amount: 1,
                unit: "serving",
                label: "1 breast",
                gramWeight: 172,
                nutrients: {
                    calories: 283.8,
                    protein_g: 53.32,
                    carbs_g: 0,
                    fat_g: 6.19,
                },
            },
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients: {
                    calories: 165,
                    protein_g: 31,
                    carbs_g: 0,
                    fat_g: 3.6,
                },
            },
        ],
        attribution: { label: "USDA FoodData Central" },
        confidence: 0.95,
        ...overrides,
    };
}

function testDecisionsConfig(
    overrides: Partial<DecisionsConfig> = {},
): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14"],
        photoGroundingModels: ["typesafe/jev-1.14"],
        gateTimeoutMs: 500,
        deciderTimeoutMs: 500,
        matchTimeoutMs: 500,
        gateEnabled: true,
        deciderEnabled: true,
        outlierTimeoutMs: 500,
        outlierEnabled: false,
        chatClaimsEnabled: false,
        chatClaimsTimeoutMs: 500,
        matchEnabled: false,
        draftReviewTimeoutMs: 500,
        draftReviewEnabled: true,
        plausibilityTimeoutMs: 500,
        plausibilityEnabled: false,
        pantryMatchEnabled: false,
        pantryMatchTimeoutMs: 500,
        drawdownReviewEnabled: false,
        drawdownReviewTimeoutMs: 500,
        ...overrides,
    };
}

describe("meal-photo latency optimizations", () => {
    test("identifyWithMealPhotoGate runs gate and vision in parallel on food photos", async () => {
        const events: string[] = [];
        const startedAt = performance.now();
        const vision = await identifyWithMealPhotoGate({
            runGate: async () => {
                events.push("gate:start");
                await Bun.sleep(40);
                events.push("gate:end");
                return { action: "proceed", reason: "food_probable" };
            },
            runIdentify: async () => {
                events.push("vision:start");
                await Bun.sleep(60);
                events.push("vision:end");
                return {
                    items: [
                        {
                            name: "chicken breast",
                            cooking_method: "grilled",
                            quantity: 160,
                            unit: "g",
                            portion_confidence: 0.9,
                            assumptions: [],
                        },
                    ],
                };
            },
        });
        const elapsedMs = performance.now() - startedAt;
        expect(vision.items).toHaveLength(1);
        // Both started before either finished.
        expect(events.slice(0, 2)).toEqual(["gate:start", "vision:start"]);
        // Wall time is ~max(40, 60) rather than 40 + 60 = 100.
        expect(elapsedMs).toBeLessThan(95);
    });

    test("identifyWithMealPhotoGate aborts in-flight vision immediately when gate rejects non-food", async () => {
        let visionAborted = false;
        const startedAt = performance.now();
        await expect(
            identifyWithMealPhotoGate({
                runGate: async () => {
                    await Bun.sleep(15);
                    return {
                        action: "no_food",
                        reason: "confident_not_food",
                        model: "typesafe/jev-1.14",
                        pFood: 0.01,
                        threshold: 0.1,
                        route: "other",
                    };
                },
                runIdentify: (signal) =>
                    new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => resolve({ items: [] }),
                            500,
                        );
                        signal.addEventListener("abort", () => {
                            clearTimeout(timer);
                            visionAborted = true;
                            reject(signal.reason);
                        });
                    }),
            }),
        ).rejects.toBeInstanceOf(MealPhotoNoFoodError);
        const elapsedMs = performance.now() - startedAt;
        expect(visionAborted).toBe(true);
        expect(elapsedMs).toBeLessThan(150);
    });

    test("needsPortionChoice skips weight-unit, single-portion, and unique exact unit matches, but keeps ambiguous count/undetermined portions", () => {
        const chicken = candidate();
        const oliveOil = candidate({
            providerFoodId: "oil-1",
            name: "Olive oil",
            portions: [
                {
                    id: "tbsp-1",
                    amount: 1,
                    unit: "tbsp",
                    label: "1 tablespoon",
                    gramWeight: 13.5,
                    nutrients: { calories: 119 },
                },
                {
                    id: "cup-1",
                    amount: 1,
                    unit: "cup",
                    label: "1 cup",
                    gramWeight: 216,
                    nutrients: { calories: 1909 },
                },
            ],
        });
        const mustard = candidate({
            providerFoodId: "mustard-1",
            name: "Mustard",
            portions: [
                {
                    id: "pkt",
                    amount: 1,
                    unit: "serving",
                    label: "1 packet",
                    gramWeight: 5,
                    nutrients: { calories: 3.45 },
                },
                {
                    id: "tbsp-real",
                    amount: 1,
                    unit: "undetermined",
                    label: "1 tablespoon",
                    gramWeight: 15,
                    nutrients: { calories: 10.35 },
                },
            ],
        });

        // Weight unit with nutrientsPer100g -> deterministic exact math, skip.
        expect(
            needsPortionChoice(
                {
                    name: "chicken",
                    cooking_method: "grilled",
                    quantity: 160,
                    unit: "g",
                    portion_confidence: 0.9,
                    assumptions: [],
                },
                chicken,
                chicken.portions,
            ),
        ).toBe(false);

        // Single-portion candidate -> nothing to choose between, skip.
        expect(
            needsPortionChoice(
                {
                    name: "chicken",
                    cooking_method: null,
                    quantity: 1,
                    unit: "piece",
                    portion_confidence: 0.9,
                    assumptions: [],
                },
                chicken,
                [chicken.portions[0]!],
            ),
        ).toBe(false);

        // Unique exact unit match ("tbsp" against single "tbsp" portion) -> skip.
        expect(
            needsPortionChoice(
                {
                    name: "olive oil",
                    cooking_method: null,
                    quantity: 1,
                    unit: "tbsp",
                    portion_confidence: 0.8,
                    assumptions: [],
                },
                oliveOil,
                oliveOil.portions,
            ),
        ).toBe(false);

        // Ambiguous count ("piece" against "serving" / "100g") -> keep portion decider.
        expect(
            needsPortionChoice(
                {
                    name: "chicken",
                    cooking_method: "grilled",
                    quantity: 1,
                    unit: "piece",
                    portion_confidence: 0.9,
                    assumptions: [],
                },
                chicken,
                chicken.portions,
            ),
        ).toBe(true);

        // USDA "undetermined" volume unit -> keep portion decider.
        expect(
            needsPortionChoice(
                {
                    name: "mustard",
                    cooking_method: null,
                    quantity: 1,
                    unit: "tbsp",
                    portion_confidence: 0.9,
                    assumptions: [],
                },
                mustard,
                mustard.portions,
            ),
        ).toBe(true);
    });

    test("Stage 3 pre-fetches refinement when initial search returns 0 candidates, folding into the first decider call", async () => {
        const vision: MealPhotoVisionItem = {
            name: "broccoli",
            cooking_method: "steamed",
            quantity: 90,
            unit: "g",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const broccoli = candidate({
            providerFoodId: "169967",
            name: "Broccoli, cooked, steamed",
        });
        const queries: string[] = [];
        let deciderCalls = 0;
        let portionCalls = 0;
        const resolved = await resolveMealPhotoPicks([vision], {
            search: async (query) => {
                queries.push(query);
                return {
                    candidates: query.includes("steamed") ? [broccoli] : [],
                    failures: [],
                };
            },
            chooseCandidates: async () => {
                deciderCalls += 1;
                return new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:169967",
                            confidence: 0.95,
                            rationale: null,
                        },
                    ],
                ]);
            },
            choosePortions: async () => {
                portionCalls += 1;
                return new Map();
            },
        });
        expect(queries).toEqual(["broccoli", "broccoli steamed"]);
        expect(deciderCalls).toBe(1);
        expect(portionCalls).toBe(0);
        expect(resolved.picks[0]?.candidate?.providerFoodId).toBe("169967");
    });

    test("groundAndReviewMealPhotoItems overlaps Stage 4c estimate with Stage 5 A3 draft review", async () => {
        const events: string[] = [];
        const items: MealPhotoVisionItem[] = [
            {
                name: "grilled chicken breast",
                cooking_method: "grilled",
                quantity: 1,
                unit: "serving",
                portion_confidence: 0.9,
                assumptions: [],
            },
            {
                name: "homemade curry",
                cooking_method: null,
                quantity: 1,
                unit: "bowl",
                portion_confidence: 0.7,
                assumptions: [],
            },
        ];
        const fetcher: DecisionsFetcher = async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            events.push("review:start");
            await Bun.sleep(50);
            events.push("review:end");
            const answers: Record<string, unknown> = {};
            for (const key of Object.keys(body.questions ?? {})) {
                answers[key] = { type: "noul", noul: 0.97 };
            }
            return new Response(
                JSON.stringify({ answers, usage: { cost: 0.00005 } }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        };

        const startedAt = performance.now();
        const result = await groundAndReviewMealPhotoItems({
            items,
            groundingDeps: {
                search: async (query) => ({
                    candidates: query.includes("chicken") ? [candidate()] : [],
                    failures: [],
                }),
                chooseCandidates: async () =>
                    new Map([
                        [
                            "item:0",
                            {
                                candidateId: "usda:2707152",
                                confidence: 0.95,
                                rationale: null,
                            },
                        ],
                    ]),
                estimateNutrients: async () => {
                    events.push("estimate:start");
                    await Bun.sleep(50);
                    events.push("estimate:end");
                    return new Map([
                        [
                            "item:1",
                            {
                                nutrients: {
                                    calories: 380,
                                    protein_g: 22,
                                    carbs_g: 34,
                                    fat_g: 16,
                                },
                                gramWeight: 260,
                            },
                        ],
                    ]);
                },
            },
            draftReviewDeps: { config: testDecisionsConfig(), fetcher },
        });
        const elapsedMs = performance.now() - startedAt;
        // Both started before either completed (overlapped, not serial 100ms).
        expect(events.slice(0, 2).sort()).toEqual([
            "estimate:start",
            "review:start",
        ]);
        expect(elapsedMs).toBeLessThan(95);
        expect(result.grounded[0]?.grounded).toBe(true);
        expect(result.grounded[0]?.candidate?.providerFoodId).toBe("2707152");
        expect(result.grounded[1]?.estimated).toBe(true);
        expect(result.review.status).toBe("reviewed");
    });

    test("FoodSearchService short-circuits preferGeneric locally with >= 5 generic hits and defers write-back when requested", async () => {
        let providerCalls = 0;
        const localHits: CatalogHit[] = Array.from({ length: 6 }, (_, i) => ({
            stale: false,
            candidate: candidate({
                providerFoodId: `chk-${i}`,
                name:
                    i === 0
                        ? "Chicken breast, grilled"
                        : `Chicken breast, variant ${i}`,
            }),
        }));
        const provider: FoodProvider = {
            name: "usda",
            async search() {
                providerCalls += 1;
                return [candidate({ providerFoodId: "remote-1" })];
            },
        };
        const service = new FoodSearchService(
            new FoodProviderRegistry([provider]),
            {
                async findCachedSearch() {
                    return null;
                },
                async searchLocal() {
                    return localHits;
                },
                async isNegative() {
                    return false;
                },
                async upsertAndRecordSearch() {},
                async recordSearch() {},
                async recordNegative() {},
            } as unknown as FoodCatalogRepository,
        );
        const result = await service.search("grilled chicken breast", 30, {
            preferGeneric: true,
        });
        expect(result.candidates).toHaveLength(6);
        expect(providerCalls).toBe(0);

        // Now verify deferWriteBack returns before a slow write completes.
        let writeStarted = false;
        let writeCompleted = false;
        const slowWriteService = new FoodSearchService(
            new FoodProviderRegistry([provider]),
            {
                async findCachedSearch() {
                    return null;
                },
                async searchLocal() {
                    return [];
                },
                async isNegative() {
                    return false;
                },
                async upsertAndRecordSearch() {
                    writeStarted = true;
                    await Bun.sleep(60);
                    writeCompleted = true;
                },
                async recordSearch() {},
                async recordNegative() {},
            } as unknown as FoodCatalogRepository,
        );
        const t0 = performance.now();
        const deferred = await slowWriteService.search("quinoa", 30, {
            preferGeneric: true,
            deferWriteBack: true,
        });
        expect(deferred.candidates).toHaveLength(1);
        expect(writeStarted).toBe(true);
        expect(writeCompleted).toBe(false);
        expect(performance.now() - t0).toBeLessThan(40);
    });

    test("UsdaFoodDataCentralProvider skips branded fallback once >= 10 generics return, and parallelizes multi-word 0-hit recovery", async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const provider = new UsdaFoodDataCentralProvider({
            apiKey: "test-key",
            fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? "{}"));
                bodies.push(body);
                return new Response(
                    JSON.stringify({
                        foods: Array.from({ length: 12 }, (_, i) => ({
                            fdcId: 100 + i,
                            description: `Rice, cooked ${i}`,
                            dataType: "Survey (FNDDS)",
                            foodNutrients: [{ nutrientId: 1008, value: 130 }],
                        })),
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }) as typeof fetch,
        });
        const results = await provider.search({
            query: "cooked rice",
            limit: 30,
            preferGeneric: true,
        });
        expect(results).toHaveLength(12);
        // Only ONE USDA HTTP call (no wasted branded fallback).
        expect(bodies).toHaveLength(1);

        // Multi-word 0-hit strict pass runs relaxed-generic + unfiltered in parallel.
        let inFlight = 0;
        let maxInFlight = 0;
        const parallelProvider = new UsdaFoodDataCentralProvider({
            apiKey: "test-key",
            fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? "{}"));
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await Bun.sleep(25);
                inFlight -= 1;
                if (body.requireAllWords && Array.isArray(body.dataType)) {
                    return new Response(JSON.stringify({ foods: [] }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    });
                }
                return new Response(
                    JSON.stringify({
                        foods: [
                            {
                                fdcId: Array.isArray(body.dataType) ? 1 : 2,
                                description: Array.isArray(body.dataType)
                                    ? "Chicken, cooked"
                                    : "BRANDED CHICKEN",
                                dataType: Array.isArray(body.dataType)
                                    ? "SR Legacy"
                                    : "Branded",
                                foodNutrients: [
                                    { nutrientId: 1008, value: 165 },
                                ],
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }) as typeof fetch,
        });
        const merged = await parallelProvider.search({
            query: "chargrilled chicken",
            limit: 30,
            preferGeneric: true,
        });
        expect(maxInFlight).toBe(2);
        expect(merged.map((c) => c.providerFoodId)).toEqual(["1", "2"]);
    });

    test("FoodProviderRegistry skips Open Food Facts on preferGeneric when USDA returns >= 3 generics, but falls back when sparse", async () => {
        let offCalls = 0;
        let usdaCount = 4;
        const usda: FoodProvider = {
            name: "usda",
            async search() {
                return Array.from({ length: usdaCount }, (_, i) =>
                    candidate({
                        providerFoodId: `u-${i}`,
                        name: `Broccoli ${i}`,
                    }),
                );
            },
        };
        const off: FoodProvider = {
            name: "open_food_facts",
            async search() {
                offCalls += 1;
                return [
                    candidate({
                        provider: "open_food_facts",
                        providerFoodId: "off-1",
                        name: "Clif Bar",
                        dataKind: "packaged",
                    }),
                ];
            },
        };
        const registry = new FoodProviderRegistry([usda, off]);

        const genericResult = await registry.search({
            query: "broccoli",
            limit: 30,
            preferGeneric: true,
        });
        expect(genericResult.candidates).toHaveLength(4);
        expect(offCalls).toBe(0);

        usdaCount = 1;
        const packagedResult = await registry.search({
            query: "clif bar",
            limit: 30,
            preferGeneric: true,
        });
        expect(offCalls).toBe(1);
        expect(
            packagedResult.candidates.some(
                (c) => c.provider === "open_food_facts",
            ),
        ).toBe(true);
    });

    test("reviewDraftNumbers runs >8-item chunks concurrently", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const fetcher: DecisionsFetcher = async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Bun.sleep(40);
            inFlight -= 1;
            const answers: Record<string, unknown> = {};
            for (const key of Object.keys(body.questions ?? {})) {
                answers[key] = { type: "noul", noul: 0.96 };
            }
            return new Response(
                JSON.stringify({ answers, usage: { cost: 0.00005 } }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        };
        const items = Array.from({ length: 10 }, (_, i) => ({
            foodName: `Food ${i}`,
            portionLabel: "100 g",
            grams: 100,
            kcal: 150,
            groundingSource: "USDA",
        }));
        const outcome = await reviewDraftNumbers(items, {
            config: testDecisionsConfig(),
            fetcher,
        });
        expect(outcome.status).toBe("reviewed");
        expect(outcome.verdicts).toHaveLength(10);
        expect(outcome.verdicts.map((v) => v.index)).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
        ]);
        expect(maxInFlight).toBe(2);
    });

    test("client and mobile wiring: parallel downscale, initialDraft fast open, and native camera target dimensions", () => {
        const appJs = readFileSync(
            new URL("../../public/app.js", import.meta.url),
            "utf8",
        );
        const mobileRuntime = readFileSync(
            new URL("../../mobile/runtime.js", import.meta.url),
            "utf8",
        );
        expect(appJs).toContain(
            "async function openMealDraft(id, { initialDraft = null } = {})",
        );
        expect(appJs).toContain("initialDraft: result.draft");
        expect(appJs).toContain(
            "selected.map((file) => downscaleImageFile(file))",
        );
        expect(mobileRuntime).toContain("targetWidth: 1568");
        expect(mobileRuntime).toContain("targetHeight: 1568");
    });

    test("DeciderChoiceCache serves full and partial batch hits without calling Decisions API", async () => {
        const cache = new DeciderChoiceCache();
        let apiCalls = 0;
        const requestedItems: string[][] = [];
        const fetcher: DecisionsFetcher = async (_url, init) => {
            apiCalls += 1;
            const body = JSON.parse(String(init?.body ?? "{}"));
            const items = (body.state?.items ?? []) as Array<{
                question: string;
                photographed_item: string;
            }>;
            requestedItems.push(items.map((item) => item.photographed_item));
            const answers: Record<string, unknown> = {};
            for (const item of items) {
                answers[item.question] = {
                    type: "choice",
                    choice: "c0",
                    confidence: 0.94,
                };
            }
            return new Response(
                JSON.stringify({ answers, usage: { cost: 0.00005 } }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        };
        const cfg = testDecisionsConfig();
        const chickenReq = {
            key: "item:0",
            itemName: "grilled chicken breast",
            cookingMethod: "grilled",
            candidates: [
                {
                    candidateId: "usda:1",
                    name: "Chicken breast, grilled",
                    brand: null,
                    provider: "usda",
                },
            ],
        };
        const riceReq = {
            key: "item:1",
            itemName: "cooked white rice",
            cookingMethod: "steamed",
            candidates: [
                {
                    candidateId: "usda:2",
                    name: "Rice, white, cooked",
                    brand: null,
                    provider: "usda",
                },
            ],
        };

        const first = await chooseCandidatesViaDecisions([chickenReq], cfg, {
            fetcher,
            cache,
        });
        expect(first.get("item:0")?.candidateId).toBe("usda:1");
        expect(apiCalls).toBe(1);

        const second = await chooseCandidatesViaDecisions([chickenReq], cfg, {
            fetcher,
            cache,
        });
        expect(second.get("item:0")?.candidateId).toBe("usda:1");
        expect(apiCalls).toBe(1);

        const third = await chooseCandidatesViaDecisions(
            [chickenReq, riceReq],
            cfg,
            { fetcher, cache },
        );
        expect(third.get("item:0")?.candidateId).toBe("usda:1");
        expect(third.get("item:1")?.candidateId).toBe("usda:2");
        expect(apiCalls).toBe(2);
        expect(requestedItems[1]).toEqual(["cooked white rice"]);
    });

    test("FoodSearchService hotSearchCache serves repeat searches with zero DB or provider calls and details(requirePortions) hydrates summary rows", async () => {
        let localCalls = 0;
        let detailsProviderCalls = 0;
        const summary = candidate({
            providerFoodId: "748608",
            name: "Olive oil",
            portions: [
                {
                    id: "100g",
                    amount: 100,
                    unit: "g",
                    label: "100 g",
                    gramWeight: 100,
                    nutrients: { calories: 884, fat_g: 100 },
                },
            ],
        });
        const detailed = candidate({
            providerFoodId: "748608",
            name: "Olive oil",
            portions: [
                {
                    id: "tbsp-1",
                    amount: 1,
                    unit: "tbsp",
                    label: "1 tablespoon",
                    gramWeight: 13.5,
                    nutrients: { calories: 119.34, fat_g: 13.5 },
                },
                ...summary.portions,
            ],
        });
        const localHits: CatalogHit[] = Array.from({ length: 5 }, (_, i) => ({
            stale: false,
            candidate:
                i === 0
                    ? summary
                    : candidate({
                          providerFoodId: `oil-${i}`,
                          name: `Olive oil ${i}`,
                      }),
        }));
        const provider: FoodProvider = {
            name: "usda",
            async search() {
                return [summary];
            },
            async getDetails() {
                detailsProviderCalls += 1;
                return detailed;
            },
        };
        const service = new FoodSearchService(
            new FoodProviderRegistry([provider]),
            {
                async findCachedSearch() {
                    return null;
                },
                async searchLocal() {
                    localCalls += 1;
                    return localHits;
                },
                async findByProviderId() {
                    return { candidate: summary, stale: false };
                },
                async isNegative() {
                    return false;
                },
                async upsert() {},
                async upsertAndRecordSearch() {},
                async recordSearch() {},
                async recordNegative() {},
            } as unknown as FoodCatalogRepository,
        );

        await service.search("olive oil", 30, { preferGeneric: true });
        await service.search("olive oil", 30, { preferGeneric: true });
        expect(localCalls).toBe(1);

        const hydrated = await service.details("usda:748608", {
            requirePortions: true,
            deferWriteBack: true,
        });
        expect(detailsProviderCalls).toBe(1);
        expect(hydrated?.portions).toHaveLength(2);
    });

    test("cold-miss details() hydrates USDA household portions before falling back to model estimate", async () => {
        const oilVision: MealPhotoVisionItem = {
            name: "olive oil",
            cooking_method: null,
            quantity: 1,
            unit: "tbsp",
            portion_confidence: 0.7,
            assumptions: [],
        };
        const summaryOnlyOil = candidate({
            providerFoodId: "748608",
            name: "Oil, olive, extra virgin",
            nutrientsPer100g: { calories: 884, fat_g: 100 },
            portions: [
                {
                    id: "100g",
                    amount: 100,
                    unit: "g",
                    label: "100 g",
                    gramWeight: 100,
                    nutrients: { calories: 884, fat_g: 100 },
                },
            ],
        });
        const detailedOil = candidate({
            providerFoodId: "748608",
            name: "Oil, olive, extra virgin",
            nutrientsPer100g: { calories: 884, fat_g: 100 },
            portions: [
                {
                    id: "tbsp-1",
                    amount: 1,
                    unit: "tbsp",
                    label: "1 tablespoon",
                    gramWeight: 13.5,
                    nutrients: { calories: 119.34, fat_g: 13.5 },
                },
                ...summaryOnlyOil.portions,
            ],
        });

        let detailsCalls = 0;
        let estimateCalls = 0;
        const resolved = await resolveMealPhotoPicks([oilVision], {
            search: async () => ({
                candidates: [summaryOnlyOil],
                failures: [],
            }),
            details: async (id) => {
                detailsCalls += 1;
                expect(id).toBe("usda:748608");
                return detailedOil;
            },
            chooseCandidates: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:748608",
                            confidence: 0.96,
                            rationale: null,
                        },
                    ],
                ]),
            estimateNutrients: async () => {
                estimateCalls += 1;
                return new Map();
            },
        });
        expect(detailsCalls).toBe(1);
        expect(estimateCalls).toBe(0);
        expect(resolved.estimateRequests).toHaveLength(0);
        expect(resolved.picks[0]?.resolution?.gramWeight).toBe(13.5);
        expect(resolved.picks[0]?.resolution?.nutrients.calories).toBeCloseTo(
            119.34,
            1,
        );
    });
});
