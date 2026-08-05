# ADR 0008: Atomic meal review workflow

## Status

Accepted for implementation.

## Context

The original meal-draft API exposed draft creation, per-item upserts, question creation and answering, preparation, and confirmation as separate model-visible mutations. The transaction safeguards were correct, but ordinary photo logging incurred several avoidable MCP/model round trips.

## Decision

Munch exposes `prepare_meal_review` for complete initial review creation and `resolve_meal_review` for atomic answers and edits. Both operations retain row-level security, draft locking, optimistic versions, validation, and tenant-scoped idempotency. Final persistence remains a separate explicit `confirm_meal_draft` call.

The inference policy defaults visually unbranded plated meals to homemade, uses visible scale references, and asks only materially consequential questions. Low-impact uncertainty is presented as an assumption in the review.

The existing granular draft tools remain available for compatibility but are not the preferred path for ordinary photo logging.

## Consequences

- Clear photo review preparation falls from five server mutations to one.
- A representative one-question path falls from seven server mutations to two.
- Confirmation safety and idempotency are unchanged.
- The review widget becomes the primary confirm/edit/cancel surface.
- Server-path benchmarks are kept distinct from image-model and human-response latency.
