# Phase 2 - Correctness Fixes

## Goals

- Keep reviewed `estimated_notional` as the source of truth for daily notional accounting.
- Count share-quantity market orders correctly even when no limit price is present.
- Attribute sectors for held positions using all available market metadata, not only the top ranked scan rows.
- Allow positions to carry optional `sector` and `industry` metadata from the broker or market scan.

## Interfaces

- `MarketScan.sectorBySymbol`: compact map of every scanned symbol with sector metadata.
- `MarketScan.quotesBySymbol`: compact quote map for symbols returned by the provider.
- `EquityPosition.sector` and `EquityPosition.industry`: optional position metadata.
- `PolicyContext.marketScan`: available to deterministic policy checks.

## Acceptance

- `dailyExecutionStats()` prefers `trade_proposals.estimated_notional`.
- Fallback notional only applies to legacy rows without reviewed notional.
- Sector composition for the LLM and policy enforcement uses position metadata first, then `MarketScan.sectorBySymbol`.
- A held position outside `topCandidates` can still be assigned a sector.

## 2026-07-21 account-drain correctness note

Deleted connected accounts drain before purge so broker-side live orders can be canceled and fills
reconciled before local account/proposal/stop state is removed. Draining cleanup must use the shared
`isLiveOrderState` vocabulary, not only literal `open`/`partially_filled`, because brokers can
report still-live orders as `accepted`, `pending_new`, `queued`, `confirmed`, `pending`, or
`pending_cancel`.
