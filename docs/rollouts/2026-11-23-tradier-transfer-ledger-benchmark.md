# 2026-11-23: Tradier transfer ledger feeds the vs SPY benchmark

## Context & Objective
The Tradier sandbox Home card shows "Benchmark unavailable". Tradier had no broker transfer ledger in the benchmark path, so deposits and withdrawals were inferred from cash deltas. Snapshots carry no cash capture time, so any cash-moving fill near a snapshot made the window ambiguous and the benchmark kept only the window after the last ambiguous snapshot (snapshot-timing-unknown). That is deliberate no-guessing behavior. Objective: use Tradier own history as the authoritative transfer ledger, as Alpaca activities already are. Nothing is estimated.

## Changes Made
- src/lib/tradier-transfer-ledger.ts: maps Tradier history events (ach, wire, check, transfer, journal) to the existing broker-activity shape (CSD in, CSW out). Trades, dividends, interest, fees and zero amounts are dropped.
- src/lib/tradier.ts: read-only getTransferLedger (GET /accounts/{id}/history, paged, 40-page cap) and fetchTradierTransferLedger. ok only when every page was read and the history was not empty.
- src/lib/broker-cash-flows.ts: resolveExternalCashFlows takes brokerLedgerComplete; a complete ledger with no transfers is an authoritative zero-flow broker source.
- src/lib/benchmark.ts, src/lib/dashboard.ts: plumb it for Tradier accounts under the existing 4 s section deadline.
- test/tradier-transfer-ledger.test.ts.

## Decisions & Trade-offs
- Any failure, truncation or empty history returns ok=false and the previous behavior stays; no estimate is ever minted.
- Display-only. No order path, sizing, risk or order-placement code is touched; no write call to Tradier.

## Verification State
- tsc clean for touched files; vitest runs in CI. The Tradier history response shape was taken from the public API docs; first live read is the verification (see ops snapshot after deploy).

## Next Steps & Blockers
- After deploy confirm the Sandbox card shows a benchmark; if history is not paged by page param the cap path falls back safely.

## Zero-Code Findings
None.
- The Sandbox audit row at 3:55 PM CST (benchmark_timing_unknown, snapshot-timing-unknown) is the verified pre-fix state; a successful ledger read replaces it with a benchmark.
