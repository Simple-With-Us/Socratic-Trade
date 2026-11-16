# 2026-07-01 — API Usage Monitor integration (Workstream C2)

Branch: `claude/competent-elion-c82938`. Spec: `docs/reviews/2026-07-01-audit-work-split.md`
(Cross-repo C2). Design: `docs/usage-monitor-integration.md`.

## Summary

Wired Agentic Trading (App B) to the API Usage Monitor (`usage.jays.services`):

1. **Push usage/cost telemetry** — `recordLlmUsage` and `recordRagUsage` now forward
   each call's usage+cost to the monitor's `POST /api/ingest/usage` via a new
   fire-and-forget forwarder `src/lib/usage-monitor-push.ts`.
2. **Market-data / broker call-volume** — `fetchWithRetry` (all market-data providers),
   `alpaca.trackHealth`, and `robinhood.callRobinhoodMcpTool` now count calls; the
   forwarder flushes them as aggregated per-provider `requests`-count events.
3. **Push-primary for Anthropic / Voyage / Robinhood** — no monitor change needed; items
   1–2 tag `provider` correctly so those (poll-blind) providers land in `ExternalUsageEvent`.
4. **Cost-aware feedback loop** — new monitor endpoint `GET /api/budget-status` (token-gated,
   combines poll snapshot + pushed month-to-date cost vs `ProviderPlan.monthlyBudgetUsd`).
   App B client `src/lib/usage-budget.ts`: **Phase 1** fires `budget_alert` notifications on
   over-budget providers (wired at `runStrategyOnce` entry). **Phase 2** (model-downgrade /
   cycle-skip enforcement) is implemented + tested as a building block but **deferred** — see
   "Post-merge Codex review" below.

## Post-merge Codex review (2026-07-01) — fixes applied + Phase 2 deferred

The Codex PR reviewer surfaced real issues beyond the pre-merge adversarial review. Fixes landed
in this PR:

- **Pinecone RAG volume mislabeled as tokens** → `pushRagUsage` now tags Pinecone query/upsert
  volume `unit:"row"` (only Voyage embed/rerank stays `"token"`).
- **Budget read-token** → the App B budget client now uses `USAGE_READ_TOKEN` (falling back to the
  ingest token), matching the monitor's `/api/budget-status` auth, so a separate read token doesn't
  401 every budget read.
- **`budget_alert` unusable** → added to the Settings notification checkbox list (it was hardcoded
  without it) so users can enable it; it's in `DEFAULT_POLICY.enabledEvents`.
- **Call-volume key-lane conflation** → `recordProviderCall` now scopes counts by
  `keySource`/`userId` (threaded from `fetchWithRetry`) so a user's own market-data key isn't merged
  into shared/operator quota.
- **Enforcement building block hardened** (for the deferred wiring): `evaluateBudgetForRun` resolves
  the *effective* served model (so the default-model case is enforceable), skips (not downgrades)
  when the green model is already cheapest even if red could shrink, and dropped the same-price
  `o3-mini→o4-mini` mapping.

**Phase 2 enforcement deferred to a follow-up PR.** The review showed a naive strategy-loop wiring
is unsafe: a budget cycle-skip must skip only the LLM proposal step (never broker reconciliation or
the drawdown/volatility/stop exits), the downgrade must not mutate the policy object that `setPolicy`
persists on a breaker trip, and it must be threaded into `debateProposal` (which re-loads persisted
policy). So the strategy-loop enforcement block was removed; only Phase 1 (alerts) is wired. The
tested `evaluateBudgetForRun`/`cheaperModel` building blocks remain for the follow-up.

## Why

The monitor's poll adapters are structurally blind to this app's biggest cost drivers
(Anthropic/Voyage/Robinhood); App B already computes real per-call cost but never emitted it
(the shared push client had zero callers — audit §6.9 / top-10 #9). This closes that wiring gap
and adds the audit's "cost-aware feedback loop" strategic bet.

## Self-sufficiency (per owner requirement)

App B runs fully standalone when the monitor is down/unconfigured. Everything is **default-off**
(no-op unless `USAGE_MONITOR_BASE_URL` + `USAGE_INGEST_TOKEN` set), **fire-and-forget +
never-throws**, and **fail-open** (a monitor outage never blocks a run). The only visible effect
of an outage is a `usage-monitor` row on the admin connections-health page (via `logApiHealth`).

## Shared-package note (why hand-rolled, not the shared client)

App B pins `@jaywedgeworth22/congress-trading-shared@1.0.0`, whose published dist does **not**
export `usageTelemetry` (the client lives on the shared repo's unmerged
`feat/usage-telemetry-idempotency-key` branch, v1.1.0). Publishing to the private GH Packages
registry + regenerating App B's lockfile isn't possible in this session, so per the spec's
fallback ("fall back to importing the client's logic locally") the forwarder hand-rolls the POST
against the **same event contract**. Migration path is documented in `docs/usage-monitor-integration.md`.

## Files

App B (`/Users/jay/Code/Agentic Trading`):
- `src/lib/usage-monitor-push.ts` (new) — forwarder: queue + per-provider call-volume aggregate, debounced batched flush, health logging.
- `src/lib/usage-budget.ts` (new) — budget-status client (TTL cache), Phase-1 alerts, Phase-2 enforcement + `cheaperModel`/`providerForModel`.
- `src/lib/llm-usage.ts`, `src/lib/rag-metering.ts` — call the forwarder after the local ledger write (inside the existing never-throws try).
- `src/lib/data-providers.ts` (`fetchWithRetry`), `src/lib/alpaca.ts` (`trackHealth`), `src/lib/robinhood.ts` (`callRobinhoodMcpTool`) — `recordProviderCall(...)` (key-lane scoped).
- `src/lib/strategy.ts` — Phase-1 budget alert (`checkBudgetAndAlert`) at `runStrategyOnce` entry (Phase-2 enforce block removed — deferred).
- `src/lib/types.ts` — new `budget_alert` notification event type.
- `app/dashboard-client.tsx` — `budget_alert` added to the Settings notification checkbox list.
- `.env.example` — `USAGE_MONITOR_BASE_URL`, `USAGE_INGEST_TOKEN`, `USAGE_MONITOR_ENV`, `USAGE_BUDGET_ENFORCE` (+ optional tuning vars).
- `test/usage-monitor-push.test.ts`, `test/usage-budget.test.ts` (new).
- `docs/usage-monitor-integration.md` (new).

Monitor (`/Users/jay/Code/API-usage-monitor`):
- `src/lib/budget-status.ts` (new) — `computeBudgetStatus` (combines poll + pushed cost, reuses `buildProviderAlertState`).
- `src/app/api/budget-status/route.ts` (new) — token-gated `GET` (`USAGE_READ_TOKEN` ?? `USAGE_INGEST_TOKEN`).
- `AGENTS.md` (new) — server-half contract + verify commands.

## Verification

- **App B** (in-worktree; `node_modules` installed via `NODE_AUTH_TOKEN=$(gh auth token) npm ci`):
  - `npx tsc --noEmit` — clean (pre-existing `alternative-data.test.ts` mockFetcher error only).
  - `npm run lint` — 0 errors (unchanged grandfathered warning baseline).
  - `npm test` — full suite green (adds 16 tests across `test/usage-monitor-push.test.ts` +
    `test/usage-budget.test.ts`).
  - `npm run build` — clean.
- **Monitor:** `npx tsc --noEmit` — clean; `npm run build` — clean (`/api/budget-status` in route manifest).
- **Adversarial review** (multi-agent workflow, 5 dimensions × verify): 2 fixes applied
  (`providerForModel` anthropic-prefix; budget fetch timeout 6s→2.5s).
- **Codex PR review:** 5 fixes applied + Phase 2 enforcement deferred (see section above).

## Follow-ups / deferred

- Merge pushed month-to-date cost into the monitor's `/api/providers` alert computation so
  dashboard provider cards match `/api/budget-status` (dashboard-UI scope, out of C2).
- Surface pushed events whose `provider` has no matching Provider row (currently fail-safe dropped).
- When shared 1.1.0 is published + App B's pin bumped: swap the hand-rolled `postBatch` for
  `createUsageTelemetryClient(...).send(events)` (also gets idempotency-key dedup for free once the
  monitor persists `idempotencyKey` — it currently discards it, so the push does not retry).
