/**
 * Cross-surface outcome contracts.
 *
 * This is intentionally an outcome manifest, not a mirror of the MCP tool
 * catalog. Several tools can support one customer workflow, and some website
 * capabilities are intentionally website-only (billing, account controls,
 * and household administration). A capability that is not yet complete is
 * still represented here with an owner and target PR so the gap is explicit.
 */

export type CapabilityCoverage = "complete" | "partial" | "missing";

export interface CapabilityChannel {
    available: boolean;
    coverage: CapabilityCoverage;
    entryPoints: readonly string[];
}

export interface CapabilityContract {
    id: string;
    mcp: CapabilityChannel;
    web: CapabilityChannel;
    intentionalChannelException: string | null;
    gap: string | null;
    targetPr: string | null;
}

const complete = (entryPoints: readonly string[]): CapabilityChannel => ({
    available: true,
    coverage: "complete",
    entryPoints,
});

const partial = (entryPoints: readonly string[]): CapabilityChannel => ({
    available: true,
    coverage: "partial",
    entryPoints,
});

const missing = (): CapabilityChannel => ({
    available: false,
    coverage: "missing",
    entryPoints: [],
});

const websiteOnly = (
    entryPoints: readonly string[],
): CapabilityContract["mcp"] => ({
    available: false,
    coverage: "missing",
    entryPoints,
});

export const CAPABILITY_MANIFEST = [
    {
        id: "meal.create",
        mcp: complete(["log_meal"]),
        web: complete([
            "POST /api/app/meals",
            "GET /api/app/food-search",
            "GET /api/app/food-details",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.read",
        mcp: complete([
            "get_meals_today",
            "get_meals_by_date",
            "get_meals_by_date_range",
        ]),
        web: complete(["/api/app/today", "/api/app/meals"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.update",
        mcp: complete(["update_meal"]),
        web: partial([
            "/api/app/meals/:id",
            "/api/app/meals/:mealId/items/:itemId",
        ]),
        intentionalChannelException: null,
        gap: "Draft/item replacement and a unified meal editor remain incomplete.",
        targetPr: "PR 3",
    },
    {
        id: "meal.delete",
        mcp: complete(["delete_meal"]),
        web: complete(["DELETE /api/app/meals/:id"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.copy",
        mcp: websiteOnly([]),
        web: complete(["POST /api/app/meals/:id/copy"]),
        intentionalChannelException:
            "The website keeps structured duplication as a direct diary convenience; MCP can re-log through its normal meal tools.",
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.search",
        mcp: complete(["search_meals"]),
        web: complete(["GET /api/app/meals?q=…", "#meal-history-search"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.details",
        mcp: complete(["get_meal_details"]),
        web: complete([
            "GET /api/app/meals/:id",
            '[data-action="view-meal-details"]',
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.provenance",
        mcp: complete(["get_nutrition_provenance"]),
        web: complete(["GET /api/app/insights (provenance)", "/app/insights"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "meal.import",
        mcp: complete(["bulk_import_meals", "start_meal_import"]),
        web: complete([
            "POST /api/app/import/parse",
            "POST /api/app/import",
            "/app/settings/data",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.create",
        mcp: complete(["start_meal_draft", "prepare_meal_review"]),
        web: complete([
            "POST /api/app/meal-drafts",
            '[data-action="start-meal-draft"]',
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.read",
        mcp: complete(["get_meal_draft"]),
        web: complete(["/api/app/today", "GET /api/app/meal-drafts/:id"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.review",
        mcp: complete(["prepare_meal_confirmation"]),
        web: complete([
            "GET /api/app/meal-drafts/:id",
            "POST /api/app/meal-drafts/:id/prepare",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.update",
        mcp: complete([
            "update_meal_draft",
            "upsert_meal_draft_item",
            "add_meal_draft_question",
            "answer_meal_draft_question",
        ]),
        web: complete([
            "PATCH /api/app/meal-drafts/:id",
            "POST /api/app/meal-drafts/:id/items",
            "PATCH /api/app/meal-drafts/:draftId/items/:itemId",
            "DELETE /api/app/meal-drafts/:draftId/items/:itemId",
            "POST /api/app/meal-drafts/:draftId/questions/:questionId/answer",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.confirm",
        mcp: complete(["confirm_meal_draft", "resolve_meal_review"]),
        web: complete(["POST /api/app/meal-drafts/:id/confirm"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealDraft.cancel",
        mcp: complete(["cancel_meal_draft"]),
        web: complete(["POST /api/app/meal-drafts/:id/cancel"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "food.search",
        mcp: complete(["search_foods"]),
        web: complete(["GET /api/app/food-search"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "food.inspect",
        mcp: complete(["get_food_details"]),
        web: complete(["GET /api/app/food-details"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "food.barcode",
        mcp: complete(["lookup_food_barcode", "lookup_barcode"]),
        web: complete(["GET /api/app/food-barcode"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "food.saved.read",
        mcp: complete(["search_saved_foods", "list_saved_foods"]),
        web: complete(["GET /api/app/food-search", "GET /api/app/foods"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "food.saved.write",
        mcp: complete(["save_food", "delete_saved_food"]),
        web: missing(),
        intentionalChannelException: null,
        gap: "The website cannot save or remove reusable foods.",
        targetPr: "PR 2",
    },
    {
        id: "food.saved.reuse",
        mcp: complete(["mark_saved_food_used"]),
        web: missing(),
        intentionalChannelException: null,
        gap: "Saved-food reuse belongs in the website meal composer.",
        targetPr: "PR 2",
    },
    {
        id: "nutrition.summary",
        mcp: complete(["get_nutrition_summary"]),
        web: complete(["/api/app/today", "/api/app/meals"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.goals",
        mcp: complete(["get_nutrition_goals", "set_nutrition_goals"]),
        web: complete(["/api/app/goals", "/app/settings/goals"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.progress",
        mcp: complete(["get_goal_progress"]),
        web: complete(["GET /api/app/insights (progress)", "/api/app/today"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.trends",
        mcp: complete(["get_trends"]),
        web: complete(["GET /api/app/insights (trends)", "/app/insights"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.patterns",
        mcp: complete(["get_meal_patterns"]),
        web: complete(["GET /api/app/insights (patterns)", "/app/insights"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "water.create",
        mcp: complete(["log_water"]),
        web: complete(["POST /api/app/water"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "water.read",
        mcp: complete(["get_water_today", "get_water_by_date"]),
        web: complete([
            "/api/app/today",
            "GET /api/app/insights (water history)",
            "/app/insights",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "water.update",
        mcp: complete(["update_water"]),
        web: complete(["PATCH /api/app/water/:id", "#water-history"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "water.delete",
        mcp: complete(["delete_water"]),
        web: complete(["DELETE /api/app/water/:id", "#water-history"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.create",
        mcp: complete(["log_weight"]),
        web: complete(["POST /api/app/weight"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.read",
        mcp: complete([
            "get_weight_today",
            "get_weight_by_date",
            "get_weight_by_date_range",
        ]),
        web: complete([
            "/api/app/today",
            "GET /api/app/insights (weight history)",
            "/app/insights",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.update",
        mcp: complete(["update_weight"]),
        web: complete(["PATCH /api/app/weight/:id", "#weight-history"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.delete",
        mcp: complete(["delete_weight"]),
        web: complete(["DELETE /api/app/weight/:id", "#weight-history"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.trends",
        mcp: complete(["get_weight_trends"]),
        web: complete([
            "GET /api/app/insights (weight trends)",
            "/app/insights",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "weight.units",
        mcp: complete(["get_weight_unit", "set_weight_unit"]),
        web: complete(["/app/settings/profile"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "preference.widgets",
        mcp: complete(["get_widget_display", "set_widget_display"]),
        web: complete(["/app/settings/profile"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "preference.alcohol",
        mcp: complete(["get_alcohol_tracking", "set_alcohol_tracking"]),
        web: complete(["/app/settings/profile"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "preference.timezone",
        mcp: complete(["get_timezone", "set_timezone"]),
        web: complete(["/app/settings/profile"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.create",
        mcp: complete(["save_recipe"]),
        web: complete(["POST /api/app/recipes", "/app/recipes"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.read",
        mcp: complete(["get_recipe"]),
        web: complete(["GET /api/app/recipes/:id"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.search",
        mcp: complete(["search_recipes"]),
        web: complete(["/api/app/planning", "#recipe-filter"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.update",
        mcp: complete(["update_recipe"]),
        web: complete(["PATCH /api/app/recipes/:id"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.archive",
        mcp: complete(["delete_recipe"]),
        web: complete(["DELETE /api/app/recipes/:id"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "recipe.log",
        mcp: complete(["log_recipe"]),
        web: complete(["POST /api/app/recipes/:id/log"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealPlan.read",
        mcp: complete(["get_meal_plan"]),
        web: complete(["/api/app/planning"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealPlan.schedule",
        mcp: complete(["schedule_recipe"]),
        web: complete(["POST /api/app/recipes/:id/plan"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "mealPlan.compose",
        mcp: complete(["save_recipe_and_plan"]),
        web: partial(["/api/app/recipes/:id", "/api/app/planning"]),
        intentionalChannelException: null,
        gap: "The website exposes the underlying recipe and planning actions but not one combined compose workflow.",
        targetPr: "PR 4",
    },
    {
        id: "grocery.read",
        mcp: complete(["get_grocery_list"]),
        web: complete(["/api/app/planning"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "grocery.add",
        mcp: complete(["add_grocery_items"]),
        web: complete(["POST /api/app/groceries/items"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "grocery.purchase",
        mcp: complete(["mark_grocery_item_purchased"]),
        web: complete([
            "POST /api/app/groceries/items/:id/purchased",
            "POST /api/app/groceries/clear-purchased",
        ]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "grocery.manage",
        mcp: websiteOnly([]),
        web: complete([
            "PATCH /api/app/groceries/items/:id",
            "DELETE /api/app/groceries/items/:id",
        ]),
        intentionalChannelException:
            "The MCP catalog exposes explicit grocery additions and purchase state; direct item editing and removal are website list-management controls.",
        gap: null,
        targetPr: null,
    },
    {
        id: "nutrition.export",
        mcp: complete(["export_meals"]),
        web: complete(["POST /api/app/export/meals", "/app/settings/data"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "account.delete",
        mcp: complete(["delete_account"]),
        web: complete(["/app/settings/account"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "connection.status",
        mcp: complete(["get_connection_status"]),
        web: complete(["/app/settings/connections"]),
        intentionalChannelException: null,
        gap: null,
        targetPr: null,
    },
    {
        id: "billing.checkout",
        mcp: websiteOnly([]),
        web: complete(["/billing/checkout", "/app/settings/billing"]),
        intentionalChannelException:
            "Billing is intentionally website-only and must not be advertised through MCP.",
        gap: null,
        targetPr: null,
    },
    {
        id: "billing.portal",
        mcp: websiteOnly([]),
        web: complete(["/billing/portal", "/app/settings/billing"]),
        intentionalChannelException:
            "Stripe subscription management is intentionally website-only.",
        gap: null,
        targetPr: null,
    },
    {
        id: "mcp.connection.revoke",
        mcp: websiteOnly([]),
        web: complete(["DELETE /api/app/connections/:tokenFamilyId"]),
        intentionalChannelException:
            "A user manages and revokes external connections from the website account settings.",
        gap: null,
        targetPr: null,
    },
    {
        id: "household.manage",
        mcp: websiteOnly([]),
        web: complete(["/api/app/household/manage", "/app/household"]),
        intentionalChannelException:
            "Household administration is a website-centric account workflow; MCP only consumes shared planning data.",
        gap: null,
        targetPr: null,
    },
    {
        id: "account.export",
        mcp: websiteOnly([]),
        web: complete(["/account/portal"]),
        intentionalChannelException:
            "The website account area owns complete-account export; MCP exposes focused meal export separately.",
        gap: null,
        targetPr: null,
    },
] as const satisfies readonly CapabilityContract[];

export type CapabilityId = (typeof CAPABILITY_MANIFEST)[number]["id"];

/** Every registered MCP tool must be assigned to an outcome capability. */
export const MCP_TOOL_CAPABILITY_MAP = {
    add_grocery_items: "grocery.add",
    add_meal_draft_question: "mealDraft.update",
    answer_meal_draft_question: "mealDraft.update",
    bulk_import_meals: "meal.import",
    cancel_meal_draft: "mealDraft.cancel",
    confirm_meal_draft: "mealDraft.confirm",
    delete_account: "account.delete",
    delete_meal: "meal.delete",
    delete_recipe: "recipe.archive",
    delete_saved_food: "food.saved.write",
    delete_water: "water.delete",
    delete_weight: "weight.delete",
    export_meals: "nutrition.export",
    get_alcohol_tracking: "preference.alcohol",
    get_connection_status: "connection.status",
    get_food_details: "food.inspect",
    get_goal_progress: "nutrition.progress",
    get_grocery_list: "grocery.read",
    get_meal_details: "meal.details",
    get_meal_draft: "mealDraft.read",
    get_meal_patterns: "nutrition.patterns",
    get_meal_plan: "mealPlan.read",
    get_meals_by_date: "meal.read",
    get_meals_by_date_range: "meal.read",
    get_meals_today: "meal.read",
    get_nutrition_goals: "nutrition.goals",
    get_nutrition_provenance: "nutrition.provenance",
    get_nutrition_summary: "nutrition.summary",
    get_recipe: "recipe.read",
    get_timezone: "preference.timezone",
    get_trends: "nutrition.trends",
    get_water_by_date: "water.read",
    get_water_today: "water.read",
    get_weight_by_date: "weight.read",
    get_weight_by_date_range: "weight.read",
    get_weight_today: "weight.read",
    get_weight_trends: "weight.trends",
    get_weight_unit: "weight.units",
    get_widget_display: "preference.widgets",
    list_saved_foods: "food.saved.read",
    log_meal: "meal.create",
    log_recipe: "recipe.log",
    log_water: "water.create",
    log_weight: "weight.create",
    lookup_barcode: "food.barcode",
    lookup_food_barcode: "food.barcode",
    mark_grocery_item_purchased: "grocery.purchase",
    mark_saved_food_used: "food.saved.reuse",
    prepare_meal_confirmation: "mealDraft.review",
    prepare_meal_review: "mealDraft.create",
    resolve_meal_review: "mealDraft.confirm",
    save_food: "food.saved.write",
    save_recipe: "recipe.create",
    save_recipe_and_plan: "mealPlan.compose",
    schedule_recipe: "mealPlan.schedule",
    search_foods: "food.search",
    search_meals: "meal.search",
    search_recipes: "recipe.search",
    search_saved_foods: "food.saved.read",
    set_alcohol_tracking: "preference.alcohol",
    set_nutrition_goals: "nutrition.goals",
    set_timezone: "preference.timezone",
    set_weight_unit: "weight.units",
    set_widget_display: "preference.widgets",
    start_meal_draft: "mealDraft.create",
    start_meal_import: "meal.import",
    update_meal: "meal.update",
    update_meal_draft: "mealDraft.update",
    update_recipe: "recipe.update",
    update_water: "water.update",
    update_weight: "weight.update",
    upsert_meal_draft_item: "mealDraft.update",
} as const satisfies Readonly<Record<string, CapabilityId>>;

export type McpToolName = keyof typeof MCP_TOOL_CAPABILITY_MAP;

export function assertCapabilityManifest(): string[] {
    const errors: string[] = [];
    const ids = new Set<string>();
    const mappedTools = new Map<string, string>();

    for (const capability of CAPABILITY_MANIFEST) {
        if (ids.has(capability.id)) {
            errors.push(`Duplicate capability id: ${capability.id}`);
        }
        ids.add(capability.id);

        for (const [channelName, channel] of [
            ["mcp", capability.mcp],
            ["web", capability.web],
        ] as const) {
            if (channel.available && channel.entryPoints.length === 0) {
                errors.push(
                    `${capability.id}: ${channelName} is available but has no entry point`,
                );
            }
            if (!channel.available && channel.coverage === "complete") {
                errors.push(
                    `${capability.id}: ${channelName} cannot be complete while unavailable`,
                );
            }
        }

        if (capability.intentionalChannelException && capability.gap) {
            errors.push(
                `${capability.id}: intentional channel exceptions cannot also be unresolved gaps`,
            );
        }
        if (
            !capability.intentionalChannelException &&
            (capability.web.coverage === "missing" ||
                capability.web.coverage === "partial") &&
            (!capability.gap || !capability.targetPr)
        ) {
            errors.push(
                `${capability.id}: incomplete web coverage needs a documented gap and target PR`,
            );
        }
    }

    for (const [tool, capabilityId] of Object.entries(
        MCP_TOOL_CAPABILITY_MAP,
    )) {
        if (!ids.has(capabilityId)) {
            errors.push(`${tool}: maps to unknown capability ${capabilityId}`);
        }
        if (mappedTools.has(tool)) {
            errors.push(`Duplicate MCP tool mapping: ${tool}`);
        }
        mappedTools.set(tool, capabilityId);
    }

    for (const capability of CAPABILITY_MANIFEST) {
        for (const tool of capability.mcp.entryPoints) {
            if (
                MCP_TOOL_CAPABILITY_MAP[tool as McpToolName] !== capability.id
            ) {
                errors.push(
                    `${capability.id}: MCP entry point ${tool} is not mapped back to this capability`,
                );
            }
        }
    }

    return errors;
}
