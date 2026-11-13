-- Log as planned (connection option #1): a planned meal can be logged
-- once per user. The app marks a plan entry logged by the meal whose
-- source_planned_meal_id points at it; this partial unique index is
-- the atomic backstop behind logRecipe's check-first guard, so no
-- insert path (app, MCP tool, draft confirmation) can double-log the
-- same planned meal for the same user. Deleting the logged meal (a
-- hard delete) frees the plan entry to be logged again.
create unique index meals_user_planned_meal_unique
    on munch.meals (user_id, source_planned_meal_id)
    where source_planned_meal_id is not null;
