# 2026-11-12 — Sentry Deploy production observation extended to 60 minutes (ST-4625, ST-4628)

## 1. Context & Objective

Usage-Monitor PR #1977 fixed a too-short Sentry Deploy poll window on shared Coolify (45m/135 attempts → 60m/180). Socratic-Trade still used a shorter aligned cap (25m/75 attempts). Run 42750773027 on 2026-11-10 failed after about 25 minutes with `Deployment not confirmed within the bounded observation window` because Coolify had not yet published the merge SHA on `/api/health`.

ST-4625 landed the window itself via #5202. ST-4628 records the same caps in `STATUS.md` and `PLAN.md` and keeps a contract test for the defaults.

## 2. Changes Made

- `observeProduction` default window: 75 attempts / 25-minute deadline → 180 attempts / 60-minute deadline (20s cadence).
- `record-production-deploy` job timeout: 50 → 65 minutes so Actions does not cancel the job mid-poll.
- Contract tests for attempt/deadline/workflow alignment.

Touched files:

- `scripts/sentry-report-deploy.mjs`
- `.github/workflows/sentry-deploy.yml`
- `scripts/sentry-report-deploy.node-test.mjs`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-sentry-deploy-observe-60m.md`

RTH skip via `SENTRY_DEPLOY_SKIP_REASON` and `assert-rth-deploy-latch.ts` unchanged. No change to skip reasons, image-noop, or the evening drain re-run.

## 3. Decisions & Trade-offs

The attempt cap stays aligned with the deadline. 180 times 20 seconds is 60 minutes, so raising only one cap would still stop the loop early. The job timeout is five minutes past that window for checkout, the reporter test, the latch check, and the Sentry write. Weekday RTH merges still exit 0 via skip, but off-hours slow builds need the longer poll. Numbers match Usage-Monitor #1977 and Congress.Trade #3097.

## 4. Verification State

```bash
node --test scripts/sentry-report-deploy.node-test.mjs
```

## 5. Next Steps & Blockers

`verify` and the Sentry Deploy `test-reporter` job are the CI gates. Do not dispatch a deploy.

## 6. Zero-Code Findings

- Main failure in last 7d with bounded-window message: [run 42750773027](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42750773027) (2026-11-10, ~25m poll).
- [run 42673448967](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42673448967): `record-production-deploy` skipped (concurrency/if), not observation timeout.
- ST-4628 was already claimed by GB-Monitor, so the ST-4628 lane did not take the claim.
