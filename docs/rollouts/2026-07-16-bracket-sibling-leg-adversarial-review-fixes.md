# 2026-07-16 — Bracket sibling-leg teardown: adversarial review follow-up (+ Codex P1 catch on my own fix)

## Summary

PR #1661 (bracket sibling-leg cancellation for Alpaca + Tradier) merged the same day with no
automated code review — Codex hit its usage-limit cap on both #1661 and its docs follow-up
#1662 and posted only a usage-limit notice, not a review. Since this touches real order
placement/cancellation on a live-money app, ran two independent adversarial review passes
(one correctness/race-focused, one money-path/financial-risk-focused) against the merged
code (`a5c27e8`) instead of leaving it unreviewed. Both passes independently surfaced the
SAME two genuine, confirmed bugs, plus a third distinct one from the correctness pass that
turned out (after grounded research) to not actually apply to this codebase's Tradier model.
Fixed the two confirmed bugs and pushed as PR #1667 — at which point Codex's usage cap had
reset, and it reviewed #1667 itself, catching a genuine, more severe flaw in fix #1's first
attempt (a P1: it could cancel STILL-VALID protection on a live position). That flaw is
corrected below with a proper design, not a patch — see "1. CONFIRMED (revised)".

## Findings and fixes

### 1. CONFIRMED (revised after Codex's PR #1667 review) — same-style scale-ins need ALL their brackets tracked, and torn down together only on a REAL style change

**First attempt (in this same PR, since superseded):** `enqueueBracketTeardownIfLeavingDistancePlan`
originally only compared `nextStyle === previousStyle` to decide whether a teardown was
needed, so a same-style scale-in (`fixed` -> `fixed`) silently orphaned the OLD bracket's
legs forever (the `opening_order_id` UPSERT overwrote it with the new order's id, with no
path back to the old one). The first fix pushed to this PR made the same-style case compare
`nextOpeningOrderId` too and enqueue a teardown for the stale order whenever it changed.

**Codex correctly flagged that first fix as a NEW, more severe bug (P1):** each bracket order
is sized ONLY to its own lot's quantity (Alpaca's `orderArgs.qty` from that specific order;
Tradier's exit legs sized to that order's own `wholeQty`) — a same-style scale-in's new
bracket does NOT replace or resize the OLD one. The OLD bracket is still the genuine,
correct, currently-resting stop-loss/take-profit for the PRE-EXISTING shares. Immediately
tearing it down on the very next scale-in (as the first fix did) cancels a live, correct
exit and leaves that earlier lot with **no protection at all** — worse than the original
"untracked forever" bug, which at least left the old bracket actively protecting its shares.

**Actual fix:** replaced the single `position_stop_plans.opening_order_id` scalar's role in
teardown decisions entirely. A new table, `position_stop_plan_open_brackets`, tracks EVERY
distinct bracket order id placed for a symbol while its plan sits in the fixed/atr family —
appended on each fill, never overwritten (`trackOpenBracketOrder`). Nothing is torn down on
a same-style scale-in; ALL tracked brackets for that symbol are torn down TOGETHER, only when
the plan genuinely LEAVES the fixed/atr family (a real style change, or the position closes —
`enqueueTeardownForAllOpenBrackets`, called from `recordStopPlan` and `clearStopPlans`). This
fixes both the original bug (nothing forgotten forever) and the P1 (nothing torn down while
still valid). `position_stop_plans.opening_order_id` remains as a display-only "most recent
bracket" field, decoupled from teardown logic. New migration v46 (renumbered from v43 after a concurrent main merge claimed 43-45).

### 2. CONFIRMED — `cancelBracketSiblingLegs` never threw, so the bounded-retry mechanism was dead code

Both Alpaca's and Tradier's `cancelBracketSiblingLegs` swallowed every failure (the initial
order lookup AND each per-leg cancel) into a plain `{ cancelledOrderIds: [] }`. But
`reconcilePendingBracketTeardowns` (`broker-protective-stops.ts`) only bumps
`attempts`/retries when the gateway call *throws* — which, with both adapters as originally
shipped, could never happen. Net effect: a transient lookup failure (network blip,
rate-limit, 5xx) was silently and permanently treated as "nothing to cancel" on the very
first sweep, removing the row and logging a success-shaped `bracket_sibling_legs_torn_down`
audit event even though the legs were never actually reached — `MAX_BRACKET_TEARDOWN_ATTEMPTS
= 10` never engaged in practice.

**Fix:** both adapters now distinguish "the order is genuinely gone" (safe to resolve as
done) from any other failure (must propagate so the reconciler's retry actually retries):
- Alpaca: only a real `404` on the nested-order GET resolves as done; anything else re-throws.
- Tradier: Tradier signals "not found" two ways — a genuine HTTP 404, or (per its own
  validation convention) a `200` response with an `{errors: {error: "..."}}` envelope that
  carries no HTTP-status prefix at all. Both are treated as "gone, safe to resolve"; anything
  else (including an unrelated validation error) propagates.

Per-leg cancel failures inside the loop remain intentionally swallowed on both adapters —
a leg that filled/cancelled between the lookup and the cancel attempt is a legitimate,
harmless race, not a signal to retry the whole teardown.

### 3. Investigated, NOT applied as originally proposed — Tradier "could cancel the entry order itself"

One reviewer flagged that Tradier's `cancelBracketSiblingLegs` has no leg-identity check
excluding the entry leg, and that a partially-filled entry (recorded as `openingOrderId` per
`performance.ts`) could get cancelled as a false "sibling." An initial fix (skip the first
row returned by `equityRowsFromTradierOrder`, assuming it's always the entry) was applied,
then reverted after checking it against this codebase's own PRE-EXISTING, tested model of
Tradier's response shape: `equityRowsFromTradierOrder`'s own doc comment and its
`getEquityOrders` coverage test (predating this PR, from an earlier "codex-autofix
reconciliation" round) both model a resting otoco/oco container's `leg` array as containing
ONLY the take-profit/stop-loss exit legs — the entry itself is never one of the container's
enumerated legs. Grounded web research (Tradier's own docs/description of OTOCO as "three
simultaneous orders" with indexed submission legs) could not conclusively confirm the GET-back
shape either way, so the established, already-tested precedent in this codebase was kept
rather than overridden by an unconfirmed guess — "skip the first leg" would have actively
broken the (still-passing) pre-existing sibling-cancellation test by skipping a genuine
take-profit/stop-loss leg.

What DID turn out to be a genuine, confirmed gap in the same area: when `container.class ===
"equity"` (no bracket was ever attached — e.g. Tradier's market-type-entry fallback in
`placeEquityOrder`, where `openingOrderId` is still recorded even though no bracket exists),
`equityRowsFromTradierOrder` returns the entry order ITSELF as its `[itself]` fallback row,
and iterating that WOULD treat the lone entry order as a cancellable "sibling." Fixed by
special-casing `class === "equity"` to a no-op before any leg iteration.

### 2. CONFIRMED — the codex-autofix backfill was correct, but a second concurrent commit needed reconciling

Two more Codex review rounds landed on PR #1667 itself:

- **Backfill gap (P1, confirmed and fixed):** `enqueueTeardownForAllOpenBrackets` only reads
  `position_stop_plan_open_brackets`, which the migration creates empty — a
  `position_stop_plans` row already at fixed/atr with an `opening_order_id` set under the OLD
  (pre-this-PR) design would have nothing in the new table, silently losing that bracket
  reference the first time its plan later changed away from fixed/atr. Fixed by backfilling
  the migration from any such legacy rows (own commit `a70b919`).
- **fixed<->atr teardown (proposed, explicitly declined):** Codex separately suggested that a
  scale-in changing style between `fixed` and `atr` should tear down the earlier tracked
  brackets, since they were "sized to a different stop distance." Declined with reasoning
  posted on the PR: a fixed and an atr bracket are computed differently but mechanically
  identical — an independent, lot-scoped broker-native bracket, with nothing else ever
  recreating protection for an earlier lot. Tearing down on this transition would reintroduce
  the exact P1 from finding 1 above.

The repo's `codex-autofix` bot then ran on this same PR (triggered by Codex's review) and
pushed its own commit (`ad4db48`) implementing BOTH: the same backfill fix independently
(redundant with `a70b919` but harmless), AND the fixed<->atr teardown Codex had proposed and
I had explicitly declined. Since the bot's commit landed on the shared PR branch, it had to be
reconciled rather than simply ignored: merged the commit properly (preserving history, not a
force-push), kept my own backfill implementation (already tested), and reverted the fixed<->atr
teardown addition back to the declined design — with the reasoning restated in
`recordStopPlan`'s doc comment, a PR comment explaining the reconciliation, and a dedicated new
regression test (`test/position-stop-plans-db.test.ts`) locking in that fixed<->atr behaves
like any same-style transition (track, never teardown, until a real exit from the whole
family). Codex then independently reviewed the autofix bot's commit too and flagged the exact
same fixed<->atr issue — confirming the original reasoning was correct.

## Files

- `src/lib/db.ts` — migration v46 (renumbered from v43 after a concurrent main merge claimed 43-45) + `position_stop_plan_open_brackets` table (append-only,
  one row per tracked bracket order id per symbol).
- `src/lib/db-api-keys.ts` — replaced `enqueueBracketTeardownIfLeavingDistancePlan` with
  `trackOpenBracketOrder` (append, dedup by order id) and `enqueueTeardownForAllOpenBrackets`
  (tears down every tracked order for a symbol at once, clears tracking); both `recordStopPlan`
  and `clearStopPlans` updated to call the appropriate one; new exports `OpenBracketOrder`,
  `listOpenBracketOrders`.
- `src/lib/account-deletion.ts`, `src/lib/db-api-keys.ts` (`purgeConnectedAccount`) — added
  `position_stop_plan_open_brackets` to account-deletion/purge coverage alongside
  `pending_bracket_teardowns`.
- `src/lib/alpaca.ts` — `cancelBracketSiblingLegs` only swallows a genuine 404; anything else
  propagates.
- `src/lib/tradier.ts` — `cancelBracketSiblingLegs` only swallows a genuine "not found" (404
  or the 200-with-errors-envelope form); anything else propagates. Added an early no-op for
  `container.class === "equity"` (no bracket ever attached).
- `test/position-stop-plans-db.test.ts` — rewrote the same-style-scale-in test to assert
  NEITHER bracket is torn down immediately, BOTH are tracked, and a later real style change
  tears down BOTH together; added a dedup test for a redundant same-order-id re-record; added a
  dedicated fixed<->atr regression test (see finding 2 above) locking in the same no-teardown
  behavior for that transition, plus a new migration-backfill test in
  `test/persistence-hardening.test.ts`.
- `test/alpaca-brackets.test.ts` — mock `sendRequest` can now simulate a thrown error; added
  tests for the 404-resolves-as-done and non-404-propagates cases.
- `test/tradier.test.ts` — added tests for: entry-only order (class=equity, still open) never
  gets cancelled; genuine HTTP 404 resolves as done; the 200-with-errors "not found" envelope
  resolves as done; any other failure (503) propagates.
- `test/persistence-hardening.test.ts` — updated 10 hardcoded schema-version assertions
  (41->46, in two steps as the migration got renumbered) now that migration 46 legitimately
  exists; added a dedicated backfill-migration test.

## Verification

```bash
npx tsc --noEmit                                                                    # clean
npx vitest run test/alpaca-brackets.test.ts test/tradier.test.ts \
  test/position-stop-plans-db.test.ts test/broker-protective-stops.test.ts \
  test/strategy-hardening.test.ts test/persistence-hardening.test.ts \
  test/account-deletion-coverage.test.ts                                           # 251/251 passed
npm test                                                                            # 393 files / 4,546 tests passed
npm run build                                                                       # clean
npm run lint                                                                        # 0 errors
```

## Follow-ups

- Same as the original PR #1661 rollout note: unverified against a live Tradier account;
  `pending_bracket_teardowns` rows exceeding `MAX_BRACKET_TEARDOWN_ATTEMPTS` still have no
  alerting/surfacing; Robinhood remains without bracket support.
- The money-path review separately flagged (as an already-disclosed, unresolved risk, not a
  newly-introduced bug) that Tradier's per-leg `status` field may not exist independently of
  the container once the entry has filled — genuinely unverifiable without a live account;
  the first live Tradier bracket fill remains the real acceptance test for this whole feature.
- `position_stop_plan_open_brackets` rows accumulate indefinitely across repeated same-style
  scale-ins until a real style change or close finally sweeps them — unbounded in the sense
  that a position scaled into many times over a long fixed/atr holding period could accrue
  many tracked rows before any teardown fires. Not expected to matter in practice (a handful
  of scale-ins at most), but worth knowing if a very high-frequency scale-in strategy emerges.
