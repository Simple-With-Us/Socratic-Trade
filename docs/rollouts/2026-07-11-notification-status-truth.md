# Truthful Notification Delivery Status

## Summary

Replaces the incomplete, unmerged AG PR #1442 implementation with one truthful delivery
orchestrator. `sendNotification` now owns normal multi-channel delivery for every event type,
including the former separately-delivered `price_alert` and `provider_degraded` paths, so the
persisted event is derived from the deliveries that actually happened.

## Why

The original activity audit found every persisted notification labelled "Not sent" even though
hundreds had reached push/email/SMS. Review of #1442 found four residual gaps: separately-delivered
event types still returned no results, unexpected bridge errors still became skips, partial and
legacy-webhook failures disappeared, and skip reasons remained webhook-specific or raw enum tokens.

## Decisions

- Keep delivery inside the existing enabled-event gate. Callers with richer text pass `directBody`;
  they do not call `notify` separately.
- Status is `sent` when any channel succeeds, with a channel-labelled partial-failure reason when
  another channel fails; `failed` when nothing succeeds and any delivery/bridge fails; and `skipped`
  only when no channels are enabled or every selected channel is unavailable/targetless.
- Persist an aggregate `notification.delivery` receipt. The legacy policy webhook also emits
  `notify.sent` / `notify.error` with `source: legacy_policy_webhook`.
- Keep the operator fallback email as a lazy additional delivery invoked only after event gating and
  only when normal operator preferences do not already contain a usable email target.
- Map historical webhook-only and raw `not_configured` / `no_target` reasons to human UI text.

## Files

- `src/lib/notifications.ts`
- `src/lib/alerts.ts`
- `src/lib/provider-tier.ts`
- `src/lib/vector-db.ts`
- `src/lib/db-health.ts`
- `src/lib/dashboard-ui.ts`
- `test/notification-status-truth.test.ts`
- `test/persistence-notification.test.ts`
- `test/dashboard-feed.test.ts`
- `test/connection-health-routing.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-11-notification-status-truth.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)

## Verification

Node `v24.18.0`:

- `npx vitest run test/notification-status-truth.test.ts test/persistence-notification.test.ts test/notify.test.ts test/dashboard-feed.test.ts test/connection-health-routing.test.ts test/provider-tier.test.ts test/alternative-data.test.ts --reporter=dot` — 7 files / 96 tests passed.
- `npx eslint src/lib/notifications.ts src/lib/alerts.ts src/lib/provider-tier.ts src/lib/vector-db.ts src/lib/db-health.ts src/lib/dashboard-ui.ts test/notification-status-truth.test.ts test/persistence-notification.test.ts test/dashboard-feed.test.ts test/connection-health-routing.test.ts` — 0 errors / 43 inherited warnings.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.
- After strategy PR #1429 merged, `origin/main@0dda52db` merged cleanly. The same Node 24 focused
  7-file / 96-test slice, touched ESLint, TypeScript, and diff-check reran green on that base.
- Root serialized final gate on that base: `npm run lint` passed with 0 errors / 404 inherited
  warnings; `npx tsc --noEmit` passed; `npm test` passed **342 files / 3,816 tests**; and
  `npm run build` passed with only inherited Next middleware, Edge/Sentry, and webpack cache warnings.

The isolated worktree required `npm ci`, followed by `npm rebuild better-sqlite3` under Node 24
because the shell defaulted to Node 26 during dependency installation.

## Follow-ups

- Push a ready replacement PR, close #1442 as superseded only then, land after hosted checks, and
  verify the auto-deployed production release before moving the effort row to Completed/Deployed.
