# API Usage Monitor integration (Workstream C2)

How Agentic Trading (App B) reports real usage/cost to the **API Usage Monitor**
(`usage.jays.services`) and consumes a budget signal back. Companion to the audit
in `docs/reviews/2026-06-30-improvement-audit.md` (§6.9) and the work-split in
`docs/reviews/2026-07-01-audit-work-split.md` (Cross-repo C2).

## Why

The monitor's poll adapters are structurally **blind** to this app's biggest cost
drivers: Anthropic (billing behind the Console), Voyage (no usage API), and
Robinhood (no public retail API). App B already computes real per-call LLM/RAG
cost locally (`recordLlmUsage`, `recordRagUsage`) and knows its market-data /
broker call volume — but none of it left the box. This wires that data out, and
adds a cost-aware feedback loop back in.

## Self-sufficiency (the hard rule)

**App B must run fully standalone if the monitor is down or unconfigured.** The
integration is:

- **Default OFF.** Nothing is pushed and nothing is read unless BOTH
  `USAGE_MONITOR_BASE_URL` and `USAGE_INGEST_TOKEN` are set.
- **Fire-and-forget + never-throws.** The push is queued/debounced and its errors
  are swallowed; `recordLlmUsage` / `recordRagUsage` keep their "never break the
  caller" contract.
- **Fail-open.** The cost-aware loop treats an unreachable/erroring monitor as
  "budget unknown" and does **not** enforce — a monitor outage never blocks a run.
- **Observable, not intrusive.** The only visible effect of a monitor outage is a
  `usage-monitor` row on the admin connections-health page (via `logApiHealth`).

## Configuration (App B env)

| Var | Default | Effect |
|-----|---------|--------|
| `USAGE_MONITOR_BASE_URL` | _(blank)_ | Monitor base URL. Blank → push + budget read disabled. |
| `USAGE_INGEST_TOKEN` | _(blank)_ | Bearer token for `POST /api/ingest/usage` (the monitor's `USAGE_INGEST_TOKEN`). Also used for the budget read unless the monitor sets a separate `USAGE_READ_TOKEN`. Blank → disabled. |
| `USAGE_MONITOR_ENV` | `NODE_ENV` | `environment` label stamped on pushed events (keeps preview vs prod spend separate). |
| `USAGE_MONITOR_FLUSH_MS` | `2000` | Debounce before a batched flush. |
| `USAGE_MONITOR_TIMEOUT_MS` | `8000` | Per-POST timeout. |
| `USAGE_BUDGET_ENFORCE` | `off` | Phase 2 enforcement. Off → over-budget only alerts (Phase 1). On → downgrade model / skip cycle. |
| `USAGE_BUDGET_TTL_MS` | `300000` | Budget-status cache TTL. |
| `USAGE_BUDGET_ALERT_COOLDOWN_MS` | `21600000` | Per-(user, provider, level) alert cooldown. |

## Data flow

```
recordLlmUsage / recordRagUsage ─┐
fetchWithRetry (market-data)     ├─► usage-monitor-push.ts (queue + per-provider
alpaca.trackHealth / robinhood   ─┘   call-volume aggregate; debounced batch flush)
                                        │  POST /api/ingest/usage  (Bearer)
                                        ▼
                              API Usage Monitor → ExternalUsageEvent

runStrategyOnce entry ──► usage-budget.ts ──GET /api/budget-status──► monitor
   (Phase 1) over-budget → notify(budget_alert)
   (Phase 1.5, always on) → audit(usage_budget_status) + Bull prompt advisory line
   (Phase 2, USAGE_BUDGET_ENFORCE) → downgrade model / skip cycle (+ audit(usage_budget_enforced))
```

### What gets pushed

- **LLM** (`recordLlmUsage`): `provider` (openai/anthropic/xai/gemini/mistral/deepseek),
  `service:"llm"`, `label:<context>`, `keyRef`, `unit:"token"`, `quantity:<total
  tokens>`, `costUsd` (from `estimateLlmCostUsd`), `metricType:"cost"|"usage"`,
  `metadata:{model,context,userId,keySource,prompt/completion tokens}`.
- **RAG** (`recordRagUsage`): `provider` (voyage/pinecone), `service:"rag"`,
  `label:<operation>`, `unit:"token"`, `costUsd` (from `estimateRagCost`).
- **Call-volume** (market-data + broker): aggregated per provider per flush window as
  a single `metricType:"usage"`, `unit:"request"`, `requests:<count>` event —
  never one POST per call. Brokers are tagged `provider:"alpaca"|"robinhood"`,
  `service:"broker"`; market-data providers use their `fetchWithRetry` service label
  (finnhub, fmp, yahoo-finance, tradier, …).

The event shape mirrors `@jaywedgeworth22/congress-trading-shared`'s
`UsageTelemetryEventSchema` and the monitor's server parser
(`src/lib/usage-telemetry.ts`).

### Push-primary providers (item 3)

No monitor code change is needed for Anthropic/Voyage/Robinhood to become
"push-primary": items 1–2 simply set `provider` correctly so those events land in
`ExternalUsageEvent`. The monitor keeps its poll adapters for providers where
polling works (openai, alpaca, finnhub, …). The budget endpoint below combines
both channels.

## Budget status (monitor)

`GET /api/budget-status` (token-gated: `USAGE_READ_TOKEN` if set, else
`USAGE_INGEST_TOKEN`) returns, per active provider, month-to-date spend vs
`ProviderPlan.monthlyBudgetUsd`. Spend combines both channels **without
double-counting**:

```
spentUsd = fixedMonthlyCostUsd + max(latestSnapshot.totalCost, pushedMonthToDateUsd)
```

`max()` is deliberate: push-primary providers have no poll snapshot (so
`pushedMonthToDate` dominates), while poll-primary providers keep their snapshot
cost even if App B also pushes some events for them. Budget alerts reuse
`buildProviderAlertState` from `provider-alerts.ts`. Per-provider `status` is
`ok | warning (≥80%) | exceeded (≥100%) | unconfigured (no budget)`.

## Cost-aware feedback loop (item 4)

- **Phase 1 — alerts (on whenever the monitor is configured).** At each scheduled
  run entry, `checkBudgetAndAlert` fires a `budget_alert` notification (through the
  existing `sendNotification` pipe) for any provider at `warning`/`exceeded`,
  throttled per (user, provider, level).
- **Phase 1.5 — advisory (on whenever the monitor is configured, independent of the
  enforce flag) — wired 2026-07-05.** Every run reads budget status once and:
  - stamps a `usage_budget_status` audit receipt with the raw per-provider
    spend/status plus a **preview** of what enforcement would do
    (`previewBudgetDecision` — same decision logic as Phase 2 below, but ungated
    on `USAGE_BUDGET_ENFORCE`, so the owner can see the counterfactual before
    opting in);
  - injects a compact `formatBudgetAdvisory()` line into the Bull `userContent`
    next to `drawdownAdvisory` whenever a provider is at `warning`/`exceeded` —
    explicitly framed as data for the agent ("YOU decide..."), never a command.
- **Phase 2 — enforcement (default-off, `USAGE_BUDGET_ENFORCE`) — wired
  2026-07-05** into `runStrategyOnce` at the existing per-user/day LLM budget
  choke point (after the drawdown breaker + volatility brake, before any LLM
  call). `evaluateBudgetForRun` + `cheaperModel` (given the effective served
  model — resolving `policy.llmModel` through the same default as
  `resolveLlmEndpoint`) downgrade the LLM/red model to a cheaper tier, or skip
  the LLM step when the green model is already cheapest. The safety
  requirements from the original deferral (2026-07-01 Codex PR review) hold:
  - the cycle-skip skips **only the LLM proposal step** — the run still
    completes; broker reconciliation (`reconcilePendingFills`/
    `flagStalePlacingIntents`) and the risk-reducing exits (drawdown breaker,
    volatility brake, protective stops) already ran before this choke point;
  - the downgrade applies to the run's **in-memory** `RunnablePolicy` object
    only, never the object `setPolicy` may persist on a breaker trip — a
    temporary downgrade never becomes permanent;
  - the override is threaded into `debateProposal` via its optional 5th
    `policyOverride` parameter (added alongside this wiring) — the caller in
    `strategy.ts` passes the same in-memory `policy` object explicitly instead
    of letting `debateProposal` re-read `getPolicy(userId)` from the DB, so the
    Bear review picks up the downgraded `redTeamLlmModel` too.

  See `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md` for the full
  change (including the new `test/usage-budget-strategy-integration.test.ts`
  e2e coverage of advisory-only / enforced-downgrade / enforced-skip /
  evaluator-failure-fail-open).

## Migration to the shared client

The push is hand-rolled here rather than importing `createUsageTelemetryClient`
because App B's pinned `@jaywedgeworth22/congress-trading-shared@1.0.0` predates
the `usageTelemetry` export (it landed on the shared repo's
`feat/usage-telemetry-idempotency-key` branch, v1.1.0). The event shape is already
the shared contract. To migrate once shared 1.1.0 is published to GitHub Packages
and App B's pin is bumped:

1. `import { createUsageTelemetryClient } from "@jaywedgeworth22/congress-trading-shared"`.
2. Replace `postBatch()` in `src/lib/usage-monitor-push.ts` with
   `createUsageTelemetryClient({ baseUrl, token }).send(events)` — that also gives
   the deterministic idempotency key for free.

(Note: the monitor's ingest route currently discards `idempotencyKey` — there is no
dedup column on `ExternalUsageEvent` — so idempotency is a no-op server-side today.
The push therefore does not retry, to avoid duplicate rows.)

## Operator setup notes

- For a push-primary provider (Anthropic, Voyage, Robinhood) to appear in
  `/api/budget-status` with a real budget, the monitor must have a **Provider row**
  named to match the pushed `provider` string (case-insensitive) **with a
  `monthlyBudgetUsd`** set. Pushed events for a provider that has no Provider row
  still land in `ExternalUsageEvent` (and show in the dashboard's "External App
  Telemetry" section) but contribute no budget number and drive no enforcement —
  there's nothing to compare against. This is expected: enforcement needs a budget.

## Known follow-ups (from the 2026-07-01 adversarial review)

- **Dashboard parity:** `/api/providers` + `/api/providers/[id]` compute alerts from
  the poll snapshot only, so a push-primary provider shows budget alerts in
  `/api/budget-status` but not on its dashboard card. Merging month-to-date
  `ExternalUsageEvent` cost into those endpoints (as `/api/budget-status` already
  does) would align them. Deferred — it's dashboard-UI scope, explicitly out of C2.
- **Orphaned pushed providers:** a pushed `provider` string with no matching Provider
  row is silently excluded from budget math (fails safe to 0). Consider surfacing
  unmatched providers for operator visibility.

## Verification

- **App B:** `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
  New tests: `test/usage-monitor-push.test.ts`, `test/usage-budget.test.ts`.
- **Monitor:** `npm run lint` (`tsc --noEmit`), `npm run build`.
