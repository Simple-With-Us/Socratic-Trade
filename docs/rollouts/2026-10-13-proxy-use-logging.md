# 2026-10-13 — Per-request proxy-use logging + public `GET /api/proxy-use`

## Context & Objective

Socratic.Trade routes provider/market-data traffic through the residential
proxy via `dataSourceFetch`.  After a trading-proxy miss, the owner wanted to
be able to name the hop: a VM watchdog (2-minute cadence) needs to read
whether recent trading/provider traffic actually went through the proxy, and
whether that proxy is reachable from the application host (where the app runs).

## Changes Made

Pure additive telemetry — no request behavior, timeouts, or error handling
changed:

- `src/lib/proxy-use-log.ts` (new): dependency-free, server-only in-memory
  ring buffer of the last 100 proxy-use decisions.  The ring is pinned on
  `globalThis` (`__socraticProxyUseRing`) so Next.js bundle copies of the
  writer and the reader share one buffer in the process.  Exports
  `recordProxyUse(entry)` and `getProxyUseSnapshot()` returning
  `{ latest, lastHour: { proxied, direct, fallbacks }, total }`.  Entries carry
  host:port only — userinfo (credentials) is stripped by `safeProxyHostForLog`.
- `src/lib/data-source-fetch.ts`: `recordProxyUse` hooked at every exit path —
  excluded service → `usedProxy:false, source:"none"`; internal target →
  `usedProxy:false, source:"none"`; no proxyUrl → `usedProxy:false` with the
  resolution source; proxied attempt → `usedProxy:true` with source + host;
  fail_soft fallback to direct → a SECOND entry `usedProxy:false,
  fallback:true` so fallbacks are visible, not silent.
- `app/api/proxy-use/route.ts` (new): public (no auth) `GET /api/proxy-use`
  returning `{ ok: true, snapshot, mango: { host, reachable, latencyMs,
  checkedAt } }`.  The `mango` probe TCP-connects to the effective proxy
  host:port.  `proxyProbePort` in `src/lib/proxy-fetch.ts` uses 443 when the
  scheme is https and the URL port is empty (omitted or the scheme default,
  which `URL` elides), and 80 for other empty ports.  The helper stays out of
  the route module because Next.js only allows route exports such as `GET`.
  Timeout is 3s, cached 60s module-level so the
  2-minute watchdog never hammers it.  Never throws — probe errors return
  `reachable:false`.
- `middleware.ts`: added `/api/proxy-use` to `PUBLIC_PREFIXES` — the edge auth
  gate 401s `/api/*` otherwise, and the watchdog polls anonymously.  Safe: only
  aggregate counts, latest host:port, and a reachability boolean.
- `test/proxy-use-log.test.ts` (new): empty snapshot, latest-entry fields,
  fallback counting, 1-hour window exclusion, 100-entry ring cap, never-throws,
  and the `globalThis` pin.
- `test/proxy-use-route.test.ts` (new): probe port for an explicit port, https
  with no port, http with no port, and elided scheme-default ports.

## Decisions & Trade-offs

- No new dependencies.  Ring is per-process memory (container-local); the
  watchdog polls the same container, so this is sufficient.  `globalThis`
  shares that memory across bundled module copies.  It does not share across
  processes.
- Probe tests the *effective* proxy URL (env overrides honored), not a
  hardcoded address — the field is still named `mango` because that is the
  historical response shape.
- fail_closed throws are recorded once (the proxied-attempt entry); no second
  entry since no direct fallback happens.
- The rollout note does not publish proxy addresses, mesh routing, or hosting
  inventory.  The sample below uses a placeholder host.

## Verification State

Re-verified 2026-10-14 on the post-merge head, after resolving the branch's
merge conflict with `main`:

```bash
npm run lint -> ok (0 errors; 866 warnings)
npx tsc --noEmit -> ok
npm test -> 14 failed | 9254 passed | 51 skipped (9319)
npm run build -> ok
```

Fast-to-slow order, one status per command.  Targeted runs:

```bash
npx vitest run test/proxy-use-log.test.ts test/proxy-use-route.test.ts test/proxy-fetch.test.ts test/data-source-fetch.test.ts -> ok (4 files, 45 tests)
```

All 14 full-suite failures are pre-existing and environment-caused, not from
this PR:

- 13 are OpenRouter / LLM-routing tests (`test/llm-provider.test.ts`,
  `test/openrouter-credits.test.ts`, `test/chat-llm.test.ts`,
  `test/framework-review.test.ts`).  They assert "no key configured" while this
  runner environment has a real OpenRouter credential present, so resolution
  lands on `openrouter` where the test expects a native provider.  Reproduced
  identically on a pristine detached `origin/main` worktree (13 failed | 47
  passed), and none of these files are touched by this PR.
- `test/event-loop-stall-hot-path.test.ts` ("pruneTaskJournal stays under 100ms")
  is a timing-sensitive perf assertion that measured 115ms on a loaded runner.

Caveat for whoever reads CI output: `npm test` exited **0** despite these 14
failures, because the `::error` annotation reporter swallows the non-zero
status.  Read the printed `Tests ... failed` line, not the exit code.

A prior round of this note also recorded a single `test/egress-guard.test.ts`
real-DNS failure; that file is unchanged versus `origin/main` and did not fail
in this run.

- Live proxy reachability from the application host: NOT verified from here.
  The endpoint's probe path is code-reviewed only.  The watchdog's first poll
  after deploy will be the real check.

## Next Steps & Blockers

- PR #4619 (branch `Muse-Assist/proxy-use-logging`): all five review threads are
  resolved and bot-verified, and the branch conflict with `main` is merged
  clean.  Auto-merge is armed; it lands when the hosted `verify` job is green.
- Watchdog VM needs its 2-minute poll pointed at
  `https://<app-host>/api/proxy-use` (sample shape below).

Sample watchdog response shape:

```json
{
  "ok": true,
  "snapshot": {
    "latest": { "ts": 1760380000000, "usedProxy": true, "source": "default", "host": "proxy.example:8888", "fallback": false, "service": "polygon" },
    "lastHour": { "proxied": 42, "direct": 3, "fallbacks": 1 },
    "total": 46
  },
  "mango": { "host": "proxy.example:8888", "reachable": true, "latencyMs": 12, "checkedAt": "2026-10-13T19:55:00.000Z" }
}
```
