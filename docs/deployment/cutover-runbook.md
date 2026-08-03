# Munch production Railway cutover

This runbook moves the live service from the inherited Supabase backend to Railway PostgreSQL and Railway-native OAuth. It is intentionally conservative because authentication identities and nutrition owner IDs must switch together.

## Preconditions

- The exact production candidate commit has passed the full staging certification matrix.
- The authenticated MCP contract probe passes against staging.
- Railway PostgreSQL backup and point-in-time recovery are enabled.
- A restore has been tested from a recent backup.
- Stripe production product, price, webhook endpoint, and customer portal are configured.
- Passwordless email delivery is production-ready.
- USDA and Open Food Facts credentials/identification are configured.
- Production privacy policy, terms, support contact, deletion process, and breach-response ownership are published.
- No unresolved severity-one or severity-two issue remains.

## Record the release

Record before starting:

```text
Git commit SHA:
Railway deployment/environment:
Railway database backup timestamp:
Supabase export directory:
Supabase export manifest checksum:
Stripe webhook endpoint:
Operator:
Start time:
Rollback decision owner:
```

## Prepare production Railway

1. Deploy the release candidate with both backend flags false.
2. Run `bun run db:migrate`.
3. Configure all Railway, Stripe, login-delivery, USDA, and Open Food Facts variables.
4. Keep `MUNCH_STRICT_STARTUP_VALIDATION=false` during preparation.
5. Verify `/health/live`.
6. Verify the database backup.
7. Do not direct production MCP traffic to Railway yet.

## Initial migration

1. Export the inherited production data to a restricted directory.
2. Record the manifest checksum.
3. Run the dry import.
4. Run the Railway import.
5. Run verification.
6. Investigate every mismatch before proceeding.
7. Keep the inherited service authoritative and writable.

The initial migration proves compatibility and reduces the final maintenance window. It is not the final source of truth.

## Start write freeze

1. Announce the maintenance window.
2. Disable or reject new writes on the inherited service.
3. Confirm no active import, meal write, hydration write, weight write, or account-deletion job remains.
4. Record the last inherited database write timestamp.
5. Leave reads available only if they cannot generate writes or refresh incompatible credentials.

## Final migration

1. Create a new complete Supabase export after the freeze.
2. Do not manually merge or edit export files.
3. Run dry import.
4. Run import.
5. Run verification.
6. Confirm identity links, counts, IDs, aggregates, and timestamp ranges all pass.
7. Record the final manifest checksum and verified migration-run ID.

## Enable Railway backend

Set both flags together:

```text
MUNCH_RAILWAY_DATA_ENABLED=true
MUNCH_RAILWAY_AUTH_ENABLED=true
```

Then set:

```text
MUNCH_STRICT_STARTUP_VALIDATION=true
```

Change the Railway health check to:

```text
/health/ready
```

Deploy the exact staging-certified commit. A mixed backend state is not an acceptable intermediate step.

## Immediate production certification

Run:

```text
MUNCH_CERT_ACCESS_TOKEN=<production-test-token> \
bun run certify:staging \
  --base-url=https://<production-domain> \
  --require-authenticated
```

Then complete a production smoke account flow:

1. New account passwordless login.
2. Production Stripe Checkout using an approved low-cost/testable method.
3. OAuth return to the MCP client.
4. Search a generic food.
5. Search a packaged food.
6. Create, prepare, and confirm a meal draft.
7. Read the meal summary.
8. Export history.
9. Revoke and reconnect the MCP connection.
10. Delete the production smoke account.

Confirm Stripe webhook reconciliation and no duplicate subscription record.

## Reopen traffic

Reopen production only after:

- `/health/ready` is 200;
- authenticated MCP certification passes;
- production smoke writes and reads pass;
- Stripe webhooks are current;
- no migration mismatch exists;
- logs show no credential or nutrition payload leakage;
- error and latency rates are normal.

## Rollback triggers

Rollback immediately for:

- cross-tenant access or ownership mismatch;
- OAuth registration, authorization, token, or refresh failure affecting normal clients;
- lost or duplicated nutrition writes;
- failed Stripe entitlement enforcement;
- sustained readiness failure;
- an unexpected inability to export or delete user data;
- any security or privacy incident.

## Rollback procedure

1. Stop new Railway writes.
2. Preserve Railway database and logs unchanged for investigation.
3. Record the rollback timestamp and last successful Railway write.
4. Set both Railway backend flags false together.
5. Disable strict startup validation only if required by the inherited configuration.
6. Restore the inherited Railway service configuration and health path.
7. Deploy the previously known-good inherited commit/configuration.
8. Verify inherited OAuth, meal reads, and a controlled write.
9. Reopen inherited traffic.
10. Reconcile Railway-only writes before another cutover attempt.

Do not allow both systems to accept writes simultaneously during rollback.

## Post-cutover observation

For the first 24 hours monitor:

- readiness and restart count;
- OAuth registration and callback errors;
- access/refresh token failures;
- MCP tool failures and latency;
- database connections, CPU, storage, and locks;
- Stripe webhook retries and subscription mismatches;
- login email delivery;
- export and deletion failures.

Retain the inherited backend and final export unchanged for the approved rollback window. Securely dispose of migration files only after the rollback window closes and the deletion is documented.
