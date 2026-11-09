# 2026-08-13 — Usage-monitor lane: drop live 409 collisions + probe the real health paths

## Summary

Peer App Health stayed Degraded while Usage Monitor was healthy.  Two ST bugs:

1. Live telemetry flush retried a 409 idempotency collision forever.  The
   durable replay lane already skips the named key; the live queue re-queued the
   whole remaining batch, so one poison row produced 36 repeats of the same key
   in two hours and tripped the last-5-failed STOPPED rule.
2. The keyless re-probe hit `/health` then `/`, both of which 307 to the login
   HTML.  Real JSON is at `/api/ready` and `/api/health`.

FilingAPI HTTP 401 (last-resort scarce env key) is a separate last-resort
problem and is filtered on the Usage Monitor card, not here.

## Files changed

- `src/lib/usage-monitor-push.ts` — live flush drops the monitor-named collision
  key, does not trip the outage breaker, treats 409 as a healthy receiver.
- `src/lib/health-lane-reprobe.ts` — probe `/api/ready` then `/api/health`,
  `redirect: "manual"`.
- `test/usage-monitor-push.test.ts`, `test/health-lane-reprobe.test.ts`.

## Verification

- Focused vitest: `usage-monitor-push` + `health-lane-reprobe`.
- After deploy: ST `/api/health` `dependencies["usage-monitor"].ok` should
  return to true once a successful (or collision-acked) flush lands.  UM
  `/api/ready` stays 200 throughout.

## Follow-ups

- FilingAPI env key still 401s at filingapi.dev.  Last-resort only; do not mint
  a replacement without owner sign-off.
