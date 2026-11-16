# Appendix B — Layout-Agnostic Capability Inventory (given to the blind teams)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

## AGENTIC TRADING SYSTEM — LAYOUT-AGNOSTIC CAPABILITY INVENTORY

### WHO USES IT & CORE JOB

**Individual traders & portfolio managers** who want **autonomous equity trading with human oversight**, running on **personal brokers (Robinhood via MCP, Alpaca)** or **local test simulation**. The system proposes trades based on market analysis + learned patterns, enforces policy guardrails, optionally auto-executes within risk boundaries, and learns continuously from realized outcomes.

---

### TENANCY MODEL (REQUIREMENTS)

**Multi-user with per-broker-account isolation:**
- **Primary user** (operator) inherits legacy "local" dataset and admin privileges
- **Additional users** via auth allowlist (Google OAuth, GitHub OAuth, Apple Sign In); each has:
  - **Own identity** (verified email from auth provider; never client-trusted)
  - **Own data** (isolated database views; cross-user data never exposed)
  - **Own API keys** (AES-256-GCM encrypted per-user store in `user_api_keys` table)
  - **Own preferences** (LLM model selection, reasoning effort, notification channels)

**Per-user broker account multiplicity:**
- **Multiple connected broker accounts per user** (e.g., Robinhood live + Alpaca paper + Test sim)
- **Per-account strategy autonomy**: each account has its own policy + strategy profile (autonomous or proposal-only)
- **Per-account risk guardrails**: separate position limits, max notional, stop-loss rules
- **Per-account execution mode**: Test (local sim) / Broker Paper / Broker Live (determined by connected account environment)

**Preset reusability & multi-account strategies:**
- **Strategy profiles** (named templates): policy + prompt + scoring weights; can be cloned, activated per account
- **Policy presets** (within a profile): risk rules, universe, order limits, tax settings; modifiable and persistent
- **Shared configuration** (operator-level): LLM keys, market-data keys, web-source toggles; all per-user override with own keys

---

### CORE CAPABILITIES

#### 1. **Market Monitoring & Signal Generation**

**Market scanning with multi-provider enrichment:**
- Scans allowed equity universe (S&P 500, NASDAQ, Russell 2000, custom ticker list, or dynamic watch-list)
- Ranks candidates by deterministic scoring (liquidity, momentum, value, quality, volatility, sentiment, smart-money positioning, diversification)
- Configurable market-scan limit (top N candidates) + configurable outlier reserve (notable below-cutoff names with strong web signals)
- Unified scoring weights per strategy profile (0.6–1.4 multiplier per factor; auto-tuned over time)

**Multi-source enrichment (quote + fundamentals + technicals + macro + web-signals):**
- **Prices & liquidity**: Alpaca, Finnhub, FMP, Yahoo Finance, CBOE, Nasdaq delayed feeds
- **Fundamentals**: P/E, EPS, FCF yield, debt/equity, sector, industry, analyst ratings (FMP, Finnhub, Yahoo)
- **Market context**: VIX, VVIX, SKEW, Fed rates, inflation, unemployment, DXY, credit spreads (FRED API)
- **Technicals**: 0–100 score + named signals (RSI, moving-average crosses, breakouts) from TradingView webhooks or in-house OHLCV compute
- **Smart-money signals**: Congressional net buying/selling (via Congress.Trade), insider sentiment, short-squeeze signals (CBOE SKEW, Finra short %)
- **Web-source bulletins**: up to 3 one-line evidence summaries per candidate (Congress, insider, finra, SEC 8-K)

**Macro regime detection:**
- Deterministic regime classification (Bull, Bear, Grind, Crisis, Recession) based on VIX, SPY/QQQ momentum, yield curve, Fed rate changes
- Regime snapshot captured at strategy-run decision time; persisted with every proposal + closed trade for learning

**Market-data staleness gating:**
- Configurable max age threshold per symbol (quote) and fundamentals; opens fail-safe when stale

**Market breadth & volatility gauges:**
- % of screened symbols advancing today (risk-on/off gauge)
- Volatility panic brake: auto-halts new entries + fires kill-switch alert when VIX/VVIX/SKEW exceed configurable thresholds

---

#### 2. **AI-Driven Proposal Generation**

**Agentic LLM loop (Bull → Bear → Red Team consensus):**
- **Bull proposal generator**: user-selected LLM (GPT-5, Claude, xAI Grok, Gemini, Mistral, DeepSeek) with user's reasoning effort (low/medium/high for reasoning models)
- **Bear (Red Team) reviewer**: optional alternate model or same model in adversarial mode; evaluates Bull's thesis
- **Consensus**: proposals require explicit approval from Red Team when conviction confidence exceeds tuning threshold

**Per-proposal enrichment context:**
- Market scan + portfolio state + open positions + sector exposure
- Macro indicators (rates, inflation, VIX regime snapshot)
- Learned context from prior trades: thesis performance cards, recurring factor efficacy, avoided-candidate regrets
- User-submitted chat history + learned preferences (constraints, goals, corrections)
- Entry-market regime (SPY/QQQ/VIX state at decision time, for regime-dependent analysis)

**Proposal output:**
- Symbol, side (buy/sell/short/cover), order type (market/limit/stop_market/stop_limit)
- Quantity, dollar amount (fractional on Alpaca), or "all available cash"
- Time-in-force (good-for-day, good-til-canceled)
- Rationale (free text; persisted for post-mortems)
- Thesis tag (e.g., "Breakout", "Value", "Mean Reversion", "Congress", "Insider Reversal"; for learning aggregation)
- Confidence score (1–100; used for sizing multiplier + Red Team re-validation gate)
- Entry-market regime snapshot
- Bracket order parameters (take-profit limit, stop-loss price, optional stop-limit)

**Proposal persistence & re-validation:**
- Pending proposals survive across runs until approval/rejection/expiry
- Configurable hard expiry (e.g., 60 min; auto-expires stale ideas)
- Configurable re-validation cadence (e.g., every 5 strategy runs, or once per day); LLM confirms thesis still stands

---

#### 3. **Approval & Risk Gates (Pre-Execution Policy)**

**Deterministic policy evaluation (never bypassed):**
- **System state**: halted, close-only (risk-reducing exits only), active
- **Universe membership**: symbol must be in allowed list (S&P 500, custom, or dynamic watch) unless already held
- **Blocklist**: symbols explicitly forbidden (e.g., meme stocks, concentrated names)
- **Universe floor**: min share price (penny-stock gate), min market cap, min daily dollar volume (liquidity floor)
- **Order type restrictions**: market, limit, stop, or bracket only if explicitly permitted
- **Extended-hours gate**: orders only in regular hours unless enabled; no fractional extended orders
- **Wash-sale protection** (IRC §1091): blocks rebuy of symbol closed at loss within 30 days; cross-account scope for taxable accounts; bypassed in IRAs
- **Margin minimum**: live accounts must maintain >$2k equity before margin trades
- **PDT (Pattern-Day-Trader) rules**: live accounts ≥5 day-trades/5-biz-days triggers enforcement; blocks new entries

**Notional & exposure caps (opening orders only):**
- **Max per-order notional** (e.g., $1,000)
- **Max per-order % of ADV** (e.g., 5% of recent daily dollar volume to limit market impact)
- **Max daily notional** (e.g., $500/day; excludes risk-reducing exits)
- **Max hourly notional** (e.g., $250/60min; rolling window; breach auto-reverts autonomy to proposal-only + rejects order)
- **Max symbol exposure** (% of portfolio or notional, e.g., 25%)
- **Max sector exposure** (configurable per sector, e.g., 30% Tech)
- **Max gross exposure** (all long + abs(all short), e.g., 150%)
- **Max net exposure** (long - short, e.g., 100%)
- **Max portfolio beta** (projected aggregate market sensitivity; prevents correlated clusters)
- **Max correlation cluster** (new position's avg correlation to holdings; prevents pile-on)

**Entry-price anchor & drift gating:**
- Captures decision-time market price when proposal generated
- Rejects stale OPENING market/dollar orders if price has drifted >configurable % from anchor (e.g., 2%) at approval time
- Protects against stale approval (hours/days later) executing at materially worse price

**Risk rules (position-level):**
- **Stop-loss %** (e.g., 8% below entry)
- **Take-profit %** (e.g., 12% above entry)
- **Take-profit trim %** (e.g., 50% of position when TP triggers; lets rest ride)
- **Trailing stop %** (e.g., 5% below running high)
- **Short stop-loss %** (mandatory on shorts; e.g., 5%)
- **ATR-based stops** (opt-in; override fixed % with volatility-scaled distance: stop = ATR × multiplier)
- **Beta-scaled stops** (opt-in; scale fixed % by name's beta: high-beta wider, low-beta tighter)

**Account-level circuit breakers:**
- **Max drawdown %** from equity high-water mark (e.g., 10%; triggers close-only state + kill-switch)
- **Max daily loss notional** (e.g., $500/day; triggers close-only state)

**Authority-level decision gate:**
- **Proposal-only mode**: proposals queue for manual approval (no auto-execution)
- **Decide mode**: auto-execute if policy passes (but still subject to broker review + idempotency)

---

#### 4. **Order Placement & Broker Integration**

**Multi-broker support:**
- **Robinhood (MCP)**: Model Context Protocol real-time trading; OAuth-authenticated; supports long/short, market/limit, extended hours
- **Alpaca**: REST API + WebSocket; paper + live modes; fractional shares; native OCO bracket orders
- **Test/Local simulator**: local SQLite fills with optional execution-cost model (slippage + half-spread + sqrt market-impact)

**Order submission flow:**
- **Deterministic pre-trade review**: policy gates (see above) + account capabilities check (equityTrading, shortSelling, optionsTrading, marginEnabled, etc.)
- **Broker-side review** (when supported): Alpaca/Robinhood validate order feasibility before submission
- **Idempotent placement**: client-supplied order ID (clientOrderId) lets the app recover if submission-response is lost; broker-truth-first reconciliation on next run-start

**Order orchestration:**
- **Bracket orders** (OCO stops): optional take-profit limit + stop-loss leg auto-attached at open (Alpaca native; Robinhood would require manual management if enabled)
- **Broker-held protective stops** (Robinhood opt-in): place GTC stop-market SELL at broker to survive app downtime
- **Synthetic trailing-stop monitor**: scheduler tick monitors all open positions, ratchets down trailing stops, executes when triggered (fallback when broker stops unavailable)
- **Order replacement** (emergency only): cancel + replace when market-impact or urgency demands re-pricing

**Market hours aware:**
- Regular hours (9:30–16:00 ET), extended hours (pre + after market)
- Fractional orders + dollar amounts restricted to regular hours only
- Extended-hours run cadence optional; extended-hours risk management (synthetic stops) opt-in

---

#### 5. **Execution & Settlement**

**Multi-mode execution:**
- **Test/Local**: simulated fills in SQLite; cash + position updates immediate
- **Broker Paper**: Alpaca paper trading; simulated fills via broker's paper account
- **Broker Live**: real capital on Robinhood MCP or Alpaca live

**Fill tracking & post-mortem:**
- Fills persisted with timestamp, quantity, price, broker order ID
- MAE/MFE (Maximum Adverse/Favorable Excursion) computed post-mortem from historical bars (when available)
- Holding duration, sector, entry/exit regime captured

**Tax lot tracking (manual + derived):**
- Entry price, cost basis, holding period (long-term: >365 days)
- Tax-harvesting signals: unrealized losses (wash-sale candidates), long-term cap gains maturity
- Cross-account wash-sale scope: closing a loss in account A locks rebuys across ALL accounts (including IRAs) for 30 days

---

#### 6. **Performance Review & Learning Loop**

**Realized performance P&L:**
- **Closed-lot analytics**: win rate, avg return %, realized P&L, shrunk stats (Bayesian posterior with pseudo-count regularization)
- **Thesis-level scorecard**: per-trade-thesis tag (Breakout, Value, Congress, etc.), stats grouped by thesis
- **Regime-level scorecard**: entry-regime snapshot (Bull/Bear/Grind/Crisis), stats grouped by regime
- **Factor-efficacy tracking**: which scoring-weight factors (momentum, value, positioning, etc.) drove winning vs losing candidates
- **Entry-run attribution**: when enabled, credits realized P&L to the entry-RUN, not just the exit-run (dual-credit for multi-run holds)

**Benchmark comparison:**
- **SPY buy-and-hold**: equity curve normalized to 100 at first common date; total return %, excess return (alpha)
- **Rolling windows**: 30-day, 90-day, 1-year performance readouts

**Counterfactual learning (missed-opportunity analysis):**
- Skipped candidates + their realized returns (from decision date forward)
- Identifies top-ranked-but-passed symbols that later moved 10%+; groups by dominant factor
- Feeds into tuning loop to explain weight misallocation

**Portfolio curve snapshots:**
- Persisted at strategy-run conclusion: equity, cash, buying power, position list
- Feeds into equity-curve reconstruction + benchmark alignment

---

#### 7. **Autonomous Tuning & Continuous Improvement**

**Factor-weight adjustment:**
- Based on **realized scorecard**: which factors (momentum, value, positioning, quality, liquidity, sentiment, diversification) drove winners vs losers
- **Bayesian shrinkage** (pseudo-count regularization): prevents overfitting to small samples
- **Max delta per step**: 5-point limit per factor (0.05 on 0.6–1.4 scale) to prevent runaway drift
- **Out-of-sample (OOS) validation**: walk-forward test confirms proposed weights against hold-out test period; unvalidated weight moves withheld
- **Shrunk corroboration gate**: only lift conviction cap if realized edge (avg return %) corroborates the LLM's confidence score

**Policy/prompt tuning:**
- **Order notional adjustments**: expand if P&L supports larger risk, contract if drawdown looms
- **Cadence changes**: speed up runs when signal clarity high, slow down in noisy regimes
- **Authority shift**: if realized win rate low, auto-revert to proposal-only; if >60%, enable decide
- **Prompt refinement**: LLM suggests thesis-refinement language based on sector/regime wins/losses
- **Risk-rule scaling**: adapt stop-loss % to regime volatility, take-profit % to realized mean reversion depth

**Tuning gating & confidence:**
- Tuning proposals generated by LLM (Green Team) + reviewed by Red Team (adversarial model)
- Confidence score (1–100) on each proposal; high-confidence changes permitted; low-confidence withheld
- Dry-run evaluation: proposed weights tested on historical walk-forward window before live adoption

**Learned context integration:**
- Persisted facts, patterns, decisions from prior trades + chat corrections
- Facts (e.g., "AAPL short selling is risky due to borrow costs") reach strategy LLM as advisory prompt data only
- Never converted to numeric policy changes directly; human approval required for risky tier ingest

---

#### 8. **Chat Assistant & User Learning**

**Conversation interface:**
- Multi-turn transcript (user + assistant turns; turns stamped with model + timestamp)
- Turn-level intent inference (Q&A, strategy adjustment, constraint, system diagnostic)
- Citations: assistant responses link to market-scan data, portfolio state, audit events

**Context-aware responses:**
- Assistant reads portfolio state, open positions, recent fills, pending proposals, performance cards
- Can propose trades (which flow through standard approval gates)
- Can explain strategy decisions ("Why did you skip MSFT?")
- Can adjust settings (policy, weights, risk rules; subject to human approval)

**Learned memory extraction:**
- Salience-gated extraction from chat: constraints, preferences, goals, corrections, patterns, decisions
- Confidence scoring (specificity, hard vs soft, PII detection)
- Reconciliation: newer values supersede contradicting prior ones
- Superseding audit: when memory is replaced, prior entry marked with successor ID for traceability

**Multimodal observability:**
- LLM session ID + turn count per provider (OpenAI, Anthropic, xAI, Gemini, etc.)
- Prompt tokens + completion tokens tracked per turn (for usage billing)
- Langfuse observability (opt-in): captures summaries of proposals + tuning (not raw prompts or account numbers)
- Sentry error tracking (opt-in): redacted stack traces + session context

---

#### 9. **Watchlist & Notifications**

**Watchlist management:**
- User-maintained list of symbols to monitor
- Separate from allowed-universe filter (universe gates opening NEW trades; watchlist is advisory feed)
- Persisted per-user

**Price alerts:**
- Per-symbol threshold (e.g., "AAPL < $150 OR AAPL > $175")
- Armed/triggered states; alert fires on quote-refresh when condition met
- Optional user-provided note (e.g., "Entry target" or "Stop-loss reference")

**Multi-channel notifications:**
- **Email** (Resend provider; user must enable in Settings → Notifications)
- **Push** (ntfy or Pushover; deliver to phone/browser)
- **SMS** (Twilio; phone number required)
- **Webhook** (custom integration; user URL)

**Alert event types:**
- Fill (order executed, live/paper)
- Block (proposal rejected by policy)
- Run failed (strategy run crashed)
- Pending approval (new proposal waiting review)
- Kill-switch triggered (drawdown/daily-loss threshold breached)
- Price alert triggered (watchlist + threshold alerts)
- Proposal withdrawn (LLM re-validation failed; no longer recommended)
- Limit order stale (market order pending >15 min, configurable)
- Provider degraded (market-data source unavailable)

**Admin-level alerts:**
- LLM usage breakdown per user + per key (for billing)
- Broker provider health (Robinhood MCP availability, Alpaca API status)
- Autonomy state transitions (halted on boot, resumed)
- Web-source ingestion failures (Congress.Trade, SEC Edgar, insider-trading feeds)

---

#### 10. **Macro Dashboard & Portfolio Macro View**

**Macro indicators displayed:**
- Fed Funds rate, 10-year yield, yield-curve inversion (10y–2y spread)
- Inflation (CPI YoY), unemployment rate
- DXY (US Dollar Index), crude oil
- Equity indices (SPY, QQQ, Russell 2000, sector ETF performance)
- Volatility (VIX, VVIX, SKEW)
- Credit spreads (high-yield OAS when available)
- Sentiment (market breadth %, put/call ratio)

**User macro context:**
- Derived metrics from indicators (Bull/Bear/Grind/Crisis regime; yield-curve inversion flag; vol regime)
- Portfolio beta exposure vs market (aggregate directional sensitivity)
- Sector rotation view (which sectors overweight/underweight; which performing)
- Holdings vs SPY benchmark (alpha generation, relative strength)

---

#### 11. **Audit & Transparency**

**Audit trail (immutable log):**
- **Run events**: strategy run start/finish, status, proposal count by outcome
- **Decision events**: proposal evaluation, policy gate reasons for rejection, authority decision
- **Order events**: placement, fill, cancel, error
- **Signal snapshots**: per-run candidate evidence (score, factors, technicals, congress signals, reasoning) for all candidates (chosen + skipped)
- **Performance events**: closed trade P&L, thesis tag, regime, MAE/MFE
- **Tuning events**: factor weights changed, prompt adjusted, policy patch applied
- **Learning events**: learned context ingested, fact superseded, pending queue updated
- **Kill-switch events**: circuit breaker triggered (drawdown, vol spike, daily loss)
- **Account lifecycle**: connected account added/disconnected, capabilities confirmed
- **Settings changes**: policy, profile, preferences updated + prior values

**Audit queries:**
- By date range, account, event type, status
- Downloadable as JSON/CSV for external analysis
- Diagnostic ops endpoint (token-gated, no OAuth required) exposes recent runs + account autonomy state

**Transparency for reproducibility:**
- Every proposal includes decision-time market scan (top candidates, scores, factors)
- Every fill includes entry regime snapshot (SPY/QQQ/VIX state at decision)
- Counterfactual tracking: skipped candidates' later returns persisted for post-mortem
- Execution-cost attribution: paper fills debited via cost model so net-of-cost P&L is realistic

---

#### 12. **Regulatory & Tax Compliance**

**Tax treatment modes:**
- **Taxable account** (standard brokerage): 30-day wash-sale lockout applies; short-term vs long-term capital gains tracked; tax-loss harvesting advisories
- **Roth IRA**: no wash-sale lockout within this IRA; 0% tax on gains (tax-sheltered); no tax-loss harvesting
- **Traditional IRA**: no wash-sale lockout within this IRA; 0% tax on gains; withdrawals taxed as income later

**Cross-account wash-sale scope:**
- Loss realized in taxable account locks rebuys of that symbol across ALL accounts (including IRAs) for 30 days per IRC §1091
- IRA wash sales within same IRA don't trigger external lockout (no benefit to realizing losses there)

**Tax settings per account:**
- Marginal tax rate (short-term, long-term) for estimated after-tax P&L display
- Optional: subtract estimated taxes from performance dashboard (net-of-tax view)
- Tax-lot tracking (cost basis, holding period) for capital-gains planning

---

### CONFIGURABLE PARAMETERS (KNOBS NOT UI SCREENS)

#### **Market Scan & Universe**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `includedIndices` | Universe | enum array | SP500, NASDAQ100, Russell2000, etc. | Which index universes feed the scan |
| `additionalSymbols` | Universe | string array | e.g., ["AVGO", "PLTR"] | Explicit symbols always scanned (not subject to universe floor) |
| `blocklist` | Universe | string array | e.g., ["GME", "AMC"] | Symbols never eligible for opening orders |
| `universeFloor.minPrice` | Universe | number (USD) | 5.0–10.0 | Minimum share price (penny-stock gate) |
| `universeFloor.minMarketCapUsd` | Universe | number ($) | 100M–1B | Min market cap for inclusion |
| `universeFloor.minDollarVolume` | Universe | number ($) | 1M–10M | Min daily $ volume (liquidity floor) |
| `marketScanCandidateLimit` | Scanning | integer | 20–50 | Top N candidates sent to LLM for proposal generation |
| `marketScanOutlierReserve` | Scanning | integer | 2–5 | Notable below-cutoff names that may displace plain candidates |
| `MARKET_SCAN_CACHE_TTL_MS` | Scanning (env) | milliseconds | 300000 (5m default) | How long market-scan results cached before re-fetch |

#### **LLM & AI Behavior**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `llmModel` | LLM (per-user override) | string | "gpt-5.4-mini", "claude-opus", "grok-3" | Green Team / Bull proposer model; overrides OPENAI_MODEL fallback |
| `redTeamLlmModel` | LLM (per-user override) | string | same as llmModel | Bear / Red Team reviewer model; if unset, reuses llmModel |
| `llmReasoningEffort` | LLM (per-user override) | enum | "low", "medium", "high" | Reasoning depth for o-series models; ignored by non-reasoning models |
| `LLM_OPERATOR_FALLBACK` | LLM (env) | boolean | on/off | Fallback to operator key if user lacks own key; off = all users need their own |
| `RED_TEAM_LLM_PROVIDER` | LLM (env, emergency) | string | "anthropic", etc. | Force Red Team onto specific provider (override Settings choice) |
| `minProposalScoreThreshold` | Scoring | 0–100 | 0–40 | Candidates below this dropped before LLM sees them |

#### **Order Sizing & Risk Rules (Position-Level)**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `maxOrderNotional` | Sizing | USD | 100–10000 | Max per single opening order |
| `maxOrderPctOfNav` | Sizing | % | 1–10 | Max order as % of portfolio value |
| `maxOrderPctOfAdv` | Sizing | % | 1–10 | Max order as % of symbol's recent daily dollar volume (market impact cap) |
| `maxDailyNotional` | Sizing | USD | 500–100000 | Max total opening notional per calendar day |
| `maxHourlyNotional` | Sizing | USD | 100–10000 | Max notional within rolling 60-min window; breach auto-reverts autonomy |
| `maxProposalsPerRun` | Sizing | integer | 1–10 | Max proposals generated per strategy run |
| `maxDailyOrders` | Sizing | integer | 5–50 | Max opening orders per calendar day |
| `maxSymbolExposurePct` | Limits | % | 10–50 | Max portfolio % in single symbol |
| `maxSymbolExposureNotional` | Limits | USD | 1000–50000 | Alt: max $ exposure per symbol |
| `maxSectorExposurePct` (per-sector) | Limits | % | 20–50 | Configurable per sector (Tech, Healthcare, etc.) |
| `maxGrossExposurePct` | Limits | % | 100–200 | Max (longs + abs(shorts)) as % of equity |
| `maxNetExposurePct` | Limits | % | 50–100 | Max (long - short) as % of equity |
| `maxPortfolioBeta` | Limits | number | 0.8–1.5 | Cap projected portfolio market sensitivity |
| `maxAvgCorrelation` | Limits | 0–1 | 0.5–0.8 | Block opening orders correlated >this to current holdings |

#### **Risk Management (Position-Level)**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `riskRules.stopLossPct` | Risk | % | 2–10 | Protective stop distance below entry for longs |
| `riskRules.stopLossNotional` | Risk | USD | 100–10000 | Alt: absolute $ stop-loss |
| `riskRules.takeProfitPct` | Risk | % | 3–20 | Profit-taking target above entry for longs |
| `riskRules.takeProfitNotional` | Risk | USD | 100–50000 | Alt: absolute $ take-profit |
| `riskRules.takeProfitTrimPct` | Risk | % | 25–100 | % of position to sell when TP triggers (default 50); rest rides |
| `riskRules.trailingStopPct` | Risk | % | 2–10 | Trailing stop ratchet (how far back from running high) |
| `riskRules.shortStopLossPct` | Risk | % | 2–10 | **Mandatory** on shorts; max adverse excursion tolerance; default 8 (since 2026-07-09) |
| `riskRules.atrStopPeriod` | Risk | integer | 7–20 | ATR lookback (days) if atrStops enabled; default 14 |
| `riskRules.atrStopMultiple` | Risk | number | 1.0–3.0 | ATR multiplier for stop distance; default 2.0 |
| `atrStops` | Risk (policy) | boolean | on/off | Volatility-scaled stops: stopLoss = ATR × multiple × entry% |
| `betaScaledStops` | Risk (policy) | boolean | on/off | Scale stops by name's beta: high-beta wider, low-beta tighter |
| `brokerBracketsEnabled` | Risk (policy) | boolean | on/off | Auto-attach OCO bracket legs to Alpaca orders (default on) |
| `robinhoodBrokerStops` | Risk (policy) | boolean | on/off | Maintain broker-held stop-market SELL on Robinhood (opt-in, default off) |

#### **Account-Level Circuit Breakers**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `riskRules.maxDrawdownPct` | Circuit | % | 5–20 | Auto-halt new entries when equity drops >this % from high |
| `riskRules.maxDailyLossNotional` | Circuit | USD | 200–5000 | Auto-halt new entries when daily loss exceeds this |
| `volPanicBrakeEnabled` | Circuit (policy) | boolean | on/off | Auto-halt on extreme VIX/VVIX/SKEW readings (default on) |
| `volPanicVixThreshold` | Circuit | number | 35–50 | VIX level triggering halt (default ~40) |
| `volPanicVvixThreshold` | Circuit | number | 100–150 | VVIX level triggering halt (default ~150) |
| `volPanicSkewThreshold` | Circuit | number | 140–180 | SKEW level triggering halt (default ~160) |

#### **Approval & Autonomy**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `systemState` | Authority | enum | "active", "close_only", "halted", "liquidating" | System-wide trading mode (ops can force close_only/halted) |
| `strategyAuthority` | Authority | enum | "propose", "decide" | "propose" = queue for approval; "decide" = auto-execute if policy passes |
| `proposalExpiryMinutes` | Approval | integer | 15–120 | Hard max age for pending proposal; auto-expires if not acted on |
| `proposalRevalidateCadenceHours` | Approval | integer | 0–120 | How often LLM re-confirms pending proposals (0 = every run) |
| `maxEntryDriftPct` | Approval | % | 0.5–5 | Reject stale OPENING market/$ orders if price drifted >this % |
| `maxQuoteAgeSec` | Approval | seconds | 0–3600 | Reject opening orders backed by quote older than this (fail-safe gate) |
| `maxFundamentalsAgeSec` | Approval | seconds | 0–3600 | Reject opening orders backed by fundamentals older than this |

#### **Order Execution**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `permittedOrderTypes` | Execution | enum array | ["market", "limit", "stop_market"] | Which order types the LLM may propose |
| `permitExtendedHours` | Execution | boolean | on/off | Allow pre/after-market orders (default off) |
| `runDuringExtendedHours` | Execution | boolean | on/off | Run strategy during extended hours (default off) |
| `runCadenceMinutes` | Execution | integer | 1–1440 | How often strategy runs (1m, 5m, 60m, etc.) |
| `allowExtendedHoursSyntheticStops` | Execution | boolean | on/off | Allow synthetic trailing-stop monitor during extended hours (default off) |
| `marketableLimitEntries` | Execution | boolean | on/off | Convert opening market orders to marketable-limit (priced through quote) |
| `marketableLimitBufferBps` | Tuning | basis points | 5–30 | How far through the quote to price (default 15 bps) |
| `STREAMS_ALPACA_PRICE_EVENTS_ENABLED` | Execution (env) | boolean | on/off | Real-time Alpaca minute-bar triggers (opt-in Alpaca-only feature) |
| `ALPACA_PRICE_EVENT_MOVE_PCT` | Execution (env) | % | 1–5 | Intraday move threshold for trigger (default 3%) |
| `ALPACA_PRICE_EVENT_VOLUME_MULT` | Execution (env) | multiplier | 1.0–3.0 | Volume spike threshold (default 1.5×) |
| `ALPACA_PRICE_EVENT_BREAKOUT/MOVE/VOLUME` | Execution (env) | boolean | on/off | Which technical signals trigger runs |

#### **Sell-to-Fund-Buy Mode**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `sellToFundBuy` | Sizing | enum | "off", "suggest", "propose", "automated" | When BUYs exceed buying power, auto-sell holdings to fund (opt-in) |

#### **Short Selling (opt-in feature)**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `shortSellingEnabled` | Authority | boolean | on/off | Allow short/cover proposals (requires broker support; RH MCP = unsupported) |
| `maxShortOrderNotional` | Sizing | USD | 50–5000 | Per-short cap (typically lower than regular max) |
| `maxShortExposurePct` | Limits | % | 5–30 | Max total short exposure as % of portfolio |

#### **Tax & Holding Horizon**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `taxSettings.taxationType` | Tax | enum | "taxable", "roth_ira", "traditional_ira" | Tax treatment (affects wash-sale + rate) |
| `taxSettings.washSaleGuard` | Tax | boolean | on/off | Block rebuy of loss-closed symbol within 30 days |
| `taxSettings.shortTermRatePct` | Tax | % | 10–40 | Marginal rate on short-term gains (ordinary income) |
| `taxSettings.longTermRatePct` | Tax | % | 0–20 | Marginal rate on long-term gains |
| `taxSettings.subtractFromResults` | Tax | boolean | on/off | Show performance net-of-estimated-tax |
| `holdingHorizon` | Strategy | enum | "intraday", "swing", "position", "longterm" | Shapes entry/exit timing + tax awareness |

#### **Tuning & Learning Loop**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `tuning.shrinkPrior` | Learning | pseudo-count | 1–10 | Bayesian regularization (small N dampening) |
| `tuning.minClosedLotsForWeightShift` | Learning | integer | 10–50 | Min closed trades before tuner may shift factor weights |
| `tuning.sizingFloorPct` | Learning | % | 5–20 | Minimum notional % the deterministic sizer allocates (exploration floor) |
| `tuning.sizingCeilingPct` | Learning | % | 80–100 | Maximum notional % (usually 100%) |
| `tuning.redTeamConvictionThreshold` | Learning | 0–100 | 50–90 | Confidence score above which Red Team reviews (default 80) |
| `tuning.crisisMaxOpeningExposurePct` | Learning | % | 0–10 | Cap opening % in crisis regimes (opt-in, default off) |
| `tuning.convictionCapUncorroborated` | Learning | 0–1 | 0.4–0.8 | Ceiling on conviction multiplier when realized edge doesn't corroborate (default 0.6) |
| `tuning.corroborationWinRatePct` | Learning | % | 50–65 | Shrunk win-rate above which conviction cap lifts (default 58%) |
| `tuning.corroborationEdgePct` | Learning | % | 0–5 | Shrunk avg return above which conviction cap lifts (default 0%) |
| `tuning.bearVetoFcfYieldFloorPct` | Learning | % | -5–5 | Hard veto: skip BUYs with FCF yield below this |
| `tuning.bearVetoDebtToEquityCeiling` | Learning | ratio | 2–5 | Hard veto: skip BUYs with debt/equity above this |
| `tuning.skipNegativeExpectancy` | Learning | boolean | on/off | Skip opening proposals with proven negative edge (conservative; default off) |
| `tuning.skipNegativeExpectancyEdgePct` | Learning | % | 0–2 | Edge threshold for skipNegativeExpectancy (default 0%) |
| `tuning.oosWithholdUnvalidated` | Learning | boolean | on/off | Withhold weight moves failing OOS validation (default on, conservative) |
| `tuning.useEntryRunAttribution` | Learning | boolean | on/off | Surface entry-run P&L attribution in tuning context (opt-in; default off) |
| `tuning.minProposalScoreThreshold` | Scoring | 0–100 | 0–40 | Candidates below this dropped before LLM (default 0 = unfiltered) |

#### **Scoring Weights (Factor Multipliers)**

| Parameter | Domain | Type | Range | Notes |
|-----------|--------|------|-------|-------|
| `scoringWeights.liquidity` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on trading volume / spread |
| `scoringWeights.momentum` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on intraday % move + technicals |
| `scoringWeights.value` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on P/E, P/B, FCF yield |
| `scoringWeights.quality` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on profitability, debt, growth |
| `scoringWeights.volatility` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on ATR, beta, 52w range |
| `scoringWeights.sentiment` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on news, analyst, insider sentiment |
| `scoringWeights.positioning` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on Congress, insider, short squeeze signals |
| `scoringWeights.diversification` | Scoring | 0.6–1.4 | Default 1.0 | Multiplier on sector correlation, holdings concentration |

#### **Notifications**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `notificationSettings.enabledEvents` | Notifications | enum array | Any of: fill, block, run_failed, pending_approval, kill_switch, price_alert, proposal_withdrawn, limit_order_stale, provider_degraded | Which event types fire alerts |
| `NOTIFY_EMAIL_FROM` | Notifications (env) | string | "alerts@domain.com" | From address for email alerts (Resend) |
| `RESEND_API_KEY` | Notifications (env) | secret | Set if email enabled | Email provider key |
| `NOTIFY_PUSH_PROVIDER` | Notifications (env) | enum | "ntfy", "pushover" | Push notification service |
| `PUSHOVER_APP_TOKEN` | Notifications (env) | secret | Set if Pushover enabled | Pushover app token |
| `TWILIO_ACCOUNT_SID` | Notifications (env) | secret | Set if SMS enabled | Twilio account |
| `TWILIO_AUTH_TOKEN` | Notifications (env) | secret | Set if SMS enabled | Twilio token |
| `TWILIO_FROM` | Notifications (env) | phone | "+1XXXXXXXXXX" | SMS from number (Twilio) |
| `NOTIFY_TIMEOUT_MS` | Notifications (env) | milliseconds | 1000–10000 | Alert delivery timeout (default 5s) |
| `staleLimitOrderMinutes` | Notifications | integer | 5–30 | Stale limit-order alert threshold (default 15 min) |

#### **Data Provider Keys & Web Sources**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `FINNHUB_API_KEY` | Market Data (env) | secret | User or operator key | Fundamentals + analyst ratings enrichment |
| `FMP_API_KEY` | Market Data (env) | secret | User or operator key | FMP fundamentals + analyst consensus |
| `FMP_MAX_SYMBOLS` | Market Data (env) | integer | ≥1, unclamped | Optional explicit throttle on symbols enriched per scan; unset, every requested candidate is enriched (no cap — owner ruling 2026-07-09) |
| `FMP_PRICE_TARGETS_ENABLED` | Market Data (env) | boolean | on/off | Fetch analyst price targets (opt-in; extra call per symbol) |
| `FRED_API_KEY` | Market Data (env) | secret | User or operator key | Macro data (rates, inflation, unemployment) |
| `ALPHAVANTAGE_API_KEY` | Market Data (env) | secret | User or operator key | News sentiment, macro backfill |
| `MASSIVE_S3_*` | Market Data (env) | credentials + endpoint | Parquet lake config | S3 flat-file OHLC backfill (Massive) |
| `MASSIVE_FLATFILE_BACKFILL_YEARS` | Market Data (env) | integer | 1–10 | Years of history per symbol (flat-file backfill) |
| `WEB_SOURCE_CONGRESS` | Web Sources (env) | boolean | on/off | Congressional trade signals (congress.trade) |
| `WEB_SOURCE_INSIDER` | Web Sources (env) | boolean | on/off | Insider transaction sentiment |
| `WEB_SOURCE_FINRA` | Web Sources (env) | boolean | on/off | Finra short %, short borrow costs |
| `WEB_SOURCE_SEC8K` | Web Sources (env) | boolean | on/off | SEC 8-K rapid-disclosure indexing (RAG) |
| `WEB_SOURCE_SEC8K_RAG_LIMIT` | Web Sources (env) | integer | 1–50 | Max 8-K docs sent to RAG per refresh |
| `WEB_SOURCE_TECHNICAL` | Web Sources (env) | boolean | on/off | Technical signals (TradingView or computed) |
| `TECHNICAL_SOURCE` | Web Sources (env) | enum | "tradingview" or "computed" | Technical signal source |
| `TRADINGVIEW_WEBHOOK_SECRET` | Web Sources (env) | secret | Webhook signing key | TradingView alert auth |

#### **Multiuser & Auth**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `PRIMARY_USER_EMAIL` | Auth (env) | email | "user@domain.com" | Primary operator (legacy "local" dataset) |
| `PRIMARY_USER_EMAIL_ALIASES` | Auth (env) | comma-separated emails | e.g., "gmail@, custom@" | Alternate emails = same primary account |
| `ALLOWED_EMAILS` | Auth (env) | comma-separated emails | e.g., "extra@, invite@" | Additional users permitted (app-level allowlist) |
| `AUTH_SECRET` | Auth (env) | 32-byte random | Generated with openssl | Auth.js session secret (arms auth) |
| `AUTH_GOOGLE_ID` / `_SECRET` | Auth (env) | OAuth credentials | From Google Cloud | Google sign-in provider |
| `AUTH_GITHUB_ID` / `_SECRET` | Auth (env) | OAuth credentials | From GitHub → Settings | GitHub sign-in provider |
| `AUTH_APPLE_ID` / `_SECRET` | Auth (env) | OAuth credentials | From Apple Developer | Apple Sign In provider |
| `ENCRYPTION_KEY` | Auth (env) | 64-char hex | openssl rand -hex 32 | AES-256-GCM master key for per-user API keys |

#### **Broker Integrations**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `ROBINHOOD_ADAPTER` | Broker (env) | enum | "mock" or "mcp" | Mock = disconnected; mcp = real MCP path |
| `ROBINHOOD_MCP_URL` | Broker (env) | URL | https://agent.robinhood.com/mcp/trading | Robinhood MCP endpoint |
| `ROBINHOOD_MCP_AUTH_TOKEN` | Broker (env, user-keyed) | secret | Per-user OAuth token | Robinhood MCP authentication |
| `ROBINHOOD_MCP_OAUTH_DISCOVERY` | Broker (env) | boolean | on/off | Auto-discover OAuth endpoints vs manual config |
| `ALPACA_PAPER_API_KEY` | Broker (env, user-keyed) | secret | User or env fallback | Alpaca paper-trading credentials |
| `ALPACA_PAPER_SECRET_KEY` | Broker (env, user-keyed) | secret | User or env fallback | Alpaca paper secret |
| `ALPACA_DATA_WS_URL` | Broker (env) | URL | Real-time WS endpoint | Alpaca price-event websocket (optional override) |

#### **Persistence & Recovery**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `AUTONOMY_RESUME_ON_BOOT` | Safety (env) | boolean | off/on | Preserve running autonomy state on restart (default off; safe) |
| `SCHEDULER_SINGLE_LEADER` | Clustering (env) | boolean | off/on | Single-leader lease for multi-process deploys (default on; unset/empty is on, explicit false/off/0/no disables) |
| `SCHEDULER_LEASE_TTL_MS` | Clustering (env) | milliseconds | 30000–180000 | Lease validity window (default 90s) |

#### **Observability & Debug**

| Parameter | Domain | Type | Typical Range | Notes |
|-----------|--------|------|----------------|-------|
| `SENTRY_DSN` | Telemetry (env) | Sentry project DSN | Set to enable error tracking | Server error + performance tracing (redacted) |
| `NEXT_PUBLIC_SENTRY_DSN` | Telemetry (env) | Sentry project DSN | Set to enable browser errors | Client-side error tracking (inlined at build) |
| `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` | Telemetry (env) | boolean | off/on | Session replay (opt-in; default off; masks text/blocks media) |
| `LANGFUSE_PUBLIC_KEY` | Telemetry (env) | secret | Langfuse org key | LLM observability (prompts + usage, redacted) |
| `LANGFUSE_SECRET_KEY` | Telemetry (env) | secret | Langfuse secret | Langfuse backend auth |
| `LANGFUSE_ENABLED` | Telemetry (env) | boolean | on/off | Enable Langfuse integration (default on) |
| `LANGFUSE_CAPTURE_IO` | Telemetry (env) | enum | "summary" or "detailed" | Capture mode: summaries only (default) or raw |

---

### KEY DATA ENTITIES & RELATIONSHIPS

#### **Core Identity & Access**

- **users** (derived from auth; never stored): email → userId (immutable)
- **user_api_keys**: per-user encrypted API keys (OpenAI, Anthropic, Alpaca, Robinhood, market-data keys); keyed by userId + provider
- **user_memory** (salience-gated chat extractions): userId, kind, subject, value, confidence, supersededBy
- **connected_accounts**: userId, broker, environment, accountNumber, capabilities (json), credentials (encrypted)

#### **Strategy & Configuration**

- **strategy_profiles**: userId, name, policy (json), prompt, scoringWeights (json), active flag
- **settings**: userId, activeBroker, policy (json, overridable per account)
- **autonomy_state** (implicit in policy.systemState): halted, close_only, active

#### **Trading Data**

- **trade_proposals**: userId, accountNumber, symbol, side, type, quantity, rationale, thesisTag, status (proposed/placed/paper/blocked/expired), confidence, referencePrice, createdAt, ...
- **strategy_runs**: userId, accountNumber, startedAt, finishedAt, status, summary, placedCount, paperCount, blockedCount
- **fill_events**: userId, accountNumber, symbol, side, quantity, price, filledAt, mae, mfe, source (live/paper), ...
- **portfolio_snapshots**: userId, accountNumber, equity, cash, buyingPower, positions (json), createdAt, executionMode
- **open_positions** (derived from fills + exits): userId, accountNumber, symbol, quantity, entryPrice, sector, entryAt, ...

#### **Risk & Performance**

- **trade_outcomes** (post-mortem closures): userId, symbol, side, entryPrice, exitPrice, pnl, returnPct, holdingDays, thesisTag, regime, mae, mfe
- **thesis_stats** (aggregated): userId, thesisTag, tradeCount, winRate, avgReturnPct, shrunkWinRate
- **regime_stats** (aggregated): userId, regime, tradeCount, winRate, avgReturnPct, shrunkWinRate
- **closed_lots** (transactional view): for tax-lot tracking + learning

#### **Learning & Continuous Improvement**

- **learned_context**: userId, scope (private/shared), kind (pattern/decision/fact), subject, value, riskTier, confidence, origin (chat/autonomous/ingest), supersededBy
- **learned_context_pending**: userId, kind, value, riskTier (risk/strategy-directive only), status (pending/approved/rejected), createdAt
- **counterfactual_learning**: skipped candidates + their later returns (for missed-opportunity analysis)
- **signal_snapshot** (audit): runId, per-candidate decision-time evidence (score, factors, signals, congress, confidence)

#### **Audit & Compliance**

- **audit**: kind, eventType, userId, accountNumber, createdAt, payload (json); immutable log for all state changes
- **account_deletion_requests**: userId, status, requestedAt, completedAt
- **llm_usage**: userId, provider, model, keyRef, inputTokens, outputTokens, cost, createdAt

#### **Notifications & Alerts**

- **price_alerts**: userId, symbol, op (</>), price, status (armed/triggered), triggeredAt, note
- **watchlist_items**: userId, symbol, addedAt
- **notification_events**: userId, type, title, status (sent/failed/skipped), payload, createdAt
- **notify_prefs**: userId, channels (json array), pushTarget, webhookUrl, email, phone

#### **Chat & History**

- **chat_turns**: userId, role (user/assistant), text, citations (json), intent, model, createdAt, redacted (boolean)
- **ingest_accessions** (SEC filings, congress trades): accession, docType, ticker, chunkCount, ingestedAt

---

### INTEGRATIONS

#### **Data Providers (Market Data & Enrichment)**

| Provider | Capability | Config | Usage |
|----------|-----------|--------|-------|
| **Alpaca** | Quotes, OHLC, broker orders, paper sim | API key (user/env), baseUrl | Real-time quotes, broker gateway, paper fills |
| **Finnhub** | Fundamentals, analyst, company profiles | API key | P/E, EPS, dividend yield, sector, analyst consensus |
| **FMP** | Fundamentals, analyst targets, company data | API key, max symbols cap | Enhanced fundamentals, analyst price targets (opt-in) |
| **FRED** | Macro (rates, inflation, unemployment, spreads) | API key | Fed funds rate, 10y yield, CPI, jobless claims |
| **Yahoo Finance** | Quotes, OHLC, technicals (free) | No key required | Final enrichment tier (always available) |
| **Massive (S3 lake)** | Historical OHLC + fundamentals (Parquet/Iceberg) | S3 creds + endpoint | Bulk history backfill for closed-lot learning |
| **Alpha Vantage** | Macro backfill, news sentiment | API key | Alternative macro history, sentiment |
| **CBOE** | VIX, VVIX, SKEW (free) | No key required | Volatility gauges for regime + panic brake |
| **TradingView** | Technical signals (webhooks) | Webhook secret | Intraday technicals (real-time push) |
| **Congress.Trade** | Congressional trades + composite scoring | Bearer token + base URL | Smart-money positioning signal |
| **SEC Edgar** | 8-K / 10-K / 10-Q documents | User-Agent header | Rapid-disclosure + earnings analysis |
| **Finra** | Short %, borrow costs | Free scrape | Short pressure signals |
| **Insider Filings** | Officer/director transactions | Free scrape | Insider sentiment + FORM 4 parsing |

#### **Broker Gateways**

| Broker | Protocol | Features | Execution |
|--------|----------|----------|-----------|
| **Robinhood (MCP)** | Model Context Protocol | Long/short, market/limit, extended hours | Live + paper sim; OAuth-authenticated |
| **Alpaca** | REST API + WebSocket | Fractional, OCO brackets, full order types | Paper + live; native bracket support |
| **Test/Local** | SQLite sim | Configurable slippage + cost model | Local fills with optional realistic costs |

#### **LLM Providers (User-Selectable)**

| Provider | Models | Green Team | Red Team | Availability |
|----------|--------|-----------|----------|--------------|
| **OpenAI** | GPT-5, o-series (reasoning), 4.1-mini | Default fallback | Supported | Operator fallback + per-user override |
| **Anthropic** | Claude Opus, Sonnet, Haiku | Supported | Supported (Red Team override) | Operator fallback + per-user override |
| **xAI** | Grok-3, Grok-2 | Supported | Supported | Operator fallback + per-user override |
| **Google** | Gemini 2.0, 1.5 | Supported | Supported | Operator fallback + per-user override |
| **Mistral** | Mistral Large, Medium | Supported | Supported | Operator fallback + per-user override |
| **DeepSeek** | DeepSeek-V3, R1 | Supported | Supported | Operator fallback + per-user override |

#### **Notification Delivery**

| Channel | Provider | Config | Use |
|---------|----------|--------|-----|
| **Email** | Resend | API key + from address | User-enabled in Settings |
| **Push** | ntfy or Pushover | ntfy server URL or Pushover token | User-enabled + target address |
| **SMS** | Twilio | Account SID + auth token + from phone | User-enabled + phone number |
| **Webhook** | Custom URL | User-supplied endpoint | User-enabled + webhook URL |

#### **Observability & Analytics**

| Tool | Purpose | Config | Data Captured |
|------|---------|--------|----------------|
| **Sentry** | Error + performance tracing | DSN (server + client) | Redacted stack traces, session context, P95 latencies |
| **Langfuse** | LLM observability | API keys + base URL | Proposal summaries, tuning decisions, token usage (NO raw prompts) |

#### **Authentication & Secrets**

| System | Provider | Purpose | Config |
|--------|----------|---------|--------|
| **Auth.js** | Google, GitHub, Apple OAuth | User identity | OAuth client IDs/secrets, AUTH_SECRET |
| **Infisical** | Secrets manager (optional) | Bootstrap secrets | Client ID/Secret for auto-mint access tokens |
| **Litestream** | SQLite WAL replication (optional) | Disaster recovery | S3 bucket + credentials |

---

### AUTHORITY & SAFETY MODEL

#### **Decision Hierarchy**

1. **Deterministic policy gates** (always run, never bypass)
   - Universe/blocklist, account state (halted/close_only), notional caps, exposure limits, entry drift, wash-sale, PDT, margin minimum
   - **Blocking outcome**: proposal rejected + audit logged + optional notification

2. **LLM proposal generation** (conditional on policy pass)
   - Bull (Green Team) generates N proposals from market scan + context
   - Red Team (Bear) reviews each for conviction + thesis soundness

3. **Authority-driven execution**
   - **"Propose" mode**: proposals queue; human must approve
   - **"Decide" mode**: auto-execute if policy gates pass (but still subject to broker review when available)

4. **Broker review** (when provider supports)
   - Alpaca/Robinhood validate order feasibility (margin, buying power, tradability)
   - Orders failing broker review are rejected before submission

#### **Autonomy Gates**

| Gate | Trigger | Recovery |
|------|---------|----------|
| **Drawdown circuit breaker** | Equity drops >maxDrawdownPct from high | Manual reset (user intervention required) |
| **Daily loss limit** | Day's loss exceeds maxDailyLossNotional | Manual reset at midnight or manual intervention |
| **Kill-switch (vol panic)** | VIX/VVIX/SKEW exceeds configurable thresholds | Manual reset (user must re-enable) |
| **Hourly cap breach** | Rolling 60-min notional exceeds maxHourlyNotional | Auto-revert to "propose" mode until window resets |
| **Autonomy boot reset** | App restarts with account left "active" | Auto-revert to "halted" (AUTONOMY_RESUME_ON_BOOT can override, dev-only default) |

#### **Audit & Accountability**

- **Every decision** logged: proposal, policy evaluation, reasons for acceptance/rejection, order outcome
- **Every fill** stamped: timestamp, price, quantity, execution mode (live/paper/test), sector, strategy run ID
- **Every tuning change** recorded: weights before/after, confidence, OOS validation result
- **Every learning** traced: origin (chat/autonomous/ingest), classifier reason if rejected, human approval status
- **Immutable audit table**: no deletes, only appends + supersession links; full trace reconstructible

#### **Per-User Safeguards**

- **API key encryption**: AES-256-GCM per-user master key; keys stored encrypted in DB, never in env
- **Chat redaction**: secrets/PII stripped on write; transcript never exposes credentials
- **Cross-account isolation**: user's data never visible to other users; each sees only own profiles/fills/audit
- **Rate-limit resistance**: per-user LLM usage tracked; fallback key subject to operator budget gating

#### **Emergency Controls**

- **System-wide halts**: operator can set systemState to "halted" (blocks all opens) or "close_only" (allows risk-reducing exits only) via settings
- **Account disconnection**: revoke broker credentials + clear connected-account state
- **Kill-switch**: configurable circuit breakers auto-trip + fire notifications
- **Account deletion**: user-initiated or operator-forced; anonymized audit trail retained (subject hash + completion timestamp only)

---

**END OF INVENTORY**
