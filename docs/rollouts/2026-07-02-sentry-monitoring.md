# 2026-07-02 — Sentry monitoring: scheduler Crons heartbeat + inert-by-default test (Claude, `claude/sentry-monitoring`)

## Summary
Completed the Sentry (@sentry/nextjs) integration for the App Router app. Most of it already
landed earlier: server/edge init + `onRequestError` (`instrumentation.ts`, 2026-06-19 era) and
the browser init / `global-error.tsx` / `withSentryConfig` build wrapper
(`docs/rollouts/2026-06-29-sentry-browser-and-build-wrapper.md`). This change adds the one
missing piece — a **Sentry Crons heartbeat for the scheduler** — plus a regression test that
pins the whole integration as inert when no Sentry env vars are set, and documents the new
`SENTRY_CRONS_ENABLED` env var.

Everything remains OFF unless env vars are present, so this is safe to merge before the owner
creates/configures the Sentry project.

## Why
Confirmed monitoring gap: a dead/hung scheduler still returns 200 from `/api/health` (the
route is alive even when the 60s tick loop is not), so autonomy and the synthetic-stop monitor
can silently stop running with no external alert. The existing `scheduler:lastTick` internal
setting only helps if something reads it. A Sentry Crons monitor is a true dead-man's-switch:
the tick reports "ok" every minute and Sentry alerts when check-ins stop arriving.

## What was already in place (no changes needed)
- `instrumentation.ts` — `register()` loads `sentry.server.config.ts` / `sentry.edge.config.ts`
  only when `SENTRY_DSN` is set; `onRequestError` → `Sentry.captureRequestError`, gated the same.
- `instrumentation-client.ts` — browser `Sentry.init` gated on `NEXT_PUBLIC_SENTRY_DSN`,
  traces rate from env (default 0.1), replay OFF by default, `sendDefaultPii: false`,
  `redactForTelemetry` on every event.
- `app/global-error.tsx` — `Sentry.captureException(error)` + plain fallback UI.
- `next.config.mjs` — `withSentryConfig` wrapper; source-map upload only runs when
  `SENTRY_AUTH_TOKEN` is set (org/project from `SENTRY_ORG`/`SENTRY_PROJECT`, defaults
  `jays-services`/`agentic-trading`); build verified green with no Sentry env.
- `@sentry/nextjs@^10.60.0` already in `package.json` dependencies (installed 10.60.0) —
  no `npm install` was needed.

## Files (this change)
- `src/lib/scheduler.ts` — **additive only.** New exported
  `sendSentrySchedulerCheckIn()` + `SENTRY_CRON_MONITOR_SLUG = "scheduler-tick"`: sends
  `Sentry.captureCheckIn({ monitorSlug: "scheduler-tick", status: "ok" }, <upsert config>)`
  once per tick. Gated on `SENTRY_DSN` && `SENTRY_CRONS_ENABLED === "1"`; whole body
  try/catch-wrapped (console.error only) so monitoring can never break trading. Called
  fire-and-forget in `tick()` **after** the single-leader gate, so on multi-process deploys
  only the process actually running the tick body checks in (idle followers can't mask a dead
  leader). Interop note baked into the code: `@sentry/nextjs`'s CJS exports can surface on
  `.default` under raw Node ESM, so the function resolves `captureCheckIn` defensively and
  silently skips if unavailable. The upsert monitor config auto-creates the monitor on first
  check-in (interval 1 minute, `checkinMargin` 5, `maxRuntime` 10, UTC).
- `test/sentry-inert.test.ts` — NEW, 9 tests: `register()` resolves without throwing (no
  runtime + edge runtime), `onRequestError` no-op without DSN, scheduler module import +
  `getSchedulerState`/`reconcileAutonomyOnBoot` work with zero Sentry env, check-in no-op with
  zero/partial env, check-in fires with slug `scheduler-tick` when both gates set (mocked SDK),
  check-in never throws when the SDK call fails, `onRequestError` forwards args when DSN set.
  Uses a `vi.mock("@sentry/nextjs")` whose factory flips an `imported` flag, proving the
  disabled paths never even load the SDK module.
- `.env.example` — added `SENTRY_CRONS_ENABLED=` with comment (all other Sentry vars —
  `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`,
  `SENTRY_TRACES_SAMPLE_RATE` — were already documented in the Sentry block).
- `docs/ops-observability-security.md` — new "Sentry Crons scheduler heartbeat" bullet +
  production-notes line for `SENTRY_CRONS_ENABLED`.
- `STATUS.md` — top entry.
- `docs/rollouts/2026-07-02-sentry-monitoring.md` — this note.

## Verification (all run with NO Sentry env vars set)
- `npx tsc --noEmit` — clean. (First run failed on stale `.next/dev/types` referencing the
  previous branch's `app/console/*` pages — the known CLAUDE.md trap; fixed by `npm run build`
  + removing the leftover `.next/dev` dev-server artifact, then clean.)
- `npm run lint` — 0 errors (279 grandfathered warnings).
- `npm test` — 233 files / 2215 tests passed (includes the 9 new sentry-inert tests).
- `npm run build` — green with `env -u SENTRY_DSN -u NEXT_PUBLIC_SENTRY_DSN -u SENTRY_AUTH_TOKEN
  -u SENTRY_ORG -u SENTRY_PROJECT -u SENTRY_CRONS_ENABLED`.
- `npx vitest run test/sentry-inert.test.ts` — 9/9 passed.

## Owner setup steps (activation — nothing works until these are done)
1. **Create the Sentry project** (org `jays-services`, project `agentic-trading` to match the
   `next.config.mjs` defaults, platform "Next.js") and copy its DSN.
2. **Set the DSN envs on prod** (Infisical / `.env.local` on trading-live):
   `SENTRY_DSN=<dsn>` and `NEXT_PUBLIC_SENTRY_DSN=<same dsn>`. `NEXT_PUBLIC_*` is inlined at
   build time — set it **before** `next build`/`build:secrets`, then rebuild + `pm2 restart trading`.
3. **Enable the scheduler heartbeat**: set `SENTRY_CRONS_ENABLED=1`. The `scheduler-tick`
   monitor is auto-created (upsert) on the first check-in; alternatively create it manually in
   Sentry → Crons with schedule type *interval, every 1 minute*. Then configure an alert on
   missed check-ins for that monitor.
4. **Optional — source maps**: create an internal auth token (scope `project:releases` /
   sourcemap upload), set `SENTRY_AUTH_TOKEN` as a build-time secret in Infisical; upload runs
   automatically on the next build. Without it the wrapper is inert.
5. Optional tuning: `SENTRY_ENVIRONMENT`/`NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default NODE_ENV),
   `SENTRY_TRACES_SAMPLE_RATE`/`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (default 0.1), Session
   Replay via `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true` (masked; off by default).

## Follow-ups / risks
- The heartbeat sends ~1440 check-ins/day when armed — well within Sentry's Crons quota for a
  single monitor, but worth knowing before arming more monitors.
- If `SCHEDULER_SINGLE_LEADER=1` is ever enabled in prod, the check-in correctly follows the
  lease holder; a total lease outage (e.g. DB failure) also stops check-ins, which is the
  desired alert condition.
- Sentry Crons alone doesn't restart anything — it alerts. PM2 remains the supervisor.
