# 2026-06-21 - ticker-logo transparent default + tile-monogram fallback

## Summary

- Ticker logos now **default to the transparent (clean, no-background) treatment**
  instead of the small tile.
- When a logo image cannot be loaded (no GitHub/logo.dev match, or a
  network/timeout error), `TickerLogo` now **falls back to a tile monogram**
  (the symbol's first 1–2 letters on the existing tile surface) instead of
  collapsing to a bare gap / ticker text. An explicit `fallback` prop (used by
  the symbol drilldown) still takes precedence.

## Why

- User report: the Display → "Logo source" picker (Auto / GitHub / logo.dev) did
  nothing — all three looked identical — and they wanted the look in their
  screenshot (transparent) to be the default, reverting to a tile when a logo
  fails.
- Root cause of the "picker does nothing" half: it was **already removed on
  `main`** (commit `e61ec84` "wire logos everywhere + remove source picker"); the
  route is now a deterministic GitHub-first → logo.dev-fallback cascade and reads
  no `?source=`. The user's deployment was simply behind `main`, so they still
  saw the dead toggle. No code change was needed for that half — it resolves on
  deploy. This change implements the remaining ask: transparent default + tile
  fallback on failure.

## Files

- `src/lib/ticker-logos.ts` — `DEFAULT_TICKER_LOGO_DISPLAY` changed `"tile"` → `"transparent"`.
- `app/ui/ticker-logo.tsx` — added `monogram()` + `monogramFontClass`; on image
  load failure, render a tile monogram (reusing the existing tile surface
  styling) unless a caller-supplied `fallback` is present.
- `test/ticker-logos.test.ts` — updated the default-display assertion to `"transparent"`.

## Behavior notes

- The persisted per-browser preference (`localStorage["ticker-logo-display"]`)
  is unchanged: returning users keep whatever they previously selected; the new
  default only applies to users who never changed it. The user can pick
  "Medium" (= transparent) once if their browser saved an old value.
- `display: "off"` still renders nothing (or the caller fallback) — unchanged.
- Failure fallback color/treatment matches the existing tile: dark slate tile in
  light mode (keeps glyphs visible), translucent surface tile in dark mode.

## Verification

- `npx tsc --noEmit` — clean (after `npm install`; node_modules was empty on a
  fresh container).
- `npx vitest run test/ticker-logos.test.ts` — 4/4 pass.
- `npm test` — 647 pass, 1 fail: `test/cache-provenance.test.ts` (macro
  cross-user cache). **Pre-existing and unrelated** — confirmed it also fails on
  the base with the logo changes stashed; it is date-sensitive (asserts a
  no-key FRED fallback `asOf` of "unavailable" but today's date 2026-06-22 is
  returned). Not touched by this change.
- `npm run build` — succeeds.

## Follow-ups

- Pre-existing `test/cache-provenance.test.ts` failure should be looked at by
  whoever owns macro caching (date-sensitive assertion).
- Optional: the Display labels on `main` read "Small Tile / Medium / Off";
  "Medium" is a less obvious name for the transparent style. Renaming to
  "Transparent" would match user vocabulary, but was left out of scope here.
