# 2026-07-13 — Mobile intro-animation size jerk + effort-log follow-up

## Summary

Fixed a visible size "pop" in the first-load candlestick intro on mobile: the
candles reassembled into the "SOCRATIC TRADE" wordmark at a narrow size, then
suddenly jerked to a larger size just before the mobile brand row slid away.

Also marked the now-merged PR #1417 (global learning reads + batched advisory
review) as Completed/Deployed in `docs/EFFORT-LOG.md` — a bookkeeping follow-up
requested by the owner, since the branch was merged and shouldn't take new commits.

## Why / root cause

`intro-canvas.tsx` lands the flying candles on the REAL top-bar logo by measuring
`[data-brand-logo]` and easing toward that box. It measured the box **once** and
froze it (`if (!headerBox) measureHeader()`), only re-measuring on window resize.

On mobile the landing target is `MobileBrandRow`'s `HeaderLogo`, which mounts at a
placeholder height (`useState(24)`) and then, in its measure effect, resizes to a
width-scaled clamp — `clamp(16..34, round(vw*0.88 / WORDMARK_AR))` — up to ~40%
taller on wider phones/tablets. The intro captured the stale 24px box, assembled
the wordmark narrow, and at handoff the real (larger) logo appeared at its final
size → the perceived "narrow then jerk larger."

(The real logo itself never visibly resizes: the mobile row stays `opacity:0`
until the `landed` phase, by which point its height is already final. The only
visible artifact was the intro's frozen-stale landing.)

## Fix

Re-measure the real logo **every frame** in the intro loop instead of freezing the
first measurement, so the eased landing (`introCurHeader`, exp smoothing) tracks
the logo's FINAL geometry and converges to it well before handoff. `measureHeader()`
keeps the previous box when no visible logo is found, so this stays safe before the
top bar mounts, and the module-scoped `introCurHeader` still preserves landing
continuity across the loading→loaded remount.

## Files

- `app/console/components/intro-canvas.tsx` — re-measure the header box each frame
  (was: measure once and freeze); comment explains the mobile-row resize race.
- `docs/EFFORT-LOG.md` — moved the global-learning/batched-review effort to
  Completed (PR #1417 merged); added this fix as In Progress.
- `STATUS.md` — snapshot refreshed.

## Verification

```
npx tsc --noEmit   # clean (exit 0)
npm run lint       # 0 errors (grandfathered warnings only)
npm test           # 3927 tests pass (350 files)
npm run build      # exit 0
```

`npm ci` was required first: the branch was restarted from the latest `main`, which
pinned a newer `@jaywedgeworth22/congress-trading-shared` commit (`c4fcfb44`) that
exports `buildOperationInFlightRejection` / `buildRateLimitedRejection` /
`getOperationGuardHttpStatus`; the stale `1.4.1` in `node_modules` broke the build
until reinstalled.

Visual note: this is a canvas animation with no unit-test surface. Recommended
manual check — on a phone/narrow viewport, clear the tab session
(`sessionStorage.removeItem("st.introShown")`) and reload: the assembled wordmark
should hand off to the header logo at a single, stable size with no growth pop
before the mobile row slides away.

## Follow-ups

- None required. Optional defense-in-depth (not done, to avoid a hydration-mismatch
  risk for zero visible benefit): give `MobileBrandRow`'s initial `logoH` its final
  clamped value so the row logo never resizes post-mount.
