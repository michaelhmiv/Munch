-- Provider-neutral subscription storage for mobile app stores.
-- Stripe remains the source for website checkout and household seat quantities.

do $$
begin
    if not exists (
        select 1
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'munch'
          and t.typname = 'store_billing_provider'
    ) then
        create type munch.store_billing_provider as enum (
            'google_play',
            'apple_app_store'
        );
    end if;
end
$$;

create table if not exists munch.store_account_bindings (
    user_id uuid not null references munch.users(id) on delete cascade,
    provider munch.store_billing_provider not null,
    app_id text not null,
    external_account_id text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (provider, app_id, user_id),
    constraint store_account_bindings_external_unique
        unique (provider, app_id, external_account_id),
    constraint store_account_bindings_app_id_nonempty
        check (length(btrim(app_id)) between 3 and 255),
    constraint store_account_bindings_external_id_length
        check (length(external_account_id) between 1 and 64)
);

create table if not exists munch.store_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    provider munch.store_billing_provider not null,
    app_id text not null,
    product_id text not null,
    purchase_token text not null,
    obfuscated_account_id text,
    status munch.subscription_status not null,
    current_period_start timestamptz,
    current_period_end timestamptz,
    grace_expires_at timestamptz,
    canceled_at timestamptz,
    provider_state text,
    acknowledged boolean not null default false,
    latest_order_id text,
    linked_purchase_token text,
    test_purchase boolean not null default false,
    verified_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint store_subscriptions_identity_unique
        unique (provider, app_id, purchase_token),
    constraint store_subscriptions_app_id_nonempty
        check (length(btrim(app_id)) between 3 and 255),
    constraint store_subscriptions_product_id_nonempty
        check (length(btrim(product_id)) between 1 and 255),
    constraint store_subscriptions_purchase_token_nonempty
        check (length(purchase_token) between 8 and 4096),
    constraint store_subscriptions_obfuscated_account_id_length
        check (
            obfuscated_account_id is null
            or length(obfuscated_account_id) between 1 and 64
        )
);

create index if not exists store_subscriptions_user_idx
    on munch.store_subscriptions (user_id, updated_at desc);
create index if not exists store_subscriptions_provider_product_idx
    on munch.store_subscriptions (provider, app_id, product_id, updated_at desc);

create table if not exists munch.store_billing_events (
    provider munch.store_billing_provider not null,
    event_id text not null,
    event_type text not null,
    payload_sha256 text not null,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    processing_error_code text,
    attempts integer not null default 0,
    primary key (provider, event_id),
    constraint store_billing_events_id_nonempty check (length(event_id) between 1 and 512),
    constraint store_billing_events_payload_sha256_format
        check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

grant select, insert, update, delete on
    munch.store_account_bindings,
    munch.store_subscriptions,
    munch.store_billing_events
    to munch_billing;

comment on table munch.store_account_bindings is
    'Opaque app-store account identifiers mapped to Munch users so authenticated server notifications can resolve ownership without exposing user identifiers to the store.';
comment on table munch.store_subscriptions is
    'Verified app-store subscriptions; purchase tokens require provider credentials to query and are never exposed to application clients.';
comment on table munch.store_billing_events is
    'Idempotency ledger for app-store server notifications; raw notification payloads are not retained.';
