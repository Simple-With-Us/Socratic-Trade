# 2026-08-18 — Mobile tab bar: shrink Safari chrome gap + match tab-strip white

## Context & Objective

On iPhone Safari the console bottom tab bar sat above a grey-blue band (`--con-bg`
`#f1f4f6`), then Safari's floating URL chrome, and the same grey-blue showed
around the URL pill.  Owner ask: remove about 75-80% of that band and paint the
remaining background the same white as the tab labels (`--con-surface`).

## Changes Made

The 2026-08-05 fix *shifted* the whole bar down by 80% of a measured chrome gap.  That hid the label row under Safari's URL chrome and was reverted on 2026-08-08.  This pass does **not** move `bottom`.  It only shrinks the redundant browser safe-area pad and paints a solid tab-surface underlay below the bar.

- Browser (not installed): `.con-tabbar` `padding-bottom` is
  `calc(env(safe-area-inset-bottom, 0px) * 0.22)` — about 78% of the previous
  inset, leaving a hair of breathing room.
- Bar background is solid `var(--con-surface)` (no 94% mix, no backdrop-blur)
  so the remaining pad matches the label row instead of leaking page grey.
- `::after` underlay sits *below* the bar (`top: 100%`) and paints
  `--con-surface` under / around the translucent URL chrome.  No min-height
  floor (the 2026-08-05 ≥48px underlay read as a dead band).
- Standalone / fullscreen: full `env(safe-area-inset-bottom)` pad; underlay
  disabled.  Home-indicator clearance is unchanged.
- Labels stay at `bottom: 0`.  Negative-`bottom` gap shift stays forbidden.

### Files

- `app/console/console.css` — browser 22% pad, solid surface, chrome underlay
- `app/console/components/nav.tsx` — comment only (still `bottom-0`)
- `docs/phase-8-cockpit-ui.md` — current mobile tab-bar geometry
- `STATUS.md`, `docs/EFFORT-LOG.md`, `PLAN.md`
- `docs/rollouts/2026-08-18-mobile-tabbar-chrome-gap.md` (this note)

## Decisions & Trade-offs

- **22% pad, not 0:** owner asked to remove 75-80% of the space, not all of it.
- **No JS `visualViewport` measure / negative bottom:** that class of change hid
  labels on-device.  CSS-only, labels stay put.
- **Solid surface over blur:** the 94% + blur mix is what let `#f1f4f6` show
  through the pad and around the URL pill.
- **theme-color left on `--con-bg`:** that token tints the *status* bar to match
  the sticky top chrome.  Changing it to white would mismatch the top of the
  page.  The bottom halo is painted by the tab bar + `::after`.
- No trading-path / data changes.  PWA `/mobile` untouched.

## Verification State

```bash
npm run lint            # 0 errors (grandfathered warnings only)
npx tsc --noEmit        # clean (after comment-terminator fix)
npx vitest run test/console-nav-labels.test.ts test/console-tabs-keyboard.test.ts
# 2 files, 9 tests — all passed
npm run build           # Next.js 16.3.1 webpack build succeeded
```

Full `npm test` was started and then stopped: this cloud VM has no provider keys, so
unrelated files fail/hang on live HTTP (TwelveData quota, SEC company_tickers 404,
Alpaca snapshot 404, strategy-held-position 30s timeouts).  No product JS/TS
logic changed — CSS + comments + docs only.  CI `verify` on the PR is the
authoritative full suite.

## Next Steps & Blockers

- Owner on-device check in mobile Safari: (1) tab labels still visible above the
  URL chrome, (2) the grey-blue band is ~75-80% shorter, (3) the remaining strip
  and the area around the URL pill match the tab-strip white.  Installed PWA
  (if anyone still uses it) should still clear the home indicator.
- If a specific iOS version still shows a large band with `env()` ≈ 0, do **not**
  resurrect the 2026-08-05 shift.  Raise the browser pad only with a small fixed
  px value, or extend the `::after` height.

## Zero-Code Findings

None — this is a CSS/comment change against a known Safari geometry.
