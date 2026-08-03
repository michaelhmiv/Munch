# Munch staging certification

Munch must pass this matrix in a dedicated Railway staging environment before production backend flags are enabled.

## Staging environment

Use separate resources from production:

- Railway service and PostgreSQL database;
- Stripe test-mode product, price, customer, and webhook secret;
- transactional email test destination or approved staging delivery adapter;
- staging public domain;
- USDA API key and identifying Open Food Facts User-Agent;
- no production nutrition data.

Required backend settings:

```text
MUNCH_RAILWAY_AUTH_ENABLED=true
MUNCH_RAILWAY_DATA_ENABLED=true
MUNCH_STRICT_STARTUP_VALIDATION=true
```

The staging Railway health check must use `/health/ready`.

## Automated public and MCP contract probe

Without an access token, validate public deployment surfaces:

```text
bun run certify:staging --base-url=https://<staging-domain>
```

After completing the staging OAuth connection and obtaining a staging access token, validate the authenticated MCP contract:

```text
MUNCH_CERT_ACCESS_TOKEN=<staging-token> \
bun run certify:staging \
  --base-url=https://<staging-domain> \
  --require-authenticated
```

The authenticated probe checks:

- liveness and readiness;
- OAuth protected-resource discovery;
- OAuth authorization-server discovery;
- MCP initialization;
- the complete tool list;
- required commercial tools;
- duplicate tool names;
- minimum expected tool count.

Do not paste access tokens into issue comments, pull requests, screenshots, shell history, or logs. Prefer an ephemeral environment variable in a restricted terminal.

## Browser onboarding and Stripe

Perform these tests using a new email address:

1. Begin OAuth authorization from an MCP client.
2. Confirm the Munch passwordless login page preserves the pending authorization transaction.
3. Request a magic link.
4. Confirm no link or token is logged by Munch or the delivery adapter.
5. Consume the magic link once.
6. Confirm a second use is rejected.
7. Confirm the user without a subscription is routed to Stripe Checkout.
8. Complete Checkout using a Stripe test card.
9. Confirm the browser resumes the original OAuth session without requiring the webhook to arrive first.
10. Confirm the Stripe webhook later reconciles to the same customer and subscription without duplication.
11. Approve consent and return to the MCP client.
12. Confirm the account portal lists the connection.

Repeat cancellation and abandoned-checkout cases. An abandoned checkout must not issue an authorization code.

## OAuth protocol

Certify:

- dynamic client registration creates a unique client;
- only exact registered redirect URIs are accepted;
- PKCE S256 is mandatory;
- authorization codes are one-time and short-lived;
- access tokens expire as configured;
- refresh tokens rotate on every use;
- reusing an old refresh token revokes the token family;
- connection revocation invalidates access and refresh tokens;
- a canceled or expired subscription cannot mint new access through refresh;
- export and account deletion remain available after subscription expiration.

Test malformed client IDs, redirect URIs, code verifiers, authorization codes, access tokens, and refresh tokens. Responses must not expose internal SQL or secrets.

## Food providers

Certify all provider paths:

- generic USDA search;
- branded USDA search;
- Open Food Facts packaged-food search;
- exact barcode found in Open Food Facts;
- exact barcode found only in USDA;
- disagreement between sources;
- one provider unavailable while the other succeeds;
- provider rate limiting;
- product stub with no usable nutrition;
- household portion details;
- per-100-gram values;
- sodium and other milligram nutrients;
- alcoholic product with milliliter serving;
- alcoholic product without a convertible serving.

The response must display the source and must not treat missing nutrients as zero.

## Personal food memory

Certify:

1. Save a verified food with a default portion.
2. Search by its exact label.
3. Search by normalized case and punctuation variants.
4. Mark it used only after a confirmed meal.
5. Confirm usage/recency changes ranking.
6. Confirm it remains available when the external provider is unavailable.
7. Delete the saved food.
8. Confirm historical meals remain unchanged.
9. Confirm another account cannot search or access it.

## Draft and confirmation workflow

Use both text and photo-origin drafts.

1. Start a draft.
2. Add multiple structured items.
3. Add questions with different impact scores.
4. Confirm the highest-impact question appears first.
5. Attempt preparation while questions remain and confirm rejection.
6. Answer one question and verify the next advances.
7. Submit an update using a stale draft version and confirm rejection.
8. Explicitly accept remaining assumptions and confirm they are retained.
9. Prepare the final summary.
10. Attempt confirmation before explicit user consent and do not proceed.
11. Confirm after explicit consent.
12. Retry the confirmation and verify the same meal is returned.
13. Verify parent totals match item totals.
14. Cancel a separate draft and verify no meal is created.
15. Confirm another user cannot read or mutate the draft or meal.

## Core nutrition operations

Certify at least:

- direct explicit meal logging;
- idempotent duplicate retry;
- meal update and deletion;
- daily summary;
- date-range history;
- meal search;
- goals and goal progress;
- hydration logging and retrieval;
- weight logging, update, deletion, and trends;
- CSV import dry-run and commit;
- CSV export and one-hour private download;
- timezone change behavior;
- widgets enabled and disabled;
- alcohol tracking enabled and disabled;
- account deletion.

For every write tool, repeat the same request and test concurrent duplicates where supported.

## Billing lifecycle

Use Stripe test clocks or controlled test subscriptions to certify:

- trialing;
- active;
- past due within grace;
- past due after grace;
- canceled at period end;
- canceled immediately;
- unpaid;
- paused;
- webhook duplication;
- webhook out-of-order delivery;
- checkout return before webhook delivery.

Nutrition writes must be denied according to the entitlement policy without deleting existing data.

## Portal and privacy

Confirm:

- portal requires a valid HttpOnly web session;
- mutation requests from another origin are denied;
- portal, export, OAuth, and token responses are not cacheable;
- billing and connection pages do not display meal descriptions or weights;
- token values are never displayed;
- connection revocation works;
- preference changes persist;
- export capabilities are absent from access-log paths;
- account deletion requires the exact confirmation phrase;
- account deletion removes nutrition, drafts, saved foods, connections, and sessions.

## Operational checks

Confirm:

- migrations run before deployment;
- migrations are idempotent;
- `/health/live` remains healthy during dependency degradation;
- `/health/ready` becomes unhealthy for missing migrations, missing roles, disabled forced RLS, or database failure;
- the maintenance command runs successfully;
- backup and point-in-time recovery are enabled;
- a backup restore has been tested in an isolated environment;
- alerts exist for readiness, restarts, database saturation, Stripe webhooks, and login delivery.

## Exit criteria

Staging certification is complete only when:

- the automated authenticated contract probe passes;
- every manual section above has a recorded pass/fail result;
- no unresolved severity-one or severity-two issue remains;
- the final tested commit SHA is the exact commit selected for production;
- rollback steps have been reviewed;
- the production database backup is current.
