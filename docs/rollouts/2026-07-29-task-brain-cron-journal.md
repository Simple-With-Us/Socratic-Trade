# Task Brain / Cron Journal + OSS Lessons Doc

**Context & Objective**: Owner-directed (2026-07-29) implementation of the OpenClaw "Task Brain" /
Hivekeep cron-journal pattern: one unified SQLite ledger recording every scheduled/background lane
fire, so "what did the scheduler do, lane by lane, in the last hour/day" is answerable from a single
table instead of being reconstructed from `internal_settings` markers, `strategy_runs`, `due_jobs`,
and `audit_events`. Companion research doc `docs/oss-lessons.md` maps the wider OSS survey
(freqtrade, Lean, Alpaca OMS, OpenBB, TradingAgents, ai-hedge-fund, nofx, Jesse, TraderHarness,
qlib, OpenClaw, Hivekeep) to concrete repo changes and registers the follow-on efforts.

**Changes Made**:
- `src/lib/db.ts` — migration **v62 `task_journal`** (table + 3 indexes); `task_journal` added to
  the account write-fence `preparedInsertAllowed` + `preparedUpdateAllowed` sets (observability
  writes must survive a deletion-prepared window, same as `audit_events`); barrel re-export of
  `./db-task-journal`.
- `src/lib/db-task-journal.ts` (new) — CRUD: `recordTaskStart` / `recordTaskEnd` (never throw —
  journaling is observability, not money path), `listTaskJournal`, `getTaskJournalSummary`
  (per-lane 24h aggregates), `pruneTaskJournal` (skipped rows age out in 24h, ok/error in 30d).
- `src/lib/task-journal.ts` (new) — `journalLane(name, ctx, fn)` wrapper: timing, ok/error/skipped
  outcome mapping, error re-throw so caller behavior is unchanged. `isLaneOutcome` guard requires
  an explicit `ok`/`skipped` status or a `value` key, so a lane whose real result is
  `{ status: "success" }` (e.g. managed-vector reconcile) is NOT mistaken for an outcome envelope.
- `src/lib/scheduler.ts` — every tick lane journaled: stale-run sweep (+ journal retention prune),
  material-event drain, managed-vector reconcile, ST bridge writer, web-source refresh,
  provider-tier check, filing-body + FMP transcript ingest, earningscalls refresh, congress daily
  share, regime-flip check, learning review, retrieval-usefulness join, price alerts, mobile
  command drain, due-job intraday drain, and per account: proposal expiry, account drain,
  stale-limit scan, synthetic-stop monitor, pending-fill reconcile, **broker-health-gate
  suppressions** (journaled with reason — answers "why didn't this account trade?"), strategy-run.
- `src/lib/ops-snapshot.ts` — `taskJournal` per-lane aggregates (24h) on the ops snapshot, so
  `GET /api/ops/snapshot` exposes the task brain remotely.
- `test/task-journal.test.ts` (new) — 9 tests: round-trip + derived duration, lane value
  pass-through, outcome envelope mapping, `{status:"success"}` non-collision, error journaling +
  re-throw, filters/limit, per-lane summary aggregation, split retention pruning, never-throw
  no-ops.
- `docs/oss-lessons.md` (new) — the OSS survey + implementation mapping + status tracker.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — program rows (this effort In
  Progress; preview renderers claimed KIMI; backtest-integrity, brokerage-model hardening, nofx
  safety mode Planned/unassigned).

**Decisions & Trade-offs**:
- Journal fires, not cadence evaluations: lanes that run every tick but self-skip return
  `status: "skipped"` where the lane knows it did nothing (ages out in 24h), keeping the ledger
  queryable without flooding it. Whole-tick journaling deliberately omitted (liveness already
  covered by `scheduler:lastTick` + Sentry cron check-in).
- No LangGraph / external orchestrator adoption: graph-style flows already exist via
  `src/lib/orchestration/trading-graph.ts`; the doc recommends extending nodes there.
- Model tiering: reviewed (OpenClaw cheap-heartbeat pattern) — no code change; our heartbeats are
  already LLM-free and role-tiered seats + rotation + budgets exceed the pattern (oss-lessons §3).
- Preview renderers, backtest-integrity, brokerage-model hardening, nofx safety mode are scoped
  with designs in the doc and effort-board rows, not implemented in this change set.
- Hivekeep is AGPL-3.0 and freqtrade GPLv3: patterns only, no code copied.

**Verification State**:
- `npx tsc --noEmit` — clean.
- `npx eslint` on all touched files — 0 errors (4 pre-existing grandfathered warnings).
- `npx vitest run test/task-journal.test.ts` — 9/9 pass (migration v62 applies cleanly).
- Scheduler regression files (7 files / 28 tests: cadence, draining, leader-heartbeat,
  single-leader, boot-halt-notify, managed-vector-reconcile, followup-lease) — pass.
- Full suite: shard 1/3 = 156 files / 1841 tests pass. Shards 2/3 and 3/3 could not complete
  inside the 300s tool cap — host load average 40-55 from concurrent foreign vitest processes
  (multi-agent Mac). Remaining shards + `npm run build` re-run before landing; `verify` CI is
  the authoritative full gate.
- Known pre-existing unrelated issue per AGENTS.md: `test/alternative-data.test.ts` mockFetcher
  type mismatch (not touched).

**Next Steps & Blockers**:
- Land via `scripts/land.sh` (opens PR from `agent/kimi-lane`, auto-merge arms; merge == deploy).
- Follow-on efforts (board rows): generalized mutation preview renderers (§5, claimed KIMI),
  backtest-integrity suite (§6), brokerage-model order-state hardening (§7), nofx
  consecutive-miss safety mode (§8).
- Optional later: journal whole-tick heartbeat row; journal trigger-engine event runs in
  `triggers.ts`; surface taskJournal on the admin dashboard UI (currently ops-snapshot only).
