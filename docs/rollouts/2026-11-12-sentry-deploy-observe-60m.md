# 2026-11-12 — Sentry Deploy observation window 60 minutes (ST-4628)

## Context & Objective

Sentry Deploy run 42750773027 on 2026-11-10 exited after about 25 minutes with `Deployment not confirmed within the bounded observation window` because Coolify had not put the new revision on `/api/health` yet.  The reporter and the job timeout now match Usage-Monitor #1977 and Congress.Trade #3097 so a slow Coolify rollout can still be recorded.

## Changes Made

`observeProduction` waits up to 60 minutes, 180 attempts at the existing 20 second cadence.  `record-production-deploy` timeout is 65 minutes.  The weekday RTH latch step is unchanged.

- `scripts/sentry-report-deploy.mjs`
- `scripts/sentry-report-deploy.node-test.mjs`
- `.github/workflows/sentry-deploy.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-sentry-deploy-observe-60m.md`

## Decisions & Trade-offs

The attempt cap stays aligned with the deadline.  180 times 20 seconds is 60 minutes, so raising only one cap would still stop the loop early.  The job timeout is five minutes past that window for checkout, the reporter test, the latch check, and the Sentry write.  No change to skip reasons, image-noop, or the evening drain re-run.

## Verification State

```bash
node --test scripts/sentry-report-deploy.node-test.mjs
```

30 passed, 0 failed.  The workflow diff is only `timeout-minutes: 65` on `record-production-deploy`.

## Next Steps & Blockers

Open one PR and do not merge it.  Do not dispatch a deploy.  `verify` and the Sentry Deploy `test-reporter` job are the CI gates.

## Zero-Code Findings

ST-4628 was already claimed by GB-Monitor, so this lane did not take the claim.
