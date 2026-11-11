# Vision model bake-off — Layer 1 (identify only)

Run: 2026-11-11T12:19:39.014Z · Fixture set: fixtures/photo-eval-real · Fixtures: 1 · Repeats: 1 · Tasks per model: 1 · Total computed spend: $0.0132

Every model ran the production identify path (same prompt, schema, reasoning params); only the model slug varied — with ONE disclosed exception: a model whose endpoint rejects the production request shape outright is measured through the bake-off-only request accommodation recorded in report.json (request_accommodations), which rewrites only the rejected field; its cost/time include whatever that shape makes it spend. Cost = token usage × catalog prices (see report.json). Accuracy uses scoring.ts name matching; failed/timed-out tasks count as zero-recall in the headline recall (see recallCompletedTasksOnly in report.json for the completed-only figure).

> **Caveat:** The fixture set is REAL photographs from openly licensed sources (per-photo provenance in the set's manifest.json). Expectations are conservative — only items a careful human can clearly see are expected, and portions are scored only where the photo honestly supports a range (portion: null = unscored) — so these scores are photographic accuracy evidence on this set, still a small sample (see the set README).

| Rank | Model | Cost/task | Median | p95 | Recall | Precision | Portion in range | Extra items | Failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen/qwen3.5-9b | $0.00031 | 4,305 ms | 4,305 ms | 100.0% | 100.0% | 100.0% (4/4) | 0 | 0/1 |
| 2 | openai/gpt-4o | $0.00462 | 2,561 ms | 2,561 ms | 100.0% | 100.0% | 100.0% (3/3) | 0 | 0/1 |
| 3 | openai/gpt-4o-mini | $0.00399 | 3,686 ms | 3,686 ms | 100.0% | 100.0% | 100.0% (4/4) | 0 | 0/1 |
| 4 | qwen/qwen3-vl-8b-instruct | $0.00050 | 11,696 ms | 11,696 ms | 60.0% | 60.0% | 100.0% (1/1) | 2 | 0/1 |
| 5 | anthropic/claude-haiku-4.5 | $0.00305 | 6,223 ms | 6,223 ms | 60.0% | 60.0% | 100.0% (2/2) | 2 | 0/1 |
| 6 | anthropic/claude-haiku-5.5 | $0.00039 | 3,521 ms | 3,521 ms | 60.0% | 60.0% | 100.0% (2/2) | 2 | 0/1 |
| 7 | qwen/qwen3.8-flash | $0.00036 | 12,559 ms | 12,559 ms | 60.0% | 50.0% | 50.0% (1/2) | 3 | 0/1 |
| 8 | google/gemini-3.1-flash-lite | $0.00000 | n/a | n/a | 0.0% | n/a | n/a (0/0) | 0 | 1/1 |
| 9 | google/gemini-3.5-flash-lite | $0.00000 | n/a | n/a | 0.0% | n/a | n/a (0/0) | 0 | 1/1 |
| 10 | google/gemini-3-flash-preview | $0.00000 | n/a | n/a | 0.0% | n/a | n/a (0/0) | 0 | 1/1 |
| 11 | google/gemini-3.8-flash | $0.00000 | n/a | n/a | 0.0% | n/a | n/a (0/0) | 0 | 1/1 |
| 12 | openai/gpt-5-mini | $0.00000 | n/a | n/a | 0.0% | n/a | n/a (0/0) | 0 | 1/1 |

## Notes

- google/gemini-3.1-flash-lite: 1 failed task(s). First failures: mixed-03-full-english-breakfast r0: Meal photo provider returned HTTP 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\n \"error\": {\n \"code\": 400,\n \"message
- google/gemini-3.5-flash-lite: 1 failed task(s). First failures: mixed-03-full-english-breakfast r0: Meal photo provider returned HTTP 400: {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_n
- google/gemini-3-flash-preview: 1 failed task(s). First failures: mixed-03-full-english-breakfast r0: Meal photo provider returned HTTP 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\n \"error\": {\n \"code\": 400,\n \"message
- google/gemini-3.8-flash: 1 failed task(s). First failures: mixed-03-full-english-breakfast r0: Meal photo provider returned HTTP 400: {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_n
- qwen/qwen3.5-9b: API-reported cost disagreed with the catalog-price computation by >20% on 1 task(s) — trust the reported figure for those.
- qwen/qwen3.5-9b: served by Darkbloom (1 tasks).
- qwen/qwen3-vl-8b-instruct: served by Parasail (1 tasks).
- qwen/qwen3.8-flash: served by Alibaba (1 tasks).
- openai/gpt-4o: served by OpenAI (1 tasks).
- openai/gpt-4o-mini: served by OpenAI (1 tasks).
- openai/gpt-5-mini: 1 failed task(s). First failures: mixed-03-full-english-breakfast r0: Meal photo provider returned HTTP 400: {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_n
- anthropic/claude-haiku-4.5: served by Amazon Bedrock (1 tasks).
- anthropic/claude-haiku-5.5: served by Azure (1 tasks).

Full per-fixture detail: report.json.
