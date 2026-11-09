## Summary

The spec covers **10 major sections** with precise line citations:

### **1. Component Hierarchy**
- `DashboardClient` (675–681): SSR wrapper
- `DashboardBootstrap`: Fetches initial snapshot
- `DashboardApp` (876–2051): Core orchestrator with header, body grid, workspace tabs, overlays

### **2. Major Sub-Components** (18 documented)
- **Workspace tabs** (7): Decision, Assistant, Market Scan, Smart Money (congressional/insider), Macro, Performance, Tax, Strategy
- **Feed SlideOver tabs** (4): Activity, Runs, Notifications, Audit Log
- **Modals** (6): Strategy Studio, Settings (9 sections), Help, Accounts, Account Deletion, Tuning Card

### **3. State Management** (30+ useState variables documented)
- **Snapshot & data:** Full dashboard state + load errors
- **Navigation:** workspaceTab, feedTab, modal open flags
- **Overlays:** Settings section, drilldown symbol, learned queue, confirmations
- **Display:** Ticker logos, execution banner mode, test-account hiding
- **Operation:** Strategy tuning, pending proposals, live order confirmations

### **4. localStorage Keys** (9 documented with line numbers)
- `ticker-logo-display` (187, 964, 989)
- `execution-banner-mode` (194, 966–967, 1008) + legacy migration
- `dashboard-workspace-tab` (197, 280, 1033)
- `dashboard-feed-tab` (198, 290, 1041)
- `strategy-tuning-proposal` (199, 316, 1050–1052)
- `scan-visible-cols-v5` (2808, 2847)

### **5. Rendering Flows** (detailed for 9 major patterns)
- Workspace tab switching (localStorage persisted)
- Feed SlideOver with nested tabs
- Symbol drilldown (uses `tickerScan` fetched on mount at line 949)
- Settings modal with 9 nested sections
- Strategy Studio (prompt auto-save at 800ms debounce, line 1178)
- Strategy Flow, Help, Accounts modals
- Confirmation dialogs (kill/start, autonomous exec, live orders, market replacement, consent gate)

### **6. Data Fetching** (28 API endpoints documented)
- **SSE/Real-time:** `/api/events/stream` (line 1072) with 5 event types + fallback 2-min poll (line 1061–1066)
- **Core:** `/api/dashboard` (fetch on mount & after actions)
- **Strategy:** `/api/strategy/run`, `/api/strategy/tune`
- **Approvals:** `/api/proposals/{id}/approve/reject`
- **Accounts:** `/api/connected-accounts` CRUD, `/api/profiles` CRUD
- **Settings:** `/api/policy`, `/api/keys`, `/api/consent`, `/api/learned-context/sharing`
- **Scan:** `/api/scan` (ticker lookup source)

### **7. Complex Workflows**
- Strategy tuning lifecycle (request → display → apply/discard + localStorage)
- Live order confirmation (mode-aware, with desktop modal gate)
- Market scan column picker (state → localStorage restore)
- Execution mode banner legacy migration

### **8. Decomposition Roadmap** (high/medium/low priority)
**High-priority extracts:**
- `SettingsContent` (1060 lines, 9 sections) → 9 separate components
- `IntegrationsSection` (441 lines) → separate module
- `MarketScanView` (391 lines) → virtualized table extraction
- `DecisionView` (277 lines) → extract proposal card grid
- `StrategyStudio` (159 lines) → move to `app/components/`

**Consolidations:**
- All localStorage keys → `lib/dashboard-storage.ts`
- API endpoints + error handlers → `lib/dashboard-api.ts`
- Type guards (isWorkspaceTab, isFeedTab, isStrategyTuningProposal) → `lib/dashboard-types.ts`

The spec shows how to decompose from 7,015 lines to ~2,500–3,000 core lines while keeping all routing/state logic intact.
