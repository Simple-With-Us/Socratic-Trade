# 2026-08-05 — Health critical-lane: env hard-stop must not 503 when user keys work

## Context & Objective

After merging open PRs (#2490/#2503/#2505/#2510), Coolify auto-deploys built images
(`socratic-app:c4df7024…`) but **rolled back every attempt**: new container healthcheck
got HTTP 503 on `/api/health` → "New container is not healthy, rolling back".

Live remained on stale `150b17c9` for hours while `origin/main` was at `c4df7024`.

## Root cause

1. Coolify healthcheck: `GET /api/health` must return **200**.
2. `/api/health` returns **503** when `ok: false`.
3. `ok` was false because critical service `alpaca-broker` had a hard-stopped **env**
   lane (5× 401 from bad Infisical env keys around 13:53Z).
4. Prod trading uses **user** Connections keys (`key_source=user`) which were healthy
   (hundreds of ok=1 in the same window) — but the public health aggregator only folds
   `env`/`none` lanes into `dependencies` and 503 logic, so user success never cleared
   the 503.

## Fix

In `app/api/health/route.ts`: treat a critical dependency as OK for liveness when **any**
configured lane (`env` or `user`) is not hard-stopped. Env hard-stop with a healthy user
lane is reported as `degraded: true` (operators still see Infisical key is bad) without
503ing deploys.

## Verification

- `npx vitest run test/connection-health-routing.test.ts test/health-route-exposure.test.ts`
- New regression: env hard-stop + user healthy → 200.

## Next

- Rotate/remove bad Infisical env Alpaca keys (owner) so env lane stops 401'ing.
- After this lands, Coolify webhook should complete a deploy to current `main`.
