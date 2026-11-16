# OSS Lessons — external references mapped to this repo

Owner-directed (2026-07-29). Survey of open-source projects whose designs solve problems this
repo also has, with a concrete "what to steal / what we already have / what to avoid" mapping
per area. Sources are 2026 secondary write-ups plus repo READMEs; star counts and feature
claims should be re-verified before treating any project as a dependency. Nothing here imports
third-party code — Hivekeep is AGPL-3.0 (patterns only, no code), OpenClaw is MIT, freqtrade is
GPLv3 (patterns only), Lean is Apache-2.0, OpenBB is AGPL (patterns only).

## 1. Reference inventory

| Project | What it is | Primary lesson area |
|---|---|---|
| freqtrade/freqtrade (GPLv3) | Mature crypto trading bot | Order state machine, Protections framework, dry-run parity |
| QuantConnect/Lean (Apache-2.0) | Event-driven backtest/live engine | Backtest==live parity, per-brokerage order-type models |
| Alpaca OMS v2 write-up (Redpanda blog) | Broker's own order manager design | Sequential-per-account processing, WAL-replayable state |
| OpenBB (AGPL) | Financial data platform | Provider interface + per-field provenance ("standardizer" split) |
| TauricResearch/TradingAgents | Multi-agent LLM trading desk (LangGraph) | Graph orchestration, debate protocol, risk veto separate from conviction |
| virattt/ai-hedge-fund | Multi-persona agent simulator | Structured signals + confidence, agent-accuracy weighting (meta-learning) |
| NoFxAiOS/nofx | AI trading assistant | Consecutive-miss kill switch ("safety mode") |
| microsoft/qlib | Quant research platform | Point-in-time data, walk-forward evaluation |
| TraderHarness | LLM-agent backtest harness | PIT masking + entity/date anonymization, trajectory export |
| Jesse (jesse.trade) | Python trading framework | Rule-significance testing (is entry timing better than luck?) |
| OpenClaw (MIT) | Local-first always-on agent gateway | Heartbeat output contract, Task Brain unified ledger, tiered model routing, exec approvals |
| Hivekeep (ex-KinBot, AGPL-3.0) | SQLite/TypeScript agent platform | Cron journal, preview renderers for mutating ops, hybrid memory retrieval |
| Inalpha | Quant agent framework | "LLM has no direct order path — every order passes machine approval" |
| ZhuLinsen/daily_stock_analysis (MIT) | Agentic daily stock analysis | Real-time search integration for news context, Agent-based QA mode, WebUI dashboards |

## 2. Agent operations — OpenClaw / Hivekeep (FOUNDATION LANDED 2026-07-29)

**Already had:** durable leader lease (`scheduler-lease.ts`), boot autonomy interlock,
per-account cadence lanes, in-flight guards, Sentry cron check-in, `due_jobs` claimable queue.

**Stolen:**
- **Task Brain / cron journal (IMPLEMENTED — see §9).** OpenClaw's 2026.3 "Task Brain" and
  Hivekeep's `get_cron_journal` both unify every kind of scheduled/background fire into one
  inspectable ledger. Our state was spread across `internal_settings` markers, `strategy_runs`,
  `due_jobs`, and `audit_events` — you could not answer "what did the scheduler do in the last
  hour, lane by lane" from one place. New `task_journal` table + `task-journal.ts` + scheduler
  wiring + ops-snapshot exposure fixes that.
- **Heartbeat output contract (doc-level confirmation).** OpenClaw's heartbeat skill rules —
  strict "say nothing when nothing is actionable," cron for exact timing vs heartbeat for
  adaptive — validate the `eventRunMode` + `fallbackIntervalMinutes` design from
  `docs/event-driven-transition-plan.md`. No code change needed.
- **Model tiering review (§3 below).**

**Avoid:** OpenClaw's community skill-registry model (a real exfiltration/prompt-injection
incident occurred — relevant if strategy packs are ever community-sourced); single-gateway
SPOF (we already enforce one scheduler leader).

## 3. Model tiering — review (no code change recommended now)

Current state is already strong and goes beyond OpenClaw's pattern: role-tiered seats
(Green/Red/Coach with per-role model recommendations in `docs/manager-model-options.md`),
credential-aware rotation intersected with OpenRouter availability (`model-rotation.ts`),
provider cooldowns, daily budget + monthly spend ceiling with cadence rollback, and
mechanical-vs-reasoning separation (Nano-class for extraction/classification).

OpenClaw's one idea we do NOT yet have: **cost-tiered heartbeats** — cheap models for frequent
low-stakes cycles, frontier only for decisions. Our scheduler heartbeats are already LLM-free
(pure TS), so there is nothing to downgrade. The one candidate gap: if the trigger engine's
event triage ever uses an LLM per event, that triage should be pinned to a Nano-class seat, not
the Green seat. Flag for the event-driven transition; not worth code today.

## 4. Order lifecycle & broker sync — freqtrade / Lean / Alpaca OMS (PLANNED §7)

**Already had:** `isWorkingOrderState` shared terminal-state classifier (the 2026-07-27
`done_for_day` fix), `reconcilePendingFills` every tick independent of strategy cadence,
broker health gate suppressing runs on elevated `order_placement_uncertain`, in-flight guards
preventing double-sell on stale-exit cancel-replace, order_replacements ledger with
terminalization migration.

**Gaps worth stealing (freqtrade):**
- A single **order-state transition module** per broker adapter — freqtrade's core discipline
  is that *nothing outside the exchange wrapper interprets raw exchange status strings*. Our
  status interpretation is shared (`broker-side.ts`) but each adapter still maps raw statuses
  in its own way; a conformance test table (raw status → canonical state, per broker, incl.
  weird ones: `done_for_day`, `pending_cancel`, `replaced`, `expired`) would lock this down.
- **Protections framework shape**: freqtrade Protections are composable, per-pair/time-bounded
  cooldown objects evaluated pre-trade, each producing a receipt. Our guards (staleness gate,
  vol taper, heat taper, drawdown breaker) are close; adopting the uniform "protection →
  receipt" interface would make the Guardrails UI and risk receipts generic instead of
  per-guard bespoke.

**Gaps worth stealing (Lean):**
- **Brokerage models as data**: each broker's order-type constraints (e.g. Alpaca's
  "bracket orders must be entry orders" 422 that bit us on T sells) encoded declaratively and
  validated *before* submission, with unit tests per constraint — instead of learning each
  constraint from a production 422.
- **Backtest==live parity**: Lean's one engine runs both. Our `backtest.ts` is separate from
  the live path; full parity is a large effort, but the cheap first step is running the
  *policy/guard evaluation* (not the LLM) identically in backtest and live.

**Gaps worth stealing (Alpaca OMS write-up):**
- **Sequential-per-account ordering**: Alpaca's OMS processes each account's orders strictly
  sequentially because buying-power validation is order-dependent. Our per-account in-flight
  guards approximate this for specific lanes; a per-account execution mutex around ALL broker
  mutation lanes (strategy execution, stale-exit remediation, stop monitor, drain cancels)
  would make the invariant structural instead of per-lane.
- **WAL-replayable state**: OMS rebuilds state by replaying an event log. Our `fill_events` +
  `order_replacements` + `task_journal` (new) are close to a replayable log; documenting the
  reconstruction path (and a recovery drill) is the gap, not the data.

## 5. Preview renderers for mutating operations — Hivekeep (COMPLETED 2026-07-29, zero-code finding)

Hivekeep renders a human-readable preview card for every mutating tool call (`update_memory`,
`delete_cron`, `update_secret`, …) before commit. **Finding from a full mutation-surface
inventory (2026-07-29): this lesson is ALREADY landed in bespoke, proportionate form on every
mutating console surface** — a shared `MutationPreview` abstraction would refactor 8+ carefully
tuned surfaces for marginal consistency, and is not advisable:

| Surface | Existing preview/confirmation UX |
|---|---|
| Policy/Guardrails edits | Review Sheet with per-field diff + Locks Down/Unlocks direction tags + typed CONFIRM for loosening on live accounts (`app/console/components/policy-form.tsx`, `app/console/lib/policy-diff.ts`) |
| Account deletion | Server-side preview (per-table counts + activity blockers) + 5 acknowledgements + typed email + typed phrase, local-operator extra phrase (`app/console/settings/danger.tsx`) |
| Live proposal approve | Typed batch Sheet with per-order notional (`app/console/approvals/page.tsx`) |
| Proposal reject | 4-second arm-click with stale-arm auto-disarm (no ritual — proportionate) |
| Learned-context approve | Confirm dialog with the exact effect preview, incl. the directive block that would be appended (`app/console/lessons/learned-context.tsx`) |
| Learned-context reject | One-click discard — applies nothing, so proportionate |
| Learned-fact delete / broker disconnect / API-key delete | Inline confirms with consequence text |
| Autonomy re-arm (halted→start) | One-tap — deliberate owner-directed design (`app/console/components/chrome.tsx` ControlSheet: "Friction is reserved for what SELLS or halts") |

Guidance for FUTURE mutating surfaces: copy the nearest existing pattern above (review Sheet for
settings edits, typed ritual for irreversible money-adjacent actions, arm-click for batched
low-stakes actions) rather than building a new abstraction.

## 6. Backtest integrity for the learning loop — Jesse / TraderHarness / qlib (PARTIALLY IMPLEMENTED — slices 1+3 landed 2026-07-30, PRs #2294/#2305)

The Phase 7 learning loop matures outcomes and (eventually) evaluates LLM proposals against
history. Three contamination traps, three references:

- **Jesse — rule significance (IMPLEMENTED 2026-07-30, PR #2294)**: before a thesis tag or
  signal is credited with predictive power, test whether the same trades would have done as
  well under a random grouping (permutation / Monte-Carlo baseline). As implemented:
  `src/lib/significance.ts` — a pure label-permutation test (observed thesis-bucket mean
  realized `returnPct` vs random same-size buckets of the pooled tagged closed-lot history,
  1000 permutations, +1 p-value correction, pool-size floor) wired into
  `writeThesisTrackRecordFacts` in `post-mortem.ts`. Each directional track-record fact now
  carries one honest baseline sentence and its confidence scales (0.7 unlikely-luck / 0.45
  luck-not-ruled-out / 0.6 fallback) — annotation, not hard-gate. Rollout:
  `docs/rollouts/2026-07-30-rule-significance.md`.
- **TraderHarness — PIT masking for LLM evaluation**: an LLM asked to "decide" on 2024 data
  may simply remember 2024. Their fixes: point-in-time masking (only data available at T is in
  context), entity/date anonymization (symbol → random ticker, dates → relative offsets), and
  full decision-trajectory export. Steal all three before any LLM-in-the-loop historical
  evaluation; without them a "backtest" of an LLM strategy measures memorization.
- **qlib — walk-forward discipline (IMPLEMENTED 2026-07-30, PR #2305)**: train/score windows roll
  forward; nothing fitted on the full sample. Audit finding: the split in `backtest.ts` was
  already sound (chronological unique-date split, always-on test-side embargo of `horizonDays`
  date-buckets, opt-in train-side purge via `policy.tuning.oosPurgeEmbargo`). The residual leak
  was upstream: the tuner's candidate weights are proposed from ALL-history evidence (closed-lot
  outcomes, scorecards, skipped-candidate counterfactuals) that includes the recent held-out test
  fold — partially in-sample. As implemented: `splitWalkForward` returns exact fold-boundary
  indices; `OOSResult` carries a required `window` report (train/test first+last dates,
  embargo/purge counts); the manual + autonomous OOS readouts name the held-out window and carry
  a "partially in-sample — a pass is necessary, not sufficient" caveat into the cautions, ledger,
  and provenance evidence. Rollout: `docs/rollouts/2026-07-30-walk-forward-window.md`.
  Follow-up LANDED 2026-08-01 (PR #2327): time-bounded proposal evidence — the tuner's
  realized-outcome evidence is now cut off at the fold start (`computeOosEvidenceCutoff` +
  `policy.tuning.pitEvidenceCutoff`, default ON), so the caveat is retired for the weight path.
  Aggregate learning state (lessons/reflection) remains uncut — that is slice 2's territory.

## 7. Brokerage-model order-state hardening (PARTIALLY IMPLEMENTED — slices 1–2 landed; slices 3–4 planned)

Tracked as its own effort row: conformance status tables per broker, declarative order-type
constraint validation pre-submission, per-account broker-mutation mutex, freqtrade-style
uniform protection receipts. Targets the exact bug classes from 2026-07-27/28 (done_for_day
inflation, order_placement_uncertain storms, bracket-order 422s).

**Slice 1 (LANDED 2026-08-01, PR #2335): per-broker order-status conformance tables.**
`src/lib/broker-status-conformance.ts` maps every documented raw status of
alpaca/robinhood/tradier to its canonical class across the four production lenses
(live/active/working/decline/filled), executed against the REAL shared classifiers
(`broker-side.ts` / `broker-held-orders.ts`) by `test/broker-status-conformance.test.ts` — a
vocabulary or classifier edit in either direction is now a CI failure. The audit also found
`broker-held-orders.ts` carrying a drifted local decline set (missing `failed`/`error`, zero
importers); it now re-exports the canonical `broker-side.isRejectedOrCanceledState`, making
the drift structurally impossible. Rollout: `docs/rollouts/2026-08-01-broker-status-conformance.md`.
Slices 2-4 status: slice 2 implemented (below); 3-4 remain planned.

**Slice 2 (IMPLEMENTED 2026-08-02, branch `monet/broker-order-constraints`): declarative
per-broker order-type constraint validation.** `src/lib/broker-order-constraints.ts` encodes each
broker's order-shape rules as data (10 receipted rows: alpaca bracket-legs-entry-only — THE
2026-07-27 T sell 422 fix — trailing/extended-hours/stop-price rules; robinhood short/trailing/
bracket rules; tradier trailing fail-closed + market-entry bracket strip), applied at the single
placement choke point (`withOrderConstraints` in broker.ts, inside `withLivePreflight`, every
environment). Remedies per row: `block` (OrderValidationError → proposal status "blocked") or
`reshape` (corrected copy + `order_constraint_reshaped` audit receipt — never block an exit over
decorative bracket legs). One unit test per constraint + fixture-coverage gate
(test/broker-order-constraints.test.ts). Rollout: docs/rollouts/2026-08-02-broker-order-constraints.md.
Slice 3 PR-1 (IMPLEMENTED 2026-08-02, branch `monet/broker-mutation-mutex`): per-account
broker-mutation lease — `src/lib/account-mutation.ts` over the operation-lease primitive, keyed
`broker-mutation:${userId}:${accountNumber}`, sequence-scoped windows (never whole lanes), wrapping
the stop-monitor pass, stale-exit remediation, drain, and manual replace; standalone cancels stay
unleased (doctrine in the module header); advisory `broker_mutation_unleased` receipt backstop at
the gateway. PR-2 (strategy/approval placement windows) and slice 4 (uniform protection receipts)
remain planned. Rollout: docs/rollouts/2026-08-02-account-mutation-lease-pr1.md.

## 8. nofx-style consecutive-miss safety mode (IMPLEMENTED 2026-07-29, PR #2275)

nofx tracks rolling prediction accuracy; after N consecutive misses (default 3) the system
closes/hedges, suppresses new signals, and goes observation-only until accuracy recovers. We
have drawdown-based breakers but nothing *accuracy*-based: a thesis regime can degrade long
before a 15% drawdown, especially with small positions.

**As implemented** (`src/lib/accuracy-breaker.ts` + `strategy.ts` wiring, mirroring the
drawdown-breaker pattern): a pure evaluator over matured REAL (placed/filled) decisive outcomes
(`listRecentDecisiveOutcomeStatuses` in db-socratic.ts — counterfactual outcomes of
blocked/rejected proposals are excluded: avoiding a bad trade is a good call, not a miss). Two
independent opt-in triggers (deviation from the sketch's AND — nofx itself fires on the streak
alone): `riskRules.accuracyBreakerConsecutiveLosses` (newest K decisive outcomes all lost) and/or
`accuracyBreakerWindow` + `accuracyBreakerMinHitRatePct` (rolling hit rate below floor; full
window required, never fires on a tiny sample). Response per `riskRules.accuracyBreakerAction`:
advisory by default (persisted KV degraded marker + one `risk_advisory` notification per
degradation, no state change) or opt-in `close_only` hard flip of the run's target account +
`kill_switch`. Recovery (`accuracyBreakerRecoveryWins` most-recent clean outcomes, default 2)
clears the marker and notifies but NEVER flips systemState back; owner re-arm after a hard flip
clears the marker (audited `accuracy_breaker_rearmed`). Off by default. Guardrails +
settings-search rows; 27 tests. Rollout: `docs/rollouts/2026-07-29-accuracy-breaker.md`.

## 9. Implementation status

| Item | State |
|---|---|
| Task brain / cron journal (`task_journal`, scheduler wiring, ops snapshot) | **Implemented 2026-07-29 (this change set)** |
| Model tiering review | Done — no change (§3) |
| Preview renderers for mutations | **Completed 2026-07-29 — zero-code finding: already landed bespoke on every surface (§5)** |
| Backtest-integrity suite | **Partially implemented — slice 1 (Jesse rule significance) PR #2294 + slice 3 (qlib walk-forward window report) PR #2305, 2026-07-30**; slice 2 (PIT masking) planned (§6) |
| Brokerage-model hardening | **Partially implemented — slice 1 (status conformance tables) PR #2335; slice 2 (declarative order-type constraints) 2026-08-02**; slices 3–4 (per-account mutex, protection receipts) planned (§7) |
| nofx safety mode | **Implemented 2026-07-29 (§8, PR #2275)** |
| Graph flows | Existing `TradingGraph` orchestrator (strategy.ts) is the LangGraph-lesson landing spot; extend nodes there rather than adopting LangGraph |

## 10. Graph flows — note

The TradingAgents/LangGraph lesson landed before this doc: `runStrategyOnce` already runs as a
`TradingGraph` state machine (`src/lib/orchestration/trading-graph.ts`, nodes INIT →
DATA_GATHERING → ALTERNATIVE_DATA_ANALYSIS → FUNDAMENTAL_PROPOSING → RED_TEAM_REVIEW →
EXECUTION). Adopting LangGraph itself is not recommended (Python, heavy); the useful remaining
ideas are (a) node-level journaling — the new `task_journal` can carry graph-node timings via
its metadata — and (b) TradingAgents' "risk veto is structurally separate from conviction,"
which our policy layer already implements.

## 11. Web search provider integration — daily_stock_analysis (PLANNED)

**Gap worth stealing:** The `ZhuLinsen/daily_stock_analysis` project demonstrates how integrating real-time web search (e.g., SerpAPI, DuckDuckGo, Brave Search) deeply into the market analysis loop provides critical, up-to-the-minute news context that raw API market data lacks.
**Plan:** We will integrate a web search capability into our `regime-watch` or fundamental data gathering phase, exposing the aggregated news/context clearly in our Dashboard (read-only), while keeping our Socratic policy veto model strictly intact.
