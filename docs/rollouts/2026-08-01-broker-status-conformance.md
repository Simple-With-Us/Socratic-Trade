# 2026-08-01 — Per-Broker Order-Status Conformance Tables (oss-lessons §7 slice 1) — KIMI

## Context & Objective

oss-lessons §7 (brokerage-model order-state hardening), slice 1 of 4. The freqtrade lesson:
nothing outside the broker wrapper may interpret raw broker status strings. In this repo the
wrappers pass raw statuses through and the SHARED classifiers in `broker-side.ts` /
`broker-held-orders.ts` are the single interpretation point — but until now nothing locked that
interpretation down, and the §7 conformance audit found it had already drifted:
`broker-held-orders.ts` carried a private decline set (`REJECTED_OR_CANCELED_STATES` =
{canceled, cancelled, rejected, expired}) missing `failed` (Robinhood terminal) and `error`
(Tradier terminal decline) that `broker-side.ts`'s canonical set already had (zero importers —
dead, drifted weight). Slice 1 makes every documented raw status of every connected broker a
CI-executed assertion against the REAL classifiers, and unifies the drifted copy into a
re-export so the two modules can never diverge again.

## Changes Made

- `src/lib/broker-status-conformance.ts` (NEW) — `BROKER_ORDER_STATUS_CONFORMANCE`: the
  documented raw-status vocabulary per broker (alpaca / robinhood / tradier), each raw status
  mapped to its canonical class across the four production lenses (`live` =
  `broker-side.isLiveOrderState`, `active` = `broker-held-orders.isActiveBrokerOrderState`,
  `working` = `broker-held-orders.isWorkingOrderState`, `decline` =
  `broker-side.isRejectedOrCanceledState`, `filled` = raw `filled` after normalization).
  Every row carries a `note` naming the trap it guards, including:
  - `done_for_day` → terminal-inert: the 2026-07-27 regression (terminal day-order outcome
    persisting forever in `getEquityOrders` history) — must NEVER count as working/live, and
    is NOT a decline (ops-snapshot tallies it separately).
  - `pending_cancel` / `pending_replace` → deliberately LIVE: a merely REQUESTED cancel/replace
    can still fill; treating it as dead is what lets a duplicate exit stack.
  - `replaced` → terminal but NOT a decline: superseded by a successor tracked in the
    `order_replacements` ledger.
  - `calculated` (Alpaca pre-accept) → live + working but NOT active/held; `stopped` (stop
    triggered, fill pending) → working but no longer resting protection — the two
    `EXTRA_WORKING_ORDER_STATES`, precisely delimited.
  - `classifyOrderStatus(raw)` runs the REAL classifiers over one status — the function the
    test checks every table row against; it must stay wired to production, never a
    re-implementation, or the tables certify nothing.
- `test/broker-status-conformance.test.ts` (NEW, 7 tests) — executes every table row against
  the real classifiers; asserts the two modules' decline classifiers are the SAME function
  (drift unification holds); cross-lens consistency (filled/declined ⇒ nothing else;
  `active ⇒ live`; `working ⇒ live` or one of the two documented EXTRA_WORKING states);
  unknown/garbage statuses fail CLOSED on every lens; case/whitespace normalization; and
  regression guards for the documented production traps (`done_for_day` inert,
  `pending_cancel`/`pending_replace` live, `failed`/`error` declines in BOTH modules).
- `src/lib/broker-held-orders.ts` — deleted the drifted local `REJECTED_OR_CANCELED_STATES`
  copy and now re-exports `isRejectedOrCanceledState` from its canonical home
  `broker-side.ts`. No behavior change for any caller (grep-verified: the removed const and
  the module's decline function had zero importers anywhere on main).

## Decisions & Trade-offs

- **Tables execute the REAL classifiers, not a parallel mapping.** A conformance table that
  re-implements the classification would only certify itself. `classifyOrderStatus` calls the
  production functions directly, so a vocabulary edit in EITHER direction (a new raw status
  mishandled, or a classifier change that alters an existing mapping) fails CI here.
- **Fail-closed as an asserted property.** Unknown statuses classify all-false on every lens —
  the test pins this so a future "helpful" default (e.g. treating an unrecognized status as
  live) cannot slip in silently. When unsure, don't suppress protection — but also don't invent
  meaning.
- **Decline unification via re-export, not a shared constants module.** `broker-side.ts` was
  already the de-facto canonical home (superset, more callers); the re-export keeps
  `broker-held-orders`' public API stable for any out-of-tree consumer while making divergence
  structurally impossible.
- **`decline` deliberately excludes `replaced` and `done_for_day`.** Both are terminal, but
  neither is a broker decline: `replaced` has a live successor in the replacements ledger, and
  `done_for_day` is a normal day-order outcome. Treating them as declines would skew
  reconciliation tallies — the ops snapshot counts them separately.
- Built in a dedicated clean worktree (`~/apps/trading-kimi-s7`): the shared lane checkout
  (`agent/kimi-lane`) holds other sessions' uncommitted WIP; the original slice-1 WIP files
  were copied out read-only and reconciled against current `origin/main` (no main-side drift in
  this file set — the WIP applied cleanly, zero adaptation).

## Verification State

```
npx tsc --noEmit                                        # clean (exit 0)
npx eslint src/lib/broker-status-conformance.ts \
  test/broker-status-conformance.test.ts src/lib/broker-held-orders.ts
                                                        # 0 errors, 0 warnings
npx vitest run test/broker-status-conformance.test.ts test/broker-side.test.ts \
  test/broker-held-orders.test.ts                       # 46/46 passed
npx vitest run --shard=1/3 --maxWorkers=8               # 1902/1902 passed
npx vitest run --shard=2/3 --maxWorkers=8               # 1774/1774 passed
npx vitest run --shard=3/3 --maxWorkers=8               # 1877/1877 passed
npm run build                                           # green (next build --webpack)
```

Full suite: 5553/5553 across 3 shards. Build gate ran locally in the dedicated worktree (no
foreign WIP this time).

## Next Steps & Blockers

- PR #2335 — auto-merge armed; merge == auto-deploy (2026-07-10 protocol).
- §7 remaining slices (all PLANNED / UNASSIGNED): slice 2 declarative order-type constraint
  validation pre-submission (Lean per-broker order-type models — targets the bracket-order 422
  class), slice 3 per-account broker-mutation mutex (Alpaca OMS sequential-per-account/WAL —
  targets `order_placement_uncertain` storms), slice 4 freqtrade-style uniform protection
  receipts.
- The original WIP copies remain uncommitted in the shared lane (`~/apps/trading-kimi`,
  `agent/kimi-lane`); a later lane cleanup can drop them once this PR lands.

## Zero-Code Findings

- The decline-set drift (`failed`/`error` missing from `broker-held-orders`' local copy) had
  NO live importers — a latent trap, not an active bug. It is now structurally impossible.
