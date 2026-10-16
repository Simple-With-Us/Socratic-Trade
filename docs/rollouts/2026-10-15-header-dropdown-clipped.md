# 2026-10-15 - Header dropdowns clipped by the header scroll container (ST-4544)

## Context & Objective

Owner report (Safari): clicking the account dropdown in the console header did not open any dropdown window.  The per-user Data Source Proxy feature the owner pasted alongside already exists (`app/console/settings/proxy.tsx`, `src/lib/proxy-fetch.ts`, `src/lib/data-source-fetch.ts`) and is not involved.  Linear ST-4544.

Root cause: the ChromeBar row in `app/console/components/shell.tsx` is `overflow-x: auto` (a 320px-width guard).  Per CSS, a non-visible overflow on one axis computes the other to `auto`, so the row clips its absolutely positioned dropdown panels to the bar's ~46px height.  Menu state opened; the panel was painted under the clip and hit-testing at its center landed on the click-away backdrop.  Reproduced with a WebKit + Chromium harness mirroring the header markup (state `open`, panel rect extending below the bar, center hit = backdrop, only a sliver visible).  All three header menus anchored inside that row were affected — not Safari-specific; Safari is the owner's browser.

## Changes Made

- `app/console/ui/use-anchored-menu.ts` — new shared hook: measures the trigger rect and returns `position: fixed` panel coordinates clamped to the viewport (recomputed on resize/scroll while open), plus `anchoredMenuContainer()` resolving the portal target to the trigger's `.console-root` so the `--con-*` theme variables stay in scope (a `<body>` portal renders the panel without surface/text colors — the same trap ToastProvider documents in shell.tsx).
- `app/console/components/chrome.tsx` — `ScopeSelector` (account scope) and `UserMenu` (profile/account menu) panels now render through that portal with fixed anchoring instead of `absolute` inside the bar.
- `app/console/components/notification-inbox.tsx` — Notifications panel, same treatment.
- `test/e2e/header-menus.spec.ts` — regression tests in the existing Playwright harness: each menu's panel must be visible AND hit-testable at its center (a clipped panel passes `toBeVisible` on its layout box, so visibility alone is not asserted).
- `STATUS.md` — session entry.

The `overflow-x: auto` 320px guard itself is unchanged; the panels escape it instead.

## Decisions & Trade-offs

Portal-to-`.console-root` + fixed positioning was chosen over removing the overflow guard (which would reintroduce horizontal page overflow at ~320px) and over portaling to `<body>` (loses the scoped theme variables, verified visually).  Panel widths, gaps (4px scope / 2px menus), backdrop, Escape, and focus-return behavior are unchanged.  The native `<select>`s in the proxy settings card are unrelated to this bug and untouched.

Separately verified, not part of this change: the owner's pasted 502 (2026-10-15 23:29:43 UTC, Ray a4b29b837f9e3822) was the deploy-restart window of sha `fad904bcd` (live `/api/health` reports `processStartedAt` 23:29:54 UTC on that sha); production was healthy on live URLs when checked (`ok: true`, db ok, scheduler fresh, all static chunks 200).

## Verification State

```bash
npx tsc --noEmit
npm test
npm run lint
npx playwright test test/e2e/header-menus.spec.ts --project=chromium
```

`tsc` clean.  Playwright: 3/3 header-menu tests pass on the built app.  WebKit (Safari engine) probe against the same build: all three panels `position: fixed`, inside `.console-root`, center-hittable, and the account panel visually opaque and correctly anchored in a screenshot.  Full vitest and lint results recorded in the STATUS.md entry at landing time.

## Next Steps & Blockers

Merge via `scripts/land.sh`, confirm the auto-deploy on live health URLs, then close ST-4544.  Fixes ST-4544.
