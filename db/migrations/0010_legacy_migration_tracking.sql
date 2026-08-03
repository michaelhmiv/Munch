create table munch.legacy_identity_links (
    source_system text not null,
    source_user_id text not null,
    user_id uuid not null references munch.users(id) on delete cascade,
    source_email text not null,
    migrated_at timestamptz not null default now(),
    primary key (source_system, source_user_id),
    constraint legacy_identity_source_nonempty check (
        length(btrim(source_system)) > 0 and length(btrim(source_user_id)) > 0
    ),
    constraint legacy_identity_email_nonempty check (
        length(btrim(source_email)) > 0
    ),
    constraint legacy_identity_user_unique unique (source_system, user_id)
);

create table munch.legacy_migration_runs (
    id uuid primary key default gen_random_uuid(),
    source_system text not null,
    manifest_checksum text not null,
    status text not null default 'running',
    dry_run boolean not null default false,
    source_exported_at timestamptz,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    row_counts jsonb not null default '{}'::jsonb,
    verification jsonb not null default '{}'::jsonb,
    error_code text,
    constraint legacy_migration_status check (
        status in ('running', 'completed', 'failed', 'verified')
    ),
    constraint legacy_migration_manifest_nonempty check (
        length(btrim(manifest_checksum)) > 0
    ),
    constraint legacy_migration_counts_object check (
        jsonb_typeof(row_counts) = 'object'
    ),
    constraint legacy_migration_verification_object check (
        jsonb_typeof(verification) = 'object'
    )
);

create index legacy_identity_user_idx
    on munch.legacy_identity_links (user_id);
create index legacy_migration_runs_started_idx
    on munch.legacy_migration_runs (started_at desc);

revoke all on munch.legacy_identity_links from public;
revoke all on munch.legacy_migration_runs from public;

comment on table munch.legacy_identity_links is 'Owner-only mapping from inherited Supabase Auth IDs to Munch account IDs';
comment on column munch.legacy_identity_links.source_email is 'Migration-only email used for deterministic identity reconciliation; never exposed through application roles';
comment on table munch.legacy_migration_runs is 'Owner-only auditable manifest and verification status for data cutovers';
