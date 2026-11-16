# Rollout: Kalshi First-Class Event Accounts, Real-Time Paper Data, & Universal Shorting/Options Trading

**Date:** 2026-08-28  
**Author:** Antigravity  
**Branch:** `agent/ag-kalshi-and-options-expansion`  

---

## 1. Context & Objective
1. **Kalshi First-Class Connected Account**: Provide the ability to connect Kalshi Demo & Live accounts alongside equity broker accounts via API Key ID & RSA Private Key PEM with customized, event-contract-tailored views across Connections, Account Switcher, Guardrails, Orders, Activity, and LLM prompt directives.
2. **Alpaca Real-Time Market Data Guarantee**: Remove reliance on the 15-minute delayed `ALPACA_PAPER_API_KEY` from Infisical / fallback stores, prioritizing live Alpaca credentials (`ALPACA_LIVE_API_KEY` / `APCA_API_KEY_ID` / connected live accounts) so paper accounts trade with identical real-time market data performance.
3. **Universal Financial-Grade Shorting & Options Architecture**: Expand options trading and short selling capabilities across all supported brokers (Alpaca, Tradier, Webull, Public, Test), including OCC contract normalization, order validation, and gateway execution.

---

## 2. Changes Made
- **Kalshi Broker Gateway**:
  - Implemented `KalshiBrokerGateway` in `src/lib/kalshi-broker.ts` satisfying the full `BrokerGateway` contract: balance fetching, event-contract positions, orders retrieval, order placement (Yes/No binary contracts priced $0.01–$0.99 with RSA-PSS SHA-256 signing), and order cancellation.
  - Wired `getKalshiGateway` into `src/lib/broker.ts` and `src/lib/execution-mode.ts`.
  - Added `eventContracts` to `AccountCapabilities` in `src/lib/types.ts`.
- **Connections & Settings UI**:
  - Added `KalshiConnectSheet` modal in `app/console/settings/brokers.tsx` and `connectKalshiAccount` in `app/console/settings/lib.ts`.
  - Added "Connect Kalshi" action button and updated `CapabilitiesSheet` with event-contract capabilities.
  - Handled `broker === "kalshi"` validation and persistence in `app/api/connected-accounts/route.ts`.
- **Event-Contract Guardrails & Chrome**:
  - Defined `KALSHI_EVENT_DEFS` in `app/console/guardrails/field-defs.ts` and tailored Guardrails for Kalshi accounts.
  - Updated `brokerName` and `ScopeSelector` in `app/console/components/chrome.tsx` to display Kalshi Demo / Live cleanly.
  - Tailored autonomous LLM prompt instructions in `src/lib/venue-contract-pure.ts` for event-contract prediction markets.
- **Alpaca Real-Time Market Data**:
  - Refactored `resolveAlpacaMarketData` in `src/lib/db-api-keys.ts` and `resolveAlpacaHistoryCredential` in `src/lib/history.ts` to prioritize live environment credentials and connected live accounts.
- **Universal Options & Shorting**:
  - Expanded `evaluateOptionOrderPolicy` in `src/lib/option-orders.ts` to support Alpaca, Tradier, Webull, Public, and Test.
  - Added `placeOptionOrder` and `cancelOptionOrder` to `TradierGateway` in `src/lib/tradier.ts` and `TestBrokerGateway` in `src/lib/robinhood.ts`.
- **Tests**:
  - Added `test/kalshi-broker.test.ts`, `test/options-orders-brokers.test.ts`, and `test/alpaca-realtime-marketdata.test.ts`.

### Touched Files
- `src/lib/kalshi-broker.ts` [NEW]
- `src/lib/types.ts`
- `src/lib/broker.ts`
- `src/lib/execution-mode.ts`
- `src/lib/venue-contract-pure.ts`
- `src/lib/tradier.ts`
- `src/lib/robinhood.ts`
- `src/lib/option-orders.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/history.ts`
- `app/api/connected-accounts/route.ts`
- `app/console/settings/lib.ts`
- `app/console/settings/brokers.tsx`
- `app/console/components/chrome.tsx`
- `app/console/guardrails/field-defs.ts`
- `app/console/guardrails/page.tsx`
- `test/kalshi-broker.test.ts` [NEW]
- `test/options-orders-brokers.test.ts` [NEW]
- `test/alpaca-realtime-marketdata.test.ts` [NEW]

---

## 3. Decisions & Trade-offs
- **Kalshi Key Authentication**: Uses RSA-PSS SHA-256 signing with the user's Key ID (UUID) and Private Key PEM, stored securely via AES-256 in the database.
- **Options Broker Gating**: Alpaca, Tradier, Webull, Public, and Test are enabled for options order placement when `optionsTradingEnabled` is on; Robinhood remains display-only for options per venue capability.
- **Alpaca Market Data Fallback**: Removes reliance on the 15-minute delayed paper key in favor of real-time feeds across live keys, ensuring paper accounts experience identical live execution performance.

---

## 4. Verification State
- `npm run lint`: 0 errors.
- `npx tsc --noEmit`: Clean type check (0 errors).
- `npm test`: 7,639+ tests passing across 695 test files.
- `npm run build`: Full Next.js production build succeeded.

---

## 5. Next Steps
- Commit, push, and open PR.
- Auto-merge to `main` and verify production deployment.
