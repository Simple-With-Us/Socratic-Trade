# 2026-09-09 — Docker HEALTHCHECK tini PID1 + curl self-timeout

## Context & Objective

Public `socratictrade.com` returned Traefik 503 `no available server` in ~2h flaps (13:51Z, 16:03Z, 18:07Z) while the Node process was often still answering in-container.  Docker HEALTHCHECK `curl /api/live` SIGKILL'd hung probes.  `infisical-run` (Node) is PID1 and does not `wait()` those children, so zombie curls piled up (CPU 105%, FailingStreak, Traefik dropped the backend).  Recurred 2026-09-10 during RTH; Sentry SOCRATIC-TRADE-S/2D auto-resolved after an existing-container docker-restart.  Board `e7b49943`.  SOCRATIC-TRADE-S / 2D / 4 (scheduler-tick) are companions of the same hang.

## Changes Made

- Runtime image installs `tini` and uses `ENTRYPOINT ["tini", "--"]` so HEALTHCHECK children are reaped.
- HEALTHCHECK still probes `GET /api/live` (never `/api/health`).  Rebase onto main keeps `--timeout=15s --retries=5` (PR #3201) and adds `curl --max-time 14 --connect-timeout 2` so curl exits itself before Docker's 15s kill.

Touched files:

- `Dockerfile`
- `STATUS.md` / `PLAN.md` — current-state snapshot + implementation-plan entries for the tini PID1 / curl self-timeout approach (Codex P1 on PR #3208)
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-09-healthcheck-tini-reap.md`

## Decisions & Trade-offs

Did not Coolify Deploy during RTH (Dockerfile is an image build; latch would refuse after stop-old-first).  Did not bounce prod.  Did not change Coolify HTTP health.  The event-loop hang itself is PR #3202 (FTS mirror non-convergence).  After cash close, Deployer can image-deploy main (this tini ENTRYPOINT plus whatever is already on main).  Do not arm auto-merge while RTH is in effect.

## Verification State

Dockerfile-only.  Do not run a weekday image build.  Public restore is existing-container `docker restart` by BF-DEPLOYER.

Hosted CI on PR #3208 (head `b4259ec57`, workflow run `34508795886`, 2026-09-10):

```
gh pr checks 3208
# verify         pass   (job 102991495690; aggregator after verify-hosted)
# verify-hosted  pass   20m56s  (job 102984397603; 2026-09-10T17:52:39Z–18:13:35Z)
# classify       pass
# gitleaks       pass
# check-pin      pass
```

`gh run view 34508795886 --json conclusion` → `success`.  Earlier CI run `34508731465` on merge-base head `7e22c6962` also `success` (`verify` + `verify-hosted`).

This Codex P1 tip is docs/handoff only (STATUS/PLAN/rollout sections).  Local `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` were **not** re-run here: no TypeScript/JS product change in the tip, and inventing a full-suite result would be false.  Hosted `verify` / `verify-hosted` remain the JS gate of record.  Did not run a local or Coolify image build (weekday RTH latch; Dockerfile is an image path).

## Next Steps & Blockers

- Deployer image-deploys after cash close / non-RTH (this tini ENTRYPOINT is a Dockerfile change; weekday image build would refuse after stop-old-first).
- Do not bounce the live container during RTH.  Public restore, if needed before the image lands, stays existing-container `docker restart`.
- FTS hang / event-loop pin is separate PR #3202 — this lane does not compete with that fix.
- Resolve Codex P1 review threads on PR #3208 after this tip lands (STATUS/PLAN + rollout Next Steps / verification receipts).
- Blockers: none for the docs tip.  Image-deploy is gated on non-RTH.  This lane does not merge.  Extra-ship no.  Do not Coolify Deploy from here.
