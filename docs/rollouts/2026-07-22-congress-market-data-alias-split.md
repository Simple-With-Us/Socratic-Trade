# 2026-07-22 — Congress market-data alias: rename vs acquisition (shared package)

## Summary

Salvage of the unique kernel from closed PR #1906 onto current main: market-data outbound
rows (prices / fundamentals / analyst / insider / short-volume) now drop acquisition tickers
instead of folding them onto the acquirer, while company-identity refs still fold via
`resolveTickerAlias`. Classification comes from `@jaywedgeworth22/congress-trading-shared@v2`
(`classifyTickerAlias` / `resolveContinuousTicker` / curated maps) — no local acquisition set,
no shared-package downgrade.

Also: when every row in a share payload is schema-dropped, `shareWithCongressTrade` returns
`skipped:false` / `reason:"all-rows-dropped"` so the daily marker does not advance on silent
schema drift.

## Why

`resolveTickerAlias` is identity/display resolution (ATVI→MSFT). Using it for market data
pollutes the acquirer's price/fundamental series with the acquired ticker's history. Shared v2
already encodes rename vs acquisition; Socratic just was not using that API on the market-data path.

Owner-directed salvage after the Grok PR audit closed the stale #1906 reopen (which also
downgraded the shared package and rewrote congress-stream).

## Files

- `src/lib/congress-share.ts` — `canonicalMarketDataSymbol`; market-data mappers; all-rows-dropped
- `test/congress-share.test.ts` — rename/acquisition + all-rows-dropped coverage
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout

## Verification

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run test/congress-share.test.ts
# then land.sh gate
```

## Follow-ups

- #1914 Monet "block oversized below-min exits": **not landed** — main already bumps exits
  (`brokerMinimumHandling: "bump"`); owner ruled bump/fix, not block.
- #1909 reflection decompose / regime-conditioned retrieval: explained to owner; wait for greenlight
  before salvage (main already has some per-account reflection + lesson vectors).
