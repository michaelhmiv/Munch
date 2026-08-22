import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolConfig = Record<string, any>;
type ToolHandler = (args: Record<string, any>) => Promise<any> | any;
type ToolServer = {
    registerTool: (
        name: string,
        config: ToolConfig,
        handler: ToolHandler,
    ) => unknown;
};

const MAX_DESCRIPTION_CHARS = 260;

/**
 * Concise model-facing descriptions for tools where the full implementation
 * contract is intentionally verbose. The server still enforces validation,
 * confirmation, provenance, RLS, and idempotency; this text is only routing
 * guidance for the host model.
 */
const FAST_TOOL_DESCRIPTIONS: Record<string, string> = {
    get_grocery_list:
        "Return the active grocery list. Use directly for requests to show, list, or read groceries; use personal scope unless the user explicitly asks for household.",
    add_grocery_items:
        "Add only groceries the user explicitly says are needed. Use personal scope unless the user explicitly asks for household.",
    mark_grocery_item_purchased:
        "Mark or unmark one grocery-list item as purchased using its current version.",
    get_meal_plan:
        "Return planned meals for a date range. Planning records intent, not consumption.",
    search_recipes:
        "Search saved personal or household recipes by name or text and return factual recipe summaries.",
    get_recipe:
        "Return one saved recipe revision with ingredients, instructions, servings, and nutrition facts.",
    save_recipe:
        "Save a fully established structured recipe. Do not invent ingredients, quantities, servings, or source facts.",
    update_recipe:
        "Replace a saved recipe with a new immutable revision after reading the current recipe.",
    delete_recipe:
        "Archive a saved recipe only after explicit user confirmation; historical meal logs remain intact.",
    log_recipe:
        "Log an explicit serving amount of a saved recipe without re-estimating its ingredients; require servings and meal type.",
    schedule_recipe:
        "Schedule a saved recipe revision on the meal calendar; this does not log consumption.",
    save_recipe_and_plan:
        "Atomically save a structured recipe, schedule it, and add only groceries the user explicitly says are needed.",
    parse_recipe_url:
        "Parse a public recipe URL into a reviewable structured preview without saving it. Resolve material ambiguities before saving.",
    log_meal:
        "Log a fully resolved text meal only after meal type, portions, and nutrition sources are known. New meals require items[]; use prepare_meal_review for photos or unresolved meals.",
    prepare_meal_review:
        "Create one reviewable meal draft for a photo or unresolved meal, including items, estimates, assumptions, and only material questions. This does not log the meal.",
    resolve_meal_review:
        "Apply the user's answers or edits to a pending meal review. The meal remains unlogged until explicit confirmation.",
    confirm_meal_draft:
        "Permanently log a prepared meal draft only after the user explicitly confirms the complete review.",
    cancel_meal_draft:
        "Cancel a pending meal draft without creating a meal record, after explicit confirmation.",
    search_saved_foods:
        "Search the user's saved foods and recent structured meal items. Use first for 'my usual' or foods the user has logged before.",
    search_foods:
        "Search Munch's local food catalog, then USDA and Open Food Facts when needed. Use before external web lookup or model estimation.",
    get_food_details:
        "Return portions, nutrients, and source details for a food candidate selected from search_foods.",
    lookup_food_barcode:
        "Look up a packaged-food barcode across Open Food Facts and USDA before estimating nutrition.",
    save_food:
        "Save a confirmed food candidate as a reusable personal food with its source snapshot.",
    list_saved_foods:
        "List the user's reusable saved foods, ordered by usage and recency.",
    mark_saved_food_used:
        "Record that a confirmed saved food was used so future usual-food ranking improves.",
    delete_saved_food:
        "Delete one reusable saved food after explicit confirmation; historical meal snapshots are unchanged.",
    search_meals:
        "Search past logged meals by short food or restaurant keywords and return recurring variations. Use when prior history is likely to improve the current result.",
    get_meals_today: "Return all meals logged today.",
    get_meals_by_date: "Return all meals logged on one date.",
    get_meals_by_date_range:
        "Return all meals logged across an inclusive date range; prefer this over repeated single-date calls.",
    get_nutrition_summary:
        "Return daily nutrition totals for a date range, with the nutrition dashboard when widgets are enabled.",
    get_goal_progress:
        "Return nutrition and weight progress against the user's saved goals for a date.",
    get_trends:
        "Return pre-aggregated nutrition trends for the requested window.",
    get_meal_patterns:
        "Return pre-aggregated descriptive meal patterns for the requested window.",
    get_meal_details:
        "Return one logged meal with item-level portions, nutrition provenance, confidence, and assumptions.",
    get_nutrition_provenance:
        "Audit nutrition-source coverage, providers, confidence, and estimate usage across a date range.",
    start_meal_import:
        "Open the interactive meal-history importer for an export file; prefer this over repeated log_meal calls.",
    bulk_import_meals:
        "Import up to 50 historical meal rows in one validated batch. Dry-run parsed file or free-text imports before writing.",
    log_water: "Log a hydration entry in milliliters.",
    get_water_today: "Return today's water total and entries.",
    get_water_by_date: "Return water total and entries for one date.",
    log_weight: "Log a body-weight measurement in the user's stated unit.",
    get_weight_today:
        "Return today's weight entries in the user's preferred unit.",
    get_weight_by_date:
        "Return weight entries for one date in the user's preferred unit.",
    get_weight_by_date_range:
        "Return weight entries across an inclusive date range, grouped by day.",
    get_weight_trends:
        "Return weight trend statistics and moving averages for the requested window.",
    get_connection_status:
        "Return the connected Munch account identity and available feature groups; use only for connection or feature-availability troubleshooting.",
};

/**
 * Older compatibility routes that are superseded by canonical tools. They stay
 * registered so app/legacy clients can still call them, but ChatGPT should not
 * spend model-selection attention on them.
 */
const MODEL_PRIVATE_TOOLS = new Set([
    "lookup_barcode",
    "start_meal_draft",
    "get_meal_draft",
    "update_meal_draft",
    "upsert_meal_draft_item",
    "add_meal_draft_question",
    "answer_meal_draft_question",
    "prepare_meal_confirmation",
]);

function firstSentence(value: string): string {
    const match = value.trim().match(/^.*?[.!?](?:\s|$)/s);
    return (match?.[0] ?? value.trim()).trim();
}

export function compactToolDescription(
    name: string,
    description: unknown,
): string {
    const override = FAST_TOOL_DESCRIPTIONS[name];
    if (override) return override;

    if (typeof description !== "string" || !description.trim()) {
        return name.replaceAll("_", " ");
    }

    const concise = firstSentence(description).replace(/\s+/g, " ");
    if (concise.length <= MAX_DESCRIPTION_CHARS) return concise;
    return `${concise.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

export function isModelPrivateTool(name: string): boolean {
    return MODEL_PRIVATE_TOOLS.has(name);
}

function optimizedToolConfig(name: string, config: ToolConfig): ToolConfig {
    const next: ToolConfig = {
        ...config,
        description: compactToolDescription(name, config.description),
    };

    if (!isModelPrivateTool(name)) return next;

    const existingMeta =
        config._meta && typeof config._meta === "object" ? config._meta : {};
    const existingUi =
        existingMeta.ui && typeof existingMeta.ui === "object"
            ? existingMeta.ui
            : {};

    next._meta = {
        ...existingMeta,
        "openai/visibility": "private",
        ui: {
            ...existingUi,
            visibility: ["app"],
        },
    };
    return next;
}

/**
 * Optimize the model-facing MCP catalog without changing tool handlers or
 * business contracts. This proxy is intentionally registration-only.
 */
export function withLatencyOptimizedToolCatalog(server: McpServer): McpServer {
    const originalRegisterTool = (
        server as unknown as ToolServer
    ).registerTool.bind(server);

    return new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: ToolConfig,
                    handler: ToolHandler,
                ) =>
                    originalRegisterTool(
                        name,
                        optimizedToolConfig(name, config),
                        handler,
                    );
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;
}
