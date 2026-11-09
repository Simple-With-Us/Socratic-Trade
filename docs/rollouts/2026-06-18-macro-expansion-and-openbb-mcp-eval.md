# 2026-06-18 — Macro data expansion + OpenBB-as-MCP evaluation

## Part A — Macro data expansion (implemented)

Big breadth win with zero new API keys: extended the existing FRED integration with
9 new series and 2 new derived metrics. All flow to the LLM via `macroeconomicData`
(raw, delta-pruned) and `macroDerived` (computed). Stored in the 24h macro cache and
the `last_macro_sent` delta tracker — same path as the existing macro fields.

### New raw FRED series (src/lib/macro.ts → MacroData)
| Field | FRED series | Why |
|-------|-------------|-----|
| dgs3moTreasury | DGS3MO | short end; enables 3m10y curve |
| inflationExpectation10y | T10YIE | market-implied (breakeven) inflation |
| corePCE | PCEPILFE (pc1) | the Fed's preferred inflation gauge |
| realGDPGrowth | A191RL1Q225SBEA | real GDP, % SAAR |
| initialClaims | ICSA | weekly labor-market pulse |
| hyCreditSpread | BAMLH0A0HYM2 | high-yield OAS — risk-appetite gauge |
| usdIndex | DTWEXBGS | broad dollar — multinationals/commodities |
| wtiOil | DCOILWTICO | energy / inflation |
| vix3m | VXVCLS | 3-month VIX (term structure) |

### New derived metrics (src/lib/macro-metrics.ts → macroDerived)
- `curve3m10y` = 10Y − 3M (the Fed's preferred recession curve).
- `vixTermStructure` = VIX ÷ VIX3M (>1 = backwardation / acute near-term fear).

(Existing macroDerived: curve2s10s, yieldCurveSpread, real10Y, realFedFunds, miseryIndex, equityRiskPremium.)

### Files
- `src/lib/macro.ts` — 9 series added to the parallel fetch + MacroData/defaults/construction.
- `src/lib/macro-metrics.ts` — curve3m10y, vixTermStructure.
- `src/lib/strategy.ts` — prompt now describes the new raw macro fields + derived metrics.
- `test/macro.test.ts`, `test/macro-metrics.test.ts` — fixtures updated; +curve3m10y/vixTermStructure assertions.

### Verification
- `npx tsc --noEmit` clean · `npm test` → **160 tests** pass · `npm run build` compiles, 11/11 pages.
- Live FRED validation NOT run — `FRED_API_KEY` is unset locally, so the app uses DEFAULT_MACRO.
  All 9 series IDs are canonical FRED IDs; with a key set, `fetchMacroData` pulls them live
  (a bad ID would silently fall back to its default — re-validate when a key is added).

## Part B — Should we run OpenBB and use it as an MCP in the decision loop?

**Verdict: do NOT put OpenBB MCP in the autonomous buy/sell hot path. DO consider it as an
optional, out-of-hot-path research tool** (Strategy Studio advisory / human "deep dive" /
ad-hoc candidate research).

### Why not in the hot path
The decision loop is deliberately deterministic: backend scans 500 names → scores →
enriches → builds a token-minified payload → bull → bear → decisions, and writes a
`signal_snapshot` evidence digest the learning loop correlates with realized outcomes.
Letting the picking LLM free-form call OpenBB MCP tools mid-decision breaks this:
- **Reproducibility/learning**: evidence would differ run-to-run → can't attribute outcomes.
- **Determinism/caching**: tool loops are non-deterministic, defeat prompt caching, add latency.
- **Token control**: OpenBB tool results are verbose JSON vs our minified `sym/px/...` payload.
- **Infra/license**: OpenBB MCP is a Python sidecar (FastAPI/stdio) bolted onto a Node app, and
  the Platform is AGPL-3.0 (network-copyleft) — material if we ship/host it.
For marginal gain: we already feed rich structured evidence (now ~19 macro fields + 7 macro
derived + ~16 per-name fields + cross-sectional + smart-money).

### Where it IS worth it
- **Advisory / research surface** (Strategy Studio, a clicked-symbol deep dive, human Q&A):
  on-demand depth (full statements, options chains, deeper history) and 32-source breadth with
  no connector-building. Run `openbb-api` / `openbb-mcp-server` as a separate service the agent
  calls only outside the scored decision path.
- **As a data source (not MCP)**: for hot-path breadth, prefer adding OpenBB's *free no-key*
  sources directly to our deterministic cascade (Cboe options/VIX, CFTC COT, Fed/Treasury
  curve, Fama-French) — we keep token/latency control; OpenBB is just the reference for which
  sources exist.

### Recommendation order
1. (Done) Exhaust free FRED breadth — this rollout.
2. Add free no-key connectors directly for hot-path breadth (Cboe, CFTC, Fama-French) — medium effort.
3. Stand up `openbb-mcp-server` as an OPTIONAL research tool for the advisory path only — not the autonomous loop.

## Follow-ups (open)
- Free no-key connectors not yet built: Cboe (options/VIX/put-call/SKEW), CFTC COT, Fama-French factors.
- No macro/internals UI panel yet (all backend→LLM).
- Tuner still doesn't read derived/sectorRelStrength/macro evidence back as a learning signal.
