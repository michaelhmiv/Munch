# ADR-0007: Stable MCP catalog and invocation-time feature access

- Status: Accepted
- Date: 2026-08-18
- Supersedes: the billing gate in ADR-0005's staged Railway OAuth flow

## Decision

Munch authentication establishes an MCP connection for every valid Munch
account. The MCP server registers one stable catalog of core, recipe, planning,
grocery, saved-food, and meal tools for every connection. Feature access is
checked when a tool is invoked, using the authenticated Munch user and current
capability state.

The connection surface must not become a billing surface. OAuth consent and MCP
responses do not display prices, start checkout, or tell a user to purchase a
different plan. A feature that is unavailable for the current connection
returns a neutral tool error. `get_connection_status` provides the connected
Munch account email and factual feature-group availability so a client can
diagnose an account mismatch without asking the user to sign in repeatedly.

Capability lookup failures fail closed for gated writes and reads but do not
remove the tool catalog or strand the authenticated connection. The server logs
the internal resolution failure for operations diagnosis; normal MCP output
does not expose internal user IDs, billing records, or entitlement sources.

## Consequences

- MCP hosts can cache a consistent tool list across Free, Premium, household,
  and temporarily degraded capability states.
- Existing connections do not need to be recreated when billing state changes.
- A client that already cached a pre-ADR-0007 catalog may need one final refresh
  to learn the newly stable tools and `get_connection_status`.
- Database row-level security remains the data boundary; capability guards are
  an additional product-access boundary, not a replacement for RLS.
- Web account settings and OAuth consent identify the active Munch email so the
  user can compare it with the account whose records they expect.
