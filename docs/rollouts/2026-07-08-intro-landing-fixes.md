# 2026-07-08 — Intro landing fixes: viewport-true fallback, eased retarget, fade gated on the real logo (MONET)

## Summary

Fixes two owner-reported production regressions in the intro→header-logo
handoff (follow-up to `2026-07-08-intro-logo-handoff.md`):

1. **Mobile: wordmark assembled a few sizes too small, then popped larger.**
2. **Desktop: logo landed top-left, vanished for ~1s, then reappeared when the
   page finished loading.**

Root cause (both): on a slow first load the intro plays against the shell's
loading screen, where no `[data-brand-logo]` exists. The candles landed on the
old hard-coded fallback box (~20px, top-left — much smaller than the mobile
brand row) and the overlay then faded on schedule with nothing mounted
underneath; when the console finally mounted, the real logo appeared at a
different size/position (mobile pop) or out of thin air (desktop gap).

## Fix (all in `app/console/components/intro-canvas.tsx`)

- **Viewport-true fallback box**: `<lg` mirrors MobileBrandRow's geometry
  (height `clamp(16..34, 88vw/13.8)`, centered near the top — a keep-in-sync
  comment now sits on both sides); `>=lg` mirrors the bar logo (18px at the
  left edge of the centered `max-w-[1400px] px-4` bar). Assembly happens at
  the right size/place even before the console mounts.
- **Eased landing box**: the landing target lerps (`1 - exp(-10·dt)`, ~0.35s
  settle) toward the measured logo instead of snapping, so a mid-flight or
  post-landing mount is a small glide, not a jump.
- **Fade gated on a settled real target**: the natural fade now requires a
  measured `[data-brand-logo]` that the glide has settled on (<2px). While the
  page is still loading, the ticking wordmark stays up as branded loading
  chrome (the overlay is transparent after LIFT, so the loading screen shows
  through). A 45s backstop covers pages that never mount a logo (error shell)
  — deliberately long: the first cut used 8s and a slow cold load blew through
  it, re-creating the vanish-gap. User skip (click/Esc) fades instantly and is
  unchanged.

## Verification

- `npm run lint` 0 errors; `npx tsc --noEmit` clean; `npm test` passed;
  `npm run build` OK.
- Live dev-server, cold compile (genuine slow-load): **mobile 375×812** — wordmark
  assembled at full row size centered near the top while "Loading the autonomy
  desk…" was still up; overlay held (no fade); on console mount, a same-size
  crossfade to the real row (caught mid-fade in a frame), 3s hold, slide-away.
  **Desktop 1280×800** — wordmark assembled at bar-logo size/position during
  the loading shell and held ticking. Warm loads on both viewports behave as
  before (immediate measure → normal timeline). Zero console errors.
- Headless note: rAF doesn't fire in hidden tabs; screenshots force frames.
  The 8s→45s lesson above surfaced exactly this way.

## Files

- `app/console/components/intro-canvas.tsx`
- `app/console/components/shell.tsx` (keep-in-sync comment only)
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Follow-ups

- None. If the error-shell-with-wordmark cosmetic ever bothers anyone, the
  shell could publish an explicit "no logo coming" signal on the intro bus.
