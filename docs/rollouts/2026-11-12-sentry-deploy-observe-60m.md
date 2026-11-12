# 2026-11-12 — Sentry Deploy production observation extended to 60 minutes (ST-4625)

## 1. Context & Objective

Usage-Monitor PR #1977 fixed a too-short Sentry Deploy poll window on shared Coolify (45m/135 attempts → 60m/180). Socratic-Trade still used a shorter aligned cap (25m/75 attempts). Run 42750773027 on main failed after 25 minutes while prod had not yet published the merge SHA.

## 2. Changes Made

- `observeProduction` default window: 75 attempts / 25-minute deadline → 180 attempts / 60-minute deadline (20s cadence).
- `record-production-deploy` job timeout: 50 → 65 minutes so Actions does not cancel the job mid-poll.
- Contract test for attempt/deadline/workflow alignment.

Touched files:

- `scripts/sentry-report-deploy.mjs`
- `.github/workflows/sentry-deploy.yml`
- `scripts/sentry-report-deploy.node-test.mjs`
- `docs/rollouts/2026-11-12-sentry-deploy-observe-60m.md`

RTH skip via `SENTRY_DEPLOY_SKIP_REASON` and `assert-rth-deploy-latch.ts` unchanged.

## 3. Decisions & Trade-offs

- Mirrored UM/CT fix numbers rather than keeping ST on 25 minutes; weekday RTH merges still exit 0 via skip, but off-hours slow builds need the longer poll.

## 4. Verification State

```bash
node --test scripts/sentry-report-deploy.node-test.mjs
```

30/30 pass.

## 5. Next Steps & Blockers

- None; merge when verify is green.

## 6. Zero-Code Findings

- Main failure in last 7d with bounded-window message: [run 42750773027](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42750773027) (2026-11-10, ~25m poll).
- [run 42673448967](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42673448967): `record-production-deploy` skipped (concurrency/if), not observation timeout.
