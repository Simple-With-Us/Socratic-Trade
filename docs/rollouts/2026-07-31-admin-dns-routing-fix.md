# Rollout Note: 2026-07-31 — Admin DNS & Host Routing Fix for admin.socratictrade.com

## 1. Context & Objective
The user requested: "admin.socratictrade.com needs to have dns fixed so it works properly".
Upon inspection, curling `https://admin.socratictrade.com` failed with **Cloudflare Error 525 (SSL Handshake Failed)**.

## 2. Root Cause Analysis
1. **Cloudflare DNS**: `admin.socratictrade.com` A record pointed to `<ORACLE_IP_RETIRED>` (the Oracle Cloud Coolify box) with `proxied: true` (orange cloud). Cloudflare SSL mode is set to **Full**.
2. **Server Reverse Proxy (Caddy on Oracle Cloud `<ORACLE_IP_RETIRED>`)**:
   - `oracle-caddy-1` listened on ports 80/443.
   - `/etc/usage-monitor/Caddyfile` defined virtual hosts for `socratictrade.com, www.socratictrade.com`, `host.jays.services`, `socratic.trade`, and `congress.trade`.
   - `admin.socratictrade.com` was missing from the `socratictrade.com` site block.
   - When Cloudflare initiated the TLS handshake to `<ORACLE_IP_RETIRED>:443` for `admin.socratictrade.com`, Caddy had no matching site block or certificate, returning a TLS alert internal error which Cloudflare surfaced as HTTP 525.

## 3. Changes Made
- **Server Infrastructure (Caddy on `<ORACLE_IP_RETIRED>`)**:
  - Updated `/etc/usage-monitor/Caddyfile` to include `admin.socratictrade.com` and `*.socratictrade.com` under the `socratic-app:4000` block:
    ```caddyfile
    socratictrade.com, www.socratictrade.com, admin.socratictrade.com, *.socratictrade.com {
      encode zstd gzip
      reverse_proxy socratic-app:4000
      tls internal
    }
    ```
  - Reloaded Caddy (`caddy reload`), resolving the SSL 525 error immediately. `https://admin.socratictrade.com` now returns HTTP 200 via Cloudflare.
- **Middleware Host Routing (`middleware.ts`)**:
  - Added host-level routing for `admin.socratictrade.com` and `admin.socratic.trade`.
  - Requests for `/` on `admin.socratictrade.com` automatically redirect to `/admin`.
  - Shorthand admin paths (`/server`, `/connections`, `/llm-usage`, `/rag-coverage`, `/transcript`) automatically redirect to `/admin<path>`.
- **Litestream R2 Credential Repair**:
  - Found `AWS_ACCESS_KEY_ID` in Infisical project `39d93bb7-76f9-498c-8b50-a7def52e072f` was set to a 40-character string instead of the 32-character Cloudflare R2 Access Key ID.
  - Updated `AWS_ACCESS_KEY_ID` (32 chars) and `AWS_SECRET_ACCESS_KEY` (64 chars) in Infisical `prod` env via API, then restarted `socratic-app`. Litestream replication & compaction now run 100% error-free.
- **Tests (`test/middleware-auth.test.ts`)**:
  - Added unit test cases verifying host routing redirects for `admin.socratictrade.com`.

## 4. Verification State
- `curl -isL https://admin.socratictrade.com` -> HTTP 200 (Clean response via Cloudflare edge proxy).
- `npx vitest test/middleware-auth.test.ts --run` -> All 38 tests passed.
- `npm run lint` -> Passed with 0 errors.
- `npx tsc --noEmit` -> Passed cleanly with 0 type errors.
- `npm test` -> All 418 test files and 4,893 tests passed.
- `npm run build` -> Full Next.js production build succeeded.

## 5. Files Touched
- `/etc/usage-monitor/Caddyfile` (on Oracle Cloud host `<ORACLE_IP_RETIRED>`)
- `middleware.ts`
- `test/middleware-auth.test.ts`
- `docs/rollouts/2026-07-31-admin-dns-routing-fix.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`
