# Munch current test audit

**Audit date:** 2026-10-09  
**Repository snapshot:** `main` at `2caea81e5a2455b2db8fdffc01f521ef3b97ff4b`
**Scope:** Test-file and workflow inventory, representative contract/auth/domain tests, a measured Bun/LCOV baseline, and recent Actions results. This is a codebase-wide test-system audit, not a line-by-line review of every test assertion.

## Executive summary

Munch has a strong server-side test foundation: a Bun unit suite, static architecture and policy checks, broad PostgreSQL 17 smoke/integration scenarios, tenant/household RLS checks, idempotency and migration checks, auth workflows, and a production-container build. CI runs most of these for pull requests and pushes to `main`.

The measured baseline is 48.34% LCOV line coverage and 61.00% LCOV function coverage across 142 instrumented source files. Coverage is concentrated in pure modules; several persistence-heavy modules remain lightly exercised at the unit layer. An 80% per-file line floor now applies to new shared `src/guidance/` domain modules. A Chromium E2E harness signs into the real website against isolated PostgreSQL on desktop and mobile viewports, verifies that an unauthenticated API is blocked, and visits Today, Plan, and Insights.

The remaining high-risk gaps are broader browser journeys and persisted cross-surface parity. Extend the E2E harness alongside each feature to cover profile editing, plan confirmation, generated recipes, swaps, weekly review, goal approval, grocery confirmation, export, and deletion against the same database state. Use deterministic proposal fixtures for normal PRs and reserve live-model evaluation for controlled scheduled/manual runs.

## Existing test inventory

| Layer                                  | What runs                                                                                                                                                                                              | Trigger and current assessment                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Unit and architecture                  | `bun test`; 112 JavaScript/TypeScript `*.test.*` files found in the repository snapshot. Includes nutrition calculations, insights, auth, recipes, platform behavior and architecture boundaries.      | PR and `main` CI. Text and LCOV reports are emitted; an 80% per-file line floor gates new shared guided-nutrition domain files. |
| Static quality and contracts           | `bun run format:check`, `bun run typecheck`, capability-manifest check, commerce boundary, OpenAI submission/policy/widget-CSP audits, responsive UI smoke, Pantry UI smoke and widget-contract smoke. | PR and `main` CI. Useful fast regression checks; they do not substitute for running the UI in a browser.                        |
| PostgreSQL integration                 | Fresh PostgreSQL 17 schema install, second migration run for idempotency, Better Auth schema/OAuth/session checks, reviewer-account readiness, and feature smoke scripts. See coverage map below.      | PR and `main` CI. Strong coverage of persistence, RLS, lifecycle and selected performance paths.                                |
| Production build                       | Docker production image build.                                                                                                                                                                         | PR and `main` CI. Validates image construction; it is not a deployed-service smoke test.                                        |
| OAuth and mobile authentication        | Better Auth OAuth/session HTTP smoke; mobile bearer-session and browser-CSRF separation smoke.                                                                                                         | Separate PR and `main` workflows. These verify protocol/server behavior, not a human-operated browser UI journey.               |
| Android                                | Build local mobile web bundle, sync Capacitor, verify generated project reproducibility, Gradle lint, native unit tests and debug APK artifact.                                                        | Separate PR and `main` workflow. No emulator/device UI journey was found.                                                       |
| Website browser journeys               | Playwright Chromium E2E on isolated PostgreSQL; password sign-in, unauthenticated API denial, Today workspace, Plan/Insights routes, desktop and mobile viewport overflow check.                       | Separate PR and `main` CI job. This is a starting smoke path, not full guided-nutrition parity certification.                   |
| External corpora and production checks | Live recipe-import and AI-provider corpus workflows, USDA corpus workflow, and production certification.                                                                                               | Manual and/or scheduled workflows; not all are required PR gates.                                                               |

The primary scripts are `test: bun test`, `format:check` and `typecheck` in `package.json`. CI uses Bun 1 and a frozen lockfile.

## Capability-to-test map

| Product area                              | Existing evidence                                                                                                                                                                                       | Coverage limits                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nutrition logging, totals and history     | Unit tests; `nutrition-platform-smoke.ts` and `structured-meal-smoke.ts` cover persistence, idempotency and RLS. The insights suite exercises trends, patterns, missing nutrients and weekly summaries. | No measured line/branch coverage. Historical goal revision behavior is not a broad cross-surface journey.                                        |
| Auth, OAuth and sessions                  | Better Auth schema, dynamic OAuth client, connection listing/revocation, account deletion, reviewer readiness, OAuth HTTP smoke and mobile bearer-session smoke.                                        | The workflow named “OAuth browser smoke” runs an in-process Hono server over HTTP; it does not launch a real browser.                            |
| Food catalog and recipe import            | Catalog ingestion/cache/freshness/idempotency smoke; import-save-readback-meal-log roundtrip; scheduled/manual recipe corpus.                                                                           | Live provider behavior is not a deterministic per-PR gate; corpus breadth and output artifacts should be reviewed as part of the baseline phase. |
| Recipes, planning and groceries           | `recipe-planning-smoke.ts` covers persisted recipes/plans/groceries, idempotency and RLS. `meal-drafts-smoke.ts` covers draft state and confirmation.                                                   | Existing tests are server-side scenarios; they do not verify equivalent website and MCP user flows against the same account.                     |
| Cooks and Pantry                          | Cooks persistence/media/timeline/RLS/side-effect smoke; Pantry inventory/receipt reconciliation/RLS and planning-profile/ranking smoke; Pantry UI static smoke.                                         | No real browser tests for the web surfaces; no device flow.                                                                                      |
| Households, privacy and account lifecycle | Household RLS and lifecycle smoke; complete account export and deletion/cascade checks, including shared Pantry retention.                                                                              | High-value server and database coverage; user-facing export/deletion journey is not covered by a browser E2E suite.                              |
| MCP↔website contracts                     | `src/capability-manifest.test.ts` validates the manifest and documents 90 MCP tools. `src/cross-surface-parity.test.ts` compares totals, missing-nutrient semantics and inclusive date ranges.          | Current parity tests use shared in-memory fixtures and cover a narrow calculation set, not actual persisted cross-surface reads and writes.      |
| AI boundary and widgets                   | `src/host-ai-boundary.test.ts` prevents website provider clients/credentials from entering the MCP dependency graph and checks deterministic recipe preview. Widget contract and CSP audits run in CI.  | These protect architecture and static contracts; they do not measure proposal quality or exercise the widget in every host/device context.       |
| Mobile                                    | Mobile shell smoke, capability declarations, mobile bearer-session workflow, Android lint/unit-test/build.                                                                                              | Android has no emulator journey; iOS/device certification was not found.                                                                         |
| Operations and deployable artifact        | Operations/readiness smoke, database benchmarks and Docker build. Production certification is separately available.                                                                                     | Production certification is a manual release activity; no automatic post-deploy certification trigger was found in the reviewed workflows.       |

## Priority gaps and actions for this implementation

### P0 — required before guided-nutrition release

1. **Measured coverage baseline (done for PR -1).** CI uploads LCOV and prints text coverage. Each new `src/guidance/` file must meet 80% line coverage. Persistence, authorization, idempotency, and privacy still require behavior-oriented database tests; line coverage does not replace those.
2. **Exercise the real website (in progress).** The initial authenticated Chromium path runs at desktop and mobile viewports. Extend it alongside each feature to cover profile editing and the highest-risk planning, recipe, swap, check-in, grocery-confirmation, export, and deletion journeys.
3. **Prove persisted parity.** Use the same test account and database: write a preference or plan through one surface, read/edit it from the other, then verify committed state and permissions in both. Matching fixtures alone are insufficient.
4. **Test deterministic planning safety.** Unit/contract tests must cover allergies and unknown ingredients, dislikes versus hard exclusions, equipment and time constraints, nutrition completeness/provenance, saved/recent duplicate avoidance, variety, generated-recipe edits, manual fallback, and no implicit meal logging or grocery writes.
5. **Test persistence and authorization.** PostgreSQL tests must cover migrations, ownership/RLS, household changes, idempotent commits, stale versions, rollback, separate grocery confirmation, deletion/export and privacy boundaries.

### P1 — add to the release-quality roadmap

- Keep live-model tests isolated from normal PR CI. Add reproducible fixtures and a scheduled/manual evaluation corpus for malformed output, injected recipe text, allergy violations, weak variety, bad nutrition claims, timeouts, spend caps and fallback behavior.
- Review whether Android is a supported release surface for these outcomes. If it is, add a representative emulator/device journey; otherwise keep its coverage status explicitly build-only.
- Define and run post-deploy identity/health certification against the exact deployed SHA before enabling the feature cohort.
- Preserve static UI, capability, widget-CSP, privacy and model-boundary checks as fast independent layers.

## Baseline run evidence

Local checks run on 2026-10-09 at `2caea81e5a2455b2db8fdffc01f521ef3b97ff4b` with Bun 1.4.2:

- `bun run format:check`: passed.
- `bun run typecheck`: passed.
- `bun run submission:check`: passed for 95 exposed tools. Existing non-blocking warning: `run_munch_action` returns text only and has no `outputSchema`.
- `bun test --coverage --coverage-reporter=text --coverage-reporter=lcov`: 742 passed, 0 failed, 3,265 expectations across 112 files.
- LCOV source totals: 17,906 covered lines out of 37,039 (48.34%); 1,023 covered functions out of 1,677 (61.00%) across 142 instrumented files. These totals come from summed LCOV records, not an average of per-file percentages.
- Docker and a local PostgreSQL server were not available, so database smoke scripts and the container build were not rerun locally on this snapshot. They remain enforced in GitHub Actions.
- The Playwright journey is configured to run against a fresh PostgreSQL service in this implementation PR. No local browser E2E pass is claimed until that CI job completes.

- Main CI passed on `4f025dc` (2026-09-17): https://github.com/michaelhmiv/Munch/actions/runs/35177767237
- USDA corpus passed on 2026-10-05: https://github.com/michaelhmiv/Munch/actions/runs/37346645204
- PR #153 initially stopped at formatting; that was corrected. On PR head `99ceacd5eb07a5b5c9ee99446c6b1633b56ca7ac`, CI run 1101 passed quality (including typecheck and `bun test`), PostgreSQL integration and container build. OAuth browser-smoke run 876 and mobile-auth run 147 passed. Android run 133 was still running when this audit was captured: https://github.com/michaelhmiv/Munch/actions/runs/37920380879

The next commit that adds this audit document will trigger a new PR validation run. Check its result on PR #153 before treating the audit-document commit itself as validated.

## Method and limitations

This audit reviewed the repository tree, `package.json`, primary CI and mobile/auth workflows, representative parity/capability/host-boundary tests, Actions run evidence, and a full local Bun coverage run. The 112 count is a file inventory, not a claim that every file has meaningful assertions or that each file passes independently. The audit did not run every workflow locally, inspect every assertion, assess production data, or certify the live website. Browser tests use isolated test data and do not exercise production.
