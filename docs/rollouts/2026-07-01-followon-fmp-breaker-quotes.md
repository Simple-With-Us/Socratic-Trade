# 2026-07-01 — Follow-ons from audit Chat D/E (issue #306)

Branch: `claude/trading-audit-d-e-dpw0h7` (restarted from `origin/main` after PR #292
merged — this is a NEW change/PR, not a reopen of the merged one).

## Summary

Closes the three non-mechanical follow-ups tracked in issue #306 after PR #292 merged:

1. **FMP `short_interest` endpoint (issue #306 item 1) — removed as non-deliverable.**
   FMP does **not** publish short interest: there is no `/short_interest` (or equivalent)
   endpoint on FMP's API surface (verified 2026-07 against FMP's public API docs and the
   official FMP MCP tool surface — the closest fields are shares-float/outstanding, not
   short interest). The speculative `GET /api/v4/short_interest` sub-call always 404'd, so
   the FMP "second short-interest source" and the Yahoo-vs-FMP disagreement bulletin never
   actually fired. Removed the dead code path end-to-end (see Files). Yahoo Finance's
   `shortPercentOfFloat` remains the single real source; a genuine second source would need
   a real provider such as Massive or Finnhub — noted inline for the next implementer.

2. **Circuit breaker per-credential-lane scoping (issue #306 item 2).** `applyCircuitBreaker`
   previously tripped a provider only when **every** health lane for its service was in hard
   consecutive-failure — so in a multi-credential setup a dead env-key lane and a healthy
   user-key lane cancelled out and the dead lane kept getting hit. Providers now declare the
   credential lane they run on (`healthKeySource`), and the breaker filters health lanes to
   that key source: a provider trips only when **its own** lane is hard-stopped. Keyless
   providers (Yahoo, SEC XBRL, Robinhood MCP tiers, etc.) leave `healthKeySource` unset and
   keep the prior all-lanes-for-service behavior. Default-off feature (`ENRICHMENT_CIRCUIT_BREAKER_ENABLED`).

3. **`extractUnderlyingPrice` top-level `{ quotes: [...] }` envelope (issue #306 item 3).**
   The parser already resolves this envelope (the `Array.isArray(root?.quotes)` branch landed
   inside PR #292 during a later review round, after the issue was drafted). Added the missing
   regression test that locks in the `{ quotes: [...] }` shape (flat row, nested `quote`
   sub-object, and symbol filtering) so it can't silently regress. Affects only the default-off
   Robinhood options tier's moneyness anchor.

**Issue #306 item 4** (short-interest disagreement bulletin surviving the web-signal overlay)
is now **moot**: the FMP disagreement bulletin was the only enrichment-side `evidenceBulletin`,
and it was removed with item 1. The overlay itself was independently changed to merge (not
replace) `evidenceBulletins` in #307, so any future enrichment bulletin already survives.

## Why

The FMP short-interest call was shipped speculatively in #292 and flagged by Codex as
targeting an endpoint FMP doesn't document. Verifying it confirmed FMP has no short-interest
data, so carrying the parse/cache-guard/disagreement machinery was dead weight that also made
a `short_interest` transient failure block caching the whole FMP row. The breaker and quotes
items were deferred from #292 as non-mechanical; #306 tracked them.

## Files

- `src/lib/data-providers.ts`
  - Removed `shortPercentOfFloatFmp` and `shortInterestDisagreement` from `SymbolEnrichment`,
    the cascade carry, the Yahoo-vs-FMP cross-check block, the `delete base.shortPercentOfFloatFmp`,
    the `shortInterestDisagreementThresholdPct()` helper, the FMP `/api/v4/short_interest` fan-out
    sub-call + its parse block, and reverted the FMP cache guard to the pre-short-interest condition.
    Left an inline NOTE explaining FMP has no short-interest endpoint.
  - Added `healthKeySource?: ApiKeySource | null` to `MarketEnrichmentProvider`; added the
    `withHealthLane()` helper and wrapped the 9 keyed provider push sites (Alpaca snapshot,
    Intrinio, Tiingo, FintechStudios, Finnhub, TwelveData, Alpaca news, Alpha Vantage, FMP);
    scoped `applyCircuitBreaker`'s lane filter to `s.keySource === lane` when set.
- `src/lib/market.ts` — removed the `evidenceBulletins: extra.shortInterestDisagreement ? … : …`
  override in `applyEnrichment` (bulletins now flow through the `...quote` spread unchanged).
- `test/data-providers.test.ts` — dropped the 3 FMP `short_interest` caching tests and the 2
  Yahoo-vs-FMP disagreement tests; adjusted FMP sub-call counts (5→4, 10→8).
- `test/milestone-4-challenger.test.ts` — FMP sub-call count 5→4 / 10→8.
- `test/market.test.ts` — removed the short-interest-disagreement evidence-bulletin test.
- `test/data-sources-breadth.test.ts` — added the per-credential-lane breaker test and the
  `{ quotes: [...] }` envelope regression test.
- `docs/phase-4-market-data-scoring.md` — replaced the "FMP second short-interest source" bullet
  with the FMP-has-no-short-interest note + the per-lane breaker scoping detail.

## Verification

Run in the Cloud VM (single `/workspace` checkout):

- `npm run lint` → **0 errors** (277 grandfathered warnings).
- `npx tsc --noEmit` → **8 errors, all in `src/lib/congress-share.ts`** — the private
  `@jaywedgeworth22/congress-trading-shared` stub in this environment doesn't export
  `resolveTickerAlias` (and related members). Environmental, not from this change.
- `npm test` (vitest) → **2033 passed; 36 failed across 4 `congress-*` files only**
  (`congress-analytics`, `congress-share`, `congress-share-price-targets`,
  `congress-trade-client`) — same private-stub cause (`https://congress.tradeundefined/…`).
  The 4 files this change touches pass (129/129: data-sources-breadth, data-providers, market,
  milestone-4-challenger).
- `npm run build` → fails only at the type-check step on `congress-share.ts:28` (same stub).

CI uses the real shared package and is authoritative for the congress-* files; this change
touches no congress code.

## Follow-ups

- A real second short-interest source (Massive or Finnhub) if a Yahoo cross-check is still
  wanted — issue #306 item 1's "switch to a provider that actually serves short interest" path.
- Issue #306 can be closed once this lands (all 4 items resolved or moot).
