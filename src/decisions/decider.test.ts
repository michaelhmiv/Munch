import { describe, expect, test } from "bun:test";
import {
    chooseCandidatesForMealPhoto,
    chooseCandidatesViaDecisions,
} from "./decider.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";
import type {
    MealPhotoCandidateChoiceRequest,
    MealPhotoVisionConfig,
} from "../meal-photo/vision.js";

const visionConfig: MealPhotoVisionConfig = {
    apiKey: "test-key",
    model: "meta/muse-ember",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1_000,
};

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: [
            "typesafe/jev-1.14",
            "perplexity/pplx-decider-v1.2",
            "liquid/d1-ultra",
        ],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        matchTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        matchEnabled: true,
        draftReviewTimeoutMs: 50,
        draftReviewEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        ...overrides,
    };
}

const requests: MealPhotoCandidateChoiceRequest[] = [
    {
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
            {
                candidateId: "off:2",
                name: "Chicken nuggets",
                brand: "BrandCo",
                provider: "open_food_facts",
            },
        ],
    },
    {
        key: "item:1",
        itemName: "white rice",
        cookingMethod: null,
        candidates: [
            {
                candidateId: "usda:3",
                name: "Rice, white, cooked",
                brand: null,
                provider: "usda",
            },
        ],
    },
];

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00002 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/** Legacy Ember chooser stub: answers item:0 with its first candidate. */
function legacyEnvelope() {
    return new Response(
        JSON.stringify({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            selections: [
                                {
                                    key: "item:0",
                                    candidate_id: "usda:1",
                                    confidence: 0.77,
                                    rationale: "legacy pick",
                                },
                            ],
                        }),
                    },
                },
            ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

describe("chooseCandidatesViaDecisions (harness adapter, productionized)", () => {
    test("maps picks, none, and carries name + brand + provider as options", async () => {
        let seenBody: Record<string, any> = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            return decisionsResponse({
                q0: { type: "choice", choice: "c1", confidence: 0.87 },
                q1: {
                    type: "choice",
                    choice: "none",
                    probabilities: { none: 0.66 },
                },
            });
        };
        const result = await chooseCandidatesViaDecisions(
            requests,
            testConfig(),
            { fetcher },
        );
        expect(result.get("item:0")).toEqual({
            candidateId: "off:2",
            confidence: 0.87,
            rationale: null,
        });
        expect(result.get("item:1")).toEqual({
            candidateId: null,
            confidence: 0.66,
            rationale: null,
        });
        const criteria = seenBody.questions.q0.criteria as Record<
            string,
            string
        >;
        expect(criteria.c0).toContain("Chicken breast, grilled");
        expect(criteria.c0).toContain("usda");
        expect(criteria.c1).toContain("BrandCo");
        expect(criteria.none).toContain("No candidate");
        const item = (seenBody.state as any).items[0];
        expect(item.candidates[1].source_database).toBe("open_food_facts");
    });

    test("batches over the 8-question cap run concurrently and merge identically", async () => {
        // 9 ambiguous items => two chunks (8 + 1). The chunks are
        // independent Decisions calls; they must overlap in flight
        // (the sequential loop was pure draft_build latency) and the
        // merged result must equal what sequential calls would give.
        const manyRequests: MealPhotoCandidateChoiceRequest[] = Array.from(
            { length: 9 },
            (_, index) => ({
                key: `item:${index}`,
                itemName: `food ${index}`,
                cookingMethod: null,
                candidates: [
                    {
                        candidateId: `usda:${index}`,
                        name: `Food ${index}`,
                        brand: null,
                        provider: "usda",
                    },
                ],
            }),
        );
        let inFlight = 0;
        let maxInFlight = 0;
        const fetcher: DecisionsFetcher = async (_input, init) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await new Promise((resolve) => setTimeout(resolve, 25));
                const body = JSON.parse(String(init?.body ?? "{}"));
                const answers: Record<string, unknown> = {};
                for (const questionKey of Object.keys(body.questions)) {
                    answers[questionKey] = {
                        type: "choice",
                        choice: "c0",
                        confidence: 0.5,
                    };
                }
                return decisionsResponse(answers);
            } finally {
                inFlight -= 1;
            }
        };
        const result = await chooseCandidatesViaDecisions(
            manyRequests,
            testConfig(),
            { fetcher },
        );
        expect(result.size).toBe(9);
        for (let index = 0; index < 9; index++) {
            expect(result.get(`item:${index}`)?.candidateId).toBe(
                `usda:${index}`,
            );
        }
        expect(maxInFlight).toBeGreaterThanOrEqual(2);
    });

    test("an option key outside the candidate list is discarded, never honoured", async () => {
        const result = await chooseCandidatesViaDecisions(
            requests,
            testConfig(),
            {
                fetcher: async () =>
                    decisionsResponse({
                        q0: { type: "choice", choice: "c9", confidence: 1 },
                        // q1 unanswered entirely
                    }),
            },
        );
        expect(result.has("item:0")).toBe(false);
        expect(result.has("item:1")).toBe(false);
    });
});

describe("chooseCandidatesForMealPhoto seat wiring (fallback drills)", () => {
    test("flag OFF: zero Decisions calls, legacy chooser answers", async () => {
        let decisionsCalls = 0;
        const result = await chooseCandidatesForMealPhoto(
            requests,
            visionConfig,
            {
                config: testConfig({ deciderEnabled: false }),
                fetcher: async () => {
                    decisionsCalls += 1;
                    throw new Error("must not be called");
                },
                visionDependencies: { fetcher: async () => legacyEnvelope() },
            },
        );
        expect(decisionsCalls).toBe(0);
        expect(result.get("item:0")?.candidateId).toBe("usda:1");
    });

    test("no decisions config (no key): legacy chooser answers", async () => {
        const result = await chooseCandidatesForMealPhoto(
            requests,
            visionConfig,
            {
                config: null,
                visionDependencies: { fetcher: async () => legacyEnvelope() },
            },
        );
        expect(result.get("item:0")?.candidateId).toBe("usda:1");
    });

    test("seat ON: Decisions answers, legacy chooser untouched", async () => {
        let legacyCalls = 0;
        const result = await chooseCandidatesForMealPhoto(
            requests,
            visionConfig,
            {
                config: testConfig(),
                fetcher: async () =>
                    decisionsResponse({
                        q0: { type: "choice", choice: "c0", confidence: 0.9 },
                        q1: { type: "choice", choice: "c0", confidence: 0.8 },
                    }),
                visionDependencies: {
                    fetcher: async () => {
                        legacyCalls += 1;
                        return legacyEnvelope();
                    },
                },
            },
        );
        expect(legacyCalls).toBe(0);
        expect(result.get("item:1")?.candidateId).toBe("usda:3");
    });

    test("DRILL — whole Decisions chain down (5xx everywhere): the flow completes via today's legacy chooser", async () => {
        let decisionsCalls = 0;
        const result = await chooseCandidatesForMealPhoto(
            requests,
            visionConfig,
            {
                config: testConfig(),
                fetcher: async () => {
                    decisionsCalls += 1;
                    return new Response(
                        JSON.stringify({ error: { message: "down" } }),
                        { status: 500 },
                    );
                },
                visionDependencies: { fetcher: async () => legacyEnvelope() },
            },
        );
        // 3 models x (initial + one retry) before the terminal fallback.
        expect(decisionsCalls).toBe(6);
        expect(result.get("item:0")?.candidateId).toBe("usda:1");
        expect(result.get("item:0")?.confidence).toBe(0.77);
    });

    test("DRILL — Decisions answers garbage: terminal fallback still completes the draft path", async () => {
        const result = await chooseCandidatesForMealPhoto(
            requests,
            visionConfig,
            {
                config: testConfig({ models: ["typesafe/jev-1.14"] }),
                fetcher: async () => new Response("garbage", { status: 200 }),
                visionDependencies: { fetcher: async () => legacyEnvelope() },
            },
        );
        expect(result.get("item:0")?.candidateId).toBe("usda:1");
    });

    test("empty batch: no provider calls at all", async () => {
        let calls = 0;
        const counting = async () => {
            calls += 1;
            throw new Error("must not be called");
        };
        const result = await chooseCandidatesForMealPhoto([], visionConfig, {
            config: testConfig(),
            fetcher: counting,
            visionDependencies: { fetcher: counting },
        });
        expect(result.size).toBe(0);
        expect(calls).toBe(0);
    });
});
