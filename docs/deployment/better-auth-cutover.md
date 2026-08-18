# Canonical Better Auth production rebaseline

This runbook retires the pre-baseline custom authentication/OAuth schema and establishes the canonical Better Auth + Railway PostgreSQL generation without changing the stable `munch.users.id` used by nutrition, household, and billing records.

This is a one-way architecture cutover. Rollback means restoring the pre-cutover application and database backup together; there is no runtime flag that re-enables the retired auth implementation.

## Preconditions

Before merge or production deployment:

1. GitHub CI is completely green on the rebaseline pull request.
2. Fresh schema installation and repeat installation pass.
3. The rebaseline preservation smoke proves representative business rows survive while retired auth tables disappear.
4. Better Auth schema, dynamic registration, browser OAuth, MCP authentication, connection list/revoke, account deletion, RLS, nutrition, recipe, household, export, and container checks pass.
5. A recoverable Railway PostgreSQL backup exists.
6. Required production configuration is present: `DATABASE_URL`, `MUNCH_APP_BASE_URL`, `BETTER_AUTH_SECRET`, Resend sender configuration, Stripe configuration, `OFF_USER_AGENT`, and `USDA_FDC_API_KEY`.

## Deployment behavior

Railway runs `bun run db:migrate` before starting the new application.

For an existing pre-baseline database, the migration runner detects `munch.users` without the canonical `munch.schema_state` marker and runs `db/legacy-bridge/retire-prebaseline-auth.sql` in a transaction. The bridge preserves business rows and stable user UUIDs while removing retired custom auth/OAuth objects and resetting transient Better Auth sessions, grants, credentials, and signing keys.

The canonical schema-generation marker is written only after the bridge succeeds. A failed bridge blocks deployment.

## Expected user impact

Business records remain attached to the same Munch user UUID. Existing browser sessions and ChatGPT OAuth credentials are intentionally invalidated. Users sign in again and reconnect Munch so every credential in the canonical system is issued by Better Auth.

## Immediate production checks

1. Confirm the Railway deployment is healthy and `/health/live` and `/health/ready` return 200.
2. Confirm protected-resource and authorization-server discovery advertise only Better Auth endpoints.
3. Sign in through the production Better Auth magic-link flow.
4. Dynamically register an OAuth public client and complete PKCE authorization/consent.
5. Exchange the authorization code and initialize MCP.
6. Call `tools/list` and representative read/write tools.
7. Confirm existing meals, goals, saved foods, recipes, plans, groceries, households, and billing state remain visible for preserved users.
8. Confirm the website Connections view shows the Better Auth grant.
9. Revoke that connection and confirm it disappears and cannot be refreshed.
10. Reconnect and verify MCP again.
11. Exercise account export and a disposable account deletion.
12. Inspect fresh production logs for startup, migration, OAuth, database, or repeated authorization errors.
13. Verify the live schema contains no retired custom auth/OAuth tables.
14. Remove retired Railway environment variables after the application is confirmed healthy.

## Recovery

For a schema/data/security failure, stop the affected deployment and restore the pre-cutover application together with the pre-cutover Railway PostgreSQL backup. Do not attempt to recreate the retired tables inside the canonical release or reintroduce backend-selector environment variables.

For an application-only defect discovered after a successful rebaseline, fix or revert application code against the canonical schema. Do not roll authentication architecture backward independently of the database.
