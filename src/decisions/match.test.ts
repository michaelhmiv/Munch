import { describe, expect, test } from "bun:test";
import { applyAmbiguousMatchDecider, isWithinAmbiguityBand } from "./match.js";
import type { DecisionsConfig } from "./config.js";
import type { DecisionsFetcher } from "./client.js";
import { scoreCandidate } from "../food-providers/ranking.js";
import { AMBIGUITY_MARGIN } from "../meal-photo/grounding.js";
import type { FoodCandidate } from "../food-providers/types.js";

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
        pantryMatchEnabled: true,
        pantryMatchTimeoutMs: 50,
        drawdownReviewEnabled: true,
        drawdownReviewTimeoutMs: 50,
        ...overrides,
    };
}

const FULL_PANEL = {
    calories: 402,
    protein_g: 25,
    carbs_g: 0.1,
    fat_g: 33,
    fiber_g: 0,
    sugar_g: 0,
    sodium_mg: 180,
    saturated_fat_g: 21,
    cholesterol_mg: 105,
    potassium_mg: 98,
};

function candidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
    return {
        provider: "usda",
        providerFoodId: "171571",
        name: "Sharp Cheddar Cheese",
        dataKind: "generic",
        nutrientsPer100g: { ...FULL_PANEL },
        portions: [
            {
                id: "oz",
                amount: 1,
                unit: "oz",
                label: "1 oz",
                gramWeight: 28,
                nutrients: { calories: 113 },
            },
        ],
        attribution: { label: "USDA FoodData Central" },
        confidence: 0.8,
        ...overrides,
    };
}

/**
 * The type specimen (audit §2 B2): a packaged processed entry ranked
 * first on panel completeness while the generic food it names sits
 * second, with identity scores inside the ambiguity band. The
 * packaged entry's portion panel is the full one (completeness 10/11
 * via its per-100 g fallback in scoreCandidate terms is equalized
 * below by construction — the margin assertion in the first test is
 * the load-bearing check, computed from the real scorer).
 */
function specimenPair(): FoodCandidate[] {
    // The packaged entry carries the rich panel (so the
    // completeness-dominant ranker promotes it); the generic entry's
    // panel is sparse. Identity scoring runs the other way — the
    // generic exact-name entry outscores the branded one — so the
    // signed margin lands inside the band.
    const packaged = candidate({
        provider: "open_food_facts",
        providerFoodId: "off-packaged-cheddar",
        brand: "PackCo",
        dataKind: "packaged",
        confidence: 0.82,
        portions: [
            {
                id: "oz",
                amount: 1,
                unit: "oz",
                label: "1 oz",
                gramWeight: 28,
                nutrients: { ...FULL_PANEL },
            },
        ],
    });
    const generic = candidate({
        provider: "usda",
        providerFoodId: "171571",
        brand: undefined,
        dataKind: "generic",
        confidence: 0.8,
        nutrientsPer100g: { calories: 402, protein_g: 25 },
    });
    return [packaged, generic];
}

function decisionsResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers, usage: { cost: 0.00003 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function pickingFetcher(choice: string, counter?: { calls: number }) {
    const fetcher: DecisionsFetcher = async () => {
        if (counter) counter.calls += 1;
        return decisionsResponse({
            q0: { type: "choice", choice, confidence: 0.9 },
        });
    };
    return fetcher;
}

describe("isWithinAmbiguityBand (AMBIGUITY_MARGIN reused from grounding)", () => {
    test("the specimen pair really is inside the band under the real scorer", () => {
        const [packaged, generic] = specimenPair();
        // Grounding's margin is SIGNED (score(top) - score(second)):
        // a completeness-promoted top candidate that does not
        // outscore #2 by the full band is ambiguous — including when
        // #2 outscores it, which is exactly the specimen's shape
        // (the generic entry wins on identity score; the packaged
        // entry was promoted by rankCandidates' completeness sort).
        const margin =
            scoreCandidate({ query: "sharp cheddar cheese" }, packaged!) -
            scoreCandidate({ query: "sharp cheddar cheese" }, generic!);
        expect(margin).toBeLessThan(AMBIGUITY_MARGIN);
        expect(
            isWithinAmbiguityBand("sharp cheddar cheese", specimenPair()),
        ).toBe(true);
    });

    test("just inside vs just outside the band (confidence-driven margins)", () => {
        const base = candidate({ providerFoodId: "a", confidence: 0.9 });
        const inside = candidate({
            providerFoodId: "b",
            confidence: 0.9 - 0.39, // score margin 0.078 < 0.08
        });
        const outside = candidate({
            providerFoodId: "c",
            confidence: 0.9 - 0.41, // score margin 0.082 > 0.08
        });
        expect(
            isWithinAmbiguityBand("sharp cheddar cheese", [base, inside]),
        ).toBe(true);
        expect(
            isWithinAmbiguityBand("sharp cheddar cheese", [base, outside]),
        ).toBe(false);
    });

    test("fewer than two candidates is never in the band", () => {
        expect(isWithinAmbiguityBand("x", [])).toBe(false);
        expect(isWithinAmbiguityBand("x", [candidate()])).toBe(false);
    });
});

describe("applyAmbiguousMatchDecider (seat B2)", () => {
    test("flag OFF: zero model calls, list untouched (same reference)", async () => {
        const counter = { calls: 0 };
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            {
                config: testConfig({ matchEnabled: false }),
                fetcher: pickingFetcher("c1", counter),
            },
        );
        expect(counter.calls).toBe(0);
        expect(result).toBe(ranked);
    });

    test("no config (no key): zero model calls, list untouched", async () => {
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            { config: null, fetcher: pickingFetcher("c1") },
        );
        expect(result).toBe(ranked);
    });

    test("outside the band: zero model calls even with the seat on", async () => {
        const counter = { calls: 0 };
        const ranked = [
            candidate({ providerFoodId: "a", confidence: 0.95 }),
            candidate({ providerFoodId: "b", confidence: 0.4 }),
        ];
        expect(isWithinAmbiguityBand("sharp cheddar cheese", ranked)).toBe(
            false,
        );
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            { config: testConfig(), fetcher: pickingFetcher("c1", counter) },
        );
        expect(counter.calls).toBe(0);
        expect(result).toBe(ranked);
    });

    test("inside the band: the model's pick is promoted, rest keep order", async () => {
        const ranked = specimenPair();
        const third = candidate({
            providerFoodId: "third",
            name: "Cheese sauce",
        });
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            [...ranked, third],
            { config: testConfig(), fetcher: pickingFetcher("c1") },
        );
        expect(result[0]!.providerFoodId).toBe("171571");
        expect(result[1]!.providerFoodId).toBe("off-packaged-cheddar");
        expect(result[2]!.providerFoodId).toBe("third");
    });

    test("inside the band: model confirming the top changes nothing", async () => {
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            { config: testConfig(), fetcher: pickingFetcher("c0") },
        );
        expect(result).toBe(ranked);
    });

    test("inside the band: a 'none' verdict leaves the deterministic top standing", async () => {
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            { config: testConfig(), fetcher: pickingFetcher("none") },
        );
        expect(result).toBe(ranked);
    });

    test("fail-open: whole chain down (5xx) -> deterministic top stands, no throw", async () => {
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            {
                config: testConfig(),
                fetcher: async () =>
                    new Response(
                        JSON.stringify({ error: { message: "down" } }),
                        {
                            status: 500,
                        },
                    ),
            },
        );
        expect(result).toBe(ranked);
        expect(result[0]!.providerFoodId).toBe("off-packaged-cheddar");
    });

    test("fail-open: garbage body -> deterministic top stands", async () => {
        const ranked = specimenPair();
        const result = await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            ranked,
            {
                config: testConfig({ models: ["typesafe/jev-1.14"] }),
                fetcher: async () => new Response("garbage", { status: 200 }),
            },
        );
        expect(result).toBe(ranked);
    });

    test("the request carries S2's state shape (query + shortlist candidates)", async () => {
        let seenBody: Record<string, any> = {};
        const fetcher: DecisionsFetcher = async (_input, init) => {
            seenBody = JSON.parse(String(init?.body ?? "{}"));
            return decisionsResponse({
                q0: { type: "choice", choice: "c1", confidence: 0.9 },
            });
        };
        await applyAmbiguousMatchDecider(
            "sharp cheddar cheese",
            specimenPair(),
            {
                config: testConfig(),
                fetcher,
            },
        );
        expect(seenBody.state.items[0].photographed_item).toBe(
            "sharp cheddar cheese",
        );
        expect(seenBody.state.items[0].candidates).toHaveLength(2);
        expect(seenBody.state.items[0].candidates[0].source_database).toBe(
            "open_food_facts",
        );
        expect(seenBody.questions.q0.criteria.c1).toContain(
            "Sharp Cheddar Cheese",
        );
        expect(seenBody.questions.q0.criteria.none).toContain("No candidate");
    });
});
