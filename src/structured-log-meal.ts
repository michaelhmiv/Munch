import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mealIdempotencyKey } from "./nutrition-platform/meals.js";
import {
    aggregateStructuredMealItems,
    insertStructuredMeal,
} from "./structured-meals/repository.js";
import type {
    StructuredMealItemInput,
    StructuredMealItemRecord,
} from "./structured-meals/types.js";

const nutrientInput = z.object({
    calories: z.coerce.number().min(0).optional(),
    protein_g: z.coerce.number().min(0).optional(),
    carbs_g: z.coerce.number().min(0).optional(),
    fat_g: z.coerce.number().min(0).optional(),
    fiber_g: z.coerce.number().min(0).optional(),
    sugar_g: z.coerce.number().min(0).optional(),
    alcohol_g: z.coerce.number().min(0).optional(),
    sodium_mg: z.coerce.number().min(0).optional(),
    saturated_fat_g: z.coerce.number().min(0).optional(),
    cholesterol_mg: z.coerce.number().min(0).optional(),
    potassium_mg: z.coerce.number().min(0).optional(),
});

const structuredItemInput = z.object({
    name: z.string().min(1).max(500),
    quantity: z.coerce.number().positive().optional(),
    portion_label: z.string().max(500).optional(),
    gram_weight: z.coerce.number().positive().optional(),
    nutrients: nutrientInput,
    source_type: z.enum([
        "usda",
        "open_food_facts",
        "published_restaurant",
        "saved_food",
        "past_meal",
        "user_supplied",
        "model_estimate",
        "legacy_aggregate",
    ]),
    provider: z.string().max(100).optional(),
    provider_food_id: z.string().max(255).optional(),
    provider_revision: z.string().max(255).optional(),
    source_url: z.string().url().max(2_000).optional(),
    source_updated_at: z.string().optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    assumptions: z.array(z.string().min(1).max(500)).max(20).optional(),
    source_snapshot: z.record(z.string(), z.unknown()).optional(),
});

const nutrientOutput = z.object({
    calories: z.number().nullable(),
    protein_g: z.number().nullable(),
    carbs_g: z.number().nullable(),
    fat_g: z.number().nullable(),
    fiber_g: z.number().nullable(),
    sugar_g: z.number().nullable(),
    alcohol_g: z.number().nullable(),
    sodium_mg: z.number().nullable(),
    saturated_fat_g: z.number().nullable(),
    cholesterol_mg: z.number().nullable(),
    potassium_mg: z.number().nullable(),
});

const mealItemOutput = z.object({
    id: z.string(),
    position: z.number(),
    name: z.string(),
    quantity: z.number().nullable(),
    portion_label: z.string().nullable(),
    gram_weight: z.number().nullable(),
    nutrients: nutrientOutput,
    source_type: z.string(),
    provider: z.string().nullable(),
    provider_food_id: z.string().nullable(),
    provider_revision: z.string().nullable(),
    source_url: z.string().nullable(),
    source_updated_at: z.string().nullable(),
    confidence: z.number().nullable(),
    assumptions: z.array(z.string()),
    source_snapshot: z.record(z.string(), z.unknown()),
});

type StructuredItemArgs = z.infer<typeof structuredItemInput>;

type ToolServer = {
    registerTool: (
        name: string,
        config: Record<string, any>,
        handler: (args: Record<string, any>) => Promise<any> | any,
    ) => unknown;
};

function toStructuredItem(item: StructuredItemArgs): StructuredMealItemInput {
    return {
        name: item.name,
        quantity: item.quantity,
        portionLabel: item.portion_label,
        gramWeight: item.gram_weight,
        nutrients: item.nutrients,
        sourceType: item.source_type,
        provider: item.provider,
        providerFoodId: item.provider_food_id,
        providerRevision: item.provider_revision,
        sourceUrl: item.source_url,
        sourceUpdatedAt: item.source_updated_at,
        confidence: item.confidence,
        assumptions: item.assumptions,
        sourceSnapshot: item.source_snapshot,
    };
}

function nullable(value: number | undefined): number | null {
    return value ?? null;
}

function serializeMealItem(record: StructuredMealItemRecord) {
    return {
        id: record.id,
        position: record.position,
        name: record.item.name,
        quantity: record.item.quantity ?? null,
        portion_label: record.item.portionLabel ?? null,
        gram_weight: record.item.gramWeight ?? null,
        nutrients: {
            calories: nullable(record.item.nutrients.calories),
            protein_g: nullable(record.item.nutrients.protein_g),
            carbs_g: nullable(record.item.nutrients.carbs_g),
            fat_g: nullable(record.item.nutrients.fat_g),
            fiber_g: nullable(record.item.nutrients.fiber_g),
            sugar_g: nullable(record.item.nutrients.sugar_g),
            alcohol_g: nullable(record.item.nutrients.alcohol_g),
            sodium_mg: nullable(record.item.nutrients.sodium_mg),
            saturated_fat_g: nullable(
                record.item.nutrients.saturated_fat_g,
            ),
            cholesterol_mg: nullable(record.item.nutrients.cholesterol_mg),
            potassium_mg: nullable(record.item.nutrients.potassium_mg),
        },
        source_type: record.item.sourceType,
        provider: record.item.provider ?? null,
        provider_food_id: record.item.providerFoodId ?? null,
        provider_revision: record.item.providerRevision ?? null,
        source_url: record.item.sourceUrl ?? null,
        source_updated_at: record.item.sourceUpdatedAt ?? null,
        confidence: record.item.confidence ?? null,
        assumptions: record.item.assumptions ?? [],
        source_snapshot: record.item.sourceSnapshot ?? {},
    };
}

function structuredDescription(base: string): string {
    return `${base}\n\nFor every new text meal with identified foods, send items[]. Each item must retain the nutrition values actually used plus its provenance. Resolve food identity in this order: Munch personal/history lookup when relevant, Munch search_foods (which checks the persistent local catalog before USDA and Open Food Facts), then external web only when Munch has no adequate database match, then an explicit model_estimate as the last fallback. For a manufacturer, retailer, or other external webpage use source_type='user_supplied', set provider to a descriptive value such as 'manufacturer_web' or 'retailer_web', include source_url, and set source_snapshot.resolution_layer='external_web'. When items[] is supplied, Munch calculates the parent calories and macros server-side; aggregate nutrition fields are ignored. The aggregate-only form remains compatibility-only for imports and older clients.`;
}

/**
 * Wrap the legacy tool registrar so its existing log_meal widget/progress path
 * is preserved while new callers can write canonical structured meal items.
 *
 * The structured insert happens first. The legacy handler is then invoked with
 * the same idempotency key and server-derived totals, so its insert is a safe
 * no-op and it can reuse the existing progress/widget builder without creating
 * a second meal.
 */
export function withCanonicalStructuredLogMeal(
    server: McpServer,
    userId: string,
): McpServer {
    const originalRegisterTool = (server as unknown as ToolServer).registerTool.bind(
        server,
    );

    return new Proxy(server, {
        get(target, property) {
            if (property === "registerTool") {
                return (
                    name: string,
                    config: Record<string, any>,
                    legacyHandler: (args: Record<string, any>) => Promise<any> | any,
                ) => {
                    if (name !== "log_meal") {
                        return originalRegisterTool(name, config, legacyHandler);
                    }

                    const wrappedConfig = {
                        ...config,
                        description: structuredDescription(
                            String(config.description ?? "Log a meal."),
                        ),
                        inputSchema: {
                            ...(config.inputSchema ?? {}),
                            items: z
                                .array(structuredItemInput)
                                .min(1)
                                .max(100)
                                .optional()
                                .describe(
                                    "Canonical itemized foods for this meal. Required for normal newly resolved meals. Each item carries its own nutrients, source, confidence, assumptions, and immutable source snapshot. Parent totals are computed by Munch.",
                                ),
                        },
                        outputSchema: {
                            ...(config.outputSchema ?? {}),
                            meal_items: z.array(mealItemOutput).optional(),
                        },
                    };

                    return originalRegisterTool(
                        name,
                        wrappedConfig,
                        async (rawArgs: Record<string, any>) => {
                            const structuredArgs = rawArgs.items as
                                | StructuredItemArgs[]
                                | undefined;
                            if (!structuredArgs?.length) {
                                console.info(
                                    "[meal_log] mode=legacy_aggregate reason=items_missing",
                                );
                                return legacyHandler(rawArgs);
                            }

                            const loggedAt =
                                rawArgs.logged_at ?? new Date().toISOString();
                            const items = structuredArgs.map(toStructuredItem);
                            const totals = aggregateStructuredMealItems(items);
                            const legacyInput = {
                                description: rawArgs.description,
                                meal_type: rawArgs.meal_type,
                                calories: totals.calories,
                                protein_g: totals.protein_g,
                                carbs_g: totals.carbs_g,
                                fat_g: totals.fat_g,
                                fiber_g: totals.fiber_g,
                                sugar_g: totals.sugar_g,
                                alcohol_g: totals.alcohol_g,
                                logged_at: loggedAt,
                                notes: rawArgs.notes,
                            };
                            const idempotencyKey =
                                rawArgs.idempotency_key ??
                                mealIdempotencyKey(
                                    userId,
                                    legacyInput,
                                    loggedAt,
                                );

                            const inserted = await insertStructuredMeal(userId, {
                                mealType: rawArgs.meal_type,
                                description: rawArgs.description,
                                loggedAt,
                                notes: rawArgs.notes,
                                idempotencyKey,
                                items,
                            });

                            const result = await legacyHandler({
                                ...legacyInput,
                                idempotency_key: idempotencyKey,
                            });

                            console.info(
                                `[meal_log] mode=structured item_count=${inserted.meal.items.length} deduplicated=${inserted.deduplicated}`,
                            );

                            if (result?.structuredContent) {
                                result.structuredContent = {
                                    ...result.structuredContent,
                                    meal_items: inserted.meal.items.map(
                                        serializeMealItem,
                                    ),
                                };
                            }

                            if (!inserted.deduplicated && Array.isArray(result?.content)) {
                                for (const item of result.content) {
                                    if (item?.type === "text" && typeof item.text === "string") {
                                        item.text = item.text.replace(
                                            /^Meal already logged \(idempotent retry\):/,
                                            "Meal logged:",
                                        );
                                    }
                                }
                            }

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
