# 2026-09-07 - scheduler broker error classification, backoff, and observability

## Summary

Error-classification / backoff / observability fix for three high-volume production error
families identified from the ST container's own `/app/data/litestream-runtime.log`
(2026-08-29..2026-09-07, ~9 days). Scope is explicitly limited to classification, backoff, and
log de-duplication — **no trading-decision logic changed** (what orders get placed, when stops
trigger, or how positions are managed is byte-identical before and after this change).

1. **Tradier order-capability probe (1,364 occurrences)** — `src/lib/tradier.ts`
   `probeOrderCapability`. Fixed a regex gap that mis-sorted Tradier's actual "Unexpected server
   error" wording (and any timeout) into a generic, unthrottled fallback bucket; added a
   `category` field (`capability_ok` / `server_error` / `timeout` / `connectivity` /
   `unclassified`) and an exponential-backoff cache TTL (2m -> 4m -> ... capped at 60m) keyed on
   consecutive same-`(ok, category)` results, so a sustained condition is re-probed far less
   often instead of every 60s tick. The `ok`/`reason` contract returned to callers
   (`checkBrokerHealth`) is unchanged for every input the old code already classified — this is
   strictly fewer probes and fewer log lines, not a different health verdict.
2. **Scheduler broker-timeout family (79 / 78 / 75 occurrences)** — `src/lib/scheduler.ts`.
   - De-duplicated the per-tick "`[scheduler] Skipping account ...`" health-gate warn
     (`logHealthGateSkip` / `clearHealthGateSkip`): logs on the first occurrence of a cause and on
     any change, otherwise stays silent except for a heartbeat every 30 ticks (~30 min). This is
     the direct fix for the 1,364-line volume — the underlying pause/resume/persist/audit
     decisions are unconditional and unchanged.
   - Added lane-failure classification + degraded-subsystem surfacing
     (`classifyLaneFailure` / `recordLaneFailure` / `recordLaneRecovery`) for the synthetic-stop
     monitor and stale-limit-order handling lanes: every failure is still logged and classified
     (`timeout` / `transient_network` / `other`), and a **sustained** streak (3+ consecutive
     same-category failures) escalates to one Sentry `lane_degraded` structured event instead of
     dissolving into per-tick noise, with a matching `lane_recovered` event on the next success.
   - Added a bounded, safe retry-with-backoff for the underlying broker READ calls (see next
     item) — this is the actual mechanism that reduces how often a transient dead-socket error
     reaches these lanes' `withDeadline` timeout in the first place, without retrying (and
     risking duplicating) any order-placing lane itself.
3. **Tradier read-path retry** — `src/lib/tradier.ts` `trackHealth`. Added an opt-in
   `retryTransient` option (default `false`, unlike Alpaca's opt-out default, to stay
   conservative on a mixed read/write gateway): one retry with backoff on a transient
   dead-socket/DNS/reset error (`isTransientNetworkError`), never on a caller abort/timeout.
   Opted in ONLY on GET reads (`getAccounts`, `getPortfolio`, `getEquityPositions`,
   `getOptionPositions`, `getEquityOrders`, `getEquityQuotes`, the GET inside
   `cancelBracketSiblingLegs`) and the side-effect-free preview probe
   (`probeOrderCapability`, `preview: "true"`). Every real order-placing/canceling write
   (`placeEquityOrder`, the bracket POST, `placeOptionOrder`, `cancelEquityOrder`) is
   deliberately left NON-retrying — a retried write after Tradier may have already accepted the
   first attempt risks a genuine duplicate order or a false "rejected" read of the broker's own
   dedupe response (same risk class Alpaca's `trackHealth` already documents for `createOrder`).
4. **`vector-db` Qdrant write path (92 occurrences)** — `src/lib/vector-store/qdrant-write.ts`
   `qdrantRequest` + `src/lib/vector-db.ts` `storeContextsImpl` catch block.
   - Added a bounded (3-attempt) retry with backoff on `qdrantRequest` for a transient network
     failure or a transient Qdrant 5xx — safe because every caller in this module is idempotent
     by construction (deterministic uuid5 point ids for upsert, ns+pc_id-filtered deletes,
     id-scoped payload sets, read-only scroll/collection-info). A caller abort/timeout is never
     retried.
   - Fixed a mislabeling bug: the `storeContexts` failure path hardcoded
     `provider: "pinecone"` in the Sentry/structured-log report regardless of which backend
     actually wrote, so every post-cutover Qdrant write failure was misattributed to Pinecone —
     the same mislabel class already called out in
     `docs/rollouts/2026-08-09-pinecone-lock-mislabel.md` for the local-DB case sitting right next
     to it. Now reports `provider: writeBackend` (the actual backend) plus an `isTransient` flag
     when the underlying cause was a network error the retry above had already exhausted.
   - Stayed strictly on the `vector-db.ts` context-storage write path per the concurrent
     `claude/ingest-error-classification` lane's boundary; did not touch SEC ingest or
     query-embed code.

**Codex/Sentry round-1 review (fixed in this same PR before merge):**

5. **Race condition let a late background success clear a just-recorded failure (P0-adjacent,
   flagged independently by both `sentry` and `chatgpt-codex-connector`)** — `src/lib/scheduler.ts`.
   `recordLaneRecovery` was attached to the RAW `staleExitWork`/`stopMonitorWork` promise, not the
   `withDeadline`-raced one. A lane that timed out (recording a failure) but later fulfilled in
   the background would silently clear that same failure streak the moment it finished — so a
   lane that always times out but always eventually succeeds could never reach `lane_degraded`.
   Both lanes now attach recovery/failure to the SAME deadline-raced promise; the in-flight-guard
   release stays on the raw promise (unchanged, intentional).
6. **Degraded state lost on a failure-category change (P2)** — `recordLaneFailure`'s
   `alreadyDegraded` check required `prev.category === category`, so a category flip (e.g.
   `timeout` → `transient_network`) while already degraded silently reset `degraded` to `false`
   even though nothing had recovered — suppressing the eventual `lane_recovered` event. Now
   preserved across category changes; only `recordLaneRecovery` (an actual success) clears it.
7. **Tradier probe backoff applied to successes too (P2)** — a long healthy streak could ride the
   exponential backoff TTL up to the 60-minute ceiling, so a real regression after that point
   could go undetected for up to an hour instead of the intended 2-minute base window. Successful
   probes now always use the base TTL; only a failing streak backs off.
8. **Health-gate skip dedup misread the one-tick halt transition (P2)** — `pauseResult.action ===
   "halted"` fires only the ONE tick a halt actually happens; a still-halted account reports
   `"still_paused"` on every later tick. Using that check directly made the halt flag flip
   true/false every tick after the first, which `logHealthGateSkip` read as a state change —
   resetting its dedup counter and re-emitting `account_skip_started` every tick, the exact noise
   this was built to remove. New `isHaltedPauseAction` helper treats `"halted"` and auto-owned
   `"still_paused"` as currently auto-halted (round-3 tightened this so a manual owner
   `still_paused` is not labeled auto-halted).
9. **`cancelBracketSiblingLegs`'s GET not actually opted into the documented retry (P2)** — the
   original summary above (item 3) claimed this idempotent lookup was opted into
   `retryTransient`, but the actual `trackHealth` call site omitted the option. A dead keep-alive
   socket would consume one of the pending teardown row's ten attempts and defer to another
   scheduler tick instead of retrying in-process. Now actually passes `{ retryTransient: true }`.
10. **Verification record listed commands with no actual results, and omitted `npm run lint`
    entirely (P1)** — see the rewritten Verification section below.

**Codex round-3 review (fixer tip, 2026-09-08 GROK, same PR, do not merge from this lane):**

11. **Manual owner pause labeled auto-halted (P2, thread `PRRT_kwDOS7mOVM6gD05C`)** —
    `applyBrokerOrderPlacementPause` returns `still_paused` both for an auto-halt we own
    (marker present) and for a manual owner halt (no marker, deliberately not claimed). Round-2
    `isHaltedPauseAction` treated every `still_paused` as halted, so `logHealthGateSkip` emitted
    `(auto-halted)` and `halted: true` on an owner-controlled pause. `still_paused` now carries
    `autoOwned`; the helper is true only for `"halted"` or `still_paused && autoOwned`. Dedup
    stays stable because the flag no longer flips for either kind of pause.
12. **Verification record still did not run the full AGENTS.md sequence (P1, thread
    `PRRT_kwDOS7mOVM6gD05D`)** — round-2 recorded targeted vitest and listed tsc before lint.
    Round-3 runs lint then tsc then whole-repo test then build and records the actual results
    below. Do not treat this change as complete if any of those four is unfinished.

## Decisions & Trade-offs (round-3)

- Distinguished ownership with `autoOwned: boolean` on the existing `still_paused` action
  rather than a new `still_manually_paused` action. The scheduler already keys persistence
  and journal transitions on `"halted"` vs `"still_paused"`; adding a third action would
  require every `=== "still_paused"` site to learn the sibling. Ownership is the actual
  distinction `broker-health.ts` already encoded via marker presence.
- `isHaltedPauseAction` now takes the full `ApplyBrokerPauseResult`, not the action string,
  so it can read `autoOwned`. The helper remains the single source for the
  `logHealthGateSkip(..., halted)` flag.
- Did not change trading-decision logic, auto-resume, or `shouldPersistBrokerHealthSkip`
  (still persists only on the `"halted"` transition).
- Did not merge. Extra-ship no.

## Why

Production evidence from the ST container's `litestream-runtime.log` (2026-08-29..2026-09-07):
1,364 "Tradier order capability probe failed" lines, 79/78/75 scheduler broker-timeout lines
(`runSyntheticStopMonitor timeout`, `[cause]: SocketError: other side closed`,
`stale-limit-scan broker timeout`), and 92 "[vector-db] Error storing contexts: TypeError: fetch
failed" lines. None of these represented a NEW failure mode each time — a single restricted or
otherwise misbehaving account/connection kept re-triggering the SAME condition every 60s
scheduler tick (or on every Qdrant write attempt), and the code re-logged / re-probed / re-warned
identically every time. The fix is entirely about not re-deriving and re-announcing an unchanged
state: classify once, cache/back off while the state holds, and emit one actionable event when it
changes (or when a streak proves it is sustained) rather than every tick.

## Complementary to PR #3174 (not duplicated)

PR #3174 ("hung scheduler-tick watchdog with honest Sentry check-ins", commit `4c75472cb`) added
a **whole-tick** 15s watchdog (2-minute budget, generation token) that renews the leader lease
while a tick is in-budget, unwedges a hung tick past budget, and made Sentry Crons check-ins
honest (`in_progress` -> `ok`/`error` only when the tick body actually finishes). It also added
`withDeadline` around the material-event drain and `checkBrokerHealth`, and stopped awaiting
strategy runs on the tick critical path.

This change operates one layer down, inside the individual lanes and broker calls that #3174's
watchdog supervises from the outside:
- #3174 answers "is the WHOLE TICK still alive?" — this change answers "is THIS PARTICULAR
  broker call/probe/lane healthy, and has it been unhealthy long enough to matter?"
- #3174 does not touch `probeOrderCapability`'s classification, the per-account health-gate skip
  log, the stop-monitor/stale-exit lane failure logging, or Tradier's/Qdrant's own retry
  behavior — all genuinely untouched surface, confirmed by reading the PR #3174 diff before
  starting this work.
- Neither change alters `SCHEDULER_BROKER_TIMEOUT_MS`, `SCHEDULER_HEALTH_PROBE_TIMEOUT_MS`, or
  the watchdog's own budget/polling constants.

## Files

- `src/lib/tradier.ts` — probe classification + backoff cache; `trackHealth` `retryTransient`
  option; opted-in read call sites.
- `src/lib/scheduler.ts` — `logHealthGateSkip` / `clearHealthGateSkip` de-dup; `classifyLaneFailure`
  / `recordLaneFailure` / `recordLaneRecovery` degraded-lane surfacing; wired into the health gate
  and the stale-exit / synthetic-stop-monitor lanes.
- `src/lib/vector-store/qdrant-write.ts` — bounded retry with backoff in `qdrantRequest`.
- `src/lib/vector-db.ts` — `storeContextsImpl` catch block reports the real `writeBackend`
  instead of a hardcoded `"pinecone"`, plus an `isTransient` flag.
- `test/tradier.test.ts` — probe classification, exponential backoff, backoff-reset-on-recovery,
  read-retry-succeeds, write-never-retries.
- `test/scheduler-lane-observability.test.ts` (new) — health-gate skip dedup/heartbeat/recovery,
  lane-failure classification, degraded/recovered escalation.
- `test/qdrant-write.test.ts` — `qdrantRequest` retry on transient network failure and on a
  transient 5xx, gives up after exhausting attempts, never retries an abort/timeout or a
  non-retryable 4xx.
- `test/vector-db-qdrant-retrieval.test.ts` — `storeContexts` labels a sustained Qdrant write
  failure `provider: "qdrant"`, not the old hardcoded `"pinecone"`.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `PLAN.md`, this
  rollout note — handoff records.
- Round-2: `src/lib/scheduler.ts` (`isHaltedPauseAction`; the withDeadline-recovery rewiring; the
  degraded-state-preservation fix), `src/lib/tradier.ts` (success-TTL fix;
  `cancelBracketSiblingLegs` `retryTransient: true`), `test/scheduler-lane-observability.test.ts`
  and `test/tradier.test.ts` (new regression tests for all five round-2 code fixes).
- Round-3 (2026-09-08 GROK fixer): `src/lib/broker-health.ts` (`still_paused.autoOwned`),
  `src/lib/scheduler.ts` (`isHaltedPauseAction` takes the full result and requires auto-ownership),
  `test/scheduler-lane-observability.test.ts`, `test/broker-health-auto-pause.test.ts`,
  `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, this
  rollout.

## Verification

Round-3 (2026-09-08 GROK fixer), AGENTS.md order: lint then tsc then test then build. Results
filled after each command actually finishes — this section is incomplete until all four have
an exit code recorded.

- `npm run lint` — pending.
- `npx tsc --noEmit` — pending.
- `npm test` (whole-repo vitest) — pending. Targeted pre-check: `test/scheduler-lane-observability.test.ts`
  + `test/broker-health-auto-pause.test.ts` — 21 passed / 0 failed in 22.50s.
- `npm run build` — pending.

Round-2 (prior session) recorded targeted vitest (125 tests) plus tsc/lint/build after merging
`origin/main`. That record listed tsc before lint and did not complete whole-repo `npm test`;
Codex P1 (`PRRT_kwDOS7mOVM6gD05D`) correctly refused to treat that as the handoff gate.

## Follow-ups

- The Tradier probe still has no way to positively distinguish a genuinely PERMANENT
  broker-side account restriction (e.g. a confirmed close-only/disabled account) from a
  transient condition that has simply been failing for a long time — this fix backs off the
  re-probe interval on a sustained streak (up to 60 minutes) rather than caching forever, so a
  truly permanent condition still gets re-verified hourly instead of never. If Tradier ever
  returns an unambiguous "account restricted" signal, `probeOrderCapability` should classify it
  into its own permanent category with a much longer (or infinite, operator-clearable) TTL.
- Did not touch the `pending-fill-reconcile` lane's error log (`src/lib/scheduler.ts`) — it was
  not one of the three named high-volume families in the production evidence, so it was left
  out of scope to keep this diff tight.
- Left the actual retry semantics for Tradier ORDER-PLACING writes untouched by design (see
  Summary #3) — adding idempotency-safe retry there would need a broker-side idempotency key or
  a client-side dedup check first, which is trade-decision-adjacent enough that it needs owner
  review rather than a leaf-worker call.

## Blockers

- None for the tip-fix. Scope stayed inside classification/backoff/observability; no
  trading-decision logic was touched. Deployer squash auto-merge stays armed; this lane does
  not merge. Extra-ship no.

## Next Steps

- Push the tip to `claude/scheduler-broker-error-classification`.
- Resolve Codex threads `PRRT_kwDOS7mOVM6gD05C` (P2) and `PRRT_kwDOS7mOVM6gD05D` (P1) after the
  four verify commands have real results on the tip.
- Do not merge from this lane.
