-- Pantry enablement moves to the feature-module flag (2026-11-11).
-- The grocery-checkoff trigger that auto-acquires purchased items
-- into Pantry was the last gate still reading the legacy
-- account_preferences.pantry_enabled switch. It now reads
-- feature_pantry_enabled (migration 0039) with the feature-modules
-- contract's semantics: a missing preferences row reads as ON.
-- The legacy column is retired, not dropped. Everything else in the
-- function is byte-identical to its definition in 0025.

create or replace function munch.acquire_inventory_from_grocery_purchase()
returns trigger
language plpgsql
as $$
declare
    pantry_module_enabled boolean := true;
    personal_owner uuid;
    household_owner uuid;
    space_id uuid;
    item_id uuid;
    current_quantity numeric(14,3);
    current_mode text;
    next_quantity numeric(14,3);
    next_mode text;
    event_key text;
begin
    if old.purchased_at is not null or new.purchased_at is null or new.purchased_by_user_id is null then
        return new;
    end if;

    pantry_module_enabled := coalesce(
        (select p.feature_pantry_enabled
           from munch.account_preferences p
          where p.user_id = new.purchased_by_user_id),
        true
    );
    if not pantry_module_enabled then
        return new;
    end if;

    select l.personal_owner_user_id, l.household_id
      into personal_owner, household_owner
      from munch.grocery_lists l
     where l.id = new.grocery_list_id and l.status = 'active';
    if personal_owner is null and household_owner is null then
        return new;
    end if;

    if personal_owner is not null then
        insert into munch.inventory_spaces (personal_owner_user_id, household_id, created_by_user_id)
        values (personal_owner, null, new.purchased_by_user_id)
        on conflict (personal_owner_user_id) where personal_owner_user_id is not null
        do update set updated_at = now(), version = munch.inventory_spaces.version + 1
        returning id into space_id;
    else
        insert into munch.inventory_spaces (personal_owner_user_id, household_id, created_by_user_id)
        values (null, household_owner, new.purchased_by_user_id)
        on conflict (household_id) where household_id is not null
        do update set updated_at = now(), version = munch.inventory_spaces.version + 1
        returning id into space_id;
    end if;

    if new.provider_food_id is not null then
        select i.id, i.quantity, i.quantity_mode
          into item_id, current_quantity, current_mode
          from munch.inventory_items i
         where i.inventory_space_id = space_id
           and i.deleted_at is null
           and i.food_provider is not distinct from new.food_provider
           and i.provider_food_id = new.provider_food_id
           and i.unit is not distinct from new.unit
         order by i.created_at
         limit 1
         for update;
    else
        select i.id, i.quantity, i.quantity_mode
          into item_id, current_quantity, current_mode
          from munch.inventory_items i
         where i.inventory_space_id = space_id
           and i.deleted_at is null
           and i.normalized_name = new.normalized_name
           and i.unit is not distinct from new.unit
         order by i.created_at
         limit 1
         for update;
    end if;

    if item_id is null then
        insert into munch.inventory_items (
            inventory_space_id, name, normalized_name, quantity, unit,
            quantity_mode, stock_state, location, food_provider, provider_food_id,
            created_by_user_id, updated_by_user_id
        ) values (
            space_id, new.name, new.normalized_name, new.quantity, new.unit,
            case when new.quantity is null then 'presence_only' else 'exact' end,
            'available', 'unspecified', new.food_provider, new.provider_food_id,
            new.purchased_by_user_id, new.purchased_by_user_id
        ) returning id, quantity, quantity_mode into item_id, next_quantity, next_mode;
    else
        if new.quantity is null then
            next_quantity := current_quantity;
            next_mode := case when current_quantity is null then 'presence_only' else current_mode end;
        elsif current_quantity is null then
            next_quantity := new.quantity;
            next_mode := 'approximate';
        else
            next_quantity := current_quantity + new.quantity;
            next_mode := case when current_mode = 'exact' then 'exact' else 'approximate' end;
        end if;
        update munch.inventory_items
           set quantity = next_quantity,
               quantity_mode = next_mode,
               stock_state = 'available',
               updated_by_user_id = new.purchased_by_user_id,
               updated_at = now(),
               version = version + 1
         where id = item_id;
    end if;

    event_key := 'grocery:' || new.id::text || ':v' || new.version::text;
    insert into munch.inventory_events (
        inventory_space_id, inventory_item_id, event_type,
        delta_quantity, quantity_after, unit, source_type,
        source_entity_id, source_key, confidence, actor_user_id,
        metadata
    ) values (
        space_id, item_id, 'acquire', new.quantity, next_quantity, new.unit,
        'grocery_purchase', new.id, event_key, 1, new.purchased_by_user_id,
        jsonb_build_object('grocery_item_id', new.id)
    ) on conflict (inventory_space_id, source_key) where source_key is not null do nothing;

    return new;
end
$$;
