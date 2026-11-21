-- Grocery check-off food gate for Pantry auto-acquisition (W2 Pantry, Finding 8).
-- Adds an explicit `is_food` column to munch.grocery_items (default true so all
-- existing manual/recipe/plan food rows stay eligible) and gates
-- munch.acquire_inventory_from_grocery_purchase() through a deterministic
-- food-signal helper so non-food household items checked off a grocery list
-- never stock the food Pantry. Numbered 0049 (not 0048) because the W2
-- data-integrity cluster claims 0048 for its index; schema_updates.version
-- is a primary key, so two updates must never share a number.
-- Defensive: `add column if not exists` + `create or replace function` make
-- this safe on fresh databases and on production (where 0042 has run), and
-- safe to re-run. Existing non-food rows already in munch.inventory_items
-- are intentionally NOT deleted — this only prevents new acquisitions.

alter table munch.grocery_items
    add column if not exists is_food boolean not null default true;

create or replace function munch.grocery_item_is_pantry_food(
    p_is_food boolean,
    p_normalized_name text,
    p_food_provider text,
    p_provider_food_id text,
    p_source_recipe_id uuid,
    p_source_planned_meal_id uuid
)
returns boolean
language plpgsql
immutable
as $$
declare
    v_name text := lower(btrim(coalesce(p_normalized_name, '')));
begin
    -- 1. Explicit non-food flag always vetoes Pantry acquisition.
    if not coalesce(p_is_food, true) then
        return false;
    end if;

    -- 2. Resolved food identity or recipe/meal-plan provenance is food.
    if p_provider_food_id is not null
        or p_source_recipe_id is not null
        or p_source_planned_meal_id is not null
    then
        return true;
    end if;

    if v_name = '' then
        return false;
    end if;

    -- 3. Free-text manual items: reject clear non-food household, cleaning,
    --    disposable, personal-care, baby, OTC, hardware, and pet supplies.
    --    Every pattern uses word boundaries (\m...\M) and avoids food collisions
    --    (e.g. tomato paste, sour cream, rice paper, chicken wrap, sponge cake,
    --    unbleached flour, cooking spray, baking powder, tea bags, pad thai,
    --    granola bar, hot dogs).
    if v_name ~* (
        '\m(sanitizer|soap|detergent|bleach|disinfectant|wipes?|lysol|clorox|febreze|swiffer|kleenex)\M'
        || '|\m(shampoo|conditioner|deodorant|antiperspirant|lotion|sunscreen|chapstick|lip\s+balm|mouthwash|toothbrush|dental\s+floss|diapers?|tampons?|razors?|band\s*aids?|bandages?|q\s*tips?|cotton\s+(balls?|swabs?)|ointment)\M'
        || '|\m(butt|diaper|tooth)\s*paste\M'
        || '|\m(diaper|rash|shaving|hand|body|face|moisturizing|hydrocortisone|antibiotic)\s+cream\M'
        || '|\m(sanitary|maxi|nursing|scouring|brillo|swiffer|mop)\s+pads?\M'
        || '|\m(gallon|quart|sandwich|freezer|storage|trash|garbage|ziploc|ziplock|zip\s+lock|clear|plastic|vacuum|poop|waste)\M.*\mbags?\M'
        || '|\m(ziploc|ziplock)\M'
        || '|\m(toilet|tissue|parchment|wax|butcher)\s+paper\M'
        || '|\mpaper\s+(towels?|plates?|cups?|napkins?)\M'
        || '|\m(napkins?|facial\s+tissues?|coffee\s+filters?|dryer\s+sheets?|fabric\s+softener|stain\s+remover|air\s+freshener|steel\s+wool)\M'
        || '|\m(aluminum|tin)\s+foil\M'
        || '|\m(plastic|saran|cling|bubble)\s+wrap\M'
        || '|\m(dish(washer|washing)?|laundry)\s+(pods?|tabs?|tablets?|liquid|detergent|soap|sheets?)\M'
        || '|\m(glass|surface|floor|toilet|drain|oven|bathroom|all\s+purpose)\s+cleaner\M'
        || '|\m(kitchen|dish|scrub|scrubbing|cleaning)\s+sponges?\M|^sponges?$'
        || '|\m(bug|insect|cleaning|disinfectant|deodorant|hair|room|fabric)\s+spray\M'
        || '|\m(baby|talcum|laundry|scouring)\s+powder\M'
        || '|\m(batter(y|ies)|light\s*bulbs?|candles?|charcoal|propane|firewood|cat\s+litter|kitty\s+litter)\M'
        || '|\m(dog|cat|pet)\s+(food|treats?)\M'
        || '|\m(ibuprofen|acetaminophen|tylenol|advil|aspirin|contact\s+solution|eye\s+drops?)\M'
    ) then
        return false;
    end if;

    return true;
end
$$;

grant execute on function munch.grocery_item_is_pantry_food(
    boolean, text, text, text, uuid, uuid
) to munch_app, munch_auth;

-- Body byte-identical to db/updates/0042_pantry_module_gate.sql, adding ONLY
-- the food-gate check immediately after the pantry-module gate.
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

    if not munch.grocery_item_is_pantry_food(
        new.is_food,
        new.normalized_name,
        new.food_provider,
        new.provider_food_id,
        new.source_recipe_id,
        new.source_planned_meal_id
    ) then
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
