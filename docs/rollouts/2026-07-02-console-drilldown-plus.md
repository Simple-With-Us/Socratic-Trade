# 2026-07-02 — Console symbol drilldown: strictly better than the legacy drawer (Claude)

Branch: `claude/console-drilldown-plus` (cut from `origin/main` @ 48fbe14).
Part of the multi-agent /console parity port (Wave 2). This branch owns
`app/console/ui/symbol-drilldown.tsx` only; scan/macro/orders/assistant and the
shared console components/lib files were deliberately untouched (other agents
own them concurrently). `SymbolButton` and `SymbolDrilldownSheet` keep their
exact prop signatures so in-flight consumers keep compiling.

## Summary

The console company drawer (opened from any `<SymbolButton>`) now supersets
the legacy `app/ui/symbol-drilldown.tsx` drawer the owner singled out:

**Ported from legacy (full parity):**
- All eleven derived-metric tiles — PEG, earnings yield, ROE, payout ratio,
  daily $ volume, bid-ask spread (bps), Graham value, margin of safety,
  % from 52w high, reward:risk (52w), sector relative strength — same math
  (imports `deriveMetrics` from `src/lib/derived-metrics.ts`, the module that
  also feeds the LLM), each with a what-it-is + how-to-read-this-value tooltip
  that now includes a dynamic reading of the current number.
- Seven-factor breakdown (Value/Momentum/Quality/Positioning/Sentiment/
  Liquidity/Volatility) as 0–100 bars + composite score, with tooltips that
  describe the ACTUAL scoring inputs from `src/lib/market.ts`.
- Signal summary pros/cons with the identical legacy thresholds
  (`buildSignalSummary` is a faithful port of the legacy `generateSummary`).
- Evidence bulletins + recent headlines (collapsible).
- Per-field source provenance (via `orderedSourceEntries`/`friendlySource`/
  `provenanceLabel` from `src/lib/dashboard-ui.ts`, read-only import).

**New over legacy:**
- **Your exposure**: position qty/market value/entry basis/unrealized P&L
  (same math as `enrichPositionsForDisplay`; shorts flagged, return % honestly
  withheld when cost basis isn't positive), PENDING proposals for the symbol
  (side/qty/thesis/confidence/age, rationale on hover, "Review →" link to
  /console/approvals), and the last 4 orders in the symbol (side/qty@avg/state/
  age). Renders honest one-liner when the account has nothing in the symbol.
- **Analysts section**: rating label + blended score, a stacked rating-
  distribution bar (strongBuy→strongSell from the first source with counts),
  and a price-target range bar (low→high track, mean + current-price markers,
  signed % to consensus).
- **Signal chips**: news tone, insider sentiment, congressional net, and a
  days-to-earnings chip (warn tone ≤7 trading days; also surfaces next to the
  price when near) — each with plain-language tooltip + per-field provenance
  ("Source: Yahoo Finance… Received …").
- **Deep fundamentals** (collapsible): EPS, EPS growth, P/B, dividend yield,
  FCF yield, debt/equity (display-normalized like the legacy scan table incl.
  the sec-xbrl ratio exemption), beta, short % float, institutional ownership,
  near-the-money IV, put/call, VWAP, bid/ask, market cap, share volume,
  52w range — every row tooltipped with meaning + provenance, `.con-row` hover.
- **Two-tier quote resolution**: prefers the fully-enriched
  `topCandidates` MarketQuote (factor breakdown/volume/headlines), falls back
  to the `quotesBySymbol` summary tier; when only the summary tier exists,
  daily $ volume falls back to the latest daily history bar's real volume and
  the tooltip says so.
- **Data honesty**: P/E renders `n/a` only when eps ≤ 0 (real computed
  no-ratio state) vs an em dash for missing data (repo convention); nothing is
  ever labeled mock/fallback; a symbol absent from the last scan still opens a
  useful drawer (chart + exposure) with an explicit notice.
- **Optional `quote?: MarketQuote` override prop** on BOTH `SymbolButton` and
  `SymbolDrilldownSheet` (coordination request from the Scan lane / Codex
  finding on #327): a caller rendering a FRESHLY-fetched /api/scan result can
  pass the exact quote object its row shows, and the sheet renders from it
  instead of the snapshot's run-captured scan — so the drilldown can never
  disagree with the row the user clicked. Chooser is `preferFreshQuote`
  (drilldown-data.ts): the override wins unless the run-captured quote's
  `asOf` is verifiably newer; the price tooltip and the footer say which scan
  the data came from ("the scan currently on screen" vs "the last market
  scan"). Fully backward compatible — optional prop, no renames; existing
  consumers (positions, approvals, orders) are unchanged. The scan lane can
  adopt it as a follow-up with `<SymbolButton symbol={q.symbol} quote={q} />`.

## Why

The owner called the legacy symbol drawers one of the old app's strongest
features and asked for a strictly-better version in the console. The console
foundation version (Wave 1) had only chart + 4 stats. This brings full legacy
parity plus account-awareness (exposure/pending/orders) and analyst detail the
legacy drawer never had, in console tokens, light+dark, tooltips everywhere.

## Files

- `app/console/ui/symbol-drilldown.tsx` — rewritten sheet body (exports and
  prop signatures unchanged: `SymbolButton`, `SymbolDrilldownSheet`).
- `app/console/ui/drilldown-data.ts` — NEW pure helpers: `toQuoteView`,
  `peDisplay`, `deriveForView`, `buildDerivedTiles`, `buildSignalSummary`,
  `buildSignalChips`, `FACTOR_DEFS`, `positionEconomics`, `ratingDistribution`,
  `ratingTooltip`, `targetUpsidePct`, `withProvenance`,
  `normalizedDebtToEquity`, `fmtCompact`, `formatDollarsM`.
- `app/console/ui/drilldown-sections.tsx` — NEW section components
  (Exposure/SignalSummary/DerivedTiles/Factor/Analyst/Fundamentals/Evidence/
  Sources).
- `app/console/console.css` — additive classes only: `.con-tile`,
  `.con-score-bar`, `.con-dist-bar`, `.con-range-bar`, `.con-range-fill`,
  `.con-range-marker` (no existing class restyled).
- `test/console-drilldown.test.ts` — NEW 27 tests over the pure helpers
  (quote-view merging, quote-override preference, P/E n/a-vs-dash honesty,
  deriveMetrics parity, volume fallback labeling, legacy signal-threshold
  parity, chips, position econ incl. shorts, analyst helpers, provenance,
  D/E normalization, factor order).
- `STATUS.md`, `PLAN.md`, this note.

## Verification

Run in this order, all green:

```bash
npm run lint       # 0 errors (grandfathered warnings only; 2 warnings in touched files are the pre-existing set-state-in-effect pattern from the foundation useHistory)
npx tsc --noEmit   # clean
npm test           # 235 files / 2268 tests pass (includes the 27 new drilldown tests)
npm run build      # clean; /console routes prerender
```

The full quartet was run twice: once before merging `origin/main` (93aed63,
the settings-expansions PR — clean merge, no overlapping files) and once after
the merge + the `quote` override addition.

Note: one `npm test` run hit `ENOSPC` (the VM's /tmp held ~14 GB of stale
per-run test SQLite files from parallel agents). An attempted cleanup of stale
temp DBs was denied by the sandbox policy; space was released externally and
the suite then passed cleanly. The final run pointed TMPDIR at a
worktree-local dir (reclaimed afterwards) to avoid re-filling the shared /tmp.

## Review fixes (Codex, PR #330 @ 71a04f2 — both verified against the code first)

1. **Factor breakdown no longer hides `diversification`.** Verified:
   `scoreFactors` (src/lib/market.ts) weighs EIGHT factors into
   `weightedTotal`, including `diversification` (80 = account holds no
   position in the name, 45 = it does); the hard-coded seven-factor list
   (inherited from the legacy drawer, which had the same blind spot) made the
   bars unable to reconcile with the composite. Fix: `factorRows(fb)` derives
   the row list from the breakdown object's OWN keys (excluding
   `weightedTotal`), with a label/explainer map for known factors — incl. a
   new Diversification tooltip describing its actual scoring input — and a
   titleized-label + generic-explainer fallback so a future factor can never
   silently vanish. Non-numeric entries are dropped, not rendered as bars.
2. **P/E precedence now lets eps decide first.** Verified: the old order
   displayed any finite provider ratio (even negative/zero) before checking
   eps. New order per the repo convention: eps <= 0 => `n/a` (computed
   no-ratio state) BEFORE accepting any provider-reported ratio (a positive
   ratio alongside eps <= 0 is stale/inconsistent cross-provider data — the
   conservative read wins); only a strictly positive ratio renders as a
   number (the same `peRatio > 0` guard the legacy scan table uses); em dash
   only when the data is missing. Deliberately stricter than the legacy
   scan-table expression in one corner: legacy shows a positive ratio even
   when eps <= 0; the convention text ("check eps to decide") and the
   reviewer both treat eps as authoritative, so the console does too.

Tests: +8 (eps-decides-first, non-positive-ratio guard, factor-rows key
derivation incl. diversification, unknown-key fallback, NaN drop) — 31
drilldown tests total.

## Follow-ups

- Factor breakdown, headlines, intraday change, volume and sector relative
  strength only exist for last-scan TOP CANDIDATES (the summary tier doesn't
  persist them) — a future scan-summary enrichment could carry
  `factorBreakdown` into `MarketQuoteSummary` so every scanned symbol gets the
  bars (needs the src/lib owner; deliberately not touched here).
- Snapshot `orders` are account-scoped current orders, not a full historical
  fills ledger; if a per-symbol fills feed is later exposed on the snapshot,
  swap the "Recent orders" list to it.
- The legacy drawer's TradingView Lightweight-Charts candles were intentionally
  NOT ported; the console keeps its honest self-contained SVG line (design-
  system rule). Candle/volume overlays could be added to the SVG later.
