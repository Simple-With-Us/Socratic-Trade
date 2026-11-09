# 2026-06-20 — Money-path safety fixes (short/cover correctness + partial fills)

## Summary

First tranche of the money-path safety + tests phase: fixed the four confirmed
correctness bugs surfaced by an adversarially-verified audit and pinned each with
regression tests. `tsc` clean, **327 tests** pass (+20), `npm run build` green.

Branch: `agent/claude`. Source of the work-list: a read-only multi-agent audit
(38 findings → 15 high-severity → 12 confirmed after adversarial verification),
synthesized into a 14-task plan. This commit lands **T1, T2, T3, T8** (the code bugs)
plus their pinning tests (T1, T4, T7, T8 + partial T2/T6 coverage).

## Why

The audit found that short/cover support was only partly implemented and almost
entirely untested, plus one side-blind risk gate and dropped partial fills — all on
or adjacent to the live order path. These de-risk real/about-to-be-real orders.

## What changed (code)

- **T1 — `src/lib/policy.ts` (per-symbol notional cap).** `maxSymbolExposureNotional`
  added order notional for ALL sides, so a risk-reducing sell/cover (e.g. an automated
  stop-loss exit) could be falsely blocked once the cap was configured. Now side-aware,
  mirroring `projectedExposurePct` and the sector cap: opening adds, closing subtracts.
- **T2 — `src/lib/strategy.ts` (`reconcilePendingFills`).** Alpaca `partially_filled`
  orders matched no branch, so partial executions never entered P&L/exposure. Added a
  `partially_filled` branch that books the executed portion, and made the terminal
  (cancelled/canceled/rejected/failed) branch book any already-executed shares instead of
  dropping them. Idempotent: reconcile UPDATES the existing fill record by id, so a later
  poll / the realtime stream never double-counts.
- **T3 — `src/lib/performance.ts` (`calculatePnl` FIFO matcher).** The closing loop took
  the front lot regardless of side, so a `sell` could consume a `short` lot (or `cover` a
  `long` lot) at $0 realized P&L and silently erase a real open lot. Now selects the first
  SAME-SIDE lot (sell→long, cover→short) via `findIndex`/`splice` and skips opposite-side lots.
- **T8 — `src/lib/strategy.ts` + `src/lib/synthetic-stops.ts` (short exits).**
  `generateProactiveRiskProposals` skipped negative-quantity positions and hard-coded
  `side:"sell"`; now manages shorts (gated behind `shortSellingEnabled`) with the correct
  inverted return math and a `cover` exit. `runSyntheticStopMonitor` no longer purges shorts
  from `liveSymbols`, auto-registers short stops (low-watermark), and uses `Math.abs` for the
  exit quantity (the exit-side `sell`/`cover` mapping was already correct).

## What changed (tests, +20)

- `test/performance.test.ts` — widened `fill()` to `OrderSide`; short→cover P&L signs
  (+20 / −30), open-short unrealized, and the T3 side-aware matcher (sell skips a leading
  short lot; cover skips a leading long lot).
- `test/policy.test.ts` — T1 side-aware notional cap (blocks opening buy; does not block
  risk-reducing / full-position sells); T7 enabled-path short guardrails (mandatory
  stop-loss, `maxShortOrderNotional`, `maxShortExposurePct`, cover-exceeds-short, valid cover).
- `test/reconciliation-risk.test.ts` — T2 partial-fill booking (partially_filled records
  executed portion; cancelled-after-partial books executed shares); T8 proactive short
  cover (and no management when short selling disabled).
- `test/synthetic-stops.test.ts` — T8 `runSyntheticStopMonitor` orchestration: long→sell,
  short→cover, and running=false suppresses the exit (each isolated by account).

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 327 passed (40 suites). The single failing suite,
  `reference/atlas-public-src/bff/notify/notify.test.mjs`, is a PRE-EXISTING, unrelated
  vendored-reference file with a broken relative import (not in the money path).
- `npm run build` — green; PM2 `trading-claude` restarted afterward.

## Follow-ups (remaining plan tasks)

- **T5** — ✅ DONE 2026-06-20: side-aware `getPaperPortfolioProjection` (wrong-sign/flat close guard +
  opposite-side averaging guard) + 6 tests. See `docs/rollouts/2026-06-20-money-path-t5-paper-projection.md`.
- **T6** — db-level notional tests for short/cover + hourly window + tenant isolation; null-`estimated_notional` fallback.
- **T9** — `recordFillFromProposal` short/cover boundary tests.
- **T10** — DESIGN DECISION: implement gross/net exposure gates (`maxGrossExposurePct`/`maxNetExposurePct`) or remove the unused fields. Needs sign-off before touching the policy/types/UI surface.
- **T11** — red-team fail-open contract tests (no key / 500 / empty / non-JSON) + debate drop/keep filter.
- **T12** — pin tax.ts long-only behavior for short/cover (document + guard tests).
- **T13** — daily-notional reset timezone (make explicit/configurable) + kill-switch notification path.
- **T14** — policy returned-field consistency, dead `currentPriceForPosition`, empty-account-number scoping.

Merge to `main` deferred while the integration worktree is actively committing (Atlas
retire work in flight); this branch is pushed to `origin/agent/claude` for review/merge.

## Blockers

- None for this tranche. T10 needs a product decision (implement vs remove).
