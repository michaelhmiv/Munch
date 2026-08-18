-- Canonical Munch PostgreSQL foundation.
-- This is schema construction, not historical migration replay. Authentication
-- is Better Auth only; no custom login/session/OAuth objects are created here.

create extension if not exists pgcrypto;
create schema if not exists munch;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'munch_app') then
        create role munch_app nologin nosuperuser nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'munch_auth') then
        create role munch_auth nologin nosuperuser nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'munch_billing') then
        create role munch_billing nologin nosuperuser nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'munch_support') then
        create role munch_support nologin nosuperuser nocreatedb nocreaterole noinherit;
    end if;

    execute format('grant munch_app, munch_auth, munch_billing, munch_support to %I', current_user);
end
$$;

revoke all on schema munch from public;
grant usage on schema munch to munch_app, munch_auth, munch_billing, munch_support;

create type munch.account_status as enum (
    'pending',
    'active',
    'suspended',
    'deletion_pending',
    'deleted'
);

create type munch.subscription_status as enum (
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused'
);

create type munch.audit_actor_type as enum (
    'user',
    'system',
    'support',
    'billing',
    'migration'
);

create table munch.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    name text not null default 'Munch user',
    email_verified boolean not null default false,
    email_verified_at timestamptz,
    image text,
    status munch.account_status not null default 'pending',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deletion_requested_at timestamptz,
    deleted_at timestamptz,
    constraint users_email_normalized check (email = lower(btrim(email))),
    constraint users_email_nonempty check (length(email) between 3 and 320)
);

create unique index users_email_unique on munch.users (email);

create table munch.account_preferences (
    user_id uuid primary key references munch.users(id) on delete cascade,
    timezone text,
    preferred_weight_unit text check (preferred_weight_unit in ('kg', 'lb')),
    widgets_enabled boolean not null default true,
    alcohol_tracking_enabled boolean not null default false,
    preferred_drink_unit text check (preferred_drink_unit in ('us', 'uk')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table munch.stripe_customers (
    user_id uuid primary key references munch.users(id) on delete cascade,
    stripe_customer_id text not null unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table munch.subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    stripe_subscription_id text not null unique,
    stripe_price_id text,
    status munch.subscription_status not null,
    current_period_start timestamptz,
    current_period_end timestamptz,
    trial_end timestamptz,
    cancel_at_period_end boolean not null default false,
    canceled_at timestamptz,
    grace_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index subscriptions_user_idx on munch.subscriptions (user_id, updated_at desc);
create index subscriptions_status_idx on munch.subscriptions (status, current_period_end);

create table munch.entitlements (
    user_id uuid not null references munch.users(id) on delete cascade,
    feature_key text not null,
    active boolean not null,
    expires_at timestamptz,
    source text not null default 'stripe',
    updated_at timestamptz not null default now(),
    primary key (user_id, feature_key)
);

create table munch.stripe_webhook_events (
    stripe_event_id text primary key,
    event_type text not null,
    livemode boolean not null,
    payload_sha256 text not null,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    processing_error_code text,
    attempts integer not null default 0
);

create table munch.audit_events (
    id bigint generated always as identity primary key,
    occurred_at timestamptz not null default now(),
    actor_type munch.audit_actor_type not null,
    actor_id uuid,
    subject_user_id uuid,
    action text not null,
    outcome text not null,
    request_id text,
    metadata jsonb not null default '{}'::jsonb,
    constraint audit_events_outcome check (outcome in ('success', 'denied', 'failed'))
);

create index audit_events_subject_idx on munch.audit_events (subject_user_id, occurred_at desc);
create index audit_events_action_idx on munch.audit_events (action, occurred_at desc);

create or replace function munch.current_user_id()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('app.user_id', true), '')::uuid
$$;

alter table munch.users enable row level security;
alter table munch.users force row level security;
alter table munch.account_preferences enable row level security;
alter table munch.account_preferences force row level security;

create policy users_app_self
    on munch.users
    for select
    to munch_app
    using (id = munch.current_user_id());

create policy users_auth_all
    on munch.users
    for all
    to munch_auth
    using (true)
    with check (true);

create policy users_billing_all
    on munch.users
    for select
    to munch_billing
    using (true);

create policy account_preferences_app_self
    on munch.account_preferences
    for all
    to munch_app
    using (user_id = munch.current_user_id())
    with check (user_id = munch.current_user_id());

create policy account_preferences_auth_all
    on munch.account_preferences
    for all
    to munch_auth
    using (true)
    with check (true);

grant select on munch.users to munch_app;
grant select, insert, update on munch.account_preferences to munch_app;
grant select, insert, update, delete on
    munch.users,
    munch.account_preferences
    to munch_auth;

grant select on munch.users to munch_billing;
grant select, insert, update, delete on
    munch.stripe_customers,
    munch.subscriptions,
    munch.entitlements,
    munch.stripe_webhook_events
    to munch_billing;

grant insert on munch.audit_events to munch_app, munch_auth, munch_billing;
grant usage, select on all sequences in schema munch to munch_app, munch_auth, munch_billing;

create view munch.support_accounts as
select
    u.id as user_id,
    u.status as account_status,
    u.email_verified_at is not null as email_verified,
    u.created_at,
    u.deletion_requested_at,
    s.status as subscription_status,
    s.current_period_end,
    s.cancel_at_period_end
from munch.users u
left join lateral (
    select sub.status, sub.current_period_end, sub.cancel_at_period_end
    from munch.subscriptions sub
    where sub.user_id = u.id
    order by sub.updated_at desc
    limit 1
) s on true;

grant select on munch.support_accounts to munch_support;

comment on schema munch is 'Munch account, Better Auth, billing, and application data';
comment on table munch.stripe_webhook_events is 'Idempotency ledger; raw Stripe payloads are not retained';
comment on table munch.audit_events is 'Sanitized operational audit events; never store nutrition contents or secrets';
