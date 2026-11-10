# LLM model benchmark — Green (Bull proposer) + Red (Bear reviewer)

- Run: 2026-07-10T07:20:06.850Z | rounds: 3 | roles: green, red | user: local
- Input pack: candidates from signal_snapshot @ 2026-07-07T23:18:29.379Z; macro from settings:last_macro_sent; portfolio from portfolio_snapshots (latest); Bear reviews trade_proposals (latest rows).
- Request path: resolveLlmEndpoint -> buildLlmRequestBody (real strategy schemas + prompts) -> llmFetchCapturing (soft timeout = strategyLlmTimeoutMs).
- Rank = success-with-valid-schema rate, ties broken by p50 latency. `brkt` = share of green proposals with a populated bracketStopLoss.
- CACHE-WARM CAVEAT: rounds 2+ re-send the identical prompt back-to-back, so they hit provider prompt caches — warm latency/cost flatters vs production's spaced-out cadence. Compare `cold p50`/`cold $` (round 1) for realistic first-call behavior; `cache tok` = avg provider-reported cache-read prompt tokens.

## Green / Bull proposer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mistral-medium-3-5 | 3/3 | 0 | 0 | 1.3s | 2.3s | 2.3s | 1.2s | 100% | 0.0 | - | $0.0117 | $0.0117 | $0.0117 | 8 | 0 |
| 2 | mistral-small-2603 | 3/3 | 0 | 0 | 3.6s | 4.4s | 4.4s | 3.3s | 100% | 2.3 | 100% | $0.0015 | $0.0016 | $0.0015 | 540 | 0 |

## Red / Bear reviewer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mistral-medium-3-5 | 3/3 | 0 | 0 | 1.1s | 1.3s | 1.3s | 1.1s | 0% | 0.0 | - | $0.0038 | $0.0039 | $0.0037 | 100 | 0 |
| 2 | mistral-small-2603 | 3/3 | 0 | 0 | 1.7s | 2.0s | 1.2s | 1.7s | 0% | 0.0 | - | $0.0004 | $0.0004 | $0.0004 | 152 | 0 |
