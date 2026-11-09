# 2026-06-21 — Logos everywhere; source picker removed

## Summary

Removed the logo source toggle (Option 1 / Option 2) and wired `TickerLogo` to every
ticker symbol shown in the dashboard — proposals, congressional trades, insider trades,
tax-view lists, and wash-sale tables — in addition to the portfolio and market scan rows
that already had logos.

## Why

The two logo sources (GitHub / logo.dev) always produced the same result for the tile
display mode, so the toggle was meaningless. User feedback: "if they are always the same
then just use github for that one and don't have an option." Separately, user requested
logos wherever tickers appear: "logos should always be there if a ticker is seen in a
heading, title, or chart."

## Decisions

- **Always GitHub first → logo.dev fallback** — the API route cascade order is now fixed
  (no `?source=` param); logo.dev remains as fallback when the GitHub repo has no PNG.
- **No version-buster param** — removing `?source=` changes the cache key anyway, so
  the old `&v=2` is no longer needed and was dropped.
- **Chip variant skipped** — `SymbolButton variant="chip"` (wash-sale lockout chips) was
  not given logos because icons are too cramped inside pill badges.

## Files touched

- `app/ui/ticker-logo.tsx` — removed `LogoSource`, `setLogoSourcePref`, `getLogoSourcePref`,
  `useLogoSource`; removed `source` state and `effectiveSource` from `TickerLogo`; simplified
  img URL to `?symbol=...&theme=...` (no `&source=`, no `&v=2`)
- `app/api/logos/ticker/route.ts` — removed `source` param extraction; always runs
  `tryGitHub() ?? tryLogoDev()`
- `app/dashboard-client.tsx`:
  - Removed `useLogoSource`, `setLogoSourcePref`, `LogoSource` imports
  - Removed `LogoSourceSegmented` component
  - Removed "Source" sub-row from Settings → Display
  - Updated display field hint text
  - Added `tickerLogoDisplay` prop to `DecisionView`, `SmartMoneyView`, `TaxView`
  - Wired `logoDisplay={tickerLogoDisplay} showLogo` to SymbolButton calls at:
    pending proposals, latest decisions (DecisionView)
    congressional trades, insider trades (SmartMoneyView)
    wash sales list, harvest candidates, open lots (TaxView)
  - Passed `tickerLogoDisplay` to all three call sites

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 456 tests, 58 files — all pass
curl -sD - "http://localhost:4100/api/logos/ticker?symbol=AAPL&theme=dark" -o /dev/null | grep x-logo-source
# → x-logo-source: github:davidepalazzo/ticker-logos
```

Manual: Settings → Display shows only Tile / Transparent / Off (no source picker).
Preview box shows logos. Market tab → congressional and insider rows show logos.
Decision tab → proposal rows show logos.

## Follow-ups

- `views.tsx` (`app/ui/dashboard/views.tsx`) is dead code — nothing imports it. Can be
  deleted in a cleanup pass.
