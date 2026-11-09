# Market Scan Cap Settings

Date: 2026-06-23  
Branch/worktree: `codex/ui-account-deletion-visual-pass` in `/Users/jay/apps/trading-codex`  
Preview: `codex.jays.services` / pm2 `trading-codex` / port `4101`

## Summary

Moved the Market Scan candidate cap from env-only behavior into per-user policy
settings. Users can now set:

- `marketScanCandidateLimit` — default 30, bounded 10-100.
- `marketScanOutlierReserve` — default 8, bounded 0-25 and never above the
  candidate cap.

The Market Scan tab now has a gauge button that opens Settings directly to the
Data section where these controls live. The scan subtitle shows the returned
candidate count against the active cap and the number of outlier-reserve names
included.

## Why

The previous cap was `MARKET_SCAN_LIMIT` in the environment, so users could not
choose the trade-off between cost/latency and breadth. It also had a hidden
prompt-side `score >= 40` filter after `topCandidates`, which could remove
below-cutoff outliers even when the scan had pulled them in for notable signals.

## Expert Debate

- LLM/prompt expert: the LLM should compare a bounded set, not thousands of
  rows. The default should stay near 30. More than about 80-100 rows usually
  dilutes attention and makes rationales less specific even when context window
  and cost are available.
- Market/portfolio expert: a broad universe still needs enough breadth for
  sector rotation and small/mid-cap discovery. 10-12 is the lowest reasonable
  range for cost-sensitive runs; below that, one sector or mega-cap cluster can
  dominate too easily. 60-80 is useful when scanning broad universes.
- Quant/signal expert: outliers should be explicitly reserved inside the cap,
  not appended on top. Congressional buying, insider buying, short-pressure, and
  strong bullish technicals are valid reasons to override pure rank, but the
  reserve must be bounded.
- Product/safety conclusion: expose both knobs with guardrails. Keep default 30
  / 8. Allow 10-100 candidates and 0-25 outliers, with the outlier reserve
  capped by candidate limit.

## Decisions

- `MARKET_SCAN_LIMIT` and `MARKET_SCAN_EVENT_RESERVE` remain fallback values for
  direct/internal calls, but policy values drive normal app scans.
- `/api/scan`, scheduled strategy runs, and approval-time re-scans pass the
  user's candidate cap and reserve into `scanMarket`.
- `MarketScan` now reports `candidateLimit`, `outlierReserve`, and
  `outlierCandidateCount`.
- Below-cutoff outliers are sorted by a new `outlierInterestScore()` before
  filling the reserve.
- Removed the hidden `score >= 40` prompt filter so outlier-reserve names can
  actually reach the LLM when included in `topCandidates`.

## Files

- `src/lib/scan-settings.ts`
- `src/lib/types.ts`
- `src/lib/defaults.ts`
- `src/lib/market.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/data-providers.ts`
- `app/api/policy/route.ts`
- `app/api/scan/route.ts`
- `app/dashboard-client.tsx`
- `test/scan-settings.test.ts`
- `test/market.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/architecture-blueprint.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-23-market-scan-cap-settings.md`
- `docs/rollouts/2026-06-23-expanded-index-universes.md`

## Verification

- `npx vitest run test/scan-settings.test.ts test/market.test.ts test/market-custom-symbol.test.ts test/market-dynamic-universe.test.ts test/index-universes.test.ts test/policy.test.ts` — passed, 70 tests.
- `npx tsc --noEmit` — passed.
- `npm test` — passed, 106 files / 934 tests.
- `npm run build` — passed.
- `git diff --check` — passed.

## Follow-ups

- If users frequently set the cap above 80, consider measuring proposal quality
  and latency by cap bucket before raising the max beyond 100.
- Consider a future split between "UI display rows" and "LLM candidate rows" if
  users want a large table but a smaller prompt.
