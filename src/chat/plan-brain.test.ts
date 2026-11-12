import { describe, expect, test } from "bun:test";
import { requestChatReply } from "./agent.js";
import type { ChatAiConfig } from "./config.js";
import type { ChatContextSummary } from "./context.js";
import { assembleEntrySeed, type ChatSeedDependencies } from "./seeds.js";
import type { ChatModelTool, ChatToolExecution } from "./tools.js";

/**
 * Plan brain (plan-brain brief, Part 1) — the action path end to
 * end in the chat test harness: the meal-plan seed assembles
 * (pantry + screened recipe candidates + goals context), the model
 * works from that seed, picks an idea, drafts it into a dinner slot
 * through the existing meal-plan-draft tool, and offers the missing
 * ingredients through the existing grocery-add path. The planted
 * allergen recipe never reaches the model: the seed's hard allergy
 * filter excluded it before the conversation started, which the
 * first model request's payload proves.
 */

const config: ChatAiConfig = {
    // Value assembled so no credential-shaped literal sits in source.
    apiKey: ["fixture", "key"].join("-"),
    model: "meta/muse-ember",
    baseUrl: "https://openrouter.invalid/v1",
    timeoutMs: 1_000,
    maxTokens: 2_500,
};

const context: ChatContextSummary = {
    date: "2026-11-11",
    timezone: "UTC",
    sections: ["goals", "today_totals"],
    goals: {
        daily_calories: 2000,
        daily_protein_g: null,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_fiber_g: null,
    },
    today: {
        totals: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
    },
};

const tools: ChatModelTool[] = [
    {
        name: "create_meal_plan_draft",
        description: "Create a meal plan draft",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "add_grocery_items",
        description: "Add items to the grocery list",
        inputSchema: { type: "object", properties: {} },
    },
];

function envelope(message: Record<string, unknown>): Response {
    return new Response(
        JSON.stringify({
            id: "fixture-chat",
            model: "meta/muse-ember",
            choices: [{ message: { role: "assistant", ...message } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

function toolCallEnvelope(
    calls: Array<{ id: string; name: string; arguments: string }>,
): Response {
    return envelope({
        content: null,
        tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
        })),
    });
}

const pantryItem = (id: string, name: string, normalized: string) => ({
    id,
    name,
    normalized_name: normalized,
    quantity: 1,
    unit: "pack",
    quantity_mode: "exact",
    stock_state: "available",
    location: "fridge",
    food_provider: null,
    provider_food_id: null,
});

const recipe = (id: string, name: string, ingredients: string[]) => ({
    recipe_id: id,
    revision_id: `rev-${id}`,
    name,
    servings: 2,
    nutrition_per_serving: {
        calories: 500,
        protein_g: 35,
        carbs_g: 40,
        fat_g: 20,
        fiber_g: 4,
    },
    total_minutes: 30,
    ingredients: ingredients.map((ingredient) => ({ name: ingredient })),
});

function seedDeps(): ChatSeedDependencies {
    return {
        profile: async () => ({ timezone: "UTC" }),
        plan: async () => [] as never,
        pantry: async () =>
            ({
                items: [
                    pantryItem("p1", "Chicken thighs", "chicken thighs"),
                    pantryItem("p2", "Spinach", "spinach"),
                    pantryItem("p3", "Peanut butter", "peanut butter"),
                ],
            }) as never,
        preferences: async () =>
            ({
                objective: "maintain",
                allergies: ["peanut"],
                excluded_ingredients: [],
                disliked_ingredients: [],
                liked_ingredients: [],
                cuisines: [],
            }) as never,
        recipes: async () =>
            [
                recipe("recipe-skillet", "Chicken spinach skillet", [
                    "Chicken thighs",
                    "Spinach",
                    "Garlic",
                ]),
                recipe("recipe-peanut", "Peanut noodles", [
                    "Peanut butter",
                    "Noodles",
                ]),
            ] as never,
        features: async () => ({
            plan: true,
            recipes: true,
            groceries: true,
            pantry: true,
            cooks: true,
        }),
    };
}

describe("plan brain", () => {
    test("seed → pick an idea → plan draft + grocery offer, allergen never offered", async () => {
        const seed = await assembleEntrySeed("user-1", "meal_plan", seedDeps());
        expect(seed).not.toBeNull();

        const requestBodies: Array<Record<string, unknown>> = [];
        const executed: Array<{
            name: string;
            args: Record<string, unknown>;
        }> = [];
        let call = 0;
        const fetcher = async (
            _input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> => {
            call += 1;
            const body = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
            >;
            requestBodies.push(body);
            if (call === 1) {
                return toolCallEnvelope([
                    {
                        id: "call-plan",
                        name: "create_meal_plan_draft",
                        arguments: JSON.stringify({
                            recipe_id: "recipe-skillet",
                            meal_slot: "dinner",
                        }),
                    },
                ]);
            }
            if (call === 2) {
                return toolCallEnvelope([
                    {
                        id: "call-groceries",
                        name: "add_grocery_items",
                        arguments: JSON.stringify({
                            items: [{ name: "Garlic" }],
                        }),
                    },
                ]);
            }
            return envelope({
                content:
                    "Chicken spinach skillet is drafted for dinner — it uses your chicken thighs and spinach; garlic is on the grocery list. Review the draft in the plan to confirm it.",
            });
        };
        const executeTool = async (
            name: string,
            args: Record<string, unknown>,
        ): Promise<ChatToolExecution> => {
            executed.push({ name, args });
            if (name === "create_meal_plan_draft") {
                return {
                    text: "Meal plan draft plan-draft-1 created with Chicken spinach skillet in a dinner slot. The user reviews and commits it in the app.",
                    isError: false,
                    outcome: "ok",
                    draftId: "plan-draft-1",
                };
            }
            return {
                text: "Added 1 item to the grocery list: Garlic.",
                isError: false,
                outcome: "ok",
            };
        };

        const result = await requestChatReply(
            {
                config,
                context,
                entrySeed: seed,
                history: [],
                message: "Three dinners from my pantry this week",
                tools,
            },
            { fetcher, executeTool },
        );

        // The seed the model actually received: pantry-first job,
        // screened candidates, allergen material nowhere in it.
        const firstRequestText = JSON.stringify(requestBodies[0]);
        expect(firstRequestText).toContain("pantry_first_dinner_ideas");
        expect(firstRequestText).toContain("Chicken spinach skillet");
        expect(firstRequestText).toContain("Chicken thighs");
        expect(firstRequestText).not.toContain("Peanut noodles");
        expect(firstRequestText).not.toContain("Peanut butter");

        // The action path ran through the existing proposal tools,
        // in order, with the picked idea and its missing ingredient.
        expect(executed.map((entry) => entry.name)).toEqual([
            "create_meal_plan_draft",
            "add_grocery_items",
        ]);
        expect(executed[0]?.args.recipe_id).toBe("recipe-skillet");
        expect(executed[1]?.args).toEqual({ items: [{ name: "Garlic" }] });

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
            expect(result.draftIds).toContain("plan-draft-1");
            expect(result.reply).toContain("drafted for dinner");
            expect(result.toolCalls).toEqual([
                { name: "create_meal_plan_draft", outcome: "ok" },
                { name: "add_grocery_items", outcome: "ok" },
            ]);
        }
    });
});
