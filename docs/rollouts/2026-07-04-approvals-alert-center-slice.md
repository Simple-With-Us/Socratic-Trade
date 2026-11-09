# 2026-07-04 — Approvals triage upgrades + alert center focused slice

## Summary

Implemented a narrow issue #470 slice in the Codex approvals lane:

- `/console/approvals` now supports search, opening-vs-exit filter, paper-vs-live filter, sort
  by newest/confidence/notional/drift, visible-row multi-select, bulk reject, and safe non-LIVE
  bulk approve via the existing per-item proposal endpoints.
- Added a reusable console alert-center surface backed by existing notification snapshot data,
  with summary buckets, search, account scoping, and better notification display text.
- Replaced the old plain Alerts list on `/console/activity` with the full alert-center view and
  added a compact alert-center panel to `/console/approvals`.
- Widened dashboard notification history from 50 to 100 rows so the alert center has enough
  recent context without adding a new backend store or route.

## Why

The expert-review / backlog row called out two operational gaps on the decision rail:

1. Approvals was a flat scroll of receipt cards with no triage when several proposals arrived.
2. Alerting lived as raw notification rows instead of a persistent operator-facing alert center.

This slice improves operator throughput without widening scope into LIVE bulk confirmations,
settings refactors, keyboard shortcuts, or unrelated console conversions.

## Files

- `app/console/approvals/page.tsx`
- `app/console/approvals/triage.ts`
- `app/console/components/alert-center.tsx`
- `app/console/activity/page.tsx`
- `src/lib/dashboard.ts`
- `test/approvals-triage-model.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## Verification

Ran in `/Users/jay/.codex/worktrees/socratic-approvals-alert-center` after `npm ci`.

```bash
npm ci
./node_modules/.bin/tsc --noEmit
npm test -- test/approvals-triage-model.test.ts test/dashboard-feed.test.ts
npm test
npm run lint
npm run build
```

Notable results:

- `./node_modules/.bin/tsc --noEmit` passed.
- Focused tests passed: `2` files / `24` tests.
- Full `npm test` passed: `255` files / `2467` tests.
- `npm run lint` passed with `0` errors and the repo's existing warning backlog (`311` warnings).
- `npm run build` passed with the existing Next middleware deprecation warning and the known
  Edge-runtime warning from the Sentry/Next import chain.

## Follow-ups

- LIVE proposals still require individual typed-confirm approval; bulk LIVE confirmation was
  intentionally left out of this slice.
- The broader "unified owner inbox" row (trade approvals + learned context + framework proposals +
  escalations) is still open.
- Keyboard triage / hotkeys and richer portfolio-preview aggregation were not attempted here.
