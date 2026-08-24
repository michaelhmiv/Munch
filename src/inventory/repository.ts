import type { DatabaseTransaction } from "../platform/database.js";
import { withUserDatabase } from "../platform/database.js";
import {
    canonicalInventoryUnit,
    convertInventoryQuantity,
    normalizeInventoryName,
    type InventoryQuantityMode,
    type InventoryStockState,
} from "./matching.js";

export type InventoryScope =
    { type: "personal" } | { type: "household"; householdId: string };
export type InventoryLocation = "pantry" | "fridge" | "freezer" | "unspecified";
export type InventorySourceType =
    | "manual"
    | "grocery_purchase"
    | "receipt"
    | "pantry_scan"
    | "meal_reconciliation"
    | "recipe_preparation"
    | "correction";

export interface PantryItem {
    id: string;
    name: string;
    normalized_name: string;
    quantity: number | null;
    unit: string | null;
    quantity_mode: InventoryQuantityMode;
    stock_state: InventoryStockState;
    location: InventoryLocation;
    food_provider: string | null;
    provider_food_id: string | null;
    barcode: string | null;
    note: string | null;
    version: number;
    updated_at: string;
}

export type PantryOperation =
    | {
          action: "acquire";
          name: string;
          quantity?: number;
          unit?: string;
          quantityMode?: InventoryQuantityMode;
          location?: InventoryLocation;
          foodProvider?: string;
          providerFoodId?: string;
          barcode?: string;
          note?: string;
          confidence?: number;
      }
    | {
          action: "consume";
          inventoryItemId: string;
          quantity: number;
          unit?: string;
          confidence?: number;
      }
    | {
          action: "consume_all" | "mark_depleted" | "discard" | "mark_low";
          inventoryItemId: string;
          confidence?: number;
      }
    | {
          action: "correct";
          inventoryItemId: string;
          quantity?: number | null;
          unit?: string | null;
          quantityMode?: InventoryQuantityMode;
          stockState?: InventoryStockState;
          note?: string | null;
          confidence?: number;
      }
    | {
          action: "move";
          inventoryItemId: string;
          location: InventoryLocation;
          confidence?: number;
      };

export interface PurchaseLineInput {
    rawLabel?: string;
    name: string;
    quantity?: number;
    unit?: string;
    foodProvider?: string;
    providerFoodId?: string;
    confidence?: number;
    isFood?: boolean;
    confirmed?: boolean;
    location?: InventoryLocation;
}

function validateScope(scope: InventoryScope): void {
    if (
        scope.type === "household" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            scope.householdId,
        )
    ) {
        throw new Error("Invalid household ID");
    }
}

function ownerValues(scope: InventoryScope, userId: string) {
    validateScope(scope);
    return {
        personalOwnerUserId: scope.type === "personal" ? userId : null,
        householdId: scope.type === "household" ? scope.householdId : null,
    };
}

function validateConfidence(value?: number): number | null {
    if (value === undefined) return null;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("Inventory confidence must be between 0 and 1");
    }
    return value;
}

function validateQuantity(value?: number | null): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Inventory quantity must be nonnegative");
    }
    return value;
}

function normalizeLocation(value?: InventoryLocation): InventoryLocation {
    return value ?? "unspecified";
}

async function getOrCreateSpace(
    tx: DatabaseTransaction,
    userId: string,
    scope: InventoryScope,
): Promise<string> {
    const owner = ownerValues(scope, userId);
    const existing = await tx<Array<{ id: string }>>`
        select id from munch.inventory_spaces
        where personal_owner_user_id is not distinct from ${owner.personalOwnerUserId}
          and household_id is not distinct from ${owner.householdId}
        limit 1
    `;
    if (existing[0]) return String(existing[0].id);

    const inserted = await tx<Array<{ id: string }>>`
        insert into munch.inventory_spaces (
            personal_owner_user_id, household_id, created_by_user_id
        ) values (
            ${owner.personalOwnerUserId}, ${owner.householdId}, ${userId}
        ) returning id
    `;
    if (!inserted[0])
        throw new Error("Inventory space creation returned no row");
    return String(inserted[0].id);
}

async function existingSpace(
    tx: DatabaseTransaction,
    userId: string,
    scope: InventoryScope,
): Promise<string | null> {
    const owner = ownerValues(scope, userId);
    const rows = await tx<Array<{ id: string }>>`
        select id from munch.inventory_spaces
        where personal_owner_user_id is not distinct from ${owner.personalOwnerUserId}
          and household_id is not distinct from ${owner.householdId}
        limit 1
    `;
    return rows[0] ? String(rows[0].id) : null;
}

function serializeItem(row: Record<string, unknown>): PantryItem {
    return {
        id: String(row.id),
        name: String(row.name),
        normalized_name: String(row.normalized_name),
        quantity: row.quantity == null ? null : Number(row.quantity),
        unit: row.unit == null ? null : String(row.unit),
        quantity_mode: String(row.quantity_mode) as InventoryQuantityMode,
        stock_state: String(row.stock_state) as InventoryStockState,
        location: String(row.location) as InventoryLocation,
        food_provider:
            row.food_provider == null ? null : String(row.food_provider),
        provider_food_id:
            row.provider_food_id == null ? null : String(row.provider_food_id),
        barcode: row.barcode == null ? null : String(row.barcode),
        note: row.note == null ? null : String(row.note),
        version: Number(row.version),
        updated_at: new Date(String(row.updated_at)).toISOString(),
    };
}

async function readItemForUpdate(
    tx: DatabaseTransaction,
    spaceId: string,
    itemId: string,
): Promise<Record<string, unknown>> {
    const rows = await tx<Array<Record<string, unknown>>>`
        select * from munch.inventory_items
        where id = ${itemId} and inventory_space_id = ${spaceId} and deleted_at is null
        limit 1 for update
    `;
    if (!rows[0]) throw new Error("Pantry item is unavailable");
    return rows[0];
}

async function findInventoryItem(
    tx: DatabaseTransaction,
    spaceId: string,
    input: {
        name: string;
        unit?: string | null;
        foodProvider?: string | null;
        providerFoodId?: string | null;
        location?: InventoryLocation;
    },
): Promise<Record<string, unknown> | null> {
    const normalized = normalizeInventoryName(input.name);
    const unit = canonicalInventoryUnit(input.unit);
    const location = normalizeLocation(input.location);
    if (input.providerFoodId) {
        const providerRows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_items
            where inventory_space_id = ${spaceId}
              and deleted_at is null
              and food_provider is not distinct from ${input.foodProvider ?? null}
              and provider_food_id = ${input.providerFoodId}
              and unit is not distinct from ${unit}
            order by case when location = ${location} then 0 else 1 end, created_at
            limit 1 for update
        `;
        if (providerRows[0]) return providerRows[0];
    }
    const rows = await tx<Array<Record<string, unknown>>>`
        select * from munch.inventory_items
        where inventory_space_id = ${spaceId}
          and deleted_at is null
          and normalized_name = ${normalized}
          and unit is not distinct from ${unit}
        order by case when location = ${location} then 0 else 1 end, created_at
        limit 1 for update
    `;
    return rows[0] ?? null;
}

async function insertEvent(
    tx: DatabaseTransaction,
    input: {
        spaceId: string;
        itemId: string;
        eventType: string;
        deltaQuantity?: number | null;
        quantityAfter?: number | null;
        unit?: string | null;
        sourceType: InventorySourceType;
        sourceEntityId?: string | null;
        sourceKey: string;
        confidence?: number;
        userId: string;
        metadata?: Record<string, unknown>;
    },
): Promise<boolean> {
    const rows = await tx<Array<{ id: string }>>`
        insert into munch.inventory_events (
            inventory_space_id, inventory_item_id, event_type,
            delta_quantity, quantity_after, unit, source_type,
            source_entity_id, source_key, confidence, actor_user_id, metadata
        ) values (
            ${input.spaceId}, ${input.itemId}, ${input.eventType},
            ${input.deltaQuantity ?? null}, ${input.quantityAfter ?? null},
            ${canonicalInventoryUnit(input.unit)}, ${input.sourceType},
            ${input.sourceEntityId ?? null}, ${input.sourceKey},
            ${validateConfidence(input.confidence)}, ${input.userId},
            jsonb_build_object()
        )
        on conflict (inventory_space_id, source_key) where source_key is not null
        do nothing
        returning id
    `;
    return Boolean(rows[0]);
}

async function acquireInTransaction(
    tx: DatabaseTransaction,
    input: {
        userId: string;
        spaceId: string;
        sourceType: InventorySourceType;
        sourceEntityId?: string | null;
        sourceKey: string;
        name: string;
        quantity?: number;
        unit?: string;
        quantityMode?: InventoryQuantityMode;
        location?: InventoryLocation;
        foodProvider?: string;
        providerFoodId?: string;
        barcode?: string;
        note?: string;
        confidence?: number;
    },
): Promise<{ item: PantryItem; deduplicated: boolean }> {
    const already = await tx<Array<{ inventory_item_id: string }>>`
        select inventory_item_id from munch.inventory_events
        where inventory_space_id = ${input.spaceId} and source_key = ${input.sourceKey}
        limit 1
    `;
    if (already[0]) {
        const itemRows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_items where id = ${already[0].inventory_item_id}
        `;
        if (!itemRows[0])
            throw new Error("Idempotent Pantry event lost its item");
        return { item: serializeItem(itemRows[0]), deduplicated: true };
    }

    const name = input.name.trim();
    const normalized = normalizeInventoryName(name);
    if (!name || !normalized || name.length > 300)
        throw new Error("Pantry item name is invalid");
    const quantity = validateQuantity(input.quantity) ?? null;
    const unit = canonicalInventoryUnit(input.unit);
    const location = normalizeLocation(input.location);
    let row = await findInventoryItem(tx, input.spaceId, {
        name,
        unit,
        foodProvider: input.foodProvider,
        providerFoodId: input.providerFoodId,
        location,
    });

    if (!row) {
        const inserted = await tx<Array<Record<string, unknown>>>`
            insert into munch.inventory_items (
                inventory_space_id, name, normalized_name, quantity, unit,
                quantity_mode, stock_state, location, food_provider,
                provider_food_id, barcode, note, created_by_user_id,
                updated_by_user_id
            ) values (
                ${input.spaceId}, ${name}, ${normalized}, ${quantity}, ${unit},
                ${input.quantityMode ?? (quantity == null ? "presence_only" : "exact")},
                'available', ${location}, ${input.foodProvider ?? null},
                ${input.providerFoodId ?? null}, ${input.barcode ?? null},
                ${input.note?.trim() || null}, ${input.userId}, ${input.userId}
            ) returning *
        `;
        row = inserted[0] ?? null;
    } else {
        const currentQuantity =
            row.quantity == null ? null : Number(row.quantity);
        const currentMode = String(row.quantity_mode) as InventoryQuantityMode;
        const nextQuantity =
            quantity == null
                ? currentQuantity
                : currentQuantity == null
                  ? quantity
                  : currentQuantity + quantity;
        const nextMode: InventoryQuantityMode =
            input.quantityMode ??
            (quantity == null && nextQuantity == null
                ? "presence_only"
                : currentQuantity == null
                  ? "approximate"
                  : currentMode === "exact"
                    ? "exact"
                    : "approximate");
        const updated = await tx<Array<Record<string, unknown>>>`
            update munch.inventory_items
            set quantity = ${nextQuantity}, quantity_mode = ${nextMode},
                stock_state = 'available', location = ${location},
                food_provider = coalesce(food_provider, ${input.foodProvider ?? null}),
                provider_food_id = coalesce(provider_food_id, ${input.providerFoodId ?? null}),
                barcode = coalesce(barcode, ${input.barcode ?? null}),
                note = coalesce(${input.note?.trim() || null}, note),
                updated_by_user_id = ${input.userId}, updated_at = now(),
                version = version + 1
            where id = ${String(row.id)} returning *
        `;
        row = updated[0] ?? null;
    }
    if (!row) throw new Error("Pantry acquisition returned no item");
    const item = serializeItem(row);
    await insertEvent(tx, {
        spaceId: input.spaceId,
        itemId: item.id,
        eventType: "acquire",
        deltaQuantity: quantity,
        quantityAfter: item.quantity,
        unit,
        sourceType: input.sourceType,
        sourceEntityId: input.sourceEntityId,
        sourceKey: input.sourceKey,
        confidence: input.confidence,
        userId: input.userId,
    });
    return { item, deduplicated: false };
}

export async function getPantryPreference(userId: string): Promise<boolean> {
    return withUserDatabase(userId, async (tx) => {
        const rows = await tx<Array<{ pantry_enabled: boolean }>>`
            select pantry_enabled from munch.account_preferences where user_id = ${userId}
        `;
        return rows[0]?.pantry_enabled === true;
    });
}

export async function setPantryPreference(input: {
    userId: string;
    enabled: boolean;
}): Promise<boolean> {
    return withUserDatabase(input.userId, async (tx) => {
        const rows = await tx<Array<{ pantry_enabled: boolean }>>`
            insert into munch.account_preferences (user_id, pantry_enabled)
            values (${input.userId}, ${input.enabled})
            on conflict (user_id) do update
            set pantry_enabled = excluded.pantry_enabled, updated_at = now()
            returning pantry_enabled
        `;
        return rows[0]?.pantry_enabled === true;
    });
}

export async function getPantry(input: {
    userId: string;
    scope: InventoryScope;
    query?: string;
    candidateNames?: string[];
    location?: InventoryLocation;
    includeDepleted?: boolean;
    limit?: number;
}) {
    return withUserDatabase(input.userId, async (tx) => {
        const preference = await tx<Array<{ pantry_enabled: boolean }>>`
            select pantry_enabled from munch.account_preferences where user_id = ${input.userId}
        `;
        const enabled = preference[0]?.pantry_enabled === true;
        if (!enabled)
            return {
                enabled: false,
                inventorySpaceId: null,
                items: [] as PantryItem[],
            };
        const spaceId = await existingSpace(tx, input.userId, input.scope);
        if (!spaceId)
            return {
                enabled: true,
                inventorySpaceId: null,
                items: [] as PantryItem[],
            };
        const query = normalizeInventoryName(input.query ?? "");
        const candidates = (input.candidateNames ?? [])
            .map(normalizeInventoryName)
            .filter(Boolean)
            .slice(0, 30);
        const max = Math.min(
            200,
            Math.max(1, input.limit ?? (candidates.length ? 40 : 150)),
        );
        const rows =
            candidates.length === 0
                ? await tx<Array<Record<string, unknown>>>`
                      select * from munch.inventory_items
                      where inventory_space_id = ${spaceId}
                        and deleted_at is null
                        and (${input.includeDepleted ?? false} or stock_state <> 'depleted')
                        and (${input.location ?? null}::text is null or location = ${input.location ?? null})
                        and (${query} = '' or normalized_name like ${`%${query}%`})
                      order by case stock_state when 'low' then 0 else 1 end, updated_at desc
                      limit ${max}
                  `
                : await tx<Array<Record<string, unknown>>>`
                      select * from munch.inventory_items
                      where inventory_space_id = ${spaceId}
                        and deleted_at is null
                        and (${input.includeDepleted ?? false} or stock_state <> 'depleted')
                        and (${input.location ?? null}::text is null or location = ${input.location ?? null})
                        and (${query} = '' or normalized_name like ${`%${query}%`})
                        and (
                            normalized_name = any(${candidates}::text[])
                            or exists (
                                select 1 from unnest(${candidates}::text[]) c(name)
                                where normalized_name like '%' || c.name || '%'
                                   or c.name like '%' || normalized_name || '%'
                            )
                        )
                      order by case stock_state when 'low' then 0 else 1 end, updated_at desc
                      limit ${max}
                  `;
        return {
            enabled: true,
            inventorySpaceId: spaceId,
            items: rows.map(serializeItem),
        };
    });
}

export async function reconcilePantry(input: {
    userId: string;
    scope: InventoryScope;
    sourceType: InventorySourceType;
    sourceEntityId?: string;
    idempotencyKey: string;
    operations: PantryOperation[];
}) {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255) {
        throw new Error("Pantry idempotency key is required");
    }
    if (input.operations.length < 1 || input.operations.length > 100) {
        throw new Error("Reconcile 1 to 100 Pantry operations at a time");
    }
    return withUserDatabase(input.userId, async (tx) => {
        const enabledRows = await tx<Array<{ pantry_enabled: boolean }>>`
            select pantry_enabled from munch.account_preferences where user_id = ${input.userId}
        `;
        if (enabledRows[0]?.pantry_enabled !== true)
            throw new Error("Pantry is not enabled");
        const spaceId = await getOrCreateSpace(tx, input.userId, input.scope);
        const results: Array<{
            action: string;
            item: PantryItem;
            deduplicated: boolean;
        }> = [];

        for (let index = 0; index < input.operations.length; index += 1) {
            const op = input.operations[index]!;
            const sourceKey = `${input.idempotencyKey}:${index}`;
            if (op.action === "acquire") {
                const acquired = await acquireInTransaction(tx, {
                    userId: input.userId,
                    spaceId,
                    sourceType: input.sourceType,
                    sourceEntityId: input.sourceEntityId,
                    sourceKey,
                    name: op.name,
                    quantity: op.quantity,
                    unit: op.unit,
                    quantityMode: op.quantityMode,
                    location: op.location,
                    foodProvider: op.foodProvider,
                    providerFoodId: op.providerFoodId,
                    barcode: op.barcode,
                    note: op.note,
                    confidence: op.confidence,
                });
                results.push({ action: op.action, ...acquired });
                continue;
            }

            const priorEvent = await tx<Array<{ inventory_item_id: string }>>`
                select inventory_item_id from munch.inventory_events
                where inventory_space_id = ${spaceId} and source_key = ${sourceKey}
                limit 1
            `;
            if (priorEvent[0]) {
                const priorItem = await readItemForUpdate(
                    tx,
                    spaceId,
                    priorEvent[0].inventory_item_id,
                );
                results.push({
                    action: op.action,
                    item: serializeItem(priorItem),
                    deduplicated: true,
                });
                continue;
            }

            const row = await readItemForUpdate(
                tx,
                spaceId,
                op.inventoryItemId,
            );
            const currentQuantity =
                row.quantity == null ? null : Number(row.quantity);
            let updated: Record<string, unknown> | undefined;
            let delta: number | null = null;

            if (op.action === "consume") {
                if (!Number.isFinite(op.quantity) || op.quantity <= 0)
                    throw new Error("Consumption quantity must be positive");
                const currentUnit = canonicalInventoryUnit(
                    row.unit == null ? null : String(row.unit),
                );
                const requestedUnit = canonicalInventoryUnit(
                    op.unit ?? currentUnit,
                );
                if (
                    currentUnit &&
                    requestedUnit &&
                    currentUnit !== requestedUnit
                ) {
                    throw new Error(
                        "Consumption unit must match the Pantry item unit",
                    );
                }
                const next =
                    currentQuantity == null
                        ? null
                        : Math.max(0, currentQuantity - op.quantity);
                delta = -op.quantity;
                const rows = await tx<Array<Record<string, unknown>>>`
                    update munch.inventory_items
                    set quantity = ${next},
                        quantity_mode = case when quantity is null then 'approximate' else quantity_mode end,
                        stock_state = case when ${next}::numeric is not null and ${next}::numeric <= 0 then 'depleted' else stock_state end,
                        updated_by_user_id = ${input.userId}, updated_at = now(), version = version + 1
                    where id = ${op.inventoryItemId} returning *
                `;
                updated = rows[0];
            } else if (
                op.action === "consume_all" ||
                op.action === "mark_depleted" ||
                op.action === "discard"
            ) {
                delta = currentQuantity == null ? null : -currentQuantity;
                const rows = await tx<Array<Record<string, unknown>>>`
                    update munch.inventory_items
                    set quantity = case when quantity is null then null else 0 end,
                        stock_state = 'depleted', updated_by_user_id = ${input.userId},
                        updated_at = now(), version = version + 1
                    where id = ${op.inventoryItemId} returning *
                `;
                updated = rows[0];
            } else if (op.action === "mark_low") {
                const rows = await tx<Array<Record<string, unknown>>>`
                    update munch.inventory_items
                    set stock_state = 'low', updated_by_user_id = ${input.userId},
                        updated_at = now(), version = version + 1
                    where id = ${op.inventoryItemId} returning *
                `;
                updated = rows[0];
            } else if (op.action === "move") {
                const rows = await tx<Array<Record<string, unknown>>>`
                    update munch.inventory_items
                    set location = ${op.location}, updated_by_user_id = ${input.userId},
                        updated_at = now(), version = version + 1
                    where id = ${op.inventoryItemId} returning *
                `;
                updated = rows[0];
            } else if (op.action === "correct") {
                const quantity = validateQuantity(op.quantity);
                const nextQuantity =
                    quantity === undefined ? currentQuantity : quantity;
                const nextState =
                    op.stockState ??
                    (nextQuantity === 0
                        ? "depleted"
                        : (String(row.stock_state) as InventoryStockState));
                const rows = await tx<Array<Record<string, unknown>>>`
                    update munch.inventory_items
                    set quantity = ${nextQuantity},
                        unit = ${op.unit === undefined ? (row.unit == null ? null : String(row.unit)) : canonicalInventoryUnit(op.unit)},
                        quantity_mode = ${op.quantityMode ?? String(row.quantity_mode)},
                        stock_state = ${nextState},
                        note = ${op.note === undefined ? (row.note == null ? null : String(row.note)) : op.note},
                        updated_by_user_id = ${input.userId}, updated_at = now(), version = version + 1
                    where id = ${op.inventoryItemId} returning *
                `;
                updated = rows[0];
            }
            if (!updated)
                throw new Error("Pantry reconciliation produced no item");
            const item = serializeItem(updated);
            await insertEvent(tx, {
                spaceId,
                itemId: item.id,
                eventType: op.action,
                deltaQuantity: delta,
                quantityAfter: item.quantity,
                unit: item.unit,
                sourceType: input.sourceType,
                sourceEntityId: input.sourceEntityId,
                sourceKey,
                confidence: op.confidence,
                userId: input.userId,
            });
            results.push({ action: op.action, item, deduplicated: false });
        }
        return {
            enabled: true,
            inventorySpaceId: spaceId,
            operations: results,
        };
    });
}

async function activeGroceryListId(
    tx: DatabaseTransaction,
    userId: string,
    scope: InventoryScope,
): Promise<string | null> {
    const owner = ownerValues(scope, userId);
    const rows = await tx<Array<{ id: string }>>`
        select id from munch.grocery_lists
        where status = 'active'
          and personal_owner_user_id is not distinct from ${owner.personalOwnerUserId}
          and household_id is not distinct from ${owner.householdId}
        limit 1
    `;
    return rows[0] ? String(rows[0].id) : null;
}

export async function reconcilePurchase(input: {
    userId: string;
    scope: InventoryScope;
    idempotencyKey: string;
    sourceLabel?: string;
    purchasedAt?: string;
    lines: PurchaseLineInput[];
}) {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255)
        throw new Error("Purchase idempotency key is required");
    if (input.lines.length < 1 || input.lines.length > 200)
        throw new Error("Reconcile 1 to 200 purchase lines at a time");
    return withUserDatabase(input.userId, async (tx) => {
        const enabledRows = await tx<Array<{ pantry_enabled: boolean }>>`
            select pantry_enabled from munch.account_preferences where user_id = ${input.userId}
        `;
        if (enabledRows[0]?.pantry_enabled !== true)
            throw new Error("Pantry is not enabled");
        const spaceId = await getOrCreateSpace(tx, input.userId, input.scope);
        const existing = await tx<Array<{ id: string; status: string }>>`
            select id, status from munch.purchase_reconciliations
            where inventory_space_id = ${spaceId} and idempotency_key = ${input.idempotencyKey}
            limit 1
        `;
        if (existing[0]) {
            const lines = await tx<Array<Record<string, unknown>>>`
                select * from munch.purchase_reconciliation_lines
                where purchase_reconciliation_id = ${existing[0].id}
                order by position
            `;
            return summarizePurchase(String(existing[0].id), true, lines);
        }
        const purchasedAt = input.purchasedAt ?? new Date().toISOString();
        if (Number.isNaN(new Date(purchasedAt).getTime())) {
            throw new Error("Purchase timestamp is invalid");
        }
        const batchRows = await tx<Array<{ id: string }>>`
            insert into munch.purchase_reconciliations (
                inventory_space_id, idempotency_key, source_type, source_label,
                purchased_at, status, created_by_user_id
            ) values (
                ${spaceId}, ${input.idempotencyKey}, 'receipt',
                ${input.sourceLabel?.trim().slice(0, 300) || null},
                ${purchasedAt}, 'applied', ${input.userId}
            ) returning id
        `;
        const batchId = String(batchRows[0]!.id);
        const groceryListId = await activeGroceryListId(
            tx,
            input.userId,
            input.scope,
        );
        let needsReview = false;

        for (let index = 0; index < input.lines.length; index += 1) {
            const line = input.lines[index]!;
            const name = line.name.trim().slice(0, 300);
            const normalized = normalizeInventoryName(name);
            if (!name || !normalized)
                throw new Error("Purchase line name is invalid");
            const confidence = validateConfidence(line.confidence);
            const isFood = line.isFood !== false;
            const actionable =
                isFood &&
                (line.confirmed === true ||
                    confidence == null ||
                    confidence >= 0.85);
            let action = "ignored_non_food";
            let groceryItemId: string | null = null;
            let inventoryItemId: string | null = null;

            if (isFood && !actionable) {
                action = "needs_review";
                needsReview = true;
            } else if (isFood) {
                let grocery: Record<string, unknown> | undefined;
                if (groceryListId) {
                    const providerId = line.providerFoodId ?? null;
                    const provider = line.foodProvider ?? null;
                    const groceryRows = await tx<
                        Array<Record<string, unknown>>
                    >`
                        select id, version, purchased_at, quantity, unit,
                               food_provider, provider_food_id, normalized_name
                        from munch.grocery_items
                        where grocery_list_id = ${groceryListId}
                          and deleted_at is null
                          and (
                            purchased_at is null
                            or purchased_at between
                                ${purchasedAt}::timestamptz - interval '7 days'
                                and ${purchasedAt}::timestamptz + interval '12 hours'
                          )
                          and (
                            (${providerId}::text is not null
                                and provider_food_id = ${providerId}
                                and food_provider is not distinct from ${provider})
                            or normalized_name = ${normalized}
                            or normalized_name like ${`%${normalized}%`}
                            or ${normalized} like '%' || normalized_name || '%'
                          )
                        order by
                            case when purchased_at is null then 0 else 1 end,
                            case when provider_food_id = ${providerId} then 0 else 1 end,
                            purchased_at desc nulls first,
                            created_at desc
                        limit 1 for update
                    `;
                    grocery = groceryRows[0];
                }
                if (grocery) {
                    groceryItemId = String(grocery.id);
                    const receiptUnit = canonicalInventoryUnit(
                        line.unit ??
                            (grocery.unit == null
                                ? null
                                : String(grocery.unit)),
                    );
                    if (grocery.purchased_at == null) {
                        const purchased = await tx<Array<{ id: string }>>`
                            update munch.grocery_items
                            set quantity = coalesce(${line.quantity ?? null}, quantity),
                                unit = coalesce(${receiptUnit}, unit),
                                food_provider = coalesce(${line.foodProvider ?? null}, food_provider),
                                provider_food_id = coalesce(${line.providerFoodId ?? null}, provider_food_id),
                                purchased_at = ${purchasedAt},
                                purchased_by_user_id = ${input.userId},
                                updated_by_user_id = ${input.userId},
                                updated_at = now(),
                                version = version + 1
                            where id = ${groceryItemId}
                              and version = ${Number(grocery.version)}
                            returning id
                        `;
                        if (!purchased[0]) {
                            throw new Error(
                                "Grocery item changed during purchase reconciliation",
                            );
                        }
                        const eventRows = await tx<
                            Array<{ inventory_item_id: string }>
                        >`
                            select inventory_item_id
                            from munch.inventory_events
                            where inventory_space_id = ${spaceId}
                              and source_type = 'grocery_purchase'
                              and source_entity_id = ${groceryItemId}
                            order by created_at desc
                            limit 1
                        `;
                        inventoryItemId = eventRows[0]
                            ? String(eventRows[0].inventory_item_id)
                            : null;
                        action = "grocery_matched";
                    } else {
                        const priorRows = await tx<
                            Array<Record<string, unknown>>
                        >`
                            select event.inventory_item_id,
                                   event.delta_quantity,
                                   event.unit,
                                   item.quantity as item_quantity,
                                   item.quantity_mode
                            from munch.inventory_events event
                            join munch.inventory_items item
                              on item.id = event.inventory_item_id
                            where event.inventory_space_id = ${spaceId}
                              and event.source_type = 'grocery_purchase'
                              and event.source_entity_id = ${groceryItemId}
                            order by event.created_at desc
                            limit 1
                            for update of item
                        `;
                        const prior = priorRows[0];
                        if (prior) {
                            inventoryItemId = String(prior.inventory_item_id);
                            action = "grocery_matched";
                            if (
                                line.quantity != null &&
                                prior.delta_quantity != null
                            ) {
                                const actualQuantity = convertInventoryQuantity(
                                    line.quantity,
                                    receiptUnit,
                                    prior.unit == null
                                        ? null
                                        : String(prior.unit),
                                );
                                if (actualQuantity == null) {
                                    action = "needs_review";
                                    needsReview = true;
                                } else {
                                    const delta =
                                        actualQuantity -
                                        Number(prior.delta_quantity);
                                    const currentQuantity =
                                        prior.item_quantity == null
                                            ? null
                                            : Number(prior.item_quantity);
                                    if (
                                        currentQuantity != null &&
                                        Math.abs(delta) > 0.0005
                                    ) {
                                        const nextQuantity = Math.max(
                                            0,
                                            currentQuantity + delta,
                                        );
                                        await tx`
                                            update munch.inventory_items
                                            set quantity = ${nextQuantity},
                                                quantity_mode = case
                                                    when quantity_mode = 'presence_only'
                                                        then 'approximate'
                                                    else quantity_mode
                                                end,
                                                stock_state = case
                                                    when ${nextQuantity} <= 0
                                                        then 'depleted'
                                                    else 'available'
                                                end,
                                                updated_by_user_id = ${input.userId},
                                                updated_at = now(),
                                                version = version + 1
                                            where id = ${inventoryItemId}
                                        `;
                                        await insertEvent(tx, {
                                            spaceId,
                                            itemId: inventoryItemId,
                                            eventType: "correct",
                                            deltaQuantity: delta,
                                            quantityAfter: nextQuantity,
                                            unit:
                                                prior.unit == null
                                                    ? null
                                                    : String(prior.unit),
                                            sourceType: "receipt",
                                            sourceEntityId: batchId,
                                            sourceKey: `receipt:${batchId}:${index}:grocery-correction`,
                                            confidence: line.confidence,
                                            userId: input.userId,
                                        });
                                    }
                                }
                            }
                            if (action === "grocery_matched") {
                                await tx`
                                    update munch.grocery_items
                                    set quantity = coalesce(${line.quantity ?? null}, quantity),
                                        unit = coalesce(${receiptUnit}, unit),
                                        food_provider = coalesce(${line.foodProvider ?? null}, food_provider),
                                        provider_food_id = coalesce(${line.providerFoodId ?? null}, provider_food_id),
                                        updated_by_user_id = ${input.userId},
                                        updated_at = now(),
                                        version = version + 1
                                    where id = ${groceryItemId}
                                `;
                            }
                        } else {
                            const acquired = await acquireInTransaction(tx, {
                                userId: input.userId,
                                spaceId,
                                sourceType: "receipt",
                                sourceEntityId: batchId,
                                sourceKey: `receipt:${batchId}:${index}:purchased-grocery`,
                                name,
                                quantity: line.quantity,
                                unit: line.unit,
                                location: line.location,
                                foodProvider: line.foodProvider,
                                providerFoodId: line.providerFoodId,
                                confidence: line.confidence,
                            });
                            inventoryItemId = acquired.item.id;
                            action = "grocery_matched";
                        }
                    }
                } else {
                    const acquired = await acquireInTransaction(tx, {
                        userId: input.userId,
                        spaceId,
                        sourceType: "receipt",
                        sourceEntityId: batchId,
                        sourceKey: `receipt:${batchId}:${index}`,
                        name,
                        quantity: line.quantity,
                        unit: line.unit,
                        location: line.location,
                        foodProvider: line.foodProvider,
                        providerFoodId: line.providerFoodId,
                        confidence: line.confidence,
                    });
                    inventoryItemId = acquired.item.id;
                    action = "inventory_added";
                }
            }

            await tx`
                insert into munch.purchase_reconciliation_lines (
                    purchase_reconciliation_id, position, raw_label, resolved_name,
                    normalized_name, quantity, unit, food_provider, provider_food_id,
                    confidence, is_food, confirmed, action, grocery_item_id, inventory_item_id
                ) values (
                    ${batchId}, ${index}, ${line.rawLabel?.trim().slice(0, 300) || null},
                    ${name}, ${normalized}, ${line.quantity ?? null},
                    ${canonicalInventoryUnit(line.unit)}, ${line.foodProvider ?? null},
                    ${line.providerFoodId ?? null}, ${confidence}, ${isFood},
                    ${line.confirmed === true}, ${action}, ${groceryItemId}, ${inventoryItemId}
                )
            `;
        }
        if (needsReview) {
            await tx`update munch.purchase_reconciliations set status='needs_review' where id=${batchId}`;
        }
        const lines = await tx<Array<Record<string, unknown>>>`
            select * from munch.purchase_reconciliation_lines
            where purchase_reconciliation_id = ${batchId}
            order by position
        `;
        return summarizePurchase(batchId, false, lines);
    });
}

function summarizePurchase(
    batchId: string,
    deduplicated: boolean,
    rows: Array<Record<string, unknown>>,
) {
    const lines = rows.map((row) => ({
        position: Number(row.position),
        name: String(row.resolved_name),
        quantity: row.quantity == null ? null : Number(row.quantity),
        unit: row.unit == null ? null : String(row.unit),
        confidence: row.confidence == null ? null : Number(row.confidence),
        action: String(row.action),
        grocery_item_id:
            row.grocery_item_id == null ? null : String(row.grocery_item_id),
        inventory_item_id:
            row.inventory_item_id == null
                ? null
                : String(row.inventory_item_id),
    }));
    return {
        purchaseReconciliationId: batchId,
        deduplicated,
        lines,
        summary: {
            groceryMatched: lines.filter(
                (line) => line.action === "grocery_matched",
            ).length,
            inventoryAdded: lines.filter(
                (line) => line.action === "inventory_added",
            ).length,
            ignoredNonFood: lines.filter(
                (line) => line.action === "ignored_non_food",
            ).length,
            needsReview: lines.filter((line) => line.action === "needs_review")
                .length,
        },
    };
}
