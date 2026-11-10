# Rollout: UI and Settings Toggles Cleanup (2026-08-23)

## Summary
Cleaned up the UI and settings toggles to reflect that "Live or Paper" is just a difference in endpoint, and made feature visibility strictly capability-driven.

## Changes
1. **Paper Banner Formatting:** The Paper Trading reality banner was updated to use a middle dot (•) and proper styling ("PAPER TRADING" in the native tone color, while the clarification "broker provided practice account" is rendered in black text).
2. **Removed "Live vs. Paper" Distinctions:**
   - Removed `optionsLiveOrdersEnabled` and `kalshiLiveOrdersEnabled` from `TradingPolicy`. The UI no longer implies that paper is required before live.
   - Updated wording throughout the settings (Options, Event Contracts, Short Selling, Autonomy block, etc.) to remove any "live" or "paper" caveats.
3. **Capability-Driven Visibility:**
   - **Options Trading:** The toggle now only shows if the connected account (`caps.optionsTrading`) supports it, and is no longer a global toggle.
   - **Short Selling:** The short selling block is strictly hidden if the account capabilities (`caps.shortSelling`) do not support it.
   - **Kalshi Event Contracts:** The `eventContractsEnabled` toggle only renders if the connected broker is explicitly `"kalshi"`.
   - **Kalshi Macro Data:** Added a new `kalshiMacroEnabled` policy toggle, which is defaulted to `true` and shown unconditionally across all accounts (so non-Kalshi accounts can use Kalshi event data for macro context). This is now wired into the `fetchKalshiMacroContext` data fetcher.
4. **Defaults:** `optionsTradingEnabled`, `eventContractsEnabled`, and `kalshiMacroEnabled` now all default to `true` on new policies. Alpaca's base capabilities were also updated to accurately reflect `optionsTrading: true`.

## Testing
- Verified `npx tsc --noEmit` and `npm run lint` pass with no errors.
- Confirmed correct conditional checks in `app/console/guardrails/page.tsx` for rendering the sections.
