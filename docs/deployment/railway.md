# Railway deployment foundation

Munch uses one Railway project containing the API/MCP service and one PostgreSQL service. Railway PostgreSQL is the only persistence layer and Better Auth is the only authentication/OAuth implementation.

## Services

1. Create a Railway project.
2. Add a PostgreSQL service.
3. Add the Munch service from the `michaelhmiv/Munch` GitHub repository.
4. Railway reads [`railway.json`](../../railway.json), builds the production Dockerfile, runs `bun run db:migrate` as the pre-deploy command, and checks `/health/live`.

## Required variables

Set these on the Munch service:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
MUNCH_APP_BASE_URL=https://<munch-domain>
MUNCH_DB_POOL_SIZE=10
MUNCH_AUTH_DB_POOL_SIZE=5
BETTER_AUTH_SECRET=<at-least-32-random-characters>
MUNCH_MAGIC_LINK_TTL_SECONDS=600
RESEND_API_KEY=re_...
MUNCH_EMAIL_FROM=Munch <sign-in@verified-domain>
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
STRIPE_HOUSEHOLD_MEMBER_PRICE_ID=price_...
OFF_USER_AGENT=Munch (<support-contact>)
USDA_FDC_API_KEY=<production-key>
```

Food-catalog cache behavior may be tuned with the `MUNCH_FOOD_CATALOG_*` variables documented in [`.env.example`](../../.env.example). Keep secrets server-only.

## Optional website recipe AI

The standalone website can use OpenRouter to interpret recipe ingredient language before it searches the configured food providers. These variables are optional; without `OPENROUTER_API_KEY`, website imports fall back to deterministic parsing and provider matching. MCP/ChatGPT imports never use this backend AI path because the connected model performs the semantic interpretation itself.

```text
OPENROUTER_API_KEY=<server-only-key>
MUNCH_RECIPE_IMPORT_AI_ENABLED=true
MUNCH_RECIPE_IMPORT_AI_BASE_URL=https://openrouter.ai/api/v1
MUNCH_RECIPE_IMPORT_AI_MODEL=openai/gpt-5.6-luna
MUNCH_RECIPE_IMPORT_AI_TIMEOUT_MS=10000
MUNCH_RECIPE_IMPORT_AI_MAX_TOKENS=4000
MUNCH_RECIPE_IMPORT_AI_MAX_CALLS_PER_IMPORT=2
MUNCH_RECIPE_IMPORT_AI_RESPONSE_HEALING=true
MUNCH_RECIPE_IMPORT_AI_RESPONSE_FORMAT=json_schema
```

`MUNCH_RECIPE_IMPORT_AI_MODEL` is the model switch; changing it does not require code changes. The resolver is bounded to two calls per import, uses at most two food-search queries per ingredient, sends uncertain rows through one batched assignment prompt, and never accepts model-generated food IDs or nutrition values. `MUNCH_RECIPE_IMPORT_AI_RESPONSE_HEALING` explicitly enables OpenRouter Response Healing, while `MUNCH_RECIPE_IMPORT_AI_RESPONSE_FORMAT` can be changed to `json_object` for models that do not support strict JSON Schema output. The default AI timeout is 10 seconds; override `MUNCH_RECIPE_IMPORT_AI_TIMEOUT_MS` when testing another model. Production logs include safe phase timings under `[recipe_import]` and `[recipe_import_ai]` without recipe text, URLs, nutrition payloads, or secrets.

The live OpenRouter smoke is intentionally manual-only. Run **Actions → Manual OpenRouter Recipe Smoke → Run workflow** when validating a key, model, response format, or Response Healing configuration; ordinary pull requests use mocked resolver tests and never spend OpenRouter credits.

There is no authentication-backend selector, Railway-auth selector, Railway-data selector, custom Munch session secret, or custom login-delivery endpoint.

## Database baseline

`bun run db:migrate` supports exactly two initialization states:

- An empty database is constructed from the canonical modules in `db/schema/` and receives the current schema-generation marker.
- A pre-baseline Munch database that already contains `munch.users` but has no schema-generation marker runs the one-time `db/legacy-bridge/retire-prebaseline-auth.sql` bridge. The bridge preserves business rows and stable user UUIDs while resetting transient authentication state and removing retired custom auth/OAuth objects.

After a database has the canonical schema-generation marker, deploys apply only immutable numbered files from `db/updates/`. Applied update checksums are verified on every deployment.

Do not manually replay the removed historical migrations into a new database.

## Better Auth and Resend

Public sign-in uses Better Auth magic links delivered directly through Resend. The sender domain configured by `MUNCH_EMAIL_FROM` must be verified for production delivery.

ChatGPT and other MCP clients use Better Auth OAuth Provider for dynamic registration, authorization, consent, token issuance/refresh, and resource-token validation. A deployment must not expose a second OAuth implementation.

## Stripe configuration

Create the recurring Stripe prices used by the owner plan and paid household seats, then configure `STRIPE_PRICE_ID` and `STRIPE_HOUSEHOLD_MEMBER_PRICE_ID`.

Configure the Stripe webhook endpoint as:

```text
https://<munch-domain>/webhooks/stripe
```

Subscribe to the events required by the billing implementation, including subscription creation, update, deletion, pause/resume, and completed checkout. Stripe remains the billing authority; Munch stores the local billing state needed for entitlements and reconciliation.

## Deployment safety

- Treat any pre-deploy migration failure as a blocked deployment.
- Do not bypass startup configuration validation to force an unhealthy release online.
- Do not use the database-owner connection for routine user/service queries outside the role-scoped database helpers.
- Do not expose PostgreSQL publicly unless operationally necessary.
- Never log Stripe secrets, database URLs, magic links, OAuth credentials, export capabilities, or nutrition payloads.
- Enable Railway PostgreSQL backups and test restoration before accepting production users.
- A rebaseline deployment intentionally invalidates transient sessions/OAuth credentials; affected users sign in and reconnect after the cutover while business data remains attached to the same `munch.users.id`.
