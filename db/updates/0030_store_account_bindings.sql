-- Bind opaque app-store account identifiers to Munch users for authenticated
-- server notifications. No raw email or user identifier is shared with stores.

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

grant select, insert, update, delete on
    munch.store_account_bindings
    to munch_billing;

comment on table munch.store_account_bindings is
    'Opaque app-store account identifiers mapped to Munch users so authenticated server notifications can resolve ownership without exposing user identifiers to the store.';
