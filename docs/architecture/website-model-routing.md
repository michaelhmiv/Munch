# Website model routing

Munch uses one OpenRouter account but separates generative work from bounded decision work.

## Model roles

- `MUNCH_AI_MODEL` is the generative website model. Production remains on `qwen/qwen3.7-flash`.
- `MUNCH_DECISION_MODEL` is the bounded decision model. The default is `~typesafe/jev-latest`.
- Both use the existing `OPENROUTER_API_KEY`.
- Nutrition arithmetic, provider retrieval, portion scaling, persistence, and authorization remain deterministic application code.
- MCP clients do not use either internal website model. The connected host model owns semantic reasoning for MCP flows.

Jev is intentionally limited to choosing among already retrieved provider candidates. It cannot invent a provider food ID. Every question contains a bounded criterion set plus `NO_MATCH`, and the response is validated against that exact set.

## Recipe import routing

1. Qwen normalizes source ingredient language and may create bounded food-search queries.
2. Munch searches configured food providers.
3. A genuinely strong deterministic match is accepted without model inference.
4. Ambiguous candidate sets are batched into one OpenRouter Decisions request using Jev.
5. A Jev candidate is accepted only when it is in the supplied set and meets the configured confidence threshold.
6. Jev `NO_MATCH`, low confidence, malformed output, timeout, rate limit exhaustion, or provider failure falls back to the existing Qwen ingredient-assignment path.
7. Missing candidates, missing quantity, or missing portion remain generative Qwen work because those cases can require new text or assumptions.

A Jev outage therefore degrades toward the previous Qwen behavior instead of making recipe imports unavailable.

## Configuration

```env
OPENROUTER_API_KEY=...
MUNCH_AI_MODEL=qwen/qwen3.7-flash
MUNCH_DECISION_MODEL=~typesafe/jev-latest
MUNCH_RECIPE_DECISION_ENABLED=true
MUNCH_RECIPE_DECISION_MIN_CONFIDENCE=0.75
MUNCH_DECISION_TIMEOUT_MS=10000
```

Decision routing is disabled unless `MUNCH_RECIPE_DECISION_ENABLED` is truthy. This is the primary rollback switch.

The Jev alias uses OpenRouter's Decisions API at `/api/alpha/decisions`, not the chat-completions endpoint. Logs record both the requested alias and the resolved model returned by OpenRouter so movement of the floating alias can be correlated with production behavior.

## Rollout and rollback

Before enabling a new Jev alias/version, run the controlled candidate corpus and production recipe-hybrid benchmark. Require semantic parity, no candidate-ID violations, no meaningful order sensitivity, and no end-to-end recipe quality regression.

Rollback does not require a code change:

1. Set `MUNCH_RECIPE_DECISION_ENABLED=false` to restore the Qwen-only assignment path.
2. If only the floating alias is suspect, set `MUNCH_DECISION_MODEL` to a known-good pinned OpenRouter Jev model.
3. Re-run the controlled corpus before re-enabling the floating alias.

## Observability

Decision logs contain aggregate operational metadata only: requested/resolved model, question count, accepted/fallback counts, confidence threshold, retries, and latency. Recipe import logs continue to record aggregate phase timing and request counts. Do not add raw pantry history, full recipe content, or complete provider payloads to operational logs.
