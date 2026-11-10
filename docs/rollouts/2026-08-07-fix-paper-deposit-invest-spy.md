# 2026-08-07 — Fix paper vs-SPY ~+50% (deposit then invest, sparse snapshots)

## Context & Objective
Owner: Alpaca Paper (and similar paper accounts) still showed returns ~50% above S&P
despite ~$100k start and slight drawdown — after #2536 (synthetic tip / isAllCash) and
#2538 (multi-period TWR).

## Root cause
`inferExternalCashFlows` missing-fill guard: when cash and positions moved **opposite**
(deposit then buy stock between rare portfolio snapshots, no fill receipts in the gap),
flow was forced to **0**. TWR then treated 66k→99k as +50% account return vs SPY.

Repro (no fills):
- start: equity/cash 66k, positions 0
- end: equity 99k, cash 5k, positions 94k
- flows empty → accountReturnPct ≈ +50%, excess ≈ +46%

With fills for the buys, flow correctly ≈ +34k deposit and account TWR ≈ 0%.

## Fix
When cash↔positions move opposite **and** residual |Δequity| is material vs the swap
size (≥ max(threshold, 0.25 × min(|Δcash|, |Δpos|))), treat Δequity as external flow
(deposit concurrent with invest, or sell then withdraw). Pure conversion + modest MTM
keeps residual small → flow stays 0 so real mark-to-market return is preserved.

## Verification
```bash
npx vitest run test/cash-flows-deposit-invest.test.ts test/benchmark.test.ts
```

## Files
- `src/lib/cash-flows.ts`
- `test/cash-flows-deposit-invest.test.ts`
- STATUS / EFFORT-LOG / this rollout
