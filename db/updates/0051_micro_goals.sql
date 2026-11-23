-- Micro targets (approved brief 2026-11-23): sodium, saturated fat,
-- cholesterol, and potassium become optional daily targets. All four
-- nutrients are already tracked end-to-end (food data, meal items,
-- daily totals); this adds only the goal columns on
-- munch.nutrition_goals, mirroring the existing columns' types
-- (mg targets are integers like daily_water_ml; saturated fat is
-- numeric(8, 2) like the other gram targets) with the same
-- nonnegative check constraints. Nullable, no backfill: NULL means
-- "no target", exactly like the existing fields.
-- Defensive per house law: safe on a fresh database, on production,
-- and on re-run.

alter table munch.nutrition_goals
    add column if not exists daily_sodium_mg integer,
    add column if not exists daily_saturated_fat_g numeric(8, 2),
    add column if not exists daily_cholesterol_mg integer,
    add column if not exists daily_potassium_mg integer;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'nutrition_goals_sodium_nonnegative'
    ) then
        alter table munch.nutrition_goals
            add constraint nutrition_goals_sodium_nonnegative
            check (daily_sodium_mg is null or daily_sodium_mg >= 0);
    end if;
    if not exists (
        select 1 from pg_constraint
        where conname = 'nutrition_goals_saturated_fat_nonnegative'
    ) then
        alter table munch.nutrition_goals
            add constraint nutrition_goals_saturated_fat_nonnegative
            check (
                daily_saturated_fat_g is null or daily_saturated_fat_g >= 0
            );
    end if;
    if not exists (
        select 1 from pg_constraint
        where conname = 'nutrition_goals_cholesterol_nonnegative'
    ) then
        alter table munch.nutrition_goals
            add constraint nutrition_goals_cholesterol_nonnegative
            check (daily_cholesterol_mg is null or daily_cholesterol_mg >= 0);
    end if;
    if not exists (
        select 1 from pg_constraint
        where conname = 'nutrition_goals_potassium_nonnegative'
    ) then
        alter table munch.nutrition_goals
            add constraint nutrition_goals_potassium_nonnegative
            check (daily_potassium_mg is null or daily_potassium_mg >= 0);
    end if;
end $$;
