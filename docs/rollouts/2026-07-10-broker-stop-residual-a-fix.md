# 2026-07-10 — PR #1229 residual (a): dead `pending_cancel` rows can now self-heal

## Summary
Fixes the accepted residual documented in
`docs/rollouts/2026-07-09-rh-broker-stop-hardening.md` ("Follow-ups / still-open blockers", item
4): a `broker_protective_stops` row stuck in `pending_cancel` status because
`gateway.cancelEquityOrder` keeps failing — even when the broker order behind it is already done
resting (filled, rejected, canceled, or expired) — used to retry forever with no way to clear.
That permanently blocked `reconcileBrokerProtectiveStops` section 4 (place-if-missing) from ever
placing a fresh broker-held stop for that symbol again this session. The position stayed protected
by the always-on synthetic trailing-stop monitor throughout (this was never a "no protection"
bug), but broker-held protection — the point of the opt-in `robinhoodBrokerStops` feature — was
permanently lost for the symbol until a restart.

`reconcileBrokerProtectiveStops` (`src/lib/broker-protective-stops.ts`) now accepts an optional
`orders?: EquityOrder[]` — the caller's freshly fetched broker order list (the synthetic-stop
monitor already calls `gateway.getEquityOrders()` once per tick before it calls reconcile). In
section 1 (pending_cancel retry), when a cancel attempt throws, the code now looks up the row's
`brokerOrderId` in that list:
- **Found, and done resting** (`isRejectedOrCanceledState` — rejected/canceled/cancelled/failed/
  expired — OR `filled`): the row is stale bookkeeping. Delete it. Section 4 can place a fresh
  stop for the symbol in the same reconcile pass (SQLite is synchronous, so recovery and
  re-placement land in one tick, not two).
- **Absent from the list, or found but still live**: stays ambiguous. Keep the row as
  `pending_cancel` and keep retrying next tick — never assume terminal without positive evidence.
  An absent order isn't proof of death (a broker's default order-list window can exclude very old
  orders), and deleting a row for a still-live order would let a later tick place a SECOND stop
  over it — two resting sell stops, one untracked, which is exactly the failure mode the existing
  section-4 placement guard exists to prevent.

`isDoneRestingState` deliberately does NOT fall back to "not a recognized live state" — it only
recognizes the explicit terminal vocabulary above. An unrecognized/unknown state must stay
ambiguous (keep retrying), matching the file's existing bias throughout: never delete a row
without positive evidence the broker order is gone.

`src/lib/synthetic-stops.ts`'s `runSyntheticStopMonitor` was updated to pass its already-fetched
`brokerOrders` through as `orders` — no new broker calls, this reuses the list it already had.

### Issue (b) — checked, already fixed, no change needed
The same recon flagged a second item referencing the `!exec.orderId` defensive branch in section
4's placement path. Reading the current code and PR #1269's resolved review-comment thread
confirms this was already fixed there: `isRejectedOrCanceledState(exec.state)` now runs BEFORE the
`!exec.orderId` check (a synchronously-declined placement with an order id is caught first and
never recorded as a `resting` row). No further action was needed.

## Why
This is exit-path code on a real-money Robinhood account (the feature stays `robinhoodBrokerStops:
false` by default, but the recon and PR #1229/#1269 review rounds treat it as money-path code that
must be hardened before the default can ever flip). The recon explicitly marked issue (a) "STILL
LIVE" with a concrete failure scenario: a broker cancel that keeps erroring after the order is
already dead (a very plausible real occurrence — a filled stop-market SELL, for instance, will
ALWAYS fail a subsequent cancel attempt) silently and permanently degrades the account from
broker-held to synthetic-only protection with no operator-visible signal beyond an audit event
that nobody is watching in real time.

## Files
- `src/lib/broker-protective-stops.ts` — new `isDoneRestingState()` helper; `orders?: EquityOrder[]`
  param on `reconcileBrokerProtectiveStops`; section-1 catch block now checks the order list before
  giving up and keeping the row stuck; module header + JSDoc updated.
- `src/lib/synthetic-stops.ts` — passes `orders: brokerOrders` into the
  `reconcileBrokerProtectiveStops` call (one-line wiring change).
- `test/broker-protective-stops.test.ts` — 3 new tests: recovers via a terminal (`canceled`)
  order-list match and re-places same tick; recovers via `filled`; stays conservative and never
  deletes when the order is absent from the list or still live (`confirmed`).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification
Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`; homebrew's default `node` is v26 and breaks
`better-sqlite3`'s prebuilt ABI in a fresh worktree).
- `npx tsc --noEmit` — clean.
- `npx vitest run test/broker-protective-stops.test.ts test/synthetic-stops.test.ts test/broker-side.test.ts test/broker-held-orders.test.ts`
  — 4 files, 68 tests, all pass.
- `npx eslint src/lib/broker-protective-stops.ts src/lib/synthetic-stops.ts test/broker-protective-stops.test.ts`
  — 0 errors (2 pre-existing grandfathered warnings, both unrelated to this change: an unused
  `crypto` import in `synthetic-stops.ts` and an `any` in the test file's pre-existing
  `PlacedOrder`/gateway fixture typing).
- Full `npm test` / `npm run build`, and `bash scripts/land.sh`, were deliberately NOT run in this
  session per the task's Build-phase scope (focused tests + tsc only; full gate + PR happen in the
  serialized Land phase).

## Follow-ups
- Land via `scripts/land.sh` in the serialized landing session (full `npm test` + `npm run build`
  ride that gate).
- The same "cancel keeps failing but the order is actually dead" pattern exists in the
  disabled-teardown branch (lines ~120–135, before the `brokerProtectiveStopsEnabled` early
  return) and in section 3's mismatch-cancel catch. Both were left untouched — the recon scoped
  issue (a) specifically to section 1 (lines 151–166), and neither of the other two spots
  currently blocks anything as severely (the disabled path never places, and section 3's stuck row
  just falls through to section 1's retry on the next tick, which now has the same recovery path).
  Worth a look if a future recon flags them, but out of scope here.
- `robinhoodBrokerStops` stays default OFF; this is hardening only, not enablement. The
  still-open live-RH-smoke-test blocker from the 2026-07-09 note is unaffected by this change.

## Landing-round review fix (same day, PR #1352)
`required_conversation_resolution` on `main`'s branch protection blocked the merge on an
unresolved codex-connector P1 comment, found valid on inspection:

> When the recovered broker order is `filled`, this deletes the local row and lets section 4
> place a fresh stop in the same pass using the `positions` snapshot that `runSyntheticStopMonitor`
> captured before fetching `orders`. If the stop fills between those two broker reads... this path
> can create a new GTC sell stop for shares that were just sold/reduced.

Traced the call chain: `runSyntheticStopMonitor` (`src/lib/synthetic-stops.ts`) calls
`gateway.getEquityPositions()` first, then `gateway.getEquityOrders()`, then passes BOTH into a
single `reconcileBrokerProtectiveStops` call. A rejected/canceled/expired recovery is safe to
re-place in that same call — the position never changed size. A `filled` recovery is different: the
position DID shrink, but the `positions` array already in hand for this call could be the read from
*before* the fill happened, if the fill landed broker-side in the narrow window between the two
`gateway.get*` calls. Section 4 would then size a replacement stop off the stale (pre-fill)
quantity — worst case, a resting sell stop for shares no longer held.

Fix (`src/lib/broker-protective-stops.ts`): `reconcileBrokerProtectiveStops` now builds a
`filledRecoverySymbols` set during section 1, populated only when the recovery evidence was
specifically `filled` (not rejected/canceled/expired). Section 4's placement loop skips any symbol
in that set for the current call, deferring re-placement to the next `reconcileBrokerProtectiveStops`
call — by then the caller has taken a fresh `getEquityPositions()` read that reflects the fill. The
always-on synthetic monitor protects the position for that one extra tick in between (same fallback
this file relies on throughout).

Updated the existing "also recovers when... FILLED" test in `test/broker-protective-stops.test.ts`
to assert the new deferral (`recovered.placed === 0`, row deleted, no premature second placement)
plus a follow-up call showing placement resumes normally once positions are fresh. The
`canceled`-state recovery test (section 1 recovering via a non-filled terminal state, same-call
re-placement) is unchanged and still passes — that path was never the race.

Verification (node@24, full gate this time): `npx tsc --noEmit` clean; `npm test` — 315 files,
3386 tests, all pass; `npm run build` clean. Landed via `bash scripts/land.sh`, PR #1352,
squash-auto-merge armed.
