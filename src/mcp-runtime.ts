import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { resolveMunchCapabilities } from "./billing/capabilities.js";
import { withCanonicalFoodSearch } from "./canonical-food-search.js";
import { registerFoodTools } from "./food-tools.js";
import { withFreshStructuredLogGuard } from "./fresh-log-guard.js";
import { registerMealDetailTools } from "./meal-detail-tools.js";
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
import { withCanonicalStructuredLogMeal } from "./structured-log-meal.js";

const MUNCH_SERVER_INSTRUCTIONS = `Munch stores and retrieves factual food, serving, macro, meal, hydration, weight, recipe, planning, and grocery data. Nutrition values are estimates and Munch does not provide medical or dietary advice. Do not ask Munch to determine what a user should eat, set a calorie target, diagnose a condition, or judge whether a food is healthy. ChatGPT may reason from the factual data under its own policies.

Resolve nutrition with a fast confidence-driven ladder. When the user says "my usual", refers to something eaten before, or a prior personal match is likely, search_saved_foods first. For every generic or branded food that still needs nutrition, call search_foods before using outside information: search_foods checks Munch's persistent local food catalog first and only falls through to USDA FoodData Central and Open Food Facts when the local catalog does not contain an adequate match. USDA and Open Food Facts are queried concurrently. For a visible packaged-food barcode, call lookup_food_barcode and use verified label values when available. If Munch returns a strong matching database record, use it and do not perform an external web search merely to double-check it. If Munch returns no adequate match, a materially wrong brand/product, or materially incomplete nutrition, then use external web search as the next fallback; prefer manufacturer, restaurant, or retailer nutrition pages. Use a model/generic estimate only after both Munch's database path and an appropriate external lookup fail. Never present an estimate as database data.

For a complete text meal whose foods and portions are already known, use log_meal with items[] so each food is stored separately with the exact nutrition values used, source, provider identifiers, confidence, assumptions, and source snapshot. Munch derives the parent meal totals from those items. For external webpage nutrition, use source_type=user_supplied, set a descriptive provider such as manufacturer_web or retailer_web, include source_url, and put resolution_layer=external_web in source_snapshot. For an unavoidable estimate, use source_type=model_estimate and record the assumptions. Aggregate-only log_meal calls for new meals are rejected so stale clients cannot silently create legacy rows; if a client does not expose items[], use the structured meal draft/review workflow instead.

For photos and any meal that still needs approval, use prepare_meal_review. Build the complete item list, nutrition estimates, confidence, assumptions, and any materially important unresolved question in one call. For a clear plated photo, infer homemade versus restaurant from the evidence instead of asking by default. No menu, restaurant branding, receipt, takeout packaging, or venue context generally supports a homemade inference. Use visible scale references such as forks, plates, bowls, cups, hands, and packaging. Put low-impact uncertainty into explicit assumptions rather than asking about every ordinary estimate. Ask only the highest-impact question when identity, portion, preparation, or calories would materially change. Use resolve_meal_review to apply the answer or any edits atomically. If the user says to stop asking or accepts the assumptions, resolve with accept_remaining_assumptions. Present the complete review and call confirm_meal_draft only after an explicit yes. Do not use aggregate-only log_meal for photo or ambiguous flows.

Legacy start_meal_draft and granular draft mutation tools remain for compatibility, but prefer prepare_meal_review and resolve_meal_review for new work because they reduce tool round trips while preserving server-enforced confirmation, version checks, RLS, and idempotency.

When the user establishes a complete recipe in conversation, recipe tools persist the factual structure. Do not create tags such as favorite, healthy, high-protein, quick, or family meal. Derive those descriptions from nutrient values, ingredient facts, timing, and observed scheduling or logging frequency when the user's request calls for it.

For a request such as "save this as My Peanut Butter Sandwich Lunch", use save_recipe once the individual ingredients, quantities, servings, nutrition facts, and source snapshots are established. Later use search_recipes or get_recipe to identify it. When the user says to log it, ask for servings and meal type if either is missing, then use log_recipe with the exact serving amount; it scales the saved ingredient quantities and logs the selected immutable recipe revision, so do not re-estimate or substitute a generic meal. Use update_recipe for a complete replacement after reading the current recipe; it creates a new revision and never rewrites historical meal logs. Use delete_recipe only after explicit confirmation; it archives the recipe while preserving historical logs. Use schedule_recipe to add a saved recipe revision to a date; planning is not consumption.

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
            version: "0.8.1",
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
    const guardedLegacyServer = withFreshStructuredLogGuard(server);
    const structuredLegacyServer = withCanonicalStructuredLogMeal(
        guardedLegacyServer,
        userId,
    );
    registerTools(
        structuredLegacyServer,
        userId,
        widgetsEnabledFromProfile(profile),
        alcoholTrackingEnabledFromProfile(profile) ? (drinkUnit ?? "us") : null,
        capabilities,
    );
    registerFoodTools(withCanonicalFoodSearch(server), userId);
    registerSavedFoodTools(server, userId, capabilities);
    registerMealDetailTools(server, userId);
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
