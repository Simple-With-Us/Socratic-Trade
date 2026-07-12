# Phase 7 - AI Trading Strategy (Design)

This document defines the comprehensive architecture for the AI Trading Strategy, including how the LLM evaluates the market, scores individual equities, and continuously learns from its own outcomes.

## 1. Strategy Architecture: Evaluation Lenses

To ensure balanced and resilient trade proposals, the LLM evaluates candidates
across macro, fundamental, technical, sentiment/news, alternative-data, and
adversarial-debate lenses before making a decision.

### A. Macro, Thematic, & Market Context
*Don't fight the Fed, and don't fight the broader trend.*
- **Core Macro Indicators:** SPY/QQQ daily trends, `^VIX` (Volatility Index), Fed Funds Rate trajectory, CPI/Inflation trends, Unemployment data, and broad market breadth (advancers vs. decliners).
  - *Implementation Target:* Integrate `VIXCLS` via the FRED API (already available in `macro.ts`) to immediately unlock "de-risk in high-vol regimes" logic.
- **Thematic & Structural Shifts:** Tracking long-term disruptive trends that create secular tailwinds or headwinds across entire sectors (e.g., GLP-1 weight loss drug adoption impacting not just food/healthcare, but downstream retail, clothing, and cosmetics sectors; AI infrastructure spending; housing/cost of living trends; and shifting consumer habits).
- **Goal:** Establish the risk regime. In a high-VIX or downtrending market, the strategy should naturally demand higher conviction for long positions, pivot to defensive sectors, or seek opportunistic **short** setups.

### B. Fundamental Factors
*Ensure underlying business health and value.*
- **Indicators:** Forward P/E Ratio vs. Sector Average, EPS Growth (QoQ/YoY), Free Cash Flow yield, Debt-to-Equity ratio, and forward guidance sentiment.
  - *Implementation Target:* Leverage SEC EDGAR (free, authoritative) for XBRL financials and 8-K filings, and explore Twelve Data or Tiingo for enhanced fundamental indicators.
- **Goal:** Identify structurally sound companies that are mispriced relative to their earnings potential for long positions, or conversely, identify fundamentally deteriorating companies (e.g., shrinking margins, high debt) as prime **short** candidates.

### C. Technical Factors
*Optimize entry and exit timing.*
- **Indicators:** Moving Averages (50-day and 200-day alignment), RSI (detecting extreme overbought > 70 or oversold < 30 conditions), MACD crossovers, Support/Resistance zones, and anomalous Volume spikes.
- **Goal:** Prevent buying "value traps" that are in a freefall, avoid chasing fundamentally strong stocks that are dangerously overextended, and optimally time entries for **short** positions (e.g., shorting at strong resistance or breakdown confirmations).

### D. Sentiment & News Catalysts
*Identify short-term directional fuel.*
- **Indicators:** Real-time company-specific headlines, earnings call sentiment (derived from NLP), sector-level news, and macro shock events.
  - *Implementation Target:* Upgrade the current keyword-heuristic sentiment scorer to a real ML model. Prioritize **Alpha Vantage NEWS_SENTIMENT** (drop-in API, utilizing our existing key) or score existing Finnhub headlines via a local **FinBERT** model. Use zero-key RSS feeds (Yahoo Finance, Google News) for broad catalyst capture.
- **Goal:** Anticipate sudden price re-ratings driven by external events that technicals and fundamentals have not yet priced in.

### E. Alternative Data & Alpha
*Gain an informational edge over retail consensus.*
- **Indicators:** Insider trading ratios (Form 4), Congressional trading activity, Unusual Options Activity (UOA) / Dark Pool prints, and NLP summarization of raw SEC EDGAR filings (8-K Material Events, 10-Q Risk Factors).
  - *Implementation Target:* Prioritize **FMP's senate and insider endpoints** (since the FMP key is already integrated) as the most cost-effective path to smart-money signals. Add SEC EDGAR RSS for authoritative Form 4 insider trades.
  - *(Note: We will integrate the Quiver Quantitative API in the short-term future to specifically source high-quality Congressional trading and lobbying data).*
- **Legislative & Litigation Risk:** Actively monitoring for pending lawsuits, anti-trust actions, or major legislative changes (e.g., subsidies, new tariffs, regulatory approvals) that could drastically re-rate a company's valuation overnight.
- **Token Efficiency Mechanism:** Raw filings and options chains are *never* fed directly to the active prompt. An asynchronous background task digests these alternative data streams and produces 1-sentence bulletins (e.g., *"Insider buying detected at 52-week lows; 8-K shows new DoD contract"*).
- **Goal:** Uncover hidden risks or catalysts before they hit mainstream financial news headlines.

### F. Multi-Agent "Bull vs. Bear" Debate
*Prevent confirmation bias and hallucination.*
- **Mechanism:** Before a high-conviction trade is finalized, the proposal is routed to a separate "Red Team / Bear" prompt. This prompt is tasked *exclusively* with finding reasons the trade will fail (e.g., hidden technical resistance, negative sector news, overvaluation).
- **Goal:** The main agent must successfully address or invalidate the Bear agent's concerns before the trade is approved, ensuring maximum robustness and quality.
- **Implementation status (2026-07-01, Audit Chat A):** the inline Bear critique inside
  `proposeTrades` now **fails CLOSED** — if it can't run (missing key, transport
  error/timeout, unparseable response) the un-critiqued Bull proposals are routed to
  human review in `decide` mode instead of auto-executing (never a silent carry-forward),
  with a loud audit + `provider_degraded` notification. The Bull/Bear system prompts are
  extracted to the versioned leaf module `src/lib/strategy-prompts.ts`
  (`STRATEGY_PROMPT_VERSION` + `buildBullSystem`/`buildBearSystem`), stamped onto every
  proposal via `trade_proposals.prompt_version`, and covered by a deterministic offline
  eval (`npm run eval:strategy-offline`). The per-proposal `debateProposal` red-team now
  requests strict `json_schema` on OpenAI-compatible providers, and the strategy/red-team
  Anthropic calls use prompt caching. See
  `docs/rollouts/2026-07-01-strategy-llm-money-path.md`.
- **Proposed redesign (design-only, 2026-07-01):** `docs/single-adversary-consolidation.md`
  proposes collapsing today's *two* adversarial passes (the in-flow Bear inside `proposeTrades`
  and the standalone `debateProposal`, which run the same model twice) into a single hardened
  **Red Team** that reviews the finalized (post-sizing) trade, fails **closed and visibly** when
  it can't run, never blocks a risk-reducing exit, and is provably independent of the proposer.
  Not yet implemented; decisions resolved in that spec's §9, review refinements in §12.
- **First-class verdict (2026-07-01):** the Red Team debate result is stored on the proposal as a
  structured `redTeamVerdict?: { rejected; available; reason }` field (`TradeProposal` in
  `src/lib/types.ts`), not just appended to the free-text rationale. It survives the JSON round-trip
  into `trade_proposals` (folded into the existing payload column — no migration), so the dashboard
  can render a dedicated "Bear Review" block instead of burying the critique in a truncated
  rationale. The backward-compat rationale-append text is preserved.
- **Bear-veto audit (2026-07-01):** a Bear *rejection* now writes an
  `audit("proposal_rejected_by_red_team", { symbol, side, thesisTag, reason })` row before the
  proposal is dropped — parity with the sibling `proposal_skipped_negative_ev` /
  `proposal_skipped_correlation` audits — so a vetoed high-conviction trade is visible in the
  Activity/Audit feed rather than only in the server console.
- **Bear-veto counterfactuals + efficacy scorecard (2026-07-04):** the audit event above is now
  additionally stamped with `runId` and `model`, and the Bear-reject branch calls
  `recordRejectedProposalCounterfactual` for opening (buy/short) proposals — the same
  counterfactual pipeline policy blocks and human rejections already feed — so a vetoed
  high-conviction trade's post-veto return matures into missed-opportunity analytics. New
  `getRedTeamEfficacy()` (`src/lib/performance.ts`) joins the audit events to matured
  counterfactual rows (via `runId+symbol`) and reports rejection rate, veto value-add (the vetoed
  trade lost money — the Bear helped), survivor-risk hit rate (the vetoed trade won — the Bear
  missed it), and a per-model breakdown. Advisory/read-only; API/db-level only — no console/Results
  UI wiring yet (see `docs/rollouts/2026-07-04-w1-learning-loops.md`).
- **The Outcome Engine (2026-07-04, Wave 2):** loop step 5 is no longer a stub —
  `src/lib/outcome-engine.ts` (`matureSocraticDecisionOutcomes`, fired on the counterfactual
  cadence from `strategy.ts`) writes `SocraticDecisionCase.outcome`: placed decisions join their
  `fill_events` entry and realized FIFO closed-lot P&L; blocked/rejected decisions (incl. Bear
  vetoes) join their counterfactual `refPrice`. Outcomes are MULTI-HORIZON —
  `outcomes[] {15m|1h|1d|1w, returnPct, spyExcessPct, priceBasis, resolution}` (pure math in
  `src/lib/outcome-horizons.ts`, trading-day arithmetic) — on decision cases and on
  skipped-counterfactual rows. 1d/1w come from daily closes via the cascade, SPY-relative;
  15m/1h resolve only from an actually-sampled live quote, else land honestly as
  `unresolvable(no_intraday_source)`. Kill-survivorship: a symbol whose series never resolves
  within a bounded 10-trading-day recheck window terminates `unresolvable` (with reason) and
  stays in every denominator — coverage disclosures ("N/M resolved (X%)") ride on job receipts,
  `getRedTeamEfficacy`, the missed-opportunity summary, and `certifyForwardResolution`. On case
  closure a budget-gated, batch-capped LLM post-mortem replaces the template `lessons[]` with
  1-3 direction-tagged lessons (+`verdictOnBelief`/`whichDissentMattered`), re-indexes the case
  vector, and routes each lesson through `ingestLearned` (origin `autonomous`); every skip is
  receipted. See `docs/rollouts/2026-07-04-w2-outcome-engine.md`.
- **Durable due-jobs substrate for 15m/1h sampling (2026-07-05):** the 15m/1h sample no longer
  depends on a `runStrategyOnce` cadence run coincidentally landing inside the tolerance window. A
  generic claimable job queue (`due_jobs` table, `src/lib/db-jobs.ts`, lease/reclaim so a crashed
  claim is never stuck) is enqueued the moment a case's entry basis (fill or ref price) is known;
  `outcome-engine.ts`'s `drainDueIntradaySampleJobs` worker (called from `scheduler.ts`'s `tick()`)
  drains due jobs, samples a live quote, and writes through the exact same
  `mergeHorizonRows`/write path the inline sampling uses — so whichever side resolves a horizon
  first wins and the other is a documented no-op, never a duplicate row. The inline sampling path
  described above is unchanged and still runs; this is additive redundancy, not a replacement. See
  `docs/rollouts/2026-07-05-durable-due-jobs.md`.

---

## 2. Initial Factor Weighting Matrix

When initially deployed (or for new Strategy Profiles), the system uses a default scoring matrix to blend the core deterministic factor scores. The LLM sees these scores plus source evidence and scales its confidence around them rather than replacing deterministic policy gates.

**Baseline Default Weights:**
- **Fundamentals (Value/Growth): 30%** (Anchor the portfolio in real business health)
- **Macro/Regime Alignment: 25%** (Respect the broader market environment)
- **Technicals (Timing/Momentum): 25%** (Ensure optimal entry execution)
- **News/Sentiment (Catalysts): 20%** (Capture short-term momentum triggers)

*Note: The strategy is designed to allow these weights to be dynamic. They serve as a starting point, but the system will actively recommend tuning them based on actual performance.*

---

## 3. The Auto-Tuning Engine (The Learning Loop)

The most critical component of the AI strategy is its ability to remember past trades, evaluate its own decisions, and suggest improvements. This forms the "Auto-Tuning Engine".

### A. Context Snapshots & Execution Metrics
Every executed trade records a comprehensive `StrategyOutcome` that goes far beyond simple P&L.
- **Execution Realism:** The learning loop explicitly penalizes the LLM for slippage and transaction costs. The system logs gross vs. net performance, forcing the LLM to learn the "cost of doing business" and favoring higher-conviction setups over rapid, unprofitable scalping.
- **Context Snapshots:** The system logs `entryMarketRegime` and `exitMarketRegime` (e.g., exact VIX and SPY trend at the time of the trade). This allows the LLM to learn context-specific rules (e.g., "My momentum trades fail when VIX > 25").
- **MAE & MFE:** The system calculates Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE) during the holding period. This teaches the LLM about its timing: Is it cutting winners too early? Is it holding losers too long through massive drawdowns?
- **Trade Thesis Classification:** The LLM must tag its initial proposal with a `tradeThesisTag` (e.g., *Mean Reversion*, *Breakout*, *Value Play*, *Earnings Catalyst*). 

```ts
export interface StrategyOutcome {
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: "paper" | "live";
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  rationale: string;
  entryPrice?: number;
  entryAt?: string;
  exitPrice?: number;
  exitAt?: string;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  returnPct?: number;
  holdingDays?: number;
  sector?: string;
  tradeThesisTag?: string; // e.g., Mean Reversion, Breakout, Value
  riskExit?: "stop_loss" | "take_profit" | "trailing_stop";
  entryMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at entry
  exitMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at exit
  mae?: number; // Maximum Adverse Excursion during holding
  mfe?: number; // Maximum Favorable Excursion during holding
}
```

### C. Risk Management & Short Selling Guardrails
While the strategy evaluates trades across the strategy lenses, it must also respect absolute risk parameters, especially given the infinite risk profile of short selling.
- **Short Selling Risk Cap:** Short positions must be heavily scrutinized. The maximum allowable portfolio allocation for any single short position will be strictly capped (e.g., lower than long positions).
- **Hard Stop-Losses:** Any short proposal must carry an absolute, non-negotiable stop-loss logic (e.g., max 5% adverse excursion) to prevent runaway losses.

### C.1 Pending-Proposal Staleness (Expiry + On-Run Re-Validation)
Proposals stay in the approval queue until a human approves or rejects them, so an old one can keep looking like a current recommendation. Two mechanisms keep the queue honest (`src/lib/proposal-revalidation.ts`):

1. **Deterministic hard expiry** — `policy.proposalExpiryMinutes` (default 2880 = 2 days; 0 = Never). A pending proposal older than the TTL is moved to status `expired` with an audit event, a `proposal_withdrawn` notification, and an SSE refresh. It runs at the **start of every strategy run** and on **every scheduler tick** (even while halted or the market is closed), so the queue self-clears regardless of run cadence. UI: a dropdown (3h / 6h / 12h / 1d / 2d / 5d / 10d / Never).
2. **On-run LLM re-validation, cadence-gated to market hours** — `policy.proposalRevalidateCadenceHours` (default 0 = every run). It is not optional (no on/off switch) — it rides on strategy runs. Inside `runStrategyOnce`, each still-pending proposal that is **due** (≥ cadence hours since it was created or last re-checked; 0 = always) is re-checked against the fresh scan + current regime in one batched LLM call ("does this still stand?"). It runs **only during the regular US session** (`currentMarketSession === "regular"`), so it never re-checks overnight — re-checking when nothing can be acted on is wasted work and the scan would be stale. `reaffirm` stamps `last_revalidated_at` (the dashboard then shows "Re-checked X ago — still advised" and the staleness clock resets); `withdraw` moves it to status `withdrawn`. Ambiguous/missing output defaults to *keep*; the pass is skipped (deterministic expiry still applies) when the market is closed, `OPENAI_API_KEY` is absent, or the call fails. UI: a dropdown (Every run / Once per day / Every 5 days).

### C.2 Opening Size and Broker Bracket Practicality

The LLM advises proposal size, but deterministic sizing remains authoritative.
`limits.maxOrderNotional` in the prompt is the absolute cap after combining
absolute and percent-of-NAV policy settings; `limits.preferredMaxOrderNotional`
is the normal opening-size target after reserving a 5% execution buffer below
that cap. Hidden stale values must not bind behind the user's visible risk
control, and proposals should not sit exactly on the hard policy tripwire. The
policy gate also enforces this opening-order buffer, so a `$4.99` max order cap
allows a preferred opening size up to `$4.74`; larger orders are blocked with a
reason telling the user to reduce size or raise the policy cap. For Alpaca
REST/MCP native brackets, a dollar order needs enough notional to represent at
least one whole share at the reference price. If the advised notional is below
that threshold and policy capacity allows it, the deterministic pass raises the
order to one-share notional and records the reason. If the cap does not allow a
full share, the proposal may remain a fractional dollar order, but native Alpaca
bracket legs are skipped so the broker is not asked for an impossible sub-share
bracket.

As of 2026-06-28, `TradeProposal.referencePrice` is explicitly the decision-time
market quote used for entry-drift checks and proposal/counterfactual performance
readouts. A limit or stop entry may be different; bracket legs and Alpaca
whole-share bracket feasibility use the intended entry price (`limitPrice` /
`stopPrice` / market anchor fallback) so a below-market limit order does not
make a fresh proposal look as though it already gained versus its market anchor.

### C.3 Broker-Held Exit Availability

Before any broker-backed sell or cover reaches order placement, the strategy
subtracts active broker-held exit orders from the current position quantity. This
guards against duplicate exits when a prior bracket/OCO leg, stop, take-profit,
or pending manual sell already reserves the same shares at the broker. If the
requested exit exceeds the remaining broker-available quantity, the proposal is
blocked with a normal policy-style reason instead of being sent to the broker and
surfacing as an uncertain placement failure.

The guard is intentionally pre-submit and fail-closed: it does not silently clamp
the exit quantity. The user must cancel or replace the existing broker order if a
different exit is desired.

### C.4 Broker Order Lifecycle and Stale Limit Alerts

Broker-backed order acceptance is not execution. The app keeps the existing
proposal status value `placed` for compatibility, but user-facing surfaces render
that state as `Submitted` / `Working` until either the broker order state or fill
reconciliation confirms execution. `filled` fill events remain the accounting
truth for P&L and portfolio projection. Broker-paper pending reconciliation rows
are excluded from paper accounting until a broker fill is observed; legacy
Test/local simulated fills remain accounting-valid.
If the broker reports an order as filled before the local fill row reconciles,
the UI still treats the group as Working/pending reconciliation. Local `filled`
events remain the accounting and completed-trade truth.

The scheduler reconciles pending broker fills for both `broker/paper` and
`broker/live` accounts. It also checks broker-backed limit and stop-limit orders
against `policy.staleLimitOrderMinutes` (default 15, 0 disables). A working order
older than the threshold emits one deduped `limit_order_stale` audit/notification
per order and threshold, so the operator can decide whether to cancel, reprice,
or intentionally replace it with a market order.

Activity exposes a guarded `Market replace` action for stale working limit and
stop-limit orders. The server cancels the original order, waits briefly, re-reads
broker order state, and submits a market order only for the remaining quantity
once the original is no longer active. For `broker/live`, the operator must type
`REPLACE LIVE <SYMBOL>` and the confirmation must match the selected account,
order id, execution mode, and remaining quantity before the cancel request is
sent.

### D. Token Efficiency & Asynchronous Post-Mortems
Feeding dozens of raw rationales, P&L lines, and redundant daily news into the trading prompt wastes massive amounts of tokens and degrades LLM reasoning. To optimize this:

1. **Information-Theoretic Pruning (Tiered Memory):** The system feeds the LLM only *delta* (change) information. If the Fed Funds rate or broader macro context hasn't changed since yesterday, it is excluded. Short-term memory (daily headlines) decays quickly, while long-term memory (quarterly reports) is compressed.
2. **Asynchronous Reflection:** A background task (e.g., nightly or weekly) analyzes recently closed trades against their original `tradeThesisTag` and `entryMarketRegime`.
3. **Prompt Auto-Pruning (OPRO):** During this reflection, the LLM generates a highly condensed **Reflection Summary** (e.g., *"Lesson: Tech breakouts failing due to choppy VIX"*). Furthermore, it actively rewrites and prunes its own prompt instructions, dropping rules that are no longer relevant to the current market regime to save tokens.
4. **Injection:** Only this concise "Lessons Learned" block and the auto-pruned instructions are injected into the active trading prompt, providing high-signal feedback at a fraction of the token cost.

**Implemented (2026-06-16):**
- **Outcome-aware Thesis Scorecard** — `getThesisScorecard()` (`performance.ts`)
  computes realized win rate / avg return / total P&L per `tradeThesisTag` from
  closed lots (deterministic, zero tokens) and injects it as
  `tradeOutcomesByThesis` into both the Bull prompt (with an instruction to
  favor proven theses and avoid repeat losers) and the post-mortem reflection,
  so the reflection is grounded in what actually made/lost money rather than
  trade descriptions alone.
- **Gated reflection** — `generateReflectionSummary` only regenerates when the
  trade history changed (signature = `#filledTrades:latestFillTime`), instead of
  every run. This saves an LLM call on no-fill runs and keeps the Bull
  system-prompt prefix stable so provider prompt-caching can hit.
- **Bounded LLM requests (2026-06-20)** — Bull, Bear, Red Team, strategy-tuning,
  and post-mortem calls now use shared OpenAI request bounds with deterministic
  temperature and explicit output caps. Their prompts and payloads use
  `broker/paper` and `broker/live` wording so broker-hosted paper fills are
  never confused with real-capital fills.
- **LLM step timeout diagnostics (2026-06-30)** — strategy runs now audit
  `llm_step` start/failure rows and preserve failed Green Team context in the
  final `strategy_run` audit. Raw abort strings are translated into
  provider/model-specific guidance (for example, Green Team `gpt-5.5` high
  reasoning timing out after the shared 60s cap), while Red Team transport
  failures fallback to Bull proposals with an auditable reason. Interactive
  strategy runs keep the 60s cap: `gpt-5.5` with high reasoning is rejected in
  Settings and stale stored configs are clamped to medium effort at request
  build time.
- **Context trimming** — large allowlists (e.g. full S&P 500) are sent as a
  compact note instead of every ticker; `recentOrders` is slimmed to 8 records;
  the Bear/critique agent receives only the candidates under review rather than
  a second full copy of the market scan.
- **Regime-conditioned outcomes** — `getRegimeScorecard()` groups realized
  outcomes by `entryMarketRegime`; `tradeOutcomesByRegime` is fed to the Bull
  (compare today's regime to history), Bear, and reflection.
- **MAE/MFE excursion lessons** — `getExcursionsByThesis()` (replacing the old
  `runPostMortems` stub) aggregates holding-period adverse/favorable excursions
  and capture-of-favorable-move per thesis, computed only in the gated async
  post-mortem so the proposal path stays network-free.
- **Delta-only macro pruning** — `pruneMacro()` sends only changed (plus
  regime-critical) macro fields on repeat runs, listing the rest as unchanged.
- **Risk-control wiring audit + money-path test (2026-07-01, audit work-split F/G):**
  - **Drawdown kill-switch (G5)** — verified `runStrategyOnce` (`src/lib/strategy.ts:~253-262`)
    flips an `active`, autonomous run to `close_only` via `setPolicy`, audits
    `policy_violation_drawdown`, and sends a `kill_switch` notification when the account draws down
    past `riskRules.maxDrawdownPct` / `maxDailyLossNotional` from the persisted equity high-water
    mark (HWM + start-of-day equity live in the settings KV, so they survive a restart). Already
    wired and durable; the missing piece was a *regression test* driving the full
    breach→`close_only` flip through `runStrategyOnce`
    (`test/strategy-moneypath-drawdown-flip.test.ts`). Default-safe: the block is gated on `active`
    and no-ops when no limit is configured; no behavior change.
  - **Correlation cluster gate (G6)** — verified `applyCorrelationClusterGate`
    (`src/lib/strategy.ts:~1087`, invoked at `~509`) runs *before* execution, keyed on
    `policy.maxAvgCorrelation` (default off). An over-correlated *opening* buy/short is dropped with
    an `audit("proposal_skipped_correlation")` row while exits (sell/cover) always pass. Built +
    wired + opt-in; covered by `test/correlation-cluster-gate.test.ts`.
  - **Money-path e2e test (G7)** — `test/strategy-money-path-f-g.test.ts` drives `runStrategyOnce`
    in broker/paper mode (simulated fills via the `TestBrokerGateway` test-infrastructure adapter,
    never a real trade) with a stubbed LLM and asserts the full proposal→evaluate→execute path
    books a paper fill and persists a proposal + `fill_event`.
  - **Live-order pre-flight guard (G7)** — `src/lib/preflight-live-guard.ts` (`assertLivePreflight`)
    is a default-SAFE assertion wired in just before a real (`broker/live`) order is placed
    (`src/lib/strategy.ts`, before `gateway.placeEquityOrder`). `LivePreflightInput.mode` is one of
    `"broker/paper" | "broker/live"`; the guard is a hard no-op whenever `mode !== "broker/live"`
    (i.e. any broker/paper run — there is no separate local Test mode). On the real-capital path
    it throws (blocking the order + auditing `order_blocked_live_preflight`) unless live trading
    is explicitly enabled via the `ALLOW_LIVE_TRADING=true` env flag (or the caller passes
    `allowLive: true`). It never places or enables a trade. Unit-tested in
    `test/preflight-live-guard.test.ts`.
- **Observability prompt-version + decision stamps (2026-07-01, G10):** every traced strategy
  generation (bull `trading.strategy.bull`, bear `trading.strategy.bear`, red-team
  `trading.red-team.debate`) now carries `metadata.promptVersion`, sourced from the single
  `STRATEGY_PROMPT_VERSION` constant (`src/lib/strategy.ts`) so traces are filterable/comparable
  across prompt revisions. The **Bear-veto** count is stamped into the bear generation's output
  (`bearVeto` / `bearVetoCount`), and a **rationale diversity-collapse** emits a stamped
  `recordDecisionObservation("trading.strategy.diversity-collapse")` span
  (`src/lib/observability.ts`). All of it is a hard no-op when Langfuse is unconfigured
  (`langfuseConfigured()` gates it). Covered by `test/redteam-observability-g10.test.ts`.
- Still TODO from this section: OPRO-style prompt self-rewrite (intentionally
  kept advisory-only via Strategy Studio's human-approved tuning, not
  auto-applied).
- **MAE/MFE persistence IS implemented**: `db-fills.ts` exposes
  `persistMaeMfeById` and `persistMaeMfeByKey` which update `fill_events.mae`
  and `fill_events.mfe` columns (added via migration in `db.ts`). The excursion
  computation path in the gated post-mortem writes these via the persistence
  helpers; earlier reflection cycles that recomputed without persisting are
  superseded.

**Implemented (2026-06-16, signals + learning pass — branch `ui-redesign`):**
This pass implemented the tractable subset of Codex's "Stronger Trading Signals
And Learning Loop" research plan, honoring its directive to *finish plumbing
existing fields end-to-end before adding new providers*.
- **Pillar-B/E fields plumbed end-to-end.** `fcfYield`, `debtToEquity`, and
  `epsGrowth` (Pillar B, section 1.B) now feed `valueScore`/`qualityScore`
  (`market.ts`); `insiderSentiment` and `senateTrades` (Pillar E, section 1.E)
  plus the three fundamentals are now emitted per candidate by
  `compactMarketScanForPrompt` and shown in the Market Scan table (FCF% / D/E /
  EPS gr columns). These fields were already fetched through the enrichment
  cascade but dead-ended before reaching scoring/prompt/UI.
- **Fixed thesis playbook** (replaces the free-form `tradeThesisTag`).
  `THESIS_PLAYBOOK` (10 tags) now constrains both the Bull and Bear JSON schemas
  (`enum`), so the thesis x outcome scorecards bucket consistently and can
  accumulate learnable samples. The proactive risk-exit tag is now `"Risk-Exit"`.
- **Bayesian shrinkage on the scorecards** (section 3.E small-sample guardrail).
  `aggregateClosedLots` adds `shrunkWinRate`/`shrunkAvgReturnPct` (neutral
  50%/0% prior, 5-trade pseudo-count); the Bull prompt instructs the agent to
  prefer the shrunk rates when `trades` is small. This is a prerequisite for the
  section 3.E "minimum 20 outcomes" gate to behave sanely on partial samples.
- **Counterfactual candidate log** (raw material for section 3 learning).
  `runStrategyOnce` writes a `candidates_considered` audit event per run: what
  the agent chose (symbol/side/status/thesisTag) vs the top-8 skipped scan
  candidates by score, without fabricating fills for un-traded names.
**Implemented (2026-06-16, web-sources pass — branch `web-sources`, see
`docs/phase-9-web-sources.md`):**
- **EvidenceDigest / SignalSnapshot** (section 1.E "Token Efficiency Mechanism").
  Backend connectors digest congressional disclosures (Senate eFD + Capitol
  Trades) and SEC EDGAR Form 4 insider trades into 1-line `smartMoneyEvidence`
  bulletins fed to the prompt — raw rows stay out. `runStrategyOnce` also writes a
  `signal_snapshot` audit per run (per-symbol factor sub-scores + congress/insider
  net + bulletins + thesis × regime) so outcomes can later be correlated with the
  signals that preceded them.
- **Multi-dimensional learning** (section 3): `getThesisRegimeScorecard()` crosses
  thesis × regime (shrunk like the 1-D cards) and feeds `tradeOutcomesByThesisRegime`
  to the agent. Phase 10 later added sector-on-fills and `getSectorScorecard()`;
  the fully composite thesis × regime × sector × factor view is still a follow-up.
- **20-outcome guardrail** (section 3.E): `MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT = 20`
  now gates the auto-tuner — factor-weight changes are withheld (local-rules path
  emits no weight patch; LLM path is instructed to null all weights) until ≥20 lots
  have closed.
- **New providers**: congressional (Senate eFD / Capitol Trades) and SEC EDGAR
  Form 4 insider are live as backend web-sources (the user's FMP key is
  rate-limited, so those FMP senate/insider paths returned nothing).
- Later Phase 10 work added SEC 8-K bulletins, FINRA short-volume, market breadth,
  technical signals, Fama-French factors, Cboe SKEW/VVIX, CFTC COT, and sector
  learning. Still deferred: House congressional coverage when a stable free feed is
  available, weight shifts wired into *sizing* (currently advisory via Strategy
  Studio), richer per-filing document digests, and factor-bucket learning.

### E. Human-Approved Weight Shifting
The ultimate expression of the learning loop is adjusting the Initial Factor Weighting Matrix and Sector Allocations.

- The system generates advisory suggestions that analyze outcome performance across factor scores, `tradeThesisTag`, market regime, and industry sectors.
- **Dynamic Factor Weight Shifting:** If the Post-Mortem reveals that trades heavily weighted by "Fundamentals" are losing money in a speculative market, but "Technicals" are winning, the system will suggest a policy patch: *"Decrease Fundamental Weight by 5%, Increase Technical Weight by 5%."*
- **Dynamic Sector Allocation Shifting:** The system continuously evaluates portfolio performance by industry sector. It will suggest *mild to moderate* target allocation shifts over time (e.g., reducing Technology exposure from 30% to 20% if the sector begins underperforming). It is explicitly designed to avoid extreme concentration (e.g., it will never suddenly recommend shifting the portfolio to 99% in one stock or sector).
- **Guardrails:** 
  - Minimum 20 outcomes before suggesting factor shifts.
  - Maximum 5-point weight delta per factor suggestion.
  - Maximum 10-point weight delta per sector shift suggestion.
  - Strict sector concentration caps (e.g., no single sector can exceed 40% of the portfolio).
  - Human approval via the Dashboard is the DEFAULT.

#### E.1 Opt-in autonomous factor-weight apply (Workstream B, 2026-07-01 — DEFAULT OFF)
A default-off `policy.tuning.autoApplyWeights` flag lets a cadence-gated caller apply the auto-tuner's
factor-weight suggestions WITHOUT human approval — but ONLY under strictly stronger gates than the manual
suggestion path:
- **Cadence:** hosted in `scheduler.ts` after a successful `runStrategyOnce`, under the single-leader gate,
  on its own slow clock (`AUTO_TUNE_MIN_INTERVAL_HOURS`, default 24h) — NOT the event-driven trigger path.
- **Write scope:** ONLY `proposedPatch.scoringWeights` are applied. The tuning patch's `policy` sub-patch
  (risk caps, `strategyAuthority`, `riskRules`, `sectorCaps`) and free-text `prompt` are NEVER auto-applied,
  so an autonomous run can't loosen a risk control or flip authority to `decide`.
- **Statistical gate:** a stricter-than-manual OOS re-validation on the exact vector to be persisted —
  requires a minimum IC-delta margin over baseline, positive absolute candidate IC, an ICIR floor, and a
  minimum test-date count; a null OOS run (<4 distinct snapshot dates) is a HARD no-apply.
- **Clamp:** each factor delta is re-clamped to ±`MAX_WEIGHT_STEP` (5 points) AFTER normalization.
- **Persistence + revert:** applied via `setPolicy` (syncs account_strategy_state + the active-profile
  mirror); an `auto_weight_apply` audit row stores the prior vector so `revertAutonomousWeightTuning`
  restores it. Off by default → the human-approval path above is unchanged.

#### E.2 Congress-signal go/no-go gating (Workstream B — DEFAULT OFF)
A default-off `policy.tuning.congressGoNoGoGating` flag gates the congressional scan contribution on a cached
statistical verdict (`congress-score-eval` → three-way PASS / FAIL_SIGNIFICANCE / INSUFFICIENT). Only a
data-backed significance failure down-weights the term to zero; a data-poor account resolves to INSUFFICIENT
and stays neutral (never a permanent kill-switch). Verdict cached out of the scan hot path, surfaced on the
dashboard, refreshed via `POST /api/admin/congress-score-eval`.

#### E.3 Confidence calibration → sizing (Workstream B — DEFAULT OFF)
A default-off `policy.tuning.calibrationSizing` flag remaps a BUY proposal's `confidenceScore` DOWN toward its
realized (Bayesian-shrunk, isotonic-across-bands, per-band-sample-gated) win rate before it becomes the
conviction sizing multiplier — de-risking persistent over-confidence. Reduce-only; shorts fall back to raw;
composes as a reduction feeding the existing conviction cap.

#### E.4 Execution cost on protective exits (Workstream B — correctness fix, ON)
The paper/test execution-cost model now also debits EXIT fills booked by `synthetic-stops.ts` and
`order-replacement.ts` (previously they inserted raw-price exits with no cost), so the learning loop's
realized edge is net-of-cost on both legs — not just entries.

#### E.5 Unified learning-mutation ledger + admin revert (follow-on P0-4 — ledger ALWAYS-ON, revert admin-only)
Every autonomous learning mutation now lands in ONE canonical append-only ledger (`learning_mutations`
table; CRUD in `src/lib/db-learning-ledger.ts`; orchestration in `src/lib/learning-ledger.ts`). Each row
carries the subsystem (`scoring_weights` today), the before/after full weight vectors, the trigger/run id,
the OOS/statistical evidence, the authorizing flag, and a timestamp. `applyAutonomousWeightTuning` records
here (capturing `before` ATOMICALLY, immediately before the `setPolicy` write) and still writes the legacy
`auto_weight_apply` audit row for dashboard back-compat. `revertLearningMutation` restores the prior vector
via `setPolicy` ONLY (keeping `account_strategy_state` + the active-profile mirror in sync), scoped by
`(user, account, subsystem)`, and marks the row reverted (idempotent). This GENERALIZES the #296
tuning-specific revert — it does not duplicate it. Recording is passive/always-on (audit trail only — it
changes no trading behavior). The one-click revert route `POST /api/admin/learning-ledger` is `requireAdmin`
(this repo has prior IDOR history); `GET` lists entries for the caller's active account.

#### E.6 Paired-t significance on the autonomous OOS gate (follow-on P0-2 — DEFAULT no-op)
The autonomous OOS gate (E.1) is extended with a proper effect-size + PAIRED-t significance test on the
per-fold IC deltas. Because the candidate and baseline composite ICs are measured on the SAME test fold and
are highly correlated, the difference's standard error comes from the PAIRED per-date IC-difference series
(`pairedICDiffStats` in `backtest.ts`, surfaced on `OOSResult.pairedICDiff`), NOT from differencing two
independent ICIRs. Two default-preserving knobs: `policy.tuning.minOosICImprovement` (default 0 → today's
env `AUTO_TUNE_MIN_IC_DELTA` margin) raises the IC-delta MARGIN; `policy.tuning.minOosPairedTStat` (default 0
= paired-t OFF) requires `pairedN ≥ 2 && pairedT ≥ threshold`. Multiplicity control across repeated
auto-applies (Šidák/Bonferroni, expansion-doc D-1) is explicitly deferred — it earns teeth only once a
per-account trial counter exists, and with the paired-t defaulting off there is nothing to correct today.

#### E.7 Fail-closed tuning-config invariant guard (follow-on P0-3 — validator ALWAYS-ON, gating autonomous-only)
A pure always-on validator (`validateTuningInvariants` in `src/lib/tuning-invariants.ts`) checks a small set
of HARD safety couplings in `policy.tuning`: sample gates > 0; `sizingFloorPct ≤ sizingCeilingPct`;
`autoApplyWeights ⇒ oosWithholdUnvalidated` (unless the explicit `autoApplyOverrideUnvalidated` escape
hatch); `calibrationSizing ⇒ a positive per-band sample gate`. The AUTONOMOUS apply path calls it at the TOP
and fails CLOSED — on any violation it SKIPS the apply, writes an `auto_weight_apply_skipped` audit row, and
returns without throwing (a throw would wedge the scheduler tick). The MANUAL tune route surfaces the same
violations as non-blocking `tuningConfigWarnings` for human review.

#### E.8 Deterministic dry-run / replay harness (broader-backlog P1-1 — read-only, admin-only)
The autonomous gate logic is factored into a shared, SIDE-EFFECT-FREE evaluator (`evaluateAutonomousWeight-
Tuning` in `src/lib/strategy-tuning.ts`) consumed by both the real apply and a new read-only replay
`dryRunAutonomousWeightTuning`. The dry-run runs the FULL gate (propose → write-scope-strip → clamp → stricter
OOS + paired-t + P2-5/P2-6 guards) and returns exactly what an apply WOULD do — `{ wouldApply, before, after,
clampedDeltas, oosICCandidate/Baseline, oosReadout, invariantViolations }` — with ZERO writes (no `setPolicy`,
ledger, audit, or cadence advance; asserted by spies). Exposed at `GET /api/admin/tuning-dry-run`
(`requireAdmin`, mirrors the backtest-ic "suggestion only" pattern). The operator on-ramp: inspect the decision
before enabling `autoApplyWeights`.

#### E.9 Purged & embargoed walk-forward split (broader-backlog P1-2 — DEFAULT off, byte-identical)
`splitWalkForward` gained an opt-in `{ purge }` control and `runWalkForwardOOS` an `purgeEmbargo` option
(`policy.tuning.oosPurgeEmbargo`). The `horizonDays` EMBARGO (drop the first `horizonDays` test-date buckets)
already existed; the PURGE additionally drops the LAST `horizonDays` TRAIN-date buckets whose forward window
straddles the boundary (train↔test bar-overlap leakage — the exact metric the autonomous gate actuates). Off by
default → the split is byte-identical (embargo-only). Fails safe: purging shrinks the train sample, which can
only strip weights.

#### E.10 Auto-tuning shadow / forward-A-B ledger (broader-backlog P1-3 — DEFAULT off)
`policy.tuning.shadowWeightLedger` (default off): each autonomous-tuning EVALUATION records a passive SHADOW row
in the #300 `learning_mutations` ledger (trigger `auto_weight_shadow`, distinct from the real-apply trigger so
no revert path restores it) capturing what the tuner WOULD have applied + the OOS readout — WITHOUT touching
policy. Independent of `autoApplyWeights` (records the would-be decision even when real auto-apply is off), so an
operator can forward-validate the tuner's decisions before trusting autonomy. Overlap-aware SE for a hard
"shadow underperforms" gate is future work.

#### E.11 Survivorship & look-ahead certification (broader-backlog P1-4 — diagnostic/test-only, gates nothing)
Two deliverables. HARD: `isPointInTimeForwardExit()` (pure) + a CI-failing unit test asserting a forward return
uses a bar strictly AFTER the snapshot date at/after `horizonDays` (a same-day or pre-horizon exit is rejected).
SOFT: `certifyForwardResolution()` (IO) reports the fraction of snapshotted candidates with a resolvable forward
price and a point-in-time-clean flag — explicitly labeled a SURVIVORSHIP PROXY that does NOT certify absence of
survivorship bias and gates nothing.

#### E.12 Missed-opportunity hit-rate + benchmark parity (broader-backlog P2-1/P2-2 — DEFAULT off)
`summarizeMissedOpportunities` gained `requireHitRate` (`policy.tuning.missedOpportunityRequireHitRate`, default
off): instead of a winners-only count it tallies per-factor total (winners AND losers) over ALL matured skipped
rows and flags a recurring factor only when its benchmark-beating hit rate, SHRUNK toward the overall skipped
base rate, clears that base rate with a minimum denominator. P2-2: the SAME benchmark-relative test classifies
both winners and losers, so the per-factor signal is net-of-benchmark on both sides. `proposeStrategyTuning`
widens the skipped fetch to 100 rows when on so the base rate isn't biased toward the top-12 winners.

#### E.13 Signed/directional top-bucket congress gate (broader-backlog P2-3 — DEFAULT off)
`evaluateCongressScore` gained `requireTopBucketPositive` (`policy.tuning.congressRequireTopBucketPositive`): the
go/no-go additionally requires the TOP score bucket's OWN excess return to be positive with a min-n floor, so a
symmetric top-minus-bottom spread whose edge lives entirely in the (unused, long-biased app) short bottom leg no
longer passes. Wired through both the admin eval route and the P2-8 refresher; off by default → verdicts
unchanged.

#### E.14 IC-weight shrinkage, drawdown guard, starvation guard, provenance (broader-backlog P2-4/5/6/7)
- **P2-4** `deriveWeightsFromICs(ics, fallback, λ)` blends the data-derived vector toward `DEFAULT_SCORING_WEIGHTS`
  (`w=λ·w_IC+(1−λ)·w_default`, renormalized), read from `policy.tuning.icWeightShrinkage` (default 0 = pure IC).
- **P2-5** `runWalkForwardOOS` now also returns `candidate/baselineMaxDrawdownPct` (two extra top-K equity curves
  via the pure `maxDrawdownOfCurve`); the autonomous gate blocks an apply whose candidate DD exceeds baseline by
  >2 points, but only when `testDates ≥ 8` (below the floor the IC/paired-t gate governs).
  `policy.tuning.autoApplyDrawdownGuard`, default off.
- **P2-6** `policy.tuning.minOosTestDates` raises the distinct-test-date floor above the `AUTO_TUNE_MIN_TEST_DATES`
  env default (default 0 = env floor governs) — a starvation guard so a thin fixed 500-row window can't pass.
- **P2-7** each real apply writes `audit('tuning_apply_provenance', …)` with the fold shape (train/test dates +
  observation counts), ICs/ICIR/paired-t, drawdowns, thresholds, and the flags in effect, so an IO+time-dependent
  apply is reproducible/auditable.

#### E.15 Congress go/no-go scheduled + cached + fixtured (broader-backlog P2-8 — DEFAULT off gate)
`refreshCongressScoreVerdict()` (in `congress-score-gate.ts`) is a cadence-callable refresher that computes
`evaluateCongressScore` from `buildCongressScoreObservations` and persists the verdict, moving the expensive
OHLC-backed eval OFF the scan hot path (the cheap read-time cache + fail-open staleness already existed). Honors
P2-3. Covered by a fixtured vitest (recorded `signal_snapshot` rows + an injected OHLC fetcher + a fixed
`placeboSeed`) asserting the three-way verdict + the P2-3 reason. **D-1** (multiplicity-aware significance) is
DEFERRED — it needs a per-account trial counter and has no teeth until the paired-t is on. **P1-5** (calibration
remap monotone+shrunk) was verified ALREADY shipped in #296 (`calibratedConviction`) and skipped.

## 4. Test Plan
- **Context/Outcome Fixture:** Seed buy/sell fills and assert that `entryMarketRegime`, `mae`, and `mfe` are accurately captured and calculated.
- **Post-Mortem Generation:** Test the async reflection LLM prompt to ensure it synthesizes raw outcomes into a concise paragraph.
- **Weight Shifting Logic:** Create a mock history of failing "Value" trades and assert that the system successfully suggests a negative delta to the Fundamentals weight.

## 5. Sequencing
1. Implement the expanded `StrategyOutcome` schema and the 4-Pillar data fetching (Macro, Fundamentals, Technicals, News).
2. Implement the Asynchronous Post-Mortem task to generate the `reflection_summary`.
3. Feed the reflection summary into the main `runStrategyOnce` prompt.
4. Implement the human-approved Weight Shifting suggestions in the Dashboard.
