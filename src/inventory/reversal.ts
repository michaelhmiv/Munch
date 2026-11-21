import type { DatabaseTransaction } from "../platform/database.js";

export interface DrawdownReversalResult {
    reversedEventCount: number;
    restoredItemIds: string[];
}

interface DrawdownEventRow {
    id: string;
    inventory_space_id: string;
    inventory_item_id: string;
    event_type: string;
    delta_quantity: number | string | null;
    unit: string | null;
    source_type: string;
}

interface LockedItemRow {
    id: string;
    quantity: number | string | null;
    unit: string | null;
    stock_state: string;
    deleted_at: Date | string | null;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/**
 * Reverse any unreversed pantry draw-down events (`consume` / `consume_all`)
 * linked to `mealId` (`source_entity_id = mealId`). Runs inside the caller's
 * RLS-scoped user transaction (`withUserDatabase`), so personal and
 * writable household inventory spaces are handled automatically.
 *
 * Idempotent: already-reversed events are skipped both by the `not exists`
 * filter and by the unique `source_key` on `munch.inventory_events`.
 * Soft-deleted pantry items are not resurrected.
 */
export async function reverseMealDrawdownInTransaction(
    tx: DatabaseTransaction,
    userId: string,
    mealId: string,
): Promise<DrawdownReversalResult> {
    const events = await tx<DrawdownEventRow[]>`
        select
            e.id,
            e.inventory_space_id,
            e.inventory_item_id,
            e.event_type,
            e.delta_quantity,
            e.unit,
            e.source_type
        from munch.inventory_events e
        join munch.inventory_spaces s
          on s.id = e.inventory_space_id
        where e.source_entity_id = ${mealId}
          and e.source_type in ('meal_reconciliation', 'recipe_preparation')
          and e.event_type in ('consume', 'consume_all')
          and (
              s.personal_owner_user_id = ${userId}
              or (
                  s.household_id is not null
                  and munch.household_role(s.household_id) in ('owner', 'member')
              )
          )
          and not exists (
              select 1
              from munch.inventory_events r
              where r.reversal_of_event_id = e.id
          )
        order by e.created_at asc, e.id asc
    `;

    const restoredItemIds: string[] = [];
    let reversedEventCount = 0;

    for (const event of events) {
        const itemRows = await tx<LockedItemRow[]>`
            select id, quantity, unit, stock_state, deleted_at
            from munch.inventory_items
            where id = ${event.inventory_item_id}
              and inventory_space_id = ${event.inventory_space_id}
            limit 1
            for update
        `;
        const item = itemRows[0];
        if (!item || item.deleted_at != null) continue;

        const rawDelta =
            event.delta_quantity == null
                ? null
                : Math.abs(Number(event.delta_quantity));
        const restoreDelta =
            rawDelta != null && Number.isFinite(rawDelta) && rawDelta > 0
                ? round3(rawDelta)
                : null;
        const currentQuantity =
            item.quantity == null ? null : Number(item.quantity);

        let nextQuantity: number | null = currentQuantity;
        let nextStockState = item.stock_state;

        if (currentQuantity != null && restoreDelta != null) {
            nextQuantity = round3(currentQuantity + restoreDelta);
            // Satisfies inventory_items_depleted_quantity CHECK constraint
            // (depleted requires quantity IS NULL OR quantity = 0).
            if (nextStockState === "depleted" && nextQuantity > 0) {
                nextStockState = "available";
            }
        } else if (
            event.event_type === "consume_all" &&
            nextStockState === "depleted"
        ) {
            // Presence-only item depleted by consume_all -> restore availability.
            nextStockState = "available";
        }

        const sourceKey = `reverse:meal:${mealId}:${event.id}`.slice(0, 255);
        const inserted = await tx<Array<{ id: string }>>`
            insert into munch.inventory_events (
                inventory_space_id,
                inventory_item_id,
                event_type,
                delta_quantity,
                quantity_after,
                unit,
                source_type,
                source_entity_id,
                source_key,
                confidence,
                actor_user_id,
                reversal_of_event_id,
                metadata
            ) values (
                ${event.inventory_space_id},
                ${event.inventory_item_id},
                'reverse',
                ${restoreDelta},
                ${nextQuantity},
                ${item.unit ?? event.unit},
                ${event.source_type},
                ${mealId},
                ${sourceKey},
                1,
                ${userId},
                ${event.id},
                jsonb_build_object('reason', 'meal_deleted', 'reversed_event_type', ${event.event_type}::text)
            )
            on conflict (inventory_space_id, source_key)
                where source_key is not null
            do nothing
            returning id
        `;
        if (!inserted[0]) continue;

        await tx`
            update munch.inventory_items
            set quantity = ${nextQuantity},
                stock_state = ${nextStockState},
                updated_by_user_id = ${userId},
                updated_at = now(),
                version = version + 1
            where id = ${item.id}
              and inventory_space_id = ${event.inventory_space_id}
        `;

        reversedEventCount++;
        restoredItemIds.push(item.id);
    }

    return { reversedEventCount, restoredItemIds };
}
