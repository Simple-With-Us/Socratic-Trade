# 2026-06-21 — Scan default columns (expert panel) + Alpaca VWAP/feed + bear-test fix

## Summary
1. **New default-visible Market-Scan columns**, chosen by a 4-persona financial-expert panel
   (momentum/swing, execution/microstructure, risk, value/quality) synthesized by a research
   lead. The new default (11 cols, Score pinned far-right):
   `symbol · price · Chg · vs VWAP · Sec RS · % off Hi · $ Vol · Spread · Bid · Ask · Score`.
   Reads left-to-right as one question: *"is this name moving, leading, in a tradeable spot, and
   can I get filled cheaply right now?"* Replaces the prior 8-col set; **bid/ask are now shown by
   default** (owner mandate) alongside the real Spread, since Alpaca now supplies real quotes.
2. **More real Alpaca data in the scan.** The snapshot provider now also maps **VWAP**
   (`dailyBar.vw`) — wired end-to-end so the existing "vs VWAP" column lights up for every symbol —
   and the data **feed is env-configurable** (`ALPACA_DATA_FEED`, default `iex`).
3. **Fixed an unrelated tsc break** another lane introduced in `test/deterministic-bear.test.ts`
   (commit `61b560e`): `null` → `undefined` for `number|undefined` fields, and corrected the
   `timeInForce`/`marketHours` enum literals. Cleared 5 tsc errors blocking the merge.

## Why
- Owner asked to show bid/ask by default and to have a financial expert pick the best default set.
- SIP feed is **not available** on the free Alpaca plan (live probe returned HTTP 403
  "subscription does not permit querying recent SIP data"), so IEX stays the default; the env knob
  lets a paid plan flip to `sip`/`otc` with no code change.
- VWAP comes free in every IEX snapshot and a "vs VWAP" column already existed reading
  `MarketQuote.vwap`, so it was zero-cost incremental data.
- A committed-but-non-compiling test on the branch had to be fixed before merging (CLAUDE.md
  requires tsc clean).

## Files
- `app/dashboard-client.tsx` — `DEFAULT_SCAN_COLS` set to the panel's 11 ids; `SCAN_COLS_KEY`
  bumped `v2`→`v3` so the new default replaces saved layouts; updated the rationale comment.
- `src/lib/data-providers.ts` — `SymbolEnrichment.vwap`; `"vwap"` added to `EnrichmentSourcedField`
  + `EMPTY_SOURCED`; `takeScalar("vwap", …)` in the cascade; `parseAlpacaSnapshot` maps
  `dailyBar.vw` (never-fabricate, `>0`); new exported `alpacaDataFeed()` helper + snapshot URL uses
  it; `AlpacaSnapshot.dailyBar.vw` typed.
- `src/lib/market.ts` — `applyEnrichment` copies `vwap` (source attribution flows via `mergeSources`).
- `test/data-providers.test.ts` — +VWAP mapping/omission tests and an `alpacaDataFeed()` describe block.
- `test/deterministic-bear.test.ts` — tsc fixes (not our feature; unblocks the tree).

## Verification
- `npx tsc --noEmit` — clean (the 5 bear-test errors are resolved).
- `npm test` — **580 passed** (70 files).
- Live pull through the per-user store path: AAPL `vwap=298.06`, NVDA `vwap=209.34` (real IEX VWAP);
  `alpacaDataFeed()` resolved `iex`.

## Follow-ups
- Alpaca historical bars could supply 52-week high/low / ATR (feeding `rr52w`, `% off Hi`, `MoS`)
  as an alternative to Yahoo — heavier (per-symbol or multi-symbol bars call); deferred.
- If computed `$ Vol` coverage proves thin, the panel suggested swapping `dollarVolM`→raw `volume`;
  and `rr52w` is the first add-back if the default is ever widened to 12 columns.
