# 2026-08-17 — Console accessibility batch (#2561)

## Context & Objective

The 2026-08-06 product review's design/a11y lane found the console token system
otherwise excellent, then listed concrete gaps: light-theme chip text failed
WCAG AA on soft fills, stacked Sheets closed together on Escape, tooltips were
keyboard-unreachable and unannounced, and the scan Columns popover missed
overlay semantics.  This change closes those P1/P2 items (and the listed P3s)
without touching trading or money-path behavior.

## Changes Made

Light tonal tokens (`--con-pos/neg/warn/info/none`) are one step darker so
11px/600 chip text clears 4.5:1 against the matching `*-soft` wash, not the
plain surface.  Dark `--con-faint` is lifted one step in both twin dark blocks
for AA headroom on `surface-3`.  `Sheet` and nav `TabsSheet` now use the
stack-aware `useFocusTrap` (same hook as the drawer and palette), so only the
topmost surface handles Escape.  `Tooltip` adds `tabIndex` for non-interactive
triggers plus a persistent `aria-describedby` description.  The scan Columns
popover gets `aria-expanded`/`aria-controls`, moves focus in, and closes on
Escape.  `Meter` accepts a `label` (wired at the console and admin call sites).
`Toggle`'s `label` prop is required; every existing call site already passed it.

Touched files:

- `app/console/console.css`
- `app/console/lib/contrast.ts`
- `app/console/lib/tooltip-trigger.ts`
- `app/console/ui/focus-trap.ts`
- `app/console/ui/sheet.tsx`
- `app/console/ui/primitives.tsx`
- `app/console/components/nav.tsx`
- `app/console/scan/scan-table.tsx`
- `app/console/page.tsx`
- `app/console/guardrails/page.tsx`
- `app/console/components/chrome.tsx`
- `app/admin/page.tsx`
- `app/admin/server/server-metrics-client.tsx`
- `app/admin/rag-coverage/rag-coverage-client.tsx`
- `test/console-a11y.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-08-17-console-a11y-batch.md`

## Decisions & Trade-offs

- Soft-fill contrast is computed as sRGB alpha-composite of the tone at the
  CSS `color-mix` percentage over white / `--con-surface-2`.  That matches how
  the chips actually paint; measuring text against the plain surface was the
  original miss.
- `--con-paper` and `--con-accent` already cleared AA on their soft fills and
  were left alone.
- Tooltip `tabIndex={0}` is applied only when the child is not a native
  interactive control, so `Btn` / `IconButton` do not grow a second tab stop.
- `nextSheetFocusTarget` stays exported for the existing wrap-math test;
  live sheets no longer use it.
- Admin `Meter` call sites got names too.  Same primitive, same unnamed
  progressbar bug; not a money-path change.

## Verification State

Commands run:

```bash
npx vitest run test/console-a11y.test.ts test/console-sheet.test.tsx test/console-focus-trap.test.ts test/scan-table-columns.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Focused suite: 20 passed.  Lint 0 errors (grandfathered warnings only).  `tsc --noEmit` clean.  `next build` succeeded.

GitHub `verify` + `verify-hosted` on PR #2795 are green (the required merge gate).  A full local `npm test` in this cloud VM also hit three unrelated env failures (TwelveData call-count fixture, `usesLocalHost` on the VM, usage-budget picking up a real bearer).  Those files are outside this change; CI is the authority.

## Next Steps & Blockers

None for this batch.  Remaining 2026-08-06 a11y/polish leftovers stay on their
own issues (#2562 copy/canvas polish, #2563 curl-only admin surfaces).

## Zero-Code Findings

None.  The review's line numbers had drifted (chips now sit near
`console.css:544`, tokens near `:40`) but the failing pairs were the ones it
named.
