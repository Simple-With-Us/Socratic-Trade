# ST-4590 — Broker universe recovery when Nasdaq/Yahoo return zero quotes

## Context & Objective

Prod Autopilot runs were failing with `ScanQuotesUnavailableError` when the Nasdaq screener and Yahoo v7/chart fallback priced zero names, even though Alpaca Paper (`delayed_sip`) and Tradier Sandbox could supply venue-aligned quotes for the allowed universe.

## Changes Made

- Added `src/lib/scan-broker-universe-recovery.ts` — fills the allowed set from the operating account's broker gateway (Alpaca paper `delayed_sip` or Tradier) with `isUsableBrokerQuote` fail-closed filtering.
- `recoverQuotesWhenScreenerEmpty` order: Yahoo whole-set, then broker recovery, then last-good seed (no seed-before-Yahoo shortcut).
- `MarketScan.universeQuoteRecoverySource` records the tape (e.g. `alpaca-delayed_sip`).
- `strategy-gather.ts` also reuses last-good on `ScanQuotesUnavailableError` with `lastGoodReason` (`quotes_unavailable` vs `timeout`).
- `strategy.ts` audits `strategy_gather_broker_universe_recovery` when broker recovery ran; `strategy_gather_used_last_good` reason uses `SCAN_QUOTES_UNAVAILABLE_CODE` when applicable.

### Touched files

- `src/lib/scan-broker-universe-recovery.ts` (new)
- `src/lib/market.ts`
- `src/lib/types.ts`
- `src/lib/strategy-gather.ts`
- `src/lib/strategy.ts`
- `test/scan-broker-universe-recovery.test.ts` (new)
- `test/scan-empty-screener.test.ts`
- `test/strategy-gather.test.ts`
- `docs/rollouts/2026-11-09-st-4590-scan-broker-universe-recovery.md`

## Decisions & Trade-offs

- Only Alpaca paper (`delayed_sip`) and Tradier are in scope; other brokers keep prior behavior.
- Connected-account credentials only (no new env `ALPACA_PAPER_*` usage on this path).
- Global `ALPACA_DATA_FEED` untouched.

## Verification State

```bash
npx vitest run test/scan-broker-universe-recovery.test.ts test/scan-empty-screener.test.ts test/strategy-gather.test.ts
npx tsc --noEmit
npm run lint
npm test
npm run build
```

## Next Steps & Blockers

- Merge after `verify` CI green. Complements open `gb-trader/scan-unavailable-lastgood` last-good-on-unavailable work (included here for gather audit).
