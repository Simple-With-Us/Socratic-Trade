# 2026-07-06 — Fix mobile horizontal overflow on the console autonomy-desk home

## Summary
On mobile, every section *after* the Live-thesis hero (Autonomous actions, Evidence,
Positions, etc.) rendered wider than the viewport, pushing content off the right edge
while the hero stayed at the correct width. Fixed by making the console home's lower
content grid shrink-safe.

`app/console/page.tsx`: the wrapper below `.con-thesis-hero` was
`<div className="grid gap-4 xl:grid-cols-[...]">` with two column children
(`<div className="flex flex-col gap-4">` and `<aside className="flex flex-col gap-4">`).
- Added `grid-cols-1` to the wrapper so the mobile (base) track is
  `repeat(1, minmax(0,1fr))` instead of an implicit `auto` (min-content) track.
- Added `min-w-0` to both column children so they can shrink below their content's
  min-content width.

## Why
The lower grid on mobile had no explicit column template, so it fell back to a single
`auto` track. Its grid items defaulted to `min-width: auto`, which propagated the widest
descendant's min-content up the tree. The widest descendant is the 7-column
`PositionsCard` table (`.con-table th` is `white-space: nowrap`), whose min-content is
~610px. Even though the table is wrapped in `overflow-x-auto`, the `min-width: auto`
column defeated that scroll container: instead of the table scrolling inside its card, the
whole column stretched to ~627px on a 390px viewport, dragging every sibling card
(Autonomous actions, etc.) off-screen.

The Live-thesis hero did **not** overflow because its CSS already uses shrink-safe columns
(`grid-template-columns: minmax(0,1.45fr) …`, collapsing to `1fr` at ≤900px) plus
`min-width:0` on its children — this fix applies that same proven pattern to the lower grid.
The console layout shell (`app/console/components/shell.tsx`) already sets
`<main className="min-w-0 …">`, so no layout-level change was needed.

## Files
- `app/console/page.tsx` — `grid-cols-1` on the lower grid wrapper; `min-w-0` on the two
  column wrappers (the left `<div>` and the right `<aside>`).

## Verification
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npm run build` — green (also confirms Tailwind emits `grid-cols-1` / `min-w-0`).
- Empirical before/after at a 390px viewport using the real `console.css` and the exact
  page markup (headless Chromium): BEFORE the positions card measured 611px wide and the
  column extended to 627px (237px page overflow), `overflow-x-auto` not scrolling; AFTER
  the column/card are contained at 374px and the table scrolls inside its card
  (`scrollWidth > clientWidth`). Rendered `/console` at 390px post-fix shows 0 overflow.

## Follow-ups
- Final confirmation on beta/production with a populated account (real positions +
  decisions) is worthwhile since the sandbox console has no connected account; the
  synthetic repro used the real CSS + representative data to stand in for that.
