# Approval-time limit re-anchor + estimated closing P/L surfaces (MONET)

**Date:** 2026-07-16 (work began 2026-07-15 evening; a network outage killed the first
implementation workflow mid-run — the partial tree was recovered, completed, and verified)
**Seat:** MONET (owner-directed)
**Branch:** `monet/todays-errors-triage-handoff-8d809b`

## Summary

1. **Approval-time price freshness (money path).** A proposal awaiting user approval for
   hours/overnight used to place at its generation-time `limitPrice` — fresh quotes were
   already fetched at approval (`executeProposal`) and then ignored for ordinary limits
   (only extended-hours protective exits repriced). New `src/lib/approval-reprice.ts`
   re-anchors every pending limit proposal (any side) to the fresh approval-time quote,
   preserving the stored limit-to-anchor RATIO so the proposal's intent survives: a
   marketable limit stays marketable, a 2%-below-market patient entry stays 2% below
   today's market. Bracket TP/SL/stop-limit legs scale by the same ratio (geometry/R:R
   preserved) and are clamped ≥1 tick from the re-anchored entry — rounding alone can
   collide or invert the geometry (adversarially reproduced at the $1 tick boundary).
   **Consent:** material anchor drift (beyond the validated marketable-limit buffer, 15
   bps default) on a live typed-confirmation account re-queues the card for a fresh
   Approve instead of placing — identical semantics to the protective-exit and
   final-size requotes; the repriced order is persisted first so the next Approve
   confirms what will actually be placed. Immaterial drift persists-then-places through
   the existing CAS. Receipts: additive `TradeProposal` fields (`repriceAnchorPrice`,
   `repricedFromLimit`, `priceRequoteReason/At`); audits `approval_limit_repriced` /
   `approval_limit_reprice_reapproval` carry old/new/drift. `referencePrice` stays
   untouched (entry-drift guard + since-proposed analytics keep their anchor);
   subsequent reprices measure from the LAST anchor (no compounding).
2. **Estimated closing P/L, three surfaces (display-only).** Sell/cover approval cards
   (console `ApprovalCard` + mobile PWA pending cards) and position-closing open orders
   (console Orders page) now show estimated realized gain/loss: broker `averageCost`
   basis × shares (via the shared `requestedExitQuantity` sizing math; remaining
   unfilled qty for orders) against the freshest mark on the snapshot. All gated on
   **position-sign consistency** (`isClosingOrder`): a card/order over a position that
   flipped or closed while pending shows nothing rather than a wrong number. Orders
   page "Last price" now prefers the position's own mark (same snapshot, fresher) over
   the stale market-scan cache for held symbols, with honest tooltips.

## Why

Owner-directed (2026-07-15): stale approval prices ("the price should be updated…or it
should turn into a market order") and always-current est. loss/gain on sell decisions +
open orders. Re-anchoring was chosen over market-conversion/market-default: it keeps
limit protection, preserves the LLM's relative intent, and needed no KEEPOUT files
(`strategy.ts` untouched; `types.ts` additive-only — AG got an objection window, no
objection).

## Files

- `src/lib/approval-reprice.ts` (new) — ratio re-anchor + bracket scaling/clamp +
  materiality
- `src/lib/strategy-execution.ts` — wiring after the protective-exit reprice (reference-
  equality double-reprice guard); material→re-queue / immaterial→CAS-persist-then-place
- `src/lib/types.ts` — 4 additive optional receipt fields
- `src/lib/protective-exit-routing.ts` — exported `roundLimitOutwardToTick`,
  `validatedMarketableLimitBufferBps`, `isApprovalRepriceProtectiveExit` (extracted, no
  behavior change)
- `src/lib/broker-held-orders.ts` — `requestedExitQuantity` exported + structural param
- `app/console/lib/derive.ts` — `estimatedClosingPnl`, `isClosingOrder`,
  `positionMarkPrice` helpers
- `app/console/components/approval-card.tsx`, `app/console/orders/lib.ts`,
  `app/console/orders/page.tsx`, `app/mobile/mobile-pwa-client.tsx` — the three surfaces
- Tests: `test/approval-limit-reprice.test.ts` (new, 20), `test/console-orders-lib.test.ts`
  (new), `test/console-live-data-derive.test.ts` (extended)
- Boards/STATUS updated; this note.

## Verification

- Two-lens adversarial review (money-correctness + tests-and-ui with mutation checks).
  **All FIX findings fixed:** bracket leg/entry collision (clamp + 2 collision-probe
  tests), cover-side leg directions, unbounded rationale-tag stacking (dedup + test),
  approval-card/mobile position-sign gates, mobile dollar-sized-exit parity
  (`requestedExitQuantity`), materiality boundary float guard (+ test). Mutation checks:
  inverted short-sign and forced sell-with-no-position each broke tests; removing
  `retries`-style guards not applicable here.
- `npx tsc --noEmit` clean; 117 tests across the 6 affected suites green post-merge with
  main (`4877689b`). Full lint/test/build run by `scripts/land.sh` at land.

## Follow-ups / deferred

- Proposal revalidation loop stays verdict-only (withdraw/keep) — approval-time reprice
  makes stored prices safe; revisit only if the owner wants pending cards to display
  live-refreshed limits too.
- Roth IRA per-order floor (prior action item) still awaits the owner's click or a
  connected Chrome extension.
- Mobile PWA still renders no open-orders list (data already round-trips) — cheap future
  surface if the owner wants it.

## Codex autofix round 1 (2026-07-16, after initial review)

Codex reviewed the PR and flagged three items; two were fixed, one was asked to maintainer:

- **[fixed] P2 — Prefer real scan quotes over cost-fallback marks** (`app/console/orders/lib.ts`):
  When Robinhood cannot quote a position it falls back to `marketValue = quantity * averageCost`,
  making the position "mark" effectively the purchase price. `effectiveOrderPrice` now detects
  this (mark ≈ averageCost within float epsilon) and prefers a real scan quote instead of
  showing cost basis as the current price.
- **[asked] P1 — Preserve explicit limits without a true quote anchor** (`src/lib/approval-reprice.ts`):
  Asked maintainer whether `ensureReferencePrice`'s limitPrice fallback should be excluded from
  re-anchoring, or if the current behavior is correct.
- **[fixed] P2 — Cap estimated closing P/L to current holdings** (`app/console/orders/lib.ts`):
  `closingOrderPnl` now caps `shares` to `Math.abs(position.quantity)` so a stale oversize exit
  order (e.g. user partially sold after the card was created) doesn't overstate the P/L estimate.

## Codex autofix round 2 (2026-07-16, second pass)

Codex posted another finding after round 1 was pushed:

- **[fixed] P2 — Cap pending-exit P/L to current holding** (`app/console/components/approval-card.tsx`):
  The approval-card path still passed `requestedExitQuantity(p)` directly into `estimatedClosingPnl`
  without capping. When an approval card is stale and the user has already reduced the position, the
  requested sell/cover size could exceed the current holding, overstating the realized P/L. Now capped
  via `Math.min(exitQty, Math.abs(matchedPosition.quantity))` — same guard as `closingOrderPnl` in
  `orders/lib.ts`. Verify: tsc clean, 4649 tests pass, build clean.

## Codex thread triage round 3 (2026-07-16 afternoon, MONET — all 7 open threads fixed)

- **P1 anchor provenance** (`approval-reprice.ts`): `ensureReferencePrice`'s defensive
  `referencePrice = limitPrice` stamp is indistinguishable from a genuine quote anchor except by
  exact equality — re-anchoring it would turn a reviewed hard limit into a current-market limit.
  An exactly-equal anchor (with no carried `repriceAnchorPrice`) now never reprices; the stored,
  reviewed limit places verbatim. Genuine marketable limits carry a bps offset so they still
  reprice. Tests: exec-level hard-limit placement + module-level skip/carried-anchor pair. (Five
  pre-existing bracket test fixtures coincidentally used ref===limit and passed vacuously — given
  carried anchors so they exercise the real path.)
- **P2 entry-drift honor** (`strategy-execution.ts`): once the reprice moves the limit, the drift
  guard's limit-order exemption no longer protects the thesis — an OPENING whose anchor drifted
  beyond `policy.maxEntryDriftPct` now re-queues for fresh consent on EVERY execution mode (paper
  included), not just live+typed. Test: paper opening at ~12.2% drift re-queues, not places.
- **P2 requeue decision receipt** (`strategy-execution.ts`): the held card now persists
  `approved: false` + reason (final-size requote pattern) so reloads/other clients can't see an
  approved receipt for an order explicitly held. Covered in the same test.
- **P2 sizing-snapshot refresh** (`strategy-execution.ts`): a repriced risk-adding opening
  recaptures `sizingSnapshot` (same `captureProposalSizingSnapshot` inputs as the final-size path)
  so learning/lifecycle receipts match the order the broker sees.
- **P2 bracket whole-share re-check** (`approval-reprice.ts`): a dollar-sized bracket that goes
  sub-one-share after an upward reprice strips its legs (generation-path parity; synthetic stops
  still protect) instead of letting the gateway floor to 0 and 422. Test: $100 bracket repriced
  past $100 strips; $500 keeps.
- **P2 approval-card cost-suspicious mark** (`approval-card.tsx`): a price exactly equal to
  `averageCost` is the broker's no-quote fallback — the card now omits the est-P/L line rather
  than rendering a fake $0.00 (same epsilon rule Codex added to `effectiveOrderPrice`).
- **P2 mobile cap + suspicious-mark parity** (`mobile-pwa-client.tsx`): exit shares capped to the
  current holding and the exact-cost mark omitted, matching the console surfaces.
