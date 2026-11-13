import { describe, expect, test } from "bun:test";
import {
    correlateReceiptLines,
    correlateReceiptLinesViaDecisions,
    type ReceiptCorrelationRequest,
} from "./receipt.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        receiptEnabled: true,
        ...overrides,
    };
}

const requests: ReceiptCorrelationRequest[] = [
    {
        key: "line:0",
        rawLabel: "MLK GL 1GAL",
        itemName: "milk, 1 gallon",
        quantity: 1,
        unit: "gallon",
        candidates: [
            {
                candidateId: "usda:111",
                name: "Milk, whole",
                brand: null,
                provider: "usda",
                providerFoodId: "111",
            },
            {
                candidateId: "open_food_facts:222",
                name: "Chocolate milk",
                brand: "BrandCo",
                provider: "open_food_facts",
                providerFoodId: "222",
            },
        ],
    },
    {
        key: "line:1",
        rawLabel: "EGGS 12CT",
        itemName: "eggs, 12 count",
        quantity: 12,
        unit: "count",
        candidates: [
            {
                candidateId: "usda:333",
                name: "Eggs, large",
                brand: null,
                provider: "usda",
                providerFoodId: "333",
            },
        ],
    },
];

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00003 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("correlateReceiptLinesViaDecisions (S2 adapter shape, receipt state)", () => {
    test("maps picks + plausibility, and carries label, quantity, unit and candidates as state", async () => {
        let seenBody: Record<string, any> = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            return decisionsResponse({
                q0: {
                    type: "choice",
                    choice: "c1",
                    probabilities: { c0: 0.05, c1: 0.87, none: 0.08 },
                },
                p0: { type: "noul", noul: 0.93 },
                q1: {
                    type: "choice",
                    choice: "none",
                    probabilities: { c0: 0.2, none: 0.66 },
                },
                p1: { type: "noul", noul: 0.41 },
            });
        };
        const result = await correlateReceiptLinesViaDecisions(
            requests,
            testConfig(),
            { fetcher },
        );
        expect(result.get("line:0")).toEqual({
            candidateId: "open_food_facts:222",
            provider: "open_food_facts",
            providerFoodId: "222",
            pickProbability: 0.87,
            plausibilityProbability: 0.93,
            model: "typesafe/jev-1.14",
        });
        expect(result.get("line:1")).toEqual({
            candidateId: null,
            provider: null,
            providerFoodId: null,
            pickProbability: 0.66,
            plausibilityProbability: 0.41,
            model: "typesafe/jev-1.14",
        });
        // Wire shape: one Choice + one Noul per line, candidates with
        // brand + provider, receipt fields in the state.
        const criteria = seenBody.questions.q0.criteria as Record<
            string,
            string
        >;
        expect(criteria.c1).toContain("BrandCo");
        expect(criteria.c0).toContain("usda");
        expect(criteria.none).toContain("No candidate");
        expect(seenBody.questions.q0.instructions).toContain("best represents");
        expect(seenBody.questions.p0.type).toBe("noul");
        expect(seenBody.questions.p0.instructions).toContain("plausible");
        const item = (seenBody.state as any).items[0];
        expect(item.receipt_line).toEqual({
            printed_label: "MLK GL 1GAL",
            item: "milk, 1 gallon",
            quantity: 1,
            unit: "gallon",
        });
        expect(item.candidates[1].source_database).toBe("open_food_facts");
    });

    test("a pick below the model's receipt threshold is NOT attached, but its probability is still the review trigger", async () => {
        const result = await correlateReceiptLinesViaDecisions(
            requests.slice(0, 1),
            testConfig(),
            {
                fetcher: async () =>
                    decisionsResponse({
                        q0: {
                            type: "choice",
                            choice: "c0",
                            probabilities: { c0: 0.3, none: 0.25 },
                        },
                        p0: { type: "noul", noul: 0.9 },
                    }),
            },
        );
        const correlation = result.get("line:0")!;
        // The raw pick is still scored/reported…
        expect(correlation.candidateId).toBe("usda:111");
        // …but no provider identity is attached below the threshold.
        expect(correlation.provider).toBeNull();
        expect(correlation.providerFoodId).toBeNull();
        expect(correlation.pickProbability).toBe(0.3);
    });

    test("an option key outside the candidate list is discarded, never honoured", async () => {
        const result = await correlateReceiptLinesViaDecisions(
            requests,
            testConfig(),
            {
                fetcher: async () =>
                    decisionsResponse({
                        q0: { type: "choice", choice: "c9", confidence: 1 },
                        p0: { type: "noul", noul: 0.9 },
                        // q1 unanswered entirely
                    }),
            },
        );
        expect(result.has("line:0")).toBe(false);
        expect(result.has("line:1")).toBe(false);
    });

    test("batches over the 8-question cap: 5 lines run as 2 concurrent calls (4 + 1) and merge", async () => {
        const many: ReceiptCorrelationRequest[] = Array.from(
            { length: 5 },
            (_, index) => ({
                key: `line:${index}`,
                rawLabel: `ITEM ${index}`,
                itemName: `food ${index}`,
                quantity: 1,
                unit: "count",
                candidates: [
                    {
                        candidateId: `usda:${index}`,
                        name: `Food ${index}`,
                        brand: null,
                        provider: "usda",
                        providerFoodId: `${index}`,
                    },
                ],
            }),
        );
        let calls = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        const fetcher: DecisionsFetcher = async (_input, init) => {
            calls += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await new Promise((resolve) => setTimeout(resolve, 20));
                const body = JSON.parse(String(init?.body ?? "{}"));
                const answers: Record<string, unknown> = {};
                for (const questionKey of Object.keys(body.questions)) {
                    answers[questionKey] = questionKey.startsWith("q")
                        ? {
                              type: "choice",
                              choice: "c0",
                              probabilities: { c0: 0.9 },
                          }
                        : { type: "noul", noul: 0.95 };
                }
                return decisionsResponse(answers);
            } finally {
                inFlight -= 1;
            }
        };
        const result = await correlateReceiptLinesViaDecisions(
            many,
            testConfig(),
            { fetcher },
        );
        expect(calls).toBe(2);
        expect(maxInFlight).toBeGreaterThanOrEqual(2);
        expect(result.size).toBe(5);
        expect(result.get("line:4")?.candidateId).toBe("usda:4");
    });
});

describe("correlateReceiptLines seat wiring (fail-open drills)", () => {
    test("flag OFF: zero Decisions calls, null result (caller keeps today's preview)", async () => {
        let decisionsCalls = 0;
        const result = await correlateReceiptLines(requests, {
            config: testConfig({ receiptEnabled: false }),
            fetcher: async () => {
                decisionsCalls += 1;
                throw new Error("must not be called");
            },
        });
        expect(result).toBeNull();
        expect(decisionsCalls).toBe(0);
    });

    test("no decisions config (no key): null result", async () => {
        const result = await correlateReceiptLines(requests, {
            config: null,
        });
        expect(result).toBeNull();
    });

    test("DRILL — whole Decisions chain down (5xx everywhere): null result, no throw", async () => {
        let decisionsCalls = 0;
        const result = await correlateReceiptLines(requests, {
            config: testConfig(),
            fetcher: async () => {
                decisionsCalls += 1;
                return new Response(
                    JSON.stringify({ error: { message: "down" } }),
                    { status: 500 },
                );
            },
        });
        // 2 models x (initial + one retry) before terminal fallback.
        expect(decisionsCalls).toBe(4);
        expect(result).toBeNull();
    });

    test("DRILL — primary down, fallback answers: the fallback's model + threshold govern the result", async () => {
        const result = await correlateReceiptLines(requests.slice(0, 1), {
            config: testConfig(),
            fetcher: async (_input, init) => {
                const body = JSON.parse(String(init?.body ?? "{}"));
                if (body.model === "typesafe/jev-1.14") {
                    return new Response(
                        JSON.stringify({ error: { message: "down" } }),
                        { status: 500 },
                    );
                }
                return decisionsResponse({
                    q0: {
                        type: "choice",
                        choice: "c0",
                        probabilities: { c0: 0.77 },
                    },
                    p0: { type: "noul", noul: 0.88 },
                });
            },
        });
        const correlation = result?.get("line:0");
        expect(correlation?.model).toBe("perplexity/pplx-decider-v1.2");
        expect(correlation?.candidateId).toBe("usda:111");
        expect(correlation?.pickProbability).toBe(0.77);
    });

    test("empty batch: no provider calls at all", async () => {
        let calls = 0;
        const result = await correlateReceiptLines([], {
            config: testConfig(),
            fetcher: async () => {
                calls += 1;
                throw new Error("must not be called");
            },
        });
        expect(result).toBeNull();
        expect(calls).toBe(0);
    });
});
