# 2026-06-30 - alpaca-share-class-symbol-mapping

## Summary

- Fixed Alpaca orders failing with `HTTP 422 asset "BRK-B" not found` for
  share-class tickers (Berkshire Hathaway B, Brown-Forman B, etc). Added
  `toAlpacaSymbol`/`fromAlpacaSymbol` in `src/lib/alpaca.ts` and applied them
  at every Alpaca API boundary: order placement (both the REST fallback and
  MCP tool-call paths), `getLatestQuotes`, and the order/position response
  mappers (`mapAlpacaOrder`, `parseAlpacaPosition`).

## Why

- Our canonical symbol format uses a hyphen for share classes (`BRK-B`), the
  Robinhood convention documented in `src/lib/sp500.ts:2`. Alpaca's REST API
  requires a dot (`BRK.B`) and rejects the hyphenated form outright. The
  order path passed `input.symbol` straight through, and `getEquityQuotes`
  had the same bug on the outbound side, keyed the returned quotes by
  Alpaca's dot-notation symbol, and silently fell through to the Yahoo
  keyless fallback since the hyphenated lookup key never matched — masking
  the mismatch instead of fixing it. `mapAlpacaOrder`/`parseAlpacaPosition`
  only uppercased Alpaca's raw response symbol, so a filled `BRK.B` order
  would come back into internal state as `BRK.B` instead of `BRK-B`,
  breaking matches against watchlist/proposal symbols downstream.

## Files

- `src/lib/alpaca.ts` — added `toAlpacaSymbol`/`fromAlpacaSymbol`; applied at
  `placeEquityOrder` (both REST and MCP order-arg construction),
  `getEquityQuotes` (outbound request + inbound response keys),
  `mapAlpacaOrder`, `parseAlpacaPosition`.
- `test/alpaca-order-mapping.test.ts` — added regression coverage for the
  hyphen↔dot conversion and for `mapAlpacaOrder`/`parseAlpacaPosition`
  normalizing a dot-notation symbol back to hyphenated form.

## Verification

- `npm run lint` (0 errors, 254 pre-existing warnings)
- `npx tsc --noEmit`
- `npm test` (165 files / 1582 tests, all passing)
- `npm run build`

## Follow-ups

- `src/lib/streams/alpaca-price-events-stream.ts` subscribes to Alpaca's bar
  websocket using the same hyphenated symbols and would hit the identical
  dot-vs-hyphen mismatch for share-class tickers on that feed. Left
  untouched here since it's a separate, default-off, flag-gated (
  `STREAMS_ALPACA_PRICE_EVENTS_ENABLED`) code path — worth the same
  `toAlpacaSymbol`/`fromAlpacaSymbol` treatment in a follow-up if that stream
  is enabled for accounts holding share-class tickers.
