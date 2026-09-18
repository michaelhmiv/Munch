import { describe, expect, test } from "bun:test";
import {
    DEFAULT_DECISION_MODEL,
    OpenRouterDecisionClient,
    websiteDecisionConfig,
} from "./website-decision-client.js";

describe("website decision configuration", () => {
    test("uses the existing OpenRouter key and is disabled by default", () => {
        expect(
            websiteDecisionConfig({
                OPENROUTER_API_KEY: "or-test",
            }),
        ).toBeNull();
        expect(
            websiteDecisionConfig({
                OPENROUTER_API_KEY: "or-test",
                MUNCH_RECIPE_DECISION_ENABLED: "true",
            }),
        ).toMatchObject({
            apiKey: "or-test",
            model: DEFAULT_DECISION_MODEL,
            minConfidence: 0.75,
        });
        expect(
            websiteDecisionConfig({
                OPENROUTER_API_KEY: "or-test",
                MUNCH_RECIPE_DECISION_ENABLED: "true",
                MUNCH_DECISION_MODEL: "typesafe/jev-test",
                MUNCH_RECIPE_DECISION_MIN_CONFIDENCE: "0.8",
            }),
        ).toMatchObject({
            model: "typesafe/jev-test",
            minConfidence: 0.8,
        });
    });
});

describe("OpenRouter decision client", () => {
    test("batches choices through the decisions endpoint and validates returned criteria", async () => {
        const calls: Array<{ url: string; body: any }> = [];
        const client = new OpenRouterDecisionClient(
            {
                apiKey: "or-test",
                model: "~typesafe/jev-latest",
                endpoint: "https://openrouter.example/api/alpha/decisions",
                timeoutMs: 5_000,
                minConfidence: 0.75,
            },
            {
                fetcher: async (input, init) => {
                    calls.push({
                        url: String(input),
                        body: JSON.parse(String(init?.body)),
                    });
                    return new Response(
                        JSON.stringify({
                            model: "typesafe/jev-1.13-test",
                            answers: {
                                q0: {
                                    type: "choice",
                                    choice: "c1",
                                    probabilities: {
                                        c0: 0.02,
                                        c1: 0.97,
                                        NO_MATCH: 0.01,
                                    },
                                    confidence: 0.97,
                                },
                                q1: {
                                    type: "choice",
                                    choice: "NO_MATCH",
                                    probabilities: {
                                        c0: 0.1,
                                        NO_MATCH: 0.9,
                                    },
                                    confidence: 0.9,
                                },
                            },
                            usage: {
                                input_tokens: 400,
                                output_tokens: 100,
                                cost: 0.0000168,
                            },
                        }),
                        { status: 200 },
                    );
                },
            },
        );

        const result = await client.decideChoices(
            { task: "food candidate selection" },
            [
                {
                    key: "milk",
                    instructions: "Choose the best milk candidate.",
                    criteria: {
                        c0: "skim milk",
                        c1: "2% milk",
                        NO_MATCH: "none",
                    },
                },
                {
                    key: "oat",
                    instructions: "Choose the best oat milk candidate.",
                    criteria: {
                        c0: "almond milk",
                        NO_MATCH: "none",
                    },
                },
            ],
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(
            "https://openrouter.example/api/alpha/decisions",
        );
        expect(calls[0]?.body.model).toBe("~typesafe/jev-latest");
        expect(Object.keys(calls[0]?.body.questions ?? {})).toEqual([
            "q0",
            "q1",
        ]);
        expect(result.resolvedModel).toBe("typesafe/jev-1.13-test");
        expect(result.results.get("milk")).toMatchObject({
            choice: "c1",
            confidence: 0.97,
        });
        expect(result.results.get("oat")).toMatchObject({
            choice: "NO_MATCH",
            confidence: 0.9,
        });
    });

    test("retries transient OpenRouter failures", async () => {
        let calls = 0;
        const sleeps: number[] = [];
        const client = new OpenRouterDecisionClient(
            {
                apiKey: "or-test",
                model: "~typesafe/jev-latest",
                endpoint: "https://openrouter.example/api/alpha/decisions",
                timeoutMs: 5_000,
                minConfidence: 0.75,
            },
            {
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
                fetcher: async () => {
                    calls += 1;
                    if (calls === 1) return new Response("rate limited", { status: 429 });
                    return new Response(
                        JSON.stringify({
                            answers: {
                                q0: {
                                    type: "choice",
                                    choice: "c0",
                                    probabilities: { c0: 1 },
                                    confidence: 1,
                                },
                            },
                        }),
                        { status: 200 },
                    );
                },
            },
        );

        const result = await client.decideChoices(
            {},
            [
                {
                    key: "x",
                    instructions: "Choose.",
                    criteria: { c0: "candidate" },
                },
            ],
        );
        expect(calls).toBe(2);
        expect(sleeps).toEqual([250]);
        expect(result.retries).toBe(1);
    });
});
