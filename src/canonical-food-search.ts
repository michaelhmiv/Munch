import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ADEQUATE_DATABASE_CONFIDENCE = 0.82;

type ToolServer = {
    registerTool: (
        name: string,
        config: Record<string, any>,
        handler: (args: Record<string, any>) => Promise<any> | any,
    ) => unknown;
};

function fallbackGuidance(result: any): {
    text: string;
    externalFallbackRecommended: boolean;
    reason: string;
} {
    const candidates = Array.isArray(result?.structuredContent?.candidates)
        ? result.structuredContent.candidates
        : [];
    const top = candidates[0];

    if (!top) {
        return {
            text: "Munch found no database candidate. For a branded, restaurant, or packaged food, external web search is now the preferred fallback; use a model/generic estimate only if that also fails.",
            externalFallbackRecommended: true,
            reason: "no_database_candidate",
        };
    }

    const confidence = Number(top.confidence ?? 0);
    if (
        !Number.isFinite(confidence) ||
        confidence < ADEQUATE_DATABASE_CONFIDENCE
    ) {
        return {
            text: `The best Munch database candidate is below the normal acceptance threshold (${Number.isFinite(confidence) ? confidence.toFixed(2) : "unknown"} confidence). If brand/product identity matters, use external web search before estimating.`,
            externalFallbackRecommended: true,
            reason: "low_database_confidence",
        };
    }

    return {
        text: `Munch has an adequate database candidate (${confidence.toFixed(2)} confidence). Prefer this database-backed result; do not perform an external web search unless the user's brand, package, restaurant, or serving details materially conflict with it.`,
        externalFallbackRecommended: false,
        reason: "adequate_database_candidate",
    };
}

/**
 * Adds a deterministic fallthrough signal to search_foods without changing its
 * public structured schema. The underlying FoodSearchService owns the fast
 * local-cache -> concurrent USDA/OFF resolution; this wrapper tells the model
 * whether leaving that pipeline for the open web is justified.
 */
export function withCanonicalFoodSearch(server: McpServer): McpServer {
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
                    if (name !== "search_foods") {
                        return originalRegisterTool(name, config, handler);
                    }

                    const wrappedConfig = {
                        ...config,
                        description: `${String(config.description ?? "Search Munch food databases.")} Munch checks its persistent local catalog first and only queries USDA FoodData Central and Open Food Facts when the local catalog does not contain an adequate match. USDA and Open Food Facts run concurrently. The result text explicitly states whether an external web fallback is warranted; follow that signal instead of searching the web by default.`,
                    };

                    return originalRegisterTool(
                        name,
                        wrappedConfig,
                        async (args: Record<string, any>) => {
                            const result = await handler(args);
                            const guidance = fallbackGuidance(result);
                            if (Array.isArray(result?.content)) {
                                const textItem = result.content.find(
                                    (item: any) =>
                                        item?.type === "text" &&
                                        typeof item.text === "string",
                                );
                                if (textItem) {
                                    textItem.text = `${textItem.text}\n\nResolution guidance: ${guidance.text}`;
                                }
                            }
                            console.info(
                                `[food_resolution] operation=search external_fallback_recommended=${guidance.externalFallbackRecommended} fallback_reason=${guidance.reason}`,
                            );
                            return result;
                        },
                    );
                };
            }

            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as McpServer;
}

export { ADEQUATE_DATABASE_CONFIDENCE, fallbackGuidance };
