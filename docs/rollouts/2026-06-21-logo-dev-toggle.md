# 2026-06-21 — Logo.dev cascade + source toggle

## Summary

Added logo.dev as a second logo source behind GitHub's `davidepalazzo/ticker-logos` repo, with a user-facing toggle in Settings → Display so logos from both sources can be compared side-by-side.

## Why

The user provided a logo.dev publishable key and wanted to evaluate whether logo.dev's coverage or visual quality is better than the GitHub source. GitHub's CDN is also slow (5 s timeout before fallback kicks in). logo.dev has a `fallback=monogram` option that always returns something even for obscure tickers.

## Files touched

- `app/ui/ticker-logo.tsx` — added `LogoSource` type, `setLogoSourcePref`, `getLogoSourcePref`, `useLogoSource` hook; `TickerLogo` now reads `source` from `useLogoSource()` and appends `&source=` to the img URL; dark/light theme detection retained via `useDarkMode()` MutationObserver
- `app/api/logos/ticker/route.ts` — reads `?source=auto|github|logodev`; restructured into `tryGitHub()` / `tryLogoDev()` helpers with `AbortSignal.timeout(5000)` on each fetch; `x-logo-source` response header identifies which backend served the image
- `src/lib/ticker-logos.ts` — added `LogoDevOptions` interface, `logoDevTickerUrl()`, `logoDevDomainUrl()`, `logoDevParams()` helpers
- `app/dashboard-client.tsx` — updated import, added `LogoSourceField` component (inlined near `ApiKeysSection`), inserted `<LogoSourceField />` and `BRK.B` preview into the display section
- `.env.local` — added `LOGO_DEV_TOKEN=pk_WI8Yj4GBROeqrqWhsbin3w`
- `.env.example` — documented `LOGO_DEV_TOKEN` with context on domain restriction and the two lookup strategies (by ticker vs by domain)
- `STATUS.md` — updated active focus
- `test/red-team.test.ts` — fixed pre-existing assertion mismatch (added `available: true` to expected object to match `RedTeamDebateResult` type)

## Decisions

- **Publishable key only in env** — the `sk_*` secret key is for the logo.dev management API and never goes in code or `.env.local`.
- **Server-side proxy sets `Referer` header** — logo.dev publishable keys can be domain-restricted; Node.js `fetch` doesn't set `Referer` automatically so the proxy sets `Referer: ${protocol}//${host}/` so domain-restricted keys work from the server.
- **Cascade order** — `auto` = GitHub first (free, no key, 5 s timeout) → logo.dev fallback; `github` = GitHub only; `logodev` = logo.dev first → GitHub fallback.
- **`fallback=monogram`** — logo.dev always returns something (letter badge) so the cascade never produces an empty image when the token is valid.
- **localStorage + custom event** — logo source preference is persisted without prop-threading through 4+ component layers; `window.dispatchEvent(new CustomEvent("ticker-logo-source-change"))` wakes all `TickerLogo` instances.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 418 tests, 54 files — all pass
# Manual: Settings → Display → Logo source toggle (Auto / GitHub / logo.dev)
# Preview box shows AAPL, MSFT, NVDA, BRK.B live
# curl -sD - "http://localhost:3000/api/logos/ticker?symbol=AAPL&theme=dark&source=github" -o /dev/null → x-logo-source: github:davidepalazzo/ticker-logos
# curl -sD - "http://localhost:3000/api/logos/ticker?symbol=AAPL&theme=dark&source=logodev" -o /dev/null → falls back to github at localhost (domain-restricted to claude.jays.services)
```

## Follow-ups

- Add `claude.jays.services` Cloudflare tunnel hostname (Zero Trust → Tunnels → Configure → Public Hostnames → Add → `claude.jays.services` → `http://localhost:4100`). Currently blocked: tunnel is token-managed with no stored API token.
- Optionally expand logo.dev lookup to also try domain-based URL for tickers that don't resolve via the ticker path.
- Dependabot PRs #4, #5, #6 still open.
- Alpaca side mapping bug (`src/lib/alpaca.ts`): `short`→`sell`, `cover`→`buy` mapping missing.
