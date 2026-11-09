# The Socratic Trade Trading Framework

_Net-new document, 2026-07-11. This is the framework-level description of the
entire trading pipeline — how market data becomes an accountable trading
decision and how outcomes feed back into the system. It is deliberately not
user- or account-specific: no owner settings, balances, or credentials appear
here, only the machinery and its rules._

_Relation to existing docs (supersession paper trail): this doc does NOT replace
[`docs/strategic-framework.md`](strategic-framework.md) (the plain-English
investment-philosophy narrative), [`docs/phase-7-strategy.md`](phase-7-strategy.md)
(the learning-loop design spec), or
[`docs/single-adversary-consolidation.md`](single-adversary-consolidation.md)
(the Red Team design). It sits above them: an end-to-end architectural map of
the trading machinery with pointers into code. The public page at
`/framework` (`app/framework/`) is derived from this document._

---

## Summary

Socratic Trade is a real trading application organized as a **dialectic**: one
LLM argues for a trade, a second LLM argues against it, and deterministic code
— never a model — controls sizing, risk gates, and order placement. The name
is the method: every position must survive questioning before it exists, and
every outcome is examined afterward so the framework itself improves.

A single **strategy run** — triggered on a per-account cadence by the
scheduler, or manually — flows through eight stages:

1. **Observe.** Scan a configured symbol universe (~8,000-row delayed screener
   base plus dynamic index universes), rank every name on eight factors
   (liquidity, momentum, value, quality, volatility, sentiment, positioning,
   diversification), and enrich the top candidates through a cascading
   multi-provider data layer with per-field source attribution. Real data or
   an honest blank — the framework never fabricates a number.
2. **Assemble evidence.** Build a structured evidence bundle: macro data and a
   deterministic market-regime label, market internals, technicals, SEC-filing
   retrieval (RAG), congressional-trading and insider signals, episodic memory
   of similar past decisions (counterexamples included, not curated out), the
   account's own realized scorecards, and tax context. All untrusted text is
   fenced as *data, never commands*.
3. **Propose (Green Team).** A user-chosen proposer LLM returns
   schema-constrained trade proposals: symbol, side, thesis tag from a fixed
   10-tag playbook, confidence score, rationale, invalidation levels.
   Proposing **nothing** is an explicitly legitimate outcome.
4. **Size (deterministic).** Code, not the model, sizes every opening from
   realized per-thesis statistics: Bayesian-shrunk win rates, capped and
   calibrated conviction, optional reduce-only fractional Kelly, volatility
   and portfolio-heat tapers. Thin evidence pins size to an exploratory floor;
   proven losers get zero.
5. **Challenge (Red Team).** A second, separately chosen LLM adversarially
   reviews **every** risk-adding opening at its final size, fact-checking the
   rationale against the same evidence the proposer saw. Its verdict is
   down-only — approve, approve at half size, or reject — and if the reviewer
   cannot run for any reason, the trade fails **closed** to human approval.
   Exits are structurally exempt: dissent can never block de-risking.
6. **Gate (policy).** A deterministic policy engine evaluates the sized,
   reviewed proposal against the account's configured rules: exposure,
   notional, and concentration caps; order-type, drift, and staleness checks;
   wash-sale handling; short-sale requirements. Only physical, broker,
   regulatory, and accounting impossibilities are hard blocks — everything
   else is an owner preference the agent may argue past with a logged,
   structured override thesis.
7. **Execute (broker).** Approved orders route through one guarded choke point
   into a broker-agnostic gateway (Alpaca, Tradier, and Robinhood adapters).
   Placement is crash-safe and idempotent: the intent is persisted before the
   broker call, uncertain outcomes are reconciled against broker truth by
   client-order-id, and protective stops rest at the broker so they survive
   app downtime. Paper vs. live is purely a property of the connected account
   — there is no simulation mode, and with no account the app cannot trade.
8. **Account and learn.** Fills are event-sourced and replayed FIFO into P&L,
   scorecards, and confidence calibration. Skipped and vetoed candidates are
   tracked as counterfactuals (what would that have done?), closed trades are
   embedded into episodic memory, a post-mortem reflection feeds the next
   run's prompt, and a statistically gated auto-tuner may adjust factor
   weights — every learning mutation ledgered and revertible, and audited
   daily by an LLM review board that hunts lessons corrupted by the system's
   own execution defects.

The loop then repeats. Throughout, three asymmetries define the engineering
posture: **fail-open for data, fail-closed for money** (a missing quote
degrades to a dash; a missing reviewer halts auto-execution), **advisory
guardrails, hard account boundaries** (rules advise and log; only account
isolation and impossibilities are cages), and **the LLM proposes, code
disposes** (models generate ideas and critiques; deterministic code owns
sizing, gating, placement, and accounting).

---

## Design philosophy

These principles are enforced in code, not just documented:

- **Real trading, deliberately.** Execution mode derives purely from the
  connected broker account's `environment` (`broker/paper` or `broker/live`).
  The local simulator, fake fills, and "test mode" were removed
  (`src/lib/execution-mode.ts`); with no connected account, `deriveExecutionState`
  returns no mode and every execution path refuses.
- **The LLM proposes, code disposes.** Models produce proposals and critiques.
  Deterministic code performs sizing (`applyDeterministicSizing`), policy
  evaluation (`evaluateTradeProposal`), placement, and accounting. A
  regression test proves learned/advisory context can never reach the sizing
  math.
- **Fail-open for data, fail-closed for money.** Market-data failures degrade
  tier-by-tier and render `-`; the LLM money path hard-errors on a missing
  credential or unchosen model (`src/lib/llm-required.ts`), and an
  unavailable Red Team routes openings to human approval.
- **Never fabricate.** No synthetic tier exists in the enrichment cascade;
  benchmarks return null on insufficient data; Kelly math returns undefined
  outside its domain; unresolvable counterfactuals stay in denominators with a
  survivorship disclosure instead of vanishing.
- **Advisory guardrails; the account boundary is the only hard rule.** The
  hard-vs-preference split is one pattern list in `src/lib/policy.ts`
  (`HARD_GATE_REASON_PATTERNS`): account boundary, accounting truths, broker
  and regulatory impossibilities. Everything else — every cap, universe rule,
  staleness gate — is an owner-adjustable preference, overridable by the
  agent only through a structured, logged `autonomyOverride` thesis.
- **No model defaults, ever.** Both the proposer ("Green Team") and reviewer
  ("Red Team") models are mandatory explicit picks. A blank model fails
  closed with an actionable error — never a silent fallback, and never the
  proposer's model quietly grading its own homework.
- **Everything leaves a receipt.** Every proposal decision persists a Socratic
  decision case (evidence, verdicts, overrides, safety receipts); every LLM
  call writes a usage-ledger row; every learning mutation lands in an
  append-only ledger with a single revert path.

---

## Layer 1 — Market observation

**Code:** `src/lib/market.ts`, `src/lib/data-providers.ts`,
`src/lib/index-universes.ts`, `src/lib/indicators.ts`, `src/lib/macro.ts`,
`src/lib/market-internals.ts`, `src/lib/market-hours.ts`,
`src/lib/market-calendar.ts`

- **Universe assembly.** The configured universe (index memberships, explicit
  symbols, minus a blocklist) resolves from static index snapshots plus
  dynamic sources (ETF holdings, per-exchange screener pulls). A
  penny/illiquidity floor drops names below configured price / market-cap /
  dollar-volume minimums — but explicitly listed symbols and **held positions
  are exempt**, so an exit can never be trapped by a screening rule.
- **Base scan and factor ranking.** A keyless delayed screener (~8,000 rows,
  cached ~5 min) provides the tape. Every quote is scored on eight factors —
  liquidity, momentum, value, quality, volatility, sentiment, positioning,
  diversification — under user-configurable normalized weights.
- **Candidate selection.** Candidates = top-N ranked names **plus** reserved
  "event outliers" (below-cutoff names with notable congressional/insider/
  short-pressure/technical signals or statistically extreme moves) **plus**
  every held position. Additive, never substitutive.
- **Cascading enrichment with provenance.** An ordered provider cascade fills
  ~32 scalar fields per candidate first-wins by tier: real-time snapshot
  sources first, delayed keyed providers next, keyless Yahoo Finance always
  last as the floor. Every field records which provider supplied it;
  `MarketScan.source` lists only providers that actually contributed this
  run. Analyst ratings are blended (votes), not first-wins; disagreements
  between short-interest sources beyond a threshold emit an evidence bulletin
  instead of silent trust. Held positions enrich first so quota shortfalls
  starve the tail, never owned names.
- **Macro, regime, and the volatility brake.** A ~19-series macro suite
  (rates, curve, inflation, labor, credit spreads, VIX term structure) feeds a
  **deterministic** market-regime classifier; failed series render blank and
  are pruned from prompts (the classifier reads "Unknown" rather than
  fiction). A short-TTL live VIX overlay keeps crash days visible despite the
  daily macro cache; a volatility panic brake can flip the account to
  close-only when configured gauges (VIX/VVIX/SKEW) cross thresholds.
- **Technicals and internals.** Pure-function indicators (RSI, SMA/EMA, MACD,
  ATR-derived stop distances) over daily bars produce a 0–100 technical score
  with named events (golden cross, RSI reclaim, …) — minimum-sample-gated,
  omitted rather than guessed. Cross-sectional internals (breadth, sector
  rotation, median earnings yield) are computed in-house from already-fetched
  data.
- **Market hours as a first-class gate.** A computed US holiday/early-close
  calendar (not hardcoded year lists) gates when scans and runs execute, and
  all learning horizons count **trading days**, not calendar days.

**Resilience:** every provider call funnels through one retry/health
chokepoint with per-credential-lane circuit breakers — a dead key lane trips
alone; a scan is never aborted by a provider failure (`src/lib/api-circuit-breaker.ts`).

---

## Layer 2 — Evidence assembly

**Code:** `src/lib/strategy.ts`, `src/lib/evidence.ts`, RAG modules,
`src/lib/experience-memory.ts`, `src/lib/learned-context/`

Each run assembles a structured evidence bundle for the decision core:

- Scan candidates with factor breakdowns, headlines, and smart-money bulletins
- Macro + regime + internals, delta-pruned for token efficiency
- **Filings RAG**: retrieval over 10-K/10-Q/8-K/transcript chunks, widened to
  held positions
- **Alternative data**: congressional-trading composite scores (versioned,
  with provenance and a statistical go/no-go gate that can zero their
  influence entirely), SEC Form 4 insider sentiment, FINRA short pressure
- **Episodic memory**: nearest historical decision analogs retrieved by
  situation similarity — as-of stamped (no lookahead), with opposite-outcome
  analogs surfaced as labeled **counterexamples** rather than filtered out
- **The account's own record**: realized thesis/regime/sector/factor
  scorecards, confidence calibration, skipped-candidate counterfactuals, tax
  context with priced wash-sale rebuy costs
- The owner's strategy prompt and the previous run's post-mortem reflection

**Prompt-safety posture:** every untrusted block (news, filings, learned
facts, analogs) is fenced and enumerated under an explicit
*data-not-command* boundary; a deterministic injection scan emits audit
receipts without altering text — detection is the control.

---

## Layer 3 — The Socratic decision core

**Code:** `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`,
`src/lib/strategy-risk.ts`, `src/lib/red-team.ts`, `src/lib/kelly.ts`,
`src/lib/socratic-runtime.ts`

### Green Team proposes

A user-chosen proposer LLM (provider inferred from the model name; three wire
transports; strict structured output per provider dialect) returns
`TradeProposal` objects: symbol, side (`buy | sell | short | cover`,
capability-gated), order type, size intent, rationale, a thesis tag from the
fixed 10-tag **thesis playbook** (so thesis×outcome learning accumulates
consistent samples), a 1–100 confidence score, bracket/stop plans, and an
optional `autonomyOverride` thesis. The proposer runs at temperature 0 with an
owner-configured cross-provider failover chain for transient failures. A
truncated or malformed reply degrades to zero proposals with a distinct audit
— and zero proposals is prompted as a *correct* outcome, not a failure.

A **rotation sentinel** (`__rotate__`, `src/lib/model-rotation.ts`) can serve a
different curated model each run — sampled representation-weighted, so models
underrepresented in the account's recent rotation history are twice as likely
to be picked as overrepresented ones (which can still be picked), and a run
never serves the same model to both seats — accruing live comparative model
history evenly, since every proposal is stamped with the model that actually
served it.

### Deterministic sizing

Code sizes every opening from realized statistics — the LLM's size is advice,
never authority:

- Core multiplier = shrunk realized win rate × capped conviction × realized-
  edge factor, bounded by configured floor/ceiling
- The LLM's confidence can shrink size freely but can only *raise* it past a
  cap (default 0.6) when the thesis's own realized record corroborates it;
  calibration remaps persistent overconfidence **downward only**
- Unproven theses (< 20 closed lots) pin to an exploratory floor; proven
  negative-edge theses get zero
- Optional fractional-Kelly (half-Kelly default) is **reduce-only**, with
  volatility-targeting, portfolio-heat, and market-impact tapers composing on
  top; every adjustment appends a `[Sizing]` receipt to the rationale

### Red Team challenges

Every risk-adding opening — universally, no conviction threshold — is
reviewed at its **final size** by the separately chosen reviewer LLM
(temperature 0.7, so repeated reviews don't produce identical objections).
Job 1: fact-check the rationale against the same candidate evidence the
proposer saw (evidence parity; a contradiction mandates rejection). Job 2:
critique the exact sized order in the current regime. The verdict vocabulary
is closed and **down-only**: `approve`, `approve-at-half` (a single discrete
haircut; if half is unplaceable the trade holds for a human at full size —
never silently traded larger than approved), or `reject` (persisted, audited,
and fed to the counterfactual pipeline so the veto's quality is itself
measured). Any failure — unconfigured model, timeout, provider error,
malformed verdict — classifies as unavailable and the opening **fails closed
to human approval** with a loud "RED TEAM FAILED" annotation. Exits and
risk-reducing trades never enter review at all.

### The Socratic override

The dialectic runs in both directions: the agent may attach a structured
`autonomyOverride` thesis to argue past *preference* gates (including a Red
Team veto) — requested flag, thesis, acknowledged conflicts, invalidation
condition. It resolves exactly once, under the owner's configured override
mode, can never bypass hard gates, and every use is tagged and audited rather
than erased.

---

## Layer 4 — The policy gate

**Code:** `src/lib/policy.ts`, `src/lib/types.ts` (`TradingPolicy`)

`evaluateTradeProposal` is the single deterministic pre-trade gate (re-run
again at approval time for escalated cards). It checks, in order: system
state, universe membership, order-type/hours permissions, entry drift against
the persisted reference price, data staleness, short-sale requirements (a
short must carry a real stop), position accounting (never sell/cover more
than held), the regulatory margin minimum, per-order caps with execution
headroom, daily/hourly notional and order-count budgets, buying power,
crisis-regime exposure caps, the wash-sale gate, and
symbol/sector/gross/net/beta/correlation exposure caps.

Framework rules that shape it:

- **Exits are never blocked** by universe, caps, staleness, budgets, or
  crisis rules — only by accounting impossibility. Blocking an exit would
  trap the very risk the rules exist to shed.
- **Hard vs. preference is a closed pattern list.** New gates are overridable
  by default; hard status is reserved for account boundary, accounting truth,
  broker/regulatory impossibility.
- **Self-healing blocks escalate instead of dying.** Time-context failures
  (daily/hourly budgets, wash-sale ask, staleness) become approval cards with
  server-minted override tokens; approval re-runs the full gate against fresh
  data, and a wash-sale token is honored only while the recomputed cost stays
  near what the user actually saw. Per-order caps never escalate — time does
  not fix an oversized order.
- **Tax-aware, not tax-paternalistic.** The wash-sale gate prices the
  forfeited deduction and, by default, records it as telemetry and prompt
  context rather than vetoing (the deterministic edge-vs-cost veto was
  removed as pseudo-math). IRA Ignore (default) does not steer Green or
  veto; Auto weighs the priced cost then proceeds; Block refuses.
  Minimum loss is optional (blank = every loss). No wash-sale outcome is
  ever silent.
- Missing data skips a check rather than guessing (staleness is the one
  deliberate, opt-in fail-safe exception).

---

## Layer 5 — Execution

**Code:** `src/lib/broker.ts`, `src/lib/alpaca.ts`, `src/lib/tradier.ts`,
`src/lib/robinhood.ts`, `src/lib/strategy-execution.ts`, `src/lib/fills.ts`,
`src/lib/broker-protective-stops.ts`, `src/lib/broker-side.ts`

- **One interface, one choke point.** Every adapter implements the same
  `BrokerGateway` interface, and every placement call — strategy loop, manual
  approval, protective stops, order replacement — passes through a single
  guarded proxy (`withLivePreflight`). Cancels are deliberately unguarded:
  cancelling is risk-reducing and must work even in an emergency.
- **Crash-safe idempotent placement.** Before any broker call, the proposal is
  atomically claimed (`proposed → placing`, compare-and-swap, so two racing
  approvals can't both place) and a client-order-id (`refId`) is persisted.
  If the call fails or the process crashes, reconciliation matches broker
  truth by that id: `placed`, `declined`, `not_placed` (retry-safe only when
  the broker's order list provably includes terminal orders), or `uncertain`
  (kept alive for the retry sweep — a possibly-real order is never dropped).
- **Fills reconcile against broker truth.** Fill events book idempotently
  (unique on proposal + broker order), partial and cancel-after-partial
  executions update the same record, and a realtime broker stream triggers
  the same deterministic reconcile — a fill never triggers an LLM run.
- **Protective stops survive downtime.** Stops rest **at the broker** (native
  trailing where supported, ratcheted cancel-replace emulation elsewhere) on
  top of an always-on in-app synthetic monitor. Reconciliation is
  coverage-aware — it will never stack a duplicate sell on shares already
  committed to a live exit order — and always tears down stops for closed
  positions, even when the feature is off.
- **Four sides, translated per broker.** Internal order sides are
  `buy/sell/short/cover`; adapters translate to each broker's vocabulary, and
  a broker without shorting capability rejects short intents outright.
- **Caps count openings only.** Daily/hourly notional budgets count risk-
  adding orders; exits are exempt, and an unpriceable exit is never blocked
  (while an unpriceable opening is).

---

## Layer 6 — Accounting

**Code:** `src/lib/performance.ts`, `src/lib/db-fills.ts`,
`src/lib/benchmark.ts`, `src/lib/derived-metrics.ts`

Accounting is **event-sourced**: fills are the ledger, and every metric is
recomputed by deterministic FIFO replay — never read from a stored aggregate
that could drift.

- **Same-side lot matching.** Sells close only long lots; covers close only
  short lots. A closing fill can never consume an opposite-side lot at $0 and
  silently erase a real position.
- **Entry context stamped at write time.** Sector, dominant factor, factor
  breakdown, and regime are persisted on the opening fill itself so
  attribution survives audit-window aging.
- **Paper fills are cost-adjusted; live fills never are.** A deterministic
  slippage model (spread + square-root market impact) haircuts simulated
  fills so the learning loop can't certify a frictionless edge that would die
  in live execution.
- **Shrunk, gated statistics.** All scorecards (thesis, regime, sector,
  factor, thesis×regime, signal efficacy, confidence calibration) are
  Bayesian-shrunk toward neutral priors and sample-gated — realized data can
  reduce risk-taking on thin evidence but never inflate it.
- **Honest benchmarking.** Account equity vs. SPY, with external
  deposits/withdrawals inferred (materiality-floored) and neutralized via
  chained time-weighted return — flagged when adjusted, null when the data
  is insufficient.

---

## Layer 7 — Learning

**Code:** `src/lib/learning-loop.ts`, `src/lib/counterfactual-learning.ts`,
`src/lib/experience-memory.ts`, `src/lib/learned-context/`,
`src/lib/backtest.ts`, `src/lib/strategy-tuning.ts`,
`src/lib/learning-ledger.ts`, `src/lib/learning-review.ts`

Five lanes, all advisory by default, with exactly two tightly gated mutation
surfaces:

1. **Post-mortems.** Closed trades are reviewed with MAE/MFE excursion timing
   (did we exit winners early? hold losers through drawdowns?); a bounded
   reflection paragraph feeds the next run's prompt.
2. **Counterfactuals.** Every scored-but-skipped candidate and every vetoed or
   rejected proposal is tracked: what did it actually do afterward, over
   trading-day horizons, against real bars only? Unresolvable rows (delisted,
   renamed) stay in denominators with a survivorship disclosure. This also
   scores the Red Team itself — a negative post-veto return means the veto
   avoided a loser.
3. **Episodic memory.** Closed lots are embedded (entry situation + realized
   outcome) and recalled at decision time as advisory analogs, with
   counterexamples labeled, no lookahead, and failure degrading to "no
   analogs."
4. **Crossover safety.** Learned "lessons" pass a fail-closed risk classifier
   plus an additive LLM semantic gate: facts flow as advisory context;
   anything touching risk or strategy needs human confirmation; chat can
   never even queue a risk-tier item; approval appends attributed prompt text
   — it can never touch numeric policy. Deterministic sizing provably never
   reads learned context.
5. **Statistically gated auto-tuning.** An IC backtest (per-date Spearman rank
   information coefficients) with **walk-forward out-of-sample validation**
   (chronological split, embargo, optional purge, paired per-date t-stats)
   gates factor-weight changes. Autonomous apply is default-off, scoped to
   scoring weights only, clamped per step, and stricter-gated than manual
   application. Every mutation lands in an append-only **learning ledger**
   with before/after snapshots and one revert path.

A once-daily **Learning Review Board** (LLM) audits recent lessons against the
system's own operational history — sample sufficiency, attribution (was an
execution defect active when this "lesson" was learned?), and still-true
tests — because the motivating failure mode is real: a lesson blaming a trade
thesis for losses actually caused by a bug.

---

## The autonomy layer

**Code:** `src/lib/scheduler.ts`, `src/lib/scheduler-lease.ts`,
`src/lib/db-execution.ts`, `src/lib/strategy-lock-guard.ts`,
`src/lib/auto-tune-scheduler.ts`, `src/lib/db-jobs.ts`

- **Four entry points, one pipeline.** Cadence runs (per-account clock,
  default 60 min), **event triggers** (`src/lib/triggers.ts`, default-off:
  8-K filings, deterministic regime flips, technical alerts, congressional
  trades — deduplicated, debounce-coalesced so an event storm produces one
  run, and gated on market hours, cooldowns, caps, and LLM budget; fed by
  persistent news/price/congress stream workers), manual **Run once**, and
  **chat** (`src/lib/chat/` — a tool-loop assistant whose tools are strictly
  read-only or draft-producing; a drafted order can only be *promoted* into
  the same `proposed → approve → execute` rail, never placed directly). All
  four converge on the same `runStrategyOnce` pipeline and proposal rail.
- **One leader, one run per account.** A 60-second tick elects a single
  leader process via a TTL'd compare-and-swap lease; each strategy run takes
  a per-account single-flight lock, heartbeat-renewed, with
  `assertOwned()` fencing before every irreversible step — a run that loses
  its lease mid-flight fails closed before placing another order. All
  coordination primitives fail **closed** (can't prove leadership → do
  nothing).
- **Safety maintenance never starves.** Every tick, regardless of LLM budgets
  or autonomy state: fill reconciliation, synthetic stop monitoring, stale
  exit-order remediation, proposal expiry. Budget ceilings suppress only LLM
  work.
- **Authority is explicit.** `strategyAuthority` is `propose` (every proposal
  becomes a human approval card) or `decide` (auto-execute, except the
  fail-closed human-review set: unavailable Red Team, unplaceable half-size,
  rationale-diversity collapse, …). A rolling notional-ceiling breach
  auto-demotes authority back to ask-first. Manual "Run once" uses the same
  pipeline with a run-scoped override that forces propose-mode — a manual
  run can never auto-execute.
- **Autonomy never resumes unattended.** On boot, persisted "active" states
  revert to "halted" unless the operator explicitly opted into resume — a
  crash loop or restored database can't silently resume live trading.
  `halted` is the only no-order state; `close_only`/`liquidating` keep
  protective exits armed.

---

## Operational resilience

**Code:** `src/lib/api-circuit-breaker.ts`, `src/lib/db-health.ts`,
`src/lib/notifications.ts`, `src/lib/llm-budget.ts`, `src/lib/llm-errors.ts`

- **Per-credential-lane health and circuit breaking.** Health, trips, alerts,
  and cooldowns are scoped to (service, key-source) lanes; one dead key never
  takes down a sibling lane; a tripped lane's skip is thrown before the fetch
  so it can't perpetuate its own failure streak. Observability code swallows
  its own errors — monitoring can never become the outage.
- **Truthful notifications.** Multi-channel dispatch (push, webhook, email,
  SMS) records `sent` only when a channel actually delivered; alerts
  auto-clear only on *proof* of resolution, and broker-uncertain alerts clear
  only when broker truth confirms the outcome.
- **Layered LLM budgeting.** Per-user daily ceilings, a compare-and-swap
  per-run reservation (closing concurrent-run races), and an operator monthly
  ceiling — all enforced at one choke point that only ever skips LLM work,
  never safety maintenance. Every call writes a usage-ledger row with cache-
  aware cost accounting.

---

## Core invariants (the laws of the system)

1. No connected broker account → no orders. No simulation fallback exists.
2. Every risk-adding opening is Red-Team-reviewed or held for a human;
   reviewer failure fails closed. Exits are never reviewer-blocked.
3. Verdicts and calibration are down-only: dissent and learning can shrink or
   block risk, never enlarge it.
4. Sizing is deterministic and app-side; advisory/learned context provably
   cannot reach it.
5. Only account boundaries and physical/broker/regulatory/accounting
   impossibilities are hard blocks; every other rule is an owner preference
   with a logged override path.
6. Exits are never trapped: not by universe rules, caps, budgets, staleness,
   crisis rules, or adversary outages.
7. Nothing is fabricated: missing data renders blank, statistics are
   sample-gated, unresolvable outcomes stay in denominators, disclosed.
8. Placement is intent-first and idempotent; uncertain broker outcomes are
   reconciled, never guessed. A possibly-real order is never dropped.
9. One leader, one run per account, fenced against lease loss before every
   irreversible step; coordination failures fail closed.
10. Safety maintenance (reconciliation, stops, expiry) runs regardless of
    budgets or autonomy state; budget stops only ever skip LLM work.
11. Every decision, verdict, override, mutation, and dollar of LLM spend
    leaves a durable, attributable receipt.
12. Learning mutations are ledgered, clamped, statistically gated, and
    revertible — and are themselves audited for corruption by system defects.

---

## Honest weaknesses

Kept per the framework's own rule: fixed items move to a "fixed" list rather
than being deleted.

- **The factor weights started as educated guesses.** The defaults are
  explicitly unproven; the IC backtest and walk-forward gates exist to earn
  changes, but early samples are small and shrinkage dominates.
- **Cold start is real.** Scorecards, calibration, episodic memory, and
  counterfactuals all need closed lots to say anything; a new account trades
  on floors and caps, not evidence.
- **LLM judgment is the point — and the risk.** Structured outputs, evidence
  parity, adversarial review, and deterministic gates bound the blast radius,
  but a plausible-sounding thesis can still be wrong in ways no gate catches.
- **Free-tier data has gaps.** The cascade degrades honestly, but degraded is
  still degraded: thin fundamentals on small names, delayed quotes on the
  base tape, provider quotas on enrichment depth.
- **Single-process scheduler by design.** Leases make multi-process deploys
  safe, but the framework assumes one database and one leader — it is not a
  distributed system.
- **Counterfactuals measure price, not fills.** Skipped-candidate returns
  ignore the execution costs and liquidity constraints a real fill would have
  faced (paper fills are cost-modeled; counterfactuals are not).

---

## Related documents

- [`docs/strategic-framework.md`](strategic-framework.md) — plain-English
  investment philosophy and the six evaluation lenses
- [`docs/phase-7-strategy.md`](phase-7-strategy.md) — learning-loop design
  spec (auto-tuning engine, outcome engine)
- [`docs/single-adversary-consolidation.md`](single-adversary-consolidation.md)
  — Red Team design and failure-mode contracts
- [`docs/architecture-blueprint.md`](architecture-blueprint.md) — historical
  blueprint (partially superseded; see its header notes)
- [`docs/capability-trading-roadmap.md`](capability-trading-roadmap.md) —
  forward roadmap (broker-capability-gated margin/shorting/options)
- Public page: `socratictrade.com/framework` (`app/framework/`), derived from
  this document; served to human readers in browsers only
