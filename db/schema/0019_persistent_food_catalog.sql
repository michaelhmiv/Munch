-- Persistent, global provider-backed food catalog.
-- Contains public provider data only; user labels, notes, usage history, and
-- custom portions remain in tenant-scoped tables.

create extension if not exists pg_trgm;

create table munch.food_catalog_entries (
    id uuid primary key default gen_random_uuid(),
    provider text not null,
    provider_food_id text not null,
    barcode text,
    name text not null,
    normalized_name text not null,
    brand text,
    normalized_brand text,
    data_kind text not null default 'unknown',
    country text,
    portions jsonb not null default '[]'::jsonb,
    nutrients_per_100g jsonb,
    declared_serving_nutrition jsonb,
    nutrient_payload jsonb not null default '{}'::jsonb,
    source_snapshot jsonb not null,
    source_url text,
    source_license text,
    provider_revision text,
    source_updated_at timestamptz,
    fetched_at timestamptz not null default now(),
    last_successful_refresh_at timestamptz not null default now(),
    last_accessed_at timestamptz not null default now(),
    access_count bigint not null default 0,
    confidence double precision not null default 0,
    quality jsonb not null default '{}'::jsonb,
    content_hash text not null,
    refresh_after timestamptz not null,
    deprecated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint food_catalog_provider_nonempty check (length(btrim(provider)) > 0),
    constraint food_catalog_provider_id_nonempty check (length(btrim(provider_food_id)) > 0),
    constraint food_catalog_name_nonempty check (length(btrim(name)) > 0),
    constraint food_catalog_normalized_name_nonempty check (length(btrim(normalized_name)) > 0),
    constraint food_catalog_confidence_range check (confidence between 0 and 1),
    constraint food_catalog_access_count_nonnegative check (access_count >= 0),
    constraint food_catalog_barcode_format check (barcode is null or barcode ~ '^[0-9]{8,14}$'),
    constraint food_catalog_provider_record_unique unique (provider, provider_food_id)
);

create index food_catalog_barcode_idx
    on munch.food_catalog_entries (barcode)
    where barcode is not null and deprecated_at is null;
create index food_catalog_refresh_idx
    on munch.food_catalog_entries (refresh_after)
    where deprecated_at is null;
create index food_catalog_last_accessed_idx
    on munch.food_catalog_entries (last_accessed_at desc);
create index food_catalog_name_trgm_idx
    on munch.food_catalog_entries using gin (normalized_name gin_trgm_ops);
create index food_catalog_brand_trgm_idx
    on munch.food_catalog_entries using gin (normalized_brand gin_trgm_ops)
    where normalized_brand is not null;
create index food_catalog_lexical_search_idx
    on munch.food_catalog_entries
    using gin (
        to_tsvector(
            'simple',
            normalized_name || ' ' || coalesce(normalized_brand, '')
        )
    )
    where deprecated_at is null;

create table munch.food_catalog_query_cache (
    query_hash text primary key,
    normalized_query text not null,
    provider_set text[] not null default '{}'::text[],
    entry_ids uuid[] not null default '{}'::uuid[],
    fetched_at timestamptz not null default now(),
    expires_at timestamptz not null,
    constraint food_catalog_query_nonempty check (length(btrim(normalized_query)) > 0)
);
create index food_catalog_query_expires_idx
    on munch.food_catalog_query_cache (expires_at);

create table munch.food_catalog_negative_cache (
    operation text not null,
    identity_hash text not null,
    provider text not null,
    not_found_at timestamptz not null default now(),
    expires_at timestamptz not null,
    primary key (operation, identity_hash, provider),
    constraint food_catalog_negative_operation_nonempty check (length(btrim(operation)) > 0),
    constraint food_catalog_negative_provider_nonempty check (length(btrim(provider)) > 0)
);
create index food_catalog_negative_expires_idx
    on munch.food_catalog_negative_cache (expires_at);

create or replace function munch.food_catalog_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end
$$;

create trigger food_catalog_entries_updated_at
before update on munch.food_catalog_entries
for each row execute function munch.food_catalog_touch_updated_at();

grant select, insert, update, delete on munch.food_catalog_entries to munch_service;
grant select, insert, update, delete on munch.food_catalog_query_cache to munch_service;
grant select, insert, update, delete on munch.food_catalog_negative_cache to munch_service;

comment on table munch.food_catalog_entries is
    'Global provider-backed food facts only; no user or household-private data';
comment on column munch.food_catalog_entries.source_snapshot is
    'Immutable normalized provider response sufficient to reproduce candidate nutrition';
comment on table munch.food_catalog_query_cache is
    'Short-lived mapping from normalized search query to persisted provider records';
comment on table munch.food_catalog_negative_cache is
    'Short-lived verified not-found results; provider errors are never stored here';
