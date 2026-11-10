# Phase 6 - Customization, Risk Rules, Notifications

## Goals

- Add named strategy profiles.
- Persist policy JSON, prompt text, scoring weights, and active profile selection.
- Enforce deterministic risk rules in code.
- Send configured notifications and audit notification outcomes.

## Profiles

Each `StrategyProfile` stores:

- id, name, created/updated timestamps
- policy snapshot
- prompt text
- scoring weights
- active flag

The existing global policy and prompt are migrated into a default profile.
`strategy_profiles` carries a `user_id` column added via the `migrate()` backfill
in `src/lib/db.ts` (same pattern as other per-user tables).

## Risk Rules

As of 2026-07-13, daily opening spend is an explicit either/or control:
`maxDailyPctOfNav` (20% default) or `maxDailyNotional`. The selected mode is normalized on web,
mobile, profile, and AI-review writes, then resolved once through `src/lib/policy-caps.ts` for
strategy generation, deterministic review, broker-minimum bumps, approval-time rechecks, and UI
utilization. Migration v26 changes only the exact former $500 product default to 20% NAV; other
dollar values remain owner-selected dollar mode.

iOS Guardrails (owner cut 2026-08-17) edits the same exclusive caps in either
direction: Ask-First ↔ Autopilot, raise or lower notional, and edit or switch
the binding % of NAV cap.  Returning to Autopilot types `AUTOPILOT`.  Raising a
cap or switching modes on a live account types `CONFIRM` when typed-confirm is
on.  IRA / Roth tax cards show same-account wash sales as not applicable and do
not render the taxable Wash-Sale Guard as On.  User-facing iOS copy is ordinary
  app language: `__rotate__` reads as lowercase “rotate models”; route names,
command types, SSE/APNs, and console-only notes stay out of the UI.

Included-index storage slugs (`sp500`, `nasdaqComposite`, …) stay on
`IndexUniverse` / `includedIndices`.  Every user-facing Indices surface
(Guardrails selected-set and checkbox grid, policy-diff, Scan
`${id}-universe` chips, iOS Guardrails, Desk Current Policy) uses
`indexUniverseLabel` / `formatIndexUniverseList` /
`DeskCopy.joinedIndexList` (`S&P 500`, `Nasdaq Composite`, `Dow 30`,
`NYSE Composite`, …).  Snapshot / API payloads are unchanged.  iOS empty-universe
copy uses that same `S&P 500` example and points at Guardrails (web's
`/console/guardrails`), not a Strategy page the phone does not have.

Policy enforcement includes:

- sector exposure caps for buys
- stop-loss protection for adding to losing positions
- take-profit protection for adding to extended winners
- trailing stop enforcement via the synthetic-stops engine (`src/lib/synthetic-stops.ts`)

## External health paging (2026-08-18)

`/api/health` HTTP 200/503 is process liveness only (DB + pinecone /
alpaca-broker hard-stops).  UptimeRobot/Pushover must page on JSON
`schedulerStale`, `tradingLiveness.degraded`, and `litestreamTiersDegraded`
instead of treating those flags as 503.  Runbook:
`docs/runbooks/uptime-health-json-monitors.md`.

## Notifications

Supported events:

- fill
- block
- run_failed
- pending_approval
- kill_switch

Multi-channel delivery is implemented (`src/lib/notify.ts`, ported from Atlas):
phone push (ntfy / Pushover), **native iOS APNs** (`src/lib/apns.ts`, device
registry + `POST /api/mobile/push/register`), webhook, email (Resend), and SMS
(Twilio). Each channel is independently gated — disabled unless admin config is
present AND the user has a matching target. APNs stays silent ("not configured")
until `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_P8` are set in
Infisical — do not invent those secrets. No configured channel means the event
is audited as skipped, not failed.

Legacy strategy/feed events still call `sendNotification(...)` so the
`notification_events` table and Activity feed semantics stay intact. That legacy
path now also mirrors enabled events into direct delivery for email/push/SMS
(and direct webhook only when a legacy policy webhook is not already configured),
skipping `price_alert` and `provider_degraded` because those flows already call
the direct dispatcher explicitly.

## Repeat lock (2026-08-20)

`sendNotification` suppresses a second *delivery* of the same fingerprint within
a window, using `notification_events` rows with `status='sent'` only (skipped or
failed never latch):

- `block` / `pending_approval`: existing 6h situation fingerprint (symbol, side,
  digit-normalized reason). Override via `NOTIFICATION_REPEAT_DEDUP_MS`.
- `price_alert`: 60s default, fingerprint `price_alert|{alert.id}` so two rules
  on the same symbol both fire. Same env override.
- `provider_degraded` / `budget_alert` / `kill_switch`: 60s same-fingerprint lock
  so a still-true condition cannot page twice in one scheduler tick.

Health / usage-limit still keep their longer existing cooldowns (6h). Those
callers no longer re-send the same payload on a channel `sendNotification`
already has in prefs (Pushover-twice-in-one-minute). Usage-limit writes its 6h
watermark only after a `sent` user delivery or a successful operator fallback.

## Acceptance

- Active profile controls policy and prompt used by strategy runs.
- Dashboard can switch profiles and update profile-backed policy fields.
- Risk-rule blocks include clear reasons.
- Legacy strategy/feed notifications are stored in `notification_events`; direct
  channel delivery is mirrored in audit events (`notify.sent` / `notify.error`).
- The same alert fingerprint is not delivered more than once per 60s
  (`price_alert` by id; other lock types by stable payload identity).
- Users can reopen later notifications (time, title/body, read) on the website
  header inbox + Activity Alerts Center, and on iOS Activity → Alerts Center.
  Same `notification_events` rows; last 100; mark-as-read uses `/api/notifications/ack`.
- Activity tabs (website and iOS, 2026-08-21) are Alerts Center, Notifications,
  Strategy Runs, Order Fills, Audit Log.  Default is Alerts Center.  The former
  All unified feed is Audit Log (`?tab=all` still opens it).  Failed strategy
  runs show a wrapping plain-English reason, not the delivery chip ("Sent") and
  not raw JSON.
- Native iOS push is included whenever APNs is configured and the user has a
  live device token, even if `prefs.channels` omitted `apns`.  System-wide
  connection and storage alerts fan out to every administrator; Pushover/email
  remain last-resort extra delivery when no admin has a live device.
