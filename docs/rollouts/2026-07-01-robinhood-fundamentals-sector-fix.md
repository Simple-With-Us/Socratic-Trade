# 2026-07-01 - robinhood-fundamentals-sector-fix

## Summary

Verified `RobinhoodEnrichmentProvider` ("robinhood-fundamentals", coded but gated off in
production via `ROBINHOOD_ENRICHMENT_ENABLED`) against live data, found a real
sector/industry taxonomy risk, and fixed it. Not yet enabled in production.

## Why

Per the owner's directive to take full advantage of free broker data before reaching for
paid third-party sources (`docs/broker-capability-plan.md` §10.5), Robinhood's free
fundamentals enrichment is a strong candidate — but its own code comment
(`data-providers.ts:1039`) explicitly warns "the broker field set/units should be verified
against `/api/admin/robinhood-probe` before trusting them next to other real numbers,"
which had never been done (0 logged calls to `robinhood-fundamentals` in production ever).

This session happened to have a live Robinhood MCP connector attached, so the exact
verification the code asks for was possible directly: called `get_equity_fundamentals`
for AAPL and compared the real response shape against `parseRobinhoodFundamentals`'s
expected fields. Numeric fields (`pe_ratio`, `high_52_weeks`, `low_52_weeks`,
`average_volume`) are clean, correctly string-encoded, and parse fine. `sector`/`industry`
came back as `"Electronic Technology"` / `"Telecommunications Equipment"` for AAPL —
Robinhood's own internal taxonomy, not the GICS-style taxonomy the rest of the app uses
(Yahoo Finance, Finnhub, and whatever a user types into `policy.sectorCaps`).

Traced why this matters: `SymbolEnrichment.sector` isn't just a display field —
`src/lib/market.ts` merges it into `MarketQuote.sector`, and `src/lib/policy.ts`'s
`sectorForSymbol()` falls back to `marketScan.quotesBySymbol[symbol]?.sector` before
`sectorCapFor()` looks it up in `policy.sectorCaps`. Since the enrichment cascade is
first-non-null-per-field-wins and this provider is seated early, enabling it as-is would
have let Robinhood's non-standard sector value win for most symbols, silently making that
symbol's configured sector cap stop matching (`sectorCaps["Electronic Technology"]` is
never going to be a key a user configured) — a real-money risk-control regression with no
error or warning anywhere.

## Files

- `src/lib/data-providers.ts` — `parseRobinhoodFundamentals` no longer maps `sector`/
  `industry`; only the four verified-safe numeric fields are mapped. Comment documents the
  live verification and the exact risk avoided.
- `test/data-providers.test.ts` — new `parseRobinhoodFundamentals` describe block using the
  real live-verified AAPL response shape: asserts numeric fields map correctly (incl.
  parsing Robinhood's string-encoded numbers), asserts `sector`/`industry` are never
  present in the output, and asserts a zero/missing/unparseable field is omitted rather
  than defaulting to 0.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/data-providers.test.ts` — 63/63 passing.
- Full suite / lint / build — run as part of the combined 2026-07-01 commit; see
  `docs/rollouts/2026-07-01-enable-alpaca-streams.md` and the commit message.

## Follow-ups

- **Not yet enabled.** Do not set `ROBINHOOD_ENRICHMENT_ENABLED=on` in production until
  this fix is deployed (`trading-live` currently runs the old, unfixed parser) — setting
  the flag before the deploy would reintroduce the exact sector risk this fix avoids.
- If sector/industry data from Robinhood is wanted later, it needs an explicit
  Robinhood-taxonomy -> GICS-style mapping table, not a raw passthrough — not attempted
  here (real scoped work, not a quick add).
- `docs/broker-capability-plan.md` §10.5 covers the broader free-vs-paid provider
  ordering audit this fix was part of.
