# 2026-08-05 — Mobile tab bar: close 80% of Safari chrome gap + continuous surface

## Context & Objective

On mobile Safari the console bottom tab bar sat above a visible empty band, then
Safari's floating URL chrome. The band (and the page peeks around the URL pill)
were the colder page `--con-bg` grey, so the bottom of the screen read as an
abrupt grey strip rather than continuous tab-bar surface. Owner ask: measure the
gap, shift the tabs down by **80%** of that distance, and make the background
style continuous all the way around the URL chrome.

## Changes Made

- **`MobileTabBar`** measures the browser chrome gap (`env(safe-area-inset-bottom)`
  probe + `visualViewport` inset; 20px floor on coarse touch when both read 0;
  **0 in standalone/PWA** so home-indicator padding is unchanged).
- Applies `bottom: -0.8 * gap` so the bar moves into 80% of the former empty band.
- Sets `--con-tabbar-underlay` to the remaining 20% plus extra solid surface to
  paint under Safari's translucent bottom chrome.
- TabsSheet offset now measures **bar top → layout bottom** (not raw height) so
  it still stops flush above the shifted bar.
- **`.con-tabbar` CSS**: near-opaque surface + blur (background moved out of
  Tailwind opacity utilities); `::after` solid `--con-surface` underlay; standalone
  still uses `padding-bottom: env(safe-area-inset-bottom)` with underlay height 0.

### Files

- `app/console/components/nav.tsx`
- `app/console/console.css`
- `docs/EFFORT-LOG.md` / `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-08-05-mobile-tabbar-chrome-gap.md` (this note)

## Decisions & Trade-offs

- **80% shift, not 100%:** leaves a hair of breathing room; underlay covers the
  rest so color stays continuous. Overshoot on the floor (20px) tucks under the
  toolbar without hiding the bulk of the tab hit targets.
- **Did not re-add content-box safe-area padding in browser mode** — that was the
  2026-07-18 failure mode (empty band under labels). Shift + underlay paint is the
  inverse: move labels down, paint the remainder, do not invent empty pad inside
  the bar.
- **Standalone unchanged:** measure returns 0; classic safe-area pad remains.
- Device-dependent: gap signals differ across iOS versions; floor + resize listeners
  cover the common case. No trading-path / data changes.

## Verification State

```bash
npx tsc --noEmit          # clean
npm run lint              # 0 errors (grandfathered warnings only)
npm test -- --run test/console-nav-labels.test.ts test/console-tabs-keyboard.test.ts
# 9/9 passed
```

Full gate (`npm test` + `npm run build`) runs via `scripts/land.sh` before PR.

On-device: confirm in mobile Safari that (1) labels sit closer to the URL chrome,
(2) no grey flash around the URL pill, (3) installed PWA still clears the home
indicator.

## Next Steps & Blockers

- Owner on-device check on the reporting iPhone.
- If the remaining 20% still looks large on a specific iOS version, lower the
  floor or raise the shift ratio in `measureBottomChromeGap` / the 0.8 constant.
