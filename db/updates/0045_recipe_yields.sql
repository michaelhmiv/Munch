-- Recipe unit logging (owner-approved 2026-11-13): a recipe revision
-- may carry a SET total yield per measure family — one volume slot and
-- one weight slot. Both are optional and independent. When a slot is
-- empty, Amount-mode logging falls back to the ingredient-sum yield
-- estimate, which is computed at read time and never stored, so these
-- columns only ever hold yields a user actually set.
--
-- Yield-only corrections update these columns on the current revision
-- in place: they never create a new revision and never bump the
-- recipe version. Logged meals snapshot the yield they were figured
-- from, so editing a yield never rewrites history.
alter table munch.recipe_revisions
    add column if not exists yield_volume_quantity numeric(12, 3),
    add column if not exists yield_volume_unit text,
    add column if not exists yield_weight_quantity numeric(12, 3),
    add column if not exists yield_weight_unit text;

alter table munch.recipe_revisions
    add constraint recipe_revisions_yield_volume_positive
        check (yield_volume_quantity is null or yield_volume_quantity > 0),
    add constraint recipe_revisions_yield_weight_positive
        check (yield_weight_quantity is null or yield_weight_quantity > 0),
    add constraint recipe_revisions_yield_volume_unit_present
        check (yield_volume_quantity is null or yield_volume_unit is not null),
    add constraint recipe_revisions_yield_weight_unit_present
        check (yield_weight_quantity is null or yield_weight_unit is not null);

-- Revisions are insert-only immutable by grant design (0013), and
-- that stands for every food and nutrition column. Yield corrections
-- are the ONE sanctioned mutation (owner ruling, 2026-11-13: they
-- never create a revision), so the grant is column-scoped to exactly
-- the four yield columns, and the update policy mirrors the insert
-- policy's ownership shape (the recipe's owner, or a household
-- owner/member).
grant update (
    yield_volume_quantity,
    yield_volume_unit,
    yield_weight_quantity,
    yield_weight_unit
) on munch.recipe_revisions to munch_app;

create policy recipe_revisions_app_update_yields
    on munch.recipe_revisions for update to munch_app
    using (
        exists (
            select 1 from munch.recipes recipe
            where recipe.id = recipe_id
              and (
                  recipe.personal_owner_user_id = munch.current_user_id()
                  or (recipe.household_id is not null and munch.household_role(recipe.household_id) in ('owner', 'member'))
              )
        )
    )
    with check (
        exists (
            select 1 from munch.recipes recipe
            where recipe.id = recipe_id
              and (
                  recipe.personal_owner_user_id = munch.current_user_id()
                  or (recipe.household_id is not null and munch.household_role(recipe.household_id) in ('owner', 'member'))
              )
        )
    );
