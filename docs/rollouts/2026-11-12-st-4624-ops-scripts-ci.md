# ST-4624 — ops scripts CI workflow

## 1. Context & Objective

ST deploy and fleet ops shell lived without static gates beyond a few `bash -n` lines in `ci.yml`.  This adds a dedicated offline workflow so regressions in ops scripts, Python helpers, and ST systemd units are caught before merge.

## 2. Changes Made

- New `.github/workflows/ops-scripts.yml`: `bash -n`, pinned ShellCheck 0.10.0 (warning+), `py_compile`, optional `scripts/tests` unittest discover, ops selftests, and `systemd-analyze verify` on ST units with stubbed `ExecStart`.
- `scripts/ops/coolify-st-pull-guard.selftest.sh`: `COOLIFY_SELFTEST_MODE=anchors-only` for CI without Docker.
- ShellCheck-clean fixes across several `scripts/**/*.sh` (directives, tiny harness fixes, `$HOME` instead of quoted tilde, exported `VERDICT`/`NOTIFY_REASON`).

**Files touched**

- `.github/workflows/ops-scripts.yml`
- `.github/workflows/sentry-ci-report.yml` (observe `Ops scripts` workflow_run)
- `docs/rollouts/2026-11-12-st-4624-ops-scripts-ci.md`
- `STATUS.md`
- `scripts/ops/coolify-st-pull-guard.selftest.sh`
- `scripts/ops/st-container-restart-monitor.selftest.sh`
- `scripts/alert-deploy-freshness.sh`
- `scripts/alert-deploy-freshness.selftest.sh`
- `scripts/cursor-cloud-install.sh`
- `scripts/infisical-prod-cutover.sh`
- `scripts/ios-fleet/publish-ios-versions.sh`
- `scripts/ios-fleet/ship-all.sh`
- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet/test-ship-seq.sh`
- `scripts/merge-shepherd.sh`
- `scripts/pr-touches-codeowners-paths.sh`
- `scripts/verify-branch-protection.sh`
- `scripts/verify-deploy-sha.selftest.sh`

## 3. Decisions & Trade-offs

- Coolify pull-guard full selftest still needs the live `coolify` container; CI runs anchors-only.  Full test remains a host manual step (`docs/deployment.md`).
- `fleet-watchdog.service` is excluded from systemd verify (fleet-wide unit; out of scope).
- Job is not added to branch protection in this PR; Jay can require `verify-ops-scripts` later.

## 4. Verification State

```bash
shellcheck -S warning $(find scripts -name '*.sh' | sort)
COOLIFY_SELFTEST_MODE=anchors-only bash scripts/ops/coolify-st-pull-guard.selftest.sh scripts/ops/coolify-st-pull-guard.sh
bash scripts/ops/st-container-restart-monitor.selftest.sh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## 5. Next Steps & Blockers

- Open PR; green `verify` required for merge.
- Optionally add `Ops scripts` / job `verify-ops-scripts` to the ruleset after a few green runs.

## 6. Zero-Code Findings

None.
