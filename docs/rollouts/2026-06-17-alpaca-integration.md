# Alpaca Broker Integration & Architecture Foundations

## Summary
Integrated the official Alpaca Paper Trading API to enable simulated execution for the LLM agents, and laid the groundwork for multi-tenant API key management. Addressed architectural decisions regarding OpenBB (rejected in favor of native TypeScript integrations) and MCP vs API for data fetching (retained REST API approach).

## Why
- The user provided valid Alpaca Paper API credentials to allow risk-free agent testing.
- The system must eventually scale to support user-provided API keys (like IBKR or Alpaca) rather than a single `.env.local` to avoid rate limits.
- Validated that we will build FMP, Alpha Vantage, and FRED natively in TypeScript, rather than bridging to a Python-based OpenBB backend.

## Files
- `[MODIFY] .env.local`: Appended `ALPACA_PAPER_API_KEY` and `ALPACA_PAPER_SECRET_KEY`.
- `[MODIFY] src/lib/types.ts`: Verified existing order/position interfaces are compatible.
- `[NEW] src/lib/alpaca.ts`: Created the `AlpacaBrokerGateway` implementing `AlpacaGateway` to interface with the Alpaca Paper environment using `@alpacahq/alpaca-trade-api`.
- `[MODIFY] src/lib/db.ts`: Added `user_api_keys` schema, along with `getUserApiKey` and `setUserApiKey` helpers for per-user settings.
- `[NEW] test/alpaca-ping.ts`: Test script to verify the Alpaca credentials (successfully verified).

## Verification
- Ran `npx tsx --env-file=.env.local test/alpaca-ping.ts` and successfully fetched the Paper Account (100k equity, 400k buying power).

## Follow-ups
- Need to expose the `AlpacaGateway` alongside the `RobinhoodGateway` in the broker logic (`src/lib/dashboard.ts`, `src/lib/strategy.ts`) so the agent can execute via Alpaca instead of just Mock Robinhood.
- Need to build the frontend Settings UI for users to securely input their API keys into the DB.
