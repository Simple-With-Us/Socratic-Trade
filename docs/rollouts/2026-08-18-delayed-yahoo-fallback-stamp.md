# 2026-08-18 — Stamp delayed fallback on approval cards; keep trading

## Context & Objective

Owner ruling: when quotes are delayed Yahoo fallback, stamp user-facing
**Delayed Quote** on approval cards and KEEP TRADING.  Do not write coordinator
notes into card or iOS copy.  Do not fail-closed openings.  Do not block
Green/Red because the quote is delayed.  Live broker / Alpaca snapshot misses
still fall through to Yahoo (~15–20m).  That tape must stay visible and must
not stop openings.

Did not steal #2792 / #2798 / #2800 / #2794.  No Stripe.

## Changes Made

- Detect delayed Yahoo fallback (`yahoo-finance-delayed`, cascade Yahoo used
  after the live freshness bar, or an explicit `delayedFallback` stamp).
- Stamp the flag on cascade FALLBACK quotes and Alpaca close-fill quotes.
- Age those quotes by fetch snapshot (`fetchedAt`), not the delayed print, so a
  just-fetched 15m Yahoo tape does not convert the opening to a limit.
- Persist `quoteDelayedFallback` on the proposal and `delayedFallback` on the
  pending card.  Website + iOS approval cards show **Delayed Quote**.
- Openings stay approved.  Green/Red are not skipped.

### Files

- `src/lib/quote-delayed-fallback.ts` (new)
- `src/lib/quotes-cascade.ts`
- `src/lib/alpaca.ts`
- `src/lib/market.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `src/lib/dashboard.ts`
- `src/lib/approval-quote-scan.ts`
- `src/lib/proposal-price-review.ts`
- `src/lib/types.ts`
- `src/lib/defaults.ts`
- `app/console/components/approval-card.tsx`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/ProposalPriceReview.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTradeTests/ProposalPriceReviewTests.swift`
- `test/quote-delayed-fallback.test.ts` (new)
- `test/quotes-cascade.test.ts`
- `test/staleness-gate.test.ts` (unchanged contract; delayed path covered in new file)
- `test/alpaca-quote-fallback.test.ts`
- `test/proposal-price-review.test.ts`
- `test/approval-quote-scan.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`

## Decisions & Trade-offs

- Tradier venue-authoritative delay is not "delayed fallback".  That is the
  sandbox fill tape, already aged by `fetchedAt`.
- A Yahoo cascade print that clears the live freshness bar is not stamped.
  Only fallback / explicit delayed Yahoo.
- If the fetch snapshot itself is stale, the existing limit backup still
  fires.  The opening is not blocked.
- User-facing stamp is **Delayed Quote** (Title Case chip).  Sentence:
  "This price is delayed.  You can still approve the order."  Rationale is
  not used as a coordinator channel.
- iOS Home / Data Sources coordinator asides already landed on main
  (this rebase kept those files as main; #2857 Desk subtitle fold stays).
- Did not touch FilingAPI, Pinecone, iOS release-readiness, or Stripe lanes.

## Verification State

```bash
npm run lint          # exit 0
npx tsc --noEmit      # exit 0 (after mergeQuoteData extra type)
npx vitest run test/quote-delayed-fallback.test.ts \
  test/quotes-cascade.test.ts \
  test/alpaca-quote-fallback.test.ts \
  test/proposal-price-review.test.ts \
  test/approval-quote-scan.test.ts \
  test/staleness-gate.test.ts \
  test/strategy-hardening.test.ts \
  test/dashboard-ui.test.ts
# 49 + 110 focused tests passed
npm run build         # exit 0 (Next.js 16.3.1 webpack)
```

Copy follow-up (user-facing **Delayed Quote**, no iOS coordinator asides):

```bash
npm run lint          # exit 0
npx tsc --noEmit      # exit 0
npx vitest run test/quote-delayed-fallback.test.ts \
  test/proposal-price-review.test.ts \
  test/staleness-gate.test.ts
# 26 passed
```

iOS unsigned `xcodebuild` passed on the first CI run of PR #2818 (no Xcode on this VM).
`npx tsc --noEmit` failed once on `mergeQuoteData` extra (`delayedFallback` missing
from the extra type); fixed in `6b2b9037`.  Full local `npm test` also hit
unrelated env flakes (TwelveData quota, vector-db receipts, server-metrics host
metadata, 30s retrieval-scope timeouts) — not this change.

## Next Steps & Blockers

- Rebase-only onto `origin/main` `ce31c367` (2026-08-20).  Conflicts were
  `ios/SocraticTrade/DataSourcesSettings.swift` and
  `ios/SocraticTrade/HomeView.swift`; kept main so this PR does not rewrite
  already-landed Data Sources number rows / #2857 Desk subtitle fold.
- Do not merge from this rebase.  Leave CI green.
- Confirm a live delayed-Yahoo opening shows the stamp on website + iOS.

## Zero-Code Findings

None — this is an implementation change.
