-- One-time bridge from the pre-baseline schema to the canonical Better Auth-only
-- generation. Business/domain rows are intentionally untouched. Authentication
-- credentials are reset so every post-cutover session and MCP grant is issued by
-- the final architecture.

do $$
begin
    if to_regclass('munch.users') is null then
        raise exception 'Cannot rebaseline: munch.users is missing';
    end if;
    if to_regclass('munch.auth_sessions') is null
       or to_regclass('munch."oauthClient"') is null
       or to_regclass('munch."oauthConsent"') is null then
        raise exception 'Cannot rebaseline: canonical Better Auth tables are missing';
    end if;
end
$$;

-- Reset transient authentication state only. Stable user UUIDs and all business
-- data remain in place. The reviewer credential can be reprovisioned after the
-- cutover; magic-link users need no auth_accounts row.
truncate table
    munch."oauthAccessToken",
    munch."oauthRefreshToken",
    munch."oauthConsent",
    munch."oauthClient",
    munch.auth_sessions,
    munch.auth_verifications,
    munch.auth_accounts,
    munch.jwks
restart identity cascade;

-- Retire the custom browser-login and OAuth implementation permanently.
drop table if exists munch.oauth_authorization_codes cascade;
drop table if exists munch.oauth_authorization_sessions cascade;
drop table if exists munch.oauth_access_tokens cascade;
drop table if exists munch.oauth_refresh_tokens cascade;
drop table if exists munch.oauth_clients cascade;
drop table if exists munch.web_sessions cascade;
drop table if exists munch.login_tokens cascade;
drop type if exists munch.login_token_purpose;

-- Normalize comments left by the temporary cutover migrations.
comment on table munch.auth_sessions is 'Better Auth browser sessions';
comment on table munch.auth_accounts is 'Better Auth identities; password hashes are permitted only for provisioned credential accounts';
comment on table munch.auth_verifications is 'Better Auth hashed single-use verification records';
comment on table munch."oauthClient" is 'Better Auth OAuth 2.1 clients, including dynamically registered public MCP clients';
comment on table munch."oauthRefreshToken" is 'Better Auth OAuth refresh tokens with rotation and revocation state';
comment on table munch."oauthAccessToken" is 'Better Auth OAuth access-token metadata';
comment on table munch."oauthConsent" is 'User consent grants for Better Auth OAuth clients and scopes';
comment on table munch.jwks is 'Private and public signing keys managed by the Better Auth JWT plugin';

-- The old immutable migration ledger describes a retired architecture. The new
-- generation is tracked by schema_state/schema_updates instead.
drop table if exists munch.schema_migrations;
