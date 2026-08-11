import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolServer = {
    registerTool: (
        name: string,
        config: Record<string, any>,
        handler: (args: Record<string, any>) => Promise<any> | any,
    ) => unknown;
};

export const STRUCTURED_LOG_REQUIRED_CODE = "structured_log_required";

export function assertFreshMealIsStructured(args: Record<string, any>): void {
    if (Array.isArray(args.items) && args.items.length > 0) return;

    console.warn(
        "[meal_log] rejected mode=legacy_aggregate reason=items_missing action=use_structured_draft",
    );
    throw new Error(
        `${STRUCTURED_LOG_REQUIRED_CODE}: New meals must be stored with item-level nutrition provenance. This client is using an aggregate-only log_meal schema. Do not retry log_meal without items. Use the structured meal workflow instead: start_meal_draft, upsert_meal_draft_item for every food, prepare_meal_confirmation, then confirm_meal_draft. Resolve nutrition through saved/history matches and Munch food databases before external web or model estimates.`,
    );
}

/**
 * Safety net for clients that cached an older aggregate-only log_meal schema.
 * The canonical structured wrapper enriches the public schema with items[].
 * This guard sits underneath it so structured calls pass through, while stale
 * callers cannot silently create a brand-new legacy aggregate row.
 */
export function withFreshStructuredLogGuard(server: McpServer): McpServer {
    const originalRegisterTool = (
        server as unknown as ToolServer
    ).registerTool.bind(server);

    return new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: Record<string, any>,
                    handler: (args: Record<string, any>) => Promise<any> | any,
                ) => {
                    if (name !== "log_meal") {
                        return originalRegisterTool(name, config, handler);
                    }
                    return originalRegisterTool(
                        name,
                        config,
                        async (args: Record<string, any>) => {
                            assertFreshMealIsStructured(args);
                            return handler(args);
                        },
                    );
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;
}
