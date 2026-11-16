# 2026-07-08 — Intro→logo handoff: hidden-until-assembled + mobile brand row (MONET)

## Summary

Two owner-directed refinements to the console intro handoff:

1. **The persistent header logo no longer pre-exists the candles.** Previously
   the top-bar `HeaderLogo` was visible from first paint, so once the intro's
   backdrop dissolved you could see the finished logo sitting there while the
   candles were still flying "onto" it. Now it stays invisible (opacity 0,
   layout box preserved so the splash can still measure its landing target)
   until the candles assemble it, then fades in.
2. **Mobile gets a real landing target.** Below `lg` the bar logo is
   `display:none`, so the intro used to land on a phantom fallback box. Now,
   while the splash plays, the chrome reserves a full-width brand row ABOVE the
   controls bar (account scope, state chip, theme, profile, Start/Run) —
   making the chrome roughly twice as tall — whose big "SOCRATIC TRADE"
   (~88% of viewport width) is the splash's landing target. The wordmark
   appears when the candles assemble it, holds ~3s, then the whole row slides
   up and away (~550ms) to give the screen space back. Repeat visits and
   reduced-motion loads (intro skipped) never show the row.

## Mechanics

- New `app/console/ui/intro-bus.ts`: a tiny module-state phase channel
  (`pending → playing → landed → done`, monotonic) written by the splash and
  subscribed to by the header chrome. "pending"/"playing" are only ever
  observable while the splash overlay covers the page, so the hidden logo is
  never wrongly visible; the server always renders "pending" so hydration
  matches.
- `intro-canvas.tsx`: `setIntroPhase("playing")` once the splash actually runs;
  `startFade` (natural end AND user skip) doubles as `"landed"`; `hide()`
  settles `"done"` (finish or never-played). `measureHeader` now picks the
  first VISIBLE `[data-brand-logo]` (there are two instances now — desktop bar
  logo and mobile row).
- `shell.tsx`: new `BrandReveal` (desktop bar logo, opacity-gated on the phase)
  and `MobileBrandRow` (lg:hidden row above the bar; states
  waiting → shown → leaving → gone; 3000ms hold, 550ms slide via
  height + translateY collapse; unmounts at "gone").

## Verification

- `npm run lint` 0 errors; `npx tsc --noEmit` clean; `npm test` 2972 passed
  (288+ files); `npm run build` OK.
- Live dev-server checks (desktop 1280×800 and mobile 375×812, DOM-sampled +
  screenshots): logo absent during chart/flight, fades in at landing
  (caught mid-transition at opacity 0.22), `st.introShown` set on finish;
  mobile row shows the full-width wordmark above the controls bar, then
  slides away and unmounts (`[data-brand-logo]` count drops to 1); repeat-visit
  loads show no row and an immediately-visible desktop logo; zero console
  errors/warnings.
- Headless-verification gotcha worth recording: `requestAnimationFrame` does
  not fire in a hidden preview tab, so the raf-driven splash parks until a
  screenshot forces a compositor frame — sample DOM state around forced
  frames, or the intro looks "stuck" when it isn't.

## Files

- `app/console/ui/intro-bus.ts` (new)
- `app/console/components/intro-canvas.tsx`
- `app/console/components/shell.tsx`
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Follow-ups

- ui-audit-sweep's PR #1110 also touches `shell.tsx` (MobileFreshnessBar mount
  below ChromeBar — disjoint from this change); whichever lands second merges
  main and re-verifies.
