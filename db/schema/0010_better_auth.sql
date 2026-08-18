-- Canonical Better Auth browser and OAuth 2.1 schema for Munch.
-- Business ownership remains munch.users.id. Better Auth is the only auth stack.

create table munch.auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    token text not null unique,
    expires_at timestamptz not null,
    ip_address text,
    user_agent text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index auth_sessions_user_expires_idx
    on munch.auth_sessions (user_id, expires_at desc);

create table munch.auth_accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references munch.users(id) on delete cascade,
    account_id text not null,
    provider_id text not null,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    password text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint auth_accounts_provider_identity_unique
        unique (provider_id, account_id),
    constraint auth_accounts_password_scope
        check (
            (provider_id = 'credential' and password is not null)
            or (provider_id <> 'credential' and password is null)
        )
);

create index auth_accounts_user_idx on munch.auth_accounts (user_id);

create table munch.auth_verifications (
    id uuid primary key default gen_random_uuid(),
    identifier text not null,
    value text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index auth_verifications_identifier_idx
    on munch.auth_verifications (identifier, expires_at desc);

create table munch."oauthClient" (
    id uuid primary key default gen_random_uuid(),
    "clientId" text not null unique,
    "clientSecret" text,
    "clientSecretExpiresAt" timestamptz,
    disabled boolean not null default false,
    "skipConsent" boolean not null default false,
    "enableEndSession" boolean not null default false,
    "subjectType" text,
    scopes text,
    "userId" uuid references munch.users(id) on delete cascade,
    "referenceId" text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now(),
    name text,
    uri text,
    icon text,
    contacts text,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" text not null,
    "postLogoutRedirectUris" text,
    "tokenEndpointAuthMethod" text,
    "grantTypes" text,
    "responseTypes" text,
    public boolean not null default false,
    type text,
    "requirePKCE" boolean not null default true,
    resources text,
    metadata jsonb,
    constraint oauth_client_redirect_uris_json_nonempty
        check (
            jsonb_typeof("redirectUris"::jsonb) = 'array'
            and jsonb_array_length("redirectUris"::jsonb) > 0
        ),
    constraint oauth_client_token_auth_method
        check (
            "tokenEndpointAuthMethod" is null
            or "tokenEndpointAuthMethod" in (
                'none',
                'client_secret_basic',
                'client_secret_post'
            )
        ),
    constraint oauth_client_subject_type
        check ("subjectType" is null or "subjectType" in ('public', 'pairwise'))
);

create index oauth_client_user_idx
    on munch."oauthClient" ("userId")
    where "userId" is not null;
create index oauth_client_reference_idx
    on munch."oauthClient" ("referenceId")
    where "referenceId" is not null;

create table munch."oauthRefreshToken" (
    id uuid primary key default gen_random_uuid(),
    token text not null unique,
    "clientId" text not null
        references munch."oauthClient" ("clientId") on delete cascade,
    "sessionId" uuid
        references munch.auth_sessions(id) on delete cascade,
    "userId" uuid not null
        references munch.users(id) on delete cascade,
    "referenceId" text,
    scopes text not null,
    revoked timestamptz,
    "authTime" timestamptz,
    "createdAt" timestamptz not null default now(),
    "expiresAt" timestamptz not null
);

create index oauth_refresh_client_idx
    on munch."oauthRefreshToken" ("clientId");
create index oauth_refresh_session_idx
    on munch."oauthRefreshToken" ("sessionId")
    where "sessionId" is not null;
create index oauth_refresh_user_idx
    on munch."oauthRefreshToken" ("userId", "expiresAt" desc);
create index oauth_refresh_expiry_idx
    on munch."oauthRefreshToken" ("expiresAt");

create table munch."oauthAccessToken" (
    id uuid primary key default gen_random_uuid(),
    token text not null unique,
    "clientId" text not null
        references munch."oauthClient" ("clientId") on delete cascade,
    "sessionId" uuid
        references munch.auth_sessions(id) on delete cascade,
    "refreshId" uuid
        references munch."oauthRefreshToken" (id) on delete cascade,
    "userId" uuid
        references munch.users(id) on delete cascade,
    "referenceId" text,
    scopes text not null,
    "createdAt" timestamptz not null default now(),
    "expiresAt" timestamptz not null
);

create index oauth_access_client_idx
    on munch."oauthAccessToken" ("clientId");
create index oauth_access_session_idx
    on munch."oauthAccessToken" ("sessionId")
    where "sessionId" is not null;
create index oauth_access_refresh_idx
    on munch."oauthAccessToken" ("refreshId")
    where "refreshId" is not null;
create index oauth_access_user_idx
    on munch."oauthAccessToken" ("userId", "expiresAt" desc)
    where "userId" is not null;
create index oauth_access_expiry_idx
    on munch."oauthAccessToken" ("expiresAt");

create table munch."oauthConsent" (
    id uuid primary key default gen_random_uuid(),
    "userId" uuid not null
        references munch.users(id) on delete cascade,
    "clientId" text not null
        references munch."oauthClient" ("clientId") on delete cascade,
    "referenceId" text,
    scopes text not null,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now()
);

create index oauth_consent_user_idx
    on munch."oauthConsent" ("userId");
create index oauth_consent_client_idx
    on munch."oauthConsent" ("clientId");
create unique index oauth_consent_owner_client_unique
    on munch."oauthConsent" (
        "userId",
        "clientId",
        coalesce("referenceId", '')
    );

create table munch.jwks (
    id uuid primary key default gen_random_uuid(),
    "publicKey" text not null,
    "privateKey" text not null,
    "createdAt" timestamptz not null default now(),
    "expiresAt" timestamptz
);

create index jwks_created_idx on munch.jwks ("createdAt" desc);
create index jwks_expiry_idx
    on munch.jwks ("expiresAt")
    where "expiresAt" is not null;

alter table munch.auth_sessions enable row level security;
alter table munch.auth_sessions force row level security;
alter table munch.auth_accounts enable row level security;
alter table munch.auth_accounts force row level security;
alter table munch.auth_verifications enable row level security;
alter table munch.auth_verifications force row level security;
alter table munch."oauthClient" enable row level security;
alter table munch."oauthClient" force row level security;
alter table munch."oauthRefreshToken" enable row level security;
alter table munch."oauthRefreshToken" force row level security;
alter table munch."oauthAccessToken" enable row level security;
alter table munch."oauthAccessToken" force row level security;
alter table munch."oauthConsent" enable row level security;
alter table munch."oauthConsent" force row level security;
alter table munch.jwks enable row level security;
alter table munch.jwks force row level security;

create policy auth_sessions_auth_all
    on munch.auth_sessions for all to munch_auth using (true) with check (true);
create policy auth_accounts_auth_all
    on munch.auth_accounts for all to munch_auth using (true) with check (true);
create policy auth_verifications_auth_all
    on munch.auth_verifications for all to munch_auth using (true) with check (true);
create policy oauth_client_auth_all
    on munch."oauthClient" for all to munch_auth using (true) with check (true);
create policy oauth_refresh_auth_all
    on munch."oauthRefreshToken" for all to munch_auth using (true) with check (true);
create policy oauth_access_auth_all
    on munch."oauthAccessToken" for all to munch_auth using (true) with check (true);
create policy oauth_consent_auth_all
    on munch."oauthConsent" for all to munch_auth using (true) with check (true);
create policy jwks_auth_all
    on munch.jwks for all to munch_auth using (true) with check (true);

grant select, insert, update, delete on
    munch.auth_sessions,
    munch.auth_accounts,
    munch.auth_verifications,
    munch."oauthClient",
    munch."oauthRefreshToken",
    munch."oauthAccessToken",
    munch."oauthConsent",
    munch.jwks
    to munch_auth;

comment on table munch.auth_sessions is 'Better Auth browser sessions';
comment on table munch.auth_accounts is 'Better Auth identities; password hashes are permitted only for provisioned credential accounts';
comment on table munch.auth_verifications is 'Better Auth hashed single-use verification records';
comment on table munch."oauthClient" is 'Better Auth OAuth 2.1 clients, including dynamically registered public MCP clients';
comment on table munch."oauthRefreshToken" is 'Better Auth OAuth refresh tokens with rotation and revocation state';
comment on table munch."oauthAccessToken" is 'Better Auth OAuth access-token metadata';
comment on table munch."oauthConsent" is 'User consent grants for Better Auth OAuth clients and scopes';
comment on table munch.jwks is 'Private and public signing keys managed by the Better Auth JWT plugin';
comment on column munch."oauthClient".scopes is 'JSON array text managed by Better Auth OAuth Provider';
comment on column munch."oauthClient"."redirectUris" is 'JSON array text managed by Better Auth OAuth Provider';
comment on column munch."oauthRefreshToken".scopes is 'JSON array text managed by Better Auth OAuth Provider';
comment on column munch."oauthAccessToken".scopes is 'JSON array text managed by Better Auth OAuth Provider';
comment on column munch."oauthConsent".scopes is 'JSON array text managed by Better Auth OAuth Provider';
