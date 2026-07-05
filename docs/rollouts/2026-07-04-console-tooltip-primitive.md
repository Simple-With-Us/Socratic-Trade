# 2026-07-04 - Accessible console tooltip/popover primitive

## Summary
- Added reusable console-scoped tooltip primitives in `app/console/ui/primitives.tsx`:
  `Tooltip`, `TooltipText`, and `InfoTip`.
- Replaced a focused first slice of native `title` usage in console scan, orders,
  learned-context, and approval-card surfaces.

## Why
- Issue #474 calls for an accessible tooltip/popover primitive instead of relying on browser-native
  `title`, especially on dense console controls, metrics, and cells where hover-only behavior is
  poor on touch and inconsistent for keyboard users.
- This pass stays tightly scoped to the console lane and avoids unrelated Monet risk, Claude
  memory/RAG, workflow, and shared `app/ui` surfaces.

## Files
- `app/console/ui/primitives.tsx`
- `app/console/scan/scan-table.tsx`
- `app/console/orders/page.tsx`
- `app/console/approvals/learned-context.tsx`
- `app/console/components/approval-card.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification
- `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --pretty false`
  - passed
- `npm run lint -- --quiet`
  - passed
- `git diff --check`
  - passed
- `rg -n "title=" app/console/ui/primitives.tsx app/console/approvals/learned-context.tsx app/console/orders/page.tsx app/console/scan/scan-table.tsx app/console/components/approval-card.tsx`
  - used as a targeted audit of remaining native `title` usage in the touched files; this first
    slice leaves low-risk wrapper/primitive `title` props and a few dense approval geometry labels
    for a later conversion pass

## Follow-ups
- Merge-forward over the current `origin/main` after the scan-column branch lands, because both
  slices touch `app/console/scan/scan-table.tsx`.
- A later broad conversion pass can retire the remaining native `title` attributes now that the
  primitive exists.
