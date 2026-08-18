-- Recipe revisions are immutable facts. This key makes a complete recipe
-- replacement safe to retry without creating a second revision.
alter table munch.recipe_revisions
    add column idempotency_key text;

alter table munch.recipe_revisions
    add constraint recipe_revisions_idempotency_key_length
    check (idempotency_key is null or length(idempotency_key) between 1 and 255);

create unique index recipe_revisions_recipe_idempotency_unique
    on munch.recipe_revisions (recipe_id, idempotency_key)
    where idempotency_key is not null;

create index meals_source_recipe_revision_idx
    on munch.meals (user_id, source_recipe_revision_id, logged_at desc)
    where source_recipe_revision_id is not null;

comment on column munch.recipe_revisions.idempotency_key is
    'Caller-provided key for one immutable replacement revision; scoped to a recipe';
