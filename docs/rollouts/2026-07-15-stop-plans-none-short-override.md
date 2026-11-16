# 2026-07-15 — Per-position stop plans: "none" short bypass, owner-decided

## Summary

Round 7 of PR #1371's Codex review flagged that `evaluateTradeProposal`'s short-stop gate
(`policy.ts`) only let an explicit `fixed`/`atr`/`trailing` stopPlan satisfy the mandatory
`shortStopLossPct` requirement — an explicit `"none"` plan (a deliberate, rationale-backed
no-stop choice) was still hard-blocked. That round fixed the `fixed`/`atr`/`trailing` parity but
left the `"none"` case as-is and posted a PR comment asking the owner whether it should also
bypass the gate, since unlike the general "stopPlan: none is never hard-blocked" rule this repo
applies elsewhere, the short-side mandatory-stop-loss requirement is a distinct, pre-existing
safety invariant for the unbounded-loss direction.

Owner's answer: **"if the LLM decides that it does not want a stop plan, that is okay."**

Implemented: the short-stop gate now also accepts an explicit `stopPlan: "none"` as satisfying
the mandatory-stop requirement, alongside `fixed`/`atr`/`trailing`. Only an ABSENT stopPlan (the
LLM made no explicit choice on this proposal) still falls through to requiring
`riskRules.shortStopLossPct > 0`. An explicit `"default"` deliberately does NOT satisfy the gate —
`"default"` defers to the account's own precedence, which in this exact branch (reached only when
`shortStopLossPct` is unset/0) guarantees no stop distance at all, so it isn't a genuine choice
with a known protective outcome the way `none`/`fixed`/`atr`/`trailing` are.

## Why

Consistent with this repo's "real trading, owner's risk" product philosophy already documented in
`CLAUDE.md`: risk-increasing owner/LLM choices are not meant to be hard-gated once the owner has
weighed in, provided the choice is deliberate (a rationale-backed `"none"`) rather than an
oversight (an absent stopPlan, or a `"default"` that happens to resolve to no protection).

## Files

- `src/lib/policy.ts` — short-stop mandatory-stop-loss gate now also accepts `stopPlan: "none"`
- `test/policy.test.ts` — two new regression tests: an explicit `none` short bypasses the gate;
  an explicit `default` short does not

## Verification

```
npx tsc --noEmit               # clean
npx vitest run test/policy.test.ts   # 56/56 passed (targeted, while full suite ran separately)
npm test                       # 382 files / 4402 tests passed (full suite)
npm run build                  # clean
npm run lint                   # 0 errors, 488 pre-existing grandfathered warnings
```

## Follow-ups

- The merged PR #1371 review thread asking this question should be replied to and resolved once
  this lands, referencing this PR.
- Separately researched (not fixed this round): the deferred OCO/bracket-sibling-leg-cancellation
  gap (flagged in PR #1331, PR #1371, and round 8). Confirmed against Alpaca's API docs this is an
  **unimplemented adapter capability**, not a broker-API wall — each bracket leg is independently
  listed with its own order ID, and fetching the tracked original entry order ID with
  `?nested=true` returns a `legs` array with the sibling leg's ID; cancelling one leg cascades via
  Alpaca's own OCO logic. `src/lib/alpaca.ts` doesn't parse or use `legs` today. Robinhood has no
  bracket/OCO order support in this codebase at all, so the gap doesn't apply there. Worth a
  dedicated follow-up effort if the owner wants it built.
