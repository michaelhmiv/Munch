# Munch production operations

## Health endpoints

- `/health/live` proves the Bun process can serve HTTP and is the Railway deployment health check.
- `/health/ready` validates configuration, PostgreSQL connectivity, schema generation/update state, required database roles, and RLS invariants.
- `/health` remains a compatibility alias for liveness.

Readiness responses never contain secrets, user identities, meal contents, or database connection strings.

## Startup validation

Startup configuration validation runs unconditionally before the application is exposed. A deployment fails when required configuration is missing or invalid, including:

- `MUNCH_APP_BASE_URL` is absent or is not a valid origin; production origins must use HTTPS.
- `BETTER_AUTH_SECRET` is absent or shorter than 32 characters.
- Resend or sender configuration is missing.
- `DATABASE_URL` is missing.
- required Stripe price/API/webhook configuration is missing.
- `OFF_USER_AGENT` or `USDA_FDC_API_KEY` is missing.
- database pool configuration is outside the allowed range.

Do not bypass startup validation to force an unhealthy release online. There is no backend selector or strict-validation feature flag.

## Scheduled maintenance

Run a separate Railway cron service from the same repository and image with:

```text
bun run maintenance
```

Recommended schedule:

```text
0 4 * * *
```

That runs once daily at 04:00 UTC. The job removes only bounded transient/operational records:

- expired Better Auth verification records after a 24-hour retention buffer;
- expired Better Auth browser sessions after a 7-day retention buffer;
- expired Better Auth OAuth access-token metadata after 7 days;
- expired or revoked Better Auth refresh-token records after 30 days;
- expired Better Auth signing keys after 30 days;
- expired export capabilities;
- provider cache entries older than 30 days;
- redacted tool events older than 90 days;
- expired meal drafts and cancelled/expired drafts older than 30 days.

OAuth client registrations, active consent grants, Munch accounts, confirmed meals, meal items, saved foods, goals, hydration, weight, recipes, households, subscriptions, entitlements, and Stripe webhook idempotency records are not routine-maintenance targets.

The cron service requires `DATABASE_URL` and uses the same private Railway PostgreSQL service. Do not expose the database publicly for the cron job.

## Monitoring

Alert on:

- `/health/ready` returning 503;
- repeated container restarts;
- failed pre-deploy schema installation/update commands;
- Stripe webhook 5xx responses;
- Resend delivery failures;
- database storage or connection-pool saturation;
- sustained MCP authorization or tool errors;
- scheduled maintenance failures.

Logs must not include OAuth credentials, magic links, Stripe secrets, database URLs, meal descriptions, weights, tool arguments, export capabilities, or request bodies.

## Backups and recovery

Enable Railway PostgreSQL backups and point-in-time recovery before accepting paid users. Perform a restore exercise into an isolated Railway environment before launch and after material schema changes. A backup is not considered operational until a restore has been verified.

The pre-baseline retirement bridge is not a backup mechanism. Preserve a recoverable database backup before a production rebaseline and verify business-data preservation before declaring the cutover complete.
