# 2026-07-24 Ticker Logo Display Settings & User Avatar Layout Constraints

## Context & Objective
The user requested an interactive setting for Ticker Logo display preferences ("transparent", "tile", "off") and reported a UI layout bug where a large user profile avatar expanded and blew out the top chrome layout.

## Changes Made
- `app/console/components/chrome.tsx`:
  - Constrained `<Avatar>` img tag with `max-w-full max-h-full aspect-square shrink-0 block` so high-res profile photos (e.g. 512x512 Google/GitHub avatars) stay strictly contained within their parent containers.
  - Constrained `<UserMenu>` trigger button with `shrink-0 max-h-11 max-w-11 sm:max-h-8 sm:max-w-8` to prevent layout pops across viewports.
- `app/console/lib/useTickerLogoDisplay.ts`:
  - Created persistent client hook for `tickerLogoDisplay` ("transparent" | "tile" | "off") stored in `localStorage` under `console:tickerLogoDisplay`.
- `app/console/ui/ticker-logo.tsx`:
  - Updated `TickerLogo` component to read the stored `tickerLogoDisplay` preference when `display` prop is omitted.
- `app/console/settings/page.tsx`:
  - Added **Ticker Logo Display** preference picker card to **Settings → Appearance** under `THIS BROWSER`.
- `app/api/keys/route.ts`:
  - Added `logodev` to `API_KEY_CATALOG` so users can connect custom `Logo.dev` tokens in **Connections → API keys** if desired.

## Verification State
- `npx tsc --noEmit`: Clean with zero type errors.
- `npx vitest run test/ticker-logos.test.ts`: 4/4 tests passed clean.

## Next Steps
Land via `scripts/land.sh` and auto-deploy to production.
