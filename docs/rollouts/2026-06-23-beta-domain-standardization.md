# 2026-06-23 — Beta domain standardization

## Summary

- Standardized the main integration preview hostname on
  `trading-beta.jays.services`.
- Retired the duplicate/legacy beta hostname.
- Updated repo and host-local documentation so the 4001 preview lane is
  described consistently.
- Updated `scripts/setup-agent-previews.sh` so repair/bootstrap starts or
  restarts pm2 `trading-main` on port `4001`.
- Hardened `scripts/land.sh` with dirty-tree and stale-overlap guards so an
  agent branch cannot silently auto-merge stale UI/text/behavior over newer
  `origin/main` changes without deliberate review.
- Tightened TypeScript and Vitest excludes for hidden agent/tool worktree
  directories so local verification does not traverse nested `.claude`
  dependency tests from the integration checkout.

## Why

Claude appears to have prepared an earlier beta hostname for the same purpose as
the later `trading-beta.jays.services` hostname. Keeping both names creates
confusion in Cloudflare redirect exceptions, Access apps, Tunnel ingress, and
handoff docs. `trading-beta.jays.services` is the clearer pre-production name and
remains the canonical beta route.

## Files

- `AGENTS.md`
- `README.md`
- `PLAN.md`
- `STATUS.md`
- `docs/deployment.md`
- `docs/rollouts/2026-06-23-beta-domain-standardization.md`
- `reference/atlas-public/DEPLOY.md`
- `scripts/land.sh`
- `scripts/setup-agent-previews.sh`
- `tsconfig.json`
- `vitest.config.ts`
- `/Users/jay/apps/README.md`
- `/Users/jay/apps/public-codex/DEPLOY.md`
- `/Users/jay/apps/public-codex/deploy/cloudflared.config.example.yml`

## Cloudflare State

- DNS: `trading-beta.jays.services` is a proxied CNAME to
  `6b807051-38ab-4062-8d52-0cddf1d66657.cfargotunnel.com`.
- Tunnel: `Jay's Home` routes `trading-beta.jays.services` to
  `http://localhost:4001`.
- Access: the `agentic-trading-beta` app is scoped to
  `trading-beta.jays.services`.
- Retired duplicate name: currently has no DNS record, no Tunnel ingress, and no
  Access app.

## Verification

- `rg -n "trading-beta|trading-main" /Users/jay/Code/Agentic\ Trading /Users/jay/apps --glob '!node_modules/**' --glob '!.next/**' --glob '!data/**'`
- Cloudflare API checks for DNS, Tunnel ingress, and Access apps for both
  the canonical beta name and the retired duplicate.
- `curl -sS -D - --resolve trading-beta.jays.services:443:172.67.166.1 https://trading-beta.jays.services/api/health`
  returns Cloudflare Access `302`, confirming the redirect-rule exception for
  the canonical beta hostname is active.
- `curl -s -D - http://127.0.0.1:4001/api/health` returns local origin `200`.
- `bash -n scripts/land.sh`
- `bash -n scripts/setup-agent-previews.sh`
- `git diff --check`
- `npx tsc --noEmit`
- `npm test` initially failed after Vitest discovered nested local
  `.claude/worktrees/**` files, including Playwright specs and dependency tests.
  Fixed by excluding hidden local tool-workspace directories from
  `vitest.config.ts` and `tsconfig.json`.
- `npm test` rerun passed: 97 files / 886 tests.
- `npm run build` passed.
- `pm2 restart trading-main` passed after the build regenerated `.next`.
- `curl -s -D - http://127.0.0.1:4001/api/health` returned `HTTP/1.1 200 OK`
  with `{"ok":true,...}`.

## Follow-ups

- The Cloudflare API token can list the dynamic redirect ruleset but cannot read
  or edit the rule body. If the dashboard still shows an obsolete duplicate beta
  hostname exclusion, remove it there; functional routing is already verified
  through `trading-beta.jays.services`.
