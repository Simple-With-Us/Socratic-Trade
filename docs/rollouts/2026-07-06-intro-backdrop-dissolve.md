# 2026-07-06 — Console intro: solid backdrop that dissolves on candle liftoff

## Summary

The console intro splash now starts with a **solid, theme-matched backdrop** that
covers the page during the opening waving-chart phase, then **dissolves** to reveal
the console/page skeleton the moment the candles start moving up — instead of the
fully-transparent overlay (which showed the half-loaded console the whole time).

- `app/console/components/intro-canvas.tsx`:
  - The model now exposes `LIFT = Math.min(...BL)` — the earliest candle breakaway,
    i.e. when the candles first move up.
  - A **background layer** `<div>` (solid `var(--con-bg)`, theme-aware) sits behind
    the candle canvas inside the fixed overlay. It starts opaque; once `t >= LIFT`
    its opacity transitions to 0 over 0.9s, so the page reveals behind the rising
    candles. The canvas is `position: relative` so the candles always paint above
    the backdrop and stay opaque throughout.
  - The overlay wrapper keeps its own separate opacity fade for the final
    hand-off-to-header (`END`); the two fades are independent.

## Behavior / decisions

- **Owner intent:** "solid background color until the candlesticks start to move
  up and then the page skeleton/page can dissolve into view." `LIFT` is that
  moment; 0.9s dissolve.
- **Theme-aware:** the backdrop uses `--con-bg` (light `#f1f4f6` / dark `#0b1114`),
  resolved from the enclosing `.console-root[data-theme]`.
- Resolves the earlier open question (transparent vs. theme background) as a hybrid
  — solid first, then reveal.

## Verification

```
npm ci             # synced deps (local node_modules was stale vs main — see note)
npx tsc --noEmit   # clean
npm run lint       # 0 errors
npm run build      # exit 0
```

Driven live (`npm run dev` + Playwright on `/console`, 1280×800): t≈0.7s solid
backdrop (only the waving chart visible); t≈2.6s backdrop dissolving with the page
revealing behind the rising candles; t≈6.2s big SOCRATIC/TRADE words with the page
fully visible behind.

Note: a fresh `npm ci` was required locally — the pre-existing `node_modules` was
stale relative to `main`'s `@jaywedgeworth22/congress-trading-shared#v1.4.1`, which
surfaced as unrelated tsc errors in `congress-*`/`usage-monitor-push` until synced.
Not caused by this change; CI's fresh install is unaffected.

## Follow-ups

- Tunable: dissolve duration (0.9s) and the `LIFT` trigger point.
