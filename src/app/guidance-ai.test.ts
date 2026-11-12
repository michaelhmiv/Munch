import { describe, expect, test } from "bun:test";
import { generateGuidanceProposals } from "./guidance-ai.js";
import { buildGoalsContext } from "../goals-context.js";

const config = {
    apiKey: "fixture-key",
    baseUrl: "https://openrouter.invalid/v1",
    model: "meta/muse-ember",
    timeoutMs: 1_000,
    maxTokens: 2_000,
};

const slots = [
    { date: "2026-11-10", meal_slot: "dinner" as const, servings: 2 },
];

const safeContext = {
    preferences: {},
    saved_recipe_names: [],
    recent_plan_history: [],
};

const validContent = JSON.stringify({
    items: [
        {
            date: "2026-11-10",
            meal_slot: "dinner",
            servings: 2,
            generated_recipe: {
                name: "Fixture Herb Chicken",
                ingredients: [
                    {
                        name: "chicken breast",
                        quantity: 400,
                        unit: "g",
                        optional: false,
                    },
                ],
                instructions: ["Grill the chicken."],
                servings: 2,
                preparation_minutes: 15,
                cooking_minutes: 25,
                difficulty: "easy",
                required_equipment: ["skillet"],
                cuisine_tags: ["fixture"],
                primary_protein: "chicken",
                cooking_methods: ["grill"],
            },
        },
    ],
});

function envelope(content: string): Response {
    return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

describe("guidance proposal model call", () => {
    test("sends the healing plugin and config caps, and parses a proposal", async () => {
        let requestBody: Record<string, any> = {};
        const result = await generateGuidanceProposals(
            { config, slots, safeContext },
            {
                fetcher: async (_url, init) => {
                    requestBody = JSON.parse(String(init?.body ?? "{}"));
                    return envelope(validContent);
                },
            },
        );
        expect(result.status).toBe("proposed");
        if (result.status === "proposed") {
            expect(result.model).toBe("meta/muse-ember");
            expect(result.items).toHaveLength(1);
            expect(result.items[0]?.generated_recipe?.name).toBe(
                "Fixture Herb Chicken",
            );
        }
        expect(requestBody.model).toBe("meta/muse-ember");
        expect(requestBody.max_tokens).toBe(2_000);
        expect(requestBody.plugins).toEqual([{ id: "response-healing" }]);
        expect(requestBody.provider).toEqual({
            data_collection: "deny",
        });
    });

    test("retries once on unparseable output, then succeeds", async () => {
        let calls = 0;
        const result = await generateGuidanceProposals(
            { config, slots, safeContext },
            {
                fetcher: async () => {
                    calls += 1;
                    return envelope(calls === 1 ? "not json" : validContent);
                },
            },
        );
        expect(calls).toBe(2);
        expect(result.status).toBe("proposed");
    });

    test("falls back to manual entry after the retry is exhausted", async () => {
        let calls = 0;
        const result = await generateGuidanceProposals(
            { config, slots, safeContext },
            {
                fetcher: async () => {
                    calls += 1;
                    return envelope("still not json");
                },
            },
        );
        expect(calls).toBe(2);
        expect(result.status).toBe("manual_fallback");
        if (result.status === "manual_fallback") {
            expect(result.manual_entry_available).toBe(true);
        }
    });

    test("falls back to manual entry on a provider HTTP error without retrying", async () => {
        let calls = 0;
        const result = await generateGuidanceProposals(
            { config, slots, safeContext },
            {
                fetcher: async () => {
                    calls += 1;
                    return new Response("nope", { status: 503 });
                },
            },
        );
        expect(calls).toBe(1);
        expect(result.status).toBe("manual_fallback");
    });

    const milkAllergyContext = buildGoalsContext({
        intake: {
            stated_goal: null,
            activity_band: null,
            eating_pattern: null,
            hardest_meal: null,
            never_suggest: [],
            allergies: ["milk"],
        },
    });

    function recipeItem(name: string, ingredient: string) {
        return {
            date: "2026-11-10",
            meal_slot: "dinner",
            servings: 2,
            generated_recipe: {
                name,
                ingredients: [
                    {
                        name: ingredient,
                        quantity: 200,
                        unit: "g",
                        optional: false,
                    },
                ],
                instructions: ["Cook it."],
                servings: 2,
                preparation_minutes: 10,
                cooking_minutes: 20,
                difficulty: "easy",
                required_equipment: ["skillet"],
                cuisine_tags: ["fixture"],
                primary_protein: "chicken",
                cooking_methods: ["grill"],
            },
        };
    }

    test("a proposal implicating a stated allergy is removed by the post-filter", async () => {
        // "cheddar" implicates the milk allergy via the alias table —
        // the model returning it anyway must not put it on screen.
        const cheesy = JSON.stringify({
            items: [recipeItem("Fixture Cheese Chicken", "cheddar")],
        });
        const result = await generateGuidanceProposals(
            { config, slots, safeContext },
            {
                fetcher: async () => envelope(cheesy),
                goalsContext: milkAllergyContext,
            },
        );
        expect(result.status).toBe("manual_fallback");
        if (result.status === "manual_fallback") {
            expect(result.message).toContain("allergies on file");
        }
    });

    test("only the violating proposal is dropped when others are clean", async () => {
        const twoSlots = [
            { date: "2026-11-10", meal_slot: "dinner" as const, servings: 2 },
            { date: "2026-11-11", meal_slot: "dinner" as const, servings: 2 },
        ];
        const mixed = JSON.stringify({
            items: [
                recipeItem("Fixture Cheese Chicken", "cheddar"),
                {
                    ...recipeItem("Fixture Herb Chicken", "chicken breast"),
                    date: "2026-11-11",
                },
            ],
        });
        const result = await generateGuidanceProposals(
            { config, slots: twoSlots, safeContext },
            {
                fetcher: async () => envelope(mixed),
                goalsContext: milkAllergyContext,
            },
        );
        expect(result.status).toBe("proposed");
        if (result.status === "proposed") {
            expect(result.items).toHaveLength(1);
            expect(result.items[0]?.generated_recipe?.name).toBe(
                "Fixture Herb Chicken",
            );
        }
    });
});
