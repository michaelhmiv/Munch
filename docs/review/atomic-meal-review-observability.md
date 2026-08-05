# Meal review observability boundaries

Permitted operational fields include opaque request, workflow, draft, and user identifiers; operation and tool names; source mode; elapsed milliseconds; item and question counts; cache status; provider name; success state; and normalized error code.

Operational logs must not include image bytes, image URLs carrying credentials, raw meal descriptions, notes, user answers, provider response bodies, or serialized item snapshots.

The initial implementation emits concise server-side review-operation timings. Broader model/image latency must be measured only when a correlated platform signal exists; it must not be estimated from database timings.
