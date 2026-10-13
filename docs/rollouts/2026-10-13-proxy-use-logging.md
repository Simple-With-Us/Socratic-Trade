# 2026-10-13 — Per-request proxy-use logging + public `GET /api/proxy-use`

## Context & Objective

Socratic.Trade routes provider/market-data traffic through the Mango residential
proxy (`http://10.99.0.2:8888` on the WireGuard mesh) via `dataSourceFetch`.
After a trading-proxy miss, the owner wanted to be able to name the hop: a VM
watchdog (2-minute cadence) needs to read whether recent trading/provider
traffic actually went through the proxy, and whether the Mango is reachable
from the Coolify host (where the app runs).

## Changes Made

Pure additive telemetry — no request behavior, timeouts, or error handling
changed:

- `src/lib/proxy-use-log.ts` (new): dependency-free, server-only in-memory
  ring buffer of the last 100 proxy-use decisions. Exports
  `recordProxyUse(entry)` and `getProxyUseSnapshot()` returning
  `{ latest, lastHour: { proxied, direct, fallbacks }, total }`. Entries carry
  host:port only — userinfo (credentials) is stripped by `safeProxyHostForLog`.
- `src/lib/data-source-fetch.ts`: `recordProxyUse` hooked at every exit path —
  excluded service → `usedProxy:false, source:"none"`; internal target →
  `usedProxy:false, source:"none"`; no proxyUrl → `usedProxy:false` with the
  resolution source; proxied attempt → `usedProxy:true` with source + host;
  fail_soft fallback to direct → a SECOND entry `usedProxy:false,
  fallback:true` so fallbacks are visible, not silent.
- `app/api/proxy-use/route.ts` (new): public (no auth) `GET /api/proxy-use`
  returning `{ ok: true, snapshot, mango: { host, reachable, latencyMs,
  checkedAt } }`. The `mango` probe TCP-connects to the effective proxy
  host:port (default the Mango at 10.99.0.2:8888) with a 3s timeout, cached
  60s module-level so the 2-minute watchdog never hammers it. Never throws —
  probe errors return `reachable:false`.
- `middleware.ts`: added `/api/proxy-use` to `PUBLIC_PREFIXES` — the edge auth
  gate 401s `/api/*` otherwise, and the watchdog polls anonymously. Safe: only
  aggregate counts, latest host:port, and a reachability boolean.
- `test/proxy-use-log.test.ts` (new): 6 tests — empty snapshot, latest-entry
  fields, fallback counting, 1-hour window exclusion, 100-entry ring cap,
  never-throws.

## Decisions & Trade-offs

- No new dependencies. Ring is per-process memory (container-local); the
  watchdog polls the same container, so this is sufficient.
- Probe tests the *effective* proxy URL (env overrides honored), not hardcoded
  Mango — the field is still named `mango` because the default and the fleet
  standard is the Mango.
- fail_closed throws are recorded once (the proxied-attempt entry); no second
  entry since no direct fallback happens.

## Verification State

- `npx vitest run test/proxy-use-log.test.ts test/data-source-fetch.test.ts
  test/proxy-fetch.test.ts test/middleware-auth.test.ts` — 4 files, 82 tests,
  all pass (rebased onto origin/main `320a495`).
- `npx tsc --noEmit` — only pre-existing errors in unrelated files
  (`app/api/admin/server-knobs/route.ts`, `src/lib/alpaca-sdk-legacy-client.ts`,
  `src/lib/infisical-settings.ts`); identical on pristine main, none in the
  touched files.
- Live Mango reachability from the Coolify host: NOT verified from here (VM has
  no WireGuard route to 10.99.0.2); the endpoint's probe path is code-reviewed
  only. The watchdog's first poll after deploy will be the real check.

## Next Steps & Blockers

- PR opened against main (branch `Muse-Assist/proxy-use-logging`); left open
  for the standing auto-merge rule — merge only when CI is green.
- Watchdog VM needs its 2-minute poll pointed at
  `https://<app-host>/api/proxy-use` (sample shape below).

Sample watchdog response shape:

```json
{
  "ok": true,
  "snapshot": {
    "latest": { "ts": 1760380000000, "usedProxy": true, "source": "default", "host": "10.99.0.2:8888", "fallback": false, "service": "polygon" },
    "lastHour": { "proxied": 42, "direct": 3, "fallbacks": 1 },
    "total": 46
  },
  "mango": { "host": "10.99.0.2:8888", "reachable": true, "latencyMs": 12, "checkedAt": "2026-10-13T19:55:00.000Z" }
}
```
