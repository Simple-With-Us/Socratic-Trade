# 2026-06-19 - Broker Connection UI Split

## Summary
Split the unified "Add Account" UI into distinct buttons for each broker (Alpaca vs Robinhood) and customized the editing form to only require API Keys and Secrets for Alpaca. 

## Why
As the system scales to support multiple brokers (Robinhood, Alpaca, and potentially IBKR in the future), each broker has entirely different authentication requirements. Robinhood uses an OAuth flow via the MCP server and doesn't need API keys pasted into the dashboard form, whereas Alpaca uses static API keys. Separating them prevents user confusion.

## Files
- `[MODIFY] app/dashboard-client.tsx`:
  - Replaced the generic "Add Account" button with distinct "Add Alpaca" and "Add Robinhood" buttons.
  - Removed the `Broker` `<select>` field from the `editing` form.
  - Conditionally render the `API Key` and `API Secret` inputs only if `editing.broker === "alpaca"`.

## Verification
- `npx tsc --noEmit` - passed.
- `npm test` - passed.
- `npm run build` - passed.

## Follow-ups
- Hook up the "Add Robinhood" manual form logic strictly to "Mock" mode, or redirect directly to the OAuth route instead of showing a manual form at all, depending on future user preference.
