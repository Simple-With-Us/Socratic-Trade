# 2026-07-10 — Dashboard upstream deadlines, ipv4first at boot, first-load watchdog

**Author:** CLAUDE (sonnet engineer agent, coordinated with AG's PR #1285) · **Branch:** `claude/console-load-hang`

## Summary
Production showed an infinite logo/loading screen on socratictrade.com (phone + desktop). Two-layer
cause: (1) primary — SSE `market-data` events abort the in-flight `GET /api/dashboard` fetch on every
event (AG's open **PR #1285** fixes that with a `background` refresh flag); (2) amplifier — the
snapshot aggregates many upstreams with no timeouts, so a slow/hung call (e.g. the 2026-07-06
undici-IPv6-blackhole mode) stretches or freezes the response. Prod logs (via Coolify API) show ZERO
app output — only litestream noise — so hangs were also invisible.

This change (complementary to #1285, no file-region overlap):
- `src/lib/dashboard.ts` — `withDeadline()` around all 9 upstream awaits (accounts 6s;
  portfolio/positions/orders 8s; RH MCP health 4s; quotes 6s; SPY benchmark 4s; macro 6s;
  signals/history/news 4s). Timeout ⇒ the SAME degraded fallback each site's `.catch` already
  produced + a `[dashboard] <label> timed out` warn (now visible in Coolify logs).
- `instrumentation.ts` — `dns.setDefaultResultOrder("ipv4first")` first in the nodejs `register()`
  (guaranteed server-boot hook on the Coolify container; `next.config.mjs` alone isn't guaranteed
  across build modes). Needed `/* webpackIgnore: true */` so the edge bundle doesn't choke on
  `node:dns`.
- `app/console/lib/useConsoleData.tsx` — self-contained 15s first-load watchdog: flips to the
  existing auto-retrying error card instead of an infinite logo. Deliberately touches nothing in
  `refresh()` so it merges cleanly with #1285.

## Verification
`npx tsc --noEmit` clean · `npm test` 3261/3261 (310 files) · `npm run build` clean · `npm run lint`
0 errors. Prod-probe evidence in session: edge/health/login fast; litestream txids advancing.

## Follow-ups
- Land #1285 first (primary fix); owner approves both; Coolify redeploys from main.
- After deploy, check Coolify logs for `[dashboard] … timed out` lines to name the slow upstream.
- Observability gap: app stdout is silent in prod — consider a request-timing log line for
  `/api/dashboard` later.
