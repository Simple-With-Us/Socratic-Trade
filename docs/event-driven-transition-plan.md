# Event-Driven Transition Plan — 2026-07-28

**Status: PLAN — nothing is enabled by this document.** The trigger engine is default OFF in
production. This doc records the verified current architecture and a staged path toward mostly
market-signal-prompted strategy runs, per the owner's direction. Companion docs:
`docs/event-driven-llm-triggering.md` (the expert-panel spec) and
`docs/guard-enablement-proposal-2026-07-28.md` row 11 (regime-flip trigger, approved "enable when
the trigger engine lands" — the engine has now landed).

## Current architecture (verified in code 2026-07-28, branch `agent/kimi/guard-enablement`)

**Engine (`src/lib/triggers.ts`)**

- Master switch `TRIGGER_ENGINE` (default off — `submitMaterialEvent`/`broadcastMaterialEvent`
  are no-ops, scheduler unchanged). `TRIGGER_MODE` = `interval` | `event` | `both`
  (default `both`, triggers.ts:90-93).
- Events are deduped by `type:symbol:sourceId` (TTL `TRIGGER_DEDUP_TTL_SEC`, default 24h; SEC 8-K
  receipts 30d), persisted in a **durable per-user queue** in `user_settings`
  (`material_trigger_state_v1`, max 5,000 pending) that survives restarts;
  `drainMaterialEventQueue()` reschedules from the DB, not timers.
- Coalescing: debounce 90s (`TRIGGER_DEBOUNCE_MS`) with a 300s hard ceiling
  (`TRIGGER_MAX_DEBOUNCE_MS`) and max batch 25 — a storm of events becomes ONE run.
- Admission gate (`admitRun`, triggers.ts:500-518): engine on, mode allows events,
  `systemState === "active"`, account selected, market hours (`isRunAllowedNow`), then
  **global cooldown 300s, hourly cap 6 runs, daily cap 24 runs, per-symbol cooldown 1800s**
  (env-tunable: `TRIGGER_GLOBAL_COOLDOWN_SEC`, `TRIGGER_MAX_RUNS_PER_HOUR`,
  `TRIGGER_MAX_RUNS_PER_DAY`, `TRIGGER_PER_SYMBOL_COOLDOWN_SEC`).
- Fired runs are normal FULL strategy runs: `fire()` calls `runStrategyOnce(userId)`
  (triggers.ts:478-479). There is currently **no close-only / reduced-scope run type** — see
  gap G2 below.
- LLM daily budget gate: `checkLlmDailyBudget` (src/lib/llm-budget.ts) is enforced INSIDE
  `runStrategyOnce` after the non-LLM risk breakers and before proposal generation, so it covers
  interval AND event runs. Default OFF until `TRIGGER_LLM_DAILY_TOKEN_BUDGET` (or
  `_COST_BUDGET_USD`, or `tuning.llmDailyTokenBudget`) is set.
- Observability: `trigger_run` / `trigger_suppressed` audit rows (with suppression reason);
  diagnostic route `GET/POST /api/admin/trigger-test` previews `admitRun` and submits test events.

**Producers wired today**

- `src/lib/regime-watch.ts` — `checkRegimeFlip(userId)` runs every scheduler tick per user
  (scheduler.ts:566-570). On a flip it writes a `regime_flip` audit row, pushes a dashboard
  refresh, and — only when flipping INTO an escalation regime (Risk-Off / Crisis /
  Inverted-curve) — submits a `type: "regime"` material event for that user (regime-watch.ts:128-130).
  De-escalations never trigger runs.
- SEC 8-K discovery — fresh filings with material item codes broadcast events (see
  docs/event-driven-llm-triggering.md).
- TradingView webhook — `src/lib/tradingview-trigger.ts` broadcasts `type: "technical"` events.
- Alpaca price-events stream — `src/lib/streams/alpaca-price-events-stream.ts` submits
  `type: "technical"` per-symbol events; refuses to start when `TRIGGER_ENGINE` is off.

**Scheduler interaction (src/lib/scheduler.ts:743-748)**

- `interval` (or engine off): fixed `runCadenceMinutes` (default 60) cadence only — today's
  behavior, byte-identical.
- `both`: the 60-min interval lane keeps running AND the event lane adds runs on top.
- `event`: the interval lane is skipped entirely (`schedule.nextRunAt = null; continue`).
  **There is no fallback interval in event mode** — if producers go quiet or break, no strategy
  runs happen at all. Non-LLM safety tasks (synthetic-stop monitor, pending-fill reconcile,
  stale-order maintenance, regime check) still run every tick in all modes.

## Recommended staged path

**Stage 1 — `TRIGGER_ENGINE=1`, `TRIGGER_MODE=both` (via Infisical on `socratic-trade-prod`).**
Events ADD runs on top of the unchanged 60-min cadence. Also set
`TRIGGER_LLM_DAILY_TOKEN_BUDGET` to a real ceiling so the new event lane cannot run away on spend.
Exit criteria before Stage 2 (suggested: 2-4 weeks):
`trigger_run`/`trigger_suppressed` cadence is sane (no cap-pinning, no cooldown starvation),
daily LLM spend within budget, `regime_flip` audits match actual regime changes, no duplicate/
storm runs (debounce working), no stale-queue buildup after deploys/restarts.

**Stage 2 — `TRIGGER_MODE=event`.** Mostly signal-driven runs. **Blocked on gap G1 below** unless
the owner accepts that a silent producer = zero runs. Do not flip until G1 is resolved or
explicitly accepted.

## Gaps / follow-ups (code)

- **G1 — No fallback interval in `event` mode.** The scheduler drops the cadence lane entirely
  (scheduler.ts:744-748). A dead producer (webhook secret rotation, stream disconnect, SEC outage)
  silently means no runs. Recommended: a long-horizon fallback cadence (e.g. 6-12h) in event mode,
  or a "no run in N hours" alert, before Stage 2.
- **G2 — "Close-only review run on regime flip" is UNIMPLEMENTED.** `fire()` always runs a full
  `runStrategyOnce` — an event-triggered run can open new positions (subject to all the normal
  gates). The approved proposal (row 11) and the expert-panel doc describe a close-only/review
  scope for regime flips; implementing a reduced run scope is a follow-up code change. Until then,
  enabling the engine means regime flips trigger full runs.
- **G3 — Caps are env-global, not per-user.** Per-user `triggerConfig` policy fields remain
  deferred (documented in the panel spec). Fine for the single-owner deployment.

## What to monitor (Stage 1)

- Run rate vs caps: `trigger_run` vs `trigger_suppressed` audit counts by reason
  (`global_cooldown`, `hourly_cap`, `daily_cap`, `per_symbol_cooldown`). Sustained cap-pinning
  means producer storms; sustained suppression means the event lane is decorative.
- LLM spend: daily tokens/cost from the usage ledger against `TRIGGER_LLM_DAILY_TOKEN_BUDGET`;
  interval+event total runs/day (24 cap + cadence runs).
- `regime_flip` audit cadence vs known market days — flip detection should be rare (a few per
  month), not weekly.
- Durable queue depth (`getDurableMaterialTriggerStatus`) after deploys — pending should drain,
  not accumulate.
- Event-mode ONLY (Stage 2): time since last strategy run, per account.

## Open questions for the owner

1. Stage 1 duration before Stage 2 — is 2-4 weeks of clean observability the right gate, and who
   calls it?
2. G1: build the long-interval fallback before `TRIGGER_MODE=event`, or accept "silent producers
   = no runs" with an uptime alert instead?
3. G2: should a regime-flip run be close-only (per the original proposal) before the engine goes
   on in prod, or is a full run acceptable given the guard stack (staleness gate, heat/vol tapers,
   drawdown advisory) now defaults on?
4. `TRIGGER_LLM_DAILY_TOKEN_BUDGET` value for Stage 1 (tokens/day) — pick from current average
   daily usage × ~1.5?
5. Are the panel's default caps (6/hour, 24/day, 300s global cooldown) right for live accounts,
   or should Stage 1 start tighter (e.g. 3/hour, 12/day)?

**Update 2026-07-28 (branch `agent/kimi-lane`):** gaps G1 and G2 are now addressed — per-account
`policy.triggerSettings` ships a `fallbackIntervalMinutes` safety-floor cadence for event-only
mode, a three-state per-account enabled/mode override, and `eventRunMode: "close_only"` for
close-only event runs (run-scoped clone, never persisted). See
`docs/rollouts/2026-07-28-per-account-trigger-guard-settings.md`.
