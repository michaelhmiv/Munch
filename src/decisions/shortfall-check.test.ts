import { describe, expect, spyOn, test } from "bun:test";
import {
    buildShortfallCheckQuestions,
    buildShortfallCheckState,
    checkShortfallContradictionsViaDecisions,
    reviewShortfallContradictions,
    type ShortfallCheckRow,
} from "./shortfall-check.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";

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
        draftReviewTimeoutMs: 50,
        draftReviewEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        shortfallCheckEnabled: true,
        shortfallCheckTimeoutMs: 50,
        ...overrides,
    };
}

function row(overrides: Partial<ShortfallCheckRow> = {}): ShortfallCheckRow {
    return {
        name: "Flour",
        normalized_name: "flour",
        need_quantity: 500,
        need_unit: "g",
        have_quantity: 200,
        short_quantity: 300,
        pantry_state: "short",
        on_list: false,
        pantry_flag: {
            state: "have",
            pantry_item_id: "inv-1",
            pantry_name: "Flour",
        },
        ...overrides,
    };
}

/** Consistent-but-odd: exact stock present yet short — flag "have" is CORRECT. */
const consistentOdd = row();
/** Planted contradiction: row says pantry has none, flag says have. */
const contradictionHave = row({
    name: "Milk",
    normalized_name: "milk",
    need_quantity: 1,
    need_unit: "l",
    have_quantity: 0,
    short_quantity: 1,
    pantry_state: "none",
    pantry_flag: {
        state: "have",
        pantry_item_id: "inv-2",
        pantry_name: "Milk",
    },
});
/** Planted reverse contradiction: row claims exact stock, flag says none. */
const contradictionNone = row({
    name: "Butter",
    normalized_name: "butter",
    need_quantity: 250,
    have_quantity: 100,
    short_quantity: 150,
    pantry_flag: { state: "none", pantry_item_id: null, pantry_name: null },
});

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00004 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function noul(p: number) {
    return { type: "noul", noul: p };
}

describe("C2 state/questions (one batched call shape)", () => {
    test("state carries every row with both channels; one question per row", () => {
        const rows = [consistentOdd, contradictionHave];
        const state = buildShortfallCheckState(rows) as any;
        expect(state.rows).toHaveLength(2);
        expect(state.rows[0]).toMatchObject({
            item: "Flour",
            pantry_state: "short",
            pantry_flag: "have",
        });
        expect(state.rows[1]).toMatchObject({
            item: "Milk",
            pantry_state: "none",
            pantry_flag: "have",
        });
        const questions = buildShortfallCheckQuestions(rows);
        expect(Object.keys(questions)).toEqual(["r0", "r1"]);
        // The false-alarm discipline is in the wording: short+have is
        // taught as correct, presence-only is taught explicitly.
        expect((questions.r0 as any).instructions).toContain(
            "NOT contradictions",
        );
        expect((questions.r0 as any).instructions).toContain("presence only");
    });
});

describe("checkShortfallContradictionsViaDecisions", () => {
    test("ONE call carries all rows; per-row probabilities map back in order", async () => {
        let calls = 0;
        let seenBody: any = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            calls += 1;
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            return decisionsResponse({
                r0: noul(0.05),
                r1: noul(0.93),
                r2: noul(0.88),
            });
        };
        const result = await checkShortfallContradictionsViaDecisions(
            [consistentOdd, contradictionHave, contradictionNone],
            testConfig(),
            { fetcher },
        );
        expect(calls).toBe(1);
        expect(Object.keys(seenBody.questions)).toEqual(["r0", "r1", "r2"]);
        expect(seenBody.state.rows).toHaveLength(3);
        expect(result.probabilities).toEqual([0.05, 0.93, 0.88]);
        expect(result.flaggedIndexes).toEqual([1, 2]);
        expect(result.model).toBe("typesafe/jev-1.14");
        expect(result.reportedCostUsd).toBe(0.00004);
    });

    test("a missing/unparseable answer is an abstention, never a flag", async () => {
        const result = await checkShortfallContradictionsViaDecisions(
            [consistentOdd, contradictionHave],
            testConfig(),
            {
                fetcher: async () =>
                    decisionsResponse({ r0: { type: "noul" } }),
            },
        );
        expect(result.probabilities).toEqual([null, null]);
        expect(result.flaggedIndexes).toEqual([]);
    });
});

describe("reviewShortfallContradictions (wired seat)", () => {
    test("flag OFF: zero Decisions calls, rows untouched", async () => {
        let calls = 0;
        const rows = [contradictionHave];
        const result = await reviewShortfallContradictions(rows, () => rows, {
            config: testConfig({ shortfallCheckEnabled: false }),
            fetcher: async () => {
                calls += 1;
                throw new Error("must not be called");
            },
        });
        expect(calls).toBe(0);
        expect(result.status).toBe("disabled");
        expect(result.rows).toEqual(rows);
    });

    test("no config (no key): zero calls, rows untouched", async () => {
        const rows = [contradictionHave];
        const result = await reviewShortfallContradictions(rows, () => rows, {
            config: null,
        });
        expect(result.status).toBe("disabled");
        expect(result.rows).toEqual(rows);
    });

    test("empty rundown: zero calls", async () => {
        let calls = 0;
        const result = await reviewShortfallContradictions([], () => [], {
            config: testConfig(),
            fetcher: async () => {
                calls += 1;
                throw new Error("must not be called");
            },
        });
        expect(calls).toBe(0);
        expect(result.status).toBe("disabled");
    });

    test("consistent rundown (incl. short+have): one call, no recompute, no flags", async () => {
        let calls = 0;
        let recomputes = 0;
        const rows = [consistentOdd];
        const result = await reviewShortfallContradictions(
            rows,
            () => {
                recomputes += 1;
                return rows;
            },
            {
                config: testConfig(),
                fetcher: async () => {
                    calls += 1;
                    return decisionsResponse({ r0: noul(0.04) });
                },
            },
        );
        expect(calls).toBe(1);
        expect(recomputes).toBe(0);
        expect(result.status).toBe("consistent");
        expect(result.contradictions).toEqual([]);
        expect(result.rows[0]).not.toHaveProperty("contradiction_flag");
        expect(result.reportedCostUsd).toBe(0.00004);
    });

    test("persistent contradiction: recompute ONCE, then surface on that row only", async () => {
        let recomputes = 0;
        const rows = [consistentOdd, contradictionHave, contradictionNone];
        const result = await reviewShortfallContradictions(
            rows,
            () => {
                recomputes += 1;
                // Deterministic recompute reproduces the same rows.
                return rows.map((r) => ({
                    ...r,
                    pantry_flag: { ...r.pantry_flag },
                }));
            },
            {
                config: testConfig(),
                fetcher: async () =>
                    decisionsResponse({
                        r0: noul(0.02),
                        r1: noul(0.95),
                        r2: noul(0.91),
                    }),
            },
        );
        expect(recomputes).toBe(1);
        expect(result.status).toBe("contradiction");
        expect(result.contradictions.map((c) => c.normalized_name)).toEqual([
            "milk",
            "butter",
        ]);
        expect(result.rows[0]).not.toHaveProperty("contradiction_flag");
        expect(result.rows[1]!.contradiction_flag).toMatchObject({
            model: "typesafe/jev-1.14",
            probability: 0.95,
        });
        expect(result.rows[2]!.contradiction_flag?.probability).toBe(0.91);
        // Rows are never edited, dropped, or reordered by the seat.
        expect(result.rows.map((r) => r.normalized_name)).toEqual([
            "flour",
            "milk",
            "butter",
        ]);
        expect(result.rows[1]!.short_quantity).toBe(1);
    });

    test("non-persistent contradiction: recompute disagrees -> nothing surfaced", async () => {
        let recomputes = 0;
        const rows = [contradictionHave];
        const result = await reviewShortfallContradictions(
            rows,
            () => {
                recomputes += 1;
                // Recompute finds the flag was stale: row now consistent.
                return [
                    {
                        ...contradictionHave,
                        pantry_flag: {
                            state: "none" as const,
                            pantry_item_id: null,
                            pantry_name: null,
                        },
                    },
                ];
            },
            {
                config: testConfig(),
                fetcher: async () => decisionsResponse({ r0: noul(0.97) }),
            },
        );
        expect(recomputes).toBe(1);
        expect(result.status).toBe("consistent");
        expect(result.contradictions).toEqual([]);
        expect(result.rows[0]).not.toHaveProperty("contradiction_flag");
    });

    test("DRILL — whole chain down: fail-open, rows exactly as computed", async () => {
        let calls = 0;
        const rows = [consistentOdd, contradictionHave];
        const info = spyOn(console, "info").mockImplementation(() => {});
        try {
            const result = await reviewShortfallContradictions(
                rows,
                () => rows,
                {
                    config: testConfig(),
                    fetcher: async () => {
                        calls += 1;
                        return new Response(
                            JSON.stringify({ error: { message: "down" } }),
                            { status: 500 },
                        );
                    },
                },
            );
            // 2 models x (initial + one retry) before terminal fail-open.
            expect(calls).toBe(4);
            expect(result.status).toBe("unchecked");
            expect(result.rows).toEqual(rows);
            expect(result.contradictions).toEqual([]);
        } finally {
            info.mockRestore();
        }
    });

    test("fallback model answers: its own threshold applies and cost is logged by the client", async () => {
        const info = spyOn(console, "info").mockImplementation(() => {});
        try {
            const rows = [contradictionHave];
            const result = await reviewShortfallContradictions(
                rows,
                () => rows,
                {
                    config: testConfig(),
                    fetcher: async (_input, init) => {
                        const body = JSON.parse(String(init?.body ?? "{}"));
                        if (body.model === "typesafe/jev-1.14") {
                            return new Response(
                                JSON.stringify({ error: { message: "down" } }),
                                { status: 404 },
                            );
                        }
                        return decisionsResponse({ r0: noul(0.9) });
                    },
                },
            );
            expect(result.status).toBe("contradiction");
            expect(result.rows[0]!.contradiction_flag?.model).toBe(
                "perplexity/pplx-decider-v1.2",
            );
            const logged = info.mock.calls
                .map((args) => String(args[0]))
                .join("\n");
            // The shared client's success line carries cost_usd — the
            // inherited cost logging the audit requires per call.
            expect(logged).toContain("seat=shortfall_check");
            expect(logged).toContain("cost_usd=0.00004");
        } finally {
            info.mockRestore();
        }
    });
});
