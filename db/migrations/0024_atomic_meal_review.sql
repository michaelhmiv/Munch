-- Stable idempotency key for one-call meal review preparation. The key is
-- tenant-scoped and contains no meal text or image data.
alter table munch.meal_drafts
    add column request_id text;

alter table munch.meal_drafts
    add constraint meal_drafts_request_id_length
    check (request_id is null or length(request_id) between 1 and 200);

create unique index meal_drafts_user_request_uq
    on munch.meal_drafts (user_id, request_id)
    where request_id is not null;

comment on column munch.meal_drafts.request_id is
    'Tenant-scoped idempotency key for atomic review preparation; never raw meal or image content';
