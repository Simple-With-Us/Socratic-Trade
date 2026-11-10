# 2026-08-17 — Green-Team empty/malformed failover + credits-exhausted hint

## Context & Objective

Issue #2577 (2026-08-06 Monet lost-window reconstruction): five Green Team runs
failed in one session with Pushover
`Green Team proposal failed using OpenRouter <model>: OpenRouter error: Empty
response returned from LLM API.` while the Uptime Robot "OpenRouter credits low"
monitor flapped all day.  The ask was (1) give Green the same empty/malformed
HTTP-200 failover #2313 added for Red Team + Bull, and (2) name a below-threshold
credits check on `run_failed` so the owner sees cause, not mystery.

## Changes Made

Investigation discarded the guess that Green is a third path.  Green Team **is**
the Bull proposer (`proposeTrades` / `step: "bull"` / label "Green Team
proposal").  Empty HTTP-200 failover was already on that path when
`policy.llmFallbackModels` is set (2026-07-31 notification-error root-cause
fix).  The Aug 6 deaths still happened because:

- rotation serves one concrete model per run, and `llmFallbackModels` defaults
  OFF, so each run was a single-model chain;
- `response.json()` throwing on a malformed HTTP-200 body was not treated as
  failover-worthy (`isRetryableLlmError` does not match `SyntaxError`);
- the exhausted-chain error named the configured primary, not the last attempt;
- `run_failed` never correlated with the already-cached OpenRouter credits check.

Fixes:

- Malformed HTTP-200 JSON now fails over like empty content
  (`strategy_llm_failover` reason `malformed_response`).
- A rotating Green seat with no owner-configured fallbacks appends two other
  eligible pool models (`implicitGreenRotationFallbacks`, cap
  `ROTATION_IMPLICIT_GREEN_FAILOVERS = 2`).  Owner-configured
  `llmFallbackModels` still win unchanged.
- Exhausted-chain errors name the last attempt and, when the chain had more
  than one endpoint, add `Failover chain exhausted (N Green Team endpoints).`
- Strategy-level `run_failed` (and the persisted run summary) append
  `OpenRouter credits look exhausted ($X remaining; alert floor $Y)` when the
  cached credits check is actually below threshold.  Kill-switch handling is
  unchanged (that exact sentence selects the `kill_switch` event type).
  Fail-open credit-read errors never invent this hint.

Touched files:

- `src/lib/strategy.ts`
- `src/lib/openrouter-credits.ts`
- `src/lib/model-rotation.ts`
- `src/lib/types.ts`
- `test/strategy-llm-failover.test.ts`
- `test/openrouter-credits.test.ts`
- `test/model-rotation.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-17-green-empty-failover-credits.md`

## Decisions & Trade-offs

- Did not invent a separate Green proposer.  The missing coverage was
  malformed-body failover, rotation-without-fallbacks, and the credits sentence.
- Implicit rotation fallbacks are only appended when the owner left
  `llmFallbackModels` empty.  A configured chain is honored as-is.
- Cap of two implicit fallbacks: a credits-exhausted day must not fan out
  across the full rotation catalog.
- Credits hint is attached only on the strategy-run catch (the
  "Strategy run failed" emitter), not on broker-rejection `run_failed` rows.
- Did not change Bull's "degrade to zero proposals" path for unparseable
  *proposal* JSON after a valid HTTP body.  That is a successful empty tick,
  not the Aug 6 death mode.

## Verification State

```bash
npx vitest run test/strategy-llm-failover.test.ts test/openrouter-credits.test.ts \
  test/model-rotation.test.ts
```

Full lint / tsc / test / build gate before merge.

## Next Steps & Blockers

- Land via PR referencing #2577.  Auto-deploy on merge to `main`.
- Owner: if OpenRouter prepaid is still near the $3 floor, top up — failover
  cannot invent tokens when every model returns empty.

## Zero-Code Findings

- Green Team = Bull.  The #2313-era empty-content failover was already on this
  path; Aug 6 alerts named one model each because rotation + default-off
  fallbacks made each run a single attempt, and credits-low made every attempt
  empty.
