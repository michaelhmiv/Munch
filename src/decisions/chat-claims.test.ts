import { describe, expect, spyOn, test } from "bun:test";
import {
    buildChatClaimsQuestions,
    buildChatClaimsState,
    checkChatClaims,
    extractNumericClaims,
    scheduleChatClaimCheck,
    MAX_CLAIMS_PER_CALL,
    type ScheduleChatClaimCheckInput,
} from "./chat-claims.js";
import type { DecisionsFetcher } from "./client.js";
import type { DecisionsConfig } from "./config.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        chatClaimsEnabled: true,
        chatClaimsTimeoutMs: 50,
        ...overrides,
    };
}

/** Decisions response scoring each claim key from a per-key map. */
function claimsAnswers(scores: Record<string, number>): Response {
    const answers: Record<string, unknown> = {};
    for (const [key, probability] of Object.entries(scores)) {
        answers[key] = { type: "noul", noul: probability };
    }
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00005 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function httpError(status: number): Response {
    return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("extractNumericClaims (deterministic extraction)", () => {
    test("extracts distinct tokens with snippets and occurrence counts", () => {
        const claims = extractNumericClaims(
            "You are at 1,840 kcal today, about 460 kcal per serving, and 1,840 kcal is your total.",
        );
        expect(claims.map((claim) => claim.raw)).toEqual(["1,840", "460"]);
        expect(claims[0]!.occurrences).toBe(2);
        expect(claims[0]!.snippet).toContain("1,840 kcal");
        expect(claims.map((claim) => claim.key)).toEqual(["c0", "c1"]);
    });

    test("a sentence comma is not part of the number; thousands groups are", () => {
        // Regression (found by the C3 eval run): "Oct 7," must
        // extract "7", never "7,".
        expect(
            extractNumericClaims(
                "Looking at Oct 1 to Oct 7, you logged 61,200 kcal in total.",
            ).map((claim) => claim.raw),
        ).toEqual(["1", "7", "61,200"]);
    });

    test("handles decimals and percents; a claim-free reply extracts none", () => {
        expect(
            extractNumericClaims(
                "That is 1.5 g of sodium, 25% of the day.",
            ).map((claim) => claim.raw),
        ).toEqual(["1.5", "25%"]);
        expect(extractNumericClaims("Sounds good — enjoy your meal!")).toEqual(
            [],
        );
    });
});

describe("checkChatClaims (C3, log-only, fail-open)", () => {
    test("sourced claims pass, planted unsourced claims are logged as unsourced with claim/verdict/probability/model/cost", async () => {
        let seenBody: Record<string, any> = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            // c0 = "500" (in the tool result), c1 = "999" (planted).
            return claimsAnswers({ c0: 0.97, c1: 0.04 });
        };
        const info = spyOn(console, "info").mockImplementation(() => {});
        try {
            const outcome = await checkChatClaims(
                {
                    reply: "You logged 500 kcal at lunch and 999 kcal of protein magic.",
                    sourcedTexts: ['{"total_calories":500}'],
                },
                testConfig(),
                { fetcher },
            );
            expect(outcome.status).toBe("checked");
            if (outcome.status === "checked") {
                expect(outcome.model).toBe("typesafe/jev-1.14");
                expect(outcome.reportedCostUsd).toBe(0.00005);
                expect(outcome.claims).toEqual([
                    expect.objectContaining({
                        claim: "500",
                        verdict: "sourced",
                        probability: 0.97,
                    }),
                    expect.objectContaining({
                        claim: "999",
                        verdict: "unsourced",
                        probability: 0.04,
                    }),
                ]);
            }
            // The production call shape: reply + sourced values in the
            // state, one Noul per claim, seat named for the logs.
            expect(seenBody.model).toBe("typesafe/jev-1.14");
            const state = seenBody.state as Record<string, any>;
            expect(state.reply).toContain("999 kcal");
            expect(state.sourced_values).toContain("500");
            expect(Object.keys(seenBody.questions).sort()).toEqual([
                "c0",
                "c1",
            ]);
            expect(seenBody.questions.c0.type).toBe("noul");
            // Derivation discipline is in the question: rounding and
            // per-serving conversions count as supported.
            expect(seenBody.questions.c0.instructions).toContain("rounding");
            expect(seenBody.questions.c0.instructions).toContain(
                "dividing a sourced total",
            );
            const logged = info.mock.calls
                .map((args) => String(args[0]))
                .join("\n");
            expect(logged).toContain("seat=chat_claims");
            expect(logged).toContain("claim=999");
            expect(logged).toContain("verdict=unsourced");
            expect(logged).toContain("probability=0.04");
            expect(logged).toContain("model=typesafe/jev-1.14");
            expect(logged).toContain("cost_usd=0.00005");
        } finally {
            info.mockRestore();
        }
    });

    test("no numeric claims: skipped with ZERO Decisions calls", async () => {
        let calls = 0;
        const fetcher: DecisionsFetcher = async () => {
            calls += 1;
            return claimsAnswers({});
        };
        const outcome = await checkChatClaims(
            { reply: "Enjoy your meal!", sourcedTexts: ["{}"] },
            testConfig(),
            { fetcher },
        );
        expect(outcome).toEqual({
            status: "skipped",
            reason: "no_numeric_claims",
        });
        expect(calls).toBe(0);
    });

    test("whole chain down: fail-open unchecked, never throws", async () => {
        const fetcher: DecisionsFetcher = async () => httpError(502);
        const outcome = await checkChatClaims(
            {
                reply: "That was 500 kcal.",
                sourcedTexts: ['{"total_calories":500}'],
            },
            testConfig(),
            { fetcher },
        );
        expect(outcome.status).toBe("unchecked");
        if (outcome.status === "unchecked") {
            expect(outcome.reason).toBe("decisions_unavailable");
            expect(outcome.claims[0]!.verdict).toBe("unchecked");
        }
    });

    test("an unparseable answer leaves that claim unchecked, not accused", async () => {
        const fetcher: DecisionsFetcher = async () =>
            new Response(
                JSON.stringify({
                    answers: { c0: { type: "noul" } },
                    usage: { cost: 0.00005 },
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        const outcome = await checkChatClaims(
            {
                reply: "That was 500 kcal.",
                sourcedTexts: ['{"total_calories":500}'],
            },
            testConfig(),
            { fetcher },
        );
        expect(outcome.status).toBe("checked");
        if (outcome.status === "checked") {
            expect(outcome.claims[0]!.verdict).toBe("unchecked");
            expect(outcome.claims[0]!.probability).toBeNull();
        }
    });

    test("claims beyond the per-call cap are counted as truncated, not silently dropped", async () => {
        const manyNumbers = Array.from(
            { length: MAX_CLAIMS_PER_CALL + 3 },
            (_unused, index) => `${100 + index} kcal`,
        ).join(", ");
        const fetcher: DecisionsFetcher = async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
                questions: Record<string, unknown>;
            };
            expect(Object.keys(body.questions)).toHaveLength(
                MAX_CLAIMS_PER_CALL,
            );
            const scores: Record<string, number> = {};
            for (const key of Object.keys(body.questions)) scores[key] = 0.99;
            return claimsAnswers(scores);
        };
        const outcome = await checkChatClaims(
            { reply: `Totals: ${manyNumbers}.`, sourcedTexts: ["{}"] },
            testConfig(),
            { fetcher },
        );
        expect(outcome.status).toBe("checked");
        if (outcome.status === "checked") {
            expect(outcome.claims).toHaveLength(MAX_CLAIMS_PER_CALL);
            expect(outcome.truncatedClaims).toBe(3);
        }
    });

    test("state and questions builders carry exactly the checked claims", () => {
        const claims = extractNumericClaims(
            "A 500 kcal meal with 30 g protein.",
        );
        const state = buildChatClaimsState(
            { reply: "A 500 kcal meal.", sourcedTexts: ['{"x":500}'] },
            claims,
        ) as { claims: Array<{ claim: string }> };
        expect(state.claims.map((claim) => claim.claim)).toEqual(["500", "30"]);
        expect(Object.keys(buildChatClaimsQuestions(claims))).toEqual([
            "c0",
            "c1",
        ]);
    });
});

describe("scheduleChatClaimCheck (off the reply path)", () => {
    const input: ScheduleChatClaimCheckInput = {
        reply: "You are at 500 kcal today.",
        toolResultTexts: ['{"total_calories":500}'],
        contextTexts: ['{"today":{"totals":{"calories":500}}}'],
    };

    test("flag off: nothing is scheduled and zero calls are made", () => {
        let scheduled = 0;
        scheduleChatClaimCheck(input, {
            config: testConfig({ chatClaimsEnabled: false }),
            schedule: () => {
                scheduled += 1;
            },
        });
        expect(scheduled).toBe(0);
        // No config at all (no key / flags unset) is equally inert.
        scheduleChatClaimCheck(input, {
            config: null,
            schedule: () => {
                scheduled += 1;
            },
        });
        expect(scheduled).toBe(0);
    });

    test("a hung check never delays the caller: scheduling returns immediately, reply untouched", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let taskFinished = false;
        let capturedTask: (() => Promise<void>) | null = null;
        const replyBefore = input.reply;
        const startedAt = Date.now();
        scheduleChatClaimCheck(input, {
            config: testConfig(),
            schedule: (task) => {
                capturedTask = task;
            },
            runCheck: async () => {
                await gate;
                taskFinished = true;
                return { status: "skipped", reason: "test" };
            },
        });
        // The scheduling call itself returned synchronously.
        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(capturedTask).not.toBeNull();
        const running = capturedTask!();
        // Even once started, the check hangs on the gate while the
        // reply path has long since returned its bytes unchanged.
        expect(taskFinished).toBe(false);
        expect(input.reply).toBe(replyBefore);
        release();
        await running;
        expect(taskFinished).toBe(true);
    });

    test("log-only proof: the scheduled task receives the reply but its outcome cannot change it", async () => {
        const reply = "You are at 500 kcal and also 9,999 kcal of nonsense.";
        let seenReply: string | null = null;
        let capturedTask: (() => Promise<void>) | null = null;
        scheduleChatClaimCheck(
            { ...input, reply },
            {
                config: testConfig(),
                schedule: (task) => {
                    capturedTask = task;
                },
                runCheck: async (checkInput) => {
                    seenReply = checkInput.reply;
                    // Even a chain-down / hostile outcome is just a
                    // value the caller never reads.
                    return {
                        status: "unchecked",
                        reason: "decisions_unavailable",
                        claims: [],
                    };
                },
            },
        );
        await capturedTask!();
        expect(seenReply).toBe(reply);
        expect(reply).toBe(
            "You are at 500 kcal and also 9,999 kcal of nonsense.",
        );
    });
});
