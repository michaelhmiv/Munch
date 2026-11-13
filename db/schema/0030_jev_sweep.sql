-- Jev stored-data sweep (accountability audit §3): findings produced by
-- the retrospective sweep + its incremental watermark.
--
-- Findings are user-facing accountability records: `recipe_healed`
-- (a resolver-defect recipe healed as a NEW revision; before/after
-- per-serving totals ride in the payload), `recipe_flagged` (confirmed
-- implausible but not auto-healable — provider-data class), and
-- `meal_check` (a logged-meal item the user is asked to check; logged
-- meals are NEVER rewritten by the sweep, corrections are
-- user-confirmed only). The provenance surface reads a user's own
-- findings; the sweep job writes them through the platform role.
-- Payloads carry food names, numbers and revision IDs only — no new
-- data category.

create table munch.jev_sweep_findings (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    kind text not null,
    recipe_id uuid references munch.recipes(id) on delete cascade,
    meal_id uuid references munch.meals(id) on delete cascade,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    acknowledged_at timestamptz,
    constraint jev_sweep_findings_kind check (
        kind in ('recipe_healed', 'recipe_flagged', 'meal_check')
    ),
    constraint jev_sweep_findings_payload_object check (
        jsonb_typeof(payload) = 'object'
    )
);

create index jev_sweep_findings_user_recent_idx
    on munch.jev_sweep_findings (user_id, created_at desc)
    where acknowledged_at is null;

alter table munch.jev_sweep_findings enable row level security;
alter table munch.jev_sweep_findings force row level security;

create policy jev_sweep_findings_app_read on munch.jev_sweep_findings
    for select to munch_app using (user_id = munch.current_user_id());
create policy jev_sweep_findings_app_acknowledge on munch.jev_sweep_findings
    for update to munch_app
    using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());

-- Sweep cadence state (platform-role only; not user data). One row:
-- the incremental watermark = the moment the last completed
-- incremental sweep started scanning.
create table munch.jev_sweep_state (
    id integer primary key default 1,
    watermark timestamptz,
    updated_at timestamptz not null default now(),
    constraint jev_sweep_state_singleton check (id = 1)
);

insert into munch.jev_sweep_state (id, watermark) values (1, null)
on conflict (id) do nothing;
