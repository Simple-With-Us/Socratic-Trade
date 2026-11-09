# 2026-07-04 - Console scan column customization parity

## Summary

Brought `/console/scan` up to legacy dashboard parity for browser-local scan-table column
customization: users can now show/hide columns, reorder visible columns, reset to the default
layout, and keep that visible-column state/order saved per browser.

## Why

`docs/reviews/2026-07-03-console-parity-open-items.md` still listed scan-table column
customization as missing from the new console. The legacy dashboard already had this behavior via
`localStorage`, and the owner asked for parity on visibility, ordering, reset, and saved state
without turning this lane into a broader settings/live-data conversion.

## Files

- `app/console/scan/columns.tsx`
- `app/console/scan/scan-table.tsx`
- `test/scan-table-columns.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/reviews/2026-07-03-console-parity-open-items.md`
- `docs/phase-8-cockpit-ui.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## What changed

- Added `DEFAULT_VISIBLE_SCAN_COLUMN_IDS` in `columns.tsx` so the scan table has an explicit
  default visible-column order.
- Added a console-scoped `localStorage` key in `scan-table.tsx`
  (`console-scan-visible-cols-v1`) plus pure helpers to:
  - sanitize stored visible-column state against the current column list,
  - prevent the symbol column from disappearing,
  - move visible columns earlier/later,
  - fall back to a visible sort column if a saved/hidden state removes the active one.
- Added a compact Columns popover to `/console/scan` with:
  - visibility checkboxes,
  - reorder arrows for visible columns,
  - Reset to restore the default visible set/order,
  - hidden-column labeling,
  - browser-local persistence wording.
- Added focused pure-helper regression coverage in `test/scan-table-columns.test.ts`.
- Updated status/plan/review docs plus both effort boards to reflect that this parity item is now
  in progress and implemented in this worktree.
- Addressed Codex PR review on PR #806 by pinning `symbol` as the first/sticky column during both
  saved-state sanitization and visible-column reordering.
- Addressed follow-up Codex PR review on PR #806 by deferring saved `localStorage` column state
  until after mount, keeping the server render and first client render on the default column layout.

## Verification

Initial attempt before dependency bootstrap:

```bash
npx vitest run test/scan-table-columns.test.ts
which tsc
```

- `npx vitest run test/scan-table-columns.test.ts` failed before loading the test because this
  worktree has no local `node_modules`: `Could not resolve 'vitest/config'` and
  `ERR_MODULE_NOT_FOUND`.
- `which tsc` returned not found.

Final verification:

```bash
npm test -- --run test/scan-table-columns.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results:

- focused scan-column helper suite passed: 1 file / 4 tests.
- lint passed with 0 errors and 308 existing warnings.
- TypeScript passed.
- full test suite passed: 255 files / 2469 tests.
- production build passed with the existing Sentry Edge runtime warning.

Review-thread follow-up on 2026-07-05:

```bash
npx vitest run test/scan-table-columns.test.ts
NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --pretty false
```

- pending rerun after the symbol-pinning patch.
- focused scan-column helper suite passed: 1 file / 4 tests.
- TypeScript passed.
- `git diff --check` passed.

Hydration follow-up on 2026-07-05:

```bash
npx vitest run test/scan-table-columns.test.ts
NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --pretty false
npm run lint -- --quiet
```

- focused scan-column helper suite passed: 1 file / 4 tests.
- TypeScript passed.
- lint passed with 0 errors.

## Follow-ups

- If the owner wants deeper legacy parity later, the next scan-only follow-up would be expanding
  the console scan column catalog itself; this lane intentionally kept the behavior scoped to the
  current console column set.
