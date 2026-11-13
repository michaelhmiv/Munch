import { describe, expect, spyOn, test } from "bun:test";
import {
    callDecisionsWithFallback,
    DecisionsChainExhaustedError,
    type DecisionsFetcher,
} from "./client.js";
import type { DecisionsConfig } from "./config.js";

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
        plausibilityTimeoutMs: 50,
        plausibilityEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        ...overrides,
    };
}

function okAnswers(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00013 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function httpError(status: number, message = "boom"): Response {
    return new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

interface RecordedCall {
    model: string;
    headers: Record<string, string>;
}

/** Fetcher scripted per call index; records the model of each request. */
function scriptedFetcher(
    script: Array<(callIndex: number) => Promise<Response> | Response>,
    calls: RecordedCall[],
): DecisionsFetcher {
    return async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
            model: string;
        };
        calls.push({
            model: body.model,
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        const step = script[calls.length - 1] ?? script[script.length - 1]!;
        return step(calls.length - 1);
    };
}

const baseOptions = {
    seat: "decider" as const,
    state: { task: "test" },
    questions: { q0: { type: "choice" } },
    timeoutMs: 50,
    includeImageHeader: false,
};

describe("callDecisionsWithFallback chain discipline", () => {
    test("primary success: one call, raw answers + cost returned", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher(
            [() => okAnswers({ q0: { type: "choice", choice: "c0" } })],
            calls,
        );
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            fetcher,
        });
        expect(calls.map((call) => call.model)).toEqual(["typesafe/jev-1.14"]);
        expect(result.model).toBe("typesafe/jev-1.14");
        expect(result.reportedCostUsd).toBe(0.00013);
        expect(result.answers.q0).toEqual({ type: "choice", choice: "c0" });
    });

    test("transient 5xx: exactly one retry on the same model, then success", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher(
            [() => httpError(503), () => okAnswers({})],
            calls,
        );
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            fetcher,
        });
        expect(calls.map((call) => call.model)).toEqual([
            "typesafe/jev-1.14",
            "typesafe/jev-1.14",
        ]);
        expect(result.model).toBe("typesafe/jev-1.14");
    });

    test("primary down: chain walks to fallback #1 in order", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher(
            [() => httpError(500), () => httpError(500), () => okAnswers({})],
            calls,
        );
        const info = spyOn(console, "info").mockImplementation(() => {});
        try {
            const result = await callDecisionsWithFallback(testConfig(), {
                ...baseOptions,
                fetcher,
            });
            expect(calls.map((call) => call.model)).toEqual([
                "typesafe/jev-1.14",
                "typesafe/jev-1.14",
                "perplexity/pplx-decider-v1.2",
            ]);
            expect(result.model).toBe("perplexity/pplx-decider-v1.2");
            const logged = info.mock.calls
                .map((args) => String(args[0]))
                .join("\n");
            expect(logged).toContain("event=fallback");
            expect(logged).toContain("next_model=perplexity/pplx-decider-v1.2");
        } finally {
            info.mockRestore();
        }
    });

    test("hard 404 (no endpoints): NO retry, straight to the next model", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher(
            [() => httpError(404, "No endpoints found"), () => okAnswers({})],
            calls,
        );
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            fetcher,
        });
        expect(calls.map((call) => call.model)).toEqual([
            "typesafe/jev-1.14",
            "perplexity/pplx-decider-v1.2",
        ]);
        expect(result.model).toBe("perplexity/pplx-decider-v1.2");
    });

    test("timeout: a hung model is abandoned after the bounded timeout", async () => {
        const calls: RecordedCall[] = [];
        const hang: DecisionsFetcher = (_input, init) => {
            calls.push({ model: "typesafe/jev-1.14", headers: {} });
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new Error("The operation was aborted")),
                );
            });
        };
        let callCount = 0;
        const fetcher: DecisionsFetcher = async (input, init) => {
            callCount += 1;
            if (callCount <= 2) return hang(input, init);
            return okAnswers({});
        };
        const startedAt = Date.now();
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            timeoutMs: 25,
            fetcher,
        });
        expect(result.model).toBe("perplexity/pplx-decider-v1.2");
        expect(callCount).toBe(3);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    test("garbage 200 (unparseable body): retryable, walks the chain", async () => {
        const calls: RecordedCall[] = [];
        const garbage = () =>
            new Response("<html>not json</html>", { status: 200 });
        const fetcher = scriptedFetcher(
            [garbage, garbage, () => okAnswers({})],
            calls,
        );
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            fetcher,
        });
        expect(calls).toHaveLength(3);
        expect(result.model).toBe("perplexity/pplx-decider-v1.2");
    });

    test("garbage 200 (valid JSON, no answers object): also retryable", async () => {
        const calls: RecordedCall[] = [];
        const noAnswers = () =>
            new Response(JSON.stringify({ model: "x" }), { status: 200 });
        const fetcher = scriptedFetcher(
            [noAnswers, noAnswers, () => okAnswers({})],
            calls,
        );
        const result = await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            fetcher,
        });
        expect(result.model).toBe("perplexity/pplx-decider-v1.2");
    });

    test("whole chain down: DecisionsChainExhaustedError with per-model attempts", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher([() => httpError(502)], calls);
        await expect(
            callDecisionsWithFallback(testConfig(), {
                ...baseOptions,
                fetcher,
            }),
        ).rejects.toBeInstanceOf(DecisionsChainExhaustedError);
        // 2 attempts (initial + one retry) x 3 models.
        expect(calls).toHaveLength(6);
    });

    test("image header is sent only when the call carries an image", async () => {
        const calls: RecordedCall[] = [];
        const fetcher = scriptedFetcher([() => okAnswers({})], calls);
        await callDecisionsWithFallback(testConfig(), {
            ...baseOptions,
            seat: "gate",
            includeImageHeader: true,
            fetcher,
        });
        expect(calls[0]!.headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    });
});
