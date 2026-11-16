# 2026-07-09 — Intro size jump (real AR) + remove loading text (MONET)

## Summary

Two owner-reported items on the console intro (both viewports, prod):

1. **The wordmark still had a sudden SIZE change ~1s after the candles
   assembled.** Root cause (measured, not guessed): the persistent `HeaderLogo`
   canvas reserved its width from a hardcoded `13.8` aspect-ratio *estimate*,
   but its own effect then set the width from the real runtime-sampled
   `wm.ar = 13.081` — a **5.2% narrower** value. So the logo canvas visibly
   shrank ~5% on mount, and the intro (which measures `[data-brand-logo]` every
   frame and eases onto it) followed the shrink. The `13.8` guess lived in three
   places (`header-logo.tsx` initial width, `shell.tsx` `MobileBrandRow`, and
   the intro's mobile fallback height), so they all drifted from the true AR.
2. **Remove the "Socratic Trade / Loading the autonomy desk…" text** shown
   during the load animation — the candlestick intro is now the entire load
   screen.

## Fix

- **`candle-ticker.ts`**: new exported `WORDMARK_AR = 13.081` — the *measured*
  `sampleWordmark("SOCRATIC TRADE").ar` (replicated the sampler's bbox math in a
  browser to get the exact value). Single source of truth; documented that it
  must equal the runtime sampler and how to re-measure. Replaces the `13.8`
  guess everywhere.
- **`header-logo.tsx`**: initial inline canvas width now uses `WORDMARK_AR`, so
  the reserved width already equals what the effect sets → the canvas no longer
  resizes on mount (kills the self-jump the intro was following).
- **`shell.tsx`**: `MobileBrandRow` uses the imported `WORDMARK_AR` (local
  `13.8` removed); loading branch renders only `<ConsoleIntro />` (text block
  deleted).
- **`intro-canvas.tsx`**: mobile fallback height divisor uses `WORDMARK_AR`
  (matches `MobileBrandRow`); `curHeader` (the eased landing box) hoisted to
  module scope as `introCurHeader` so a loading→loaded remount no longer resets
  it to null and **snaps** to the freshly-mounted real logo — it keeps easing.

## Verification

- `npm run lint` 0 errors; `npx tsc --noEmit` clean; `npm test` 3168 passed
  (306 files); `npm run build` OK.
- **Root cause proven fixed empirically**: polled the desktop bar logo's width
  for 7s across a fresh intro — **one distinct value, 235px** (= round(18 ×
  13.081)), zero jump. Previously it would flash 248 (round(18 × 13.8)) then
  settle to 235.
- Mobile visual replay (375×812): the brand row assembles the full-width
  "SOCRATIC TRADE" at the top, holds, and slides away — no size pop between
  assembly and slide. Mobile uses the identical `HeaderLogo` code path, so the
  same initial-width fix applies (logoH 25 → width round(25 × 13.081) = 327,
  stable).
- Loading text confirmed gone: the loading branch renders only `<ConsoleIntro
  />`; the only remaining "autonomy desk" strings are a marketing page, a meta
  description, and the separate `!snapshot` *error* message ("Couldn't load
  the autonomy desk"), none of which is the load label.

## Files

- `app/console/ui/candle-ticker.ts`, `app/console/ui/header-logo.tsx`,
  `app/console/components/shell.tsx`, `app/console/components/intro-canvas.tsx`
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Review follow-up (Codex P2)

The reviewer flagged that removing the text left a **blank** load screen for
visitors whose intro is *skipped* (returning tab via `st.introShown`, or
prefers-reduced-motion) — those never see the animation. Addressed with a new
`LoadingBrand` component in the loading branch: it renders a small centered,
text-free static candlestick "SOCRATIC TRADE" mark **only** when the intro is
skipped (returns `null` on a first visit, so it never interferes with the
animation the owner asked to keep). First visit still gets the full intro and no
text; skipped loads get the brand mark instead of a blank flash. Verified first
visit visually (clean animation, no stray mark) + lint/tsc/build; the
sub-second loading window itself isn't freezable in the preview harness, so the
skip fallback is covered by logic + the first-visit non-interference check.

## Follow-ups

- If the wordmark text or font ever changes, re-measure `WORDMARK_AR` (documented
  in candle-ticker.ts). Arial is metric-compatible, so the value is stable
  across platforms.
