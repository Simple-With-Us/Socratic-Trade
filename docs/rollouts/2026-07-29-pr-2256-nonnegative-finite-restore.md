# 2026-07-29 — PR #2256 restore nonNegativeFinite (GROK)

## Context & Objective
PR #2256 (daily notional zero-balance clamp) failed required `verify` / `verify-hosted` because `src/lib/policy-caps.ts` called `nonNegativeFinite` without defining it after a merge with main.

## Changes Made
- Re-added `nonNegativeFinite` type-guard next to `positiveFinite`.
- Corrected per-order pct cap test: 80% of $100 NAV is $80 under `Math.max(bp, pv)` spend limit.
- Restored zero-balance daily notional ($0 / $0 → notional 0) regression test.

Touched files:
- `src/lib/policy-caps.ts`
- `test/policy-caps.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-29-pr-2256-nonnegative-finite-restore.md`

## Decisions & Trade-offs
- Kept PR's `Math.max(buyingPower, portfolioValue)` spend-limit semantics (not buying-power-only).
- Did not change other open PRs (#2257/#2259/#2265): merge-tree clean, blocked only on CI queue/in-progress.

## Verification State
```bash
./node_modules/.bin/tsc --noEmit   # clean
./node_modules/.bin/vitest run test/policy-caps.test.ts  # 6/6
```

## Next Steps & Blockers
Push fix to `agent/antigravity/daily-notional-zero-balance-fix`, re-arm squash auto-merge, watch verify. Monitor sibling open PRs for CI completion.
