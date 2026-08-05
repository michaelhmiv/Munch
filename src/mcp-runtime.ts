import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { resolveMunchCapabilities } from "./billing/capabilities.js";
import { registerFoodTools } from "./food-tools.js";
import { registerMealDraftTools } from "./meal-draft-tools.js";
import { registerMealReviewTools } from "./meal-review-tools.js";
import { registerRecipePlanningTools } from "./recipe-planning-tools.js";
import { registerSavedFoodTools } from "./saved-food-tools.js";
import { registerTools } from "./mcp.js";
import {
    alcoholTrackingEnabledFromProfile,
    getProfile,
    preferredDrinkUnitFromProfile,
    widgetsEnabledFromProfile,
} from "./storage.js";

const MUNCH_SERVER_INSTRUCTIONS = `Munch stores and retrieves factual food, serving, macro, meal, hydration, weight, recipe, planning, and grocery data. Nutrition values are estimates and Munch does not provide medical or dietary advice. Do not ask Munch to determine what a user should eat, set a calorie target, diagnose a condition, or judge whether a food is healthy. ChatGPT may reason from the factual data under its own policies.

Before estimating a generic or branded food, search personal foods first when the user says "my usual" or refers to something eaten before. Otherwise call search_foods only when database lookup is likely to materially improve product identity, hidden ingredients, or serving accuracy. For a visible packaged-food barcode, call lookup_food_barcode and use verified label values when available. Always identify the source and do not present model estimates as database facts.

For photos and any meal that still needs approval, use prepare_meal_review. Build the complete item list, nutrition estimates, confidence, assumptions, and any materially important unresolved question in one call. For a clear plated photo, infer homemade versus restaurant from the evidence instead of asking by default. No menu, restaurant branding, receipt, takeout packaging, or venue context generally supports a homemade inference. Use visible scale references such as forks, plates, bowls, cups, hands, and packaging. Put low-impact uncertainty into explicit assumptions rather than asking about every ordinary estimate. Ask only the highest-impact question when identity, portion, preparation, or calories would materially change. Use resolve_meal_review to apply the answer or any edits atomically. If the user says to stop asking or accepts the assumptions, resolve with accept_remaining_assumptions. Present the complete review and call confirm_meal_draft only after an explicit yes. Do not use log_meal for photo or ambiguous flows.

Legacy start_meal_draft and granular draft mutation tools remain for compatibility, but prefer prepare_meal_review and resolve_meal_review for new work because they reduce tool round trips while preserving server-enforced confirmation, version checks, RLS, and idempotency.

When the user establishes a complete recipe in conversation, recipe tools persist the factual structure. Do not create tags such as favorite, healthy, high-protein, quick, or family meal. Derive those descriptions from nutrient values, ingredient facts, timing, and observed scheduling or logging frequency when the user's request calls for it.

A planned meal does not mean anyone ate it. A grocery list is not pantry inventory. If the user says they have everything except onions, add onions only. Do not store or infer that every other ingredient is currently owned.

Use search_meals and search_saved_foods for prior variations only when likely to improve the current estimate. Use the interactive importer for history files instead of repeatedly calling log_meal. Munch tool availability is account-specific; do not advertise, describe, or link to unavailable paid capabilities.`;

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
            version: "0.7.0",
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

    const [profile, capabilities] = await Promise.all([
        getProfile(userId),
        resolveMunchCapabilities(userId),
    ]);
    const drinkUnit = preferredDrinkUnitFromProfile(profile);
    registerTools(
        server,
        userId,
        widgetsEnabledFromProfile(profile),
        alcoholTrackingEnabledFromProfile(profile) ? (drinkUnit ?? "us") : null,
        capabilities,
    );
    registerFoodTools(server, userId);
    registerSavedFoodTools(server, userId, capabilities);
    registerMealReviewTools(server, userId);
    registerMealDraftTools(server, userId);
    registerRecipePlanningTools(server, userId, capabilities);
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
