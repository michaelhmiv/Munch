# ADR-0009: Canonical Better Auth and PostgreSQL baseline

- Status: Accepted
- Date: 2026-08-18
- Supersedes: ADR-0002 authentication implementation details, ADR-0004, ADR-0005, and ADR-0007 coherent data selector

## Context

Munch previously carried two complete authentication/OAuth implementations and temporary data-plane selectors so the Railway migration could be rolled back. The rollback window ended, but the compatibility code, tables, environment flags, tests, maintenance queries, and documentation remained. That created two competing definitions of a connection and allowed production behavior to diverge from CI fixtures.

## Decision

Munch has one production generation:

- Railway PostgreSQL is the only persistence layer.
- `munch.users.id` is the stable business identity for nutrition, household, billing, export, and audit ownership.
- Better Auth is the only browser authentication implementation.
- Better Auth OAuth Provider is the only OAuth authorization server for ChatGPT and other MCP clients.
- Fresh databases are constructed from `db/schema/`; historical migration replay is not part of a new installation.
- Existing pre-baseline databases use the one-time bridge in `db/legacy-bridge/` to preserve business rows while resetting transient authentication credentials and removing retired authentication/OAuth objects.
- Runtime backend selectors and rollback environment flags do not exist.

## Authentication and OAuth model

Browser sessions, verification records, OAuth clients, OAuth grants, refresh-token state, access-token metadata, and signing keys are stored only in the canonical Better Auth tables. MCP bearer authentication verifies Better Auth resource tokens. The application never falls back to a custom token lookup.

Website connection management is derived from Better Auth OAuth consent/client/token state. A connection is identified by the Better Auth consent grant, not by the former custom token-family identifier. Revocation operates only on Better Auth state.

Generic opaque capabilities used for short-lived export downloads are application security primitives, not authentication credentials, and live outside the auth implementation.

## Schema and data preservation

The canonical schema must be sufficient to build an empty production-equivalent PostgreSQL database without replaying retired architecture. The pre-baseline bridge must preserve stable user UUIDs and business records, including meals, meal items, goals, preferences, saved foods, recipes, plans, groceries, households, Stripe mappings, subscriptions, and entitlements.

The bridge intentionally resets transient authentication state. Users sign in and reconnect clients after the cutover so every surviving credential was issued by the canonical stack.

## Configuration

Production startup validation is unconditional. Required configuration is validated before the server starts. There is no auth-backend selector, Railway-auth selector, Railway-data selector, custom session secret, or custom login-delivery adapter.

## Verification

CI must fail if active runtime, scripts, workflows, schema, or example configuration reference retired auth/data-plane objects or selectors. CI also verifies:

- fresh canonical schema installation and idempotency;
- business-data preservation through the pre-baseline bridge;
- Better Auth schema compatibility;
- dynamic OAuth registration and browser authorization;
- MCP initialization and tool discovery with Better Auth resource tokens;
- Better Auth connection listing and revocation;
- account deletion, export, RLS, household, recipe, planning, grocery, and nutrition persistence behavior;
- production container build.

Historical ADRs remain in Git history and may remain in this directory when marked superseded, but they are not deployment instructions.
