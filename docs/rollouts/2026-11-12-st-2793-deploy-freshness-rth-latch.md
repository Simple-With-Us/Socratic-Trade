# 2026-11-12 - ST-2793 deploy-freshness RTH latch awareness

## Context and objective

The deploy-freshness watchdog aged undeployed `main` from commit timestamp only, so merges during weekday RTH (when the Dockerfile latch correctly refuses image builds) tripped STALE after one hour.  Nov 11 run 43104521635 on merge `d554c15c` was that false positive.

## Changes made

- `src/lib/market-calendar.ts` — `regularSessionCloseUtcMs()` (same early-close / holiday rules as `isMarketOpen`).
- `src/lib/deploy-freshness-staleness.ts` — latch-aware age via `evaluateRthDeployLatch`.
- `scripts/deploy-freshness-staleness-cli.ts` — JSON helper for `alert-deploy-freshness.sh`.
- `scripts/alert-deploy-freshness.sh` — consults CLI before exit 3; `DEPLOY_FRESHNESS_LATCH_NOW` test seam.
- `test/deploy-freshness-staleness.test.ts` — RTH, post-close grace, off-hours, HOTFIX, holiday/early-close.
- `scripts/alert-deploy-freshness.selftest.sh` — hermetic RTH cases.

## Decisions and trade-offs

- Reused `evaluateRthDeployLatch` / `isMarketOpen` from the build latch; did not change `assert-rth-deploy-latch.ts`.
- Grace after latch lift reuses `DEPLOY_FRESHNESS_STALE_SECONDS` (default 3600); no new secrets.
- Staleness CLI runs from the real repo root so hermetic selftests can use a throwaway git fixture.

## Verification state

```bash
bash -n scripts/alert-deploy-freshness.sh
bash scripts/alert-deploy-freshness.selftest.sh
npm test -- test/deploy-freshness-staleness.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next steps and blockers

- Land PR #5143; confirm next weekday RTH merge does not fail deploy-freshness until latch grace after close.
- Real silent-freeze class unchanged: off-hours / post-grace staleness still exit 3.
- 2026-11-12: merged `origin/main` (`ba400936`, ST-4607 RAG embed timeout) into `cursor/st-2793-deploy-freshness-rth-latch-5247`; no conflicts in deploy-freshness / RTH latch files.
- Kody round 2: npx-fallback selftest (21/21), `rth-deploy-latch.yml` cron lock in vitest, `deployDueAnchorMs` control on the drain-stale test.

## Zero-code findings

- Run 43104521635 failed because prod was behind `d554c15c` (merged 11:55 ET) while live stayed on `d85f2224`, with raw age 16863s > 3600s at 16:36 ET — not a Coolify freeze; RTH latch with no latch-aware watchdog.
