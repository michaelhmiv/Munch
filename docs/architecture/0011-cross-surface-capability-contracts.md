# ADR-0011: Cross-surface capability contracts

Status: Accepted

## Context

Munch has a richer MCP surface than its website. Comparing the two surfaces by
counting tools creates the wrong product requirement: several MCP tools often
form one customer workflow, while billing, account controls, and household
administration are intentionally website-centric.

The absence of a durable capability contract also makes drift easy. A new MCP
tool can be added and deployed without a corresponding website path, without a
documented channel exception, and without an explicit owner for the gap.

## Decision

`src/capability-manifest.ts` is the canonical outcome-parity manifest. Each
capability declares:

- whether MCP and the website expose it;
- whether the current coverage is complete, partial, or missing;
- the concrete entry points for each surface;
- an intentional channel exception when the capability belongs to one surface;
- a plain-language gap description; and
- the focused PR that owns an incomplete path.

The manifest is intentionally organized around customer outcomes such as
`food.search`, `meal.create`, and `nutrition.trends`, not around the number of
registered MCP tools.

Every literal MCP `registerTool(...)` call is checked in CI against
`MCP_TOOL_CAPABILITY_MAP`. An unclassified tool or a stale mapping fails the
build. This prevents a new MCP capability from silently bypassing the parity
review. Future dynamic registration must add an equivalent explicit contract
and test rather than bypassing this check.

Known gaps remain visible while they are being implemented. They are not
treated as intentional exceptions: each has a target PR. The first commercial
standalone milestone is PRs 1–6; PRs 7–9 complete analytical and record
management parity, and standalone AI entry remains an optional later layer.

## Consequences

- Website and MCP work can be reviewed against one customer-outcome checklist.
- A missing website workflow is visible without creating a one-screen-per-tool
  UI.
- Website-only billing and account administration remain explicit exceptions,
  not accidental parity failures.
- Adding an MCP tool now requires a capability assignment and a decision about
  its website path before CI can pass.
