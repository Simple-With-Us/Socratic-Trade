# 2026-07-06 — Console intro animation (candlestick page-load splash)

## Summary

Added a first-load splash animation to the console: a candlestick chart of an
unnamed asset waves like an ocean, the candles break apart and fly (each on its
own staggered magnetic path), reassemble into a big **SOCRATIC / TRADE** (which
ticks left and waves gently), then shrink and fly into the small **SOCRATIC
TRADE** logo in the top-left, which keeps ticking. The overlay then fades to
reveal the console.

**Wave scope (owner call):** only the big **center** words wave — the gentle
travelling-sine ripple runs from the instant each candle lands until the words
begin shrinking into the header (`t < T4`), and its amplitude fades to zero over
the morph. The **top-left header logo never waves**.

**Center words keep their formed candles (no "flip"):** an earlier version ran a
smooth colour/body "tick field" over the big words once they formed, which the
owner saw as a sudden messy rearrangement ("the text at first looked right and
then flipped"). Fixed: the centre words now keep their formed candle bodies and
colours and *only* ripple — no field reshape on the big words at all.

**Header is a real candlestick ticker (matches `candle-tick` reference):** the
header no longer colours candles from a smooth low-frequency wave (which smeared
into one big red block + one big green block — a look the owner explicitly never
approved). It now uses the approved reference logic: a small green-biased price
walk of `P = 12` candle *units* (colour + body-fraction + vertical offset); each
header column shows one unit and the pattern marches one column left **per
second** (`UNITS[(column + floor(t - T4)) % P]`), so neighbouring columns differ
— a lively, varied red/green ticker, never a solid block. Two supporting fixes
made it read cleanly at logo size: (1) `lineToM` now **overlaps** the extra flying
candles onto each natural letter-stroke instead of subdividing a stroke into
stacked mini-candles (kills the speckle), and (2) header body width is tied to the
real column count (`header.w / NCOL * 0.55`) instead of a fixed `/40`, so bodies
no longer overlap into mush. Header size bumped (`logoH` → `clamp(vh*0.05,24,42)`)
for legibility.

- **New:** `app/console/components/intro-canvas.tsx` — a self-contained client
  `<ConsoleIntro>` component. Pure Canvas 2D; no dependencies. It samples the
  wordmarks from an offscreen canvas (bold Arial), generates a jagged
  upward-trending random-walk chart, and drives the whole keyframed animation in
  a `requestAnimationFrame` loop.
- **Wired:** `app/console/components/shell.tsx` renders `<ConsoleIntro/>` in the
  loading branch and the loaded branch (module-level clock so the
  loading→loaded transition doesn't restart it).

## Behavior / decisions

- **Responsive:** reads the viewport each resize and lays out the chart band,
  the centered stacked word, and the top-left header target independently, so it
  reflows between desktop (wide) and mobile portrait. Flight paths recompute from
  those regions.
- **Any background:** the canvas draws only candles (no baked background beyond
  the overlay's own `#0b1018`), so a transparent/any-bg export is trivial later.
- **Plays once per tab session** (`sessionStorage["st.introShown"]`), is
  **click-to-skip**, and is **skipped entirely for `prefers-reduced-motion`**.
- **Continuity:** during the flights each candle keeps its own identity and moves
  on a continuous magnetic path (trackable); the letter/logo "ticking" is a
  smooth continuous left-scroll of a trend field (not an abrupt per-second swap),
  so nothing hard-cuts.
- **Letter-stem evenness:** the type sampler uses a coverage threshold so bold
  stems render at a consistent candle-column weight (fixes the earlier "the R
  looks fatter" artifact).
- Timeline (1.5x of the original storyboard): ~2.25s wave (candles begin peeling
  off ~1.2s in, overlapping the wave) → assemble → **0.75s** big-word hold
  (ticking+waving; halved per owner) → 2.25s shrink to header → header ticks
  forever.

- **Reference:** `docs/branding/intro-live.html` is the standalone vanilla-JS
  version (open in a browser, resize, cycle backgrounds) the component was ported
  from; it is not used by the app.

## Verification

```
npx tsc --noEmit   # clean
npm run lint       # 0 errors (intro-canvas.tsx + shell.tsx clean)
npm run build      # exit 0
```
Also driven live: `npm run dev` + Playwright screenshots of `/console` at
t≈0.9/2.6/6.5/10.5s confirm chart → break-apart → big word → top-left logo →
fade-to-console, on a 1280×800 viewport.

Wave scope verified headlessly against `docs/branding/intro-live.html` (identical
math to the component): sampled a mid-word candle's wick top/bottom across the
center-hold window (spread ≈2.3px = waving) and the header window (spread 0.00px =
no wave).

Header/center rebuild driven in the **live app** (`npm run dev` → Playwright on
`/console`, fresh session): center-phase frame shows the big words holding their
formed candles + colours (no flip) while rippling; header-phase frame shows the
clean varied candlestick "SOCRATIC TRADE" ticker (per-candle red/green mix, no
colour blocks) marching left. Standalone frames also confirmed the header stays
varied and legible across consecutive ticks.

## Review follow-ups (PR #876)

Post-open fixes:
- **Mobile header overflow:** `logoH` now also clamps by available width
  (`(vw - 2·pad) / HEADER_AR`), so the enlarged header no longer runs off narrow
  viewports. Verified at 390×844 (center + header both fit) and 1280×800 (unchanged).
- **Copilot review comments (all addressed):** (1) `sampleCells` builds its font
  string from its `fontPx` arg instead of a hard-coded 200px const (honest
  contract); (2) the fade `setTimeout` is tracked and cleared in effect cleanup
  (no setState-after-unmount if unmounted mid-fade); (3) overlay `zIndex` raised
  60 → 200 so console toasts (120) / drawers (111) can't render over the splash;
  (4) added a keyboard skip (Escape / Enter / Space) alongside click-to-skip.

## Follow-ups

- Optionally replace the console header's text brand with the persistent ticking
  candle logo (so the splash hands off seamlessly to a live header logo).
- Transparent video export (now trivial from the canvas) if a social/marketing
  asset is wanted.
- Tunable knobs: scatter radius, tick speed, wave amount, splash length.
