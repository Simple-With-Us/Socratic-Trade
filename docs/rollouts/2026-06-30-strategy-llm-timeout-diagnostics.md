# 2026-06-30 - Strategy LLM Timeout Diagnostics

## Summary

Diagnosed and patched the production strategy timeout shown as:

- `2026-06-30 09:35:47 America/Chicago` / `2026-06-30T14:35:47Z`
- `Strategy run failed`
- `The operation was aborted due to timeout`

The affected run was `64016e66-bb6d-4efc-bb23-2d11b7d054c5`, started at
`2026-06-30T14:34:33.577Z`, and failed at `2026-06-30T14:35:47.124Z`.
No `llm_step` completion row existed for that run, which places the failure in
the Green Team proposal request before Red Team review, proposal validation,
broker placement, or notification delivery.

## Why

The run happened immediately after policy changes to Green Team `gpt-5.5`,
Red Team `claude-opus-4-8`, and `llmReasoningEffort=high`. The next manual run
with the same model pair completed, so this was a bounded single-call LLM
timeout, not a persistent production outage.

Prior behavior surfaced the raw runtime error string and recorded no failed LLM
step. That made Activity/Audit unable to identify whether the timeout was Green
Team, Red Team, broker, market data, or notification related.

## Changes

- Added `humanizeLlmTransportError(...)` so timeout/network exceptions include
  step, provider, model, timeout budget, and operator guidance.
- Added `started` and `failed` LLM step statuses.
- Strategy runs now audit `llm_step` start rows before Green/Red requests.
- Failed Green Team transport calls now:
  - record a failed `llm_step`,
  - preserve that failed step in the final `strategy_run` audit payload,
  - fail closed with a specific message such as
    `Green Team proposal timed out after 60s using OpenAI gpt-5.5...`.
- Red Team transport failures now fallback to Bull proposals with an auditable
  `fallback` step reason instead of escaping as an opaque run failure.

## Files

- `src/lib/llm-errors.ts`
- `src/lib/strategy.ts`
- `test/llm-errors.test.ts`
- `test/persistence-notification.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-06-30-strategy-llm-timeout-diagnostics.md`

## Verification

- `npm ci` - installed isolated worktree dependencies.
- `npx vitest run test/llm-errors.test.ts test/persistence-notification.test.ts` - 29 tests pass.
- `npm run lint` - pass with 0 errors and the existing warning backlog.
- `npx tsc --noEmit` - pass.
- `npm test` - 160 files / 1557 tests pass.
- `npm run build` - pass.

## Follow-ups

- If `gpt-5.5` high-reasoning timeouts recur, add a per-model strategy timeout
  knob or route high-latency Green Team runs through a background/queued flow
  instead of the interactive run path.
