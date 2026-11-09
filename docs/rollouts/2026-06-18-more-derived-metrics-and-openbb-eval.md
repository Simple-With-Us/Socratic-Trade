# 2026-06-18 — "Calculable now" metrics + OpenBB evaluation

## Part A — New derived metrics (implemented)

### Per-company (src/lib/derived-metrics.ts → LLM, table, drilldown, evidence)
- `grahamNumber` — Benjamin Graham intrinsic value = √(22.5 × EPS × BVPS), BVPS = price ÷ P/B. Profitable names only.
- `marginOfSafety` — (Graham − price) ÷ price %. Positive = below intrinsic value.
- `pctFromHigh` — (price − 52w high) ÷ high %. 0 = at the high, negative = pullback depth.
- `rr52w` — reward:risk to the 52-week band = (high − price) ÷ (price − low). >1 = more upside room than downside.
All four ride the existing `deriveMetrics` bundle, so they auto-propagate to the LLM
payload, the `signal_snapshot` evidence digest, and the UI.

### Macro (src/lib/macro.ts + macro-metrics.ts → LLM)
- Added FRED series **`DGS2`** (2Y treasury) → new `MacroData.dgs2Treasury`.
- Added **M2 YoY growth** via `M2SL` with `units=pc1` → new `MacroData.m2GrowthYoY`.
- New derived `curve2s10s` = 10Y − 2Y (the canonical recession curve), alongside the
  existing `yieldCurveSpread` (10Y − Fed funds).

### UI
- Symbol Drilldown: 4 new tiles (Graham value, Margin of safety, % from 52w high, Reward:risk).
- Market Scan: 3 new default-hidden, sortable columns (MoS, % off Hi, R:R). PEG/ROE stay default-visible.

### Files
- `src/lib/derived-metrics.ts` — 4 new metrics + signature now takes 52w high/low.
- `src/lib/macro.ts` — `dgs2Treasury`, `m2GrowthYoY` fields/defaults/fetch (DGS2 + M2SL pc1).
- `src/lib/macro-metrics.ts` — `curve2s10s`.
- `src/lib/strategy.ts` — prompt descriptions for the new per-name + macro fields.
- `app/ui/symbol-drilldown.tsx`, `app/dashboard-client.tsx` — tiles + columns.
- `test/derived-metrics.test.ts` (+2), `test/macro-metrics.test.ts` (2s10s), `test/macro.test.ts`
  (base fixture updated for new required fields).

### Verification
- `npx tsc --noEmit` clean · `npm test` → **160 tests** pass · `npm run build` compiles, 11/11 pages.
- Browser: INTC drilldown shows "% from 52w high −8.8%", "Reward:risk 0.11"; Graham/Margin
  correctly "—" (negative earnings). Sector RS +1.36%.
- Note: a subtle gotcha — BVPS is derived as `price ÷ P/B`, so a Graham/margin test must
  vary price AND P/B consistently (a test that held P/B fixed while changing price was wrong).

## Part B — OpenBB evaluation (research, no code)

Researched OpenBB (openbb.co) against this app. Full provider table + citations live in
the chat thread / summary below; key conclusions:

### Are we accessing the sources that feed OpenBB?
OpenBB Platform ships **~32 bring-your-own-key provider connectors**; it hosts no data.
**Overlap we already have:** Yahoo Finance, FMP, Alpha Vantage, FRED, SEC, FINRA.
**They have, we don't (free/free-key, easy adds):** Federal Reserve/ECB/IMF/OECD/BLS (macro),
Cboe (options/VIX direct), Finviz/WSJ/Stockgrid (screening/short-vol), CFTC (COT),
Fama-French (factors), Tiingo/Nasdaq Data Link, Treasury/Government.
**Notable difference:** we use **Finnhub**, which is **not** a current OpenBB Platform provider;
OpenBB's **Polygon** is no longer bundled in the open-source repo (separate package only).

### Should we use the OpenBB API?
Optional, not required. OpenBB is AGPL-3.0 (network-copyleft — relevant if we link/serve it),
self-hosted (run `openbb-api`, a FastAPI server on :6900), bring-your-own-keys. It would let us
swap our hand-rolled provider cascade for one normalized interface across 32 sources, and its
`openbb-mcp-server` exposes data as MCP tools our agent could call directly. Tradeoffs: AGPL,
a Python sidecar service, and less control over our token-tuned minified payloads. Recommendation:
keep our lean in-house cascade for the hot path; consider OpenBB (or just adding its free
no-key macro/options/COT sources directly) for breadth, and `openbb-mcp-server` as an optional
research tool for the agent.

### How OpenBB compares / differs
OpenBB = research/data/analysis layer that **deliberately stops before execution** (no broker
order routing in the current Platform or Workspace; portfolio features are read-only/post-trade).
**OpenBB Workspace** is an AI-native, enterprise (BYO-data/agent, RBAC/SSO/VPC) research front-end
— it orchestrates external agents via an SSE `/query` + `widgets.json` + MCP contract; it is not
itself an autonomous trader. **This app is the opposite end of the workflow:** an autonomous LLM
agent that scores, decides, and **places trades** (paper/live), with its own learning loop. The
relationship is complementary, not competitive — OpenBB-style connectors/MCP could feed our
analysis; execution + autonomy is our layer.

## Follow-ups (open)
- Easy data breadth wins (no new paid keys): add FRED via OpenBB-style direct calls for
  Treasury yield-curve, GDP, PCE; Cboe for direct options/VIX; CFTC COT; Fama-French factors.
- Still no dedicated macro/internals UI panel (backend→LLM only).
- Tuner still doesn't read derived/sectorRelStrength evidence back as a learning signal.
