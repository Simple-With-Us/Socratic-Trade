# 2026-07-20 — Guardrails section-heading chevron position + darker heading color

## Summary

Two CSS-only fixes to the collapsible section headers used on the Guardrails page
(`Essentials` / `Protective stops` / `Advanced rulebook`, rendered by `Card`'s
`collapsible` variant in `app/console/ui/primitives.tsx`):

1. The disclosure chevron (`>` collapsed / `v` expanded) now renders on the **right**
   side of the heading text instead of the left.
2. Section-heading text (`.con-card-title`) is now `var(--con-fg)` (the app's
   darkest/highest-contrast text token) instead of `var(--con-faint)`.

## Why

Owner request from a screenshot of the Guardrails page: move the chevron to the right
of the heading, and darken the heading text to match the darkest text elsewhere in the
app.

`.con-card-title` is the shared section-heading class used across the whole console/admin
app (22 files), not just these two accordions, so darkening it in `console.css` makes
every section heading in the app consistently as dark as body text, rather than creating
a one-off inconsistency between the Guardrails accordions and every other card header.

The chevron was a `summary::before` pseudo-element (first flex child, hence left-aligned).
Changed to `summary::after` with `margin-left: auto` so it's pushed to the far right of
the row; the corner-border-rotate technique that draws the chevron shape itself
(`border-right` + `border-bottom` + `rotate(-45deg)`/`rotate(45deg)` for closed/open) is
unchanged.

`collapsible` is currently only used by the three Guardrails accordions (verified via
grep — no other page passes `collapsible` to `Card`), so this change has no blast radius
beyond that page today.

## Files

- `app/console/console.css` — `.con-card-title` color `--con-faint` → `--con-fg`;
  `.con-disclosure > summary::before` → `::after` (+ `margin-left: auto`), same rename
  on the `[open]` rotate rule.

## Verification

- `npm run lint` — 0 errors (pre-existing warning backlog unchanged).
- `npx tsc --noEmit` — clean.
- `npm test` — 4878/4881 pass; the 3 failures (`chat-draft-policy.test.ts`,
  `llm-provider-cooldown.test.ts`, `server-metrics.test.ts`) are pre-existing and
  unrelated — confirmed by `git stash`-ing this change and re-running the same 3 files,
  which fail identically against unmodified `main`-based tree.
- `npm run build` — fails in this sandbox with `Failed to collect page data for
  /_not-found` / `TypeError: Invalid URL` during page-data collection. Confirmed
  pre-existing and environment-specific (not caused by this change): identical failure
  reproduces with the CSS change stashed out, against the same tree. Root cause not
  investigated further (out of scope for a CSS-only change; looks like a sandbox env-var
  gap, not a code defect).
- Visual verification: since this cloud sandbox has no path to authenticate through the
  app's Google-OAuth login, the actual `/console/guardrails` page couldn't be driven in a
  browser. Instead, built an isolated HTML reproduction of the exact `Card`
  collapsible markup (`<details class="con-card con-disclosure"><summary>...`) loading
  the real, modified `app/console/console.css`, and screenshotted it with Playwright
  (chromium) in both light and dark `prefers-color-scheme`. Confirmed: chevron sits at
  the right edge of the row in both collapsed (`>`) and expanded (`v`) states, and the
  heading text renders at the same darkness as body text, in both themes.

## Follow-ups

None identified. No product logic, money path, or test-covered behavior touched.
