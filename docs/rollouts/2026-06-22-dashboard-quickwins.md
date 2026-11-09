# 2026-06-22 Dashboard Quick Wins

## Summary

Five targeted fixes to `app/dashboard-client.tsx` and supporting modules,
addressing a safety gap, three UI gaps (command palette, scheduler display,
audit log), and an SSE coverage gap for learned-context badge updates.

## Why

All five items were audited against current `main` and confirmed real before
implementation. No findings were pre-existing no-ops.

## Changes

### 1. strategyAuthority → "decide" safety gate (P0)

Both the header Mode select and the Settings "Strategy authority" select now
intercept a switch to `"decide"` and show a `ConfirmModal` with an explicit
autonomous-execution disclaimer before calling `updatePolicy`. Switching AWAY
from `"decide"` remains instant. A new `decideConfirm` boolean state drives
the modal in `DashboardApp`; a new `onRequestDecideConfirm` prop threads the
trigger from `SettingsContent` back up to the parent where the modal lives.

### 2. ⌘K / Ctrl-K Command Palette

`CommandPalette` (from `app/ui/command-palette.tsx`) is now imported and
rendered inside `DashboardApp`. A `useEffect` registers a document-level
`keydown` listener that opens/closes the palette on ⌘K or Ctrl-K. The
palette is wired to 14 real actions: all 7 workspace tabs, Activity feed,
Settings, Accounts, Strategy Flow, Strategy Studio, Help, Run once, and
Refresh.

### 3. Scheduler status rendered

`RunHistory` now shows a compact status bar at the top (inside the Activity →
Runs tab) that surfaces `snapshot.scheduler.lastRunAt`, `nextRunAt`, and
`runsToday` when the field is populated server-side. Displays "No runs
scheduled yet" when both time fields are null.

### 4. Audit log surfaced + pending-proposals empty state

- New `FeedTab` variant `"audit"` and corresponding `AuditLog` component
  render `snapshot.auditFeed` inside the Activity slide-over under a new
  "Audit Log" tab. Shows title, detail, timestamp, and optional symbol/company.
- `DecisionView` now renders an explicit empty state card when
  `pendingProposals.length === 0` AND the system is in `propose` mode AND
  running — matching the existing positions/scan/runs empty-state pattern.

### 5. pending-learned-change SSE push (end-to-end)

- `DashboardEventType` in `src/lib/events.ts` gains `"pending-learned-change"`.
- `src/lib/learned-context/store.ts` imports `emitDashboardEvent` and emits
  the new event type (userId-scoped) immediately after `insertPendingLearnedContext`.
- `DashboardApp`'s SSE effect now listens for `"pending-learned-change"` and
  re-fetches `/api/learned-context/pending` to refresh the badge count in real
  time, eliminating the mount-only poll gap.

## Files touched

- `app/dashboard-client.tsx`
- `app/ui/command-palette.tsx` (unchanged — only imported)
- `src/lib/events.ts`
- `src/lib/learned-context/store.ts`
- `docs/rollouts/2026-06-22-dashboard-quickwins.md` (this file)

## Verification

```
npx tsc --noEmit   → 0 errors
npm test           → 772 passed (85 files)
npm run build      → ✓ Compiled successfully in 4.4s
```

## Follow-ups

- The pending-proposals empty state only shows in `propose` mode while
  running. A future pass could also show it when the system is halted, with
  a hint to start it.
- The command palette currently has no keyboard shortcut hint in the header
  bar. A small `⌘K` `kbd` element near the right utilities could aid
  discoverability.
- The audit log renders up to 100 items. For high-volume installs a paginated
  or virtualized list may be needed.
