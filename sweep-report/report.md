# Vision model bake-off — Layer 1 (identify only)

Run: 2026-11-11T12:35:48.424Z · Fixture set: fixtures/photo-eval-real · Fixtures: 30 · Repeats: 2 · Tasks per model: 60 · Total computed spend: $0.8676

Every model ran the production identify path (same prompt, schema, reasoning params); only the model slug varied — with ONE disclosed exception: a model whose endpoint rejects the production request shape outright is measured through the bake-off-only request accommodation recorded in report.json (request_accommodations), which rewrites only the rejected field; its cost/time include whatever that shape makes it spend. Cost = token usage × catalog prices (see report.json). Accuracy uses scoring.ts name matching; failed/timed-out tasks count as zero-recall in the headline recall (see recallCompletedTasksOnly in report.json for the completed-only figure).

> **Caveat:** The fixture set is REAL photographs from openly licensed sources (per-photo provenance in the set's manifest.json). Expectations are conservative — only items a careful human can clearly see are expected, and portions are scored only where the photo honestly supports a range (portion: null = unscored) — so these scores are photographic accuracy evidence on this set, still a small sample (see the set README).

| Rank | Model | Cost/task | Median | p95 | Recall | Precision | Portion in range | Extra items | Failures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | openai/gpt-4o | $0.00397 | 1,865 ms | 3,012 ms | 81.3% | 64.1% | 89.5% (34/38) | 61 | 0/60 |
| 2 | qwen/qwen3-vl-8b-instruct | $0.00041 | 5,879 ms | 15,408 ms | 79.1% | 59.9% | 80.0% (16/20) | 71 | 0/60 |
| 3 | openai/gpt-4o-mini | $0.00396 | 3,086 ms | 4,295 ms | 78.4% | 54.4% | 72.7% (16/22) | 88 | 0/60 |
| 4 | anthropic/claude-haiku-5.5 | $0.00035 | 2,425 ms | 3,925 ms | 78.4% | 51.7% | 88.5% (23/26) | 98 | 0/60 |
| 5 | openai/gpt-5-mini | $0.00244 | 12,316 ms | 18,070 ms | 77.6% | 55.0% | 90.9% (20/22) | 85 | 0/60 |
| 6 | qwen/qwen3.5-9b | $0.00027 | 4,037 ms | 7,539 ms | 74.6% | 56.8% | 82.4% (14/17) | 76 | 0/60 |
| 7 | qwen/qwen3.8-flash | $0.00031 | 5,088 ms | 10,519 ms | 71.6% | 53.0% | 95.5% (21/22) | 85 | 0/60 |
| 8 | anthropic/claude-haiku-4.5 | $0.00274 | 3,126 ms | 4,450 ms | 58.2% | 41.9% | 60.0% (12/20) | 108 | 0/60 |

## Notes

- qwen/qwen3.5-9b: API-reported cost disagreed with the catalog-price computation by >20% on 43 task(s) — trust the reported figure for those.
- qwen/qwen3.5-9b: served by Darkbloom (13 tasks), PrimeIntellect (7 tasks), Parasail (31 tasks), Together (11 tasks).
- qwen/qwen3-vl-8b-instruct: API-reported cost disagreed with the catalog-price computation by >20% on 16 task(s) — trust the reported figure for those.
- qwen/qwen3-vl-8b-instruct: served by Parasail (60 tasks).
- qwen/qwen3.8-flash: API-reported cost disagreed with the catalog-price computation by >20% on 45 task(s) — trust the reported figure for those.
- qwen/qwen3.8-flash: served by Alibaba (60 tasks).
- openai/gpt-4o: API-reported cost disagreed with the catalog-price computation by >20% on 17 task(s) — trust the reported figure for those.
- openai/gpt-4o: served by OpenAI (60 tasks).
- openai/gpt-4o-mini: API-reported cost disagreed with the catalog-price computation by >20% on 27 task(s) — trust the reported figure for those.
- openai/gpt-4o-mini: served by OpenAI (60 tasks).
- openai/gpt-5-mini: Bake-off-only request accommodation: this endpoint rejects the production reasoning:{enabled:false}, so the harness rewrote ONLY the reasoning field of the outgoing request (shape: reasoning field omitted; endpoint default applies). Prompt, schema, and image payload identical; no production code changed. The model's cost/time include any reasoning tokens it spends — its real operating profile. Reasoning tokens spent across its tasks: 46,272.
- openai/gpt-5-mini: API-reported cost disagreed with the catalog-price computation by >20% on 3 task(s) — trust the reported figure for those.
- openai/gpt-5-mini: served by OpenAI (60 tasks).
- anthropic/claude-haiku-4.5: served by Amazon Bedrock (60 tasks).
- anthropic/claude-haiku-5.5: served by Azure (34 tasks), Google (26 tasks).

Full per-fixture detail: report.json.
