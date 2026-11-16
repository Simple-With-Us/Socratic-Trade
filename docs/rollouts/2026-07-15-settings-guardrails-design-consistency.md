# Settings design consistency + Guardrails collapsible sections

**Date:** 2026-07-15
**Seat:** CLAUDE (Fable)
**Branch:** `claude/settings-guardrails-consistency`

## Summary

Owner report: the Settings page looked inconsistent with the rest of the console ("fucked
up … no agent seems able to fix it"), and the Guardrails "Universe" section was collapsible
while its sibling sections were not. Two coordinated UI fixes:

1. **Settings now uses the same `con-card` design as every other console page.**
2. **All top-level Guardrails sections are now consistently collapsible.**

## Why

**Root cause of the Settings mismatch (the part prior passes missed):** the entire Settings
page was built on `app/ui/ios-components.tsx` (`List` / `ListSection` / `ListRow` /
`LabeledContent`) — a component set used by **no other page in the app**. Every other page
(Mandates, Scan, Results, …) uses the `con-card` primitive. Worse, on Settings these were
**nested**: an outer bordered `ListSection` scope-group ("ALL YOUR ACCOUNTS") wrapped inner
bordered `ListSection` cards ("BROKER CONNECTIONS", "API KEYS"), producing boxes-inside-boxes
with heavy iOS-style uppercase headers. It was a structural mismatch, not a token/color one
(both already used the same `con-*` variables).

## Changes

**Settings → flat cards (matches Mandates):**
- `app/ui/ios-components.tsx`: `ListSection` now renders the shared **`con-card`** primitive
  (standalone titled card with divided rows) instead of the ad-hoc `rounded border shadow`
  box. Because `ios-components` is Settings-only, this harmonizes every Settings sub-card at
  once without touching their ~143 call sites.
- Added `SettingsGroup` (a lightweight scope label + optional footer + stacked cards, **no**
  bordered container) for the page-level groupings.
- `app/console/settings/page.tsx`: the 5 outer scope groups (ALL YOUR ACCOUNTS / THIS BROWSER
  / OPERATOR / REFERENCE / DANGER) now use `SettingsGroup`, eliminating the nested-box look;
  each section card stands alone exactly like a Mandates card.

**Guardrails → consistently collapsible:**
- `app/console/ui/primitives.tsx`: `Card` gained optional `collapsible` + `defaultOpen`
  props (default off / open, fully backward-compatible). When collapsible it renders a native
  `<details className="con-card con-disclosure">` with the title as the summary and the
  existing `con-disclosure` chevron.
- `app/console/guardrails/page.tsx`: the three top sections ("Essentials", "Protective
  stops", "Advanced rulebook") are now `collapsible defaultOpen`, so every Guardrails section
  can collapse/expand consistently (the "Universe" advanced group was already collapsible).

## Verification

- `npx tsc --noEmit` clean; `eslint` on the 4 changed files: 0 errors.
- `npm run build` (Node 24) succeeded — all 32 routes compiled.
- Rendered both pages in a local Node-24 dev server:
  - Settings: "ALL YOUR ACCOUNTS" is now a light label; "BROKER CONNECTIONS" is a standalone
    `con-card` identical to Mandates' cards — no nested boxes.
  - Guardrails: "ESSENTIALS" (and the other sections) show the disclosure chevron and
    collapse/expand.
- No logic/behavior changed — display-only. `Card`'s new props are opt-in; all other pages
  using `Card` are untouched.

## Files

- `app/ui/ios-components.tsx`
- `app/console/settings/page.tsx`
- `app/console/ui/primitives.tsx`
- `app/console/guardrails/page.tsx`

## Follow-ups

- None required. If the owner later wants the Guardrails inner "advanced" groups (Universe,
  Exposure caps, …) open by default too, set `defaultOpen` on those `AdvancedGroup`s.
