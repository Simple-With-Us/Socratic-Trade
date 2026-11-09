# 2026-06-23 - Custom watchlist tickers and visible error surfaces

## Summary

Additional Watchlist now accepts quote-resolvable custom U.S. equity/ETF
tickers such as `SPCX` instead of restricting entries to the embedded S&P 500,
Nasdaq 100, and Dow 30 snapshots. The app also shows more concrete failure
messages for policy saves, scan warnings, page render failures, and uncaught
browser runtime errors.

## Why

`SPCX` was blocked because `isValidAppSymbol()` only accepted symbols present in
the embedded index snapshots. That made real non-index tickers fail in Settings
before the app ever tried to fetch market data. The fix keeps malformed ticker
text out, quote-checks newly added custom Additional Watchlist symbols, and
explains failures when a ticker cannot be priced.

## Files

- `app/api/policy/route.ts`
- `app/dashboard-client.tsx`
- `app/error.tsx`
- `app/global-error.tsx`
- `app/layout.tsx`
- `app/ui/global-error-toasts.tsx`
- `src/lib/index-universes.ts`
- `src/lib/market.ts`
- `src/lib/policy-symbol-validation.ts`
- `src/lib/robinhood.ts`
- `src/lib/yahoo-finance.ts`
- `test/market-custom-symbol.test.ts`
- `test/policy-custom-symbol.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-5-dashboard-refactor.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-23-custom-watchlist-errors.md`

## Verification

- `npx vitest run test/policy-custom-symbol.test.ts test/market-custom-symbol.test.ts test/alternative-data.test.ts test/watchlist-alerts.test.ts` - 16 tests passed.
- `npx tsc --noEmit` - clean.
- `npm test` - 102 files / 915 tests passed in `/Users/jay/apps/trading-codex` after layering with the in-progress account-deletion work.
- `npm run build` - passed in `/Users/jay/apps/trading-codex`.
- `pm2 restart trading-codex` - restarted the Codex preview on port 4101.
- `curl http://127.0.0.1:4101/api/health` - 200 OK with `{"ok":true,...}`.
- `curl -I https://codex.jays.services` - 302 to Cloudflare Access login, expected for the protected public preview.

## Follow-ups

- If a custom symbol is syntactically valid but Yahoo cannot price it at add
  time, the policy save now fails with a ticker-specific explanation. If a
  previously saved custom symbol later becomes unavailable, Market Scan shows a
  concrete warning and keeps the rest of the scan usable.
