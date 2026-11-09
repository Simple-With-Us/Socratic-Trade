# 2026-06-21 — Fix: regime-flip broadcast gated to escalation regimes only

## Summary

`checkRegimeFlip` in `src/lib/regime-watch.ts` was calling `broadcastMaterialEvent`
unconditionally on every regime flip — including de-escalation flips back to calm
regimes (Neutral, Risk-On, Cautious). This meant that a recovery from a Crisis back to
Neutral would still fire an LLM run, contrary to the event-driven design specification
in `docs/event-driven-llm-triggering.md`.

Fixed by gating `broadcastMaterialEvent` behind `isEscalationRegime(next)` so it only
fires when the NEW regime is one of the escalation regimes (Risk-Off / Crisis /
Inverted-curve). All-flip audit logging and dashboard refresh events are preserved
unconditionally.

## Why

The event-driven LLM trigger design (Event→action table in docs) specifies that the
trigger should fire only on a flip INTO an escalation regime. De-escalation is a
recovery — firing an expensive LLM run on every de-escalation was both incorrect per
spec and wasteful.

## Files

- `src/lib/regime-watch.ts` — added `if (isEscalationRegime(next))` guard around
  `broadcastMaterialEvent` call (line ~41)
- `test/regime-watch.test.ts` — new test file with 3 test cases:
  1. Flip into Risk-Off → broadcasts
  2. Flip from Crisis back to Neutral (de-escalation) → does NOT broadcast
  3. De-escalation still emits dashboard event (audit path preserved)

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 775 tests, 86 files — all pass (3 new regime-watch tests added)
npm run build      # clean Next.js build
```

## Follow-ups

- Crisis and Inverted-curve regimes covered by `isEscalationRegime` via string matching;
  this function is already tested in the macro test suite.
- No other callers of `broadcastMaterialEvent` in the codebase are affected by this change.
