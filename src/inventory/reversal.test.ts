import { describe, expect, test } from "bun:test";
import { reverseMealDrawdownInTransaction } from "./reversal.js";
import { getPantry, reconcilePantry } from "./repository.js";
import { applyPantryDrawdown } from "./drawdown.js";
import { deleteMeal } from "../nutrition-platform/meals.js";
import {
    getPlatformDatabase,
    closePlatformDatabase,
} from "../platform/database.js";
import type { DatabaseTransaction } from "../platform/database.js";

/**
 * W2 data-integrity F5: deleting a meal must unwind its pantry
 * draw-down. Reversal matches events by source_entity_id = mealId
 * (NOT the meal idempotency key) and appends `reverse` events linked
 * via reversal_of_event_id instead of mutating history.
 */

interface FakeItem {
    id: string;
    quantity: number | string | null;
    unit: string | null;
    stock_state: string;
    deleted_at: Date | string | null;
}

interface FakeEvent {
    id: string;
    inventory_space_id: string;
    inventory_item_id: string;
    event_type: string;
    delta_quantity: number | string | null;
    unit: string | null;
    source_type: string;
}

interface InsertRecord {
    values: unknown[];
    sql: string;
}

/** A stateful fake DatabaseTransaction over in-memory items/events,
 *  emulating the source_key unique-conflict behavior of
 *  munch.inventory_events. */
function makeFakeTx(events: FakeEvent[], items: Map<string, FakeItem>) {
    const inserts: InsertRecord[] = [];
    const updates: Array<{ id: string; values: unknown[] }> = [];
    const usedSourceKeys = new Set<string>();

    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (
            sql.includes("from munch.inventory_events") &&
            sql.includes("select")
        ) {
            return Promise.resolve(events);
        }
        if (sql.includes("from munch.inventory_items")) {
            const item = items.get(String(values[0]));
            return Promise.resolve(item ? [item] : []);
        }
        if (sql.includes("insert into munch.inventory_events")) {
            const sourceKey = String(values[7]);
            if (usedSourceKeys.has(sourceKey)) {
                return Promise.resolve([]);
            }
            usedSourceKeys.add(sourceKey);
            inserts.push({ values, sql });
            return Promise.resolve([{ id: `rev-${inserts.length}` }]);
        }
        if (sql.includes("update munch.inventory_items")) {
            // values: [nextQuantity, nextStockState, userId, itemId, spaceId]
            const item = items.get(String(values[3]));
            if (item) {
                item.quantity = values[0] as number | null;
                item.stock_state = String(values[1]);
            }
            updates.push({ id: String(values[3]), values });
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    }) as unknown as DatabaseTransaction;

    return { tx, inserts, updates };
}

const ev = (partial: Partial<FakeEvent> & { id: string }): FakeEvent => ({
    inventory_space_id: "space-1",
    inventory_item_id: "item-1",
    event_type: "consume",
    delta_quantity: null,
    unit: null,
    source_type: "meal_reconciliation",
    ...partial,
});

describe("reverseMealDrawdownInTransaction", () => {
    test("reverseMealDrawdownInTransaction appends reverse events and restores exact/depleted/presence-only stock", async () => {
        const items = new Map<string, FakeItem>([
            [
                "rice",
                {
                    id: "rice",
                    quantity: "4",
                    unit: "cup",
                    stock_state: "available",
                    deleted_at: null,
                },
            ],
            [
                "chicken",
                {
                    id: "chicken",
                    quantity: "0",
                    unit: "lb",
                    stock_state: "depleted",
                    deleted_at: null,
                },
            ],
            [
                "salt",
                {
                    id: "salt",
                    quantity: null,
                    unit: null,
                    stock_state: "depleted",
                    deleted_at: null,
                },
            ],
            [
                "gone",
                {
                    id: "gone",
                    quantity: "3",
                    unit: "cup",
                    stock_state: "available",
                    deleted_at: "2026-06-01T00:00:00Z",
                },
            ],
            [
                "flour",
                {
                    id: "flour",
                    quantity: "5",
                    unit: "cup",
                    stock_state: "available",
                    deleted_at: null,
                },
            ],
        ]);
        const events: FakeEvent[] = [
            ev({
                id: "evt-1",
                inventory_item_id: "rice",
                delta_quantity: "-2",
                unit: "cup",
            }),
            ev({
                id: "evt-2",
                inventory_item_id: "chicken",
                delta_quantity: "-1",
                unit: "lb",
            }),
            ev({
                id: "evt-3",
                inventory_item_id: "salt",
                event_type: "consume_all",
                delta_quantity: null,
            }),
            ev({
                id: "evt-4",
                inventory_item_id: "gone",
                delta_quantity: "-1",
                unit: "cup",
            }),
            ev({
                id: "evt-5a",
                inventory_item_id: "flour",
                delta_quantity: "-1",
                unit: "cup",
            }),
            ev({
                id: "evt-5b",
                inventory_item_id: "flour",
                delta_quantity: "-2",
                unit: "cup",
            }),
        ];
        const { tx, inserts } = makeFakeTx(events, items);

        const result = await reverseMealDrawdownInTransaction(
            tx,
            "user-1",
            "meal-1",
        );

        // Soft-deleted item (evt-4) is skipped; everything else reverses.
        expect(result.reversedEventCount).toBe(5);
        expect(result.restoredItemIds).toContain("rice");
        expect(result.restoredItemIds).toContain("chicken");
        expect(result.restoredItemIds).toContain("salt");
        expect(inserts).toHaveLength(5);

        // Case 1: exact consume of -2 cup on 4 cup -> restore to 6.
        // Insert values: [space, item, delta, quantityAfter, unit,
        // sourceType, mealId, sourceKey, actorUserId, reversalOf, eventType]
        const riceInsert = inserts.find((i) => i.values[1] === "rice")!;
        expect(riceInsert.values[2]).toBe(2);
        expect(riceInsert.values[3]).toBe(6);
        expect(riceInsert.values[7]).toBe("reverse:meal:meal-1:evt-1");
        expect(riceInsert.values[9]).toBe("evt-1");
        expect(riceInsert.sql).toContain("'reverse'");
        expect(riceInsert.sql).toContain("jsonb_build_object");
        expect(items.get("rice")!.quantity).toBe(6);
        expect(items.get("rice")!.stock_state).toBe("available");

        // Case 2: depleted-to-0 restores quantity AND availability.
        expect(items.get("chicken")!.quantity).toBe(1);
        expect(items.get("chicken")!.stock_state).toBe("available");

        // Case 3: presence-only consume_all restores availability, no quantity.
        const saltInsert = inserts.find((i) => i.values[1] === "salt")!;
        expect(saltInsert.values[2]).toBeNull();
        expect(saltInsert.values[3]).toBeNull();
        expect(items.get("salt")!.quantity).toBeNull();
        expect(items.get("salt")!.stock_state).toBe("available");

        // Case 5: two events on the same item accumulate sequentially.
        expect(items.get("flour")!.quantity).toBe(8);
        const flourAfters = inserts
            .filter((i) => i.values[1] === "flour")
            .map((i) => i.values[3]);
        expect(flourAfters).toEqual([6, 8]);
    });

    test("a source_key conflict skips the item update entirely (no double restore)", async () => {
        const items = new Map<string, FakeItem>([
            [
                "rice",
                {
                    id: "rice",
                    quantity: "4",
                    unit: "cup",
                    stock_state: "available",
                    deleted_at: null,
                },
            ],
        ]);
        const events: FakeEvent[] = [
            ev({
                id: "evt-1",
                inventory_item_id: "rice",
                delta_quantity: "-2",
                unit: "cup",
            }),
        ];
        const { tx, inserts, updates } = makeFakeTx(events, items);
        // Pre-seed the reversal key as already used by running once.
        await reverseMealDrawdownInTransaction(tx, "user-1", "meal-1");
        expect(items.get("rice")!.quantity).toBe(6);

        // Second pass against the same fake (key now used): the SQL
        // not-exists filter would normally exclude the event, but if it
        // still arrives, the insert conflict must prevent a re-update.
        const again = await reverseMealDrawdownInTransaction(
            tx,
            "user-1",
            "meal-1",
        );
        expect(again.reversedEventCount).toBe(0);
        expect(items.get("rice")!.quantity).toBe(6);
        expect(inserts).toHaveLength(1);
        expect(updates).toHaveLength(1);
    });
});

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

describe("deleteMeal pantry draw-down reversal against real Postgres", () => {
    test.skipIf(!hasDatabase)(
        "deleteMeal unwinds pantry drawdown in Postgres, restores stock, and is idempotent",
        async () => {
            const database = getPlatformDatabase();
            const userId = crypto.randomUUID();
            const scope = { type: "personal" as const };
            try {
                await database`
                    insert into munch.users (id, email, name, email_verified, status)
                    values (${userId}::uuid, ${`reversal-f5-${userId}@example.test`}, 'F5 test', true, 'active')
                `;
                await reconcilePantry({
                    userId,
                    scope,
                    sourceType: "manual",
                    idempotencyKey: `f5-acquire-${userId}`,
                    operations: [
                        {
                            action: "acquire",
                            name: "Rice",
                            quantity: 6,
                            unit: "cup",
                        },
                        {
                            action: "acquire",
                            name: "Chicken",
                            quantity: 1,
                            unit: "lb",
                        },
                    ],
                });
                const pantryOf = async (name: string) => {
                    const pantry = await getPantry({
                        userId,
                        scope,
                        includeDepleted: true,
                    });
                    return pantry.items.find((i) => i.name === name);
                };
                expect((await pantryOf("Rice"))?.quantity).toBe(6);

                const mealId = crypto.randomUUID();
                await database`
                    insert into munch.meals (id, user_id, description)
                    values (${mealId}::uuid, ${userId}::uuid, 'F5 drawdown meal')
                `;
                await applyPantryDrawdown({
                    userId,
                    scope,
                    sourceType: "meal_reconciliation",
                    mealId,
                    mealIdempotencyKey: `f5-meal-${mealId}`,
                    requirements: [{ name: "Rice", quantity: 2, unit: "cup" }],
                });
                expect((await pantryOf("Rice"))?.quantity).toBe(4);

                const consumeRows = await database<Array<{ id: string }>>`
                    select id from munch.inventory_events
                    where source_entity_id = ${mealId}
                      and event_type = 'consume'
                `;
                expect(consumeRows).toHaveLength(1);

                await deleteMeal(userId, mealId);

                const mealRows = await database<Array<{ id: string }>>`
                    select id from munch.meals where id = ${mealId}::uuid
                `;
                expect(mealRows).toHaveLength(0);
                const rice = await pantryOf("Rice");
                expect(rice?.quantity).toBe(6);
                expect(rice?.stock_state).toBe("available");

                const reversalRows = await database<
                    Array<{
                        delta_quantity: string | null;
                        quantity_after: string | null;
                        reversal_of_event_id: string;
                        metadata_type: string;
                    }>
                >`
                    select delta_quantity, quantity_after, reversal_of_event_id,
                           jsonb_typeof(metadata) as metadata_type
                    from munch.inventory_events
                    where source_entity_id = ${mealId}
                      and event_type = 'reverse'
                `;
                expect(reversalRows).toHaveLength(1);
                expect(Number(reversalRows[0]!.delta_quantity)).toBe(2);
                expect(Number(reversalRows[0]!.quantity_after)).toBe(6);
                expect(reversalRows[0]!.reversal_of_event_id).toBe(
                    consumeRows[0]!.id,
                );
                expect(reversalRows[0]!.metadata_type).toBe("object");

                // Idempotent: a second delete restores nothing twice.
                await deleteMeal(userId, mealId);
                expect((await pantryOf("Rice"))?.quantity).toBe(6);
                const reversalCount = await database<Array<{ count: string }>>`
                    select count(*)::text as count from munch.inventory_events
                    where source_entity_id = ${mealId} and event_type = 'reverse'
                `;
                expect(reversalCount[0]!.count).toBe("1");

                // Depleted-to-zero stock is restored to available.
                const meal2Id = crypto.randomUUID();
                await database`
                    insert into munch.meals (id, user_id, description)
                    values (${meal2Id}::uuid, ${userId}::uuid, 'F5 depleting meal')
                `;
                await applyPantryDrawdown({
                    userId,
                    scope,
                    sourceType: "meal_reconciliation",
                    mealId: meal2Id,
                    mealIdempotencyKey: `f5-meal-${meal2Id}`,
                    requirements: [
                        { name: "Chicken", quantity: 1, unit: "lb" },
                    ],
                });
                const depleted = await pantryOf("Chicken");
                expect(depleted?.quantity).toBe(0);
                expect(depleted?.stock_state).toBe("depleted");

                await deleteMeal(userId, meal2Id);
                const chicken = await pantryOf("Chicken");
                expect(chicken?.quantity).toBe(1);
                expect(chicken?.stock_state).toBe("available");
            } finally {
                await database`
                    delete from munch.inventory_events
                    where inventory_space_id in (
                        select id from munch.inventory_spaces
                        where personal_owner_user_id = ${userId}::uuid
                    )
                `;
                await database`
                    delete from munch.inventory_items
                    where inventory_space_id in (
                        select id from munch.inventory_spaces
                        where personal_owner_user_id = ${userId}::uuid
                    )
                `;
                await database`
                    delete from munch.inventory_spaces
                    where personal_owner_user_id = ${userId}::uuid
                `;
                await database`
                    delete from munch.meals where user_id = ${userId}::uuid
                `;
                await database`
                    delete from munch.users where id = ${userId}::uuid
                `;
                await closePlatformDatabase();
            }
        },
    );
});
