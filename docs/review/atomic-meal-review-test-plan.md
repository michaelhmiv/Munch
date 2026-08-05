# Atomic meal review test plan

## Automated gates

- Production TypeScript partitions compile without errors.
- Full Bun unit test suite passes.
- Widget templates assemble into self-contained HTML.
- Photo-policy tests enforce inference-first review and explicit confirmation.
- Migration 0024 applies twice without error.
- Atomic smoke test covers complete review creation, request idempotency, stale-version rejection, question resolution, structured totals, confirmation idempotency, cancellation, and RLS isolation.
- Benchmark compares legacy and atomic paths against the same PostgreSQL instance and fixture.
- Production Docker image builds successfully.

## Production verification

- Migration 0024 is applied by the existing Railway pre-deploy migration command.
- `/health/live` succeeds after deployment.
- OAuth token exchange, JWKS, and MCP discovery continue returning HTTP 200.
- `prepare_meal_review` and `resolve_meal_review` are discoverable.
- A disposable benchmark run records same-environment legacy and atomic timings and removes its temporary users.
- Railway configuration is restored after measurement.

## Rollback

Revert the application commit or disable preference for the atomic tools. The nullable `request_id` column and unique partial index may remain safely in place. Existing granular draft tools and confirmed meal records remain compatible.
