# LLM model benchmark — Green (Bull proposer) + Red (Bear reviewer)

- Run: 2026-07-08T10:47:56.237Z | rounds: 3 | roles: green, red | user: local
- Input pack: candidates from signal_snapshot @ 2026-07-07T23:18:29.379Z; macro from settings:last_macro_sent; portfolio from portfolio_snapshots (latest); Bear reviews trade_proposals (latest rows).
- Request path: resolveLlmEndpoint -> buildLlmRequestBody (real strategy schemas + prompts) -> llmFetchCapturing (soft timeout = strategyLlmTimeoutMs).
- Rank = success-with-valid-schema rate, ties broken by p50 latency. `brkt` = share of green proposals with a populated bracketStopLoss.
- CACHE-WARM CAVEAT: rounds 2+ re-send the identical prompt back-to-back, so they hit provider prompt caches — warm latency/cost flatters vs production's spaced-out cadence. Compare `cold p50`/`cold $` (round 1) for realistic first-call behavior; `cache tok` = avg provider-reported cache-read prompt tokens.

## Green / Bull proposer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | deepseek-v4-pro | 3/3 | 0 | 0 | 0.5s | 0.5s | 0.5s | 0.4s | 100% | 0.0 | - | $0.0030 | $0.0030 | $0.0030 | 8 | - |
| 2 | deepseek-v4-flash | 3/3 | 0 | 0 | 0.5s | 0.6s | 0.6s | 0.5s | 100% | 0.0 | - | $0.0010 | $0.0010 | $0.0010 | 8 | - |
| 3 | gemini-3.1-flash-lite | 3/3 | 0 | 0 | 2.0s | 7.1s | 7.1s | 1.8s | 100% | 2.3 | 57% | $0.0025 | $0.0027 | $0.0024 | 449 | - |
| 4 | claude-fable-5 | 3/3 | 0 | 0 | 4.1s | 13.5s | 4.0s | 4.1s | 100% | 0.7 | 100% | $0.0573 | $0.0461 | $0.0629 | 259 | - |
| 5 | claude-haiku-4-5 | 3/3 | 0 | 0 | 7.8s | 8.9s | 8.9s | 7.6s | 100% | 3.0 | 89% | $0.0067 | $0.0068 | $0.0067 | 651 | - |
| 6 | claude-sonnet-5 | 3/3 | 0 | 0 | 9.2s | 9.4s | 6.7s | 9.2s | 100% | 2.7 | 100% | $0.0240 | $0.0213 | $0.0253 | 711 | - |
| 7 | claude-opus-4-8 | 3/3 | 0 | 0 | 9.7s | 15.9s | 9.7s | 9.3s | 100% | 2.0 | 100% | $0.0385 | $0.0390 | $0.0383 | 654 | - |
| 8 | gemini-3.1-pro-preview | 3/3 | 0 | 0 | 18.4s | 21.1s | 17.5s | 18.4s | 100% | 3.0 | 89% | $0.0215 | $0.0216 | $0.0215 | 568 | - |
| 9 | gemini-3.5-flash | 3/3 | 0 | 0 | 27.1s | 27.4s | 27.4s | 17.0s | 100% | 2.7 | 75% | $0.0159 | $0.0164 | $0.0156 | 536 | - |
| 10 | gpt-5.5 | 3/3 | 0 | 0 | 33.1s | 57.6s | 33.1s | 29.9s | 100% | 2.3 | 100% | $0.1090 | $0.0936 | $0.1167 | 2453 | - |
| 11 | grok-4.3 | 3/3 | 0 | 0 | 34.0s | 40.4s | 20.6s | 34.0s | 100% | 1.7 | 0% | $0.0096 | $0.0090 | $0.0100 | 269 | - |
| 12 | gpt-5.4 | 3/3 | 0 | 0 | 35.6s | 37.7s | 37.7s | 20.8s | 100% | 1.3 | 100% | $0.0604 | $0.0712 | $0.0550 | 2848 | - |
| 13 | gpt-5.4-nano | 2/3 | 0 | 1 | 19.8s | 20.5s | - | 19.8s | 100% | 2.5 | 0% | $0.0055 | - | $0.0055 | 3260 | - |
| 14 | gpt-5.4-mini | 2/3 | 0 | 1 | 24.3s | 49.9s | 24.3s | 49.9s | 100% | 1.5 | 100% | $0.0247 | $0.0195 | $0.0299 | 4311 | - |
| 15 | grok-build-0.1 | 1/3 | 2 | 0 | 54.3s | 54.3s | - | 54.3s | 100% | 2.0 | 0% | $0.0078 | - | $0.0078 | 332 | - |
| 16 | mistral-small-2603 | 0/3 | 0 | 3 | - | - | - | - | - | - | - | - | - | - | - | - |
| 17 | mistral-medium-3-5 | 0/3 | 0 | 3 | - | - | - | - | - | - | - | - | - | - | - | - |

## Red / Bear reviewer

| rank | model | ok/attempts | timeouts | errors | p50 | p95 | cold p50 | warm p50 | schema-valid | avg proposals | brkt | avg est $/call | cold $ | warm $ | avg completion tok | cache tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | claude-haiku-4-5 | 3/3 | 0 | 0 | 0.7s | 0.8s | 0.7s | 0.6s | 100% | 0.0 | - | $0.0036 | $0.0036 | $0.0036 | 33 | - |
| 2 | gpt-5.4-mini | 3/3 | 0 | 0 | 3.3s | 3.8s | 2.8s | 3.3s | 100% | 0.0 | - | $0.0030 | $0.0028 | $0.0032 | 300 | - |
| 3 | gemini-3.1-pro-preview | 3/3 | 0 | 0 | 4.5s | 6.7s | 6.7s | 3.8s | 100% | 0.0 | - | $0.0040 | $0.0040 | $0.0040 | 10 | - |
| 4 | gemini-3.1-flash-lite | 3/3 | 0 | 0 | 5.0s | 5.1s | 5.1s | 1.5s | 100% | 1.3 | - | $0.0009 | $0.0011 | $0.0008 | 286 | - |
| 5 | gpt-5.5 | 3/3 | 0 | 0 | 5.6s | 6.2s | 5.3s | 5.6s | 100% | 0.0 | - | $0.0190 | $0.0185 | $0.0193 | 259 | - |
| 6 | gpt-5.4-nano | 3/3 | 0 | 0 | 5.9s | 11.6s | 4.0s | 5.9s | 100% | 0.3 | - | $0.0016 | $0.0009 | $0.0020 | 923 | - |
| 7 | claude-sonnet-5 | 3/3 | 0 | 0 | 7.1s | 7.5s | 7.1s | 5.4s | 100% | 1.0 | - | $0.0136 | $0.0143 | $0.0132 | 513 | - |
| 8 | claude-opus-4-8 | 3/3 | 0 | 0 | 8.2s | 8.7s | 7.4s | 8.2s | 100% | 1.0 | - | $0.0226 | $0.0221 | $0.0228 | 509 | - |
| 9 | gemini-3.5-flash | 3/3 | 0 | 0 | 9.1s | 10.3s | 10.3s | 7.7s | 100% | 0.7 | - | $0.0045 | $0.0054 | $0.0041 | 177 | - |
| 10 | claude-fable-5 | 3/3 | 0 | 0 | 9.6s | 14.9s | 14.9s | 3.9s | 100% | 0.7 | - | $0.0377 | $0.0452 | $0.0340 | 361 | - |
| 11 | grok-build-0.1 | 3/3 | 0 | 0 | 19.2s | 31.5s | 31.5s | 18.0s | 100% | 0.0 | - | $0.0025 | $0.0025 | $0.0025 | 8 | - |
| 12 | grok-4.3 | 3/3 | 0 | 0 | 22.2s | 27.5s | 22.2s | 14.4s | 100% | 0.0 | - | $0.0031 | $0.0031 | $0.0031 | 5 | - |
| 13 | gpt-5.4 | 1/3 | 0 | 2 | 2.6s | 2.6s | 2.6s | - | 100% | 0.0 | - | $0.0080 | $0.0080 | - | 162 | - |
| 14 | deepseek-v4-flash | 3/3 | 0 | 0 | 0.3s | 0.4s | 0.3s | 0.3s | 0% | 1.0 | - | $0.0003 | $0.0003 | $0.0003 | 264 | - |
| 15 | deepseek-v4-pro | 3/3 | 0 | 0 | 0.3s | 0.4s | 0.3s | 0.3s | 0% | 0.0 | - | $0.0009 | $0.0008 | $0.0009 | 114 | - |
| 16 | mistral-small-2603 | 0/3 | 0 | 3 | - | - | - | - | - | - | - | - | - | - | - | - |
| 17 | mistral-medium-3-5 | 0/3 | 0 | 3 | - | - | - | - | - | - | - | - | - | - | - | - |
