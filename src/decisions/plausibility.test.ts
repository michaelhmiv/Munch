import { describe, expect, test } from "bun:test";
import {
    buildPlausibilityQuestions,
    buildPlausibilityState,
    reviewRecipePlausibility,
    type PlausibilityIngredientState,
} from "./plausibility.js";
import type { DecisionsConfig } from "./config.js";

const CONFIG: DecisionsConfig = {
    apiKey: ["test", "key"].join("-"),
    apiUrl: "https://openrouter.ai/api/alpha/decisions",
    models: ["typesafe/jev-1.14"],
    gateTimeoutMs: 1500,
    deciderTimeoutMs: 2000,
    gateEnabled: true,
    deciderEnabled: true,
    plausibilityTimeoutMs: 5000,
    plausibilityEnabled: true,
    matchTimeoutMs: 2_000,
    matchEnabled: true,
    pantryMatchEnabled: true,
    pantryMatchTimeoutMs: 2_000,
    drawdownReviewEnabled: true,
    drawdownReviewTimeoutMs: 2_000,
    draftReviewTimeoutMs: 2_000,
    draftReviewEnabled: true,
};

const MILK: PlausibilityIngredientState = {
    name: "Whole Milk",
    quantity: 3,
    unit: "cup",
    resolution: "assumed_provider_match",
    providerFoodName: "Milk, whole",
    providerDataKind: "generic",
    portionLabel: "Guideline amount per cup of hot cereal",
    gramWeight: 183,
    kcal: 111.63,
    impliedGramsPerUnit: 61,
    deterministicFlags: ["assumed_portion_implausible"],
};

function noulFetcher(
    probabilities: Record<string, number>,
    captured?: string[],
) {
    return async (_input: unknown, init?: { body?: string }) => {
        if (init?.body) captured?.push(init.body);
        const answers: Record<string, unknown> = {};
        for (const [key, probability] of Object.entries(probabilities)) {
            answers[key] = { type: "noul", noul: probability };
        }
        return new Response(
            JSON.stringify({ answers, usage: { cost: 0.00005 } }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
}

describe("A1 shared checker state shape (audit §2)", () => {
    test("state carries exactly the audit fields per ingredient", () => {
        const state = buildPlausibilityState([MILK]) as {
            ingredients: Array<Record<string, unknown>>;
        };
        const row = state.ingredients[0]!;
        expect(row.name).toBe("Whole Milk");
        expect(row.quantity).toBe(3);
        expect(row.unit).toBe("cup");
        expect(row.provider_food_name).toBe("Milk, whole");
        expect(row.provider_data_kind).toBe("generic");
        expect(row.portion_label).toBe(
            "Guideline amount per cup of hot cereal",
        );
        expect(row.gram_weight).toBe(183);
        expect(row.kcal).toBe(111.63);
        expect(row.implied_kcal_per_100g).toBe(61);
        expect(row.implied_grams_per_unit).toBe(61);
    });

    test("ANONYMITY: the wire payload contains ingredient names + numbers only", async () => {
        const captured: string[] = [];
        await reviewRecipePlausibility([MILK], CONFIG, {
            fetcher: noulFetcher({ q0: 0.99 }, captured) as never,
        });
        expect(captured).toHaveLength(1);
        const body = captured[0]!;
        // No identity-shaped content of any kind.
        for (const forbidden of [
            "user_id",
            "userId",
            "email",
            "@",
            "recipe_id",
            "recipeId",
            "account",
            "owner",
        ]) {
            expect(body).not.toContain(forbidden);
        }
        const parsed = JSON.parse(body) as { state: unknown };
        expect(JSON.stringify(parsed.state)).not.toMatch(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
    });

    test("one batched call per recipe (all ingredients in one body)", async () => {
        const captured: string[] = [];
        const ingredients = Array.from({ length: 5 }, (_, i) => ({
            ...MILK,
            name: `Ingredient ${i}`,
        }));
        await reviewRecipePlausibility(ingredients, CONFIG, {
            fetcher: noulFetcher(
                { q0: 0.1, q1: 0.1, q2: 0.1, q3: 0.1, q4: 0.1 },
                captured,
            ) as never,
        });
        expect(captured).toHaveLength(1);
        const questions = buildPlausibilityQuestions(ingredients);
        expect(Object.keys(questions)).toHaveLength(5);
    });
});

describe("A1 checker verdicts", () => {
    test("confirms at/above the serving model's threshold; cost is reported", async () => {
        const review = await reviewRecipePlausibility([MILK], CONFIG, {
            fetcher: noulFetcher({ q0: 0.97 }) as never,
        });
        expect(review.status).toBe("reviewed");
        if (review.status !== "reviewed") return;
        expect(review.model).toBe("typesafe/jev-1.14");
        expect(review.verdicts[0]!.confirmedImplausible).toBe(true);
        expect(review.reportedCostUsd).toBe(0.00005);
    });

    test("a low p(implausible) clears the ingredient (no accusation)", async () => {
        const review = await reviewRecipePlausibility([MILK], CONFIG, {
            fetcher: noulFetcher({ q0: 0.03 }) as never,
        });
        expect(review.status).toBe("reviewed");
        if (review.status !== "reviewed") return;
        expect(review.verdicts[0]!.confirmedImplausible).toBe(false);
    });

    test("an abstention (unparseable answer) never confirms", async () => {
        const fetcher = async () =>
            new Response(
                JSON.stringify({
                    answers: { q0: { type: "noul" } },
                    usage: {},
                }),
                { status: 200 },
            );
        const review = await reviewRecipePlausibility([MILK], CONFIG, {
            fetcher: fetcher as never,
        });
        expect(review.status).toBe("reviewed");
        if (review.status !== "reviewed") return;
        expect(review.verdicts[0]!.pImplausible).toBeNull();
        expect(review.verdicts[0]!.confirmedImplausible).toBe(false);
    });

    test("chain down -> unchecked (fail-open), never a throw", async () => {
        const fetcher = async () => new Response("down", { status: 503 });
        const review = await reviewRecipePlausibility([MILK], CONFIG, {
            fetcher: fetcher as never,
        });
        expect(review.status).toBe("unchecked");
    });
});
