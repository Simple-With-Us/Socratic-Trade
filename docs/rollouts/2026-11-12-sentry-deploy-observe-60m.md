# 2026-11-12 — Sentry Deploy production observation extended to 60 minutes (ST-4625, ST-4628)

## 1. Context & Objective

Usage-Monitor PR #1977 fixed a too-short Sentry Deploy poll window on shared Coolify (45m/135 attempts → 60m/180). Socratic-Trade still used a shorter aligned cap (25m/75 attempts). Run 42750773027 on 2026-11-10 failed after about 25 minutes with `Deployment not confirmed within the bounded observation window` because Coolify had not yet published the merge SHA on `/api/health`.

ST-4625 landed the window itself via #5202.  ST-4628 keeps those caps.  The existing cadence test now also pins the 20 second interval, the production call site, and the `record-production-deploy` job body.  It does not add a second contract test.

## 2. Changes Made

- `observeProduction` default window: 75 attempts / 25-minute deadline → 180 attempts / 60-minute deadline (20s cadence).
- `record-production-deploy` job timeout: 50 → 65 minutes so Actions does not cancel the job mid-poll.
- One cadence test pins attempts, the 20 second interval, the deadline, the production call site, and the `record-production-deploy` timeout.

Touched files:

- `scripts/sentry-report-deploy.mjs`
- `.github/workflows/sentry-deploy.yml`
- `scripts/sentry-report-deploy.node-test.mjs`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-sentry-deploy-observe-60m.md`

RTH skip via `SENTRY_DEPLOY_SKIP_REASON` and `assert-rth-deploy-latch.ts` unchanged. No change to skip reasons, image-noop, or the evening drain re-run.

## 3. Decisions & Trade-offs

The attempt cap stays aligned with the deadline.  180 times 20 seconds is 60 minutes, so raising only one cap would still stop the loop early.  The job timeout stays 65 minutes, the same number as Usage-Monitor #1977 and Congress.Trade #3097.  That is not a guaranteed five-minute margin: the deadline is checked at the start of each attempt, and the Sentry write happens after the window.  This change does not raise the timeout past 65.  Weekday RTH merges still exit 0 via skip, but off-hours slow builds need the longer poll.

## 4. Verification State

```bash
node --test scripts/sentry-report-deploy.node-test.mjs
```

Reporter suite: pass.  `npm run build` was not run.  This diff does not change the Next.js app.

## 5. Next Steps & Blockers

`test-reporter` in `.github/workflows/sentry-deploy.yml` is the job that runs `node --test scripts/sentry-report-deploy.node-test.mjs`.  `verify` does not run that file, because vitest excludes `scripts/**/*.test.mjs`.  Do not dispatch a deploy.  Do not merge from this lane.

## 6. Zero-Code Findings

- Main failure in last 7d with bounded-window message: [run 42750773027](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42750773027) (2026-11-10, ~25m poll).
- [run 42673448967](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/42673448967): `record-production-deploy` skipped (concurrency/if), not observation timeout.
- ST-4628 was already claimed by GB-Monitor, so the ST-4628 lane did not take the claim.
