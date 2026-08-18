import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAnalytics } from "./analytics.js";
import type {
    MunchCapabilities,
    MunchCapabilityResolutionStatus,
} from "./billing/capabilities.js";

const featureAccessSchema = z.object({
    saved_foods: z.boolean(),
    recipes: z.boolean(),
    recipe_changes: z.boolean(),
    recipe_logging: z.boolean(),
    meal_planning: z.boolean(),
    meal_planning_changes: z.boolean(),
    grocery_lists: z.boolean(),
    grocery_list_changes: z.boolean(),
});

const connectionStatusOutputSchema = {
    connected: z.boolean(),
    account_email: z.string().email().nullable(),
    capability_resolution: z.enum(["available", "temporarily_unavailable"]),
    features: featureAccessSchema,
};

export interface ConnectionStatusSnapshot {
    connected: true;
    account_email: string | null;
    capability_resolution: "available" | "temporarily_unavailable";
    features: z.infer<typeof featureAccessSchema>;
}

export function buildConnectionStatus(input: {
    accountEmail?: string | null;
    capabilities: MunchCapabilities;
    capabilityResolution: MunchCapabilityResolutionStatus;
}): ConnectionStatusSnapshot {
    const { capabilities } = input;
    return {
        connected: true,
        account_email: input.accountEmail ?? null,
        capability_resolution:
            input.capabilityResolution === "resolved"
                ? "available"
                : "temporarily_unavailable",
        features: {
            saved_foods: true,
            recipes:
                capabilities.personalRecipesRead || capabilities.householdRead,
            recipe_changes:
                capabilities.personalRecipesWrite ||
                capabilities.householdWrite,
            recipe_logging:
                capabilities.personalRecipesRead || capabilities.householdRead,
            meal_planning:
                capabilities.personalPlanningRead || capabilities.householdRead,
            meal_planning_changes:
                capabilities.personalPlanningWrite ||
                capabilities.householdWrite,
            grocery_lists:
                capabilities.personalPlanningRead || capabilities.householdRead,
            grocery_list_changes:
                capabilities.personalPlanningWrite ||
                capabilities.householdWrite,
        },
    };
}

export function registerConnectionStatusTools(
    server: McpServer,
    userId: string,
    input: {
        accountEmail?: string | null;
        capabilities: MunchCapabilities;
        capabilityResolution: MunchCapabilityResolutionStatus;
    },
): void {
    const toolServer = server as unknown as {
        registerTool: (
            name: string,
            config: unknown,
            handler: (...args: any[]) => unknown,
        ) => unknown;
    };

    toolServer.registerTool(
        "get_connection_status",
        {
            title: "Get Connection Status",
            description:
                "Show which Munch account this connection uses and which Munch feature groups are available to it. Use this when the user asks about the connection or when an expected Munch feature is unavailable. It does not expose internal identifiers or billing details.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {},
            outputSchema: connectionStatusOutputSchema,
        },
        async () =>
            withAnalytics(
                "get_connection_status",
                async () => {
                    const status = buildConnectionStatus(input);
                    const accountText = status.account_email
                        ? `Connected to Munch as ${status.account_email}.`
                        : "Connected to Munch.";
                    const availabilityText =
                        status.capability_resolution === "available"
                            ? "Feature access was evaluated for this account."
                            : "Feature access is temporarily unavailable; try the request again.";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${accountText} ${availabilityText}`,
                            },
                        ],
                        structuredContent: status,
                    };
                },
                { userId },
            ),
    );
}
