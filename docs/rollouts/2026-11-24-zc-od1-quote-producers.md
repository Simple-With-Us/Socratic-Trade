# 2026-11-24 — ST-4679 OD-1: wire bar-derived quote fields from the EOD cache into scan candidates

## Context & Objective

PR #5465 (ST-4666 Wave 2C) added multi-horizon momentum, realized-volatility and 20-day ADV reads to scan-candidate scoring, but those reads consume optional quote fields (`return5d/20d/60d/126d`, `realizedVol20d/60d`, `atrPct`, `avgVolume20d`) that nothing wrote, so the logic was inert in production.   This change wires the producer side: it derives those fields from the stored nightly OHLC cache (`history_cache_eod`, already filled over the rotating watchlist by `refreshTechnical` in `src/lib/web-sources/technical.ts`) and attaches them to scan candidates ahead of `scoreFactors`, with no network in the scan path.   Owner-approved OD-1; child of ST-4668.

## Changes Made

Producer helper, batched cache read, and attachment in every scored scan path; absent bars leave today's fallback byte-identical.

- `src/lib/bar-quote-fields.ts` (new): pure exported `barDerivedQuoteFields(bars)` returns the optional fields from a daily bar series (oldest -> newest, the `fetchHistoryCacheEod` shape).   `return5d/20d/60d/126d` are percent close-to-close returns over the literal trailing windows (reusing `rocPct`'s convention after validating the whole window); `realizedVol20d/60d` are annualized stdev of daily log returns (`sqrt(252) * 100`, percent); `atrPct = ATR14 / lastClose * 100`; `avgVolume20d` is the integer mean of the last 20 volumes.   Any hole or insufficient window omits that field.   Mirrors `scorecardIndicatorsFromBars` hole-handling without importing `strategy.ts` (cycle); reuses the pure `indicators.ts` `rocPct`/`atr`.
- `src/lib/history-cache.ts`: added `fetchHistoryCacheEodBulk(symbols)` — one chunked `IN (...)` query (chunk 400, mirroring `db-embed-stage.ts`) returning `Map<normalizedSymbol, OHLCBar[]>`, with the same `>= 2` bars guard and enablement guards as the per-symbol `fetchHistoryCacheEod` (off switch; test runtime requires `MASSIVE_LOCAL_HISTORY_ENABLED=on`).   Cache reads only, no network.
- `src/lib/market.ts`: imported the helper + bulk accessor; added exported `barDerivedFieldsBySymbol(symbols)` (bulk read -> per-symbol fields map) and `attachBarDerivedFields(quote, map)` (merge by symbol then normalized symbol, unchanged when absent).   In `nasdaqDelayedProvider.scan`, computed `barFieldsBySymbol` once over the preselection pool and wrapped all three scored paths before `scoreFactors`: `applySeededPool` (also the abort fallback), the live `applyEnrichment` path, and the skip/no-provider path.   The unscored ranked fallback keeps its original behavior.
- `test/market.test.ts`: 14 new tests — helper units + hole/insufficient omissions; each field reaching its score (momentum, volatility, liquidity); absent-bars byte-identical fallback; and a DB-backed scan-assembly test seeding `history_cache_eod` rows proving the bulk producer attaches fields end to end.
- `docs/rollouts/2026-11-24-zc-od1-quote-producers.md` (this note) and a `STATUS.md` stanza.

## Decisions & Trade-offs

- Units mirror the readers exactly: returns and realized vol are PERCENT (the momentum `tanh` scales and the volatility `105 - vol * 1.33` map are calibrated to percent), and `avgVolume20d` is a SHARE COUNT (`liquidityScore` and the `strategy-risk.ts` ADV cap multiply it by price).   Verified against `market.ts` `multiHorizonTrendScore`/`volatilityScore`/`liquidityScore` and `strategy-risk.ts` the ADV cap.
- Realized vol uses LOG returns per the OD-1 spec, while keeping `vol-targeting.ts`'s `sqrt(252) * 100` annualization and population-variance convention; the magnitude is near-identical to simple returns at daily scale.
- Strict literal-window omission (any hole / too few bars -> field absent) mirrors `scorecardIndicatorsFromBars`; this keeps the absent-bars fallback byte-identical because only defined keys are emitted and merged.
- No `types.ts` change: `MarketQuote`/`MarketQuoteSummary` do not carry these fields and the readers/tests cast locally, matching the existing `avgVolume20d` test convention.
- The bulk read returns each symbol's full stored series (the helper slices the tails it needs); row volume is bounded by the enrichment pool cap (default 500) and the local SQLite cache.   A last-N-bar SQL bound was deliberately not added to keep the accessor idiomatic and minimal.

## Verification State

Lint and targeted vitest only in this lane; the serialized full gate is left to the lead (this box also hosts production).

- `npm run lint` -> 0 errors (913 grandfathered warnings); `npx eslint` on the four changed source/test files -> clean (exit 0).
- `npx vitest run test/market.test.ts test/antigravity-cheap-wins.test.ts` -> 71 passed (60 market incl. 14 new; 11 ADV cases green).
- `npx vitest run test/history.test.ts test/market-dynamic-universe.test.ts test/provenance-stamps.test.ts test/scan-broker-universe-recovery.test.ts` -> 66 passed (history-cache accessors + scan path regression).
- NOT run here (left to the lead before push): `npx tsc --noEmit`, `npm run build`, full `npm test`.   Known local-only Node 22 failure `test/cpuprofile-summary.test.ts` was not run.

## Next Steps & Blockers

Lead runs the serialized full gate (tsc -> vitest -> build) plus lint, then pushes / opens the PR / merges per fleet protocol.   No blockers in this lane; the producer is cache-only and inert-safe when bars are absent.

## Zero-Code Findings

None.
