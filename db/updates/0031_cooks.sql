-- Persistent cooking-session history. Cooks are independent from meals,
-- nutrition, pantry usage, and mutable recipe identities.

create table munch.cooks (
    id uuid primary key default gen_random_uuid(),
    personal_owner_user_id uuid references munch.users(id) on delete cascade,
    household_id uuid references munch.households(id) on delete cascade,
    title text not null,
    status text not null default 'active',
    cook_date date not null,
    timezone text not null default 'UTC',
    started_at timestamptz,
    finished_at timestamptz,
    notes text,
    setup_snapshot jsonb not null default '{}'::jsonb,
    source_cook_id uuid references munch.cooks(id) on delete set null,
    original_message text,
    idempotency_key text,
    version integer not null default 1,
    created_by_user_id uuid references munch.users(id) on delete set null,
    updated_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cooks_exactly_one_owner check (
        (personal_owner_user_id is not null)::integer +
        (household_id is not null)::integer = 1
    ),
    constraint cooks_title_nonempty check (length(btrim(title)) between 1 and 200),
    constraint cooks_status check (status in ('active', 'finished')),
    constraint cooks_timezone_nonempty check (length(btrim(timezone)) between 1 and 100),
    constraint cooks_notes_length check (notes is null or length(notes) <= 20000),
    constraint cooks_setup_snapshot_object check (jsonb_typeof(setup_snapshot) = 'object'),
    constraint cooks_version_positive check (version > 0)
);

create unique index cooks_personal_idempotency_unique
    on munch.cooks (personal_owner_user_id, idempotency_key)
    where personal_owner_user_id is not null and idempotency_key is not null;
create unique index cooks_household_idempotency_unique
    on munch.cooks (household_id, idempotency_key)
    where household_id is not null and idempotency_key is not null;
create index cooks_personal_recent_idx
    on munch.cooks (personal_owner_user_id, cook_date desc, updated_at desc);
create index cooks_household_recent_idx
    on munch.cooks (household_id, cook_date desc, updated_at desc);
create index cooks_status_idx on munch.cooks (status, cook_date desc);
create index cooks_title_search_idx on munch.cooks using gin (to_tsvector('simple', title));

create table munch.cook_dishes (
    id uuid primary key default gen_random_uuid(),
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    position integer not null,
    name text not null,
    ingredient_or_cut text,
    method text,
    flavor text,
    equipment text,
    notes text,
    actual_ingredients jsonb not null default '[]'::jsonb,
    recipe_id uuid references munch.recipes(id) on delete set null,
    recipe_revision_id uuid references munch.recipe_revisions(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cook_dishes_position_nonnegative check (position >= 0),
    constraint cook_dishes_name_nonempty check (length(btrim(name)) between 1 and 200),
    constraint cook_dishes_notes_length check (notes is null or length(notes) <= 20000),
    constraint cook_dishes_actual_ingredients_array check (jsonb_typeof(actual_ingredients) = 'array'),
    constraint cook_dishes_recipe_pair check (
        (recipe_id is null and recipe_revision_id is null)
        or (recipe_id is not null and recipe_revision_id is not null)
    ),
    constraint cook_dishes_unique_position unique (cook_id, position)
);

create index cook_dishes_cook_idx on munch.cook_dishes (cook_id, position);
create index cook_dishes_search_idx on munch.cook_dishes using gin (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(ingredient_or_cut, '') || ' ' ||
    coalesce(method, '') || ' ' || coalesce(flavor, '') || ' ' || coalesce(equipment, ''))
);

create table munch.cook_updates (
    id uuid primary key default gen_random_uuid(),
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    dish_id uuid references munch.cook_dishes(id) on delete set null,
    source text not null,
    raw_message text not null,
    submitted_at timestamptz not null default now(),
    submitted_timezone text not null default 'UTC',
    media_status text not null default 'none',
    media_error text,
    idempotency_key text,
    created_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint cook_updates_source check (source in ('website', 'mcp')),
    constraint cook_updates_message_length check (length(raw_message) between 1 and 20000),
    constraint cook_updates_timezone_nonempty check (length(btrim(submitted_timezone)) between 1 and 100),
    constraint cook_updates_media_status check (media_status in ('none', 'saved', 'failed'))
);

create unique index cook_updates_idempotency_unique
    on munch.cook_updates (cook_id, idempotency_key)
    where idempotency_key is not null;
create index cook_updates_cook_recent_idx on munch.cook_updates (cook_id, submitted_at, id);

create table munch.cook_events (
    id uuid primary key default gen_random_uuid(),
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    update_id uuid references munch.cook_updates(id) on delete set null,
    dish_id uuid references munch.cook_dishes(id) on delete set null,
    event_type text not null,
    event_at timestamptz not null,
    submitted_at timestamptz not null default now(),
    event_timezone text not null default 'UTC',
    time_precision text not null default 'unknown',
    relative_phrase text,
    setpoint_temperature numeric(8, 2),
    setpoint_unit text,
    ambient_temperature numeric(8, 2),
    ambient_unit text,
    internal_temperature numeric(8, 2),
    internal_unit text,
    note text,
    original_message text,
    correction_of_event_id uuid references munch.cook_events(id) on delete set null,
    idempotency_key text,
    version integer not null default 1,
    created_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cook_events_type check (
        event_type in ('preparation', 'preheat', 'food_on', 'temperature_change',
                       'wrap', 'sauce', 'remove', 'rest', 'taste', 'note', 'correction', 'custom')
    ),
    constraint cook_events_precision check (time_precision in ('exact', 'approximate', 'unknown')),
    constraint cook_events_unit_pair_setpoint check (
        (setpoint_temperature is null and setpoint_unit is null)
        or (setpoint_temperature is not null and setpoint_unit in ('F', 'C'))
    ),
    constraint cook_events_unit_pair_ambient check (
        (ambient_temperature is null and ambient_unit is null)
        or (ambient_temperature is not null and ambient_unit in ('F', 'C'))
    ),
    constraint cook_events_unit_pair_internal check (
        (internal_temperature is null and internal_unit is null)
        or (internal_temperature is not null and internal_unit in ('F', 'C'))
    ),
    constraint cook_events_note_length check (note is null or length(note) <= 20000),
    constraint cook_events_version_positive check (version > 0)
);

create unique index cook_events_idempotency_unique
    on munch.cook_events (cook_id, idempotency_key)
    where idempotency_key is not null;
create index cook_events_timeline_idx on munch.cook_events (cook_id, event_at, id);

create table munch.cook_outcomes (
    id uuid primary key default gen_random_uuid(),
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    dish_id uuid references munch.cook_dishes(id) on delete cascade,
    written_feedback text,
    overall_assessment numeric(3, 2),
    characteristics jsonb not null default '{}'::jsonb,
    worked text,
    disappointed text,
    next_time_notes text,
    ai_suggestions jsonb not null default '[]'::jsonb,
    is_preferred boolean not null default false,
    version integer not null default 1,
    created_by_user_id uuid references munch.users(id) on delete set null,
    updated_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cook_outcomes_assessment_range check (
        overall_assessment is null or (overall_assessment >= 1 and overall_assessment <= 5)
    ),
    constraint cook_outcomes_characteristics_object check (jsonb_typeof(characteristics) = 'object'),
    constraint cook_outcomes_suggestions_array check (jsonb_typeof(ai_suggestions) = 'array'),
    constraint cook_outcomes_text_length check (
        (written_feedback is null or length(written_feedback) <= 20000)
        and (worked is null or length(worked) <= 10000)
        and (disappointed is null or length(disappointed) <= 10000)
        and (next_time_notes is null or length(next_time_notes) <= 10000)
    ),
    constraint cook_outcomes_version_positive check (version > 0)
);

create unique index cook_outcomes_cook_dish_unique
    on munch.cook_outcomes (cook_id, (coalesce(dish_id, '00000000-0000-0000-0000-000000000000'::uuid)));
create index cook_outcomes_preferred_idx on munch.cook_outcomes (is_preferred, updated_at desc);

create table munch.cook_media (
    id uuid primary key default gen_random_uuid(),
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    dish_id uuid references munch.cook_dishes(id) on delete set null,
    update_id uuid references munch.cook_updates(id) on delete set null,
    event_id uuid references munch.cook_events(id) on delete set null,
    sha256 text not null,
    mime_type text not null,
    file_name text,
    file_size integer not null,
    bytes bytea not null,
    openai_file_id text,
    caption text,
    created_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint cook_media_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
    constraint cook_media_mime_type check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
    constraint cook_media_file_size check (file_size > 0 and file_size <= 8388608),
    constraint cook_media_file_name_length check (file_name is null or length(file_name) <= 255),
    constraint cook_media_caption_length check (caption is null or length(caption) <= 4000),
    constraint cook_media_has_context check (dish_id is not null or update_id is not null or event_id is not null)
);

create unique index cook_media_hash_unique on munch.cook_media (cook_id, sha256);
create index cook_media_cook_idx on munch.cook_media (cook_id, created_at, id);

alter table munch.cooks enable row level security;
alter table munch.cooks force row level security;
alter table munch.cook_dishes enable row level security;
alter table munch.cook_dishes force row level security;
alter table munch.cook_updates enable row level security;
alter table munch.cook_updates force row level security;
alter table munch.cook_events enable row level security;
alter table munch.cook_events force row level security;
alter table munch.cook_outcomes enable row level security;
alter table munch.cook_outcomes force row level security;
alter table munch.cook_media enable row level security;
alter table munch.cook_media force row level security;

create policy cooks_app_read on munch.cooks for select to munch_app using (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) is not null)
);
create policy cooks_app_insert on munch.cooks for insert to munch_app with check (
    (personal_owner_user_id = munch.current_user_id() and household_id is null)
    or (personal_owner_user_id is null and household_id is not null
        and munch.household_role(household_id) in ('owner', 'member'))
);
create policy cooks_app_update on munch.cooks for update to munch_app using (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
) with check (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
);
create policy cooks_app_delete on munch.cooks for delete to munch_app using (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
);

create policy cook_dishes_app_read on munch.cook_dishes for select to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
    ))
);
create policy cook_dishes_app_write on munch.cook_dishes for all to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
) with check (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
);

create policy cook_updates_app_read on munch.cook_updates for select to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
    ))
);
create policy cook_updates_app_write on munch.cook_updates for all to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
) with check (
    (
        created_by_user_id = munch.current_user_id()
        or exists (select 1 from munch.cooks household_cook where household_cook.id = cook_id
            and household_cook.household_id is not null
            and munch.household_role(household_cook.household_id) in ('owner', 'member'))
    )
    and exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
);

create policy cook_events_app_read on munch.cook_events for select to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
    ))
);
create policy cook_events_app_write on munch.cook_events for all to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
) with check (
    (
        created_by_user_id = munch.current_user_id()
        or exists (select 1 from munch.cooks household_cook where household_cook.id = cook_id
            and household_cook.household_id is not null
            and munch.household_role(household_cook.household_id) in ('owner', 'member'))
    )
    and exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
);

create policy cook_outcomes_app_read on munch.cook_outcomes for select to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
    ))
);
create policy cook_outcomes_app_write on munch.cook_outcomes for all to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
) with check (
    (
        (created_by_user_id = munch.current_user_id()
         and updated_by_user_id = munch.current_user_id())
        or exists (select 1 from munch.cooks household_cook where household_cook.id = cook_id
            and household_cook.household_id is not null
            and munch.household_role(household_cook.household_id) in ('owner', 'member'))
    )
    and exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
);

create policy cook_media_app_read on munch.cook_media for select to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
    ))
);
create policy cook_media_app_write on munch.cook_media for all to munch_app using (
    exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
) with check (
    (
        created_by_user_id = munch.current_user_id()
        or exists (select 1 from munch.cooks household_cook where household_cook.id = cook_id
            and household_cook.household_id is not null
            and munch.household_role(household_cook.household_id) in ('owner', 'member'))
    )
    and exists (select 1 from munch.cooks cook where cook.id = cook_id and (
        cook.personal_owner_user_id = munch.current_user_id()
        or (cook.household_id is not null and munch.household_role(cook.household_id) in ('owner', 'member'))
    ))
);

create policy cooks_auth_all on munch.cooks for all to munch_auth using (true) with check (true);
create policy cook_dishes_auth_all on munch.cook_dishes for all to munch_auth using (true) with check (true);
create policy cook_updates_auth_all on munch.cook_updates for all to munch_auth using (true) with check (true);
create policy cook_events_auth_all on munch.cook_events for all to munch_auth using (true) with check (true);
create policy cook_outcomes_auth_all on munch.cook_outcomes for all to munch_auth using (true) with check (true);
create policy cook_media_auth_all on munch.cook_media for all to munch_auth using (true) with check (true);

grant select, insert, update, delete on
    munch.cooks, munch.cook_dishes, munch.cook_updates, munch.cook_events,
    munch.cook_outcomes, munch.cook_media
    to munch_app, munch_auth;

comment on table munch.cooks is 'Persistent cooking occasions, independent of nutrition logs and mutable recipe identities.';
comment on table munch.cook_dishes is 'Actual dishes and optional exact recipe-revision links belonging to one cook.';
comment on table munch.cook_updates is 'Original website or MCP submissions retained for audit and retry-safe updates.';
comment on table munch.cook_events is 'Editable cook timeline with event time separated from submission time and distinct temperature readings.';
comment on table munch.cook_outcomes is 'User-authored results and next-attempt notes, separate from AI suggestions.';
comment on table munch.cook_media is 'Durable user-provided cook photos stored as bytes, not expiring source URLs.';
