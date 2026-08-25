import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { observeAnalytics } from "./analytics.js";
import { MCP_TOOL_CAPABILITY_MAP } from "./capability-manifest.js";

type ToolConfig = Record<string, any>;
type ToolHandler = (args: Record<string, any>) => Promise<any> | any;
type ToolServer = {
    registerTool: (
        name: string,
        config: ToolConfig,
        handler: ToolHandler,
    ) => unknown;
};

type RegisteredTool = {
    config: ToolConfig;
    handler: ToolHandler;
};

const MAX_DESCRIPTION_CHARS = 260;
const ADVANCED_ACTION_LIMIT = 8;
const KNOWN_MUNCH_TOOLS = new Set(Object.keys(MCP_TOOL_CAPABILITY_MAP));

/**
 * Common, latency-sensitive, widget-bearing, or confirmation-sensitive intents
 * stay directly visible to the host model. Everything else remains registered
 * for compatibility but is discovered on demand through the advanced gateway.
 */
const DIRECT_MODEL_TOOLS = new Set([
    "get_grocery_list",
    "add_grocery_items",
    "log_meal",
    "get_meals_today",
    "get_meals_by_date_range",
    "search_meals",
    "get_meal_details",
    "prepare_meal_review",
    "resolve_meal_review",
    "confirm_meal_draft",
    "cancel_meal_draft",
    "search_foods",
    "get_food_details",
    "lookup_food_barcode",
    "search_saved_foods",
    "get_nutrition_summary",
    "get_goal_progress",
    "get_trends",
    "start_meal_import",
    "log_water",
    "log_weight",
    "get_weight_today",
    "get_weight_trends",
    "search_recipes",
    "get_recipe",
    "parse_recipe_url",
    "save_recipe",
    "get_meal_plan",
    "save_recipe_and_plan",
]);

const TOOL_REGISTRIES = new WeakMap<McpServer, Map<string, RegisteredTool>>();

const advancedParameterSchema = z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    description: z.string().nullable(),
});

const advancedActionSchema = z.object({
    action: z.string(),
    title: z.string(),
    description: z.string(),
    parameters: z.array(advancedParameterSchema),
});

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
        "Return all meals logged across an inclusive date range; use the same start/end date for one historical day.",
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
    return KNOWN_MUNCH_TOOLS.has(name) && !DIRECT_MODEL_TOOLS.has(name);
}

export function directModelToolCount(): number {
    return DIRECT_MODEL_TOOLS.size;
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

function inputShape(config: ToolConfig): Record<string, any> | null {
    const schema = config.inputSchema;
    if (!schema || typeof schema !== "object") return null;
    if (typeof schema.parse === "function") {
        const shape = schema?._def?.shape;
        if (typeof shape === "function") return shape();
        if (shape && typeof shape === "object") return shape;
        return null;
    }
    return schema as Record<string, any>;
}

function parseAdvancedArgs(
    config: ToolConfig,
    args: Record<string, unknown>,
): Record<string, any> {
    const schema = config.inputSchema;
    if (!schema) return args;
    if (typeof schema.parse === "function") {
        return schema.parse(args);
    }
    if (typeof schema === "object") {
        return z.object(schema as Record<string, any>).parse(args);
    }
    return args;
}

function unwrapField(field: any): any {
    let current = field;
    for (let i = 0; i < 5; i += 1) {
        const typeName = current?._def?.typeName;
        if (
            typeName === "ZodOptional" ||
            typeName === "ZodNullable" ||
            typeName === "ZodDefault" ||
            typeName === "ZodCatch"
        ) {
            current = current._def.innerType;
            continue;
        }
        if (typeName === "ZodEffects") {
            current = current._def.schema;
            continue;
        }
        break;
    }
    return current;
}

function fieldType(field: any): string {
    const current = unwrapField(field);
    const typeName = current?._def?.typeName;
    if (typeName === "ZodString") return "string";
    if (typeName === "ZodNumber") return "number";
    if (typeName === "ZodBoolean") return "boolean";
    if (typeName === "ZodArray") return "array";
    if (typeName === "ZodObject" || typeName === "ZodRecord") return "object";
    if (typeName === "ZodEnum") {
        return `enum(${(current._def.values ?? []).join(" | ")})`;
    }
    if (typeName === "ZodLiteral") {
        return `literal(${String(current._def.value)})`;
    }
    if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
        return "union";
    }
    return "value";
}

function parameterSummary(config: ToolConfig) {
    const shape = inputShape(config);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]) => ({
        name,
        type: fieldType(field),
        required:
            typeof (field as any)?.isOptional === "function"
                ? !(field as any).isOptional()
                : true,
        description:
            typeof (field as any)?.description === "string"
                ? (field as any).description
                : null,
    }));
}

function actionSearchScore(
    query: string,
    name: string,
    config: ToolConfig,
): number {
    const normalized = query.toLowerCase().trim();
    const tokens = normalized
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2);
    const parameters = parameterSummary(config);
    const haystack = [
        name.replaceAll("_", " "),
        String(config.title ?? ""),
        String(config.description ?? ""),
        ...parameters.flatMap((parameter) => [
            parameter.name.replaceAll("_", " "),
            parameter.description ?? "",
        ]),
    ]
        .join(" ")
        .toLowerCase();

    let score = 0;
    if (normalized && haystack.includes(normalized)) score += 12;
    for (const token of tokens) {
        if (name.toLowerCase().includes(token)) score += 4;
        if (haystack.includes(token)) score += 2;
    }
    return score;
}

function advancedActionRecord(name: string, tool: RegisteredTool) {
    return {
        action: name,
        title: String(tool.config.title ?? name.replaceAll("_", " ")),
        description: String(tool.config.description ?? ""),
        parameters: parameterSummary(tool.config),
    };
}

function isDestructive(tool: RegisteredTool): boolean {
    return tool.config.annotations?.destructiveHint === true;
}

/**
 * Optimize the model-facing MCP catalog without changing tool handlers or
 * business contracts. Private tool definitions are retained in a per-server
 * registry so the on-demand gateway can invoke the exact wrapped handlers.
 */
export function withLatencyOptimizedToolCatalog(server: McpServer): McpServer {
    const originalRegisterTool = (
        server as unknown as ToolServer
    ).registerTool.bind(server);
    const registry = new Map<string, RegisteredTool>();

    const wrapped = new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: ToolConfig,
                    handler: ToolHandler,
                ) => {
                    const optimized = optimizedToolConfig(name, config);
                    if (isModelPrivateTool(name)) {
                        registry.set(name, {
                            config: optimized,
                            handler,
                        });
                    }
                    return originalRegisterTool(name, optimized, handler);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;

    TOOL_REGISTRIES.set(wrapped, registry);
    return wrapped;
}

/**
 * Add two small model-visible tools that provide application-level deferred
 * discovery for low-frequency Munch operations. Common intents never pay this
 * extra round-trip; advanced requests keep full backend parity.
 */
export function registerAdvancedToolGateway(
    server: McpServer,
    userId?: string,
): void {
    const registry = TOOL_REGISTRIES.get(server);
    if (!registry) {
        throw new Error(
            "Advanced Munch tool gateway requires withLatencyOptimizedToolCatalog",
        );
    }
    const toolServer = server as unknown as ToolServer;
    const observe = <T>(
        toolName: string,
        args: Record<string, unknown>,
        handler: () => Promise<T> | T,
    ): Promise<T> | T =>
        userId
            ? observeAnalytics(
                  toolName,
                  async () => handler(),
                  { userId },
                  args,
              )
            : handler();

    toolServer.registerTool(
        "find_munch_actions",
        {
            title: "Find Advanced Munch Action",
            description:
                "Find low-frequency Munch actions for corrections, settings, exports, deletions, historical reads, and advanced management when no direct tool matches the request.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z.string().min(1).max(200),
            },
            outputSchema: {
                actions: z.array(advancedActionSchema),
            },
        },
        async ({ query }) =>
            observe("find_munch_actions", { query }, async () => {
                const ranked = [...registry.entries()]
                    .map(([name, tool]) => ({
                        score: actionSearchScore(query, name, tool.config),
                        action: advancedActionRecord(name, tool),
                    }))
                    .filter((candidate) => candidate.score > 0)
                    .sort(
                        (a, b) =>
                            b.score - a.score ||
                            a.action.action.localeCompare(b.action.action),
                    )
                    .slice(0, ADVANCED_ACTION_LIMIT);

                const actions = ranked.map((candidate) => candidate.action);
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                actions.length === 0
                                    ? `No advanced Munch action matched "${query}". Use a direct Munch tool if one fits.`
                                    : actions
                                          .map((action) => {
                                              const params = action.parameters
                                                  .map(
                                                      (parameter) =>
                                                          `${parameter.name}:${parameter.type}${parameter.required ? " required" : " optional"}`,
                                                  )
                                                  .join(", ");
                                              return `${action.action} — ${action.description}${params ? ` Parameters: ${params}.` : ""}`;
                                          })
                                          .join("\n"),
                        },
                    ],
                    structuredContent: { actions },
                };
            }),
    );

    toolServer.registerTool(
        "run_munch_action",
        {
            title: "Run Advanced Munch Action",
            description:
                "Execute one advanced action returned by find_munch_actions. Pass exactly the action name and parameters it returned; direct Munch intents should use their dedicated tools instead.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                action: z.string().min(1).max(120),
                args: z.record(z.unknown()).default({}),
                confirm: z
                    .literal(true)
                    .optional()
                    .describe(
                        "Required only when the selected advanced action is destructive. The user must explicitly confirm before this is set to true.",
                    ),
            },
        },
        async ({ action, args, confirm }) =>
            observe("run_munch_action", { action, args, confirm }, async () => {
                const tool = registry.get(action);
                if (!tool) {
                    throw new Error(
                        `Unknown or direct Munch action "${action}". Call find_munch_actions first.`,
                    );
                }
                const destructive = isDestructive(tool);
                if (destructive && confirm !== true) {
                    throw new Error(
                        `Advanced action "${action}" is destructive and requires explicit confirmation.`,
                    );
                }
                const forwardedArgs =
                    destructive && confirm === true && !("confirm" in args)
                        ? { ...args, confirm: true }
                        : args;
                const parsed = parseAdvancedArgs(tool.config, forwardedArgs);
                return tool.handler(parsed);
            }),
    );
}
