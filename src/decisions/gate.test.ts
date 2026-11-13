import { describe, expect, test } from "bun:test";
import { evaluateMealPhotoGate, noulProbability } from "./gate.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14"],
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

/** Minimal JPEG carrying a SOF0 segment with the given dimensions. */
function jpegBytes(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0x03,
        0x01,
        0x22,
        0x00,
        0x02,
        0x11,
        0x01,
        0x03,
        0x11,
        0x01,
    ]);
}

/** Minimal PNG carrying an IHDR with the given dimensions. */
function pngBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

function gateAnswers(payload: {
    pFood: number;
    pClear?: number;
    route?: string;
}): Response {
    return new Response(
        JSON.stringify({
            answers: {
                food: { type: "noul", noul: payload.pFood },
                route: {
                    type: "choice",
                    choice: payload.route ?? "plated_meal",
                    probabilities: { [payload.route ?? "plated_meal"]: 0.95 },
                },
                clear: { type: "noul", noul: payload.pClear ?? 0.99 },
            },
            usage: { cost: 0.00013 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

describe("noulProbability answer shapes", () => {
    test("reads the live {noul} shape and the documented fallbacks", () => {
        expect(noulProbability({ type: "noul", noul: 0.42 })).toBe(0.42);
        expect(noulProbability({ probability: 0.7 })).toBe(0.7);
        expect(noulProbability({ probabilities: { true: 0.3 } })).toBe(0.3);
        expect(noulProbability({ value: false, confidence: 0.75 })).toBe(0.25);
        expect(noulProbability({})).toBeNull();
        expect(noulProbability(null)).toBeNull();
        expect(noulProbability("nope")).toBeNull();
    });
});

describe("evaluateMealPhotoGate (S1, fail-open)", () => {
    test("confident food: proceeds, sends the probe wire shape", async () => {
        let seenBody: Record<string, any> = {};
        let seenHeaders: Record<string, string> = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            seenHeaders = (init?.headers ?? {}) as Record<string, string>;
            return gateAnswers({ pFood: 0.98 });
        };
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(1200, 900) },
            testConfig(),
            { fetcher },
        );
        expect(verdict.action).toBe("proceed");
        expect(seenHeaders["TypeSafe-Danger-Zone-Images"]).toBe("true");
        expect(seenBody.model).toBe("typesafe/jev-1.14");
        const state = seenBody.state as Array<any>;
        expect(state[0].type).toBe("image_url");
        expect(state[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
        expect(typeof state[1]).toBe("string");
        const questions = seenBody.questions as Record<string, any>;
        expect(Object.keys(questions).sort()).toEqual([
            "clear",
            "food",
            "route",
        ]);
        // Plain style (the measured probe runs): Nouls carry no criteria.
        expect(questions.food.criteria).toBeUndefined();
        expect(questions.route.criteria.receipt).toContain("receipt");
    });

    test("confident not-food: no_food verdict under the model's threshold", async () => {
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/png", bytes: pngBytes(800, 800) },
            testConfig({
                models: ["perplexity/pplx-decider-v1.2"],
            }),
            {
                fetcher: async () =>
                    gateAnswers({ pFood: 0.004, route: "other" }),
            },
        );
        expect(verdict.action).toBe("no_food");
        if (verdict.action === "no_food") {
            expect(verdict.model).toBe("perplexity/pplx-decider-v1.2");
            expect(verdict.pFood).toBe(0.004);
            expect(verdict.threshold).toBe(0.1);
            expect(verdict.route).toBe("other");
        }
    });

    test("d1-ultra calibration band: hottest negative (0.071) rejected, weakest positive (0.84) proceeds", async () => {
        // Bake-off separation for d1-ultra: negatives peaked at 0.071,
        // positives bottomed at 0.84. The 0.10 threshold sits inside
        // that band — above the hottest negative (so it is rejected,
        // the least margin of the three models) and far below the
        // weakest real meal (so no false reject).
        const negative = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(640, 640) },
            testConfig({ models: ["liquid/d1-ultra"] }),
            { fetcher: async () => gateAnswers({ pFood: 0.071 }) },
        );
        expect(negative.action).toBe("no_food");
        const positive = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(640, 640) },
            testConfig({ models: ["liquid/d1-ultra"] }),
            { fetcher: async () => gateAnswers({ pFood: 0.84 }) },
        );
        expect(positive.action).toBe("proceed");
    });

    test("a confident RECEIPT route is log-only: the photo proceeds", async () => {
        // Receipts steer through the pantry flow, not this route; the
        // gate's only action is the not-food verdict.
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(1000, 1400) },
            testConfig(),
            {
                fetcher: async () =>
                    gateAnswers({ pFood: 0.6, route: "receipt" }),
            },
        );
        expect(verdict.action).toBe("proceed");
    });

    test("provider down (transport throw): fail-open, never throws", async () => {
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(900, 900) },
            testConfig(),
            {
                fetcher: async () => {
                    throw new Error("network down");
                },
            },
        );
        expect(verdict).toEqual({
            action: "proceed",
            reason: "decisions_unavailable",
        });
    });

    test("unparseable food answer: fail-open", async () => {
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(900, 900) },
            testConfig(),
            {
                fetcher: async () =>
                    new Response(
                        JSON.stringify({ answers: { food: { type: "noul" } } }),
                        { status: 200 },
                    ),
            },
        );
        expect(verdict.action).toBe("proceed");
    });

    test("WebP upload: gate skipped without any provider call", async () => {
        let calls = 0;
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/webp", bytes: new Uint8Array([1, 2, 3]) },
            testConfig(),
            {
                fetcher: async () => {
                    calls += 1;
                    return gateAnswers({ pFood: 0 });
                },
            },
        );
        expect(verdict).toEqual({
            action: "proceed",
            reason: "unsupported_media_type",
        });
        expect(calls).toBe(0);
    });

    test("out-of-range dimensions: gate skipped without any provider call", async () => {
        let calls = 0;
        const verdict = await evaluateMealPhotoGate(
            { mimeType: "image/jpeg", bytes: jpegBytes(100, 100) },
            testConfig(),
            {
                fetcher: async () => {
                    calls += 1;
                    return gateAnswers({ pFood: 0 });
                },
            },
        );
        expect(verdict).toEqual({
            action: "proceed",
            reason: "image_dimensions_out_of_range",
        });
        expect(calls).toBe(0);
    });
});
