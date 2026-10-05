# Quote asOf anchors (board 009b99f0de754dff)

## Context & Objective

Partial PR #3309 (`ag/quote-asof`) did not land the three remaining quote-provenance anchors.  Values that were not just observed were still stamped with the wall clock, and Alpaca equity quotes still used the ask as the price.  This pass is the smallest fix for those three sites so the staleness gate and displayed price match the observation.

## Changes Made

- `toQuoteOnlyMarketQuote` copies `quote.asOf` (Yahoo `regularMarketTime`).  A missing observation time stays undefined.
- The ROIC company-profile block leaves `asOf` undefined.  `parseRoicProfile` has no price timestamp, and inventing a field name would be a guess.  `isQuoteFresh` already treats a missing stamp as stale.  The cascade fallback may still return the price; it is not treated as fresh.
- `getEquityQuotes` sets `price` to `(bid + ask) / 2` when both sides are numbers, otherwise `ask ?? bid ?? 0`.  Bid and ask stay on the quote.  One-sided books keep the side that exists so the session-close fill can still price a symbol.
- The existing BRK.B alias assertion that pinned ask-as-price (`410`) now expects the mid (`409.5`).

Touched files:

- `src/lib/market.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/alpaca.ts`
- `test/quote-only-asof.test.ts`
- `test/alpaca-nbbo-mid.test.ts`
- `test/quotes-cascade.test.ts`
- `test/order-confirmation-status.test.ts`
- `docs/rollouts/2026-10-05-quote-asof-anchors.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md`

## Decisions & Trade-offs

- **Deferred:** `data-providers.ts` `takeScalar` still writes `cascadeFetchedAt = new Date()` for fields that lack their own asOf, and evidence-facts recency arbitration sits on that stamp.  Bundling it is a large behavior change, not a one-line sibling of these three anchors.
- **Deferred:** `syncQuotesToFieldStore` still falls back `asOf: prov?.asOf ?? quote.asOf ?? quote.fetchedAt ?? nowIso`.  Same class of wall-clock stamp.  Left for a follow-up so this diff stays the three anchors.
- **Deferred:** watchlist and symbol-drilldown age chips.  Board secondary; no UI change.
- ROIC `asOf` is always undefined in this block.  There is no upstream timestamp to pass through.
- `sources.asOf` on the Yahoo quote-only row stays `"yahoo-finance"` even when `asOf` is undefined.  That label is the provider, not the clock.
- Extra-ship no.  Do not merge this branch.  Do not Coolify deploy.

## Verification State

Failing-first, then the three anchors.  Before the behavior change the new tests failed: Yahoo `asOf` was a fresh ISO timestamp, the ROIC quote's `asOf` was a fresh ISO timestamp, and Alpaca `bp: 199` / `ap: 201` priced at `201`.

After the fix:

```bash
npx vitest run test/quote-only-asof.test.ts test/alpaca-nbbo-mid.test.ts test/quotes-cascade.test.ts test/order-confirmation-status.test.ts
# 4 files, 61 tests passed
```

Full `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build` are recorded in a follow-up commit on this branch once they finish.

## Next Steps & Blockers

- Open a ready PR.  Do not auto-merge.
- Kody threads: fix real issues or leave them open with a rationale.  Do not resolve a thread only so the PR can merge.
- Follow-up (separate PR): stop `takeScalar` from minting `cascadeFetchedAt` as an observation time, and stop `syncQuotesToFieldStore` from filling a missing `asOf` with `nowIso`.

## Zero-Code Findings

`isQuoteFresh` returns false for a missing `asOf` unless the quote is venue-price-authoritative or a verified realtime two-sided NBBO aged by `fetchedAt`.  A ROIC profile quote has no bid/ask, so it ages by `asOf`.  `isCascadeFieldComplete` also requires a two-sided book plus prevClose and OHLC, so a ROIC row does not stop the cascade via `acceptIfComplete`.  The end-of-cascade fallback still copies the best quote into the result.  The regression therefore asserts `asOf` is undefined and `isQuoteFresh` is false, not that the symbol is absent from the result.
