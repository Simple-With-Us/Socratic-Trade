# 2026-06-25 — Surface avgDaysHeld / shortTermPct in the scorecard tooltips

Branch: `claude/scorecard-turnover-ui` (off `origin/main`). Clean/additive backlog batch.
**Display-only** — no trading-logic change; the data was already computed and already in the
dashboard snapshot feed, just never shown.

## Summary

`getThesisScorecard` / `getRegimeScorecard` already return optional `avgDaysHeld` and
`shortTermPct` (turnover / tax-lot diagnostics), and `src/lib/dashboard.ts` already ships the
full `ThesisStat[]`/`RegimeStat[]` in the snapshot. The dashboard client dropped both fields when
mapping into `ScorecardBars`, so they never reached the UI. Now the scorecard bar tooltip appends
`"<N>d avg hold - <M>% short-term"` when those fields are present (omitted otherwise, so sources
that don't compute them add no noise). Neither field feeds sizing or any decision — pure
read-only turnover/tax-lot visibility.

## Files

- `app/ui/charts.tsx` — `ScorecardBars` data type widened with optional `avgDaysHeld`/`shortTermPct`;
  tooltip appends the turnover context when present.
- `app/dashboard-client.tsx` — the thesis/regime scorecard mappers now carry the two fields through.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 1111/1112; only the pre-existing cache-provenance date flake
npm run build      # compiles green
```

Display-only tooltip text — covered by tsc + build; the repo verifies UI visually via Playwright,
not unit tests, so no test was added for the rendered string.

## Follow-ups

Remaining clean/additive backlog (separate branches): persist MAE/MFE per closed lot; ATR-stops
opt-in mode; prompt-cache the strategy system prefix; SEC XBRL company-facts connector.
