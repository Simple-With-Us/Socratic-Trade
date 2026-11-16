1. **Context & Objective**: The dashboard was silently swallowing `getPortfolio` failures (e.g., from the Robinhood agentic MCP), causing the `availableSpend` to fall back to the policy limit ($1,000) and incorrectly displaying "$1,000 opening authority" for failed or unfunded accounts. This change exposes the actual portfolio fetch error directly in the UI so users and agents can diagnose MCP connectivity issues immediately without checking server logs.
2. **Changes Made**:
   - Added `portfolioReadError` to `DashboardSnapshot` in `app/dashboard-types.ts`.
   - Populated `portfolioReadError` during the `handlePortfolioReadFailure` catch block in `src/lib/dashboard.ts`.
   - Updated the `app/console/page.tsx` UI to conditionally render a warning chip displaying the `portfolioReadError` when present, skipping the fallback `$1,000 capNotional` block.
3. **Decisions & Trade-offs**: We chose to truncate the displayed error at 50 characters in the chip title to prevent layout breaking, with the full error text available on hover (standard `title` attribute).
4. **Verification State**: 
   - `npx tsc --noEmit && npm test -- --passWithNoTests && npm run build`
   - Build passes, 5431 tests passed.
5. **Next Steps & Blockers**: Land the branch.
6. **Zero-Code Findings**: The "+70% vs SPY" calculation in the PWA is caused by Time-Weighted Return (TWR) incorrectly seeing a massive paper reset or MCP portfolio spike as alpha/growth, because it couldn't infer the external cash flow. The exact error for the `agentic` account will now be visible in the UI.
