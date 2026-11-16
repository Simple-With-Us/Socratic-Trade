# Appendix A — Current-State Maps (forensic baseline)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

## A1. Navigation map

## Navigation & Information Architecture Map — Complete

I have created a **precise, comprehensive map** of every navigation surface in the Agentic Trading dashboard. Here's what I found:

### **Scope: ~40+ Navigation Surfaces**

1. **7 Primary Workspace Tabs** — Decision, Assistant, Market Scan, Macro, Performance, Tax, Strategy
2. **4 Secondary Feed Tabs** — Activity, Runs, Notifications, Audit (in slide-over modal)
3. **9 Settings Sections across 2 Tiers** — 4 User-level (Connections, Display, Notifications, Data) + 5 Account-level (Strategy, Operate, Safety/Risk, Tax, Tuning)
4. **7 Major Modal Overlays** — Strategy Studio, Strategy Flow, Accounts, Help, Symbol Drilldown, Market Replace, Learned Context Queue
5. **Profile Menu** — 8 items including Activity, Settings, Accounts, Help, Sign Out
6. **14 Command Palette Commands** — Jump to tabs, open modals, run strategy, sign out
7. **9 Separate Routes** — /welcome, /strategy, /mobile, /login, /admin/* (4 pages)

---

### **10 Critical Redundancy & Overlap Issues**

**#1: Strategy Config in 4+ Places**
- Workspace "Strategy" tab
- Strategy Studio modal
- Settings → Account → "Strategy" section
- Settings → Account → "Operate" section (universe affects strategy visibility)
→ Users don't know the canonical editing location.

**#2: Duplicate Tab Labels** (Tax, Notifications)
- "Tax" is both a workspace tab (view outcomes) AND a settings section (configure rules)
- "Notifications" is both a feed tab (view alerts) AND a settings section (configure delivery)
→ UI is ambiguous: does the label mean "view" or "configure"?

**#3: Settings Tier Split Not Visible**
- Code has `ACCOUNT_SETTINGS_SECTIONS` (line 165)
- UI has a tier toggle, but users don't understand user-level vs. account-level until they open Settings
→ New account creation leaves users confused: "Did this apply to all accounts or just this one?"

**#4: Market Scan Settings Inconsistency**
- Transient slider in Market Scan panel header (ephemeral)
- Persistent setting in Settings → Account → "Data" section
→ Users don't know if changes persist.

**#5: Strategy Flow Not Linked to Editing**
- Flow visualizer only accessible from Strategy tab or command palette
- NOT accessible from Strategy Studio or Settings → Strategy
→ You edit the strategy, then must navigate away to see the pipeline status.

**#6: "Operate" Label Is Vague**
- Contains execution mode (Test/Paper/Brokerage), universe, scan limits
- Name doesn't convey it's the place to switch broker modes
→ Hidden discovery path.

**#7: Account Switching Buried**
- Header has account selector (for portfolio *view*)
- Settings have account selector (for strategy *policy* context)
- No main navigation account switcher for multi-account users
→ Multi-account workflow is non-obvious.

**#8: Profile Copy-to-Account Only in Strategy Tab**
- If you're in Settings → Strategy, no copy UI
- Must close Settings, go to Strategy workspace tab, use copy dropdown
→ Friction in a core multi-account workflow.

**#9: Help Not Contextual**
- Help modal has Settings Glossary tab, but no links from actual Settings
- Users read help, then manually navigate to settings
→ No cross-linking.

**#10: Learned Context Queue Badge Has No Preview**
- Header shows count, but full panel requires click
- No quick-access dropdown in header
→ Minor: low discoverability.

---

### **Conceptual Confusion: Three Overlapping Models**

1. **Connected Accounts** (Alpaca Paper, Alpaca Live, Robinhood, Test/local-sim) — broker links; policy stored per-account
2. **Strategy Profiles** (named presets) — reusable bundles of (policy + prompt + weights); can be copied to accounts
3. **User-Tier Settings** (global; Connections, Display, Notifications, Data) — shared across all accounts

→ No clear terminology or visual distinction in UI; users ask "Does this profile apply to all accounts or just this one?"

---

### **Output Artifact**

I've generated a **complete reference document** with:
- **Every navigation surface** (tabs, settings sections, modals, routes) with file:line citations
- **Three-level setting hierarchy** (tier selector → section tabs → individual controls)
- **10 detailed redundancy findings** with evidence, impact, and line numbers
- **Recommendations** for redesign (unify strategy editing, clarify tiers, add contextual help, rename vague sections)

This map is a precise inventory of the current state—**not a redesign**, but a forensic baseline for your redesign conversations with the team.

## A2. Settings surface map

## COMPLETE SETTINGS SURFACE ENUMERATION

### TIER ARCHITECTURE (Explicit)

**ACCOUNT-TIER** (scoped per connected account — stored per connectedAccountId):
- Strategy | Operate | Safety (Risk) | Tax | Tuning

**USER-TIER** (global to user — shared across all connected accounts):
- Connections | Display | Notifications | Data

---

## SETTINGS BREAKDOWN BY SECTION

### **1. STRATEGY** (Account-scoped)

**Controls:**
- **Green Team Model** (llmModel) — LLM model for proposals; readonly display in Settings tab (full control in Strategy Studio modal)
- **Red Team Model** (redTeamLlmModel) — Bear/adversarial reviewer model; readonly display in Settings tab (full control in Strategy Studio modal)
- **Reasoning Effort** (llmReasoningEffort: low|medium|high) — reasoning token budget for o-series models; readonly display in Settings tab (full control in Strategy Studio modal)

**Issue:** Settings tab shows ONLY readonly summaries. All actual strategy config (prompt, scoring weights, green/red/reasoning) lives in the separate "Strategy Studio" modal, accessed via a button. This is the first manifestation of the fragmentation complaint.

---

### **2. OPERATE** (Account-scoped)

**Controls:**
- **Execution Mode Banner** — shows current mode (Test/Paper/Live) — readonly informational display
- **Base Indexes** (includedIndices: sp100|sp500|nasdaq100|nasdaqComposite|dow30|russell2000|nyseComposite|ftWilshire5000) — multi-select checkboxes
- **Additional Watchlist** (additionalSymbols: string[]) — user-added individual tickers on top of base indexes
- **Ignore List** (blocklist: string[]) — tickers to subtract from all universes
- **Approval Mode** (strategyAuthority: propose|decide) — "Propose Mode" (user approves each order) vs "Autonomous Mode" (auto-executes within limits)
- **Holding Horizon** (holdingHorizon: intraday|swing|position|longterm) — LLM guidance for setup, exit timing, and tax framing
- **System State** (systemState: active|halted|close_only|liquidating) — Start/Stop button to toggle between active and halted
- **Setup Blocked Reason** — conditional warning if certain required fields are missing

---

### **3. SAFETY (Risk)** (Account-scoped)

**Account Circuit Breakers:**
- **Max Drawdown %** (riskRules.maxDrawdownPct) — auto-switch to close-only if account falls this far from high-water mark
- **Max Daily Loss ($)** (riskRules.maxDailyLossNotional) — auto-switch to close-only on daily loss amount

**Volatility Panic Brake:**
- **Enabled toggle** (volPanicBrakeEnabled: boolean) — on by default
- **VIX ≥ threshold** (volPanicVixThreshold, default 40)
- **VVIX ≥ threshold** (volPanicVvixThreshold, default 150)
- **SKEW ≥ threshold** (volPanicSkewThreshold, default 160)

**Whole-Portfolio Exposure Caps:**
- **Max Gross Exposure %** (maxGrossExposurePct, default 80) — sum of long + absolute short value
- **Max Net Exposure %** (maxNetExposurePct, default 80) — long minus short (directional exposure)

**Stops & Exits:**
- **Trailing Stop %** (riskRules.trailingStopPct) — percentage-based trailing stop
- **Take-Profit Trim %** (riskRules.takeProfitTrimPct, default 50) — what fraction to sell at profit
- **ATR (volatility) Stops toggle** (atrStops: boolean) — use volatility-aware stops
  - **ATR Period (days)** (riskRules.atrStopPeriod, default 14)
  - **ATR Multiple** (riskRules.atrStopMultiple, default 2.0)
- **Robinhood Broker-Held Stop toggle** (robinhoodBrokerStops: boolean, RH live-only) — place resting stop at broker
- **Per-broker Stop Support Info** — readonly table showing Alpaca OCO, Robinhood GTC stop, or Test simulation

**Short-Selling Limits:**
- **Short Stop-Loss %** (riskRules.shortStopLossPct) — REQUIRED when short selling is enabled; defaults to 8% since 2026-07-09 (`DEFAULT_RISK_RULES`), so the requirement is auto-satisfied unless explicitly cleared
- **Max Short Order ($)** (maxShortOrderNotional)
- **Max Short Exposure %** (maxShortExposurePct)

**Order Execution:**
- **Permitted Order Types** (permittedOrderTypes: market|limit|stop_market|stop_limit) — checkboxes for which types are allowed
- **Max Order % of ADV** (maxOrderPctOfAdv) — cap order size relative to daily dollar volume
- **Stale Limit Alert (min)** (staleLimitOrderMinutes, default 15) — alert if broker limit order sits without fill
- **Allow Extended-Hours ORDERS toggle** (permitExtendedHours: boolean) — separate from "Run during extended hours"
- **Marketable Limit Entries toggle** (marketableLimitEntries: boolean) — rewrite opening markets as marketable limits
- **Fire Synthetic Stops in Extended Hours toggle** (allowExtendedHoursSyntheticStops: boolean)

**Universe Floor (Penny/Illiquid Exclusion):**
- **Min Share Price $** (universeFloor.minPrice) — primary penny-stock gate for scanned candidates
- **Min Market Cap $** (universeFloor.minMarketCapUsd) — filters below-cap candidates only when data is known
- **Min Daily $-Volume** (universeFloor.minDollarVolume) — liquidity floor for scanned universe only

---

### **4. TAX** (Account-scoped)

**Controls:**
- **Account Tax Treatment** (taxSettings.taxationType: taxable|roth_ira|traditional_ira) — dropdown
- **Wash-Sale Guard toggle** (taxSettings.washSaleGuard: boolean) — block rebuy within 30 days of loss
- **Short-Term Rate (%)** (taxSettings.shortTermRatePct, default 24) — estimated ordinary-income tax rate
- **Long-Term Rate (%)** (taxSettings.longTermRatePct, default 15) — estimated capital-gains rate
- **Subtract Estimated Tax From Results toggle** (taxSettings.subtractFromResults: boolean) — show P&L net of tax

---

### **5. TUNING** (Account-scoped)

**Learning Loop Parameters:**
- **Shrinkage Prior (trades)** (tuning.shrinkPrior, default 5) — Bayesian pseudo-trades for small-sample skepticism
- **Min Lots for Weight Shift** (tuning.minClosedLotsForWeightShift, default 20) — gate for auto-tuner weight changes
- **Sizing Floor (% of max)** (tuning.sizingFloorPct, default 10) — minimum exploratory position size
- **Sizing Ceiling (% of max)** (tuning.sizingCeilingPct, default 100) — maximum size before risk caps apply
- **Red-Team Threshold** (tuning.redTeamConvictionThreshold, default 80) — proposal confidence triggering adversarial review
- **Crisis Open Cap (% NAV)** (tuning.crisisMaxOpeningExposurePct, default 0 = off) — block new openings in crisis/inverted regime
- **Min Proposal Score Threshold** (tuning.minProposalScoreThreshold, default 0) — drop candidates below this 0–100 score before LLM
- **FCF-Yield Veto Floor %** (tuning.bearVetoFcfYieldFloorPct) — deterministic veto on low-FCF buys
- **Debt/Equity Veto Ceiling** (tuning.bearVetoDebtToEquityCeiling) — deterministic veto on high-leverage buys
- **Skip Proven Money-Losers (Negative-EV Gate) toggle** (tuning.skipNegativeExpectancy: boolean)
  - **Negative-EV Skip Threshold %** (tuning.skipNegativeExpectancyEdgePct, default 0)

---

### **6. CONNECTIONS** (User-scoped)

**Controls:**
- **API Keys Section** — manages provider keys (LLM, data, broker gateways) and broker account links
  - Provider keys (OpenAI, FMP, etc.) — encrypted, server-only
  - Broker accounts (Alpaca paper/live, Robinhood, Test) — link/unlink, manage labels and credentials

---

### **7. DISPLAY** (User-scoped)

**Controls:**
- **Account-Mode Banner** (executionBannerMode: full|compact|hidden) — Test/Paper/Brokerage banner size
- **Ticker Logos** (tickerLogoDisplay: tile|transparent|off) — logo style or off
- **Logo Preview** (readonly) — shows sample logos in chosen style

---

### **8. DATA** (User-scoped)

**Market Scan Controls:**
- **Candidate Cap** (policy.marketScanCandidateLimit, default 25) — top-ranked candidates sent to LLM
- **Outlier Reserve** (policy.marketScanOutlierReserve, default 5) — below-cutoff notable candidates with congressional/insider/technical signals

**Shared Data Pool:**
- **Sharing toggle** (poolConsent: boolean) — opt in/out of shared general market data pool (quotes, fundamentals, price history, news)

**AI-Learned Facts Sharing:**
- **Include Shared Learnings toggle** (lcSharing.includeShared: boolean) — use facts shared by other opted-in users
- **Contribute My Learnings toggle** (lcSharing.contributeShared: boolean) — share your own learned facts

**Account Deletion:**
- **Delete Account Panel** — option to permanently delete user account

---

### **9. NOTIFICATIONS** (User-scoped)

**Controls:**
- **Notifications Webhook** (policy.notificationSettings.webhookUrl) — HTTP endpoint to receive notifications
- **Send Notifications For** (policy.notificationSettings.enabledEvents) — checkboxes for event types:
  - fill, block, run_failed, pending_approval, kill_switch, limit_order_stale, provider_degraded, (plus price_alert, proposal_withdrawn implied in code)
- **Direct Delivery Channels** (email/SMS/push) — send alerts straight to user via configured providers

---

## SETTINGS OUTSIDE THE 9 MODAL SECTIONS

These controls live OUTSIDE the Settings Modal but affect account behavior:

### **Strategy Studio Modal** (accessible from Settings → Strategy → "Open Strategy Studio" button)
- **Strategy Prompt** (policy.strategyPrompt) — the LLM's full system prompt (editable textarea)
- **Scoring Weights Matrix** (policy.scoringWeights: liquidity|momentum|value|quality|volatility|sentiment|positioning|diversification) — factor weights for candidate scoring (8 sliders)
- **Green/Red Team Model Selection** (policy.llmModel, policy.redTeamLlmModel) — full controls (vs readonly in Settings)
- **Reasoning Effort** (policy.llmReasoningEffort) — full control
- **LLM Strategy Review** — advisory review button + tuning proposal application

### **Strategy Tab Workspace** (separate from Settings)
- Contains "Key Parameters" card with inline-editable fields:
  - Max order ($⇄%)
  - Daily cap ($⇄%)
  - Symbol cap (%)
  - Stop loss ($⇄%)
  - Take profit ($⇄%)
  - Max proposals/run
  - Cadence (min)
  - Max daily orders
  - Max hourly notional ($)
  - Max portfolio beta
  - Max avg correlation
  - Max entry drift (%)
  - Max quote age (sec)
  - Max fundamentals age (sec)
  - Sell to fund buys (off|suggest|propose|automated)
  - Sector Caps (text field: "Technology:25, Financials:20")
  - Run during extended hours (checkbox)
  - Enable short selling (toggle)
  - Broker-held brackets (toggle)
  - Beta-scaled stops (toggle)

- Contains "LLM Strategy Review" card with review generation button

---

## CRITICAL ISSUES & DUPLICATIONS

### **Duplicated/Fragmented Settings:**

| **Setting** | **Appears In** | **Issue** |
|---|---|---|
| **Green Team Model** | Settings → Strategy (readonly) + Strategy Studio modal (editable) | **Tier ambiguity**: strategy config split across two UI entry points; Settings shows only summary |
| **Red Team Model** | Settings → Strategy (readonly) + Strategy Studio modal (editable) | Same as above |
| **Reasoning Effort** | Settings → Strategy (readonly) + Strategy Studio modal (editable) | Same as above |
| **Scoring Weights** | NOT in Settings at all; only in Strategy Studio modal | **Missing from Settings**: user must navigate to separate modal to access |
| **Strategy Prompt** | NOT in Settings; only in Strategy Studio modal | **Missing from Settings**: the core strategic directive lives elsewhere |
| **Max Order**, **Daily Cap**, **Symbol Cap**, **Stop Loss**, **Take Profit** | Operate section (missing) + Strategy workspace "Key Parameters" card (editable) | **Never appears in Settings modal**; user must go to Strategy tab or Settings → Operate (which doesn't show them) |
| **Max Proposals/Run**, **Cadence**, **Max Daily Orders**, **Max Hourly Notional** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Max Portfolio Beta**, **Max Avg Correlation**, **Max Entry Drift**, **Quote/Fundamentals Age** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Sector Caps** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Sell to Fund Buys** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Run During Extended Hours** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Enable Short Selling** | NOT in Settings → Operate; only in Strategy workspace "Key Parameters" | **Missing from Operate section where it logically belongs** |
| **Broker-Held Brackets** | NOT in Settings → Safety/Risk; only in Strategy workspace "Key Parameters" | **Missing from Risk section where it logically belongs** |
| **Beta-Scaled Stops** | NOT in Settings; only in Strategy workspace "Key Parameters" | **Missing entirely from Settings modal** |
| **Tax** (workspace tab) | Has own independent tab in workspace + Settings → Tax section | **Duplication**: same settings appear in two different tabs |
| **Notifications** (feed tab) | Has own independent feed tab + Settings → Notifications section | **Duplication**: settings split between feed rail and Settings modal |
| **paperMode toggle** | NOT visible in UI; backend-only; mode is actually controlled by top-bar account selector (Test/Paper/Brokerage) | **Hidden setting**: UI doesn't let users explicitly set paperMode; it's derived from account selection |
| **systemState** (active/halted) | Appear both in Operate section (Start/Stop button) AND in Strategy workspace (top-bar status) | **Duplication**: togglable in two places |

---

### **Scope Issues (Wrong Tier):**

| **Setting** | **Current Tier** | **Should Be** | **Problem** |
|---|---|---|---|
| **Scoring Weights** (liquidity, momentum, value, etc.) | Account-scoped (Strategy Studio) | **Correct** | But completely missing from Settings modal |
| **Strategy Prompt** | Account-scoped (Strategy Studio) | **Correct** | But completely missing from Settings modal |
| **Green/Red Team Models** | Account-scoped (correct) | **Correct** | But split between Settings (readonly summary) and Strategy Studio (editable) |
| **Provider API Keys** | User-scoped (Connections) | **Correct** | Documented correctly in Settings → Strategy section note |
| **notificationSettings** | User-scoped (correct) | **Correct** | Settings → Notifications is correct scope |
| **marketScanCandidateLimit** | User-scoped (in Data section) | **Debatable**: could be Account-scoped | User may want different scan breadth per account; currently one global setting |

---

### **Missing from Settings Modal (But Should Be):**

| **Setting** | **Current Location** | **Should Be In** |
|---|---|---|
| Max Order, Daily Cap, Symbol Cap | Strategy workspace "Key Parameters" | Operate section |
| Stop Loss, Take Profit | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Max Proposals/Run | Strategy workspace "Key Parameters" | Operate section |
| Cadence (run frequency) | Strategy workspace "Key Parameters" | Operate section |
| Max Hourly Notional | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Max Portfolio Beta | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Max Avg Correlation | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Max Entry Drift % | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Max Quote/Fundamentals Age | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Sell to Fund Buys | Strategy workspace "Key Parameters" | Operate section |
| Sector Caps | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Run During Extended Hours | Strategy workspace "Key Parameters" | Operate section |
| Enable Short Selling | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Broker-Held Brackets | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Beta-Scaled Stops | Strategy workspace "Key Parameters" | Safety (Risk) section |
| Scoring Weights | Strategy Studio modal only | Strategy section (matrix of 8 sliders) |
| Strategy Prompt | Strategy Studio modal only | Strategy section (textarea) |

---

## CONCLUSION: ROOT CAUSES OF FRAGMENTATION

1. **Four Distinct Settings Surfaces Exist:**
   - Settings Modal (9 sections, split 2-tier)
   - Strategy Studio Modal (prompt + scoring weights + model selection)
   - Strategy Workspace "Key Parameters" Card (majority of operational controls)
   - Strategy Workspace "Strategy Review" Card (advisory tuning)
   - Top-bar Account Selector (sets execution mode → paperMode, which governs Test/Paper/Live)

2. **Strategy Config is Scattered Across 3+ Places Without Clear Reason:**
   - Prompt: Strategy Studio only
   - Scoring weights: Strategy Studio only
   - Green/Red models: Both Settings (readonly) + Strategy Studio (editable)
   - Most operational constraints: Strategy workspace only
   - Risk/safety guards: Settings → Safety section (but some missing)

3. **Account vs User Tier is Poorly Communicated:**
   - Settings Modal makes the distinction visible (separate tab rows for "Account Settings" vs "User Settings")
   - But no other surfaces hint at the scope
   - Users don't know why some settings are tied to a specific account and others global

4. **The Settings Modal is Incomplete:**
   - 9 sections but many key policy fields missing entirely
   - Users expect to configure the entire strategy in Settings, but 50%+ of the controls are elsewhere
   - Operate section lists universe filters but omits the execution constraints it logically should hold

5. **Duplication & Confusion:**
   - Tax settings appear in both a workspace tab AND Settings
   - Notification config split between a feed tab and Settings
   - Same controls appear in multiple places with no clear hierarchy
   - No single "source of truth" for where to go to change a setting

This is a classic product-debt Frankenstein: features added incrementally to different surfaces (modal, workspace card, top-bar selector) without consolidation, resulting in a fragmented mental model for the user.

## A3. Strategy duplication map

## STRATEGY SURFACES ANALYSIS: Fragmentation Report

### EXECUTIVE SUMMARY

The "Agentic Trading" app fragments strategy configuration across **5 primary surfaces** and **2 secondary overlaps**, creating user confusion about "where do I configure X?" This analysis maps every strategy-related capability to its current location, identifies duplications, and reveals why consolidation is imperative for a multi-account product.

---

## CAPABILITY MATRIX: WHERE EACH STRATEGY FEATURE LIVES

| Capability | Strategy Tab | Strategy Studio Modal | Settings→Strategy | Strategy Flow Modal | /strategy Page | Notes |
|---|---|---|---|---|---|---|
| **Edit Prompt** | View only (read-only `<pre>`) | ✅ **Full edit** (textarea) | ❌ | ❌ | ❌ Marketing only | Prompt editing only in Studio |
| **Reset Prompt** | ❌ | ✅ Button | ❌ | ❌ | ❌ | Reset is Studio-only |
| **Green Team Model** | View only (KeyVal display) | ✅ **Dropdown + custom** | ✅ Summary card | ❌ | ❌ | **DUPLICATION**: shown in 2 places, editable in 1 |
| **Red Team Model** | ❌ | ✅ **Dropdown + custom** | ✅ Summary card | ❌ | ❌ | **DUPLICATION**: shown in 2 places, editable in 1 |
| **Reasoning Effort** | ❌ | ✅ **Dropdown** (conditionally for gpt-5/o-series) | ✅ Summary card | ❌ | ❌ | **DUPLICATION**: shown in Settings, edited in Studio |
| **Scoring Weights Matrix** | ❌ | ✅ **Full 6-factor grid** | ❌ | ❌ | Documented (Fig. in /strategy) | Only editable in Studio |
| **LLM Green/Red Review** | ✅ Button + inline TuningCard | ✅ **Button + inline TuningCard** | ❌ | ❌ | ❌ | **MAJOR DUPLICATION**: entire feature lives in 2 tabs |
| **Tuning Model Selection** | ✅ Model picker | ✅ **Model picker** | ❌ | ❌ | ❌ | **DUPLICATION**: same picker, 2 locations |
| **Apply/Discard Tuning** | ✅ Buttons on TuningCard | ✅ **Buttons on TuningCard** | ❌ | ❌ | ❌ | **DUPLICATION**: entire proposal flow in 2 tabs |
| **View Tuning Diff** | ✅ Prompt/Risk/Studio changes | ✅ **Prompt/Risk/Studio changes** | ❌ | ❌ | ❌ | **DUPLICATION**: identical diff UI in 2 tabs |
| **Saved Strategy Profiles** | ✅ Dropdown, Save, Copy to account | ❌ | ❌ | ❌ | ❌ | Only accessible in Strategy tab |
| **Activate Profile** | ✅ Dropdown onChange | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Copy Profile to Account** | ✅ Dropdown + button | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Save Current as Profile** | ✅ Input + Save button | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Key Parameters (Sizing, Stops)** | ✅ Editable fields (inline commit) | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Extended Hours** | ✅ Checkbox | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Short Selling** | ✅ Switch | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Broker Brackets** | ✅ Switch | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Beta-Scaled Stops** | ✅ Switch | ❌ | ❌ | ❌ | ❌ | Only in Strategy tab |
| **Strategy Flow Graph** | ✅ Button "Flow" | ❌ | ❌ | ✅ **Interactive ReactFlow** | ❌ | Good separation; accessed via Strategy tab button |
| **How-Strategy-Works Explainer** | ❌ | ❌ | ❌ | ❌ | ✅ **Comprehensive** (6 lenses, safety rules, limitations) | Marketing page; gated by `LANDING_PAGE_ENABLED` |

---

## FRAGMENTATION FINDINGS

### 1. **MASSIVE DUPLICATION: LLM Strategy Review (TuningCard)**

**The Problem:**
- **Strategy Tab (StrategyView)** lines 3687–3727 renders "LLM Strategy Review" section with:
  - StrategyTuningModelSelect
  - "Review strategy" button
  - Full TuningCard with prompt diff, risk/studio changes, apply/discard buttons
  
- **Strategy Studio Modal (StrategyStudio)** lines 4410–4444 renders identical:
  - StrategyTuningModelSelect (same component)
  - "Review strategy" button  
  - Full TuningCard (same component)

**Code Evidence:**
- StrategyView: `requestStrategyTuning`, `tuningBusy`, `tuningError`, `strategyTuning`, `applyStrategyTuning`, `discardStrategyTuning` passed in
- StrategyStudio: **identical props and behavior** (lines 4297–4313)
- Both pass exact same state to TuningCard (line 3725 vs 4441)

**Why it's broken:**
- User must know there are TWO places to run a tuning review
- Both accept the same tuning model selection
- Both apply changes to the same underlying `strategyTuning` state
- Workflow confusion: "I reviewed it in the tab but the proposal disappeared. Where is it?" (It's still in both places; you'd have to find the other one to discard)

---

### 2. **DUPLICATION: Green/Red Team Model + Reasoning Effort**

**The Problem:**

| Location | Edit? | Read-only? | Where shown |
|---|---|---|---|
| Strategy Tab | ❌ | ✅ KeyVal cards (lines 3842–3844) | After scrolling past Key Parameters |
| Settings→Strategy | ❌ | ✅ Summary cards (lines 4842–4844) | Top of Settings Strategy section |
| Strategy Studio Modal | ✅ | ✅ Dropdown + custom input (lines 4346–4401) | In the right grid column |

**Why it's broken:**
- User sees "Green Team: gpt-4o" in both Strategy tab AND Settings→Strategy
- But they can't edit in EITHER of those places—only in Strategy Studio
- A user trying to change the model via Settings→Strategy hits a dead-end
- The "summary view" in Settings is meant to show "here's what's set" but gives no affordance to modify

---

### 3. **CONFUSING SCOPE: Settings→Strategy Section**

**What it shows (lines 4822–4847):**
- An info card with text: "Prompt, Green/Red Team models, reasoning effort, scoring weights, and LLM strategy reviews are saved for the selected account's live strategy."
- Three KeyVal read-only fields: Green Team, Red Team, Reasoning
- Button: "Open Strategy Studio"

**What it does NOT do:**
- Does not let you edit anything shown
- Serves only as a "status portal" redirecting to Strategy Studio
- Creates false affordance: user reads the label and thinks they can modify here

**Why it's broken:**
- Settings traditionally imply "configuration happens here"
- This section is merely a "portal + summary", not a true settings section
- User might expect to edit strategy here (natural mental model for a "Settings" tab)

---

### 4. **CAPABILITY SPLIT: Key Parameters + Policy Limits**

**In Strategy Tab (StrategyView, lines 3614–3683):**
- Max order (notional or % of NAV)
- Daily cap
- Symbol cap
- Stop loss
- Take profit
- Max proposals/run
- Cadence (minutes)
- Max daily orders
- Max hourly notional
- Max portfolio beta
- Max avg correlation
- Max entry drift %
- Max quote age
- Max fundamentals age
- Sell to fund buys
- Sector caps
- Extended hours
- Short selling
- Broker brackets
- Beta-scaled stops

**In Settings→Risk (Safety) section (NOT shown in analysis, but mentioned in line 3621):**
- "More guards (drawdown & daily-loss breakers, volatility brake, exposure caps, trailing/ATR stops, short limits, order types, universe floor) live under Risk & Safety"

**Why it's broken:**
- Strategy tab shows "Key Parameters" + some toggles
- Settings→Risk shows additional "guards" and "stops"
- No clear boundary: where should "max daily orders" live vs "daily loss breaker"?
- User must navigate TWO places to see all risk-related limits
- Inline-editable fields in Strategy tab vs traditional form inputs in Settings create inconsistent UX

---

### 5. **SAVED STRATEGY PROFILES: Orphaned to Strategy Tab**

**Current location:** Strategy Tab (StrategyView, lines 3555–3603)
- Dropdown to select active profile
- Input + Save to create new profile
- Dropdown + Apply button to copy to another account

**Missing from:**
- Settings→Strategy section (no link, no mention)
- Strategy Studio modal (no mention)
- Command palette or quick actions

**Why it's broken:**
- Strategy profiles are a **per-account, reusable bundle** (core feature for multi-account)
- But they're hidden in one tab that user might not think to check
- No affordance in Settings→Strategy: user sees "edit in Studio" but doesn't know they can save/load presets
- Multi-account user managing 3+ accounts: finding where to manage profiles requires domain knowledge

---

### 6. **SCOPE CONFUSION: What's "account-tier" vs "global"?**

**The code knows (line 165):**
```typescript
const ACCOUNT_SETTINGS_SECTIONS = new Set<SettingsSection>(["strategy", "operate", "risk", "tax", "tuning"]);
```

**But the UI barely surfaces it:**
- Settings modal has a toggle "User" vs "Account" (lines 4706–4718)
- When you switch to "Account" tier, section tabs change to `["strategy", "operate", "risk", "tax", "tuning"]`
- When "User" tier, tabs are `["connections", "display", "notifications", "data"]`

**Why it's broken:**
- User must explicitly toggle the tier switch to understand the split
- The distinction is not reinforced in Strategy tab or Strategy Studio modal
- Example: strategy prompt is account-tier (per account) but this is nowhere stated in the prompt editor
- API keys (Connections) are user-tier, but no guidance in Strategy Studio about this

---

## THE MULTI-ACCOUNT PROBLEM

**Current state:**

1. User has 3 connected accounts (Alpaca Paper, Alpaca Live, Robinhood)
2. Each account has its own policy (strategy prompt, models, limits, etc.)
3. Each account can activate a saved profile

**What the UI does NOT clearly convey:**
- "I'm configuring Account X right now, not Account Y"
- In Strategy tab, top of StrategyView doesn't show "You're editing: Alpaca Paper"
- In Settings→Strategy, there's an account selector in the header, but it's in the Settings modal itself (not visible in Strategy tab)
- Strategy Studio modal has NO account context (could be confusing if user switches accounts without closing the modal)

**Better multi-account design would:**
- Show "Currently editing: [Account Label]" prominently in Strategy tab + Strategy Studio
- Warn if user tries to apply a profile from Account A to Account B with incompatible brokers
- Use consistent scoping language across all 5 surfaces

---

## EVIDENCE FOR CONSOLIDATION

### A. The "Strategy Studio is the Source of Truth" problem

**Lines 4290–4447:** StrategyStudio component manages:
- Prompt editing (textarea)
- Green/Red Team model selection
- Reasoning effort selection
- Scoring weights matrix
- Tuning model picker + button + TuningCard display

**Lines 3491–3729:** StrategyView also manages:
- Tuning model picker (separate instance)
- Tuning button (separate click handler via `requestStrategyTuning`)
- TuningCard display (via `strategyTuning` prop)
- Key parameters (policy limits, toggles)

**Synchronization issue:**
- Both receive `requestStrategyTuning`, `tuningBusy`, `tuningError`, `strategyTuning`, `applyStrategyTuning`, `discardStrategyTuning` as props
- Both are driven by the same state in DashboardClient (lines 1026, 1586, 4290, 3491)
- If user modifies tuning in Studio and switches to Strategy tab without closing Studio, they see the stale tuning (browser cache until Modal closes)

**Root cause:** No clear ownership. Both surfaces claim authority over tuning.

### B. Settings→Strategy is a "read-only mirror"

**Lines 4822–4847:** The entire Settings→Strategy section is:
1. An explanatory card
2. Three read-only status displays
3. A button to open Strategy Studio

**This is NOT a settings section—it's a portal with a status window.**

Contrast with actual settings sections:
- Settings→Connections: actually lets you manage API keys
- Settings→Display: actually lets you change tickerLogoDisplay
- Settings→Notifications: actually manages notification settings
- Settings→Risk: (not shown, but mentioned) manages risk limits

Settings→Strategy is an oddity: it displays information about strategy configuration but defers all edits to a modal in a different surface (Strategy Studio).

### C. "The why" behind surface fragmentation

**Looking at the code timeline:**
1. **Initial design (app/strategy/page.tsx):** A public marketing explainer `/strategy` page describing the strategy (6 lenses, safety rules, limitations)
2. **Later addition (Strategy tab):** A comprehensive workspace tab for managing active strategy, profiles, parameters, and tuning reviews
3. **Later addition (Strategy Studio modal):** A dedicated modal for editing the prompt and scoring weights, plus tuning
4. **Later addition (Settings→Strategy):** A settings section to show account-tier vs user-tier distinction
5. **Later addition (Strategy Flow modal):** A ReactFlow visualization of the pipeline

**What happened:** Each addition was incremental, without rationalizing the previous surface. The tab owner didn't know about the modal, or vice versa. Settings was added to establish the account/user tier split, but it became redundant.

---

## RECOMMENDATIONS FOR A COHERENT REDESIGN

### **Phase 1: Consolidate the LLM Review (Quick Win)**

**Current state:** TuningCard appears in BOTH Strategy tab and Strategy Studio modal

**Action:**
- Move tuning review entirely to Strategy Studio (the "edit" location)
- In Strategy tab, show a summary of the last tuning review (if any), with a link: "Re-review in Strategy Studio"
- This makes Studio the single source of truth for "proposal generation and review"

**Benefit:** Removes duplicate UI and state management; makes strategy editing a focused, single-window task

### **Phase 2: Consolidate Strategy Configuration**

**Create a unified "Strategy Control Center" that contains:**

1. **Prompt & Models** (from Studio)
   - Textarea for prompt editing
   - Green/Red Team dropdowns
   - Reasoning effort selector
   - Reset button

2. **Scoring Weights** (from Studio)
   - 6-factor grid

3. **Key Parameters** (currently in Strategy tab)
   - Max order, daily cap, symbol cap
   - Stops, profit-taking
   - Cadence, proposal limits
   - Extended hours, shorting, brackets, beta scaling

4. **Saved Profiles** (currently in Strategy tab)
   - Dropdown to select/activate
   - Input + Save to create
   - Copy to account button

5. **LLM Tuning Review** (from Strategy Studio)
   - Model picker + Review button
   - Proposal display + apply/discard

**Where should it live?**

Option A (Recommended for UX clarity):
- Expand the "Strategy" workspace tab into a full-featured editor (similar to how Performance tab is comprehensive)
- Keep Settings→Strategy as a "quick-link portal to Strategy tab"
- Archive Strategy Studio modal (its contents migrate to Strategy tab)

Option B (If separation of concerns is preferred):
- Keep Strategy Studio modal but add Key Parameters + Profiles to it
- Reduce Strategy tab to a "read-only dashboard" showing current settings + recent tuning reviews
- Strategy tab becomes a status view; Studio becomes the control center

### **Phase 3: Clarify Account Scoping**

**For multi-account clarity:**
- Every strategy-related surface (tab, modal, or section) must show: "Currently configuring: [Account Name] · [Broker] [Environment]"
- In Settings→Strategy, make it clear: "These settings are per-account. Switch the account selector at the top to edit a different account's strategy."
- Add a visual indicator (badge or color) to show which account's context you're in

### **Phase 4: Retire Settings→Strategy (if consolidation in Strategy tab)**

If the Strategy tab becomes the authoritative UI:
- Remove Settings→Strategy section entirely
- Settings→Account becomes just: [Operate, Risk, Tax, Tuning] — all the "guards and limits" not in the main editor
- Users clearly understand: "broad strategy config is in the Strategy tab; detailed safety/tax/tuning refinement is in Settings"

---

## SUMMARY TABLE: "User's Journey" to Understand Strategy

| User Goal | Current Path | Pain Points |
|---|---|---|
| Edit my prompt | Strategy Studio modal | Must know modal exists; one-off flow |
| Change scoring weights | Strategy Studio modal | No mention in Strategy tab |
| Adjust stop-loss % | Strategy tab "Key Parameters" | Hidden below prompt view |
| Review my strategy performance & get suggestions | Strategy tab OR Strategy Studio (both work) | **CONFUSION**: Why are there two places? Which one "counts"? |
| Save this strategy as a preset | Strategy tab, find the "Save" input | Easy to miss; not mentioned anywhere else |
| Copy my Alpaca Paper strategy to my Robinhood account | Strategy tab, find the "Copy" dropdown | Requires knowledge of profile system |
| Understand what the strategy does | `/strategy` (marketing page) | Marketing page; not linked from UI |
| See which model is active | Settings→Strategy OR Strategy tab (both show it) | Redundant; can't change from Settings |
| Change from Propose mode to Autonomous | Settings→Operate section | Not in Strategy surfaces at all |

---

## QUANTIFIED FRAGMENTATION

- **Total strategy-related "surfaces":** 5 (Strategy tab, Strategy Studio, Settings→Strategy, Strategy Flow, /strategy page)
- **Capabilities accessible in >1 place:** 7 (Green Team, Red Team, Reasoning, LLM Review, Model selector, Tuning diff, account context)
- **Duplicated UI components:** 3 (StrategyTuningModelSelect, TuningCard, tuning state handlers)
- **Capabilities with zero guidance about location:** 4 (Profile system, Key Parameters breadth, Settings scope, multi-account context)
- **Lines of code for strategy configuration:** ~1200 (StrategyStudio + StrategyView + SettingsContent strategy section)

---

## CONCLUSION

The strategy surfaces exhibit **classic accidental complexity**:
- Each surface adds value independently
- But collectively they create **cognitive overload** for the user
- The product needs to establish **one authoritative entry point** for strategy configuration
- Settings→Strategy is well-intentioned (scoping clarity) but became **redundant** with the Strategy tab
- Strategy Studio is powerful but **undermarketed**; users don't know it's the prompt-editing hub
- Strategy Flow is excellent but **orthogonal** (visualization, not configuration)
- /strategy page is good educational content but **isolated** from the working UI

**The fix:** Consolidate prompt, models, weights, parameters, profiles, and tuning reviews into a single "Strategy Editor" experience—either the Strategy tab (recommended) or a redesigned modal that replaces both the tab and current Studio.

## A4. Multi-account model map

## THREE OVERLAPPING CONCEPTS: SCOPING MODEL ANALYSIS

### (A) CONNECTED ACCOUNTS — Broker links, execution targets, metadata

**Data held per ConnectedAccount** (`src/lib/types.ts:280-310`, stored in `connected_accounts` table):
- `id`, `userId`: unique account identifier within user's portfolio
- `broker`: "alpaca" | "alpaca-mcp" | "robinhood" | "test" (which venue)
- `environment`: "paper" | "live" (paper trading or real money)
- `accountNumber`: broker's account ID (e.g., "PA123456" for Alpaca paper)
- `label`: user-facing name (e.g., "Alpaca Paper", "Robinhood Agentic")
- `taxationType`: "taxable" | "roth_ira" | "traditional_ira" (used for wash-sale scope)
- `apiKey`, `apiSecret`, `baseUrl`: broker credentials (encrypted)
- `isActive`: boolean — which account is "selected" right now
- `capabilities`: JSON snapshot of broker's live capabilities (short-selling, fractional, etc.)

**What is scoped to it:**
- Broker connection & real-time execution
- Order routing (which venue/account number receives orders)
- Sandbox selection (Test mode is a fake local account)
- **Account-level live strategy state** (`account_strategy_state` table, `src/lib/db-profiles.ts:174-188`): the **currently running** policy, prompt, and scoring weights for this specific account

**How user creates/switches/applies it:**
- **Create**: API `POST /api/connected-accounts` with broker type, credentials (`app/api/connected-accounts/route.ts:31-132`). For Robinhood, syncs real accounts from broker OAuth.
- **Switch (activate)**: API `POST /api/connected-accounts/{id}/activate` → sets `isActive=true`, deactivates others (`app/api/connected-accounts/[id]/activate/route.ts`; UI at `app/dashboard-client.tsx:4722-4756`, a dropdown in Settings → Account tier).
- **Display**: Listed in settings with broker, environment, account number, label; UI shows "which account's settings am I editing right now?"

**Key relationship to other concepts:**
- Many accounts → one active account at a time
- Account has **one active `account_strategy_state` row** (the live policy/prompt/weights being executed)
- That row can be *derived from* a library strategy profile (stamped via `derived_from_profile_id` at apply time)

---

### (B) STRATEGY PROFILES — Reusable named presets, user's library, copyable across accounts

**Data held per StrategyProfile** (`src/lib/types.ts:986-994`, stored in `strategy_profiles` table):
- `id`: unique profile ID
- `name`: user-facing name (e.g., "Conservative Growth", "Swing Trade v2")
- `policy`: **full** `TradingPolicy` object (prompt, models, scoring weights, safety limits, authority mode, etc.)
- `prompt`: LLM strategy system prompt
- `scoringWeights`: 8-dimensional weighting vector (liquidity, momentum, value, quality, volatility, sentiment, positioning, diversification)
- `active`: boolean — which profile is the user's "default" library entry point
- `createdAt`, `updatedAt`: timestamps

**What is scoped to it:**
- User's **library** of reusable strategy bundles — **copyable templates**
- Each profile is a self-contained snapshot: if you edit it, downstream copies are **not** retroactively changed
- NOT directly what the account executes: the profile is inert until activated or copied to an account

**How user creates/switches/applies it:**
- **Create**: UI button "Save current as a named strategy" (`app/dashboard-client.tsx:3586-3603`) → `POST /api/profiles` with name, policy, prompt. Can be marked `active: true` to become the library default (`src/lib/db-profiles.ts:467-490`).
- **Activate** (as library default): Dropdown "Saved strategy" → select profile → click → `POST /api/profiles/{id}/activate` (`app/dashboard-client.tsx:3558`, `app/api/profiles/[id]/activate/route.ts:10`). This:
  - Sets `active=1` on the profile in `strategy_profiles`
  - **Mirrors into the active account's `account_strategy_state`** so the active account immediately runs it (`src/lib/db-profiles.ts:531`)
  - Overwrites `user_settings.policy` with the profile's policy (user-tier fields only; account fields go to the account row)
- **Copy to another account** (PR 2): "Copy this strategy to another account" picker (`app/dashboard-client.tsx:3563-3582`) → select account → click "Apply" → `POST /api/profiles/{id}/copy` with `connectedAccountId` (`src/lib/db-profiles.ts:547-578`, `app/api/profiles/[id]/copy/route.ts:19`). This:
  - Reads the profile's policy and prompt
  - **Writes only the target account's `account_strategy_state` row** (does NOT change library profile or active flag)
  - Stamps `derived_from_profile_id` so UI knows this account is running a copy of profile X (for user clarity)
  - **Preserves the target account's `systemState`** (active/halted) so copying never auto-arms a halted account

---

### (C) USER-TIER GLOBAL SETTINGS — Shared across all accounts

**Data held in user_settings table** (scoped by user, NOT by account):
- Provider API keys (OpenAI, Anthropic, xAI, Gemini, etc.) — credentials belong to the user, not a single account
- **User-level policy fields** (`src/lib/db-profiles.ts:20-24`):
  - `notificationSettings`: alert preferences (which events, webhook URL)
  - `marketScanCandidateLimit`: how many top stocks to enrich per run (affects all accounts equally)
  - `marketScanOutlierReserve`: reserve slots for high-signal outliers (applies across all accounts)
- `autoResumeOnBoot`: whether "active" accounts auto-resume on server restart (global toggle)
- Display preferences: theme, logo display mode
- Learned-context sharing (pool consent, contribute/include toggles)
- Tax data, watch lists, price alerts, chat memory

**What is scoped to it:**
- Credentials (API keys): belong to user identity, not to a single brokerage account
- Notification/alerting rules: shared — all accounts respect the same webhook and event filters
- Market scan breadth: shared — whether we enrich 5 or 50 candidates affects cost/UX globally
- Display & UX: shared

**How user creates/switches/applies it:**
- Settings modal with **two-tier toggle** (`app/dashboard-client.tsx:4706-4719`): "User" vs "Account"
  - Clicking "User" switches the settings panel to show user-tier tabs: Connections | Display | Notifications | Data
  - Clicking "Account" shows account-tier tabs: Strategy | Operate | Risk | Tax | Tuning
- **Connections section** (`app/dashboard-client.tsx:6249+`): paste API keys here. Shared across all accounts.
- **Display section**: theme, logo display mode, etc.
- **Notifications section**: event filters, webhook URL.
- **Data section**: shared pool consent, learned-context opt-in/out.

---

## PRECISE USER-FACING CONFUSION — What makes this Frankenstein patchwork

### 1. **Three competing mental models, no one structure**
   - **Account switching** (dropdown at top of Settings): "I'm configuring Account A" — but this is **structural**, not really a "mode."
   - **Profile activation** (different dropdown in Strategy tab): "I'm activating the Conservative Growth profile" — but where does it go? Into the active account? Or does it become the library default, or both?
   - **Apply profile to account**: "Copy this preset to Account B" — happens in a secondary UI panel inside the Strategy tab (line 3563-3582), hidden beside profile management controls. Easy to miss.

   **User question**: "I just created a new strategy. Is it saved in the library, active for my account, or applied to all accounts? What's the difference between 'saving' and 'activating' and 'applying'?"

### 2. **"Strategy" exists in 5+ disconnected places with no hierarchy**
   - **Workspace tab "Strategy"** (`app/dashboard-client.tsx:148`): main UI, shows Active Strategy card, Key Parameters, LLM Review
   - **Settings → Strategy section** (account-tier, `app/dashboard-client.tsx:4822-4847`): shows the Studio info, Green/Red Team models, reasoning effort (but you can't *edit* them there — must click "Open Strategy Studio")
   - **Strategy Studio modal** (`app/dashboard-client.tsx:4290-4500+`): prompt textarea, scoring sliders, weight matrix, LLM review (only accessible from 3 different buttons)
   - **Strategy Flow overlay** (`app/ui/strategy-flow.tsx`): visual pipeline of how the LLM reaches a decision
   - **Public "/strategy" marketing page**: separate landing page, not linked to config

   **User question**: "I need to change my prompt. Is that in the Strategy tab, Settings → Strategy, or Strategy Studio? Why are they different?"

### 3. **Ambiguous "active" meaning — profile active? account active?**
   - `activateProfile(id)` sets a profile as the library default AND immediately mirrors it into the **active** account's live state (line 531, `src/lib/db-profiles.ts:518-534`)
   - `activateAccount(id)` switches which account is "active" (receives policy reads/writes) (line 1517, `app/dashboard-client.tsx`)
   - A profile can be "active" in the library but NOT running in an account if that account is halted (systemState='halted')
   - An account can be "active" (selected for UI) but "halted" (not running strategy)

   **User question**: "I activated this profile, why isn't my account running it? I activated Account A — does that mean the strategy was cleared?"

### 4. **Account-tier vs user-tier split is invisible**
   - Settings modal has a **toggle** (line 4706) but the modal is **not divided visually** — you flip between two tab sets (User: Connections/Display/Notifications/Data) and (Account: Strategy/Operate/Risk/Tax/Tuning). Feels like two separate modals stitched together.
   - **Tax** appears **twice**: as workspace tab (main nav) AND as a settings section (account-tier under Account Settings) — no explanation of why
   - **Notifications** appears **twice**: as a feed tab (left sidebar) AND as a settings section (user-tier) — confusing what "muting notifications" does vs "disabling notification events"

   **User question**: "I changed Notifications in Settings — did this affect all my accounts or just this one? What's the difference between 'Notifications' settings and the 'Notifications' feed tab?"

### 5. **No clear indication of "which account am I configuring"**
   - When you open Settings, there's an account dropdown at the top (`app/dashboard-client.tsx:4732-4754`), but it's only shown **when settingsTier='account'** 
   - If you're in user-tier settings (Connections, Display), the account selector **vanishes** — implying those settings are global (which they are). But visually it's jarring.
   - The detail panel at the top says "Account · broker strategy, operation, safety, tax, and tuning" **only if settingsTier='account'** — otherwise it says "User Settings · Provider keys, display, notifications, and shared data" (line 4623-4628). Easy to lose context.

   **User question**: "I just changed my max order size — did it apply only to Account A or to all accounts? I don't remember which tier I was in."

### 6. **"Copy to account" is buried inside a secondary use case**
   - Line 3563-3582: the "Copy this strategy to another account" panel only appears **if**:
     - You're in the Strategy workspace tab
     - settingsTier='account' (so you picked an account in the Account Settings modal)
     - There are other accounts to copy to
     - A profile is selected
   - It's in a `<div>` sibling to the profile dropdown, easy to miss as a secondary feature.
   - No entry point from Accounts modal or Profiles library view.

   **User question**: "How do I use the same strategy on multiple accounts? I saved 'Growth Strategy' — now what?"

### 7. **Policy inheritance is implicit and partly documented only in code**
   - When you read policy for Account A:
     1. Fetch account's `account_strategy_state` row (the live state)
     2. Merge in **user-level fields** from `user_settings.policy` (notificationSettings, marketScanCandidateLimit, marketScanOutlierReserve)
     3. If no account row exists, use the active library profile or user_settings as fallback (line 330-374, `src/lib/db-profiles.ts`)
   - This two-tier merge is **never visible in UI** — you edit one field and don't know if it's stored per-account or per-user.
   - **User question**: "I changed my market-scan breadth — will all my accounts scan broader, or just this one?"

---

## CONCRETE CODE CITATIONS

| Concept | File:Line | What it shows |
|---------|-----------|---|
| **ConnectedAccount interface** | `src/lib/types.ts:280` | broker, environment, accountNumber, label, capabilities, isActive |
| **Account-tier vs user-tier split** | `src/lib/db-profiles.ts:20-24` | USER_LEVEL_POLICY_FIELDS: notificationSettings, marketScanCandidateLimit, marketScanOutlierReserve |
| **Two-tier policy merge on read** | `src/lib/db-profiles.ts:330-374` | getPolicy(): overlays user fields on top of account state |
| **Account strategy state (live execution)** | `src/lib/db-profiles.ts:174-188` | account_strategy_state table schema; per-account live policy, prompt, scoring_weights, derived_from_profile_id |
| **Activate profile (to library default + active account)** | `src/lib/db-profiles.ts:518-534` | activateStrategyProfile(): sets active=1 on profile, mirrors into active account's row |
| **Copy profile to account (PR 2)** | `src/lib/db-profiles.ts:547-578` | applyProfileToAccount(): copies profile to a chosen account's account_strategy_state, preserves systemState, stamps derived_from_profile_id |
| **Settings tier toggle** | `app/dashboard-client.tsx:4706-4719` | Segmented control "User" vs "Account"; switches between two tab sets |
| **Settings tier detection** | `app/dashboard-client.tsx:165-168` | ACCOUNT_SETTINGS_SECTIONS constant; settingsTierForSection() function |
| **Account dropdown in Settings** | `app/dashboard-client.tsx:4722-4756` | Shown only when settingsTier='account'; lists connected accounts; calls onChangeAccount(id) |
| **Copy-to-account UI** | `app/dashboard-client.tsx:3563-3582` | Hidden inside Strategy tab's "Active Strategy" card; picker + "Apply" button |
| **Activate account** | `app/dashboard-client.tsx:1517-1525` | POST /api/connected-accounts/{id}/activate |
| **Profile activation button** | `app/dashboard-client.tsx:3558` | Dropdown in Strategy tab "Saved strategy"; onChange calls activateProfile(e.target.value) |
| **Settings scope labels** | `app/dashboard-client.tsx:4623-4628` | settingsScopeTitle and settingsScopeDetail conditionally change based on tier |
| **Tax appears twice** | `app/dashboard-client.tsx:4808-4813` | account-tier tabs include "tax"; workspace tabs (line 148) include "tax" as separate workspace |
| **Notifications appears twice** | `app/dashboard-client.tsx:161, 4805` | FeedTab='notifications' (left sidebar feed) vs SettingsSection='notifications' (user-tier settings section) |
| **API: Connect accounts** | `app/api/connected-accounts/route.ts:31-132` | POST with broker type, credentials; auto-detects Alpaca paper vs live from account number |
| **API: Copy profile to account** | `app/api/profiles/[id]/copy/route.ts:19` | POST with connectedAccountId; calls applyProfileToAccount() |
| **API: List accounts** | `app/api/connected-accounts/route.ts:17-29` | GET returns safe subset (no secrets) used for UI dropdowns |

---

## SUMMARY: THE FRANKENSTEIN NATURE

**The three concepts are real and logically sound:**
1. **Connected Accounts** = broker links, execution targets (per-broker state)
2. **Strategy Profiles** = reusable templates, library presets (user's library, not account-specific)
3. **User-tier Settings** = shared API keys, notification rules, UI prefs (across all accounts)

**The problem is presentation and navigation:**
- **No coherent workflow.** Users don't know whether to open Settings, the Strategy tab, the Accounts modal, or the Connections section to get what they need.
- **Redundant labels.** "Tax," "Notifications," "Strategy" appear in multiple places with overlapping meaning.
- **Invisible scoping.** The account-vs-user tier split is a **toggle**, not a structure — users flip between tab sets without clear mental model of "global vs this account."
- **Buried features.** Copy-to-account is hidden inside a secondary panel. Profile activation is a dropdown. Account switching is another dropdown. No unified "apply this preset to multiple accounts" flow.
- **Implicit inheritance.** Policy merges from user settings + account state without UI indication of which fields are scoped where.

Result: **users feel lost, the app feels incoherent**, and the actual data model (which is sound) is buried under overlapping UI surfaces.
