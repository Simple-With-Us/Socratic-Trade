# 2026-07-26 — PR merge drain + Actions runner unblock

## Summary

Cleared residual open-PR merge blockers and fixed a self-hosted workspace race that
failed scheduled Playwright Smoke with `ENOENT package.json`.

## Why

- Three green PRs sat with auto-merge off; two red PRs blocked the residual board.
- #2217 re-failed `verify-hosted` on a stale `dashboard-feed` assertion already fixed
  on the #2219 lineage; #2217 had **zero unique commits** vs #2219.
- #2215 failed `tsc` because it imports `TradeEventRowSchema` / `trades` while the
  repo still pinned `@jaywedgeworth22/congress-trading-shared` at **v2.0.0** (schema
  landed in **v2.3.0**).
- Scheduled smoke on socratic-ci lost the checkout between `actions/checkout` and
  `npm install` (same class as the earlier verify-hosted / check-pin races).

## What changed

1. **Merged** #2218 (watchlist star) and #2220 (vs-SPY cash-flow benchmark fix).
2. **Closed** #2217 as superseded by #2219.
3. **Merged `origin/main` into** `agent/ag-reformat-previous-trades` and re-armed
   auto-merge on #2219.
4. **This PR branch** `agent/grok-ci-and-pr-unblock`:
   - Bump shared package pin **v2.0.0 → v2.3.0**.
   - Wire optional `trades` through `dropInvalidShareRows`, send counts, empty-payload
     total, and error log (unblocks #2215 intent).
   - `e2e.yml`: scrub + re-checkout + assert `package.json` before `npm install`.

## Files

- `.github/workflows/e2e.yml`
- `package.json`, `package-lock.json`
- `src/lib/congress-share.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-26-pr-merge-and-runner-unblock.md`

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run test/congress-share.test.ts test/congress-share-price-targets.test.ts` — 50/50 pass
- Runners: `fleet-ci-socratic-ci`, `fleet-ci-socratic-ci-2` online / idle
- #2219: classify/gitleaks/check-pin success; verify-hosted in progress after main merge push

## Follow-ups

- Confirm #2219 auto-merges when verify goes green.
- Close #2215 once this PR lands (or re-target #2215 onto this pin).
- Peer pin-check is non-blocking; Congress.Trade vendors shared package separately —
  coordinate a peer pin/vendor refresh if check-pin starts warning.
