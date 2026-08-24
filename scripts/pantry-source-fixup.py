from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected patch marker missing in {path}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


repository = Path("src/inventory/repository.ts")
text = repository.read_text()

# Keep event metadata an actual JSON object. Bun binding a stringified object and
# then casting it to jsonb produces a JSON string, which correctly violates the
# ledger's jsonb_typeof(metadata) = 'object' invariant.
if '${JSON.stringify(input.metadata ?? {})}::jsonb' in text:
    text = text.replace(
        '${JSON.stringify(input.metadata ?? {})}::jsonb',
        'jsonb_build_object()',
        1,
    )

# Receipt corrections may need compatible mass/volume conversion.
if "    convertInventoryQuantity,\n" not in text:
    text = text.replace(
        "    canonicalInventoryUnit,\n    normalizeInventoryName,",
        "    canonicalInventoryUnit,\n    convertInventoryQuantity,\n    normalizeInventoryName,",
        1,
    )

# Never bind an empty JavaScript array to PostgreSQL text[]. Bun serializes an
# empty array as an empty string in this path, which PostgreSQL rejects as a
# malformed array literal. Candidate filtering gets a separate non-empty query.
old_query = '''        const rows = await tx<Array<Record<string, unknown>>>`
            select * from munch.inventory_items
            where inventory_space_id = ${spaceId}
              and deleted_at is null
              and (${input.includeDepleted ?? false} or stock_state <> 'depleted')
              and (${input.location ?? null}::text is null or location = ${input.location ?? null})
              and (${query} = '' or normalized_name like ${`%${query}%`})
              and (
                ${candidates.length === 0}
                or normalized_name = any(${candidates}::text[])
                or exists (
                    select 1 from unnest(${candidates}::text[]) c(name)
                    where normalized_name like '%' || c.name || '%'
                       or c.name like '%' || normalized_name || '%'
                )
              )
            order by case stock_state when 'low' then 0 else 1 end, updated_at desc
            limit ${max}
        `;'''
new_query = '''        const rows =
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
                  `;'''
if old_query in text:
    text = text.replace(old_query, new_query, 1)
elif "candidates.length === 0\n                ? await tx" not in text:
    raise SystemExit("Pantry candidate query marker missing")

# Resolve one timestamp once for the whole receipt batch.
old_batch = '        const batchRows = await tx<Array<{ id: string }>>`'
new_batch = '''        const purchasedAt = input.purchasedAt ?? new Date().toISOString();
        if (Number.isNaN(new Date(purchasedAt).getTime())) {
            throw new Error("Purchase timestamp is invalid");
        }
        const batchRows = await tx<Array<{ id: string }>>`'''
if old_batch in text and "const purchasedAt = input.purchasedAt" not in text:
    text = text.replace(old_batch, new_batch, 1)
text = text.replace(
    '${input.purchasedAt ?? new Date().toISOString()}, \'applied\', ${input.userId}',
    "${purchasedAt}, 'applied', ${input.userId}",
    1,
)

# Reconcile both unpurchased Grocery rows and recently checked-off rows. For an
# unchecked row, update its quantity before setting purchased_at so the Grocery
# trigger acquires the receipt's actual amount. For an already checked row,
# correct only the difference from the original acquisition event.
start_token = '            } else if (isFood) {\n'
search_from = text.index("export async function reconcilePurchase")
start = text.index(start_token, search_from) + len(start_token)
end_token = '\n            }\n\n            await tx`\n                insert into munch.purchase_reconciliation_lines'
end = text.index(end_token, start)
replacement = r'''                let grocery: Record<string, unknown> | undefined;
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
                            (grocery.unit == null ? null : String(grocery.unit)),
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
                                    prior.unit == null ? null : String(prior.unit),
                                );
                                if (actualQuantity == null) {
                                    action = "needs_review";
                                    needsReview = true;
                                } else {
                                    const delta =
                                        actualQuantity - Number(prior.delta_quantity);
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
                }'''
text = text[:start] + replacement + text[end:]
repository.write_text(text)

smoke = Path("scripts/pantry-platform-smoke.ts")
smoke_text = smoke.read_text()

sugar_marker = '''if (replenishedSugar?.quantity !== 4.5) {
    throw new Error(
        `Grocery checkoff did not replenish Pantry exactly once (got ${replenishedSugar?.quantity})`,
    );
}
'''
if "pantry-smoke-checked-then-receipt" not in smoke_text:
    if sugar_marker not in smoke_text:
        raise SystemExit("Sugar receipt smoke marker missing")
    smoke_text = smoke_text.replace(
        sugar_marker,
        sugar_marker
        + '''
// If the user checks Grocery first and uploads the receipt second, the receipt
// corrects the original acquisition instead of creating a duplicate purchase.
const checkedThenReceipted = await reconcilePurchase({
    userId: owner.userId,
    scope: personalScope,
    idempotencyKey: "pantry-smoke-checked-then-receipt",
    sourceLabel: "Synthetic Market receipt after Grocery checkoff",
    lines: [
        {
            rawLabel: "SUGAR 5 LB",
            name: "Granulated sugar",
            quantity: 5,
            unit: "lb",
            confidence: 0.99,
            isFood: true,
            location: "pantry",
        },
    ],
});
if (
    checkedThenReceipted.summary.groceryMatched !== 1 ||
    checkedThenReceipted.summary.inventoryAdded !== 0
) {
    throw new Error(
        `Checked Grocery receipt did not reconcile in place: ${JSON.stringify(checkedThenReceipted.summary)}`,
    );
}
pantry = await getPantry({ userId: owner.userId, scope: personalScope });
const correctedSugar = pantry.items.find(
    (item) => item.normalized_name === "granulated sugar",
);
if (correctedSugar?.quantity !== 5.5) {
    throw new Error(
        `Receipt correction double-counted or missed the checked Grocery purchase (got ${correctedSugar?.quantity})`,
    );
}
''',
        1,
    )

# The requested Grocery amount is 2; the synthetic receipt proves that an
# unchecked row adopts the actual purchased amount (3) before its trigger fires.
receipt_line = '''            rawLabel: "AVOCADO 2",
            name: "Avocados",
            quantity: 2,
            unit: "count",
            confidence: 0.99,
'''
if receipt_line in smoke_text:
    smoke_text = smoke_text.replace(
        receipt_line,
        '''            rawLabel: "AVOCADO 3",
            name: "Avocados",
            quantity: 3,
            unit: "count",
            confidence: 0.99,
''',
        1,
    )

avocado_marker = '''if (!avocadoGrocery?.purchased_at) {
    throw new Error("Receipt did not mark matching Grocery item purchased");
}
'''
if "Receipt did not preserve the actual purchased Grocery quantity" not in smoke_text:
    if avocado_marker not in smoke_text:
        raise SystemExit("Avocado quantity smoke marker missing")
    smoke_text = smoke_text.replace(
        avocado_marker,
        avocado_marker
        + '''if (avocadoGrocery.quantity !== 3) {
    throw new Error(
        `Receipt did not preserve the actual purchased Grocery quantity (got ${avocadoGrocery.quantity})`,
    );
}
''',
        1,
    )

smoke.write_text(smoke_text)
