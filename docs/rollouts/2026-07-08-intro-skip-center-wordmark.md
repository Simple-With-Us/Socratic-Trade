# 2026-07-08 — Intro animation: skip the centered-wordmark middle act (MONET)

## Summary

The console first-load candlestick intro no longer assembles the large centered
SOCRATIC / TRADE wordmark before flying into the header. Candles now fly straight
from the chart into the top-left header logo (`[data-brand-logo]`) and start
ticking on arrival. Total intro time drops from ~9.3s to ~6.1s (removes the
~0.75s center hold + ~2.25s second flight + ripple fade).

The middle act is NOT deleted: all of its code (stack sampling, `stackGeom`,
`waveRipple`, the second-flight windows `P4s`/`P4e`/`WX4`/`WY4`, and the
three-act timeline `T3`/`T4`) remains live in `intro-canvas.tsx` behind a single
`CENTER_WORDMARK_STEP: boolean = false` flag at the top of the file. Flip it to
`true` to restore the original three-act sequence exactly.

## Why

Owner: the intro "takes too long the way we have it now and we don't need the
middle step" — but wanted the middle step saved somewhere hidden in case we want
it in the future. A typed-`boolean` compile-time flag keeps the preserved branch
type-checked and lint-clean (no unreachable-code narrowing) while keeping the
default experience direct.

## What changed (mechanics)

- `candleAt` branches on `CENTER_WORDMARK_STEP`: the direct path flies each
  candle chart → header in its existing per-candle window (`BL[j]` → `AR[j]`,
  reusing the leg-1 wander `WX2`/`WY2`), then hands it to `headerTick`.
- `END` (fade start) = `T2B + 0.2` (all candles landed) on the direct path;
  `T4 + 0.2` with the flag on (unchanged from before).
- `headerTick`'s per-second march is anchored at a new `TICK_T0` (`T2B` direct /
  `T4` legacy). The existing `((x % P) + P) % P` modulo handles negative offsets,
  so candles that land before `T2B` tick immediately on arrival.
- Backdrop dissolve (`LIFT = min(BL)`) and the `HeaderLogo` handoff are
  untouched.

## Files

- `app/console/components/intro-canvas.tsx` — flag, direct-path branch in
  `candleAt`, `END`/`TICK_T0` anchoring, updated header comments.
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Verification

- `npm run lint` — 0 errors (335 grandfathered warnings, unchanged).
- `npx tsc --noEmit` — clean.
- `npm test` — 2901 passed (288 files).
- `npm run build` — succeeded.

## Follow-ups

- None planned. If the owner ever wants the centered wordmark back, flip
  `CENTER_WORDMARK_STEP` to `true` in `intro-canvas.tsx` — no other change
  needed.
