# Rollout Note — 2026-06-21 — Header Layout, Logo Options, and Symbol Validation

## Summary
Updated the Agentic Trading dashboard to improve header responsiveness, status dots alignment, logo source options, and input validation.

- **Header Layout**: Redesigned the header component to stack as `flex-col` on mobile/tablet viewports and as `lg:flex-row` on desktop screens. This prevents buttons and dropdowns from wrapping awkwardly and overlapping the top safety banner.
- **Zap Logo Alignment**: Modified the Zap icon container class from `items-center` to `items-start mt-0.5` to align the green logo cleanly with the first line of the title text instead of centering it with the entire status block.
- **Autonomy Label**: Changed the autonomy status label from `"Halted"` to `"Inactive"` to match user preferences.
- **Settings Subtitle**: Updated Settings subtitle to `"Risk, Tax, & Notifications"`.
- **Ticker Logo Options**:
  - Renamed segmented logo choices: `"Normal tile"` -> `"Small Tile"`, `"Transparent"` -> `"Medium"`.
  - Added `"BRK.B"` to the preview ticker badges.
  - Implemented `LogoSourceField` to configure logo sources as `"Option 1"` (Auto), `"Option 2"` (GitHub), and `"Option 3"` (logo.dev).
  - Hardened backend `/api/logos/ticker` routing to conditionally fetch from the user-selected source.
- **Symbol Validation**: Enforced strict validation checking all input tickers against the union of S&P 500, Nasdaq 100, and Dow 30 components. Applies to Watchlist, Additional Watchlist (`additionalSymbols`), and Ignore List (`blocklist`) inputs across both backend API handlers and frontend fields.

## Why
- Avoid overlapping layout bugs on intermediate screens.
- Enhance aesthetic alignment of the brand mark and status block.
- Allow users to select and test their desired logo sources (free GitHub repo vs premium logo.dev) with clear Option 1/2/3 labels.
- Prevent invalid mock tickers (like `DSADLAS`) from entering watchlists/blocklists, ensuring the app only tracks reachable assets.

## Files Touched
- `src/lib/index-universes.ts`
- `src/lib/watchlist.ts`
- `app/api/policy/route.ts`
- `app/api/logos/ticker/route.ts`
- `app/dashboard-client.tsx`
- `app/ui/ticker-logo.tsx`
- `test/policy.test.ts`

## Verification
Ran the following verification suite successfully:
1. `npx tsc --noEmit` — Compile clean.
2. `npm test` — 416 unit tests passing.
3. `npm run build` — Optimized Next.js production build succeeded in 2.9 seconds.
