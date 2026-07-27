# Rollout: Complete Open PR Sweep Merge & Hetzner Runner Swap Provisioning

**Date:** 2026-07-27  
**Author:** Antigravity  
**Status:** Completed & Production Deployed (`socratictrade.com`)

---

## 1. Context & Objective
The user requested all open Pull Requests to be checked, resolved of conflicts/review issues, and merged to `main` with production deployment on Coolify. In addition, health checks were executed across all self-hosted GitHub Actions runners and both Hetzner server instances (`135.181.192.190` and `77.42.35.209`).

---

## 2. Changes Made & PR Sweep Summary

### Merged Pull Requests (All Auto-Merged to `main` and Deployed):
1. **PR #2234**: `fix(#165): wire CONGRESS_TRADE_TOKEN into SSE subscription creation`
   - *Branch:* `cursor/shared-pkg-consumer-fixes`
   - *Status:* **MERGED**
2. **PR #2232**: `feat: dormant-features readiness (landing, CSP report, embed_rev)`
   - *Branch:* `cursor/dormant-features-impl-1c6c`
   - *Status:* **MERGED**
3. **PR #2231**: `feat(hoard): add 5-year multi-index universe data hoarding script across Massive and FMP`
   - *Branch:* `agent/antigravity-layout-fixes`
   - *Status:* **MERGED**
4. **PR #2230**: `feat(enrichment): free-first cascade planner + coverage report`
   - *Branch:* `fix/cursor-free-cascade-coverage` (superseded failed PR #2224)
   - *Status:* **MERGED**
5. **PR #2229**: `chore(deps-dev): bump eslint-config-next from 16.2.10 to 16.2.12`
   - *Branch:* `dependabot/npm_and_yarn/eslint-config-next-16.2.12`
   - *Status:* **MERGED**

### Redundant PR Cleanup:
- **PR #2233** & **PR #2235**: Closed as redundant duplicate copies of PR #2231.
- **PR #2224**: Closed as superseded by PR #2230.

---

## 3. Hetzner Server & Actions Runner Infrastructure Health

### Hetzner Actions Runner Host (`ci-cpx32-hel1-22` / `77.42.35.209`):
- **Root Cause:** Host had 0B swap configured on 7.6GB total RAM. Parallel builds across `socratic-ci` and `socratic-ci-2` caused RAM spikes above 100% leading to Node.js OOM crashes.
- **Resolution:** Provisioned and activated an 8GB swapfile (`/swapfile`), persisted in `/etc/fstab`.
- **Systemd Runner Services:** All 5 runner units (`shared-ci`, `congress-ci`, `socratic-ci`, `socratic-ci-2`, `usage-ci`) are online, healthy, and processing jobs cleanly.

### Prod Coolify Host (`135.181.192.190` / `host.jays.services`):
- **Coolify Dashboard:** `https://host.jays.services` → **HTTP 302** (Online & responsive).
- **Production Web App:** `https://socratictrade.com/api/health` → **`ok: true`**
  - Database: `ok`, 33.2 GB free disk space available.
  - Litestream: `replicating` to R2 backup.
  - Trading Engine: Active across 3 live accounts.

---

## 4. Verification State

```bash
# 1. Listed open PRs (returns 0 open PRs)
gh pr list

# 2. Checked recent merged PRs
gh pr list --state merged -L 5

# 3. Verified production health endpoint
curl -s -m 5 https://socratictrade.com/api/health
```

Output: Production health returned `{"ok":true}` with release SHA `c93f1988d747fef3ad16487bc80d5142482bcc76`.

---

## 5. Next Steps
- Zero open PRs remaining in queue.
- Fleet CI runner swap expansion guarantees stability for future parallel multi-agent builds.
