import { describe, expect, test } from "bun:test";
import type { DecisionsFetcher } from "../decisions/client.js";
import type { DecisionsConfig } from "../decisions/config.js";
import {
    chooseCandidatesViaDecisions,
    choosePortionsViaDecisions,
} from "../decisions/decider.js";
import type {
    CatalogHit,
    FoodCatalogRepository,
} from "../food-providers/catalog-repository.js";
import { rankCandidates } from "../food-providers/ranking.js";
import { FoodProviderRegistry } from "../food-providers/registry.js";
import { FoodSearchService } from "../food-providers/service.js";
import type { FoodCandidate, FoodProvider } from "../food-providers/types.js";
import { UsdaFoodDataCentralProvider } from "../food-providers/usda.js";
import { groundMealPhotoItems, isAmbiguous } from "./grounding.js";
import type { MealPhotoVisionItem } from "./vision.js";

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "2707152",
        name: "Egg, whole, raw",
        dataKind: "generic",
        nutrientsPer100g: {
            calories: 143,
            protein_g: 12.6,
            carbs_g: 0.7,
            fat_g: 9.5,
            fiber_g: 0,
            sugar_g: 0.4,
            sodium_mg: 142,
            saturated_fat_g: 3.1,
            cholesterol_mg: 372,
            potassium_mg: 138,
        },
        portions: [
            {
                id: "egg-1",
                amount: 1,
                unit: "serving",
                label: "1 egg",
                gramWeight: 50,
                nutrients: {
                    calories: 71.5,
                    protein_g: 6.3,
                    carbs_g: 0.35,
                    fat_g: 4.75,
                },
            },
            {
                id: "cup-1",
                amount: 1,
                unit: "cup",
                label: "1 cup",
                gramWeight: 243,
                nutrients: {
                    calories: 347.5,
                    protein_g: 30.6,
                    carbs_g: 1.7,
                    fat_g: 23.1,
                },
            },
            {
                id: "100g",
                amount: 100,
                unit: "g",
                label: "100 g",
                gramWeight: 100,
                nutrients: {
                    calories: 143,
                    protein_g: 12.6,
                    carbs_g: 0.7,
                    fat_g: 9.5,
                },
            },
        ],
        attribution: {
            label: "USDA FoodData Central",
            url: "https://fdc.nal.usda.gov/food/2707152",
        },
        confidence: 0.98,
        ...overrides,
    };
}

function testDecisionsConfig(
    overrides: Partial<DecisionsConfig> = {},
): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        gateTimeoutMs: 500,
        deciderTimeoutMs: 500,
        matchTimeoutMs: 500,
        gateEnabled: true,
        deciderEnabled: true,
        outlierTimeoutMs: 500,
        outlierEnabled: true,
        chatClaimsEnabled: true,
        chatClaimsTimeoutMs: 500,
        matchEnabled: true,
        draftReviewTimeoutMs: 500,
        draftReviewEnabled: true,
        plausibilityTimeoutMs: 500,
        plausibilityEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 500,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 500,
        ...overrides,
    };
}

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00005 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("model-first photo grounding (production path)", () => {
    test("consults the decider for EVERY item, even outside the legacy ambiguity band", async () => {
        const vision: MealPhotoVisionItem = {
            name: "egg",
            cooking_method: "fried",
            quantity: 2,
            unit: "piece",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const wrongTop = candidate({
            providerFoodId: "172673",
            name: "Egg",
            confidence: 0.98,
        });
        const realEgg = candidate({
            providerFoodId: "2707152",
            name: "Egg, whole, raw",
            confidence: 0.5,
        });
        // Confirm this pair is NOT ambiguous under the legacy gate.
        expect(isAmbiguous("egg", [wrongTop, realEgg])).toBe(false);

        let deciderCalls = 0;
        let seenCandidatesCount = 0;
        let seenSearchLimit = 0;
        const [entry] = await groundMealPhotoItems([vision], {
            search: async (_query, limit) => {
                seenSearchLimit = limit ?? 0;
                return { candidates: [wrongTop, realEgg], failures: [] };
            },
            chooseCandidates: async (requests) => {
                deciderCalls += 1;
                seenCandidatesCount = requests[0]?.candidates.length ?? 0;
                return new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:2707152",
                            confidence: 0.95,
                            rationale: null,
                        },
                    ],
                ]);
            },
        });

        expect(seenSearchLimit).toBeGreaterThanOrEqual(25);
        expect(deciderCalls).toBe(1);
        expect(seenCandidatesCount).toBe(2);
        expect(entry?.grounded).toBe(true);
        expect(entry?.tieBreakUsed).toBe(true);
        expect(entry?.candidateId).toBe("usda:2707152");
    });

    test("photo grounding decider uses Jev as lead and carries tuned cross-cooking-method instruction", async () => {
        const seenModels: string[] = [];
        let seenInstructions = "";
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            seenModels.push(body.model);
            seenInstructions = String(body.questions?.q0?.instructions ?? "");
            return decisionsResponse({
                q0: { type: "choice", choice: "c0", confidence: 0.92 },
            });
        };

        // Even if the global chain has Perplexity first, photo grounding's
        // seat lane puts Jev first and Perplexity as fallback.
        const config = testDecisionsConfig({
            models: ["perplexity/pplx-decider-v1.2", "typesafe/jev-1.14"],
        });
        const result = await chooseCandidatesViaDecisions(
            [
                {
                    key: "item:0",
                    itemName: "egg",
                    cookingMethod: "fried",
                    candidates: [
                        {
                            candidateId: "usda:2707152",
                            name: "Egg, whole, raw",
                            brand: null,
                            provider: "usda",
                        },
                    ],
                },
            ],
            config,
            { fetcher },
        );

        expect(seenModels[0]).toBe("typesafe/jev-1.14");
        expect(result.get("item:0")?.candidateId).toBe("usda:2707152");
        // Tuned instruction explicitly teaches generic form across cooking methods.
        expect(seenInstructions.toLowerCase()).toContain("cooking method");
        expect(seenInstructions.toLowerCase()).toContain("same food");
    });

    test("refinement retry: decider abstention triggers one code-driven refined search before estimate", async () => {
        const vision: MealPhotoVisionItem = {
            name: "broccoli",
            cooking_method: "steamed",
            quantity: 1,
            unit: "cup",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const wrongCandidate = candidate({
            providerFoodId: "2709659",
            name: "Soup, broccoli cheese",
        });
        const cookedBroccoli = candidate({
            providerFoodId: "169967",
            name: "Broccoli, cooked, boiled, drained, without salt",
            portions: [
                {
                    id: "cup",
                    amount: 1,
                    unit: "cup",
                    label: "1 cup",
                    gramWeight: 156,
                    nutrients: {
                        calories: 55,
                        protein_g: 3.7,
                        carbs_g: 11.2,
                        fat_g: 0.6,
                    },
                },
            ],
        });

        const searchQueries: string[] = [];
        let deciderCalls = 0;
        const [entry] = await groundMealPhotoItems([vision], {
            search: async (query) => {
                searchQueries.push(query);
                if (query.toLowerCase().includes("steamed")) {
                    return { candidates: [cookedBroccoli], failures: [] };
                }
                return { candidates: [wrongCandidate], failures: [] };
            },
            chooseCandidates: async (requests) => {
                deciderCalls += 1;
                const cands = requests[0]?.candidates ?? [];
                const found = cands.find(
                    (c) => c.candidateId === "usda:169967",
                );
                return new Map([
                    [
                        "item:0",
                        {
                            candidateId: found ? found.candidateId : null,
                            confidence: 0.9,
                            rationale: null,
                        },
                    ],
                ]);
            },
        });

        expect(searchQueries).toEqual(["broccoli", "broccoli steamed"]);
        expect(deciderCalls).toBe(2);
        expect(entry?.grounded).toBe(true);
        expect(entry?.candidateId).toBe("usda:169967");
        expect(entry?.draftItem.nutrients.calories).toBe(55);
    });

    test("abstention after retry routes to estimate / question path — never forces a wrong ground", async () => {
        const vision: MealPhotoVisionItem = {
            name: "rice",
            cooking_method: null,
            quantity: 1,
            unit: "cup",
            portion_confidence: 0.85,
            assumptions: [],
        };
        const riceCake = candidate({
            providerFoodId: "2708162",
            name: "Rice cake",
        });
        const [entry] = await groundMealPhotoItems([vision], {
            search: async () => ({ candidates: [riceCake], failures: [] }),
            chooseCandidates: async () =>
                new Map([
                    [
                        "item:0",
                        { candidateId: null, confidence: 0.9, rationale: null },
                    ],
                ]),
            estimateNutrients: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            nutrients: {
                                calories: 205,
                                protein_g: 4.3,
                                carbs_g: 44.5,
                                fat_g: 0.4,
                            },
                        },
                    ],
                ]),
        });

        expect(entry?.grounded).toBe(false);
        expect(entry?.estimated).toBe(true);
        expect(entry?.draftItem.sourceType).toBe("model_estimate");
        expect(entry?.draftItem.nutrients.calories).toBe(205);
    });

    test("decider error fails open to deterministic ranking for the whole photo", async () => {
        const vision: MealPhotoVisionItem = {
            name: "egg",
            cooking_method: "fried",
            quantity: 100,
            unit: "g",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const [entry] = await groundMealPhotoItems([vision], {
            search: async () => ({ candidates: [candidate()], failures: [] }),
            chooseCandidates: async () => {
                throw new Error("decisions timeout");
            },
        });

        expect(entry?.grounded).toBe(true);
        expect(entry?.candidateId).toBe("usda:2707152");
        expect(entry?.draftItem.nutrients.calories).toBe(143);
    });
});

describe("retrieval hardening (ranking + USDA + local short-circuit)", () => {
    test("ranking handles singular/plural overlap (pancake -> Pancakes, plain) and head-noun priority (rice -> Rice, cooked)", () => {
        const pancakeRanked = rankCandidates({ query: "pancake" }, [
            candidate({ providerFoodId: "1", name: "Pancake syrup" }),
            candidate({ providerFoodId: "2", name: "Pancakes, plain" }),
        ]);
        expect(pancakeRanked[0]?.name).toBe("Pancakes, plain");

        const riceRanked = rankCandidates({ query: "rice" }, [
            candidate({ providerFoodId: "1", name: "Rice cake" }),
            candidate({ providerFoodId: "2", name: "Wine, rice" }),
            candidate({ providerFoodId: "3", name: "Rice, cooked, NFS" }),
        ]);
        expect(riceRanked[0]?.name).toBe("Rice, cooked, NFS");
    });

    test("full-token match beats partial-token match even when partial match has a fuller panel", () => {
        const ranked = rankCandidates({ query: "trader joe's eggs" }, [
            candidate({
                provider: "usda",
                providerFoodId: "392823",
                name: "TRADER JOE'S, STEAK SAUCE",
                brand: "TRADER JOE'S",
                dataKind: "packaged",
            }),
            candidate({
                provider: "open_food_facts",
                providerFoodId: "00055277",
                name: "Eggs",
                brand: "Trader Joe's",
                dataKind: "packaged",
                nutrientsPer100g: { calories: 143, protein_g: 12.6 },
                portions: [
                    {
                        id: "100g",
                        amount: 100,
                        unit: "g",
                        label: "100 g",
                        gramWeight: 100,
                        nutrients: { calories: 143, protein_g: 12.6 },
                    },
                ],
                confidence: 0.78,
            }),
        ]);
        expect(ranked[0]?.providerFoodId).toBe("00055277");
    });

    test("USDA provider uses relevance sort (no alphabetical dataType.keyword) and requireAllWords for multi-word queries", async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const provider = new UsdaFoodDataCentralProvider({
            apiKey: "test-key",
            fetchImpl: (async (
                _input: RequestInfo | URL,
                init?: RequestInit,
            ) => {
                bodies.push(JSON.parse(String(init?.body ?? "{}")));
                return new Response(
                    JSON.stringify({
                        foods: [
                            {
                                fdcId: 1001,
                                description: "GREAT VALUE, WHOLE MILK",
                                brandName: "GREAT VALUE",
                                dataType: "Branded",
                                foodNutrients: [
                                    { nutrientId: 1008, value: 61 },
                                ],
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }) as unknown as typeof fetch,
        });

        await provider.search({ query: "great value milk", limit: 30 });
        expect(bodies[0]?.sortBy).toBeUndefined();
        expect(bodies[0]?.requireAllWords).toBe(true);
        expect(bodies[0]?.pageSize).toBe(30);
    });

    test("FoodSearchService does not short-circuit live providers on partial-token multi-word local hits", async () => {
        let providerCalls = 0;
        const partialLocalHits: CatalogHit[] = Array.from(
            { length: 10 },
            (_, i) => ({
                stale: false,
                candidate: candidate({
                    providerFoodId: `chicken-${i}`,
                    name: `Chicken part ${i}`,
                }),
            }),
        );
        const provider: FoodProvider = {
            name: "open_food_facts",
            async search() {
                providerCalls += 1;
                return [
                    candidate({
                        provider: "open_food_facts",
                        providerFoodId: "alfredo-1",
                        name: "Chicken Alfredo",
                        brand: "Healthy Choice",
                        dataKind: "packaged",
                    }),
                ];
            },
        };
        const fakeCatalog = {
            async findCachedSearch() {
                return null;
            },
            async searchLocal() {
                return partialLocalHits;
            },
            async isNegative() {
                return false;
            },
            async upsertAndRecordSearch() {},
            async recordSearch() {},
            async recordNegative() {},
        } as unknown as FoodCatalogRepository;

        const service = new FoodSearchService(
            new FoodProviderRegistry([provider]),
            fakeCatalog,
        );
        const result = await service.search("chicken alfredo", 10);
        expect(providerCalls).toBe(1);
        expect(result.candidates[0]?.providerFoodId).toBe("alfredo-1");
    });
});

describe("model-first portion choice validation and batching (production path)", () => {
    test("one batched pick call + one batched portion call across multiple photo items via Decisions", async () => {
        const eggVision: MealPhotoVisionItem = {
            name: "egg",
            cooking_method: "fried",
            quantity: 2,
            unit: "piece",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const mustardVision: MealPhotoVisionItem = {
            name: "mustard",
            cooking_method: null,
            quantity: 1,
            unit: "tbsp",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const eggCand = candidate();
        const mustardCand = candidate({
            providerFoodId: "2710085",
            name: "Mustard",
            nutrientsPer100g: { calories: 69, protein_g: 4.4 },
            portions: [
                {
                    id: "pkt",
                    amount: 1,
                    unit: "serving",
                    label: "1 packet",
                    gramWeight: 5,
                    nutrients: { calories: 3.45, protein_g: 0.22 },
                },
                {
                    id: "tbsp-real",
                    amount: 1,
                    unit: "undetermined",
                    label: "1 tablespoon",
                    gramWeight: 15,
                    nutrients: { calories: 10.35, protein_g: 0.66 },
                },
            ],
        });

        const calls: Array<{ model: string; task: string; qCount: number }> =
            [];
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            const qKeys = Object.keys(body.questions ?? {});
            calls.push({
                model: body.model,
                task: body.state?.task ?? "",
                qCount: qKeys.length,
            });
            if (calls.length === 1) {
                return decisionsResponse({
                    q0: { type: "choice", choice: "c0", confidence: 0.95 },
                    q1: { type: "choice", choice: "c0", confidence: 0.95 },
                });
            }
            // Portion call: find "1 egg" for q0 and "1 tablespoon" for q1.
            const q0Criteria = body.questions.q0.criteria as Record<
                string,
                string
            >;
            const q1Criteria = body.questions.q1.criteria as Record<
                string,
                string
            >;
            const eggKey = Object.entries(q0Criteria).find(
                ([, v]) => v === "1 egg",
            )![0];
            const tbspKey = Object.entries(q1Criteria).find(
                ([, v]) => v === "1 tablespoon",
            )![0];
            return decisionsResponse({
                q0: { type: "choice", choice: eggKey, confidence: 0.93 },
                q1: { type: "choice", choice: tbspKey, confidence: 0.91 },
            });
        };

        const config = testDecisionsConfig();
        const grounded = await groundMealPhotoItems(
            [eggVision, mustardVision],
            {
                search: async (query) => ({
                    candidates: query.includes("egg")
                        ? [eggCand]
                        : [mustardCand],
                    failures: [],
                }),
                chooseCandidates: (reqs) =>
                    chooseCandidatesViaDecisions(reqs, config, { fetcher }),
                choosePortions: (reqs) =>
                    choosePortionsViaDecisions(reqs, config, { fetcher }),
            },
        );

        // Exactly 2 Decisions calls for 2 items: 1 batched pick + 1 batched portion.
        expect(calls).toHaveLength(2);
        expect(calls[0]?.qCount).toBe(2);
        expect(calls[1]?.qCount).toBe(2);
        expect(calls[0]?.model).toBe("typesafe/jev-1.14");
        expect(calls[1]?.model).toBe("typesafe/jev-1.14");

        // 2 fried eggs via "1 egg" (50g, 71.5 kcal) -> 100g, 143 kcal.
        expect(grounded[0]?.draftItem.gramWeight).toBe(100);
        expect(grounded[0]?.draftItem.nutrients.calories).toBe(143);
        expect(grounded[0]?.draftItem.sourceSnapshot?.selected_portion_id).toBe(
            "egg-1",
        );

        // 1 tbsp mustard via "1 tablespoon" (15g, 10.35 kcal) -> 15g, 10.35 kcal.
        expect(grounded[1]?.draftItem.gramWeight).toBe(15);
        expect(grounded[1]?.draftItem.nutrients.calories).toBe(10.35);
        expect(grounded[1]?.draftItem.sourceSnapshot?.selected_portion_id).toBe(
            "tbsp-real",
        );
    });

    test("unresolvable / fabricated / dimensionally invalid portion falls back safely to deterministic resolution", async () => {
        // (a) Fabricated portion ID falls back to resolveGroundedPortion
        const beefVision: MealPhotoVisionItem = {
            name: "ground beef",
            cooking_method: null,
            quantity: 4,
            unit: "oz",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const beefCand = candidate({
            providerFoodId: "2705854",
            name: "Beef, ground",
            nutrientsPer100g: { calories: 261, protein_g: 26 },
            portions: [
                {
                    id: "100g",
                    amount: 100,
                    unit: "g",
                    label: "100 g",
                    gramWeight: 100,
                    nutrients: { calories: 261, protein_g: 26 },
                },
            ],
        });
        const [fabEntry] = await groundMealPhotoItems([beefVision], {
            search: async () => ({ candidates: [beefCand], failures: [] }),
            chooseCandidates: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:2705854",
                            confidence: 0.9,
                            rationale: null,
                        },
                    ],
                ]),
            choosePortions: async () =>
                new Map([
                    ["item:0", { portionId: "invented-id", confidence: 1 }],
                ]),
        });
        // 4 oz = 113.4 g -> 1.134 * 261 = 295.97 kcal via deterministic 100g panel.
        expect(fabEntry?.draftItem.gramWeight).toBe(113.4);
        expect(fabEntry?.draftItem.nutrients.calories).toBeCloseTo(295.97, 1);

        // (b) Count vision ("3 piece") + chosen "100g" weight portion is REFUSED (count-as-grams P1)
        const cornVision: MealPhotoVisionItem = {
            name: "corn on the cob",
            cooking_method: "boiled",
            quantity: 3,
            unit: "piece",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const weightOnlyCorn = candidate({
            providerFoodId: "999",
            name: "Corn, sweet, boiled",
            nutrientsPer100g: { calories: 86 },
            portions: [
                {
                    id: "100g",
                    amount: 100,
                    unit: "g",
                    label: "100 g",
                    gramWeight: 100,
                    nutrients: { calories: 86 },
                },
            ],
        });
        const [cornEntry] = await groundMealPhotoItems([cornVision], {
            search: async () => ({
                candidates: [weightOnlyCorn],
                failures: [],
            }),
            chooseCandidates: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:999",
                            confidence: 0.9,
                            rationale: null,
                        },
                    ],
                ]),
            choosePortions: async () =>
                new Map([["item:0", { portionId: "100g", confidence: 0.9 }]]),
        });
        // Never logs 3 g / 2.58 kcal; routes to blocking question when no estimate.
        expect(cornEntry?.grounded).toBe(false);
        expect(cornEntry?.question?.blocking).toBe(true);

        // (c) Volume vision ("300 ml") + chosen "1 serving" (no volume unit) is REFUSED (calorie-blowup guard)
        const soupVision: MealPhotoVisionItem = {
            name: "tomato soup",
            cooking_method: null,
            quantity: 300,
            unit: "ml",
            portion_confidence: 0.9,
            assumptions: [],
        };
        const servingOnlySoup = candidate({
            providerFoodId: "1966887",
            name: "Tomato soup",
            nutrientsPer100g: { calories: 40 },
            portions: [
                {
                    id: "declared-serving",
                    amount: 1,
                    unit: "serving",
                    label: "1 serving",
                    gramWeight: 425,
                    nutrients: { calories: 161.5 },
                },
            ],
        });
        const [soupEntry] = await groundMealPhotoItems([soupVision], {
            search: async () => ({
                candidates: [servingOnlySoup],
                failures: [],
            }),
            chooseCandidates: async () =>
                new Map([
                    [
                        "item:0",
                        {
                            candidateId: "usda:1966887",
                            confidence: 0.9,
                            rationale: null,
                        },
                    ],
                ]),
            choosePortions: async () =>
                new Map([
                    [
                        "item:0",
                        { portionId: "declared-serving", confidence: 0.9 },
                    ],
                ]),
        });
        // Never logs 300 servings (48,450 kcal)!
        expect(soupEntry?.grounded).toBe(false);
        expect(soupEntry?.question?.blocking).toBe(true);
    });

    test("Jev lead falls back to Perplexity on 5xx without disturbing Search Intent order", async () => {
        const triedModels: string[] = [];
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            triedModels.push(body.model);
            if (body.model === "typesafe/jev-1.14") {
                return new Response(
                    JSON.stringify({ error: { message: "jev down" } }),
                    { status: 503 },
                );
            }
            return decisionsResponse({
                q0: { type: "choice", choice: "c0", confidence: 0.9 },
            });
        };
        const config = testDecisionsConfig();
        const result = await chooseCandidatesViaDecisions(
            [
                {
                    key: "item:0",
                    itemName: "egg",
                    cookingMethod: "fried",
                    candidates: [
                        {
                            candidateId: "usda:2707152",
                            name: "Egg, whole, raw",
                            brand: null,
                            provider: "usda",
                        },
                    ],
                },
            ],
            config,
            { fetcher },
        );
        expect(triedModels).toEqual([
            "typesafe/jev-1.14",
            "typesafe/jev-1.14",
            "perplexity/pplx-decider-v1.2",
        ]);
        expect(result.get("item:0")?.candidateId).toBe("usda:2707152");
    });
});
