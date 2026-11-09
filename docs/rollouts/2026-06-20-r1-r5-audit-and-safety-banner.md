# 2026-06-20 — R1–R5 blueprint audit + R1 tri-state safety banner

## Summary
- Ran a **6-agent audit** (one reviewer per blueprint requirement R1–R5 + synthesis) of the
  Antigravity/Codex in-progress work against `docs/architecture-blueprint.md`, all briefed on the
  canonical **Test / Paper / Brokerage** model.
- Shipped the keystone **safe** R1 piece — a persistent **tri-state execution safety banner** — and
  removed one real drift item (the dead `paperMode` toggle).
- **Verified the audit against real code before acting** and caught several false positives; the
  codebase is further along than the audit's bug-list implied.
- Deployed `5747770` to `socratictrade.com` (prod healthy, still defaulting to Test).

## Why
User asked to "spin up a team of agents to review the work that Antigravity began and Codex
continued, complete the work, improve/correct anything," then commit/push/merge/host. The audit
scopes the true remaining work; the banner is the highest-value piece that carries **no real-money
risk** and was genuinely missing.

## Audit outcome (verified against code, not just the blueprint)
**Already done (no action needed) — audit false positives:**
- `src/lib/execution-mode.ts` is already correct: `test/local | broker/paper | broker/live` strings,
  labels Test/Paper/Brokerage, **no `"mock"`**. The audit's `getThemeClasses("mock"…)` finding was the
  blueprint *doc's* example snippet, not code (no `getThemeClasses` exists in `src/`/`app/`).
- `src/lib/vector-db.ts` Voyage backoff already does `max(batchDelay, exponentialDelay) + jitter`
  (jitter ≤500ms) — not the `Math.random()*backoff` the audit claimed.
- `retrieveContext` already uses a **single `$or` query** (`userId == user OR userId == "local"`).
- **R4 (multi-tenant RAG hardening)** was landed by `worker_m4_1` (merged via `origin/main`); +12 tests
  (261 → 273).

**Genuinely missing (real gaps):** R1 safety gates, R2 trailing-stop engine (0%), R3 IRA tax logic.

## Files (this session, `agent/claude`)
- `app/dashboard-client.tsx` — added `executionBanner(state)` helper + a persistent full-width banner
  above the command bar, keyed on the active execution mode: **Test** (slate) / **Paper** (emerald) /
  **Brokerage** (red, `animate-pulse`). Display-only; does not place or gate orders.
- `app/ui/dashboard/settings.tsx` — removed the stale "Switch to Live/Test" `paperMode` toggle (mode is
  account-derived now).
- `STATUS.md` — handoff note for broker-honesty + account-drives-mode; merge-resolved against Codex's
  broker-neutral-copy and worker_m4_1 RAG entries.

## Verification
- `npx tsc --noEmit` — clean (ignoring pre-existing `.next/types`).
- `npm test` — **273 passed** (post-merge).
- `npm run build` — exit 0.
- Deploy: `~/apps/trading-publish.sh` → published `5747770`; `curl localhost:4000/api/health` → `{"ok":true}`, root 200, pm2 `trading` online.

## ⛔ HOLD — needs explicit human go-ahead (can place / auto-execute real orders)
- **H1** Live-order execution gate enforcement (`approve` requiring `{confirmedLive, disclaimerAccepted}`;
  `gateway.placeEquityOrder()` in `broker/live`) — `app/api/proposals/[id]/approve/route.ts`, `strategy.ts:579`.
- **H2** Autonomy / `decide` mode for Brokerage — `app/api/policy/route.ts`, `strategy.ts`, `settings.tsx`.
  Default all live accounts to `propose`; block `decide`+`broker/live` until approved.
- **H3** Native Alpaca trailing-stop orders (`trail_percent`/`trail_price`) — `alpaca.ts`.
- **H4** Synthetic trailing-stop **execution** (the checker firing market sell/cover) — new
  `src/lib/synthetic-stops.ts`, `robinhood.ts`, `scheduler.ts`.

## Remaining SAFE / protective work (no live-order placement)
- **R3 IRA taxation** — `taxation_type` enum on `connected_accounts` + types; IRA → 0% tax + bypass
  individual wash-sale; **cross-account 30-day buy-lockout** when a loss is realized in a taxable account
  (`src/lib/tax.ts`, `db.ts`, `types.ts`, `policy.ts`) — tax-correctness, tests-first.
- **R1 hourly notional cap + auto-revert** to `propose` on breach (`strategy.ts`, `db.ts`,
  `app/api/policy/route.ts`) — a blocking *safety* control.
- **R2 safe scaffolding** — `synthetic_trailing_stops` table + accessors + the polling/outlier/proximity
  detection logic in `synthetic-stops.ts` (compute + log only; **no order placement** — that's H3/H4).
- **R5 polish (optional)** — cache-control ephemeral headers when scan cadence > 5 min; payload key
  abbreviation. Cost optimization only.

## Update — Wave 1 (foundation) + Wave 2 (R3 IRA taxation) implemented
User authorized all three SAFE items + building H1–H4 **gated so no order can fire until the system
is deliberately started running** (linked account is $0, so low residual risk during dev).

- **Wave 1 — schema/types foundation** (`src/lib/types.ts`, `src/lib/db.ts`): `TaxationType`
  (`taxable|roth_ira|traditional_ira`) on `ConnectedAccount` + `TaxSettings`; `maxHourlyNotional` +
  `allowExtendedHoursSyntheticStops` on `TradingPolicy` (+ `maxHourlyNotional` in the tuning patch);
  `connected_accounts.taxation_type` column (CREATE + idempotent ALTER migration), mapped in
  `listConnectedAccounts`/`getActiveConnectedAccount`, persisted in `upsertConnectedAccount`;
  `synthetic_trailing_stops` table + accessors (`upsert/list/delete/purgeSyntheticStops`); and
  `notionalInLastMinutes()` (rolling-window notional for the R1 hourly cap).
- **Wave 2 — R3 IRA taxation** (`src/lib/tax.ts`, `strategy.ts`, `dashboard.ts`): `resolveTaxSettings`
  forces IRA → 0% rates + `washSaleGuard:false`; `getTaxSummary` honors `taxationType` (IRA ⇒ 0 tax,
  no own-account lockout); new `getWashSaleLockedSymbolsForUser` / `getUserWashSaleLockedSymbols`
  implement the **cross-account** lockout (a TAXABLE-account loss locks rebuys across ALL accounts incl.
  IRAs; an IRA's own loss locks nothing). `strategy.ts` now feeds the **cross-account** set to the policy
  guard at both the run-loop and approval paths. +3 tests in `test/tax.test.ts`. **276 tests green.**
- **Wave 3 — R1 hourly cap + auto-revert** (`policy.ts`, `strategy.ts`): `maxHourlyNotional` enforced in
  `evaluateTradeProposal` (rolling 60-min window via `notionalInLastMinutes`) at the run-loop + approval
  paths; a daily/hourly/order-count breach in `decide` mode auto-reverts the account to `propose` + audits
  `policy_violation_cap_exceeded`. +2 policy tests. Settable via a new **Max hourly notional** field in the
  live Key-parameters card.
- **R3 usable from the UI**: a tax-treatment picker (Taxable / Roth IRA / Traditional IRA) in the live Tax
  tab (sets `taxSettings.taxationType`); the connect-accounts route now accepts a per-account
  `taxationType` that overrides the policy-level default; `dashboard.ts` resolves account-level →
  policy-level. **278 tests, build green; deploying.**
- **Wave 4 — control-group consolidation + R2/H4 (per user direction).**
  - **Controls (one Start/Stop + approval mode):** removed the redundant autonomy **Switch**; the header
    now has a **Mode** selector (Propose → you approve / Decide → auto-executes), a **Run once** button
    (manual scan), and a single **Start/Stop** primary that opens a confirm explaining the gate ("only
    while running can orders be placed", mode-aware). `systemState === "halted"` ⇒ `throw` in `strategy.ts`
    remains the hard order gate, so nothing trades until Start.
  - **R2 synthetic trailing-stop monitor** (`src/lib/synthetic-stops.ts`): pure `evaluateStop`
    (extreme-tracking, %/abs trail, **bad-tick >10% filter**) + `runSyntheticStopMonitor` (purges closed
    positions, auto-registers longs when `riskRules.trailingStopPct` is set, persists extremes). +5 tests.
    Works for ALL brokers (incl. Robinhood MCP) via a market exit — simpler/safer than mixing native.
  - **H4 gated execution:** when a stop triggers, the monitor fires a **market** sell/cover + records the
    fill — but only when `running`; the scheduler calls it only for `systemState === "active"` users, so
    exits are gated behind Start. When not running it audits `synthetic_stop_would_trigger` (detection only).
  - **H3 (native Alpaca trailing) deferred:** `OrderType` has no `trailing_stop`; adding it is a broad
    cross-cutting change. The synthetic-for-all-brokers path covers Alpaca too; native delegation is a
    future optimization — noted, not silently dropped.

## Follow-ups / notes
- The 6-agent audit over-reported by reading the blueprint's illustrative snippets as code. Lesson:
  verify each finding against the actual file before implementing (done here).
- `STATUS.md` worker_m4_1 entry cites "271 tests"; actual post-merge count is 273 — harmless drift.
