-- Paid household seats.
--
-- Stripe remains the billing source of truth. Munch persists subscription-item
-- quantities so entitlement checks can fail closed without calling Stripe on
-- every request. Reservation timestamps serialize concurrent household seat
-- additions/removals without exposing pending memberships to users.

create table munch.subscription_items (
    stripe_subscription_item_id text primary key,
    stripe_subscription_id text not null
        references munch.subscriptions(stripe_subscription_id) on delete cascade,
    stripe_price_id text not null,
    quantity integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint subscription_items_quantity_nonnegative check (quantity >= 0)
);

create unique index subscription_items_subscription_price_unique
    on munch.subscription_items (stripe_subscription_id, stripe_price_id);
create index subscription_items_subscription_idx
    on munch.subscription_items (stripe_subscription_id);

alter table munch.household_invitations
    add column seat_reserved_at timestamptz;

alter table munch.household_memberships
    add column seat_release_reserved_at timestamptz;

create index household_invitations_seat_reservations_idx
    on munch.household_invitations (household_id, seat_reserved_at)
    where seat_reserved_at is not null
      and accepted_at is null
      and revoked_at is null;

create index household_memberships_seat_release_reservations_idx
    on munch.household_memberships (household_id, seat_release_reserved_at)
    where seat_release_reserved_at is not null
      and status = 'active'
      and role <> 'owner';

grant select, insert, update, delete on munch.subscription_items to munch_billing;

grant select, insert, update, delete on
    munch.household_memberships,
    munch.household_invitations,
    munch.households
    to munch_auth;

comment on table munch.subscription_items is
    'Stripe subscription item snapshot used for billing reconciliation and household-seat entitlements';
comment on column munch.household_invitations.seat_reserved_at is
    'Short-lived reservation counted while a paid household seat is being added';
comment on column munch.household_memberships.seat_release_reserved_at is
    'Short-lived reservation excluded from desired paid seat count while a member is leaving or being removed';
