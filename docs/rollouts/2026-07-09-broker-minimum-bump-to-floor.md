# 2026-07-09 — Broker minimum: bump-to-floor (owner ruling), skip becomes the opt-out (MONET)

## Summary

Owner ruling (2026-07-09, in-session, relayed on #ag***-s**c): a fractional or
dollar-based order that lands below the active broker's minimum order size
(Robinhood's $1 floor — typically a pct-of-NAV-clamped trim on a small account)
is **bumped up to the floor and placed**, not skipped. The pre-flight skip
behavior (#1167) remains available as `brokerMinimumHandling: "skip"`; the new
default is `"bump"`.

Supersedes the intent of PR #1169 (closed-superseded earlier — its bump landed
only in the deterministic-sizing stage "when capacity covers it"; this change
covers the remaining case where the pct-of-NAV clamp keeps the order under the
floor).

## Behavior

- **Buys/shorts (opening)**: dollar-based orders are raised to exactly the
  floor; fractional-quantity orders scale with a 0.5% cushion. A bump is
  declined (falls back to skip) when the floor exceeds the policy's own
  effective per-order cap (`min(maxOrderNotional, maxOrderPctOfNav×NAV)`) —
  bumping into a guaranteed policy rejection would just trade one kind of feed
  noise for another.
- **Sells/covers**: quantity scales to reach the floor, capped at the FULL held
  position — needing more than held degrades to a whole-position exit, which
  brokers permit at any notional (the existing dust-exit exemption's rule).
  Dollar-based exits and exits with unknown held quantity are not bumped
  (no safe position bound) — skip path.
- Every bump is audited as `order_bumped_broker_minimum` (from/to notional,
  reason, account attribution) and the bumped order is **re-reviewed by the
  broker and still passes evaluateTradeProposal** — a bump never bypasses
  policy evaluation. Both order paths covered: the autonomous run loop and the
  human-approval execution path.

## Files

- `src/lib/broker-minimum-guard.ts` — `planBrokerMinimumBump`,
  `effectiveOpeningCapNotional`.
- `src/lib/strategy.ts` — bump-first wiring at both guard call sites.
- `src/lib/types.ts`, `src/lib/defaults.ts` (`brokerMinimumHandling: "bump"`),
  `app/api/policy/route.ts` (validation),
  `app/console/guardrails/field-defs.ts` (Hygiene → "Sub-minimum orders"
  select; skip→bump ranked looser, so switching to bump on a live account costs
  the typed word).
- `test/broker-minimum-bump.test.ts` (new, 13 tests incl. the production $4-NAV
  case), existing guard/sizing suites unchanged and green.

## Adversarial review (pre-land, money-path norm) — all findings fixed

An independent adversarial diff review + the activity-feed audit flagged, and
this branch now fixes:
- **Cap parity (P1)**: the planner's opening cap is now policy's OWN math —
  `openingPolicyNotionalCap` (incl. `maxShortOrderNotional`) with
  `applyOpeningOrderHeadroom` (the 5% buffer) — further bounded by remaining
  daily/hourly budget, and compared against the CUSHIONED bump target. Without
  this, bumps in the ~[$1.00–$1.05] cap window would be policy-rejected every
  run (uncooldowned), and a bumped order could newly breach the daily cap and
  **demote the account's authority** via autoRevertOnCapBreach (P2).
- **Sibling sizing field (P2)**: bump patches explicitly clear the other sizing
  key (brokers prefer `quantity` when both are set); tests assert it via an
  Object.assign round-trip (`toHaveProperty(k, undefined)` can't fail on a
  missing key).
- **Dollar-based exits (audit P3, the production AAPL case)**: converted to a
  position-bounded quantity order priced off the position's market value —
  declining them would have left the motivating loop alive post-merge.
- **Covers**: short positions carry negative quantities — magnitudes used.
- **Price-oracle bound**: quantity scaling declines when the reviewed notional
  is under $0.05 (unbounded scale-factor protection).
- **Receipt honesty**: successful bumps annotate the rationale with the
  before-size; failed bumps restore the original sizing + review and record
  `attemptedBumpToNotional` in the skip audit; guardrails hint says the bumped
  order "goes through" (not "passes") every policy check.

## Verification

- Focused: 34/34 across bump/guard/sizing suites (incl. the real production
  numbers: a $0.22 dollar trim of a $1.09 position converts to ~0.0046 sh).
  Full land.sh gate (tsc/tests/build) before push.

## Follow-ups

- The other Monet lane's empty claimed branch `monet/broker-min-bump-to-floor`
  (zero commits) can be deleted once this lands.

## Codex review round (2026-07-10, triaged by the MONET bump-lane per #ag***-s**c handoff)

- Full short-COVER exemption via magnitudes + mixed-form dollar orders never shrink to the floor
  (threads 2+7, fixed by the authoring lane at da79264a).
- Bump eligibility now also declines when the daily opening ORDER-COUNT budget is spent and when
  available BUYING POWER can't fit the floor (both would otherwise manufacture the policy
  rejection/authority-demotion this design exists to avoid) — both integration-tested.
- `applyDeterministicSizing`'s own floor-raise is now gated on `brokerMinimumHandling === "bump"` —
  unconditional, it made "skip" unreachable for autonomous openings.
- `claimProposalForExecution` persists execution-time proposal sizing (bump/reprice) into the row
  before placement — crash-recovery (`flagStalePlacingIntents`) books fills from that stored JSON,
  and Recent/Activity now show the executed order (was the #1280 delta, folded in here).
- Typed live-confirmation P1: resolved as annotate-not-ceremony — the confirmation is minted
  against the pre-bump notional; the bump delta is bounded (≤ floor + 0.5% cushion) and is the
  owner-ruled default, so no re-confirmation ritual; both sizes ride the audit event + rationale.
- New `test/broker-minimum-bump-execute.test.ts`: 6 integration tests driving the REAL
  executeProposal (bump+audit+row-persist, cap/buying-power/order-count declines, one-shot
  fallback with original-sizing restore, skip off-switch).
