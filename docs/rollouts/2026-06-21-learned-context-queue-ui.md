# 2026-06-21 — Learned-context confirmation queue UI

## Summary

Added a "Pending Learned Changes" surface to the dashboard that lets users review,
approve, or reject risk-tier candidates queued by the autonomous agent before they
influence the AI. The backend API (routes + db helpers) already existed; this is
UI-only.

## What changed

### New files
- `app/ui/learned-context-queue.tsx` — `LearnedContextQueue` (SlideOver panel with
  item cards, loading/empty/error states, approve/reject actions) and
  `LearnedContextQueueBadge` (count badge trigger button, hidden when count is 0).
- `src/lib/learned-context-queue-helpers.ts` — pure helper functions (`tierTone`,
  `tierLabel`, `formatStrategyDirectiveBlock`, `relativeDate`).
- `test/learned-context-queue-ui.test.ts` — 13 unit tests covering all four helpers.
- `docs/rollouts/2026-06-21-learned-context-queue-ui.md` — this file.

### Modified files
- `app/dashboard-client.tsx` — imports + wires in:
  - `learnedQueueOpen` / `learnedQueueCount` state.
  - `<LearnedContextQueueBadge>` button inserted in the header action row (between
    the Activity button and the Flow button), visible only when `learnedQueueCount > 0`.
  - `<LearnedContextQueue>` SlideOver in the overlays section.
  - `useEffect` on mount to seed the badge count from `GET /api/learned-context/pending`.

## IA location

The entry point is a badge/button in the existing header action row, between Activity
and Flow — the same strip where trade-approval badges live. The button shows a blue
count badge and a brain icon. When count is 0 the button is hidden entirely, so it
does not add visual clutter in the nominal (no pending items) case.

## Approve confirm

Approve goes through a `Modal`-based confirm dialog (not a single click). The modal
shows:

- **strategy-directive** items: a `<pre>` block rendering the exact
  `<!-- AI-LEARNED id date --> / value / <!-- /AI-LEARNED -->` text that will be
  appended, plus a note that the existing prompt is preserved.
- **risk** items: a plain warning that advisory promotion does NOT change numeric risk
  limits.

The Cancel / Approve buttons follow the existing `ConfirmModal` footer style (ghost
cancel, accent confirm). The confirm button is disabled while `actionBusy` is true
to prevent double-submission.

## Reject

Reject is a single click (no confirm required) per the spec — it only discards the
candidate without any state change in the live system.

## JSON field mapping

Confirmed via `src/lib/db.ts` `mapLearnedContextPending`: the API returns camelCase
(`riskTier`, `classifierReason`, `createdAt`) because the raw DB snake_case is mapped
before the route serialises to JSON.

## Decisions

- Used `Modal` directly (not `ConfirmModal`) for the approve confirm so the
  strategy-directive preview can render in a `<pre>` block rather than a string
  wrapped in `<p>`.
- Badge uses `bg-info` (blue) rather than `bg-warn` (amber) to distinguish learned-
  context queue items from pending trade approvals which already use `bg-warn`.
- Initial count is seeded on mount via a lightweight separate fetch so the badge
  appears even before the user opens the SlideOver.
- Re-fetch happens on every SlideOver open (detected via `open && !lastOpen` edge) to
  stay fresh without a polling interval.

## Verification

```bash
cd /Users/jay/apps/wt-queueui && npx tsc --noEmit   # clean
cd /Users/jay/apps/wt-queueui && npm test            # 723/723 pass (13 new)
cd /Users/jay/apps/wt-queueui && npm run build       # clean, all routes compiled
```

## Follow-ups / risks

- The badge count is seeded once on mount and updated only via `onCountChange`
  callbacks from the SlideOver. A background SSE event for `learned-context` could
  keep the count fresher if the agent is running autonomously; deferred for now since
  the 2-minute fallback poll will pick it up.
- No pagination — the GET returns all pending rows. If a user accumulates many pending
  items the list may get long; virtual scrolling or pagination is a future enhancement.
- The approve confirm shows the full raw `value` string inside a `<pre>` block without
  character-length truncation. Extremely long directive values may overflow the modal
  on very small screens; the `whitespace-pre-wrap break-words` CSS handles it but the
  UX degrades gracefully rather than being fully resolved.
