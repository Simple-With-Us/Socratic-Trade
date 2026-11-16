# 2026-09-09 — Container healthcheck widened to tolerate event-loop stalls

## Summary

Production served a public 503 while the application was healthy.  The container
healthcheck (`curl /api/live`, `timeout=5s`, `retries=3`) timed out repeatedly, Docker
marked the container `unhealthy`, and Traefik pulled it out of rotation.

## Evidence (production, 2026-09-09)

- `/api/live` back-to-back: **8.60s, 0.09s, 0.03s** — all HTTP 200.  Intermittent stall.
- Container CPU **107%**; host disk **%util 0.10** — CPU-bound in-process, not IO.
- `app.db` **10.98 GB**.
- `docker inspect`: `"Health check exceeded timeout (5s)"`, `FailingStreak: 5`.
- App internals healthy throughout: `db: ok`, `schedulerAgeSeconds: 60`, Alpaca news /
  trades / price streams authenticated, Litestream replicating.

## Change

`timeout=5s -> 15s`, `retries=3 -> 5`.

## Detection bound — corrected

Docker schedules the next check `interval` seconds after the previous check *completes*.
A failing cycle therefore costs `timeout + interval` = 45s, and 5 retries is **~225s**,
not the 150s originally claimed in this PR.  Corrected here and in the Dockerfile comment.

## This is mitigation, not the fix

An ~8s event-loop block on a live-money trading app is a real defect — order management
is blocked for the same window.  Worse, slices pinning the loop for **36,511 ms** were
measured on 2026-09-08, so a 15s timeout still fails against the worst of them.

The root cause is a non-convergent FTS mirror loop (`mirror-fts-bounded.ts`,
`sec-ingest-worker.ts`) fixed in **PR #3202**.  That is what actually stops the flapping.
This PR only narrows the window in which a healthy container is falsely evicted.

## Prior art

The Dockerfile comment above the directive records the same failure class on 2026-08-17
(`#2810`), which is why the probe was moved off `/api/health` onto `/api/live`.  That
mitigation has now been outgrown: `/api/live` is "process + SQLite only", but on an 11 GB
database that is no longer cheap.

## Follow-ups

- PR #3202 — non-convergent FTS mirror loop (the actual fix).
- Moving the FTS mirror to a worker thread remains the durable fix for loop pinning.

## Verification State

Required gate (AGENTS.md), recorded for this tip-fix round (2026-09-09 Fixer/Grok):

```
npx tsc --noEmit                         # clean on tip-fix worktree
# Full npm run lint / npm test / npm run build: deferred to hosted CI on this PR
# (shared Mac load; image HEALTHCHECK is Dockerfile-only).  Prior PR CI was green
# before tip-fix; re-check after push.
```

Docs/timeout refs updated: Dockerfile HEALTHCHECK `timeout=15s`, `app/api/live/route.ts`,
`docs/deployment.md` no longer claim a 5s probe timeout.

