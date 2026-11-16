# 2026-07-11 — PR #1371 round 6: 4 more Codex findings

## Summary

Fixed 4 fresh Codex findings triggered by the round-5 push:

- `broker-protective-stops.ts` section 1 (`pending_cancel` retry loop): the guard blocked a retry
  for a plan-excluded row (`kindForSymbol(rowSym) === null`) whenever `liveReplaceBlocked` was set,
  even though that row's broker-held stop was never going to be replaced in the first place — only
  rows the account still actively manages need the live-replace-blocked skip. Narrowed the guard to
  `liveReplaceBlocked && liveLongs.has(rowSym) && kindForSymbol(rowSym) !== null`.
- `performance.ts`'s `recordFillFromProposal` blended-avgCost calculation used `price` (the paper
  execution model's synthetic-slippage-adjusted fill price) in both branches of the blend ternary.
  Switched to `basePrice` (the raw execution price before that ~1bp paper-mode adjustment) so a
  persisted stop-plan basis matches what the broker itself reports as `position.averageCost`
  instead of drifting.
- `dashboard.ts`'s `stopPlanBySymbol` block filtered by `policy.accountNumber` instead of the
  already-resolved `accountNumber` (destructured from `brokerChain`, the same variable used for
  `liveFills`/`paperFills`/`dailyStats` right above it) — could show or hide a plan against the
  wrong account when the two differ.
- `strategy.ts`'s `anyOpeningAtrPlan` predicate (gates the opening-candidate ATR precompute) only
  checked `p.stopPlan?.style === "atr"` — an explicit LLM-set plan — missing an INHERITED "atr"
  plan carried via `stopPlanBySymbol[normalizeSymbol(p.symbol)]`. Now checks both.

A CI "autofix" run (HeadSHA `e8c257a`, before this round's fixes) failed with `error_max_turns`
(61 turns, ~$5, no commit made) — confirmed the same known non-blocking pattern seen in prior
rounds (the bot re-does already-completed triage and runs out of its 60-turn budget). `verify` is
the only required merge check; this is not it.

## Why

Continuation of the ongoing Codex-review triage on PR #1371 now that the autofix bot's DeepSeek
routing is confirmed working (it authenticates and runs; it just isn't finishing within budget on
this large a backlog). All 4 findings are genuine correctness gaps in the round-4/round-5 work,
not regressions introduced this round.

## Files

- `src/lib/broker-protective-stops.ts` — narrowed section-1 pending_cancel retry guard
- `src/lib/performance.ts` — `basePrice` instead of `price` in both blend branches
- `src/lib/dashboard.ts` — resolved `accountNumber` instead of `policy.accountNumber`
- `src/lib/strategy.ts` — `anyOpeningAtrPlan` also checks inherited plans via `stopPlanBySymbol`

## Verification

```
npx tsc --noEmit   # clean
npm test           # 319 files / 3566 tests passed
npm run build      # clean (next-env.d.ts / tsconfig.json restored after)
npm run lint       # 0 errors, 379 pre-existing grandfathered warnings
```

## Follow-ups

- Still open: OCO sibling-identity pairing (see PR #1331's comment thread) — needs a broker API
  change to fix precisely.
- Continuing to monitor PR #1371 for further Codex review activity as pushes land.
