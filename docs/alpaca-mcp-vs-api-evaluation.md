# Alpaca MCP Server vs. Direct REST API Evaluation

This document evaluates the trade-offs of using the official **Alpaca Model Context Protocol (MCP) Server** versus direct integration with the **Alpaca REST API** within this broker-neutral trading system.

---

## Update 2026-06-30 — two different "MCP" scenarios, don't conflate them

This doc (below) is entirely about **Scenario 1**: an external chat client (Claude
Desktop, Cursor) connecting *directly* to Alpaca's MCP server, bypassing this app. That
framing is correct and the cautions below still apply to it.

It does not cover **Scenario 2**, which already exists in this codebase: this app's own
backend calling Alpaca's MCP server as a network transport instead of the REST SDK (the
`alpaca-mcp` broker type / `AlpacaBrokerGateway`'s `isMcp` flag, see
`docs/rollouts/2026-06-21-alpaca-mcp-integration.md`). In Scenario 2, MCP is fully wrapped
by the same policy/cap/review/persistence pipeline as REST — every order still goes
through `executeProposal`/the run-loop's guardrails before `gateway.placeEquityOrder()` is
called; the "State Synchronization: Out-of-Sync" and "Safety & Guardrails: None" rows in
the table below do **not** apply to it. It's a transport choice (REST vs. MCP-as-a-network-
protocol to reach the same Alpaca API), not a safety bypass. Robinhood's entire
integration is this same Scenario 2 pattern — Robinhood has no REST alternative, so MCP
there is a network-transport default, not an optional add-on.

Full cross-broker MCP evaluation (Alpaca, Robinhood, eToro, Public.com, IBKR) — including
which brokers even *have* a trading-capable MCP server (eToro's official one is
docs-only, for example) — lives in `docs/broker-capability-plan.md` §7. Read that doc
first if the question is "should we use MCP for broker X."

---

## 1. Architectural Roles

- **Alpaca REST API**: Programmatic, deterministic access used by our server-side Next.js loops. All actions go through our local database, state tracker, and safety engines.
- **Alpaca MCP Server**: A bridge exposing Alpaca endpoints as tools that the LLM agent can call directly in a chat session.

---

## 2. Key Differences & Trade-offs

| Dimension | Direct REST API (Next.js Application) | Alpaca MCP Server (LLM Tool) |
| :--- | :--- | :--- |
| **Safety & Guardrails** | **Complete.** Checks daily limits, sector caps, blocklists, and tax wash-sale rules before placing orders. | **None.** Bypasses the application’s safety logic, executing orders directly. |
| **State Synchronization** | **Synchronized.** Orders are tracked, persisted to SQLite, and update the UI dashboard instantly. | **Out-of-Sync.** Orders placed directly are unknown to the database until the next sync/poll cycle. |
| **Automation** | **Autonomous Loops.** Runs scheduled scan-to-order cron jobs without developer intervention. | **Interactive Only.** Requires active LLM chat context/execution steps to trigger. |
| **Options & Greeks** | Complex to build custom parsing for options chains. | Excellent for asking the LLM to search option chains or build spreads dynamically. |
| **Developer Ergonomics** | Must write, compile, and maintain TypeScript client code. | Plug-and-play. No code needed; just add keys to the configuration. |

---

## 3. Detailed Comparison

### A. Safety and Compliance (Critical for Trading)
- **Direct API (Recommended)**: The application acts as a gatekeeper. If the LLM proposes buying 1,000 shares of a symbol, the system verifies `policy.maxDailyNotional` and `taxSettings.washSaleGuard`. If the check fails, the order is blocked.
- **MCP Server**: Executes directly at the API level. However, **Alpaca MCP V2** introduces **Tool Filtering and Whitelisting** via the `ALPACA_TOOLSETS` environment variable. This allows you to restrict the LLM to specific tools (e.g., only account statistics or market data), blocking execution of order commands (`post_order`, etc.).

### B. Portfolio & Order History Tracking
- **Direct API**: Every transaction maps to a local trade ID, linked to audit trails, notification logs, and tax ledger entries.
- **MCP Server**: Actions taken by the LLM through the MCP server are executed outside the application's lifecycle. While the positions would eventually show up when fetching the account portfolio, the app would lack local context (such as the specific strategy prompt, run state, or target thesis that spawned the trade).

---

## 4. MCP V2 Configuration Guide
Unlike V1, which required a local `.env` and `init` commands, **Alpaca MCP V2** is configured entirely within the MCP client configuration (e.g. `claude_desktop_config.json`):

```json
"alpaca": {
  "command": "uvx",
  "args": ["alpaca-mcp-server"],
  "env": {
    "ALPACA_API_KEY": "YOUR_API_KEY",
    "ALPACA_API_SECRET": "YOUR_API_SECRET",
    "ALPACA_API_BASE_URL": "https://paper-api.alpaca.markets",
    "ALPACA_TOOLSETS": "account,market_data" 
  }
}
```
*Note: Specifying `ALPACA_TOOLSETS` (e.g. `account,market_data`) is highly recommended to block the agent from initiating trades directly in chat.*

---

## 5. Recommendations

### When to use the Direct REST API (Current System)
1. **Automated Trading**: All automated strategies (`Propose` and `Decide` modes) should use the direct REST API client to enforce policy ceilings, risk profiles, and tax compliance.
2. **Audit Trails**: Anything requiring database logging, reporting, or notifications must go through the core application codebase.

### When to use the Alpaca MCP Server
1. **Interactive Chat Assistance**: Enable it in your personal Claude Desktop or Cursor configuration for developer tasks (e.g., asking "How much cash buying power do I have right now?" or "Create a watchlist called 'Tech' with AAPL and MSFT").
2. **Options Explorations**: Useful for querying live option contract pricing, Greeks, and chains dynamically in the chat window.

*Caution: If you add the Alpaca MCP server to your desktop client, it is highly recommended to configure it using a **Paper Trading API Key** or use the V2 `ALPACA_TOOLSETS` restriction feature to restrict it to **read-only/market data** mode. This protects your live accounts from accidental or unintended executions.*
