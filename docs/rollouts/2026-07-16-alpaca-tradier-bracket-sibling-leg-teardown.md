# 2026-07-16 — Alpaca + Tradier bracket sibling-leg cancellation (Tradier bracket support built from scratch)

## Summary

Closed the long-deferred "OCO sibling-identity pairing" gap for both Alpaca and Tradier:
when a broker-native bracket order's entry leg fills, its take-profit/stop-loss legs become
independently-resting orders on the broker with no app-side tracking. If a later scale-in
changed the position's `stopPlan` away from `fixed`/`atr` (the two styles that place a
broker-native bracket), nothing cancelled those still-resting legs — they'd sit on the
broker forever, or fire unexpectedly against a position the plan no longer intended to
protect that way.

- **Alpaca**: implemented `cancelBracketSiblingLegs` using the existing Alpaca client's
  `GET /orders/{id}?nested=true` (returns the bracket's `legs` array) + per-leg
  `cancelOrder`. This was an unimplemented adapter capability, not a broker limitation —
  Alpaca has supported nested-order lookup all along.
- **Tradier**: had **zero** bracket-order support before this change (a prior, deliberate
  scope decision documented in `tradier.ts`). Built it from scratch: `placeEquityOrder` now
  emits a native `class: "otoco"` order (both take-profit and stop-loss legs) or `class:
  "oto"` (single exit leg) using Tradier's indexed leg form params (`symbol[N]`, `side[N]`,
  `type[N]`, `price[N]`, `stop[N]`), and `cancelBracketSiblingLegs` parses the `leg` array
  Tradier returns on a GET of the parent order.
- Wired Tradier into `brokerSupportsBrackets` (`strategy.ts`) alongside Alpaca, so
  `enrichOpeningProposal` now attaches native brackets for Tradier accounts too.
- Added a small dedicated queue, `pending_bracket_teardowns`, that decouples "the stop plan
  changed away from a tracked bracket" (detected at write time in `db-api-keys.ts`, cheap,
  no broker I/O) from "actually cancel the broker-side legs" (done at reconcile time in
  `broker-protective-stops.ts`, via the new `reconcilePendingBracketTeardowns`, alongside
  the existing `reconcileBrokerProtectiveStops` call in `runSyntheticStopMonitor`).

## Why

This gap was surfaced by the owner's direct question ("what brokers are capable of
identifying/cancelling a bracket's sibling legs by group ID") after round-8 Codex follow-ups
on the per-position stop-plans feature flagged it as a known, deferred limitation. Research
(grounded against real Alpaca/Tradier API docs, not guessed) showed this was solvable for
both brokers, just previously unimplemented for Alpaca and entirely unbuilt for Tradier. Per
owner direction (`AskUserQuestion` — "Build both now"), this pass builds the Alpaca fix AND
the full Tradier OTOCO/OTO bracket feature (placement + capability gating + sibling-leg
cancellation) rather than doing Alpaca alone and re-deferring Tradier again.

The dedicated `pending_bracket_teardowns` queue (rather than calling broker I/O directly
from the DB write path in `db-api-keys.ts`) mirrors the existing `broker_protective_stops`/
`synthetic_trailing_stops` pattern already in this codebase — it avoids threading async
broker calls into a currently-synchronous DB write path, and gives teardown attempts the
same retry/backoff treatment (`MAX_BRACKET_TEARDOWN_ATTEMPTS = 10`) as other reconciliation
queues.

`bracketWholeShareMinimum`'s existing Alpaca-only gate was checked and confirmed to NOT need
a Tradier branch — Tradier bracket orders are already whole-share only (`fractional: false`),
so there is no equivalent fractional-bracket restriction to encode for it.

## Files

- `src/lib/db.ts` — `position_stop_plans` gained `opening_order_id TEXT`; new table
  `pending_bracket_teardowns` (+ index); migration v42 `bracket_sibling_leg_teardown`
  (guards `position_stop_plans` existence via `sqlite_master` before `ALTER TABLE`, matching
  the established defensive pattern used by other migrations in this file, since the
  `position_stop_plans`/`pending_bracket_teardowns` tables are absent in some
  migration-only test harnesses that hand-build a minimal schema).
- `src/lib/db-api-keys.ts` — `PositionStopPlan.openingOrderId`; `getStopPlans` SELECT
  includes `opening_order_id`; new `enqueueBracketTeardownIfLeavingDistancePlan` helper
  called from `recordStopPlan` and `clearStopPlans`; new exports `PendingBracketTeardown`,
  `listPendingBracketTeardowns`, `removePendingBracketTeardown`,
  `bumpPendingBracketTeardownAttempts`.
- `src/lib/types.ts` — `BrokerGateway` gained optional
  `cancelBracketSiblingLegs?(accountNumber, originalOrderId): Promise<{ cancelledOrderIds:
  string[] }>` (optional so Robinhood, which has no bracket support, can leave it
  undefined).
- `src/lib/alpaca.ts` — implemented `cancelBracketSiblingLegs` via nested-order GET +
  per-leg cancel.
- `src/lib/tradier.ts` — `placeEquityOrder` builds full `otoco`/`oto` orders for
  `fixed`/`atr` stop plans (limit/stop entries only; market-type entries fall through to
  the plain no-bracket path, matching Tradier's own order-type constraints); implemented
  `cancelBracketSiblingLegs` reusing the existing `equityRowsFromTradierOrder` helper.
- `src/lib/strategy.ts` — `brokerSupportsBrackets` now includes `"tradier"`.
- `src/lib/performance.ts` — `recordFillFromProposal` computes `openingOrderId` from
  `input.execution?.orderId` (only when the proposal carried bracket fields) and passes it
  through to `recordStopPlan`.
- `src/lib/broker-protective-stops.ts` — new `reconcilePendingBracketTeardowns(gateway,
  accountNumber, userId)`, called from `runSyntheticStopMonitor` in `synthetic-stops.ts`
  (own try/catch, doesn't block the existing `reconcileBrokerProtectiveStops` call).
- `test/alpaca-brackets.test.ts`, `test/tradier.test.ts`,
  `test/position-stop-plans-db.test.ts`, `test/broker-protective-stops.test.ts`,
  `test/strategy-hardening.test.ts` — new/extended coverage for bracket placement,
  sibling-leg cancellation, and the teardown queue on both brokers.
- `test/persistence-hardening.test.ts` — updated 10 hardcoded `toBe(41)` schema-version
  assertions to `toBe(42)` now that migration 42 legitimately exists (collateral from
  legitimately adding a new migration, not a design change).

## Verification

```bash
npx tsc --noEmit                                    # clean
npx vitest run test/persistence-hardening.test.ts    # 20/20 passed (after 41->42 fix)
npm test                                             # full suite, see below
npm run build
npm run lint
```

Isolated per-file runs during development: `alpaca-brackets.test.ts` 16/16,
`tradier.test.ts` 55/55, `position-stop-plans-db.test.ts` 18/18,
`broker-protective-stops.test.ts` 60/60, `strategy-hardening.test.ts` 74/74 — all green.

Root cause of the one real bug hit during implementation: migration 42's `up()` ran an
unconditional `PRAGMA table_info(position_stop_plans)` + `ALTER TABLE ... ADD COLUMN` —
`PRAGMA table_info` silently returns `[]` for a nonexistent table (not an error), but the
subsequent `ALTER TABLE` on that same nonexistent table throws. Fixed by adding an explicit
`SELECT 1 FROM sqlite_master WHERE type='table' AND name='position_stop_plans'` existence
check first (same pattern already used by the `chunk_occurrences`/`order_replacements`
migrations in this file).

## Follow-ups

- **Unverified against live Tradier.** No live Tradier account was available to place a
  real OTOCO/OTO order end-to-end; the implementation is built strictly from Tradier's
  documented API (indexed leg params, `class`/`leg` GET shape) and covered by unit tests
  against a mocked Tradier client, matching the existing testing posture for this adapter
  (`tradier.ts`'s pre-existing header comment already notes it had no live-verified bracket
  path — that caveat now applies to a real feature instead of an absent one). Treat the
  first live Tradier bracket fill as the actual acceptance test.
- `pending_bracket_teardowns` rows that exceed `MAX_BRACKET_TEARDOWN_ATTEMPTS` are left
  in place rather than auto-purged — no alerting/surfacing wired up yet for a
  teardown that keeps failing. Consider surfacing this in the activity feed if it proves
  to happen in practice (mirrors an existing gap already flagged for
  `broker_protective_stops`/`synthetic_trailing_stops`).
- Robinhood remains without bracket support entirely (pre-existing scope boundary, not
  changed by this pass) — `cancelBracketSiblingLegs` is left undefined on its gateway.
