-- Production update for Pantry planning profiles. Intentionally idempotent because
-- fresh installs load canonical schema before applying update files.

create table if not exists munch.inventory_item_profiles (
    inventory_item_id uuid primary key references munch.inventory_items(id) on delete cascade,
    profile_status text not null default 'unresolved',
    source_type text not null default 'heuristic',
    source_provider text,
    source_food_id text,
    match_confidence numeric(5, 4),
    category text not null default 'other',
    culinary_roles text[] not null default '{}'::text[],
    basis_quantity numeric(14, 3),
    basis_unit text,
    basis_grams numeric(14, 3),
    calories numeric(14, 4),
    protein_g numeric(14, 4),
    carbs_g numeric(14, 4),
    fat_g numeric(14, 4),
    fiber_g numeric(14, 4),
    sugar_g numeric(14, 4),
    sodium_mg numeric(14, 4),
    profile_version integer not null default 1,
    enriched_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint inventory_item_profiles_status check (profile_status in ('resolved','partial','unresolved','failed')),
    constraint inventory_item_profiles_source_type check (source_type in ('provider','heuristic','user_supplied','model_estimate','unresolved')),
    constraint inventory_item_profiles_confidence check (match_confidence is null or match_confidence between 0 and 1),
    constraint inventory_item_profiles_category_nonempty check (length(btrim(category)) between 1 and 80),
    constraint inventory_item_profiles_basis_quantity_positive check (basis_quantity is null or basis_quantity > 0),
    constraint inventory_item_profiles_basis_grams_positive check (basis_grams is null or basis_grams > 0),
    constraint inventory_item_profiles_calories_nonnegative check (calories is null or calories >= 0),
    constraint inventory_item_profiles_protein_nonnegative check (protein_g is null or protein_g >= 0),
    constraint inventory_item_profiles_carbs_nonnegative check (carbs_g is null or carbs_g >= 0),
    constraint inventory_item_profiles_fat_nonnegative check (fat_g is null or fat_g >= 0),
    constraint inventory_item_profiles_fiber_nonnegative check (fiber_g is null or fiber_g >= 0),
    constraint inventory_item_profiles_sugar_nonnegative check (sugar_g is null or sugar_g >= 0),
    constraint inventory_item_profiles_sodium_nonnegative check (sodium_mg is null or sodium_mg >= 0),
    constraint inventory_item_profiles_version_positive check (profile_version > 0)
);

create index if not exists inventory_item_profiles_category_idx
    on munch.inventory_item_profiles (category, profile_status);
create index if not exists inventory_item_profiles_source_idx
    on munch.inventory_item_profiles (source_provider, source_food_id)
    where source_food_id is not null;
create index if not exists inventory_item_profiles_roles_idx
    on munch.inventory_item_profiles using gin (culinary_roles);

alter table munch.inventory_item_profiles enable row level security;
alter table munch.inventory_item_profiles force row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname='munch'
          and tablename='inventory_item_profiles'
          and policyname='inventory_item_profiles_app_all'
    ) then
        create policy inventory_item_profiles_app_all
        on munch.inventory_item_profiles
        for all to munch_app
        using (exists (
            select 1
            from munch.inventory_items i
            join munch.inventory_spaces s on s.id = i.inventory_space_id
            where i.id = inventory_item_id
              and i.deleted_at is null
              and (
                  s.personal_owner_user_id = munch.current_user_id()
                  or (
                      s.household_id is not null
                      and munch.household_role(s.household_id) is not null
                  )
              )
        ))
        with check (exists (
            select 1
            from munch.inventory_items i
            join munch.inventory_spaces s on s.id = i.inventory_space_id
            where i.id = inventory_item_id
              and i.deleted_at is null
              and (
                  s.personal_owner_user_id = munch.current_user_id()
                  or (
                      s.household_id is not null
                      and munch.household_role(s.household_id) in ('owner','member')
                  )
              )
        ));
    end if;
end
$$;

grant select, insert, update, delete on munch.inventory_item_profiles to munch_app, munch_auth;

comment on table munch.inventory_item_profiles is 'Refreshable Pantry planning cache: compact nutrition basis plus culinary category/roles; inventory_items remains possession source of truth';
