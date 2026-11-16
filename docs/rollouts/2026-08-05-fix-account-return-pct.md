# 2026-08-05 — Fix inflated account % return (paper/sandbox/all accounts)

## Context & Objective
Owner: account return shows ~+50% on Sandbox, Alpaca Paper, Agentic, etc., despite starting
near $100k and being slightly down. The figure was not credible across every paper account.

## Root causes
1. **Synthetic paper equity curve + live tip (P0).** `syntheticPaperCurve` builds
   `equity = 100 + realized` (fake $100 base). Dashboard tips the curve with live
   `totalMarketValue` (~$100k) which carries `cash`/`positionsValue`. Old
   `computeSpyBenchmark` only required *some* point to look real, so TWR chained
   $100 → $100k and reported enormous "Your account" returns on Results/iOS Home.
2. **isAllCash preferred buggy `positionsValue`.** When cash ≈ equity but
   `positionsValue` was wrongly equal to full equity, all-cash deposit/reset detection
   failed and raw equity growth (e.g. 66k → 100k ≈ +50%) was counted as alpha.
3. **Avg return / closed trade was unweighted.** Small +50% round-trips dominated the
   mean even when NAV was flat/down on large open losers.

## Changes
- `computeSpyBenchmark`: require ≥2 real snapshot points (cash or positionsValue); drop
  pure synthetic history even if a live tip is present.
- `isAllCash`: prefer cash≈equity before positionsValue.
- `inferExternalCashFlows`: missing-cash fallback for flat books with no trades.
- `averageReturn`: capital-weighted (sum pnl / sum entry notional); UI label clarified.

## Verification
```bash
npx vitest run test/benchmark.test.ts  # 19 pass
```

## Files
- `src/lib/benchmark.ts`, `src/lib/cash-flows.ts`, `src/lib/performance.ts`
- `app/console/results/page.tsx`
- `test/benchmark.test.ts`

## Follow-up: withdrawals + every external dollar

Owner: also need withdrawals and every dollar change accounted for.

- Strengthened `inferExternalCashFlows`: cash-first deposits **and** withdrawals
  (`flow = Δcash − tradeCash`; pure transfer when cash+equity move together).
- Headline `accountReturnPct` is **capital-adjusted simple return**
  `(V_end − V_start − netExternalFlows) / V_start` so net deposits (+) and
  withdrawals (−) are stripped; wipe-level withdrawals still use TWR rebase.
- UI copy on Results spells out deposit/withdrawal stripping.
- Tests: withdrawal with open positions; multi deposit+withdrawal netting to market P&L.
