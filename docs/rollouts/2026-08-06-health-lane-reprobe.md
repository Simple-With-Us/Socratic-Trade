# 2026-08-06 — Automatic re-probe of STOPPED API health lanes

## Context & Objective

Owner: red **STOPPED** Connections lanes correctly raise attention, but the app
must not leave them dead forever until a human/agent intervenes. Retry at least
every 3–6 hours, or at a known vendor quota reset (daily AV midnight, Retry-After).

## Changes Made

- **`src/lib/health-lane-reprobe.ts`**
  - Scheduler-driven re-probe of every non-retired `stoppedWorking` health lane.
  - Default interval **4h** (`HEALTH_LANE_REPROBE_INTERVAL_HOURS`, clamped 3–6).
  - If last error encodes a known unavailability (`Retry-After`, `25/day`, `until=ISO`),
    wait until that instant instead of hammering.
  - **Open window**: soften last 5 hard-failure log rows with
    `[expected-limit] reprobe-window@…` so consecutive-failure STOPPED lifts and the
    enrichment circuit breaker can try again.
  - **Live probe** for known keyless/ops services: nasdaq-quote, nasdaq-calendar,
    yahoo-finance, vix-yahoo, vix-cboe, usage-monitor — logs real successes via
    `logApiHealth`.
  - Intentionally skips FMP/Quiver/UW retired lanes.
  - Kill-switch: `HEALTH_LANE_REPROBE_ENABLED=off`.
  - Tick admission ≥30m; per-lane next-due in internal settings.
  - Audits `health_lane_reprobe` when any lane is acted on.

- **`src/lib/scheduler.ts`**: journal lane `health-lane-reprobe` each tick.

- **Tests**: `test/health-lane-reprobe.test.ts`.

## Verification

```bash
npx vitest run test/health-lane-reprobe.test.ts
npx tsc --noEmit
```

## Notes

- Soft “active this hour / no success” stops still clear naturally; this lane mainly
  fixes **hard consecutive failure** red STOPPED.
- Dead RapidAPI 403 products will re-probe every 4h (cheap) but stay soft/degraded
  until access returns — not silently marked healthy.
