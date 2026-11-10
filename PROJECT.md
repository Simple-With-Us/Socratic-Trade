# Project: Next Evolution of Agentic Trading System

Consolidated roadmap after merging public-repo ("Atlas") efforts into the private dashboard. See `docs/atlas-integration-map.md` for the feature mapping.

## Architecture (private repo — canonical)
- **Tri-State Execution Safety**: Test / Paper / Brokerage driven by the active connected account; Start/Stop + approval-mode controls; autonomy gate.
- **Trailing Stop-Loss Engine**: Synthetic trailing stops in SQLite for Robinhood MCP; Alpaca native path deferred (H3).
- **IRA Taxation Settings**: `taxation_type` on connected accounts; 0% tax + wash-sale bypass for IRAs; no tax-loss harvest; cross-account taxable loss lockout.
- **Multi-Tenant RAG & Rate-Limit Hardening**: Pinecone user-or-public filter, Voyage jitter, publication dates on chunks.
- **User Watchlist + Price Alerts** (ported from public repo): persisted symbols + threshold alerts evaluated on the scheduler tick.
- **LLM Prompt Compaction & Consensus**: Bull → Bear → Red Team loop with deterministic parameters.

## Milestones
| # | Name | Scope | Status |
|---|---|---|---|
| M1 | Tri-State Safety & Autonomy | Safety banner, Start/Stop, approval modes, hourly cap | **SHIPPED** |
| M2 | Trailing Stop-Loss | `synthetic_trailing_stops`, scheduler monitor, H4 gated exits | **SHIPPED** (synthetic); native Alpaca deferred |
| M3 | IRA Taxation Settings | `taxation_type`, cross-account wash sale | **SHIPPED** |
| M4 | Multi-Tenant RAG & Rate Limits | Pinecone/Voyage hardening | **SHIPPED** |
| M5 | Watchlist + Price Alerts | Public-repo port into Next.js API + scheduler | **SHIPPED** (API/backend); UI deferred |
| M6 | Chat Assistant + History | Atlas orchestrator patterns | **PLANNED** |
| M7 | E2E Testing & Verification | Full verification gate on every change | **ONGOING** |

## Public repo reference
- Design docs: `docs/atlas/`
- Provenance: `reference/atlas-public/`
- Upstream: https://github.com/jaywedgeworth22/public
