# 2026-06-17 - ui-improvements

## Summary

A batch of user-requested UI/UX improvements on branch `web-sources`, landed
alongside (and cleanly merged with) a concurrent Codex "2026-06-17 optimizations"
pass (Kelly-lite sizing, deterministic regime, token minification, virtualization,
Sonner toasts). Paper mode unchanged.

This note covers the UI-improvements half:

- **Market Scan, data-driven columns.** `MarketScanView` is now a config-driven
  table (`ScanColumn[]`): every column has a rich header tooltip that expands the
  acronym, names the data source, and states the calculation methodology (e.g. P/E,
  FCF%, D/E, EPS gr, Congress, Score). A **gear popover** shows/hides columns
  (persisted in `localStorage`), including previously-hidden **Bid** and **Ask**.
  The **Rating** column is now a colored chip like Sentiment (`RatingChip`).
  Cells still render `—` (never fabricated) when data is absent. (Codex then wired
  these columns through `react-virtuoso` `TableVirtuoso` for smooth scrolling.)
- **Empty columns fixed via a live scan.** The table was showing the *captured*
  scan from the last strategy run (stale, pre-enrichment-fix), so FCF%/D/E/EPS gr/
  Congress were blank. Added a read-only `GET /api/scan` (cached by `scanMarket`'s
  TTLs) that the tab fetches on mount + a refresh button; falls back to the captured
  scan. A fresh scan populates fundamentals (Yahoo) and the congressional/insider
  overlay. Verified: a fresh scan returns FCF for 8/10 large caps and a real
  Congress signal where members traded the symbol.
- **Header / status area.** Title → "Agentic Trading". Two stacked status lines,
  each with its own dot: **Autonomy On/Off/Halted** (green/grey/red) and **Market
  Open/Closed/Pre-market/After-hours** (green/grey/amber), `whitespace-nowrap` so
  they never wrap. Added an obvious **Autonomy on/off Switch** in the command bar
  (clears the kill switch when enabling).
- **Command palette.** Clicking the dimmed backdrop now closes it (previously only
  Escape). The ⌘K button + binding are **platform-aware**: ⌘K on macOS, Ctrl+K on
  Windows/Linux.
- **Copy / affordances.** "Latest decision" → "Latest decisions"; "Equity curve" →
  "Equity"; "Risk & limits" → "Risk & Limits"; the run summary now appends
  "Proposed N Paper Trades" (paper) / "Proposed N Trades" (live); pending-proposal
  rationale shows full text on hover when truncated.
- **Settings + tunables.** New **Tuning** settings tab exposes previously-hardcoded
  constants: `shrinkPrior` (Bayesian shrinkage) and `minClosedLotsForWeightShift`
  (auto-tuner gate), wired through `policy.tuning` → `performance.ts` (reads
  `shrinkPrior`) and `strategy-tuning.ts` (reads the gate). A **Tax** setting,
  "Subtract estimated tax from results", nets realized P&L of the estimated tax
  burden on the Performance tab. The Strategy tab's **Key parameters** are now
  editable inline (`EditableParam` → `updatePolicy`), mirroring Settings → Risk &
  Limits.

## Why

User feedback: missing/uninformative column tooltips, no column source/methodology,
no way to show/hide columns, empty data columns, awkward header status, palette
not closing on backdrop click, non-platform-aware shortcut, truncated rationale,
several copy nits, and a desire to expose arbitrary hard-coded constants as
settings and edit key parameters where they're shown.

## Files

- `app/dashboard-client.tsx` (data-driven scan table, header status + autonomy
  toggle, platform shortcut, editable Key Parameters, tax-after-tax Performance,
  Tuning settings tab, copy fixes), `app/ui/command-palette.tsx` (backdrop close),
  `app/api/scan/route.ts` (new live scan endpoint), `src/lib/types.ts`
  (`TaxSettings.subtractFromResults`, `TuningSettings`), `app/api/policy/route.ts`
  (merge + validate `tuning`), `src/lib/performance.ts` (`resolveShrinkPrior`),
  `src/lib/strategy-tuning.ts` (configurable gate), `src/lib/strategy.ts` (run
  summary phrase).

## Verification

```bash
npx tsc --noEmit   # clean (combined tree incl. Codex optimizations)
npm test           # 118 passed (16 files)
npm run build      # succeeds
```

Browser-verified earlier in the session: Congress column renders; header/status
correct; live-scan endpoint returns enriched data. The combined tree (this batch +
Codex's Kelly-sizing/regime/minification/virtualization/toasts) all passes the gate.

## Follow-ups

- The adversarial review workflow for this batch hit the Anthropic session limit
  before returning findings; a self-review pass should be re-run.
- Deeper exposure of scoring sub-score thresholds as settings (currently env/code
  level) remains a follow-up.
