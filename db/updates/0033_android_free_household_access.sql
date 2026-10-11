alter table munch.household_invitations
    add column android_free_access boolean not null default false;

alter table munch.household_memberships
    add column android_free_access boolean not null default false;

comment on column munch.household_invitations.android_free_access is
    'Android free-baseline invitations do not create a billable Stripe household seat';
comment on column munch.household_memberships.android_free_access is
    'Membership entered through an Android free-baseline invitation and excluded from Stripe seat quantities';
