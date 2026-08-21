import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAnalytics } from "./analytics.js";
import type { MunchCapabilities } from "./billing/capabilities.js";
import { requireRecipeAccess } from "./mcp-capability-guard.js";
import { previewRecipeUrl } from "./recipe-import/service.js";
import { recipeImportDraftOutputSchema } from "./recipe-import/types.js";

/**
 * URL import is deliberately preview-only. Saving stays behind the existing
 * save_recipe/save_recipe_and_plan tools so the MCP client must show the
 * parsed source and receive an explicit confirmation before persistence.
 */
export function registerRecipeImportTools(
    server: McpServer,
    userId: string,
    capabilities: MunchCapabilities,
): void {
    const toolServer = server as unknown as {
        registerTool: (
            name: string,
            config: unknown,
            handler: (...args: any[]) => unknown,
        ) => unknown;
    };

    toolServer.registerTool(
        "parse_recipe_url",
        {
            title: "Parse Recipe URL",
            description:
                "Preview a public HTTPS recipe URL by extracting its title, ingredients, servings, timing, instructions, nutrition matches, and source provenance. This tool never saves a recipe or adds groceries. Show the preview and ask for explicit confirmation before using save_recipe or save_recipe_and_plan with the returned recipe fields.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                url: z
                    .string()
                    .url()
                    .max(2_000)
                    .refine((value) => value.startsWith("https://"), {
                        message: "Only HTTPS recipe URLs are supported.",
                    }),
            },
            outputSchema: z.object({
                draft: recipeImportDraftOutputSchema,
            }),
        },
        async ({ url }) =>
            withAnalytics(
                "parse_recipe_url",
                async () => {
                    requireRecipeAccess(capabilities, "all", false);
                    const draft = await previewRecipeUrl(url, {
                        rateLimitKey: userId,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Parsed “${draft.recipe.name}” from ${draft.source.final_url}. ${draft.recipe.ingredients.length} ingredients are ready for review; nothing was saved. Ask for explicit confirmation before saving the returned recipe.`,
                            },
                        ],
                        structuredContent: { draft },
                    };
                },
                { userId },
            ),
    );
}
