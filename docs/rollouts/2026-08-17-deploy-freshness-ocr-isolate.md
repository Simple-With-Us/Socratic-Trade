# 2026-08-17 — Deploy freshness alert + shared-box OCR isolation (#2545)

## Context & Objective

On 2026-08-06 five Coolify deploys died mid-build (SSH exec stream exit 255)
while GitHub webhooks returned 200 and `/api/health` stayed green on the old
sha for ~14h.  Congress.Trade OCR / `scan-cpu-worker` batches on the shared
box were the contention correlate.  The freeze itself was repaired that night;
this change adds the two guards the issue kept open: a freshness alert, and a
safe isolation tool that cannot take prod down.

## Changes Made

Standing watchdog compares public `/api/health` `.checks.release.sha` to
`origin/main`.  It pages when the *oldest* undeployed main commit is older
than 1 hour (tip-age alone would hide a stuck first merge behind a later
one).  Unreachable health is not this class (UptimeRobot pages site-down).
The workflow never deploys and never calls Coolify.

Shared-box isolation is a dry-run-default `docker update` CPU cap on CT
OCR/scan worker containers.  Default is **5.0 of 8 vCPUs** (cpu-shares 256):
as high as is reasonably advisable on the shared Hetzner cx43.  Unconstrained
OCR peaked at 2.83 cores, so 5.0 does not throttle normal work and leaves 3
cores for Coolify SSH + ST + UM + CT web.  6.0+ is the class that starved the
exec stream.  It never restarts, never matches ST / Coolify / UM, and
`--apply` requires `ISOLATE_SHARED_BOX_APPLY=1`.

- `scripts/alert-deploy-freshness.sh`
- `scripts/alert-deploy-freshness.selftest.sh`
- `scripts/isolate-shared-box-batch.sh`
- `scripts/isolate-shared-box-batch.selftest.sh`
- `.github/workflows/deploy-freshness.yml`
- `.github/workflows/sentry-ci-report.yml`
- `.github/workflows/ci.yml`
- `scripts/sentry-ci-report.py`
- `docs/deployment.md`
- `.claude/skills/deploy-verify/SKILL.md`
- `AGENTS.md` / `CLAUDE.md` (symlink)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-17-deploy-freshness-ocr-isolate.md` (this file)

## Decisions & Trade-offs

- Reused `verify-deploy-sha.sh` for the probe so the two tools share one
  ancestor/behind/divergent matrix.  Freshness only adds the 1h oldest-gap
  rule and Slack de-dupe against the previous cron conclusion.
- Slack `#ag***-s**c` posts only when `SLACK_BOT_TOKEN` is present (Actions
  secret or local env).  Missing token is a no-op; Sentry fleet-infra still
  pages on a failed scheduled run and on a missed check-in.
- Did **not** SSH to production or apply CPU limits.  `docker update` is
  ephemeral across the next CT Coolify recreate.  Durable isolation is a
  Coolify CPU limit on `congress-app`, a CT-repo nice/cpuset worker, or
  moving OCR off-box.
- Did **not** add a Coolify job-level retry-on-255.  That is a Coolify
  product setting this repo cannot set.  Documented as a remaining host
  constraint.
- `--include-app` is opt-in because capping `congress-app-live` also caps
  CT web.  Default only matches dedicated worker/OCR names.
- OCR default is 5.0 / 8, not 2.0.  CT compose `scan-cpu-worker` is still
  `cpus: '2.0'`, which sits *below* the 2.83 unconstrained peak and throttles
  OCR.  The durable matching change is raise that compose line to `5.0`
  (`congress-app` stays at 2.0).  This repo cannot edit Congress.Trade.

## Verification State

```bash
bash -n scripts/alert-deploy-freshness.sh
bash -n scripts/isolate-shared-box-batch.sh
bash scripts/verify-deploy-sha.selftest.sh
bash scripts/alert-deploy-freshness.selftest.sh
bash scripts/isolate-shared-box-batch.selftest.sh
npx vitest run test/sentry-ci-report-workflows.test.ts
```

Selftests: verify-deploy-sha 13/13, freshness 9/9, isolate 17/17 (offline;
no production, no Slack, no docker).  Local `npm run lint` and `npx tsc --noEmit`
clean.  GitHub `verify` / `verify-hosted` on PR #2796 passed (lint, tsc, vitest,
build) before the `origin/main` rematch.  No prod container, DNS, or Coolify
setting was touched.

## Next Steps & Blockers

1. Owner: add repo Actions secret `SLACK_BOT_TOKEN` if `#ag***-s**c` pages
   should come from this cron (Sentry still works without it).
2. CT lane: raise `app/docker-compose.yml` `scan-cpu-worker.cpus` from
   `2.0` to `5.0` (the advised ceiling).  `congress-app` stays at 2.0.
3. Owner: Coolify-side retry on SSH exit 255, if the installed Coolify
   version exposes it.  Not configurable from this repo.
4. After merge: confirm the first scheduled `Deploy freshness` run is green
   while prod matches main (expected).  Do not hand-trigger a deploy.

## Zero-Code Findings

The 2026-08-07 Hetzner cutover moved the fleet off the 4-core Oracle A1 onto
an 8-vCPU cx43.  ST/CT/UM still share that one box, so the isolation ask
survives the host move.  This PR does not claim OCR can no longer freeze ST
deploys until Coolify/CT-repo limits land; it makes a stuck deploy visible
within the hour and gives a no-restart isolation tool plus an explicit
remaining-constraint record.
