# 2026-06-18 — Free no-key market-signal connectors (Cboe, CFTC, Fama-French) + FRED key

## Summary
Added `FRED_API_KEY` (macro layer now pulls live) and built three new free/no-key
data connectors, aggregated into one `marketSignals` block fed to the LLM. All are
market-wide regime/sentiment signals (not per-symbol), cached 6h, failure-tolerant
(a down source drops out — never fabricated).

## New connectors (src/lib/market-signals/)
- **cboe.ts** — Cboe public CDN delayed quotes (no key): `skew` (CBOE SKEW — tail-risk /
  crash-hedging demand) and `vvix` (vol-of-vol). VIX/VIX3M already come from FRED.
- **cftc.ts** — CFTC Commitment of Traders, Socrata API (no key; optional app token):
  E-mini S&P 500 large-speculator net positioning (`cotSpNonCommNet`, `...PctOI`) +
  report date. `summarizeCotRow` is pure/tested.
- **famafrench.ts** — Kenneth French Data Library (no key): trailing ~1-month cumulative
  factor returns — market (mktRf), size (smb), value (hml), momentum (mom). Single-CSV
  ZIPs extracted with `zlib.inflateRawSync` (minimal in-file ZIP reader, no new dep).
  `unzipSingleFile`, `parseFamaFrenchDaily`, `trailingSum` are pure/tested.
- **index.ts** — `getMarketSignals()` aggregator + 6h cache + `MarketSignals` type.

## Wiring
- `src/lib/strategy.ts` — `getMarketSignals()` in `buildUserContent`; added `marketSignals`
  to the LLM `userContent`; documented `marketSignals` in the system context (how to read
  skew/vvix/COT/factor regime).
- `next.config.mjs` — stub `zlib`/`node:zlib` out of the client bundle (same insurance as
  the earlier `crypto` fix; famafrench imports zlib).
- `.env.local` — `FRED_API_KEY` added (gitignored).

## API keys
- **No keys required** for any of the three new connectors (all free/no-key).
- FRED key now set → macro is live (validated below).
- Optional later: a CFTC Socrata app token (only raises rate limits; not required).

## Verification
- `npx tsc --noEmit` clean · `npm test` → **181 tests** pass (25 files) · `npm run build` compiles.
- FRED live with the new key: DGS3MO 3.79%, T10YIE 2.26%, BAMLH0A0HYM2 2.71%, DCOILWTICO $84.65, VXVCLS 19.53.
- Live `getMarketSignals()` (temp test, since removed): skew 142.62, vvix 94.53,
  cotSpNonCommNet −205,644 (−9.3% OI, 2026-06-09), factors1m {mktRf 9.53, smb 0.19,
  hml −1.21, mom 10.3} as of 2026-04-30.
- Dev server healthy (GET / and /api/dashboard → 200).

## Notes / limitations
- **Fama-French data lags** (~6 weeks; the free daily file updates roughly monthly). Treat
  the factor regime as a slow-moving style signal, not a real-time read.
- CFTC COT is **weekly** and futures-based (E-mini S&P 500) — a broad positioning gauge, not per-stock.
- These signals reach the LLM only (no UI panel yet).

## Follow-ups (open)
- Optional: surface `marketSignals` + `macroDerived` in a compact "Macro & Market" UI panel.
- Optional: add Fama-French 5-factor (RMW/CMA) and more COT contracts (Nasdaq, VIX futures).
- Tuner still doesn't read derived/macro/signal evidence back as a learning signal.
- API keys present in .env.local but not yet consumed by code: MARKETSTACK, TRADIER, PINECONE, MASSIVE_* (future opportunities).
