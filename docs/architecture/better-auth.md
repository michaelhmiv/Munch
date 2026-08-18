# Better Auth boundary

Munch uses Better Auth for browser identity, magic-link authentication, and the OAuth authorization-server lifecycle used by ChatGPT and other MCP clients. There is no fallback authentication or OAuth implementation.

The stable business identity remains `munch.users.id`. Nutrition rows, Stripe customers and subscriptions, preferences, exports, deletion, households, and audit ownership reference that UUID. Better Auth is the authentication implementation, not the owner of Munch business data.

## Public authentication

- Magic links are the public sign-in mechanism.
- A previously unseen normalized email may create its Munch account through the Better Auth flow.
- Public password signup is disabled.
- Social providers are not enabled at launch.
- Verification records are short-lived and single use.
- Magic-link redemption remains scanner-safe.
- Transactional delivery uses Resend directly.
- Marketplace reviewer credentials are separately provisioned and are not a public signup path.

## OAuth and MCP

Better Auth OAuth Provider owns dynamic client registration, authorization, consent, token issuance/refresh, and OAuth client metadata. MCP bearer authentication accepts only Better Auth resource tokens. Connection management reads Better Auth consent/client/token state and revokes Better Auth grants; it does not consult legacy token-family tables.

## Production configuration

`main` is the production release branch. GitHub CI validates pull requests and pushes to `main`; Railway watches `main` and deploys merged commits automatically.

Production startup validation is unconditional and requires the canonical application origin, Better Auth secret, Resend sender configuration, Railway PostgreSQL, Stripe configuration, Open Food Facts user agent, and USDA API key. No auth-backend selector, Railway-auth selector, custom session secret, or custom login-delivery adapter exists.

Secrets are server-only and must not be returned to browsers or written to application logs.

## Database rules

- Fresh databases are constructed from the canonical files in `db/schema/`.
- The one-time `db/legacy-bridge/` path exists only to retire a pre-baseline database while preserving business rows.
- Better Auth runtime database access uses the restricted `munch_auth` role.
- Better Auth schema compatibility is checked in CI against the pinned dependency version.
- Public password signup remains disabled even though provisioned reviewer credentials may use Better Auth's credential account support.
