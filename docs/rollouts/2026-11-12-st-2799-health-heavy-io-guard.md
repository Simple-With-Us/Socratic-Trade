# ST-2799 — Guard heavy /api/health I/O

## Context & Objective

`GET /api/health` is public and was doing OpenRouter management fetches, `statfs`, and Litestream IPC/log scans on every cold assemble.  Uptime monitors and anonymous clients could hammer those paths.  This change memoizes the three heavy subsections and applies a fail-open anonymous rate limit that serves cached subsection data instead of recomputing.

## Changes Made

- TTL + single-flight caches for OpenRouter credits, disk `statfs`, and Litestream IPC/log work (`src/lib/health-heavy-probe.ts`).
- `app/api/health/route.ts` wraps only those three call sites; liveness / scheduler-stale / trading-liveness escalation logic is untouched.
- Anonymous per-IP + global limiter (fail-open): over budget → stale heavy sections with `cachedAgeSeconds` / `diskCachedAgeSeconds` / `litestreamCachedAgeSeconds`; always HTTP 200/503 from real `ok`, never 5xx from the limiter.
- Runbook note: container probes must stay on `/api/live` (`docs/runbooks/uptime-health-json-monitors.md`).

**Files**

- `src/lib/health-heavy-probe.ts` (new)
- `src/lib/health-probe-cache.ts`
- `app/api/health/route.ts`
- `test/health-heavy-io-guard.test.ts` (new)
- `test/health-probe-isolation.test.ts`
- `test/health-route-exposure.test.ts`
- `docs/runbooks/uptime-health-json-monitors.md`
- `docs/rollouts/2026-11-12-st-2799-health-heavy-io-guard.md`
- `STATUS.md`

## Decisions & Trade-offs

- Default heavy TTL 20s (`HEALTH_HEAVY_SECTION_TTL_MS`); warm full snapshot TTL unchanged (`HEALTH_SNAPSHOT_TTL_MS`, default 2s).
- Limits default 12/min per IP and 60/min global (`HEALTH_HEAVY_PER_IP_LIMIT`, `HEALTH_HEAVY_GLOBAL_LIMIT`); ops-token view never throttled.
- Storage alerts fire only on fresh Litestream/disk compute, not when serving a cached subsection.
- Review follow-up (PR #5154): anonymous admission is charged only when a heavy section actually recomputes (cold path, lazily, once per request), so warm-snapshot and heavy-cache hits do not consume the budget; the background snapshot refresh always recomputes heavy sections; `CF-Connecting-IP` keys the per-IP bucket only under `REQUIRE_CLOUDFLARE_ORIGIN` with the origin trust marker, otherwise all anonymous callers share one bucket; disk/WAL `storageDegraded` is computed in the disk heavy section; OpenRouter credits cache merges live `dependencies.openrouter` each request; heavy section map is pinned on `globalThis`.
- **Infra unchanged:** Docker/Coolify already probe `/api/live` (`Dockerfile` `HEALTHCHECK`).  UptimeRobot keyword monitors may remain on `/api/health` for JSON flags.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/health-heavy-io-guard.test.ts test/health-probe-isolation.test.ts
npm test
npm run build
```

## Next Steps & Blockers

- Merge after `verify` green and Kody review.  No deploy action from agent.

## Zero-Code Findings

| Monitor / script | URL | Note |
| --- | --- | --- |
| `Dockerfile` HEALTHCHECK | `GET /api/live` | Correct cheap probe |
| UptimeRobot HTTP + keyword monitors | `https://socratictrade.com/api/health` | Rich JSON; keep for flags, not container restarts |
| `scripts/verify-deploy-sha.sh` / deploy verify skill | may curl `/api/health` | Credential-less deploy checks; benefits from caching |
| Coolify app health path | should be `/api/live` per `AGENTS.md` | Not changed in repo |
