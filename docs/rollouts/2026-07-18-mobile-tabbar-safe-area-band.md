# 2026-07-18 — Mobile bottom tab bar: remove redundant safe-area band

## Summary
On mobile, the console's fixed bottom tab bar (`Thesis / Proposals / Journal /
Orders / More`) showed an empty band of vertical space between the tab labels
and the browser's address bar. Removed it by reserving the bottom safe-area
inset only in installed/standalone (PWA) mode instead of unconditionally.

## Why
The tab-bar `<nav>` in `app/console/components/nav.tsx` applied
`style={{ paddingBottom: "env(safe-area-inset-bottom)" }}` in all display modes.

In a normal mobile browser tab, the browser already holds a
`position: fixed; bottom: 0` element above its own toolbar/address bar, so this
padding stacks a **second, redundant** bottom clearance. Because the tab bar's
background color equals the page background, that reserved band reads as empty
wasted page — the space the owner circled in the reported screenshots (the band
sits between the tab labels and Safari's floating address bar, which is the
tell-tale of a doubled clearance rather than a needed one).

The inset is genuinely needed only in **standalone/fullscreen** display mode
(app installed to the home screen), where there is a physical home indicator and
no browser chrome below the bar. So the fix gates the reservation to those
display modes.

## Changes
- `app/console/components/nav.tsx`: removed the inline
  `style={{ paddingBottom: "env(safe-area-inset-bottom)" }}` from the mobile
  `MobileTabBar` `<nav>` and added the `con-tabbar` class to it.
- `app/console/console.css`: added `.con-tabbar { padding-bottom: 0; }` with an
  `@media (display-mode: standalone), (display-mode: fullscreen)` override that
  restores `padding-bottom: env(safe-area-inset-bottom)`. Documented the reason
  inline.

No behavior change in installed/standalone PWA mode (still clears the home
indicator). No logic, data, or trading-path changes — CSS/markup only.

## Files
- `app/console/components/nav.tsx`
- `app/console/console.css`
- `docs/EFFORT-LOG.md` (In Progress row)
- `STATUS.md` (snapshot)
- `docs/rollouts/2026-07-18-mobile-tabbar-safe-area-band.md` (this note)

## Verification
Ran the full gate after `npm install` in the cloud worktree:
- `npx tsc --noEmit` — clean (exit 0).
- `npm run lint` — 0 errors (500 grandfathered warnings, unchanged).
- `npx vitest run` — 405 files, 4758 tests passed.
- `npm run build` — production Next.js build succeeded.

Device note: `env(safe-area-inset-bottom)` and `display-mode` are iOS/Safari
runtime concerns that can't be exercised in the headless Linux gate; the change
is the documented standard pattern for this symptom and is safe-by-construction
(browser mode: removes an unneeded band or is a no-op; standalone: unchanged).

## Follow-ups
- Confirm on-device in mobile Safari that the band is gone and the tab bar sits
  snug above the address bar. If a hair of breathing room is preferred in browser
  mode, bump `.con-tabbar` `padding-bottom` from `0` to a small fixed value
  (e.g. `2px`) — the standalone override is independent and stays as-is.
