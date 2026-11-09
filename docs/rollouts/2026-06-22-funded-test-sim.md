# 2026-06-22 — Funded local simulator for the Test broker

## Summary

The "Test" broker previously returned a **$0 unfunded** portfolio (cash 0, buying power 0)
and no positions, so the zero-config default account could not actually simulate trades.
Per the owner's decision (option A of the test-account tree), it is now a **funded local
simulator**: a simulated starting balance with positions and P&L derived from the recorded
simulated fills. The account is labeled **"Test — Local Sim"**, and the app + docs state
that a third-party paper account (e.g. Alpaca Paper Trading) is **likely more realistic**
than this local simulation.

## Why

`TestBrokerGateway.getPortfolio()` returned all zeros → buying power 0 → the strategy could
not size or place simulated orders, so the default Test experience was an empty, unusable
account. Funding it makes the zero-config (no-broker) default a real, self-contained demo
while staying honest that it is a simplified simulation.

## Changes

- **`src/lib/robinhood.ts`** — `TestBrokerGateway` takes a `userId`; new
  `TEST_SIM_STARTING_CASH` (env, default $100,000). `getEquityPositions` derives open
  positions from recorded fills (`getOpenLots`) priced at live quotes; `getPortfolio`
  returns a coherent funded portfolio (`equity = starting cash + total P&L`,
  `cash = equity − positionsValue`, `buyingPower = max(0, cash)`). With no fills:
  buying power = cash = equity = starting cash, positions = []. `getAccounts` label →
  **"Test — Local Sim"**. `getTestGateway(userId)`.
- **`src/lib/broker.ts`** — passes `userId` into `getTestGateway`.
- **`src/lib/dashboard-client.tsx`** — the TEST safety banner now adds that a connected
  paper account (e.g. Alpaca Paper Trading) is likely more realistic than the local sim.
- **`.env.example`** — documents `TEST_SIM_STARTING_CASH`.
- **`docs/strategic-framework.md`** — practice-modes section updated (funded local sim +
  "paper is likely more realistic" note). (`/strategy` public page already carries this.)
- Tests: new `test/test-sim-funded.test.ts` (no-fills funded baseline = $100k); updated any
  prior assertion that expected the old $0 Test portfolio.

## Verification

Isolated worktree `~/Code/agentic-trading-queue` off `origin/main`:
- `npx tsc --noEmit` — (recorded at commit)
- `npm test` — (recorded at commit)
- `npm run build` — (recorded at commit)

## Follow-ups

- A fuller sim could model per-fill cash debits/credits and slippage; intentionally kept
  simple (equity = starting cash + P&L) — the honest "less realistic than Alpaca paper"
  framing covers the gap.
- A public no-signup demo (unauthenticated sandboxed surface) remains a separate, larger
  effort.
