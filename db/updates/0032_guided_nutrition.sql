alter table munch.recipe_revisions
    add column guidance_metadata jsonb not null default '{}'::jsonb;

alter table munch.recipe_revisions
    add constraint recipe_revisions_guidance_metadata_object
    check (jsonb_typeof(guidance_metadata) = 'object');

create table munch.guidance_preferences (
    user_id uuid primary key references munch.users(id) on delete cascade,
    objective text not null default 'track_only',
    suggestions_enabled boolean not null default false,
    profile jsonb not null default '{}'::jsonb,
    version integer not null default 1,
    updated_at timestamptz not null default now(),
    constraint guidance_preferences_objective check (objective in ('maintain', 'gain', 'lose', 'track_only')),
    constraint guidance_preferences_profile_object check (jsonb_typeof(profile) = 'object'),
    constraint guidance_preferences_version check (version > 0)
);

create table munch.guidance_goal_revisions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    revision integer not null,
    objective text not null,
    targets jsonb not null,
    origin text not null,
    confirmed boolean not null default true,
    rationale jsonb not null default '[]'::jsonb,
    proposal_id uuid,
    idempotency_key text,
    created_at timestamptz not null default now(),
    constraint guidance_goal_revisions_number check (revision > 0),
    constraint guidance_goal_revisions_objective check (objective in ('maintain', 'gain', 'lose', 'track_only')),
    constraint guidance_goal_revisions_origin check (origin in ('user', 'website', 'mcp', 'guided_suggestion')),
    constraint guidance_goal_revisions_targets_object check (jsonb_typeof(targets) = 'object'),
    constraint guidance_goal_revisions_rationale_array check (jsonb_typeof(rationale) = 'array'),
    constraint guidance_goal_revisions_unique_number unique (user_id, revision)
);
create unique index guidance_goal_revisions_idempotency_unique
    on munch.guidance_goal_revisions (user_id, idempotency_key)
    where idempotency_key is not null;
create index guidance_goal_revisions_recent_idx
    on munch.guidance_goal_revisions (user_id, created_at desc);

create table munch.guidance_goal_proposals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    expected_revision integer not null default 0,
    proposed_targets jsonb not null,
    rationale jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    idempotency_key text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint guidance_goal_proposals_expected_revision check (expected_revision >= 0),
    constraint guidance_goal_proposals_targets_object check (jsonb_typeof(proposed_targets) = 'object'),
    constraint guidance_goal_proposals_rationale_array check (jsonb_typeof(rationale) = 'array'),
    constraint guidance_goal_proposals_evidence_object check (jsonb_typeof(evidence) = 'object'),
    constraint guidance_goal_proposals_status check (status in ('pending', 'accepted', 'rejected', 'expired'))
);
create unique index guidance_goal_proposals_idempotency_unique
    on munch.guidance_goal_proposals (user_id, idempotency_key)
    where idempotency_key is not null;
create index guidance_goal_proposals_pending_idx
    on munch.guidance_goal_proposals (user_id, expires_at)
    where status = 'pending';

create table munch.guided_plan_drafts (
    id uuid primary key default gen_random_uuid(),
    personal_owner_user_id uuid references munch.users(id) on delete cascade,
    household_id uuid references munch.households(id) on delete cascade,
    created_by_user_id uuid references munch.users(id) on delete set null,
    start_date date not null,
    end_date date not null,
    timezone text not null,
    mode text not null,
    replace_existing boolean not null default false,
    expected_plan_fingerprint text not null,
    request_fingerprint text not null,
    item_count integer not null,
    profile_version integer not null default 0,
    preferences_override jsonb not null default '{}'::jsonb,
    status text not null default 'draft',
    version integer not null default 1,
    idempotency_key text not null,
    commit_id uuid,
    committed_at timestamptz,
    expires_at timestamptz not null default now() + interval '7 days',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint guided_plan_drafts_one_owner check (
        (personal_owner_user_id is not null)::integer + (household_id is not null)::integer = 1
    ),
    constraint guided_plan_drafts_dates check (end_date >= start_date and end_date <= start_date + 6),
    constraint guided_plan_drafts_timezone check (length(btrim(timezone)) between 1 and 100),
    constraint guided_plan_drafts_mode check (mode in ('saved_only', 'generated_only', 'mixed')),
    constraint guided_plan_drafts_status check (status in ('draft', 'committed', 'cancelled', 'expired')),
    constraint guided_plan_drafts_preferences_override_object check (jsonb_typeof(preferences_override) = 'object'),
    constraint guided_plan_drafts_versions check (profile_version >= 0 and version > 0),
    constraint guided_plan_drafts_item_count check (item_count between 1 and 35)
);
create unique index guided_plan_drafts_personal_idempotency_unique
    on munch.guided_plan_drafts (personal_owner_user_id, idempotency_key)
    where personal_owner_user_id is not null;
create unique index guided_plan_drafts_household_idempotency_unique
    on munch.guided_plan_drafts (household_id, idempotency_key)
    where household_id is not null;
create index guided_plan_drafts_recent_idx
    on munch.guided_plan_drafts (created_by_user_id, created_at desc);

create table munch.guided_plan_draft_items (
    id uuid primary key default gen_random_uuid(),
    plan_draft_id uuid not null references munch.guided_plan_drafts(id) on delete cascade,
    position integer not null,
    planned_date date not null,
    meal_slot text not null,
    servings numeric(10, 3) not null,
    source_type text not null,
    recipe_id uuid references munch.recipes(id) on delete cascade,
    recipe_revision_id uuid references munch.recipe_revisions(id) on delete cascade,
    generated_recipe jsonb,
    resolved_recipe jsonb,
    nutrition jsonb not null default '{}'::jsonb,
    nutrition_status text not null default 'unavailable',
    blockers jsonb not null default '[]'::jsonb,
    warnings jsonb not null default '[]'::jsonb,
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint guided_plan_draft_items_position check (position >= 0),
    constraint guided_plan_draft_items_slot check (meal_slot in ('breakfast', 'lunch', 'dinner', 'snack')),
    constraint guided_plan_draft_items_servings check (servings > 0),
    constraint guided_plan_draft_items_recipe_pair check (
        (recipe_id is null and recipe_revision_id is null)
        or (recipe_id is not null and recipe_revision_id is not null)
    ),
    constraint guided_plan_draft_items_source check (
        (source_type = 'saved' and recipe_id is not null and recipe_revision_id is not null and generated_recipe is null)
        or (source_type = 'generated' and generated_recipe is not null and jsonb_typeof(generated_recipe) = 'object'
            and ((recipe_id is null and recipe_revision_id is null) or (recipe_id is not null and recipe_revision_id is not null)))
    ),
    constraint guided_plan_draft_items_type check (source_type in ('saved', 'generated')),
    constraint guided_plan_draft_items_resolved_object check (resolved_recipe is null or jsonb_typeof(resolved_recipe) = 'object'),
    constraint guided_plan_draft_items_nutrition_object check (jsonb_typeof(nutrition) = 'object'),
    constraint guided_plan_draft_items_status check (nutrition_status in ('complete', 'partial', 'unavailable')),
    constraint guided_plan_draft_items_blockers_array check (jsonb_typeof(blockers) = 'array'),
    constraint guided_plan_draft_items_warnings_array check (jsonb_typeof(warnings) = 'array'),
    constraint guided_plan_draft_items_unique_position unique (plan_draft_id, position)
);
create index guided_plan_draft_items_date_idx
    on munch.guided_plan_draft_items (plan_draft_id, planned_date, meal_slot);

create table munch.guided_plan_changes (
    id uuid primary key default gen_random_uuid(),
    planned_meal_id uuid not null references munch.planned_meals(id) on delete cascade,
    user_id uuid not null references munch.users(id) on delete cascade,
    old_recipe_id uuid references munch.recipes(id) on delete set null,
    old_recipe_revision_id uuid references munch.recipe_revisions(id) on delete set null,
    new_recipe_id uuid references munch.recipes(id) on delete set null,
    new_recipe_revision_id uuid references munch.recipe_revisions(id) on delete set null,
    change_type text not null,
    prior_version integer not null,
    after_version integer not null,
    idempotency_key text not null,
    undone_at timestamptz,
    created_at timestamptz not null default now(),
    constraint guided_plan_changes_type check (change_type in ('swap', 'undo', 'replace')),
    constraint guided_plan_changes_versions check (prior_version > 0 and after_version > prior_version)
);
create unique index guided_plan_changes_idempotency_unique
    on munch.guided_plan_changes (user_id, idempotency_key);
create index guided_plan_changes_meal_idx
    on munch.guided_plan_changes (planned_meal_id, created_at desc);

alter table munch.guidance_preferences enable row level security;
alter table munch.guidance_preferences force row level security;
alter table munch.guidance_goal_revisions enable row level security;
alter table munch.guidance_goal_revisions force row level security;
alter table munch.guidance_goal_proposals enable row level security;
alter table munch.guidance_goal_proposals force row level security;
alter table munch.guided_plan_drafts enable row level security;
alter table munch.guided_plan_drafts force row level security;
alter table munch.guided_plan_draft_items enable row level security;
alter table munch.guided_plan_draft_items force row level security;
alter table munch.guided_plan_changes enable row level security;
alter table munch.guided_plan_changes force row level security;

create policy guidance_preferences_app_self on munch.guidance_preferences
    for all to munch_app using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());
create policy guidance_preferences_auth_self on munch.guidance_preferences
    for all to munch_auth using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());

create policy guidance_goal_revisions_app_self on munch.guidance_goal_revisions
    for select to munch_app using (user_id = munch.current_user_id());
create policy guidance_goal_revisions_app_insert on munch.guidance_goal_revisions
    for insert to munch_app with check (user_id = munch.current_user_id());
create policy guidance_goal_revisions_auth_self on munch.guidance_goal_revisions
    for all to munch_auth using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());

create policy guidance_goal_proposals_app_self on munch.guidance_goal_proposals
    for all to munch_app using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());
create policy guidance_goal_proposals_auth_self on munch.guidance_goal_proposals
    for all to munch_auth using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());

create policy guided_plan_drafts_app_read on munch.guided_plan_drafts for select to munch_app using (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) is not null)
);
create policy guided_plan_drafts_app_insert on munch.guided_plan_drafts for insert to munch_app with check (
    created_by_user_id = munch.current_user_id()
    and (
        (personal_owner_user_id = munch.current_user_id() and household_id is null)
        or (personal_owner_user_id is null and household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
    )
);
create policy guided_plan_drafts_app_update on munch.guided_plan_drafts for update to munch_app using (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
) with check (
    personal_owner_user_id = munch.current_user_id()
    or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
);
create policy guided_plan_drafts_auth_self on munch.guided_plan_drafts
    for all to munch_auth using (
        personal_owner_user_id = munch.current_user_id()
        or (household_id is not null and munch.household_role(household_id) is not null)
    ) with check (
        personal_owner_user_id = munch.current_user_id()
        or (household_id is not null and munch.household_role(household_id) in ('owner', 'member'))
    );

create policy guided_plan_draft_items_app_read on munch.guided_plan_draft_items for select to munch_app using (
    exists (
        select 1 from munch.guided_plan_drafts draft
        where draft.id = plan_draft_id
          and (draft.personal_owner_user_id = munch.current_user_id()
               or (draft.household_id is not null and munch.household_role(draft.household_id) is not null))
    )
);
create policy guided_plan_draft_items_app_write on munch.guided_plan_draft_items for all to munch_app using (
    exists (
        select 1 from munch.guided_plan_drafts draft
        where draft.id = plan_draft_id
          and (draft.personal_owner_user_id = munch.current_user_id()
               or (draft.household_id is not null and munch.household_role(draft.household_id) in ('owner', 'member')))
    )
) with check (
    exists (
        select 1 from munch.guided_plan_drafts draft
        where draft.id = plan_draft_id
          and (draft.personal_owner_user_id = munch.current_user_id()
               or (draft.household_id is not null and munch.household_role(draft.household_id) in ('owner', 'member')))
    )
);
create policy guided_plan_draft_items_auth_self on munch.guided_plan_draft_items for all to munch_auth using (
    exists (select 1 from munch.guided_plan_drafts draft where draft.id = plan_draft_id
            and (draft.personal_owner_user_id = munch.current_user_id()
                 or (draft.household_id is not null and munch.household_role(draft.household_id) is not null)))
) with check (
    exists (select 1 from munch.guided_plan_drafts draft where draft.id = plan_draft_id
            and (draft.personal_owner_user_id = munch.current_user_id()
                 or (draft.household_id is not null and munch.household_role(draft.household_id) in ('owner', 'member'))))
);

create policy guided_plan_changes_app_read on munch.guided_plan_changes for select to munch_app using (
    user_id = munch.current_user_id()
    and exists (select 1 from munch.planned_meals planned where planned.id = planned_meal_id)
);
create policy guided_plan_changes_app_insert on munch.guided_plan_changes for insert to munch_app with check (
    user_id = munch.current_user_id()
    and exists (select 1 from munch.planned_meals planned where planned.id = planned_meal_id)
);
create policy guided_plan_changes_app_update on munch.guided_plan_changes for update to munch_app using (
    user_id = munch.current_user_id()
    and exists (select 1 from munch.planned_meals planned where planned.id = planned_meal_id)
) with check (
    user_id = munch.current_user_id()
    and exists (select 1 from munch.planned_meals planned where planned.id = planned_meal_id)
);
create policy guided_plan_changes_auth_read on munch.guided_plan_changes for select to munch_auth
    using (user_id = munch.current_user_id());
create policy guided_plan_changes_auth_insert on munch.guided_plan_changes for insert to munch_auth
    with check (user_id = munch.current_user_id());
create policy guided_plan_changes_auth_update on munch.guided_plan_changes for update to munch_auth
    using (user_id = munch.current_user_id()) with check (user_id = munch.current_user_id());

grant select, insert, update, delete on munch.guidance_preferences to munch_app, munch_auth;
grant select, insert on munch.guidance_goal_revisions to munch_app;
grant all on munch.guidance_goal_revisions to munch_auth;
grant select, insert, update on munch.guidance_goal_proposals to munch_app, munch_auth;
grant select, insert, update on munch.guided_plan_drafts to munch_app, munch_auth;
grant select, insert, update, delete on munch.guided_plan_draft_items to munch_app, munch_auth;
grant select, insert, update on munch.guided_plan_changes to munch_app, munch_auth;

comment on table munch.guidance_preferences is 'User-managed objective and meal-planning preferences for optional nutrition guidance';
comment on table munch.guidance_goal_revisions is 'Append-only, user-confirmed snapshots of nutrition goals and objective';
comment on table munch.guidance_goal_proposals is 'Expiring target previews that require explicit user confirmation';
comment on table munch.guided_plan_drafts is 'Editable meal-planning proposals; never logged meals or grocery acquisitions';
comment on table munch.guided_plan_draft_items is 'Saved or generated recipe selections in an uncommitted plan draft';
comment on table munch.guided_plan_changes is 'Auditable, versioned planned-meal swaps and safe undo operations';
