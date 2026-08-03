# Supabase to Railway PostgreSQL migration

This migration is designed for the inherited Nutrition MCP data set and the Munch Railway schema. It copies identities, profiles, goals, meals, hydration, and weight while preserving source row IDs, timestamps, and idempotency keys.

Do not run migration files on a workstation that is not trusted to temporarily hold nutrition and account data.

## Security properties

- Export files are JSON Lines with a SHA-256 checksum per table.
- The manifest has its own checksum covering every file name, row count, and file checksum.
- The export directory and files are created with owner-only permissions where the operating system supports them.
- Authentication passwords, password hashes, access tokens, refresh tokens, and arbitrary Supabase user metadata are not exported.
- The Railway identity map is stored in owner-only tables. Application, billing, support, and MCP roles receive no access.
- Import and verification use the database-owner connection because they are controlled one-time administrative operations, not request-time application paths.

## Required environment variables

For export:

```text
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service-role-key>
```

For import and verification:

```text
DATABASE_URL=postgresql://...
```

Do not place these values in command history, repository files, logs, or migration manifests.

## Initial export

Choose a restricted output directory outside the repository:

```text
bun run migration:export --output=/secure/path/munch-export
```

To intentionally replace a prior export:

```text
bun run migration:export --output=/secure/path/munch-export --overwrite
```

The exporter paginates both Supabase Auth users and application tables.

## Validate before importing

Run a dry import. It validates manifest checksums, per-file checksums, row counts, duplicate emails, duplicate user IDs, and foreign user references without connecting to Railway:

```text
bun run migration:import --input=/secure/path/munch-export --dry-run
```

A dry run must succeed before a write import.

## Import into Railway

Apply all Munch migrations first:

```text
bun run db:migrate
```

Then import:

```text
bun run migration:import --input=/secure/path/munch-export
```

The importer is idempotent:

- users reconcile by normalized email;
- inherited user IDs map to Munch user IDs;
- profiles and goals upsert by user;
- meal, water, and weight records preserve source UUIDs and upsert by UUID;
- each execution creates an auditable migration-run record.

Re-running the same complete manifest must not duplicate nutrition records.

## Verify

```text
bun run migration:verify --input=/secure/path/munch-export
```

Verification compares:

- identity-link count and source emails;
- profile, goal, meal, water, and weight counts;
- preserved meal, water, and weight UUIDs;
- calorie, macro, hydration, and weight aggregates;
- minimum and maximum logged timestamps.

The latest matching migration run is marked `verified` only when every check passes. A mismatch returns a nonzero exit code and records `verification_failed`.

## Production cutover sequence

1. Enable Railway PostgreSQL backups and take a pre-migration snapshot.
2. Deploy the code with both backend flags still false.
3. Apply all Railway migrations.
4. Export Supabase and run dry import, import, and verification.
5. Leave the inherited service active while staging MCP certification is completed against a separate Railway environment.
6. Announce a brief write freeze for the production cutover.
7. Prevent new writes to the inherited deployment.
8. Create a new complete export. Do not reuse the earlier export as the final delta source.
9. Dry-run, import, and verify the final export.
10. Confirm `/health/ready` returns 200 in the Railway environment.
11. Enable both flags together:

```text
MUNCH_RAILWAY_DATA_ENABLED=true
MUNCH_RAILWAY_AUTH_ENABLED=true
```

12. Enable strict startup validation:

```text
MUNCH_STRICT_STARTUP_VALIDATION=true
```

13. Change the Railway health check from `/health/live` to `/health/ready`.
14. Deploy and run the live MCP certification matrix.
15. Reopen writes only after registration, OAuth, meal writes, refresh, reconnect, export, and deletion tests pass.

Never enable Railway authentication against inherited Supabase nutrition rows, or Railway nutrition rows against inherited authentication. Mixed backend states are unsupported.

## Rollback

Before the write freeze, rollback is simply leaving both backend flags false.

After the Railway cutover:

1. stop new writes;
2. preserve the Railway database unchanged for investigation;
3. set both backend flags false together;
4. restore the inherited service configuration;
5. deploy and verify inherited OAuth and meal reads;
6. reconcile any Railway-only writes before attempting another cutover.

Do not alternate active writes between both systems. Munch intentionally does not dual-write because split histories are harder to detect and repair than a controlled freeze.

## Disposal

After the migration has been verified, the rollback window has closed, and backups are confirmed:

- securely delete local export files;
- remove temporary service-role credentials from the execution environment;
- retain only the owner-protected migration run and identity-link records needed for audit and support;
- document the deletion date and operator.
