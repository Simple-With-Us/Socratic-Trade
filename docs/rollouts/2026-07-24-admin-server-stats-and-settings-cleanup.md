# Rollout Note: Admin Server Stats & Settings Cleanup (2026-07-24)

## Context & Objective
The Admin Server Stats page (`/admin/server`) needed updates to exclude noisy backup tasks from Coolify services, list Hetzner GitHub Action runners, report host RAM utilization and disk space, and format host uptime. Additionally, the deprecated `OPERATOR` section linking to old `/admin/*` pages in Console Settings (`/console/settings`) was removed.

## Changes Made
- **`src/lib/server-metrics-shapes.ts`**: Updated `normalizeCoolifyResources` to filter out resources containing "backup" or "backups" in their name or type.
- **`app/api/admin/server-metrics/route.ts`**:
  - Added `getDiskStats()` using `fs.statfsSync('/')` for disk space metrics (`diskTotalBytes`, `diskFreeBytes`, `diskUsedBytes`, `diskUsedPct`).
  - Added `getActionRunners()` to query GitHub API or include registered Hetzner action runners (`socratic-ci`, `socratic-ci-2`, `congress-ci`, `shared-ci`, `usage-ci`, `github-runner`).
  - Populated host RAM utilization and uptime in local payload.
- **`app/admin/server/server-metrics-client.tsx`**:
  - Updated Host Details Grid to 5 columns: Host Server, CPU Cores, System Memory, Disk Storage, Host Uptime.
  - Updated System Memory Card to render RAM used, free, total, and utilization percentage.
  - Added Disk Storage Card (total, used, available, and percentage used).
  - Added Disk Utilization progress bar to Live Resource Load card.
  - Renamed Coolify Services section to "Services & Action Runners".
- **`app/console/settings/page.tsx`**: Removed `OPERATOR` section (`AdminLinksCard`) and unused imports.
- **`test/server-metrics.test.ts`**: Added unit tests for backup filtering and updated resource assertions.

## Decisions & Trade-offs
- **Backup Resource Filtering**: Backup tasks (like `usage monitor backups`) were hidden from the primary services list to keep the status view clean and actionable.
- **Process Host Data Isolation**: Process host metrics (such as local `os.freemem()` / `/proc/uptime`) are kept in `localPayload` while remote API metadata targets populate remote `hostInfo` without cross-contaminating host values.

## Verification State
- `npx tsc --noEmit`: Passes with 0 errors.
- `npx vitest run test/server-metrics.test.ts`: Passes all 19 tests.
- `npm run lint`: Verified.
- `npm run build`: Verified.

## Next Steps
- Merge PR to `main` for automatic Coolify production deployment.
