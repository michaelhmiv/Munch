import { describe, expect, test } from "bun:test";
import {
    buildBulkReviewState,
    buildDraftReviewState,
    impliedKcalPer100g,
    reviewBulkImportRows,
    reviewDraftNumbers,
    selectBulkOutlierCandidates,
    type BulkReviewRow,
    type DraftReviewItem,
} from "./draft-review.js";
import {
    draftReviewPlausibleThresholdForModel,
    type DecisionsConfig,
} from "./config.js";
import type { DecisionsFetcher } from "./client.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14"],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        draftReviewTimeoutMs: 50,
        draftReviewEnabled: true,
        matchTimeoutMs: 50,
        matchEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        ...overrides,
    };
}

interface Captured {
    body: any;
    headers: Record<string, string>;
}

/** Fetcher answering noul probabilities from a per-question map. */
function answeringFetcher(
    probabilities: Record<string, number>,
    captured: Captured[],
    cost = 0.00007,
): DecisionsFetcher {
    return async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        captured.push({
            body,
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        const answers: Record<string, unknown> = {};
        for (const key of Object.keys(body.questions ?? {})) {
            if (probabilities[key] !== undefined) {
                answers[key] = { type: "noul", noul: probabilities[key] };
            }
        }
        return new Response(JSON.stringify({ answers, usage: { cost } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}

const OIL_AT_SALAD_GRAMS: DraftReviewItem = {
    foodName: "Olive oil",
    portionLabel: "1 cup",
    grams: 32,
    kcal: 283,
    groundingSource: "USDA",
};
const REAL_CUP_OF_OIL: DraftReviewItem = {
    foodName: "Olive oil",
    portionLabel: "1 cup",
    grams: 216,
    kcal: 1909,
    groundingSource: "USDA",
};
const CHICKEN: DraftReviewItem = {
    foodName: "Chicken breast, grilled",
    portionLabel: "1 breast",
    grams: 172,
    kcal: 284,
    groundingSource: "USDA",
};

describe("A3 draft numeric review — state shape", () => {
    test("implied kcal/100 g is computed by code, not the model", () => {
        expect(impliedKcalPer100g(REAL_CUP_OF_OIL)).toBe(883.8);
        expect(impliedKcalPer100g({ ...CHICKEN, grams: null })).toBeNull();
        expect(impliedKcalPer100g({ ...CHICKEN, kcal: null })).toBeNull();
    });

    test("state carries exactly the audit's per-item fields", () => {
        const state = buildDraftReviewState([CHICKEN]) as any;
        expect(Object.keys(state.items[0]).sort()).toEqual(
            [
                "food_name",
                "grams",
                "grounding_source",
                "implied_kcal_per_100g",
                "kcal",
                "portion_label",
                "question",
            ].sort(),
        );
        expect(state.items[0].food_name).toBe("Chicken breast, grilled");
        expect(state.items[0].implied_kcal_per_100g).toBe(165.12);
    });
});

describe("A3 draft numeric review — PIXEL-FREE proof", () => {
    test("the Decisions payload contains no image field of any kind", async () => {
        const captured: Captured[] = [];
        const threshold =
            draftReviewPlausibleThresholdForModel("typesafe/jev-1.14");
        await reviewDraftNumbers([CHICKEN], {
            config: testConfig(),
            fetcher: answeringFetcher({ q0: threshold + 0.1 }, captured),
        });
        expect(captured).toHaveLength(1);
        const { body, headers } = captured[0]!;
        const serialized = JSON.stringify(body);
        // No image transport anywhere in the payload: no image_url
        // parts, no data URLs, no base64 blobs, no image header.
        expect(serialized).not.toContain("image_url");
        expect(serialized).not.toContain("data:image");
        expect(serialized).not.toContain("base64");
        expect(headers["TypeSafe-Danger-Zone-Images"]).toBeUndefined();
        const keys: string[] = [];
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === "object") {
                for (const [key, inner] of Object.entries(value)) {
                    keys.push(key);
                    walk(inner);
                }
            }
        };
        walk(body);
        expect(
            keys.filter((key) => /image|photo|pixel|bytes/i.test(key)),
        ).toEqual([]);
        // Only the three wire keys the Decisions client ever sends.
        expect(Object.keys(body).sort()).toEqual(
            ["model", "questions", "state"].sort(),
        );
    });
});

describe("A3 draft numeric review — verdicts", () => {
    test("ONE batched call per draft; flagged = p(plausible) below the model's threshold", async () => {
        const captured: Captured[] = [];
        const threshold =
            draftReviewPlausibleThresholdForModel("typesafe/jev-1.14");
        const outcome = await reviewDraftNumbers(
            [OIL_AT_SALAD_GRAMS, REAL_CUP_OF_OIL, CHICKEN],
            {
                config: testConfig(),
                fetcher: answeringFetcher(
                    {
                        q0: Math.max(0, threshold - 0.2),
                        q1: Math.min(1, threshold + 0.3),
                        q2: Math.min(1, threshold + 0.3),
                    },
                    captured,
                ),
            },
        );
        expect(captured).toHaveLength(1);
        expect(Object.keys(captured[0]!.body.questions)).toHaveLength(3);
        expect(outcome.status).toBe("reviewed");
        if (outcome.status !== "reviewed") throw new Error("unreachable");
        expect(outcome.model).toBe("typesafe/jev-1.14");
        // Cost evidence rides the outcome (API-reported, §4).
        expect(outcome.reportedCostUsd).toBe(0.00007);
        expect(outcome.verdicts.map((v) => v.flagged)).toEqual([
            true,
            false,
            false,
        ]);
        expect(outcome.verdicts[0]!.index).toBe(0);
    });

    test("fail-open: chain down -> unchecked, no verdicts, never throws", async () => {
        const down: DecisionsFetcher = async () =>
            new Response(JSON.stringify({ error: { message: "boom" } }), {
                status: 503,
            });
        const outcome = await reviewDraftNumbers([CHICKEN], {
            config: testConfig(),
            fetcher: down,
        });
        expect(outcome.status).toBe("unchecked");
        expect(outcome.verdicts).toEqual([]);
    });

    test("fail-open: unparseable answers -> unchecked", async () => {
        const captured: Captured[] = [];
        const outcome = await reviewDraftNumbers([CHICKEN], {
            config: testConfig(),
            fetcher: answeringFetcher({}, captured),
        });
        expect(outcome.status).toBe("unchecked");
    });

    test("flag off = zero calls; no config = zero calls", async () => {
        const captured: Captured[] = [];
        const fetcher = answeringFetcher({ q0: 0.99 }, captured);
        const off = await reviewDraftNumbers([CHICKEN], {
            config: testConfig({ draftReviewEnabled: false }),
            fetcher,
        });
        expect(off.status).toBe("unchecked");
        if (off.status === "unchecked") expect(off.reason).toBe("disabled");
        const none = await reviewDraftNumbers([CHICKEN], {
            config: null,
            fetcher,
        });
        expect(none.status).toBe("unchecked");
        expect(captured).toHaveLength(0);
    });
});

function bulkRow(partial: Partial<BulkReviewRow>): BulkReviewRow {
    return {
        description: "Meal",
        kcal: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        alcohol_g: null,
        ...partial,
    };
}

const NORMAL_BATCH: BulkReviewRow[] = [
    bulkRow({ description: "Oatmeal and fruit", kcal: 420 }),
    bulkRow({ description: "Chicken sandwich", kcal: 560 }),
    bulkRow({ description: "Pasta with tomato sauce", kcal: 640 }),
    bulkRow({ description: "Green salad with egg", kcal: 380 }),
    bulkRow({ description: "Beef stew", kcal: 590 }),
    bulkRow({ description: "Yogurt and granola", kcal: 450 }),
];

describe("A3 bulk-import fold-in", () => {
    test("deterministic pre-filter: dwarf + Atwater-mismatch rows are candidates, normal rows are not", () => {
        const rows = [
            ...NORMAL_BATCH,
            bulkRow({ description: "Side salad", kcal: 6200 }),
            bulkRow({
                description: "Grilled chicken plate",
                kcal: 1800,
                protein_g: 40,
                carbs_g: 30,
                fat_g: 20,
            }),
        ];
        const candidates = selectBulkOutlierCandidates(rows);
        expect(candidates.map((c) => c.index)).toEqual([6, 7]);
        expect(candidates[1]!.atwaterImpliedKcal).toBe(460);
    });

    test("one batched call per import; only the implausible outlier is flagged", async () => {
        const captured: Captured[] = [];
        const threshold =
            draftReviewPlausibleThresholdForModel("typesafe/jev-1.14");
        const rows = [
            ...NORMAL_BATCH,
            bulkRow({ description: "Side salad", kcal: 6200 }),
            bulkRow({ description: "Thanksgiving feast plate", kcal: 4300 }),
        ];
        const outcome = await reviewBulkImportRows(rows, {
            config: testConfig(),
            fetcher: answeringFetcher(
                {
                    q0: Math.max(0, threshold - 0.2),
                    q1: Math.min(1, threshold + 0.3),
                },
                captured,
            ),
        });
        expect(captured).toHaveLength(1);
        const state = buildBulkReviewState(
            rows,
            selectBulkOutlierCandidates(rows),
        ) as any;
        expect(state.surface).toBe("bulk_import_meals");
        expect(outcome.status).toBe("reviewed");
        expect(outcome.flagged.map((f) => f.description)).toEqual([
            "Side salad",
        ]);
        expect(outcome.reportedCostUsd).toBe(0.00007);
    });

    test("no outliers = zero calls; flag off = zero calls", async () => {
        const captured: Captured[] = [];
        const fetcher = answeringFetcher({ q0: 0.01 }, captured);
        const plain = await reviewBulkImportRows(NORMAL_BATCH, {
            config: testConfig(),
            fetcher,
        });
        expect(plain.status).toBe("unchecked");
        if (plain.status === "unchecked")
            expect(plain.reason).toBe("no_outliers");
        const rows = [
            ...NORMAL_BATCH,
            bulkRow({ description: "Side salad", kcal: 6200 }),
        ];
        const off = await reviewBulkImportRows(rows, {
            config: testConfig({ draftReviewEnabled: false }),
            fetcher,
        });
        expect(off.status).toBe("unchecked");
        expect(captured).toHaveLength(0);
    });

    test("bulk fail-open: chain down -> unchecked, nothing flagged", async () => {
        const down: DecisionsFetcher = async () =>
            new Response("nope", { status: 500 });
        const rows = [
            ...NORMAL_BATCH,
            bulkRow({ description: "Side salad", kcal: 6200 }),
        ];
        const outcome = await reviewBulkImportRows(rows, {
            config: testConfig(),
            fetcher: down,
        });
        expect(outcome.status).toBe("unchecked");
        expect(outcome.flagged).toEqual([]);
    });
});
