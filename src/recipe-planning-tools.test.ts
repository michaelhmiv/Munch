import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRecipePlanningTools } from "./recipe-planning-tools.js";
import type { MunchCapabilities } from "./billing/capabilities.js";

function captureTools(capabilities: MunchCapabilities) {
    const tools = new Map<string, Record<string, any>>();
    const server = {
        registerTool(
            name: string,
            config: Record<string, any>,
            _handler: (...args: any[]) => unknown,
        ) {
            tools.set(name, config);
            return {};
        },
        registerResource() {
            return {};
        },
    } as unknown as McpServer;
    registerRecipePlanningTools(
        server,
        "11111111-1111-4111-8111-111111111111",
        capabilities,
    );
    return tools;
}

const premiumPersonal = {
    tier: "premium",
    entitlementSource: "subscription",
    coreNutrition: true,
    personalRecipesRead: true,
    personalRecipesWrite: true,
    personalPlanningRead: true,
    personalPlanningWrite: true,
    householdRead: false,
    householdWrite: false,
    householdManage: false,
    household: null,
    historyDays: null,
} as unknown as MunchCapabilities;

describe("recipe MCP surface", () => {
    test("exposes the complete lifecycle for a recipe-capable account", () => {
        const tools = captureTools(premiumPersonal);
        expect([...tools.keys()]).toEqual(
            expect.arrayContaining([
                "search_recipes",
                "get_recipe",
                "save_recipe",
                "update_recipe",
                "delete_recipe",
                "log_recipe",
                "schedule_recipe",
            ]),
        );
        expect(tools.get("delete_recipe")?.annotations.destructiveHint).toBe(
            true,
        );
        expect(tools.get("log_recipe")?.annotations.idempotentHint).toBe(true);
    });

    test("normalizes blank optional recipe queries instead of forcing a retry", () => {
        const tools = captureTools(premiumPersonal);
        const querySchema = tools.get("search_recipes")?.inputSchema.query;
        expect(querySchema.parse("")).toBeUndefined();
        expect(querySchema.parse("   ")).toBeUndefined();
        expect(querySchema.parse("  pasta  ")).toBe("pasta");
    });

    test("keeps the catalog when an account lacks recipe read access", () => {
        const tools = captureTools({
            ...premiumPersonal,
            personalRecipesRead: false,
            personalRecipesWrite: false,
        });
        expect([...tools.keys()]).toEqual(
            expect.arrayContaining([
                "search_recipes",
                "get_recipe",
                "save_recipe",
                "update_recipe",
                "delete_recipe",
                "log_recipe",
                "schedule_recipe",
                "get_meal_plan",
                "get_grocery_list",
                "add_grocery_items",
                "mark_grocery_item_purchased",
                "save_recipe_and_plan",
            ]),
        );
    });

    test("keeps the complete catalog for a free account and defers access checks", () => {
        const tools = captureTools({
            ...premiumPersonal,
            tier: "free",
            personalRecipesRead: false,
            personalRecipesWrite: false,
            personalPlanningRead: false,
            personalPlanningWrite: false,
            householdRead: false,
            householdWrite: false,
            household: null,
        });
        expect(tools.size).toBe(12);
    });

    test("log_recipe takes servings, amount + unit, or fraction (unit logging)", () => {
        const tools = captureTools(premiumPersonal);
        const input = tools.get("log_recipe")?.inputSchema;
        // Servings is optional now — the other portion forms stand alone.
        expect(input.servings_consumed.parse(undefined)).toBeUndefined();
        expect(input.servings_consumed.parse(2)).toBe(2);
        expect(input.amount.parse(1.5)).toBe(1.5);
        expect(input.unit.parse("cup")).toBe("cup");
        expect(input.fraction.parse("1/4")).toBe("1/4");
        expect(input.fraction.parse(0.25)).toBe(0.25);
    });

    test("log_recipe output carries the portion record and share", () => {
        const tools = captureTools(premiumPersonal);
        const output = tools.get("log_recipe")?.outputSchema;
        const meal = {
            id: "11111111-1111-4111-8111-111111111111",
            logged_at: "2026-11-13T17:00:00.000Z",
            meal_type: "lunch",
            description: "Mac (1 cup)",
            calories: 497,
            protein_g: 19.6,
            carbs_g: 38.2,
            fat_g: 28.6,
            fiber_g: 1.4,
            sugar_g: 8.9,
            source_recipe_id: "22222222-2222-4222-8222-222222222222",
            source_recipe_revision_id: "33333333-3333-4333-8333-333333333333",
            source_planned_meal_id: null,
            items: [],
        };
        const parsed = output.parse({
            logged_meal: meal,
            recipe_id: "22222222-2222-4222-8222-222222222222",
            recipe_revision_id: "33333333-3333-4333-8333-333333333333",
            recipe_revision_number: 2,
            servings_consumed: 1,
            portion: {
                mode: "amount",
                entered_amount: 1,
                entered_unit: "cup",
                fraction_numerator: null,
                fraction_denominator: null,
                share: 0.083333,
                yield_snapshot: {
                    quantity: 12,
                    unit: "cup",
                    family: "volume",
                    source: "estimated",
                },
                servings_equivalent: 1,
            },
            share: 0.083333,
            deduplicated: false,
        });
        expect(parsed.portion.mode).toBe("amount");
        expect(parsed.portion.yield_snapshot.source).toBe("estimated");
        expect(parsed.share).toBe(0.083333);
    });

    test("recipe schemas carry the yield slots in both directions", () => {
        const tools = captureTools(premiumPersonal);
        const saveInput = tools.get("save_recipe")?.inputSchema.recipe;
        const withYields = saveInput.parse({
            name: "Mac",
            servings: 12,
            yield_volume: { quantity: 12, unit: "cup" },
            yield_weight: { quantity: 1800, unit: "g" },
            instructions: ["Boil"],
            source_type: "user_entered",
            ingredients: [{ name: "Pasta", source_type: "user_supplied" }],
        });
        expect(withYields.yield_volume).toEqual({
            quantity: 12,
            unit: "cup",
        });
        const detail = tools.get("get_recipe")?.outputSchema.recipe;
        const recipe = {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Mac",
            version: 1,
            ownership: { type: "personal" },
            revision_id: "33333333-3333-4333-8333-333333333333",
            revision_number: 2,
            servings: 12,
            yields: {
                volume: { quantity: 12, unit: "cup" },
                weight: null,
            },
            yield_estimates: {
                volume: { quantity: 9.25, unit: "cup" },
                weight: { quantity: 2193, unit: "g" },
            },
            effective_yields: {
                volume: {
                    quantity: 12,
                    unit: "cup",
                    family: "volume",
                    source: "set",
                },
                weight: {
                    quantity: 2193,
                    unit: "g",
                    family: "weight",
                    source: "estimated",
                },
            },
            description: null,
            instructions: ["Boil"],
            preparation_minutes: null,
            cooking_minutes: null,
            source: { type: "user_entered", title: null, url: null },
            nutrition_status: "complete",
            nutrition_total: { calories: 5960 },
            nutrition_per_serving: { calories: 497 },
            ingredients: [],
            created_at: "2026-11-13T00:00:00.000Z",
            updated_at: "2026-11-13T00:00:00.000Z",
        };
        const parsed = detail.parse(recipe);
        expect(parsed.effective_yields.volume.source).toBe("set");
        expect(parsed.effective_yields.weight.source).toBe("estimated");
        expect(detail.parse(null)).toBeNull();
    });
});
