-- Expand the canonical event taxonomy without rewriting existing Cooks or updates.
-- Mirrors src/cooks/event-contract.ts. The fresh-schema CI job applies this
-- migration against PostgreSQL and exercises all supported event types.
alter table munch.cook_events drop constraint if exists cook_events_type;
alter table munch.cook_events
    add constraint cook_events_type check (
        event_type in (
            'preparation', 'season', 'marinate', 'preheat', 'food_on',
            'temperature_change', 'wrap', 'unwrap', 'sauce', 'spritz',
            'turn', 'reposition', 'equipment_adjustment', 'remove',
            'rest', 'taste', 'note', 'correction', 'custom'
        )
    );

-- Preserve the exact prior row on every successful optimistic correction.
-- Source cook_updates remain immutable; active cook_events stay simple to read.
create table munch.cook_event_revisions (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references munch.cook_events(id) on delete cascade,
    cook_id uuid not null references munch.cooks(id) on delete cascade,
    prior_version integer not null check (prior_version > 0),
    snapshot jsonb not null,
    changed_by_user_id uuid references munch.users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint cook_event_revisions_snapshot_object
        check (jsonb_typeof(snapshot) = 'object'),
    constraint cook_event_revisions_version_unique unique (event_id, prior_version)
);
create index cook_event_revisions_cook_idx
    on munch.cook_event_revisions (cook_id, event_id, created_at);

alter table munch.cook_event_revisions enable row level security;
alter table munch.cook_event_revisions force row level security;
create policy cook_event_revisions_app_read on munch.cook_event_revisions
    for select to munch_app using (
        exists (select 1 from munch.cooks cook where cook.id = cook_id and (
            cook.personal_owner_user_id = munch.current_user_id()
            or (cook.household_id is not null and munch.household_role(cook.household_id) is not null)
        ))
    );
create policy cook_event_revisions_app_write on munch.cook_event_revisions
    for all to munch_app using (
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
create policy cook_event_revisions_auth_all on munch.cook_event_revisions
    for all to munch_auth using (true) with check (true);
grant select, insert, update, delete on munch.cook_event_revisions
    to munch_app, munch_auth;
comment on table munch.cook_event_revisions is
    'Immutable pre-correction event snapshots; source cook_updates are preserved separately.';

-- Unknown is an unknown instant, not the time the user submitted the note.
alter table munch.cook_events alter column event_at drop not null;
