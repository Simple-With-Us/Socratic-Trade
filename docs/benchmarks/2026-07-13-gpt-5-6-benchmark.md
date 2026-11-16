# LLM model benchmark — Green (Bull proposer) + Red (Bear reviewer)

- Run: 2026-07-13T02:43:59.543Z | rounds: 3 | roles: green, red | user: local
- **Est. total spend this run: $0.3517** across 16 priced call(s) — openai $0.3517 (16) — logged to llm_usage as user_id="benchmark:local" + pushed to external usage telemetry (when configured)
- Input pack: candidates from bundled fixture (no usable signal_snapshot); macro from settings:last_macro_sent; portfolio from portfolio_snapshots (latest); Bear reviews trade_proposals (latest rows).
- Request path: resolveLlmEndpoint -> buildLlmRequestBody (real strategy schemas + prompts) -> llmFetchCapturing (soft timeout = strategyLlmTimeoutMs).
- Rank = success-with-valid-schema rate, ties broken by p50 latency. `brkt` = share of green proposals with a populated bracketStopLoss.
- CACHE-WARM CAVEAT: rounds 2+ re-send the identical prompt back-to-back, so they hit provider prompt caches — warm latency/cost flatters vs production's spaced-out cadence. Compare `cold p50`/`cold $` (round 1) for realistic first-call behavior; `cache tok` = avg provider-reported cache-read prompt tokens.

## Green / Bull proposer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.6-terra | 3/3 | 0 | 0 | 3.8s | 14.8s | 14.8s | 3.6s | 100% | 1.7 | 100% | $0.0234 | $0.0311 | $0.0196 | 671 | - |
| 2 | gpt-5.6-luna | 3/3 | 0 | 0 | 8.6s | 9.4s | 8.6s | 7.1s | 100% | 3.0 | 100% | $0.0122 | $0.0117 | $0.0125 | 1139 | - |
| 3 | gpt-5.6-sol | 3/3 | 0 | 0 | 21.5s | 24.1s | 15.0s | 21.5s | 100% | 2.0 | 100% | $0.0622 | $0.0524 | $0.0672 | 1183 | - |

## Red / Bear reviewer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.6-terra | 3/3 | 0 | 0 | 2.3s | 2.3s | 2.3s | 2.0s | 0% | 0.0 | - | $0.0051 | $0.0051 | $0.0051 | 122 | - |
| 2 | gpt-5.6-luna | 1/3 | 0 | 2 | 2.4s | 2.4s | - | 2.4s | 0% | 0.0 | - | $0.0027 | - | $0.0027 | 238 | - |
| 3 | gpt-5.6-sol | 3/3 | 0 | 0 | 5.1s | 5.2s | 5.2s | 4.7s | 0% | 0.0 | - | $0.0133 | $0.0134 | $0.0132 | 223 | - |
