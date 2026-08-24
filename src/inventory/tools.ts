import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAnalytics } from "../analytics.js";
import type { MunchCapabilities } from "../billing/capabilities.js";
import {
    getPantry,
    reconcilePantry,
    reconcilePurchase,
    type InventoryScope,
} from "./repository.js";

const locationSchema = z.enum(["pantry", "fridge", "freezer", "unspecified"]);
const quantityModeSchema = z.enum(["exact", "approximate", "presence_only"]);
const stockStateSchema = z.enum(["available", "low", "depleted"]);

const pantryItemOutputSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    normalized_name: z.string(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    quantity_mode: quantityModeSchema,
    stock_state: stockStateSchema,
    location: locationSchema,
    food_provider: z.string().nullable(),
    provider_food_id: z.string().nullable(),
    barcode: z.string().nullable(),
    note: z.string().nullable(),
    version: z.number().int().positive(),
    updated_at: z.string(),
});

const acquireOperationSchema = z.object({
    action: z.literal("acquire"),
    name: z.string().min(1).max(300),
    quantity: z.number().nonnegative().optional(),
    unit: z.string().max(80).optional(),
    quantity_mode: quantityModeSchema.optional(),
    location: locationSchema.optional(),
    food_provider: z.string().max(80).optional(),
    provider_food_id: z.string().max(300).optional(),
    barcode: z.string().max(120).optional(),
    note: z.string().max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
});
const consumeOperationSchema = z.object({
    action: z.literal("consume"),
    inventory_item_id: z.string().uuid(),
    quantity: z.number().positive(),
    unit: z.string().max(80).optional(),
    confidence: z.number().min(0).max(1).optional(),
});
const stateOperationSchema = z.object({
    action: z.enum(["consume_all", "mark_depleted", "discard", "mark_low"]),
    inventory_item_id: z.string().uuid(),
    confidence: z.number().min(0).max(1).optional(),
});
const correctionOperationSchema = z.object({
    action: z.literal("correct"),
    inventory_item_id: z.string().uuid(),
    quantity: z.number().nonnegative().nullable().optional(),
    unit: z.string().max(80).nullable().optional(),
    quantity_mode: quantityModeSchema.optional(),
    stock_state: stockStateSchema.optional(),
    note: z.string().max(500).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
});
const moveOperationSchema = z.object({
    action: z.literal("move"),
    inventory_item_id: z.string().uuid(),
    location: locationSchema,
    confidence: z.number().min(0).max(1).optional(),
});
const operationSchema = z.discriminatedUnion("action", [
    acquireOperationSchema,
    consumeOperationSchema,
    stateOperationSchema,
    correctionOperationSchema,
    moveOperationSchema,
]);

function inventoryScope(
    requested: "personal" | "household",
    capabilities: MunchCapabilities,
    write: boolean,
): InventoryScope {
    if (capabilities.tier !== "premium") {
        throw new Error("Pantry is a premium Munch feature");
    }
    if (requested === "personal") return { type: "personal" };
    const household = capabilities.household;
    if (
        !household ||
        (write ? !capabilities.householdWrite : !capabilities.householdRead)
    ) {
        throw new Error("Household Pantry access is unavailable");
    }
    return { type: "household", householdId: household.householdId };
}

function toPantryOperation(value: z.infer<typeof operationSchema>) {
    if (value.action === "acquire") {
        return {
            action: value.action,
            name: value.name,
            quantity: value.quantity,
            unit: value.unit,
            quantityMode: value.quantity_mode,
            location: value.location,
            foodProvider: value.food_provider,
            providerFoodId: value.provider_food_id,
            barcode: value.barcode,
            note: value.note,
            confidence: value.confidence,
        } as const;
    }
    if (value.action === "consume") {
        return {
            action: value.action,
            inventoryItemId: value.inventory_item_id,
            quantity: value.quantity,
            unit: value.unit,
            confidence: value.confidence,
        } as const;
    }
    if (value.action === "correct") {
        return {
            action: value.action,
            inventoryItemId: value.inventory_item_id,
            quantity: value.quantity,
            unit: value.unit,
            quantityMode: value.quantity_mode,
            stockState: value.stock_state,
            note: value.note,
            confidence: value.confidence,
        } as const;
    }
    if (value.action === "move") {
        return {
            action: value.action,
            inventoryItemId: value.inventory_item_id,
            location: value.location,
            confidence: value.confidence,
        } as const;
    }
    return {
        action: value.action,
        inventoryItemId: value.inventory_item_id,
        confidence: value.confidence,
    } as const;
}

export function registerInventoryTools(
    server: McpServer,
    userId: string,
    capabilities: MunchCapabilities,
): void {
    const toolServer = server as unknown as {
        registerTool: (
            name: string,
            config: Record<string, unknown>,
            handler: (args: any) => Promise<any>,
        ) => unknown;
    };

    toolServer.registerTool(
        "get_pantry",
        {
            title: "Get Pantry",
            description:
                "Read the user's enabled Pantry inventory. For meal reconciliation, pass only the candidate ingredient names so Munch returns likely Pantry matches instead of the full inventory. Pantry, Grocery, and Saved Foods are separate concepts.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                scope: z.enum(["personal", "household"]),
                query: z.string().max(200).optional(),
                candidate_names: z
                    .array(z.string().min(1).max(300))
                    .max(30)
                    .optional(),
                location: locationSchema.optional(),
                include_depleted: z.boolean().optional(),
                limit: z.number().int().min(1).max(200).optional(),
            },
            outputSchema: {
                enabled: z.boolean(),
                inventorySpaceId: z.string().uuid().nullable(),
                items: z.array(pantryItemOutputSchema),
            },
        },
        async (args: any) =>
            withAnalytics(
                "get_pantry",
                async () => {
                    const pantry = await getPantry({
                        userId,
                        scope: inventoryScope(args.scope, capabilities, false),
                        query: args.query,
                        candidateNames: args.candidate_names,
                        location: args.location,
                        includeDepleted: args.include_depleted,
                        limit: args.limit,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: pantry.enabled
                                    ? pantry.items.length
                                        ? `Found ${pantry.items.length} Pantry item${pantry.items.length === 1 ? "" : "s"}.`
                                        : "Pantry is enabled but no matching inventory items were found."
                                    : "Pantry is not enabled.",
                            },
                        ],
                        structuredContent: pantry,
                    };
                },
                { userId },
            ),
    );

    toolServer.registerTool(
        "reconcile_pantry",
        {
            title: "Reconcile Pantry",
            description:
                "Apply a batch Pantry update only from explicit user facts: what they bought, used, finished, discarded, moved, or corrected. Never infer meal consumption and silently subtract it. It is fine to propose likely matches first with get_pantry, then reconcile only after the user clarifies.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                scope: z.enum(["personal", "household"]),
                source_type: z.enum([
                    "manual",
                    "pantry_scan",
                    "meal_reconciliation",
                    "recipe_preparation",
                    "correction",
                ]),
                source_entity_id: z.string().uuid().optional(),
                idempotency_key: z.string().min(1).max(255),
                operations: z.array(operationSchema).min(1).max(100),
            },
            outputSchema: {
                enabled: z.literal(true),
                inventorySpaceId: z.string().uuid(),
                operations: z.array(
                    z.object({
                        action: z.string(),
                        item: pantryItemOutputSchema,
                        deduplicated: z.boolean(),
                    }),
                ),
            },
        },
        async (args: any) =>
            withAnalytics(
                "reconcile_pantry",
                async () => {
                    const result = await reconcilePantry({
                        userId,
                        scope: inventoryScope(args.scope, capabilities, true),
                        sourceType: args.source_type,
                        sourceEntityId: args.source_entity_id,
                        idempotencyKey: args.idempotency_key,
                        operations: args.operations.map(toPantryOperation),
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Reconciled ${result.operations.length} Pantry change${result.operations.length === 1 ? "" : "s"}.`,
                            },
                        ],
                        structuredContent: result,
                    };
                },
                { userId },
            ),
    );

    toolServer.registerTool(
        "reconcile_purchase",
        {
            title: "Reconcile Purchase",
            description:
                "Reconcile a grocery receipt or explicit shopping purchase in one idempotent batch. High-confidence food purchases may mark matching Grocery items purchased and add acquisitions to Pantry; low-confidence lines are returned for review, and non-food lines are ignored.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                scope: z.enum(["personal", "household"]),
                idempotency_key: z.string().min(1).max(255),
                source_label: z.string().max(300).optional(),
                purchased_at: z.string().optional(),
                lines: z
                    .array(
                        z.object({
                            raw_label: z.string().max(300).optional(),
                            name: z.string().min(1).max(300),
                            quantity: z.number().positive().optional(),
                            unit: z.string().max(80).optional(),
                            food_provider: z.string().max(80).optional(),
                            provider_food_id: z.string().max(300).optional(),
                            confidence: z.number().min(0).max(1).optional(),
                            is_food: z.boolean().optional(),
                            confirmed: z.boolean().optional(),
                            location: locationSchema.optional(),
                        }),
                    )
                    .min(1)
                    .max(200),
            },
            outputSchema: {
                purchaseReconciliationId: z.string().uuid(),
                deduplicated: z.boolean(),
                lines: z.array(
                    z.object({
                        position: z.number().int().nonnegative(),
                        name: z.string(),
                        quantity: z.number().nullable(),
                        unit: z.string().nullable(),
                        confidence: z.number().nullable(),
                        action: z.string(),
                        grocery_item_id: z.string().uuid().nullable(),
                        inventory_item_id: z.string().uuid().nullable(),
                    }),
                ),
                summary: z.object({
                    groceryMatched: z.number().int().nonnegative(),
                    inventoryAdded: z.number().int().nonnegative(),
                    ignoredNonFood: z.number().int().nonnegative(),
                    needsReview: z.number().int().nonnegative(),
                }),
            },
        },
        async (args: any) =>
            withAnalytics(
                "reconcile_purchase",
                async () => {
                    const result = await reconcilePurchase({
                        userId,
                        scope: inventoryScope(args.scope, capabilities, true),
                        idempotencyKey: args.idempotency_key,
                        sourceLabel: args.source_label,
                        purchasedAt: args.purchased_at,
                        lines: args.lines.map((line: any) => ({
                            rawLabel: line.raw_label,
                            name: line.name,
                            quantity: line.quantity,
                            unit: line.unit,
                            foodProvider: line.food_provider,
                            providerFoodId: line.provider_food_id,
                            confidence: line.confidence,
                            isFood: line.is_food,
                            confirmed: line.confirmed,
                            location: line.location,
                        })),
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Purchase reconciled: ${result.summary.groceryMatched} Grocery match${result.summary.groceryMatched === 1 ? "" : "es"}, ${result.summary.inventoryAdded} additional Pantry acquisition${result.summary.inventoryAdded === 1 ? "" : "s"}, ${result.summary.needsReview} line${result.summary.needsReview === 1 ? "" : "s"} needing review.`,
                            },
                        ],
                        structuredContent: result,
                    };
                },
                { userId },
            ),
    );
}
