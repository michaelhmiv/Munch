import { describe, expect, test } from "bun:test";
import {
    attachPantryIdentityReviews,
    resolvePantryIdentity,
    reviewPantryIdentityPair,
    type PantryIdentityPair,
} from "./pantry-match.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";
import {
    inventoryIdentityScore,
    type InventoryMatchableItem,
} from "../inventory/matching.js";

function testConfig(overrides: Partial<DecisionsConfig> = {}): DecisionsConfig {
    return {
        apiKey: "test-key",
        apiUrl: "https://decisions.test/api",
        models: ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.2"],
        gateTimeoutMs: 50,
        deciderTimeoutMs: 50,
        gateEnabled: true,
        deciderEnabled: true,
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        ...overrides,
    };
}

function item(
    overrides: Partial<InventoryMatchableItem> = {},
): InventoryMatchableItem {
    return {
        id: "item-1",
        name: "cheddar aged cheese",
        normalized_name: "cheddar aged cheese",
        quantity: 2,
        unit: "cup",
        quantity_mode: "exact",
        stock_state: "available",
        food_provider: null,
        provider_food_id: null,
        ...overrides,
    };
}

/** A fetcher answering both B3 questions with fixed probabilities. */
function answeringFetcher(pSame: number, pUnits: number, counter = { calls: 0 }): DecisionsFetcher {
    return async () => {
        counter.calls += 1;
        return new Response(
            JSON.stringify({
                answers: {
                    same_item: { type: "noul", noul: pSame },
                    units_compatible: { type: "noul", noul: pUnits },
                },
                usage: { cost: 0.00004 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
}

const failingFetcher: DecisionsFetcher = async () =>
    new Response(JSON.stringify({ error: { message: "down" } }), {
        status: 500,
    });

describe("B3 fixture band sanity (scores computed by the production scorer)", () => {
    test("the grey fixtures really land in the 0.50–0.75 band", () => {
        const score = (existing: string, incoming: string) =>
            inventoryIdentityScore(
                { normalized_name: existing, food_provider: null, provider_food_id: null },
                { name: incoming },
            );
        // Token-overlap pairs where neither name contains the other
        // as a substring (a substring scores 0.82, above the band).
        expect(score("cheddar aged cheese", "cheddar cheese")).toBeCloseTo(0.667, 3);
        expect(score("sliced cheddar cheese", "shredded cheddar cheese")).toBeCloseTo(0.5, 3);
        expect(score("swiss aged cheese slices", "swiss cheese slices")).toBeCloseTo(0.75, 3);
        expect(score("chicken stock", "chicken broth")).toBeCloseTo(0.333, 3);
        expect(score("swiss aged deli cheese slices", "swiss aged cheese slices")).toBeCloseTo(0.8, 3);
    });
});

describe("resolvePantryIdentity — seat disabled is exactly today", () => {
    test("grey pair merges deterministically at the 0.62 threshold, zero model calls", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 1, unit: "cup" },
            {
                config: testConfig({ pantryMatchEnabled: false }),
                fetcher: answeringFetcher(0.01, 0.01, counter),
            },
        );
        expect(result.action).toBe("merge");
        if (result.action === "merge") expect(result.via).toBe("deterministic");
        expect(counter.calls).toBe(0);
    });

    test("below-threshold pair stays separate, zero calls", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item({ name: "chicken stock", normalized_name: "chicken stock" })],
            { name: "chicken broth", quantity: 1, unit: "cup" },
            {
                config: testConfig({ pantryMatchEnabled: false }),
                fetcher: answeringFetcher(0.99, 0.99, counter),
            },
        );
        expect(result.action).toBe("separate");
        expect(counter.calls).toBe(0);
    });

    test("no config at all behaves like today", async () => {
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 1, unit: "cup" },
            { config: null },
        );
        expect(result.action).toBe("merge");
    });
});

describe("resolvePantryIdentity — seat enabled, outside the band", () => {
    test("above-band match merges deterministically with zero calls", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item({ name: "swiss aged deli cheese slices", normalized_name: "swiss aged deli cheese slices", unit: "count" })],
            { name: "swiss aged cheese slices", quantity: 4, unit: "count" },
            { config: testConfig(), fetcher: answeringFetcher(0.01, 0.01, counter) },
        );
        expect(result.action).toBe("merge");
        if (result.action === "merge") expect(result.via).toBe("deterministic");
        expect(counter.calls).toBe(0);
    });

    test("below-band pair never engages the model", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item({ name: "chicken stock", normalized_name: "chicken stock" })],
            { name: "chicken broth", quantity: 1, unit: "cup" },
            { config: testConfig(), fetcher: answeringFetcher(0.99, 0.99, counter) },
        );
        expect(result.action).toBe("separate");
        if (result.action === "separate") expect(result.reason).toBe("below_band");
        expect(counter.calls).toBe(0);
    });
});

describe("resolvePantryIdentity — grey band engages exactly one review", () => {
    test("band low edge (0.50) engages; a confident yes to both questions merges", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item({ name: "sliced cheddar cheese", normalized_name: "sliced cheddar cheese", unit: "cup" })],
            { name: "shredded cheddar cheese", quantity: 2, unit: "cup" },
            { config: testConfig(), fetcher: answeringFetcher(0.95, 0.9, counter) },
        );
        expect(counter.calls).toBe(1);
        expect(result.action).toBe("merge");
        if (result.action === "merge") {
            expect(result.via).toBe("jev");
            expect(result.review?.reportedCostUsd).toBe(0.00004);
        }
    });

    test("band high edge (0.75) engages", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item({ name: "swiss aged cheese slices", normalized_name: "swiss aged cheese slices", unit: "count" })],
            { name: "swiss cheese slices", quantity: 4, unit: "count" },
            { config: testConfig(), fetcher: answeringFetcher(0.9, 0.9, counter) },
        );
        expect(counter.calls).toBe(1);
        expect(result.action).toBe("merge");
    });

    test("a model no on same-item keeps strangers separate (false-merge discipline)", async () => {
        const result = await resolvePantryIdentity(
            [item({ name: "cheddar aged cheese", normalized_name: "cheddar aged cheese", unit: "cup" })],
            { name: "cheddar cheese spread", quantity: 1, unit: "cup" },
            { config: testConfig(), fetcher: answeringFetcher(0.04, 0.9) },
        );
        expect(result.action).toBe("separate");
        if (result.action === "separate") {
            expect(result.reason).toBe("model_declined");
            expect(result.checked).toBe(true);
        }
    });

    test("same item but incompatible units (model no) stays separate", async () => {
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 12, unit: "count" },
            { config: testConfig(), fetcher: answeringFetcher(0.95, 0.05) },
        );
        expect(result.action).toBe("separate");
        if (result.action === "separate") expect(result.reason).toBe("model_declined");
    });

    test("mass vs volume never merges even when the model says yes to both (code guard)", async () => {
        const counter = { calls: 0 };
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 1, unit: "lb" },
            { config: testConfig(), fetcher: answeringFetcher(0.99, 0.99, counter) },
        );
        expect(counter.calls).toBe(1);
        expect(result.action).toBe("separate");
        if (result.action === "separate") expect(result.reason).toBe("units_cross_family");
    });

    test("chain down fails open to NO merge and reports unchecked", async () => {
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 1, unit: "cup" },
            { config: testConfig(), fetcher: failingFetcher },
        );
        expect(result.action).toBe("separate");
        if (result.action === "separate") {
            expect(result.reason).toBe("unchecked");
            expect(result.checked).toBe(false);
        }
    });

    test("unparseable answers fail open to NO merge", async () => {
        const fetcher: DecisionsFetcher = async () =>
            new Response(JSON.stringify({ answers: { nope: 1 } }), { status: 200 });
        const result = await resolvePantryIdentity(
            [item()],
            { name: "cheddar cheese", quantity: 1, unit: "cup" },
            { config: testConfig(), fetcher },
        );
        expect(result.action).toBe("separate");
        if (result.action === "separate") expect(result.reason).toBe("unchecked");
    });
});

describe("attachPantryIdentityReviews (scan-confirm wiring)", () => {
    test("reviews food lines with candidates, skips non-food, keeps original indices", async () => {
        const counter = { calls: 0 };
        const reviews = await attachPantryIdentityReviews(
            [
                { name: "paper towels", quantity: 1, unit: "count", is_food: false },
                { name: "cheddar cheese", quantity: 1, unit: "cup", is_food: true },
                { name: "unicorn sprinkles", quantity: 1, unit: "count", is_food: true },
            ],
            [item()],
            { config: testConfig(), fetcher: answeringFetcher(0.95, 0.95, counter) },
        );
        expect(Object.keys(reviews)).toEqual(["1"]);
        expect(reviews[1]?.action).toBe("merge");
        expect(counter.calls).toBe(1);
    });
});

describe("reviewPantryIdentityPair (production call shape)", () => {
    test("returns probabilities, the serving model, and the API-reported cost", async () => {
        const pair: PantryIdentityPair = {
            incoming: { name: "cheddar cheese", quantity: 1, unit: "cup" },
            existing: { id: "item-1", name: "cheddar aged cheese", quantity: 2, unit: "cup", quantityMode: "exact" },
            identityScore: 0.667,
        };
        const review = await reviewPantryIdentityPair(pair, testConfig(), {
            fetcher: answeringFetcher(0.9, 0.8),
        });
        expect(review.pSameItem).toBe(0.9);
        expect(review.pUnitsCompatible).toBe(0.8);
        expect(review.model).toBe("typesafe/jev-1.14");
        expect(review.reportedCostUsd).toBe(0.00004);
    });
});
