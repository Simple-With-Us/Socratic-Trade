# 2026-08-05 — Collapsed "You're set" card: taller + vertically centered

## Context & Objective

The home readiness card collapses to **"YOU'RE SET"** with Dismiss / EXPAND.
When collapsed it used the open-state header padding (`pt-3.5 pb-1`), so the
one-line title sat top-weighted in a short strip. Owner asked for a slightly
taller collapsed card with the words vertically centered like other card rows.

## Changes Made

- **`app/console/console.css`**: when a collapsible `.con-card` is closed,
  override the summary row to balanced `0.875rem` vertical padding and
  `min-height: 3.25rem` so title/actions center. Open state unchanged.
- **`app/console/ui/primitives.tsx`**: comment pointing at the CSS contract.
- Docs: this rollout + effort board + STATUS.

## Decisions & Trade-offs

- Global for all collapsed collapsible Cards (same asymmetry would hit any
  summary-only card), not a one-off on readiness-checklist.
- Did not change open-state padding (still tight toward body content).

## Verification State

```bash
npx tsc --noEmit
npm run lint   # errors only
# full gate via scripts/land.sh
```

## Next Steps & Blockers

- Owner on-device check that collapsed "You're set" matches neighboring cards.
