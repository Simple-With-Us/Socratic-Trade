# 2026-07-10 — Mistral keyed re-benchmark (MONET, owner-directed)

## Summary

The keyed re-benchmark deferred from PR #1279 (Mistral capability-map fix) ran tonight,
owner-directed. **12/12 calls succeeded — zero 400s** (the 2026-07-08 benchmark was 0/12
under the old family-wide capability map), empirically proving the fixed request shapes
against the live Mistral API. Results committed as
`docs/benchmarks/2026-07-10-mistral-rebench.{json,md}`.

| model | role | ok | p50 | p95 | avg $/call | output |
|---|---|---|---|---|---|---|
| mistral-small-2603 | green | 3/3 | 3.6s | 4.4s | $0.0015 | 2.3 proposals avg, 100% schema-valid, 100% bracket coverage |
| mistral-small-2603 | red | 3/3 | 1.7s | 2.0s | $0.0004 | correct verdict JSON (see validator note) |
| mistral-medium-3-5 | green | 3/3 | 1.3s | 2.3s | $0.0117 | valid but EMPTY `{"proposals":[]}` every round (~8 completion tokens) |
| mistral-medium-3-5 | red | 3/3 | 1.1s | 1.3s | $0.0038 | correct verdict JSON (see validator note) |

Context vs. 2026-07-08 peers: `mistral-small-2603` as green is markedly cheaper and faster
than `gpt-5.4-mini` green ($0.0015 / 3.6s vs $0.0247 / 24.3s) with real bracket-covered
proposals. `mistral-medium-3-5` green (reasoning off — the new default) declined to propose
on the same signal snapshot all three rounds.

## Benchmark-validator artifact (red rows)

`validateProposals` in `scripts/benchmark-llm-models.ts` applies the GREEN
proposals-array check to BOTH roles, so any correctly-shaped red `red_team_verdict`
object scores `schemaValid=false` by construction. Manual inspection of all six red
responses: well-formed `{"verdict":"reject","reason":...}` JSON, and the reasoning was
substantively correct (both models fact-checked the fixture's bull-says-BUY vs
trades-are-SELLs incongruity). Follow-up: teach the script a red-role validator keyed on
`RED_TEAM_VERDICT_SCHEMA` so red rows report honestly.

## How it ran

From this worktree (post-#1279 request shapes) under Node 24, with
`DATABASE_URL=file:~/apps/trading-live/data/app.db` (read-only source of the real
signal-snapshot prompt data) and `MISTRAL_API_KEY` + `ENCRYPTION_KEY` resolved at runtime
from Infisical prod via the automation machine identity (values never written to disk or
logs):

```bash
npx tsx scripts/benchmark-llm-models.ts --models mistral-small-2603,mistral-medium-3-5 \
  --rounds 3 --role both
```

## Why medium-3-5 proposes nothing (owner question — investigated same night)

Probes (green role, identical real-snapshot prompt, new `--effort` flag on the script):

1. `--effort omit` (reasoning params stripped entirely): IDENTICAL empty
   `{"proposals":[]}` (~8 tokens, deterministic) — the `reasoning_effort:"none"` param is
   NOT the suppressor. With its thinking disabled, medium-3-5 simply answers "no
   qualifying trades" on this snapshot, every time (temperature 0 + same prompt).
2. `--effort high`, original #1279 shape: **400 "Reasoning prompt mode is not enabled
   for this model"** — medium-3-5 rejects `prompt_mode:"reasoning"` TOO. Mistral
   validates `reasoning_effort` before `prompt_mode`, so the 2026-07-08 benchmark's
   effort-value 400 had masked this second rejection (my #1279 read of "prompt_mode
   passed validation" was validation-order-blind). SHAPER FIXED: reasoning tier sends
   `reasoning_effort` only, never `prompt_mode`.
3. `--effort high`, prompt_mode dropped: **400 "top_p must be 1 when using greedy
   sampling" (code 3054)** — Mistral's reasoning tier rejects `temperature: 0` without
   `top_p: 1`. SHAPER FIXED: a thinking-enabled Mistral call now sends NO temperature
   (matching the app's other providers' thinking modes).
4. `--effort high`, both fixes: **IT PROPOSES** — 2 schema-valid proposals with 100%
   bracket coverage in 50.1s, ~8.4k completion tokens (hidden reasoning + JSON),
   ~$0.074/call. The reasoning-mode reply parsed clean — consistent with #1279's
   chunked reasoning-text extraction working live (pre-fix that response shape read as
   empty text). Second round exceeded even the widened 150s reasoning soft-timeout —
   long-tail latency is real on this tier.

Committed as `docs/benchmarks/2026-07-10-mistral-rebench-high.{json,md}` (1 ok / 1
timeout — small sample, enough to answer the behavioral question).

**Bottom line:** medium-3-5 with reasoning off is fast, cheap-ish, and useless as a
proposer (empty list); with reasoning on it works but at ~50x small-2603's cost and
~15-40x its latency, with timeout risk. Its natural role, if any, would be reviewer
(fast, sharp verdicts at $0.0038) — not proposer.

## Rotation-pool recommendation (owner call — pool NOT changed in this PR)

- `mistral-small-2603`: meets the re-add gate as a GREEN proposer (100% schema-valid,
  cheap, fast, brackets populated). Its red verdicts are correctly shaped too. Reasonable
  to re-add.
- `mistral-medium-3-5`: hold out of the pool. Reasoning-off it proposes nothing;
  reasoning-on it works but is slow/expensive with real timeout risk, and the pool's
  rotation serves the app's default effort (off). Fine as a manually-chosen reviewer.
- Caveat that applies to any red-seat pool member: the pool is shared by both seats;
  DeepSeek precedent shows red-side strict-schema drift is tolerated in the pool today,
  and Mistral's verdicts are correct anyway.

## Files

- `docs/benchmarks/2026-07-10-mistral-rebench.json` / `.md` — committed results (checked:
  no secrets in either artifact); `-high.{json,md}` — the reasoning-tier probe.
- `src/lib/llm-request.ts` — two reasoning-tier shaper fixes from the probes: no
  `prompt_mode` ever (medium-3-5 rejects it too), no `temperature` on a thinking-enabled
  Mistral call (greedy-sampling 400).
- `scripts/benchmark-llm-models.ts` — new `--effort <tier|omit>` flag (was a filed
  follow-up; `omit` is the diagnostic strip-the-params mode).
- `test/llm-request.test.ts`, `test/llm-call.test.ts` — expectations updated to the
  probe-proven shapes.
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note — protocol.

## Verification

- Benchmark run itself (12 live calls, all `ok`, output tables above).
- `grep -ciE "api[_-]?key|bearer|sk-..." docs/benchmarks/2026-07-10-mistral-rebench.json`
  → 0 before commit.

## Follow-ups

- Red-role validator fix in `scripts/benchmark-llm-models.ts` (artifact above).
- ~~Optional `--effort` flag~~ DONE this PR; high-effort probe DONE (findings above).
- ~~Owner decision on re-adding to `MODEL_ROTATION_POOL`~~ DECIDED 2026-07-10: owner
  wants BOTH models in the pool for now, to pull out later as warranted — done in
  `src/lib/model-rotation.ts` (this overrides the hold-medium-3-5-out recommendation
  above). `MODEL_ROTATION_POOL` now excludes only `grok-build-0.1`.
