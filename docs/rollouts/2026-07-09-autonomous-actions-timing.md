# 2026-07-09 — Autonomous actions: relative timestamps top-right (MONET)

## Summary

Owner request: the Home page's "Autonomous actions" rows should show relative
timing in the top right ("15m ago", "1d ago"), like Journal entries do.

Each decision row now renders the shared `Ago` primitive (relative time,
exact timestamp on hover — the console's standing timestamp rule) at the top
of its right column, in the same faint/xs treatment the Journal feed uses.

## Mechanics (all in `app/console/page.tsx`)

- `DecisionRowData` gains `at?: string` (ISO timestamp).
- All three row sources wire it: `decisionFromSocratic` ←
  `SocraticDecisionCase.createdAt`; `decisionFromProposal` gains an `at` param
  ← the run's `StrategyDecision.createdAt`; `decisionFromPending` ←
  `PendingProposal.createdAt`.
- `DecisionRow` renders `<Ago iso={row.at} />` first in the right column
  (above size / conf / Trace), only when a timestamp exists — rows with no
  known time show nothing rather than a dash.

## Verification

- `npm run lint` 0 errors; `npx tsc --noEmit` clean; `npm test` 3168 passed
  (306 files); `npm run build` OK (run standalone — the first combined run hit
  the 10-min window under peer-build host contention, not a failure).
- Live dev-server: injected a pending proposal with `createdAt` 15 minutes ago
  into the dashboard payload (fetch intercept + visibilitychange-triggered
  refresh, since the dev DB has no actions) — the row rendered **"15m ago"**
  top-right above the notional/confidence, `<time dateTime>` correct,
  screenshot-confirmed placement matches the Journal treatment.

## Files

- `app/console/page.tsx`
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Follow-ups

- None.
