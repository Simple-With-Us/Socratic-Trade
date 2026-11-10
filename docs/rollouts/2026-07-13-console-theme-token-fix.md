# 2026-07-13 - console-theme-token-fix

## Summary

Display-only CSS-class fix for a confirmed UI regression on every migrated Settings
page. `app/ui/ios-components.tsx` now paints its secondary text from the console token
system (`--con-*`) instead of the legacy `.dark`-keyed app utilities, so text and
background palettes stay on the same theme. Also corrects two undefined-token typos in
the console theme picker.

Two-line change footprint: `ios-components.tsx` 12 lines (6 class swaps), `chrome.tsx`
4 lines (2 typo fixes). No logic, data, or behavior touched.

## Why — the regression (divergent theme systems)

The app runs **two independent theme systems**:

1. **Console token system** — CSS custom properties `--con-*` defined in
   `app/console/console.css`, keyed to a `data-theme` attribute on `.console-root`.
   `--con-muted`, `--con-faint`, `--con-fg` all exist and **do** flip with `data-theme`
   (light: `#46556b` / `#566478` / `#17202e`; dark: `#a5b2c4` / `#8492a6` / `#e8edf4`).
2. **Legacy app utility classes** — `text-muted` / `text-faint` / `text-fg`, keyed to a
   `.dark` class on `<html>`.

The iOS-settings migration PR **#1476** added `app/ui/ios-components.tsx` mixing the two:
backgrounds/surfaces used console tokens (`bg-[color:var(--con-surface)]`,
`border-[color:var(--con-line)]`) but secondary text used the legacy `text-muted` /
`text-faint` / `text-fg` utilities. The **same PR** shipped a Light/Dark/System theme
picker that flips **only** the console system (`data-theme` on `.console-root`), leaving
`<html>.dark` unchanged. So the two systems diverged:

- **Console dark mode** (data-theme=dark, html not `.dark`): the legacy classes resolved
  to their light-mode palette — muted text stayed a dark slate `rgb(63,79,96)` on a dark
  card = **nearly invisible**.
- **html-dark + console-light**: washed-out light text on a white card.

Confirmed two independent ways: a live browser probe of the rendered computed colors, and
a code bisection of the two theme systems. Every migrated Settings page was affected.

Separately, the theme picker's active-state classes in `app/console/components/chrome.tsx`
referenced `var(--con-text)` — **not a defined token** — so the active tab's text color
silently fell back to `currentColor`/inherited rather than the intended foreground. The
correct token is `--con-fg`.

### Why CI missed it

The legacy `text-*` utilities are **valid, existing classes** — they compile and pass lint,
tsc, and the build. The bug is a *wrong-palette* selection at runtime, not a broken or
missing class, so nothing in the static gate (tsc / test / build) could catch it. It only
manifests as a computed-color contrast failure in a rendered browser under console dark
mode. There is no visual-regression / contrast test covering these components.

## The fix

`app/ui/ios-components.tsx` — 6 swaps to the `text-[color:var(--con-*)]` arbitrary-value
form the **same file already uses** at its other call sites (e.g. `NavigationLinkRow`,
`LargeTitle`), so text now tracks the console `data-theme` exactly like the surfaces do:

- `ListSection` title `h2`: `text-muted` → `text-[color:var(--con-muted)]`
- `ListSection` footer: `text-faint` → `text-[color:var(--con-faint)]`
- `LabeledContent` icon span: `text-muted` → `text-[color:var(--con-muted)]`
- `LabeledContent` label span: `text-fg` → `text-[color:var(--con-fg)]`
- `LabeledContent` hint span: `text-muted` → `text-[color:var(--con-muted)]`
- `LabeledContent` value wrapper div: `text-muted` → `text-[color:var(--con-muted)]`

`app/console/components/chrome.tsx` — 2 typo fixes in the theme-picker active state:

- both `var(--con-text)` → `var(--con-fg)` (the active tab's text color)

Post-edit greps confirm **0** standalone legacy utility classes (`text-muted` /
`text-faint` / `text-fg`) remain in `ios-components.tsx` and **0** `con-text` remain in
`chrome.tsx`. The `text-[color:var(--con-*)]` arbitrary-value forms are the correct target
and are intentionally kept.

## Files

- `app/ui/ios-components.tsx`
- `app/console/components/chrome.tsx`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-console-theme-token-fix.md`

## Verification

- `npx tsc --noEmit` — via `scripts/land.sh`
- `npm test` — via `scripts/land.sh`
- `npm run build` — via `scripts/land.sh` (compiles Tailwind; the `text-[color:var(--con-*)]`
  arbitrary-value utility form already builds fine for the untouched call sites in the same
  file, so the swapped sites generate identically)
- Grep confirmations: 0 standalone `text-muted`/`text-faint`/`text-fg` in `ios-components.tsx`;
  0 `con-text` in `chrome.tsx`.

## Follow-ups

- **`/console/usage` is NOT fixed here.** That page uses the fully-legacy design system
  (not the console token system at all), so it is a **separate, pre-existing** issue,
  independent of this #1476 regression. Out of scope for this display-only token-mixing fix.
- No visual-regression / computed-contrast test guards these components; a future guard
  would catch this class of wrong-palette regression that the static gate cannot.
