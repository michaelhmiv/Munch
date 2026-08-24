-- Premium Pantry / Inventory domain.
-- Pantry is intentionally separate from grocery intent and saved-food identity.

alter table munch.account_preferences
    add column if not exists pantry_enabled boolean not null default false;

create table if not exists munch.inventory_spaces (
    id uuid primary key default gen_random_uuid(),
    personal_owner_user_id uuid references munch.users(id) on delete cascade,
    household_id uuid references munch.households(id) on delete cascade,
    created_by_user_id uuid not null references munch.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    version integer not null default 1,
    constraint inventory_spaces_exactly_one_owner check (
        (personal_owner_user_id is not null)::integer +
        (household_id is not null)::integer = 1
    ),
    constraint inventory_spaces_version_positive check (version > 0)
);

create unique index if not exists inventory_spaces_personal_unique
    on munch.inventory_spaces (personal_owner_user_id)
    where personal_owner_user_id is not null;
create unique index if not exists inventory_spaces_household_unique
    on munch.inventory_spaces (household_id)
    where household_id is not null;

create table if not exists munch.inventory_items (
    id uuid primary key default gen_random_uuid(),
    inventory_space_id uuid not null references munch.inventory_spaces(id) on delete cascade,
    name text not null,
    normalized_name text not null,
    quantity numeric(14, 3),
    unit text,
    quantity_mode text not null default 'presence_only',
    stock_state text not null default 'available',
    location text not null default 'unspecified',
    food_provider text,
    provider_food_id text,
    barcode text,
    note text,
    created_by_user_id uuid not null references munch.users(id) on delete restrict,
    updated_by_user_id uuid not null references munch.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    version integer not null default 1,
    constraint inventory_items_name_nonempty check (length(btrim(name)) between 1 and 300),
    constraint inventory_items_normalized_nonempty check (length(btrim(normalized_name)) between 1 and 300),
    constraint inventory_items_quantity_nonnegative check (quantity is null or quantity >= 0),
    constraint inventory_items_quantity_mode check (quantity_mode in ('exact', 'approximate', 'presence_only')),
    constraint inventory_items_stock_state check (stock_state in ('available', 'low', 'depleted')),
    constraint inventory_items_location check (location in ('pantry', 'fridge', 'freezer', 'unspecified')),
    constraint inventory_items_version_positive check (version > 0),
    constraint inventory_items_depleted_quantity check (stock_state <> 'depleted' or quantity is null or quantity = 0)
);

create index if not exists inventory_items_space_active_idx
    on munch.inventory_items (inventory_space_id, stock_state, location, normalized_name)
    where deleted_at is null;
create index if not exists inventory_items_provider_idx
    on munch.inventory_items (inventory_space_id, food_provider, provider_food_id)
    where deleted_at is null and provider_food_id is not null;
create index if not exists inventory_items_barcode_idx
    on munch.inventory_items (inventory_space_id, barcode)
    where deleted_at is null and barcode is not null;

create table if not exists munch.inventory_events (
    id uuid primary key default gen_random_uuid(),
    inventory_space_id uuid not null references munch.inventory_spaces(id) on delete cascade,
    inventory_item_id uuid not null references munch.inventory_items(id) on delete cascade,
    event_type text not null,
    delta_quantity numeric(14, 3),
    quantity_after numeric(14, 3),
    unit text,
    source_type text not null,
    source_entity_id uuid,
    source_key text,
    confidence numeric(5, 4),
    metadata jsonb not null default '{}'::jsonb,
    actor_user_id uuid not null references munch.users(id) on delete restrict,
    reversal_of_event_id uuid references munch.inventory_events(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint inventory_events_type check (event_type in (
        'acquire', 'consume', 'consume_all', 'correct', 'discard',
        'mark_low', 'mark_depleted', 'move', 'reverse'
    )),
    constraint inventory_events_source_type check (source_type in (
        'manual', 'grocery_purchase', 'receipt', 'pantry_scan',
        'meal_reconciliation', 'recipe_preparation', 'correction'
    )),
    constraint inventory_events_confidence check (confidence is null or confidence between 0 and 1),
    constraint inventory_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists inventory_events_source_key_unique
    on munch.inventory_events (inventory_space_id, source_key)
    where source_key is not null;
create index if not exists inventory_events_item_created_idx
    on munch.inventory_events (inventory_item_id, created_at desc);

create table if not exists munch.purchase_reconciliations (
    id uuid primary key default gen_random_uuid(),
    inventory_space_id uuid not null references munch.inventory_spaces(id) on delete cascade,
    idempotency_key text not null,
    source_type text not null,
    source_label text,
    purchased_at timestamptz not null default now(),
    status text not null default 'applied',
    created_by_user_id uuid not null references munch.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    constraint purchase_reconciliations_source_type check (source_type in ('receipt', 'manual')),
    constraint purchase_reconciliations_status check (status in ('applied', 'needs_review')),
    constraint purchase_reconciliations_idempotency_nonempty check (length(btrim(idempotency_key)) between 1 and 255),
    unique (inventory_space_id, idempotency_key)
);

create table if not exists munch.purchase_reconciliation_lines (
    id uuid primary key default gen_random_uuid(),
    purchase_reconciliation_id uuid not null references munch.purchase_reconciliations(id) on delete cascade,
    position integer not null,
    raw_label text,
    resolved_name text not null,
    normalized_name text not null,
    quantity numeric(14, 3),
    unit text,
    food_provider text,
    provider_food_id text,
    confidence numeric(5, 4),
    is_food boolean not null default true,
    confirmed boolean not null default false,
    action text not null,
    grocery_item_id uuid references munch.grocery_items(id) on delete set null,
    inventory_item_id uuid references munch.inventory_items(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint purchase_reconciliation_lines_position_nonnegative check (position >= 0),
    constraint purchase_reconciliation_lines_quantity_positive check (quantity is null or quantity > 0),
    constraint purchase_reconciliation_lines_confidence check (confidence is null or confidence between 0 and 1),
    constraint purchase_reconciliation_lines_action check (action in ('grocery_matched', 'inventory_added', 'ignored_non_food', 'needs_review')),
    unique (purchase_reconciliation_id, position)
);

-- Grocery checkoff is strong acquisition evidence. The trigger is deliberately
-- preference-gated; accounts that never enable Pantry keep existing behavior.
create or replace function munch.acquire_inventory_from_grocery_purchase()
returns trigger
language plpgsql
as $$
declare
    pantry_enabled boolean := false;
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

    select coalesce(p.pantry_enabled, false)
      into pantry_enabled
      from munch.account_preferences p
     where p.user_id = new.purchased_by_user_id;
    if not pantry_enabled then
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

drop trigger if exists grocery_purchase_inventory_trigger on munch.grocery_items;
create trigger grocery_purchase_inventory_trigger
after update of purchased_at on munch.grocery_items
for each row execute function munch.acquire_inventory_from_grocery_purchase();

alter table munch.inventory_spaces enable row level security;
alter table munch.inventory_spaces force row level security;
alter table munch.inventory_items enable row level security;
alter table munch.inventory_items force row level security;
alter table munch.inventory_events enable row level security;
alter table munch.inventory_events force row level security;
alter table munch.purchase_reconciliations enable row level security;
alter table munch.purchase_reconciliations force row level security;
alter table munch.purchase_reconciliation_lines enable row level security;
alter table munch.purchase_reconciliation_lines force row level security;

do $$
begin
    if not exists (select 1 from pg_policies where schemaname='munch' and tablename='inventory_spaces' and policyname='inventory_spaces_app_all') then
        create policy inventory_spaces_app_all on munch.inventory_spaces for all to munch_app
        using (
            personal_owner_user_id = munch.current_user_id()
            or (household_id is not null and munch.household_role(household_id) is not null)
        )
        with check (
            personal_owner_user_id = munch.current_user_id()
            or (household_id is not null and munch.household_role(household_id) in ('owner','member'))
        );
    end if;
    if not exists (select 1 from pg_policies where schemaname='munch' and tablename='inventory_items' and policyname='inventory_items_app_all') then
        create policy inventory_items_app_all on munch.inventory_items for all to munch_app
        using (exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) is not null))
        ))
        with check (exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) in ('owner','member')))
        ));
    end if;
    if not exists (select 1 from pg_policies where schemaname='munch' and tablename='inventory_events' and policyname='inventory_events_app_all') then
        create policy inventory_events_app_all on munch.inventory_events for all to munch_app
        using (exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) is not null))
        ))
        with check (actor_user_id = munch.current_user_id() and exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) in ('owner','member')))
        ));
    end if;
    if not exists (select 1 from pg_policies where schemaname='munch' and tablename='purchase_reconciliations' and policyname='purchase_reconciliations_app_all') then
        create policy purchase_reconciliations_app_all on munch.purchase_reconciliations for all to munch_app
        using (exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) is not null))
        ))
        with check (created_by_user_id = munch.current_user_id() and exists (
            select 1 from munch.inventory_spaces s where s.id = inventory_space_id
            and (s.personal_owner_user_id = munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) in ('owner','member')))
        ));
    end if;
    if not exists (select 1 from pg_policies where schemaname='munch' and tablename='purchase_reconciliation_lines' and policyname='purchase_reconciliation_lines_app_all') then
        create policy purchase_reconciliation_lines_app_all on munch.purchase_reconciliation_lines for all to munch_app
        using (exists (
            select 1 from munch.purchase_reconciliations p join munch.inventory_spaces s on s.id=p.inventory_space_id
            where p.id=purchase_reconciliation_id and (s.personal_owner_user_id=munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) is not null))
        ))
        with check (exists (
            select 1 from munch.purchase_reconciliations p join munch.inventory_spaces s on s.id=p.inventory_space_id
            where p.id=purchase_reconciliation_id and (s.personal_owner_user_id=munch.current_user_id() or (s.household_id is not null and munch.household_role(s.household_id) in ('owner','member')))
        ));
    end if;
end
$$;

grant select, insert, update, delete on
    munch.inventory_spaces,
    munch.inventory_items,
    munch.inventory_events,
    munch.purchase_reconciliations,
    munch.purchase_reconciliation_lines
    to munch_app, munch_auth;

grant select, insert, update on munch.account_preferences to munch_app, munch_auth;

comment on table munch.inventory_spaces is 'Personal or household Pantry ownership scope; premium feature state lives in account_preferences';
comment on table munch.inventory_items is 'Materialized current Pantry/Fridge/Freezer inventory state; separate from grocery intent and saved foods';
comment on table munch.inventory_events is 'Append-only Pantry mutation ledger for acquisition, consumption, correction, movement, and reversal provenance';
comment on table munch.purchase_reconciliations is 'Idempotent shopping acquisition batches such as receipt reconciliation; raw receipt media is never stored';
