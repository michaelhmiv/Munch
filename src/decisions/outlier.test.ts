import { describe, expect, spyOn, test } from "bun:test";
import {
    detectOutlier,
    evaluateOutlierPrompt,
    type OutlierCandidate,
} from "./outlier.js";
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
        outlierTimeoutMs: 50,
        outlierEnabled: true,
        ...overrides,
    };
}

function waterSeries(values: number[]): OutlierCandidate["recent"] {
    return values.map((value, index) => ({
        value,
        logged_at: `2026-11-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
    }));
}

const outlierWater: OutlierCandidate = {
    kind: "water",
    entry: { value: 2500, logged_at: "2026-11-13T12:00:00.000Z" },
    recent: waterSeries([500, 500, 350, 500, 250]),
};

const outlierWeight: OutlierCandidate = {
    kind: "weight",
    entry: { value: 90_000, logged_at: "2026-11-13T07:00:00.000Z" },
    recent: [
        { value: 80_000, logged_at: "2026-11-10T07:00:00.000Z" },
        { value: 80_500, logged_at: "2026-11-12T07:00:00.000Z" },
    ],
};

function countingFetcher(
    handler: () => Response,
    calls: string[],
): DecisionsFetcher {
    return async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
            model: string;
        };
        calls.push(body.model);
        return handler();
    };
}

function answersResponse(
    pMistake: number,
    explanation = "unit_slip",
): Response {
    return new Response(
        JSON.stringify({
            answers: {
                likely_mistake: { type: "noul", noul: pMistake },
                explanation: { type: "choice", choice: explanation },
            },
            usage: { cost: 0.00004 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

describe("detectOutlier (deterministic first pass)", () => {
    test("water: >3x the user's median is an outlier", () => {
        const d = detectOutlier(outlierWater);
        expect(d.isOutlier).toBe(true);
        expect(d.baseline).toBe(500);
        expect(d.ratio).toBe(5);
        expect(d.reason).toBe("water_over_3x_median");
    });

    test("water: at or under 3x median is not an outlier", () => {
        const d = detectOutlier({
            ...outlierWater,
            entry: { value: 1500, logged_at: "2026-11-13T12:00:00.000Z" },
        });
        expect(d.isOutlier).toBe(false);
    });

    test("water: too little history means no baseline, no outlier", () => {
        const d = detectOutlier({
            ...outlierWater,
            recent: waterSeries([500, 500]),
        });
        expect(d.isOutlier).toBe(false);
        expect(d.baseline).toBeNull();
    });

    test("weight: >5% jump from the most recent prior weight", () => {
        const d = detectOutlier(outlierWeight);
        expect(d.isOutlier).toBe(true);
        expect(d.baseline).toBe(80_500);
        expect(d.reason).toBe("weight_over_5pct_jump");
    });

    test("weight: a 2% change is not an outlier; no history is not either", () => {
        expect(
            detectOutlier({
                ...outlierWeight,
                entry: { value: 82_000, logged_at: "2026-11-13T07:00:00.000Z" },
            }).isOutlier,
        ).toBe(false);
        expect(detectOutlier({ ...outlierWeight, recent: [] }).isOutlier).toBe(
            false,
        );
    });
});

describe("evaluateOutlierPrompt engagement rules", () => {
    test("normal entries make ZERO model calls", async () => {
        const calls: string[] = [];
        const verdict = await evaluateOutlierPrompt(
            {
                kind: "water",
                entry: { value: 500, logged_at: "2026-11-13T12:00:00.000Z" },
                recent: waterSeries([500, 500, 350, 500]),
            },
            {
                config: testConfig(),
                fetcher: countingFetcher(() => answersResponse(0.99), calls),
            },
        );
        expect(verdict.action).toBe("none");
        expect(calls).toHaveLength(0);
    });

    test("flag off: outlier makes ZERO model calls", async () => {
        const calls: string[] = [];
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: testConfig({ outlierEnabled: false }),
            fetcher: countingFetcher(() => answersResponse(0.99), calls),
        });
        expect(verdict).toEqual({ action: "none", reason: "seat_disabled" });
        expect(calls).toHaveLength(0);
    });

    test("no config: no prompt, no throw", async () => {
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: null,
        });
        expect(verdict.action).toBe("none");
    });

    test("outlier + model says likely mistake -> soft prompt with cost evidence", async () => {
        const calls: string[] = [];
        const info = spyOn(console, "info").mockImplementation(() => {});
        try {
            const verdict = await evaluateOutlierPrompt(outlierWater, {
                config: testConfig(),
                fetcher: countingFetcher(() => answersResponse(0.92), calls),
            });
            expect(calls).toEqual(["typesafe/jev-1.14"]);
            expect(verdict.action).toBe("prompt");
            if (verdict.action === "prompt") {
                expect(verdict.pMistake).toBe(0.92);
                expect(verdict.explanation).toBe("unit_slip");
                expect(verdict.reportedCostUsd).toBe(0.00004);
                expect(verdict.message).toContain("Log it anyway?");
                expect(verdict.message).toContain("2500 ml");
            }
            // cost_usd logging is inherited from the Decisions client.
            const logged = info.mock.calls.map((a) => String(a[0])).join("\n");
            expect(logged).toContain("seat=outlier");
            expect(logged).toContain("cost_usd=0.00004");
        } finally {
            info.mockRestore();
        }
    });

    test("outlier + model says genuine -> NO prompt (honest entries are not nagged)", async () => {
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: testConfig(),
            fetcher: countingFetcher(
                () => answersResponse(0.08, "genuine"),
                [],
            ),
        });
        expect(verdict).toEqual({
            action: "none",
            reason: "model_says_genuine",
        });
    });

    test("weight outlier prompts with the weight message", async () => {
        const verdict = await evaluateOutlierPrompt(outlierWeight, {
            config: testConfig(),
            fetcher: countingFetcher(
                () => answersResponse(0.88, "decimal_slip"),
                [],
            ),
        });
        expect(verdict.action).toBe("prompt");
        if (verdict.action === "prompt") {
            expect(verdict.message).toContain("decimal slip");
            expect(verdict.message).toContain("Log it anyway?");
        }
    });

    test("fail-open: chain down (all 5xx) resolves to no prompt, never throws", async () => {
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: testConfig(),
            fetcher: countingFetcher(
                () =>
                    new Response(
                        JSON.stringify({ error: { message: "down" } }),
                        {
                            status: 503,
                        },
                    ),
                [],
            ),
        });
        expect(verdict).toEqual({
            action: "none",
            reason: "decisions_unavailable",
        });
    });

    test("fail-open: unparseable answers resolve to no prompt", async () => {
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: testConfig(),
            fetcher: countingFetcher(
                () =>
                    new Response(
                        JSON.stringify({ answers: { likely_mistake: {} } }),
                        {
                            status: 200,
                        },
                    ),
                [],
            ),
        });
        expect(verdict.action).toBe("none");
    });

    test("fallback: Jev down walks to Perplexity and its verdict stands", async () => {
        const calls: string[] = [];
        let n = 0;
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
                model: string;
            };
            calls.push(body.model);
            n += 1;
            if (n <= 2) {
                return new Response(
                    JSON.stringify({ error: { message: "down" } }),
                    { status: 500 },
                );
            }
            return answersResponse(0.9);
        };
        const verdict = await evaluateOutlierPrompt(outlierWater, {
            config: testConfig(),
            fetcher,
        });
        expect(calls).toEqual([
            "typesafe/jev-1.14",
            "typesafe/jev-1.14",
            "perplexity/pplx-decider-v1.2",
        ]);
        expect(verdict.action).toBe("prompt");
        if (verdict.action === "prompt") {
            expect(verdict.model).toBe("perplexity/pplx-decider-v1.2");
        }
    });
});
