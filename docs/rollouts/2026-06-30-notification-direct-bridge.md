# Notification Direct Delivery Bridge

## Summary

Legacy strategy notifications now bridge into the direct notification dispatcher
so operational events can reach enabled email/push/SMS channels, not only the
legacy policy webhook path.

## Why

Production email delivery was enabled for `notification_prefs`, and test sends
worked for push + email. Recent fill/block rows still showed
`Notifications Webhook Not Configured` because those events use
`src/lib/notifications.ts` and never called `src/lib/notify.ts`.

## Files

- `src/lib/notifications.ts`
- `test/persistence-notification.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/rollouts/2026-06-30-notification-direct-bridge.md`

## Verification

- `npm test -- test/persistence-notification.test.ts -t "bridges legacy notification events to direct email delivery"`: pass
- `npm run lint`: pass with existing warning backlog
- `npx tsc --noEmit --pretty false`: pass
- `npm test -- test/persistence-notification.test.ts test/strategy-tuning.test.ts`: pass, 31/31
- `npm test`: pass, 159 files / 1539 tests
- `npm run build`: pass

Notable false start: `npm test` was first run concurrently with `npm run build`
and produced timing/failure noise in `strategy-tuning.test.ts` and
`persistence-notification.test.ts`. The same files passed when rerun without the
parallel build, and the full suite then passed.

## Follow-ups

- SMS remains disabled in production preferences until Twilio A2P 10DLC
  registration/sender-pool setup is complete; Twilio accepted the API requests
  but returned carrier delivery error `30034`.
- Consider adding Twilio delivery-status callback/polling so app audit logs can
  distinguish Twilio API acceptance from carrier delivery.
