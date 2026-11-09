# 2026-06-18 — Keys (SEC/encryption), Macro UI panel, and wiring Tradier/Marketstack

## Summary
Three things: (A) added the SEC user-agent + a generated encryption key + activated computed
technicals; (B) built the Macro & Market UI tab; and wired the previously-unused price-history
keys (Tradier, Marketstack) into the actual fetch cascade.

## A) Env / keys (.env.local — gitignored)
- `SEC_EDGAR_USER_AGENT=<descriptive app/contact user agent>` — SEC insider/8-K connectors now identify politely (SEC asks for a contact UA; reduces throttling).
- `ENCRYPTION_KEY=<32-byte hex>` — **self-generated** with `crypto.randomBytes(32).toString("hex")` (not a provider key). `db.ts` does `Buffer.from(ENCRYPTION_KEY,"hex")` for AES-256-GCM; without it the app used a memory-only key (encrypted broker keys lost on restart). Now persistent.
- `FRED_API_KEY` — set last round; validated live this round (real macro now flows).
- `TECHNICAL_SOURCE=computed` — activates the in-house technical producer (RSI/MACD/MA from price bars) instead of the push-only TradingView producer.

## B) Macro & Market UI tab
- `app/ui/macro-panel.tsx` — NEW `MacroBoardView`: 5 sections (Rates & Yield Curve, Inflation
  & Growth, Risk & Volatility, Positioning & Factor Regime, Liquidity & Other) of tiles with
  tone coloring (inverted curve / backwardation / elevated SKEW / wide HY spread / negative ERP).
- `src/lib/dashboard.ts` — snapshot now computes `macroBoard` { macro, derived, signals, regime }
  (FRED macro + deriveMacroMetrics + getMarketSignals + regime). ERP uses the persisted run's
  scan median earnings yield when available.
- `app/dashboard-types.ts` — `DashboardSnapshot.macroBoard` typed.
- `app/dashboard-client.tsx` — added the "Macro" workspace tab + content branch + ⌘K command.

## Wiring the unused price-history keys (Tradier, Marketstack)
- `src/lib/history.ts` defined `fetchTradier`/`fetchMarketstack` but the cascade only called
  Yahoo + Stooq — the keys were never used. Fixed the cascade to Tradier → Marketstack → Yahoo
  → Stooq (keyed sources self-skip without a key). This powers the drilldown price chart AND the
  computed technical producer (which had unreliable bars from datacenter-IP Yahoo/Stooq).
  NOTE: a parallel session converged on the same fix (with temp `[history-debug]` logging) —
  left as-is, not duplicated.

## Continuation hardening
- `.env.example` now mirrors the expanded provider surface without real secrets.
- `src/lib/dashboard.ts` no longer casts a trimmed historical audit `marketScan` into
  a full `MarketScan` for macro internals; it only computes equity-risk-premium input
  when the stored scan actually has full quote fields.
- Dashboard snapshot reads now pass `userId` through strategy prompt, connected-account,
  strategy-run, and fill-list calls where those helpers already support user scoping.
- `DashboardSnapshot.webSources` now includes the technical-source status returned by
  `getWebSourcesStatus()`.
- `test/history.test.ts` now proves the OHLC cascade uses Tradier first and falls back
  to Marketstack before Yahoo/Stooq.

## API keys — status for the user
- **No new keys needed** for Tradier/Marketstack (already provided) — now actually used. Tradier
  is a **production** token with market-data access (verified live: real AAPL daily bars).
- **Pinecone/Voyage RAG is fully built** (`vector-db.ts`; `sec8k.ts` embeds 8-K filings via
  `storeContext`, `strategy.ts` retrieves via `retrieveContext`) but **dormant**: it needs a
  **`VOYAGE_API_KEY`** (the Pinecone key is set; Voyage is the embedding model, missing). Get one
  free at voyageai.com → add `VOYAGE_API_KEY=...` to activate financial-news/filing RAG.
- **Massive (massive.com)** flat-files (S3: `MASSIVE_*`) are **not wired** anywhere in code — a
  potential bulk historical-data source; would need a new connector + schema work (future).

## Verification
- Initial pass: `npx tsc --noEmit` clean · `npm test` → **188 tests** pass (26 files) · `npm run build` compiles.
- Continuation targeted check: `npx vitest run test/history.test.ts` passed (7 tests).
- Continuation full check: `npx tsc --noEmit` passed; `npm test` passed
  (**190 tests**, 26 files); `npm run build` passed (11 app pages generated).
- Live FRED via new key: macro returns real values (CPI 4.17% YoY via `pc1`, not the index bug).
- `GET /api/dashboard` returns a full live `macroBoard` (regime, derived metrics, signals).
- Browser (1500×950): Macro tab renders all 5 sections with live data (Fed 3.63%, 10Y 4.43%,
  3m10y +0.64, Core PCE 3.29%, Real Fed funds −0.54, VIX 18.44, …).
- Tradier/Marketstack/Cboe/CFTC/Fama-French all validated against live endpoints.

## Follow-ups (open)
- Add `VOYAGE_API_KEY` to light up the already-built Pinecone RAG.
- Massive flat-file connector (bulk historical) — not built.
- Macro panel is read-only display; could add sparklines/history later.
