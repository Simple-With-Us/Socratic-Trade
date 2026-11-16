# 2026-08-05 — Multi-period TWR: capital regimes + chained SPY

## Context & Objective
Owner: if you hold $100 for 10 days then $10 for 100 days, return must split into
back-to-back capital regimes at each deposit/withdrawal, measure account **and** SPY
on each subset, then combine with geometric linking (product of (1+r) − 1) — not a
single start→end ratio that ignores how long each dollar was invested.

## Method (GIPS-style time-weighted return)
1. Infer external flows (deposits +, withdrawals −) between snapshots.
2. Each consecutive snapshot pair is a sub-period:
   - Account factor = V_end / (V_start + flow_at_end)
   - SPY factor = SPY_end / SPY_start over the same dates
3. Overall account = ∏ account factors − 1; overall SPY = ∏ SPY factors − 1.
4. Coalesce no-flow runs into readable “capital regimes” for the Results table.

## UI
Results → Versus the market: copy explains multi-period TWR; table lists each regime
(window, start→end equity, transfer, you %, SPY %).

## Verification
`npx vitest run test/benchmark.test.ts` — 22 pass (includes $100→$10 regime chain).

## Files
- `src/lib/benchmark.ts`, `src/lib/cash-flows.ts`, `src/lib/types.ts`
- `app/console/results/page.tsx`, `test/benchmark.test.ts`
