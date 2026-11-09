# LLM model benchmark — Green (Bull proposer) + Red (Bear reviewer)

- Run: 2026-07-10T08:52:37.492Z | rounds: 2 | roles: green | user: local
- Input pack: candidates from signal_snapshot @ 2026-07-07T23:18:29.379Z; macro from settings:last_macro_sent; portfolio from portfolio_snapshots (latest); Bear reviews trade_proposals (latest rows).
- Request path: resolveLlmEndpoint -> buildLlmRequestBody (real strategy schemas + prompts) -> llmFetchCapturing (soft timeout = strategyLlmTimeoutMs).
- Rank = success-with-valid-schema rate, ties broken by p50 latency. `brkt` = share of green proposals with a populated bracketStopLoss.
- CACHE-WARM CAVEAT: rounds 2+ re-send the identical prompt back-to-back, so they hit provider prompt caches — warm latency/cost flatters vs production's spaced-out cadence. Compare `cold p50`/`cold $` (round 1) for realistic first-call behavior; `cache tok` = avg provider-reported cache-read prompt tokens.

## Green / Bull proposer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | mistral-medium-3-5 | 1/2 | 1 | 0 | 50.1s | 50.1s | 50.1s | - | 100% | 2.0 | 100% | $0.0743 | $0.0743 | - | 8362 | 0 |
