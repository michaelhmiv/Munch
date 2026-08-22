import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { resolveMunchCapabilitiesSafe } from "./billing/capabilities.js";
import { withCanonicalFoodSearch } from "./canonical-food-search.js";
import { getAccountIdentity } from "./accounts/repository.js";
import { registerConnectionStatusTools } from "./connection-status-tools.js";
import { registerFoodTools } from "./food-tools.js";
import { withFreshStructuredLogGuard } from "./fresh-log-guard.js";
import { registerMealDetailTools } from "./meal-detail-tools.js";
import { registerMealDraftTools } from "./meal-draft-tools.js";
import { registerMealReviewTools } from "./meal-review-tools.js";
import { withLatencyOptimizedToolCatalog } from "./mcp-latency.js";
import { registerRecipePlanningTools } from "./recipe-planning-tools.js";
import { registerRecipeImportTools } from "./recipe-import-tools.js";
import { registerSavedFoodTools } from "./saved-food-tools.js";
import { registerTools } from "./mcp.js";
import {
    alcoholTrackingEnabledFromProfile,
    getProfile,
    preferredDrinkUnitFromProfile,
    widgetsEnabledFromProfile,
} from "./storage.js";
import { withCanonicalStructuredLogMeal } from "./structured-log-meal.js";
import { MUNCH_APP_VERSION } from "./widget-release.js";
import { withVersionedWidgetResources } from "./widget-resource-versioning.js";

const MUNCH_SERVER_INSTRUCTIONS = `Munch stores and retrieves factual meals, nutrition, hydration, weight, foods, recipes, meal plans, and grocery lists. Nutrition values are estimates; Munch does not provide medical or dietary advice.

Prefer the direct read/write tool that exactly matches the user's request. Grocery-list requests go straight to get_grocery_list; adding groceries goes straight to add_grocery_items. Today's meals use get_meals_today; date ranges use the matching range tool. Meal plans use get_meal_plan. Saved recipes use search_recipes/get_recipe. Use personal scope by default unless the user explicitly asks for household data.

For nutrition resolution, use personal saved/history matches when relevant, then search_foods, then external web only when Munch has no adequate result, and model estimates last. Visible packaged barcodes use lookup_food_barcode.

For a fully resolved text meal, use log_meal with items[]. For photos or unresolved meals, use prepare_meal_review; infer homemade versus restaurant from the evidence instead of asking by default; resolve only material questions/edits, present the complete review, then use confirm_meal_draft only after explicit user approval. Prefer this atomic review flow over legacy granular draft tools.

Recipe URLs use parse_recipe_url before saving. Planning never means consumption. A grocery list is not pantry inventory; add only items the user explicitly says are needed. Use get_connection_status only for connection or feature-availability troubleshooting.`;

async function buildMunchMcpServer(
    c: Context,
    userId: string,
): Promise<McpServer> {
    const proto = c.req.header("x-forwarded-proto") || "http";
    const host =
        c.req.header("x-forwarded-host") || c.req.header("host") || "localhost";
    const baseUrl = `${proto}://${host}`;
    const server = new McpServer(
        {
            name: "Munch",
            version: MUNCH_APP_VERSION,
            icons: [
                {
                    src: `${baseUrl}/favicon.ico`,
                    mimeType: "image/x-icon",
                },
            ],
        },
        {
            capabilities: { tools: {}, resources: {} },
            instructions: MUNCH_SERVER_INSTRUCTIONS,
        },
    );
    // Every registrar uses the same proxy so UI resource links and resource
    // registrations are versioned atomically. This prevents clients from
    // holding old widget HTML behind an unchanged ui:// cache key.
    const appServer = withVersionedWidgetResources(server);
    // Keep the full backend catalog for compatibility, but minimize what the
    // host model has to read and reason over on every turn.
    const optimizedServer = withLatencyOptimizedToolCatalog(appServer);

    const [profile, capabilityResolution, accountIdentity] = await Promise.all([
        getProfile(userId).catch((error) => {
            console.warn("Munch profile lookup failed during MCP setup", {
                userId,
                errorName: error instanceof Error ? error.name : "unknown",
            });
            return null;
        }),
        resolveMunchCapabilitiesSafe(userId),
        getAccountIdentity(userId).catch((error) => {
            console.warn(
                "Munch account identity lookup failed during MCP setup",
                {
                    userId,
                    errorName: error instanceof Error ? error.name : "unknown",
                },
            );
            return null;
        }),
    ]);
    const capabilities = capabilityResolution.capabilities;
    const drinkUnit = preferredDrinkUnitFromProfile(profile);
    const widgetsEnabled = widgetsEnabledFromProfile(profile);
    const guardedLegacyServer = withFreshStructuredLogGuard(optimizedServer);
    const structuredLegacyServer = withCanonicalStructuredLogMeal(
        guardedLegacyServer,
        userId,
    );
    registerTools(
        structuredLegacyServer,
        userId,
        widgetsEnabled,
        alcoholTrackingEnabledFromProfile(profile) ? (drinkUnit ?? "us") : null,
        capabilities,
    );
    registerFoodTools(withCanonicalFoodSearch(optimizedServer), userId);
    registerSavedFoodTools(optimizedServer, userId, capabilities);
    registerMealDetailTools(optimizedServer, userId);
    registerMealReviewTools(optimizedServer, userId, widgetsEnabled);
    registerMealDraftTools(optimizedServer, userId);
    registerRecipeImportTools(optimizedServer, userId, capabilities);
    registerRecipePlanningTools(optimizedServer, userId, capabilities);
    registerConnectionStatusTools(optimizedServer, userId, {
        accountEmail: accountIdentity?.email,
        capabilities,
        capabilityResolution: capabilityResolution.status,
    });
    return server;
}

export const handleMcp = async (c: Context) => {
    if (c.req.method !== "POST") {
        return c.json(
            {
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32000,
                    message:
                        "Method Not Allowed: this endpoint serves POST only and offers no SSE stream",
                },
            },
            405,
            { Allow: "POST" },
        );
    }

    const userId = c.get("userId") as string;
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });
    const server = await buildMunchMcpServer(c, userId);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
};
