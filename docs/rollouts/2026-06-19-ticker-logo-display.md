# Ticker Logo Display Preference

## Summary

- Added a sanitized `/api/logos/ticker` proxy for
  `davidepalazzo/ticker-logos` PNG files, with app-side cache headers and
  GitHub raw fetch revalidation.
- Added a reusable `TickerLogo` component with Tile, Transparent, and Off
  display modes plus text fallback support.
- Added Settings -> Display so the user can choose Normal tile, Transparent, or
  Off locally; the choice is persisted in `localStorage`.
- Applied logos to portfolio symbols, Market Scan symbols, and the Symbol
  Intelligence header.

## Why

The GitHub repo provides transparent PNGs, not a separate "normal" set. The app
can still make the choice useful by rendering the same transparent assets either
on a consistent filled tile or directly on the dashboard surface. The app should
not vendor the full repository because it is large and only a small subset of
symbols is visible at a time.

## Files

- `app/api/logos/ticker/route.ts`
- `app/dashboard-client.tsx`
- `app/ui/symbol-drilldown.tsx`
- `app/ui/ticker-logo.tsx`
- `src/lib/ticker-logos.ts`
- `test/ticker-logos.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-19-ticker-logo-display.md`

## Verification

- `curl -L -I --max-time 15 https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons/AAPL.png` returned `200` with `content-type: image/png`.
- `npx vitest run test/ticker-logos.test.ts` passed: 1 file, 4 tests.
- `npx tsc --noEmit` passed.
- `npm test` passed: 32 files, 248 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `pm2 restart trading-codex` restarted the Codex preview after the build
  regenerated `.next`.
- `curl -sS -o /tmp/trading-codex-health-localhost.json -w 'health-localhost %{http_code} %{content_type} %{size_download}\n' http://localhost:4101/api/health` returned `200 application/json`.
- `curl -sS -o /tmp/trading-codex-aapl-logo-localhost.png -w 'logo-localhost %{http_code} %{content_type} %{size_download}\n' 'http://localhost:4101/api/logos/ticker?symbol=AAPL'` returned `200 image/png 7672`.
- `curl -sS -o /tmp/trading-codex-root-localhost-2.html -w 'root-localhost %{http_code} %{content_type} %{size_download}\n' http://localhost:4101/` returned `200 text/html; charset=utf-8`.
- `curl` against `http://127.0.0.1:4101/` returned HTTP 200 but reported a
  partial-transfer warning from the Next dev stream; `localhost:4101/` returned
  a complete response, and the API checks were healthy.
- Playwright smoke with `waitUntil: "commit"` opened Settings -> Display,
  verified Normal tile rendered 3 logo images, Transparent persisted
  `ticker-logo-display=transparent`, and Off persisted
  `ticker-logo-display=off` with 0 logo images.
- Playwright mobile smoke at 390x844 reported `bodyScrollWidth` equal to
  `viewportWidth` (`390`), with no obvious horizontal overflow.

## Follow-ups

- If logo coverage becomes product-critical, add a maintained local manifest so
  missing symbols can be known without first trying the PNG request.
- Re-check repository license/attribution before using these logos in a
  public/commercial deployment.
