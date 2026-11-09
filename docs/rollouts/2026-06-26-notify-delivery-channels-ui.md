# 2026-06-26 — Notification delivery-channels UI (email/SMS/push) + Send-test

Branch `feat/notify-delivery-channels-ui` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).

## Why
The new multi-channel notification system (`src/lib/notify.ts` + `notification_prefs`) had a complete
backend AND API (`GET/POST /api/notifications`, `POST /api/notifications/test`) but **no UI** — the
Settings → Notifications screen only edited the LEGACY `policy.notificationSettings` webhook. So even
with `RESEND_API_KEY` configured, price-alert/event notifications sent nothing through the new path,
because `notification_prefs.channels` was always empty with no way to set it. This adds the missing UI.

## What
- NEW `app/ui/delivery-channels.tsx` — `DeliveryChannelsPanel`:
  - Loads `GET /api/notifications` → channel descriptors (with `available` = operator configured the
    provider key) + the user's current prefs.
  - Per channel (push/webhook/email/sms): a toggle (disabled + "not configured" when the operator
    hasn't set the provider key) and the target input (email / phone / ntfy-or-Pushover target /
    webhook URL), using the descriptor's `targetField`/`targetLabel`/`placeholder`/`hint`.
  - **Save channels** → `POST /api/notifications`.
  - **Send test** → saves, then `POST /api/notifications/test`; shows per-channel results
    (sent / skipped:not_configured / skipped:no_target / failed).
- `app/dashboard-client.tsx` — render the panel in Settings → Notifications under a "Direct delivery
  (email · SMS · push)" heading, below the legacy webhook block.

No backend changes — the API + `notify.ts` channel implementations already existed.

## Operator setup (NOT done in code — secrets stay out of the repo/chat)
- **Email (Resend)** — already configured (`RESEND_API_KEY` + `NOTIFY_EMAIL_FROM`). Email shows
  "available"; the user enables Email + enters their address + Send test.
- **SMS (Twilio)** — set in Infisical (NOT in chat): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM` (the Twilio sending number), then restart so `start:secrets` injects them. SMS then
  shows "available"; the user enables SMS + enters their mobile + Send test. (The personal phone is
  entered in the app UI, never in chat.)
- **Push (ntfy)** — free: leave `NOTIFY_PUSH_PROVIDER` default (ntfy); the user enters an ntfy topic.

## Verification
- `npx tsc --noEmit` clean · `npm test` 1254 passing · `npm run build` clean.
- Live (throwaway `next dev -p 4199`): `GET /api/notifications` returns channels with availability
  (push/webhook true; email/sms false on this keyless host); `POST /api/notifications {channels:["email"],
  email:…}` saves; `POST /api/notifications/test` returns `[{channel:"email", ok:false,
  skipped:"not_configured"}]` (correct — no Resend key here); dashboard `GET /` 200. On the operator's
  box email is configured, so Email shows available and Send test delivers.

## Follow-ups
- No automated UI test (repo's oxc transformer can't transform an imported `.tsx` in vitest; consistent
  with the prior Markdown component decision) — covered by build + live API checks.
