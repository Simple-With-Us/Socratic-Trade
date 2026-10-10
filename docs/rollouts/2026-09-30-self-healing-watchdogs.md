# 2026-09-30 - Self-healing watchdogs (liveness, OOM, run-failure)

> Re-arm correction (2026-10-06): the halt-time `lastHaltStreak` floor re-halted an account when a run that had already started failed after re-arm.  The window is now `rearmedAt`.  See `docs/rollouts/2026-10-06-rearm-failure-streak.md`.

## Context & Objective

On 2026-09-30 ~10:33-10:44 AM CT, every route on socratictrade.com returned
Traefik 503 "no available server" for 11 minutes. The app process was alive
(Litestream replicating, logs flowing), the Docker HEALTHCHECK was green, and
Coolify reported "running:healthy". A manual Coolify restart at 10:43 recovered
it. Post-restart, `/api/health` showed `tradingLivenessDegraded=true` with
`maxConsecutiveFailedRuns=4` and no completed strategy run in ~4.9 days — the
scheduler was ticking but every run failed, and nothing escalated.

Jay's directive: the trading system must identify and handle failures
automatically and promptly. No more incidents sitting unhandled until a human
notices. Guardrails: no changes to strategy, signal logic, order placement,
position sizing, or risk limits; no touching live positions or money movement.
Self-healing only: restarts, health checks, watchdogs, backoff, alerting.

Root causes found:
1. **No actor on the health signal.** The Docker HEALTHCHECK marks the
   container unhealthy but nothing restarts it (Docker never restarts on health
   status; Coolify has `health_check_enabled=false`). The event-loop stall
   mechanism is documented in `src/lib/stall-profiler.ts`: the loop pins
   40-140s during RTH, wedging the server while the process stays alive.
2. **Watchdog abort cannot reach run work.** The tick's AbortSignal is never
   passed to `runScheduledStrategyAndMaybeTune`, and the
   `managed-vector-reconcile` lane fires `reconcileManagedVectorRecords`
   without any signal. The chain reaches `qdrantInventoryByMetadata`, whose
   scroll loop honors AbortSignal — but receives `undefined`. When the 120s
   tick watchdog fires, the orphaned scroll keeps paging ~250k records into
   memory until the kernel OOM-kills the process (the 2026-09-25 restart-loop
   mechanism; the `finch/oom-watchdog-fix` branch no longer exists on remote).
3. **Silent run-failure streaks.** `tradingLivenessDegraded` was exposed on
   `/api/health` but had no consumer (UptimeRobot is retired). Consecutive
   failures accumulated with no backoff, no escalation, no auto-halt.
4. **No memory watchdog.** Confirmed: no in-process RSS/memory watchdog
   existed; unclean exits (SIGKILL/OOM) were undifferentiated in the boot
   ledger with no RSS-at-death.

## Changes Made

**1. Liveness watchdog actor — `scripts/coolify-prod-start.sh`**
A background subshell (outside Node, so a pinned event loop cannot wedge it)
probes `GET /api/live` with the Docker HEALTHCHECK's curl flags. After
`LIVENESS_WATCHDOG_FAILURES` (default 5) consecutive failures it logs loudly,
writes a receipt to `/app/data/liveness-watchdog.log`, and SIGTERMs the app
process (20s grace, then SIGKILL) so Docker restarts the container. Failures
are not counted until the first successful probe or
`LIVENESS_WATCHDOG_BOOT_GRACE_S` (default 600s); one success resets the count
(rides out 40-140s stalls); probes are sequential (no pile-up); kill switch
`LIVENESS_WATCHDOG=0`. Functionally tested with stubbed curl (3 behavior
tests passed).

**2. Watchdog-kill attribution — `src/lib/boot-ledger.ts`, `instrumentation.ts`**
`readRecentWatchdogKill()` reads the last liveness-watchdog receipt (within
1h, else null, never throws); logged after `recordBoot()` as
`[boot-ledger] previous container killed by liveness watchdog: ...`.

**3. Staleness paging — `src/lib/db-health.ts`, `app/api/health/route.ts`**
`alertLivenessWarning` now captures a Sentry **error**-level message (the
level PagerDuty routes on) with stable fingerprint
`["api-health","trading-liveness"]`, service tag `trading-liveness`, and
`failureClass` `persistent-degradation`/`escalated-persistent`. Episode start
tracked in `livenessDegradedSince:<type>`; escalates after
`ST_LIVENESS_ESCALATION_HOURS` (default 4) with an `ESCALATED Liveness: ...`
title/body, re-escalating at most once per window. New
`clearLivenessWarning(type)` resets the episode on recovery. Wired into the
`/api/health` healthy branches for `scheduler_stale` and
`trading_liveness_degraded`.

**4. RSS watchdog — `src/lib/rss-watchdog.ts` (new), `instrumentation.ts`**
`resolveRssWatchdogConfig` (enabled when `ST_RSS_WATCHDOG` != "0" and
`NODE_ENV=production`; `ST_RSS_LIMIT_MB` default 8192; interval default 30s,
min 5s; `ST_RSS_WATCHDOG_SAMPLES` default 3) and pure `evaluateRssSample`.
`startRssWatchdog` runs an unref'd interval; on the first breach it logs a
loud warning; after sustained breaches it exits with code 44 (documented in
the entrypoint exit-code contract; Docker `unless-stopped` restarts any
spontaneous exit). Never throws. Wired into `instrumentation.ts` after the
stall-profiler block.

**5. RSS-at-death — `src/lib/boot-ledger.ts`**
`rssBytes` added to `ExitReceiptDetail` and `ExitEntry`; `noteExitReceipt`
captures `process.memoryUsage().rss` at receipt time (best-effort); the exit
handler persists it. Addresses the "no RSS-at-death" gap for receipted exits.

**6. Consecutive-run-failure watchdog — `src/lib/run-failure-watchdog.ts` (new), `src/lib/scheduler.ts`**
Durable state in the `settings` table (`runFailureWatch:<userId>:<accountId>`;
halt marker `runFailureHaltMarker:<userId>:<accountId>`). Thresholds:
`ST_RUN_FAILURE_ALERT_AFTER` (3), `ST_RUN_FAILURE_BACKOFF_AFTER` (5),
`ST_RUN_FAILURE_HALT_AFTER` (10), `ST_RUN_FAILURE_BACKOFF_BASE_MIN` (15),
`ST_RUN_FAILURE_BACKOFF_CAP_MIN` (240). `runFailureWatchdogTick` runs as a
scheduler lane: builds streaks from `getTradingLivenessSummary`; streak==0
clears state (recovery); streak crossing the alert threshold pages via
`alertLivenessWarning` (reuses the 15-min cooldown + Sentry error paging + 4h
escalation); at the backoff threshold due runs are suppressed with
exponential backoff (base*2^(streak-backoffAfter), capped, extend-only);
at the halt threshold the account is auto-halted via `setPolicy` with a
durable marker (`autoResume:false`, `audit("run_failure_auto_halted")`).
**Never restarts the process** — the boot autonomy interlock would halt the
fleet. Owner re-arm is honored: if the account is active again with a marker
present, the marker clears and a fresh episode starts; re-halt requires NEW
failures beyond the halt-time streak (mirrors the broker-health auto-pause
re-arm rule). The scheduler's due-run loop now consults
`isRunBackedOff(userId, accountId)` and skips backed-off accounts (rolling
back cadence state, same pattern as monthly-ceiling suppression).
App-stall and mid-run-restart failures stay on the alert and backoff streak
and are omitted from auto-halt (`consecutiveHaltEligibleFailures`).  Broker
HTTP and LLM failures still count toward `ST_RUN_FAILURE_HALT_AFTER`.
`isRunBackedOff` is false once `backoffUntil` passes (cap
`ST_RUN_FAILURE_BACKOFF_CAP_MIN`, default 240m), so a pure-stall episode
retries instead of writing a halt marker.  Rollout:
`docs/rollouts/2026-10-05-stall-failures-exempt-halt-streak.md` (PR #4210).

**7. Halt-cause honesty — `src/lib/autonomy-halt-cause.ts`**
New `run_failure_halt` kind; `describeAutonomyHaltCause` surfaces the watchdog
marker so the console explains why the account is halted.

**8. Abort-signal threading (OOM fix) — `src/lib/scheduler.ts`**
`reconcileManagedVectorRecordsIfDue(now, signal?)` accepts and forwards the
tick's AbortSignal; the `managed-vector-reconcile` lane passes it. Verified
the full chain reaches the scroll loop's `throwIfAborted()` seams — a
watchdog unwedge now kills the orphaned Qdrant scroll instead of letting it
OOM (the 2026-09-25 mechanism). One bad edit during implementation
accidentally deleted the broker-marker check lines in `autonomy-halt-cause.ts`;
detected and restored.

## Decisions & Trade-offs

- The liveness watchdog lives in the entrypoint shell script, NOT in Node:
  a pinned event loop (the 40-140s RTH stall) would wedge an in-process
  prober too. The Docker HEALTHCHECK has the same placement problem — it
  reports but cannot act.
- The run-failure watchdog never restarts the process: `reconcileAutonomyOnBoot`
  reverts every "active" account to "halted" on restart (unless
  `AUTONOMY_RESUME_ON_BOOT=1`), so a restart-based self-heal would halt the
  fleet to fix one account. Halt-the-account is the safe direction.
- Degraded trading liveness is still never mapped to a 503 (per the
  `trading-liveness.ts` design note): the paging path is Sentry error-level
  -> PagerDuty instead.
- Scan-limit throw -> warning+partial was deliberately NOT changed
  (`qdrant-write.ts:531`, `vector-db.ts:5317`): the 50k/250k ceilings are
  protections, not the bug; changing them alters data-completeness semantics.
  The abort-signal threading fixes the actual OOM mechanism.
- The `web-source-refresh` lane was not re-threaded: it carries its own
  lease-guard signal, not the tick's; deeper surgery, noted as a gap.
- The degraded flag likely has no external consumer (UptimeRobot retired);
  the Sentry error-level paging is now the escalation path.

## Verification State

- `npx tsc --noEmit`: clean.
- `npx eslint` on changed files: 0 errors (3 pre-existing warnings in
  `scheduler.ts`: unused imports, not from this change).
- `npm test`: full suite — see below for result.
- `npm run build`: see below for result.
- New tests: `test/rss-watchdog.test.ts` (9), `test/run-failure-watchdog.test.ts`
  (10), `test/liveness-warning-escalation.test.ts` (8),
  4 new `readRecentWatchdogKill` tests in `test/boot-ledger.test.ts`.
- Liveness watchdog shell function: 3 behavior tests with stubbed curl passed;
  `bash -n` clean; ASCII-only verified (Apple bash 3.2 rule).

## Next Steps & Blockers

- **External public-URL watchdog: BLOCKED.** Built
  `~/workspace/socratic-trade-watchdog/bin/public-liveness-watch.sh` (probe
  public `/api/live`, 5 consecutive failures -> Coolify API restart, 30-min
  cooldown, control probe, kill switch). But from this VM every path on
  socratictrade.com returns **Cloudflare 403 "Your request was blocked"**
  (even with a browser UA) — Cloudflare blocks the VM's egress IP at the
  edge, so the monitor cannot distinguish healthy from down and would
  false-positive restart production. Tailscale-direct and egress-proxy paths
  are also blocked. Left DISABLED with a README. To activate: allowlist the
  VM's egress IP in Cloudflare, run from an unblocked network, or use a
  third-party uptime service.
- **Coolify-side complementary step** (manual, owner): enable the Coolify
  health check with a restart action as a second layer. Not settable from the repo.
- The RTH weekday latch (Mon-Fri 09:30-16:00 ET) means a merge now queues the
  deploy until after close; the PR can still auto-merge.

## Zero-Code Findings

- Coolify app record `updated_at` was 2026-09-30T15:33:31Z — exactly the
  incident start. Significance undetermined (may be a deploy, config sync, or
  Coolify touching the record during the incident).
- Whether the ~5-day no-completed-run window was failures vs never-due could
  not be determined from the data available.
- Prod `enabledEvents` notification state and whether any alert channel is
  configured for the admin fanout could not be determined.
