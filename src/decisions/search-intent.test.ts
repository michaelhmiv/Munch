import { describe, expect, test } from "bun:test";
import { applySearchIntentSeat, applySearchSeats } from "./search-intent.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";
import { summarizeFoodCandidate } from "../food-providers/service.js";
import type { SearchIntentPinRecord } from "../food-providers/catalog-repository.js";
import type { FoodCandidate, FoodPortion } from "../food-providers/types.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        matchTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        matchEnabled: true,
        outlierTimeoutMs: 50,
        outlierEnabled: true,
        chatClaimsEnabled: true,
        chatClaimsTimeoutMs: 50,
        draftReviewTimeoutMs: 50,
        draftReviewEnabled: true,
        plausibilityTimeoutMs: 50,
        plausibilityEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        searchIntentEnabled: true,
        searchIntentTimeoutMs: 2_000,
        searchIntentModels: [
            "perplexity/pplx-decider-v1.2",
            "typesafe/jev-1.14",
        ],
        ...overrides,
    };
}

const FULL_PANEL = {
    calories: 52,
    protein_g: 0.3,
    carbs_g: 14,
    fat_g: 0.2,
};

function portion(
    id: string,
    label: string,
    amount: number,
    unit: string,
    gramWeight: number,
    calories: number,
): FoodPortion {
    return {
        id,
        amount,
        unit,
        label,
        gramWeight,
        nutrients: { calories },
    };
}

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "2709215",
        name: "Apple, raw",
        dataKind: "generic",
        nutrientsPer100g: { ...FULL_PANEL },
        portions: [
            portion("cup", "1 cup", 1, "cup", 125, 65),
            portion("medium", "1 medium", 1, "medium", 182, 95),
            portion("100g", "100 g", 100, "g", 100, 52),
        ],
        attribution: { label: "USDA FoodData Central" },
        confidence: 0.9,
        ...overrides,
    };
}

/**
 * The Dani case from the 2026-11-22 eval fixture: a branded snack
 * pack ranks first for "apple", the plain raw apple second — and
 * the raw apple's own deterministic default portion is "1 cup".
 */
function appleList(): FoodCandidate[] {
    return [
        candidate({
            providerFoodId: "454004",
            name: "APPLE",
            brand: "TREECRISP 2 GO",
            dataKind: "packaged",
            portions: [
                portion("declared-serving", "5.5 ONZ", 1, "package", 154, 80),
                portion("100g", "100 g", 100, "g", 100, 52),
            ],
        }),
        candidate(),
        candidate({
            providerFoodId: "2709000",
            name: "Applesauce, sweetened",
            portions: [portion("cup", "1 cup", 1, "cup", 246, 167)],
        }),
    ];
}

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00001 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

interface RecordedCall {
    model: string;
    task: string;
    body: Record<string, any>;
}

/** Fake Decisions fetcher dispatching on the call's state task —
 * the same seam every seat test uses (no network, no key). */
function scriptedFetcher(script: {
    candidateChoice?: string;
    portionChoice?: string;
    matchChoice?: string;
}) {
    const calls: RecordedCall[] = [];
    const fetcher: DecisionsFetcher = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            any
        >;
        const task = String(body.state?.task ?? "");
        calls.push({ model: String(body.model ?? ""), task, body });
        if (task.startsWith("Choose the food-database candidate")) {
            return decisionsResponse({
                q0: { type: "choice", choice: script.candidateChoice },
            });
        }
        if (task.startsWith("Choose the portion")) {
            return decisionsResponse({
                q0: { type: "choice", choice: script.portionChoice },
            });
        }
        if (task.startsWith("Choose the best food-database candidate")) {
            return decisionsResponse({
                q0: { type: "choice", choice: script.matchChoice },
            });
        }
        throw new Error(`unscripted Decisions task: ${task}`);
    };
    return { fetcher, calls };
}

function memoryPinStore(seed: Record<string, SearchIntentPinRecord> = {}) {
    const pins = new Map<string, SearchIntentPinRecord>(Object.entries(seed));
    const reads = { count: 0 };
    const store = {
        find: async (normalizedQuery: string) => {
            reads.count += 1;
            return pins.get(normalizedQuery) ?? null;
        },
        record: async (normalizedQuery: string, pin: SearchIntentPinRecord) => {
            pins.set(normalizedQuery, pin);
        },
    };
    return { store, pins, reads };
}

describe("applySearchIntentSeat — live decision", () => {
    test("pin applied + portion default swapped, with the eval's exact call shape", async () => {
        const { fetcher, calls } = scriptedFetcher({
            candidateChoice: "c1",
            portionChoice: "p1",
        });
        const { store, pins } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });

        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(result.pinnedPortionId).toBe("medium");
        expect(result.candidates.map((c) => c.providerFoodId)).toEqual([
            "2709215",
            "454004",
            "2709000",
        ]);
        // The portion swap the surfaces apply through the summary:
        const summary = summarizeFoodCandidate(result.candidates[0]!, {
            defaultPortionId: result.pinnedPortionId,
        });
        expect(summary.default_portion?.label).toBe("1 medium");
        // ...while the deterministic default (no seat) stays "1 cup":
        expect(
            summarizeFoodCandidate(result.candidates[0]!).default_portion
                ?.label,
        ).toBe("1 cup");

        // The pin was recorded under the normalized query.
        expect([...pins.keys()]).toEqual(["apple"]);
        expect(pins.get("apple")).toEqual({
            candidateId: "usda:2709215",
            portionId: "medium",
            model: "perplexity/pplx-decider-v1.2",
        });

        // Exactly two calls, both on the Perplexity-led lane, with
        // the eval's payload construction verbatim.
        expect(calls.length).toBe(2);
        const [candidateCall, portionCall] = calls as [
            RecordedCall,
            RecordedCall,
        ];
        expect(candidateCall.model).toBe("perplexity/pplx-decider-v1.2");
        expect(candidateCall.body.state.items[0].search_query).toBe("apple");
        expect(candidateCall.body.state.items[0].candidates[1]).toEqual({
            option: "c1",
            name: "Apple, raw",
            brand: null,
            source_database: "usda",
            data_kind: "generic",
            default_portion: "1 cup",
        });
        expect(candidateCall.body.questions.q0.instructions).toBe(
            "A user searched a nutrition app for the query in the state. Choose the single candidate they most likely intend to log. Prefer an exact brand match when the query names a brand or store; otherwise prefer the plain, unprepared, generic form of the food over branded, flavored, or prepared variants, unless the query itself asks for a prepared dish.",
        );
        expect(candidateCall.body.questions.q0.criteria.c0).toBe(
            "APPLE — brand: TREECRISP 2 GO (source database: usda)",
        );
        expect(candidateCall.body.questions.q0.criteria.none).toBe(
            "No candidate is a defensible match for this search query.",
        );
        expect(portionCall.model).toBe("perplexity/pplx-decider-v1.2");
        expect(portionCall.body.state.items[0].food).toBe("Apple, raw");
        expect(portionCall.body.state.items[0].portions[1]).toEqual({
            option: "p1",
            label: "1 medium",
            gram_weight: 182,
            calories: 95,
        });
        expect(portionCall.body.questions.q0.instructions).toBe(
            "Which portion would a person most likely log for this food? Choose the single portion that represents the amount a person would typically eat and log at one time for the food in the state.",
        );
        expect(portionCall.body.questions.q0.criteria.p1).toBe(
            "1 medium (182 g, 95 kcal)",
        );
    });

    test("portion-call failure keeps the candidate pin; natural default stands", async () => {
        const calls: RecordedCall[] = [];
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as Record<
                string,
                any
            >;
            const task = String(body.state?.task ?? "");
            calls.push({ model: String(body.model ?? ""), task, body });
            if (task.startsWith("Choose the food-database candidate")) {
                return decisionsResponse({
                    q0: { type: "choice", choice: "c1" },
                });
            }
            return new Response(
                JSON.stringify({ error: { message: "down" } }),
                { status: 500 },
            );
        };
        const { store, pins } = memoryPinStore();
        const result = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(result.pinnedPortionId).toBeNull();
        expect(result.candidates[0]!.providerFoodId).toBe("2709215");
        expect(pins.get("apple")).toEqual({
            candidateId: "usda:2709215",
            portionId: null,
            model: "perplexity/pplx-decider-v1.2",
        });
    });
});

describe("applySearchIntentSeat — cached pins", () => {
    test("cached pin served with NO model call", async () => {
        const { fetcher, calls } = scriptedFetcher({});
        const { store } = memoryPinStore({
            apple: {
                candidateId: "usda:2709215",
                portionId: "medium",
                model: "perplexity/pplx-decider-v1.2",
            },
        });
        const result = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(calls.length).toBe(0);
        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(result.pinnedPortionId).toBe("medium");
        expect(result.candidates[0]!.providerFoodId).toBe("2709215");
    });

    test("cached abstention served with NO model call, list untouched", async () => {
        const { fetcher, calls } = scriptedFetcher({});
        const { store } = memoryPinStore({
            apple: {
                candidateId: null,
                portionId: null,
                model: "typesafe/jev-1.14",
            },
        });
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(calls.length).toBe(0);
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
    });

    test("stale pin (candidate gone) is ignored and re-decided", async () => {
        const { fetcher, calls } = scriptedFetcher({
            candidateChoice: "c1",
            portionChoice: "p1",
        });
        const { store, pins } = memoryPinStore({
            apple: {
                candidateId: "usda:9999999",
                portionId: "medium",
                model: "perplexity/pplx-decider-v1.2",
            },
        });
        const result = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(calls.length).toBe(2);
        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(pins.get("apple")?.candidateId).toBe("usda:2709215");
    });

    test("pin whose portion vanished keeps the candidate, natural default", async () => {
        const { fetcher, calls } = scriptedFetcher({});
        const { store } = memoryPinStore({
            apple: {
                candidateId: "usda:2709215",
                portionId: "no-such-portion",
                model: "perplexity/pplx-decider-v1.2",
            },
        });
        const result = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(calls.length).toBe(0);
        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(result.pinnedPortionId).toBeNull();
        expect(result.candidates[0]!.providerFoodId).toBe("2709215");
    });
});

describe("applySearchIntentSeat — fail-open discipline", () => {
    test("abstention leaves the ranked order untouched and is recorded", async () => {
        const { fetcher, calls } = scriptedFetcher({ candidateChoice: "none" });
        const { store, pins } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
        expect(pins.get("apple")?.candidateId).toBeNull();
        // A repeat search reads the recorded abstention: no new call.
        const again = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(again.pinnedCandidateId).toBeNull();
        expect(calls.length).toBe(1);
    });

    test("model error (chain exhausted) fails open; nothing recorded", async () => {
        let callCount = 0;
        const fetcher: DecisionsFetcher = async () => {
            callCount += 1;
            return new Response(
                JSON.stringify({ error: { message: "down" } }),
                {
                    status: 500,
                },
            );
        };
        const { store, pins } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(callCount).toBeGreaterThan(0);
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
        expect(pins.size).toBe(0);
    });

    test("timeout fails open inside the total budget; nothing recorded", async () => {
        const fetcher: DecisionsFetcher = async () =>
            new Promise<Response>(() => {});
        const { store, pins } = memoryPinStore();
        const ranked = appleList();
        const started = Date.now();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig({ searchIntentTimeoutMs: 100 }),
            fetcher,
            pinStore: store,
        });
        const elapsed = Date.now() - started;
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
        expect(pins.size).toBe(0);
        expect(elapsed).toBeLessThan(1_500);
    });

    test("unparseable answer (out-of-range key) fails open; nothing recorded", async () => {
        const { fetcher } = scriptedFetcher({ candidateChoice: "c99" });
        const { store, pins } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig(),
            fetcher,
            pinStore: store,
        });
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
        expect(pins.size).toBe(0);
    });

    test("seat disabled = current behaviour: no store read, no model call", async () => {
        const { fetcher, calls } = scriptedFetcher({ candidateChoice: "c1" });
        const { store, reads } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: testConfig({ searchIntentEnabled: false }),
            fetcher,
            pinStore: store,
        });
        expect(result.candidates).toBe(ranked);
        expect(result.pinnedCandidateId).toBeNull();
        expect(calls.length).toBe(0);
        expect(reads.count).toBe(0);
    });

    test("no config (no key) = current behaviour", async () => {
        const { fetcher, calls } = scriptedFetcher({ candidateChoice: "c1" });
        const { store } = memoryPinStore();
        const ranked = appleList();
        const result = await applySearchIntentSeat("apple", ranked, {
            config: null,
            fetcher,
            pinStore: store,
        });
        expect(result.candidates).toBe(ranked);
        expect(calls.length).toBe(0);
    });

    test("pin-store failure fails open and the live decision still applies", async () => {
        const { fetcher } = scriptedFetcher({
            candidateChoice: "c1",
            portionChoice: "p1",
        });
        const brokenStore = {
            find: async (): Promise<SearchIntentPinRecord | null> => {
                throw new Error("db down");
            },
            record: async (): Promise<void> => {
                throw new Error("db down");
            },
        };
        const result = await applySearchIntentSeat("apple", appleList(), {
            config: testConfig(),
            fetcher,
            pinStore: brokenStore,
        });
        expect(result.pinnedCandidateId).toBe("usda:2709215");
        expect(result.candidates[0]!.providerFoodId).toBe("2709215");
    });
});

describe("applySearchSeats — interaction with Seat B2", () => {
    // The B2 specimen (mirrors match.test.ts): a packaged entry the
    // completeness-dominant ranker put first while the generic entry
    // it names sits second, identity scores inside the ambiguity
    // band — B2 WOULD flip this list if it ran.
    function specimenPair(): FoodCandidate[] {
        const packaged = candidate({
            provider: "open_food_facts",
            providerFoodId: "off-packaged-cheddar",
            name: "Sharp Cheddar Cheese",
            brand: "PackCo",
            dataKind: "packaged",
            confidence: 0.82,
            nutrientsPer100g: { ...FULL_PANEL, calories: 402 },
            portions: [portion("oz", "1 oz", 1, "oz", 28, 113)],
        });
        const generic = candidate({
            providerFoodId: "171571",
            name: "Sharp Cheddar Cheese",
            brand: undefined,
            dataKind: "generic",
            confidence: 0.8,
            nutrientsPer100g: { calories: 402, protein_g: 25 },
            portions: [portion("oz", "1 oz", 1, "oz", 28, 113)],
        });
        return [packaged, generic];
    }

    test("intent pin takes precedence: B2 never runs on the list", async () => {
        const { fetcher, calls } = scriptedFetcher({
            candidateChoice: "c1",
            portionChoice: "p0",
            matchChoice: "c0",
        });
        const { store } = memoryPinStore();
        const result = await applySearchSeats(
            "sharp cheddar cheese",
            specimenPair(),
            {
                intent: { config: testConfig(), fetcher, pinStore: store },
                match: { config: testConfig(), fetcher },
            },
        );
        expect(result.pinnedCandidateId).toBe("usda:171571");
        expect(result.candidates[0]!.providerFoodId).toBe("171571");
        expect(
            calls.some((call) =>
                call.task.startsWith("Choose the best food-database"),
            ),
        ).toBe(false);
    });

    test("intent abstains: B2 runs on the untouched list and flips it as today", async () => {
        const { fetcher, calls } = scriptedFetcher({
            candidateChoice: "none",
            matchChoice: "c1",
        });
        const { store } = memoryPinStore();
        const result = await applySearchSeats(
            "sharp cheddar cheese",
            specimenPair(),
            {
                intent: { config: testConfig(), fetcher, pinStore: store },
                match: { config: testConfig(), fetcher },
            },
        );
        expect(result.pinnedCandidateId).toBeNull();
        expect(result.candidates[0]!.providerFoodId).toBe("171571");
        expect(
            calls.some((call) =>
                call.task.startsWith("Choose the best food-database"),
            ),
        ).toBe(true);
    });

    test("intent seat off: B2 behaviour unchanged, no intent calls", async () => {
        const { fetcher, calls } = scriptedFetcher({ matchChoice: "c1" });
        const { store } = memoryPinStore();
        const result = await applySearchSeats(
            "sharp cheddar cheese",
            specimenPair(),
            {
                intent: {
                    config: testConfig({ searchIntentEnabled: false }),
                    fetcher,
                    pinStore: store,
                },
                match: { config: testConfig(), fetcher },
            },
        );
        expect(result.pinnedCandidateId).toBeNull();
        expect(result.candidates[0]!.providerFoodId).toBe("171571");
        expect(
            calls.some((call) =>
                call.task.startsWith("Choose the food-database candidate"),
            ),
        ).toBe(false);
        expect(
            calls.filter((call) =>
                call.task.startsWith("Choose the best food-database"),
            ).length,
        ).toBe(1);
    });
});

describe("summarizeFoodCandidate — pinned default portion", () => {
    test("unknown pinned portion id falls back to the natural default", () => {
        const summary = summarizeFoodCandidate(candidate(), {
            defaultPortionId: "no-such-portion",
        });
        expect(summary.default_portion?.label).toBe("1 cup");
    });
});
