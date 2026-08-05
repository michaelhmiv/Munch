# Atomic meal review performance contract

This change measures server-side workflow overhead separately from image interpretation and user response time.

## Comparable workflows

- Clear meal review before confirmation: legacy draft creation plus three item upserts plus confirmation preparation (5 server mutations) versus one atomic `prepare_meal_review` mutation.
- One-question meal review before confirmation: legacy creation, three item upserts, question creation, answer, and preparation (7 server mutations) versus atomic preparation plus one `resolve_meal_review` mutation (2 server mutations).
- Final confirmation remains a separate explicit, idempotent transaction in both paths.

## Reported metrics

The benchmark runs both implementations against the same PostgreSQL instance, process, fixture, and iteration count. It reports minimum, median, p95, maximum, and mean elapsed time. Temporary benchmark users are deleted after measurement.

These timings do not include model image inference, network latency between ChatGPT and Munch, or time waiting for the user to approve the review. Those layers require correlated production workflow telemetry and must not be inferred from database-path measurements.

## Privacy

Latency events contain operation names, durations, counts, cache status, and opaque identifiers only. They do not contain image bytes, raw meal descriptions, notes, question answers, or provider payloads.
