# Munch architecture decisions

Architecture decision records (ADRs) document decisions that constrain later implementation. A later ADR may supersede an earlier one, but merged ADRs are not silently rewritten to hide prior reasoning.

- [ADR-0001: Railway and PostgreSQL runtime](0001-railway-postgresql-runtime.md)
- [ADR-0002: Munch identity, MCP OAuth, and Stripe entitlements](0002-identity-oauth-stripe.md) — superseded by ADR-0009
- [ADR-0003: Multi-tenant isolation and administrative privacy](0003-tenant-isolation-privacy.md)
- [ADR-0004: Railway-native MCP OAuth token lifecycle](0004-oauth-token-lifecycle.md) — superseded by ADR-0009
- [ADR-0005: Staged Railway OAuth route cutover](0005-oauth-route-cutover.md) — superseded by ADR-0009
- [ADR-0006: Railway-native nutrition core](0006-railway-nutrition-core.md)
- [ADR-0007: Coherent Railway data backend selector](0007-coherent-data-selector.md) — superseded by ADR-0009
- [ADR-0007: Stable MCP catalog and invocation-time feature access](0007-mcp-catalog-entitlement-boundary.md)
- [ADR-0008: Atomic meal review](0008-atomic-meal-review.md)
- [ADR-0009: Canonical Better Auth and PostgreSQL baseline](0009-canonical-better-auth-postgresql-baseline.md)
- [ADR-0010: Canonical user data contracts](0010-canonical-user-data-contracts.md)
- [ADR-0011: Cross-surface capability contracts](0011-cross-surface-capability-contracts.md)

## Current non-negotiable boundaries

- Railway PostgreSQL is the only production system of record.
- `munch.users.id` is the stable business identity.
- Better Auth is the only browser authentication and OAuth implementation.
- ChatGPT or another MCP host performs language and image reasoning.
- Munch authenticates requests, retrieves food data, validates writes, stores records, and calculates deterministic results.
- Stripe is the billing authority, not the authentication system.
- User identity is derived from a verified Better Auth session or MCP resource token.
- User-owned tables are protected by row-level security.
- Routine support and billing tooling cannot display nutrition record contents.
- Raw nutrition payloads are excluded from application logs and analytics.
- Fresh databases are constructed from `db/schema/`; retired architecture is not replayed.
- User-facing facts and derived values have canonical domain owners; renderers must not establish alternate business semantics.
- Outcome capabilities are tracked across MCP and the website; new MCP tools require an explicit parity mapping or a documented channel exception.
