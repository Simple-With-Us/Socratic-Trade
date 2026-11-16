## Complete Backend Surface Inventory

I've created a **951-line markdown report** documenting the entire backend surface:

### 📋 Report Location
`/tmp/claude-0/-home-user-agentic-trading/50891747-d8ff-5e89-91d7-bd23dbc1c4ae/scratchpad/backend_inventory.md`

### 📊 Contents

**1. API Routes (78 routes)** — Every `app/api/*/route.ts` with methods + one-line purposes:
- Authentication & account management (9 routes)
- Strategy & policy management (9 routes)
- Execution & trading (7 routes)
- Monitoring & history (5 routes)
- Chat & LLM (2 routes)
- Alerts & learning (5 routes)
- Configuration & keys (5 routes)
- Mobile (7 routes)
- Admin (13 routes)
- Webhooks & external (2 routes)
- Utility (7 routes)

**2. Database Schema** — 35 CREATE TABLE statements with:
- Column names + types
- Primary keys & unique constraints
- Index definitions
- Purpose annotations
- Scoping notes

Tables organized by category:
- Core execution (strategy_runs, trade_proposals, fill_events, portfolio_snapshots)
- Strategy configuration (strategy_profiles, account_strategy_state)
- Accounts & credentials (connected_accounts, user_api_keys)
- Risk management (synthetic_trailing_stops, broker_protective_stops, take_profit_trims)
- Tax & learning (skipped_candidate_counterfactuals, learned_context, etc.)
- Chat & settings (chat_turns, user_settings, notifications, watchlist)
- Usage tracking (llm_usage, rag_usage, api_health_log)
- Data ingestion (ingested_accessions, imported_price_eod, etc.)
- Mobile command queue (mobile_commands — v8)
- Account deletion (account_deletion_requests, account_deletion_audit — v4)

**3. Policy/Prompt/ScoringWeights Persistence**
- **User-level library**: `strategy_profiles` (copyable templates per user_id)
- **Account-level LIVE state**: `account_strategy_state` (scoped by user_id + connected_account_id)
- **ConnectedAccountId scoping**: Each account is isolated with its own policy, prompt, and system_state
- **Initialization**: Lazy-seeded on first read via `getPolicy()`

**4. Wash-Sale Function Call Sites** — EVERY consumer of the three functions:

| Function | Location | Callers | Call Count |
|----------|----------|---------|-----------|
| `getUserWashSaleLockedSymbols(userId, now)` | src/lib/tax.ts:110 | policy.ts:321, strategy.ts:219/1552, 5 test files | 7 call sites |
| `getWashSaleLockedSymbolsForUser(accounts, now, userId)` | src/lib/tax.ts:99 | tax.ts:116 (internal), 2 test files | 3 call sites |
| `getWashSaleLockedSymbols(accountNumber, source, now, userId)` | src/lib/tax.ts:75 | tax.ts:104/232 (internal), 3 test files | 5 call sites |

**Return-Type Change Impact**: All three functions return `Set<string>`. Any change requires coordinating:
- Import sites (policy.ts, strategy.ts, test files)
- Test mocks (policy.test.ts, strategy-hardening.test.ts, staleness-gate.test.ts)
- getTaxSummary() caller at line 232 (converts to array for API response)

---

The report is ready for your data-model/API-change spec and provides the exact file:line citations you requested.
