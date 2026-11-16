# Safety-lane deadline attribution: broker latency vs a pinned event loop

**Date:** 2026-09-09
**Seat:** CLAUDE
**Branch:** `claude/broker-timeout-safety-monitors`
**Scope:** observability only on the two protective scheduler lanes.  No safety monitor was weakened.

## The reported defect

Two scheduler safety monitors were timing out repeatedly against the broker, and still are:

- `[scheduler] synthetic-stop monitor error: Error: runSyntheticStopMonitor timeout` — 71 occurrences
- `[scheduler] stale-limit-order handling error: Error: stale-limit-scan broker timeout` — 66 occurrences

Window 2026-09-07T07:04 through 2026-09-09T14:17, still firing at investigation time (latest observed
`2026-09-09T14:41:56.548Z`).  These are the stop-loss monitoring and stale-limit-order cleanup paths on
live trading accounts.

## Root cause: event-loop starvation, not broker latency

The message is wrong about its own cause.  The deadline is a wall-clock race, so it fires whenever the
process cannot run a callback in time — regardless of whether a broker was involved at all.

Evidence, from `task_journal` on container `d83b1aykr03uwr32yhgzaiay` (production, read-only):

1. **Time is spent outside all broker I/O.**  `stale-limit-scan` at `2026-09-08T19:51:57.566Z` ran for
   **185,633 ms** carrying the inner error `Timed out waiting for alpaca.getOrders after 16000+8000ms.`
   The broker call self-terminated at 24,000 ms, so **161,633 ms of that lane elapsed with no broker call
   outstanding at all.**  No network explanation reaches that number.

2. **The monitor succeeded — late.**  `synthetic-stop-monitor` at `2026-09-09T13:45:41.103Z` ran for
   **196,840 ms** and finished `ok`, summary `evaluated=6 triggered=0 exited=0`.  The pass completed; the
   deadline had already logged it as a broker timeout 182 seconds earlier.

3. **Passes with nothing to do were still slow.**  Runs summarising `evaluated=0` took 30,000–134,000 ms.
   Such a pass makes two bounded reads whose transport ceiling is 30 s each.  It cannot spend 134 s on the
   network.

4. **The two lanes move together.**  They are independent — different endpoints, different call counts —
   yet their slow runs start within 2–3 ms of each other and match durations to ~100 ms across 130-second
   runs (e.g. `14:41:21.542`/`14:41:21.540` at 40,885/40,884 ms; `14:06:46` at 134,038/134,122 ms).  That is
   one shared process-wide stall, not two coincident broker slowdowns.

5. **Normal is fast; only the tail is broken.**  Over the last 4,000 runs of each lane: p50 ≈ 800 ms,
   p95 ≈ 1.4 s, and only 0.5–0.8 % exceed the 15 s deadline.  The deadline is generous for the actual work.
   The failures are a bimodal tail reaching 196 s, well past the 30 s broker I/O ceiling.

### Attribution to the FTS mirror loop (PR #3202)

The per-day damage to these lanes tracks the event-loop pinning curve measured by the event-loop lane, and
does **not** track ingest volume:

| day | worst safety-lane run | total ms over the 15 s deadline | ingest-lane runs |
|---|---|---|---|
| 2026-09-05 | 25,114 ms | 126,118 | 1,561 |
| 2026-09-06 | 19,783 ms | 99,579 | 1,550 |
| 2026-09-07 | 25,088 ms | 120,110 | 1,501 |
| **2026-09-08** | **185,633 ms** | **3,430,064** | 2,011 |
| **2026-09-09** | **218,434 ms** | **3,823,250** | 1,795 |

Total time over deadline rose **28.6x** from 09-07 to 09-08, and the tail rose **7.4x**, on the exact day the
event-loop lane measured pinning jump from 239 s/day to 1,317,546 ms/day across 198 slices.  Ingest run
counts did not rise correspondingly, and slow ingest runs actually fell (78 → 63) — so this is the same
ingest work becoming far more blocking, which is the signature of the non-convergent FTS mirror loop at
`src/lib/rag/mirror-fts-bounded.ts:35` and `src/lib/rag/sec-ingest-worker.ts:480`.

**The root cause therefore belongs to PR #3202, not to this lane.**  This branch ships no competing fix.

### The SQLite lock-contention hypothesis is refuted

Tested and rejected independently here before it was withdrawn upstream.  Correlating 240 timeout events
against 355 `database is locked` events over the same span: only 14.2 % of timeouts had a lock event within
15 s, and at a 300 s window the observed co-occurrence (28.3 %) was **below** chance (36.0 %).  Median gap
was 1,184 s.  Lock contention is not the driver.

## What this change does

The remaining genuine gap is that `withDeadline` cannot distinguish *"the broker did not answer"* from
*"we could not process the answer"*.  That gap is what sent PR #3189 after Tradier GET retries which could
not help — retrying into a blocked loop cannot succeed, and indeed 57 of 71 synthetic-stop and 53 of 66
stale-limit occurrences landed **after** #3189 merged, with the daily rate rising rather than falling.

- **`src/lib/event-loop-lag.ts` (new).**  A sampler that records how late its own 500 ms interval runs, and
  `stalledMsSince(t)` to total the stall inside a window.  One `unref`'d timer and a bounded ring buffer.
  Includes an in-progress term, because a blocked loop defers both the sampler and the deadline's own
  `setTimeout` and they resume in arbitrary order — without it we would miss the very stalls we exist to catch.
- **`withLaneDeadline` in `src/lib/safety-maintenance.ts`.**  Wraps `withDeadline` and, on expiry, attaches
  `elapsedMs` / `stalledMs` / `stallRatio` and says in the message which cause it was.  It also announces a
  **late completion**, so an operator can tell that a protective pass actually ran.
- **`classifyLaneFailure` in `src/lib/scheduler.ts`.**  New `event_loop_stall` category, checked before the
  timeout matchers since an attributed expiry still contains the word "timeout".

## Safety statement

**No safety monitor was weakened.**  Specifically:

- The deadline value is **unchanged** at `SCHEDULER_BROKER_TIMEOUT_MS` = 15,000 ms.
- No monitoring interval was lengthened and no lane was made less frequent.
- No `AbortController` is passed, so the protective work is still never cancelled — exactly as before.
- The expiry still rejects, so a lane failure is still recorded and still escalates to `lane_degraded` on a
  streak.  Nothing is silenced.
- Re-attribution requires at least **75 %** of the window to be measured stall, so a real broker outage is
  never explained away as a stall.  Below that bar the classification stays `timeout`.
- Streak accounting keys on the deadline FAMILY, so a lane whose stall ratio oscillates across the threshold
  still escalates `lane_degraded` — it cannot flip categories forever and silently stop alerting.

The change is strictly additive to what an operator learns.  It also closes a safety-relevant blind spot:
previously a `runSyntheticStopMonitor timeout` gave no way to tell whether stops had in fact been monitored,
when in the measured cases they had been.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` on all changed files — 0 errors (2 pre-existing unused-import warnings in `scheduler.ts`).
- `npx vitest run test/lane-deadline-stall-attribution.test.ts` — 11/11 pass.
- Regression: `scheduler-lane-observability`, `scheduler-stale-exit-inflight-guard`, `deep-safety-fixes`,
  `p0-safety-fixes`, `scheduler-cadence` — 50/50 pass.

## Decisions & trade-offs

- **Attribution, not remediation.**  The blocking work lives in the RAG ingest path owned by PR #3202.
  Fixing it here would race that lane and duplicate it.
- **Threshold 75 %, raised from an initial 25 % after review (Codex P2).**  A stall ratio does not prove the
  broker was healthy: a request pending the whole 15 s window alongside an unrelated 4 s stall clears a 25 %
  bar and would have been labelled a stall exclusively, hiding a real broker outage.  At 75 % the broker is
  left under a quarter of the window, far too little to be the explanation by itself.  The category is only
  ever a summary — `elapsedMs` / `stalledMs` / `stallRatio` ride on every expiry and on the `lane_degraded`
  Sentry event either way, so neither cause can hide the other.
- **Rejected: raising the deadline.**  It would have hidden the signal without monitoring anything sooner,
  and the measurement shows 15 s is generous for the real work (p95 ≈ 1.4 s).
- **Rejected: removing the in-flight guard** so a stuck pass cannot block the next one.  That would allow
  concurrent monitor passes on the money path — a real safety regression to buy a log improvement.

## Review round 1 (chatgpt-codex-connector, 2026-09-09)

Three findings, all real, all fixed in one batch:

- **P1 — degraded streak lost across categories.**  `recordLaneFailure` reset `streak` to 1 whenever the
  category changed, so a lane whose stall ratio hovered around the threshold alternated `event_loop_stall` /
  `timeout` and could fail indefinitely without ever reaching `LANE_DEGRADED_STREAK_THRESHOLD` — strictly
  worse than before the category existed.  Streak continuity now keys on a `laneStreakFamily`, which treats
  both deadline expiries as one condition while keeping unrelated categories separate.
- **P2 — the stale-exit late log claimed too much.**  In `runSafetyMaintenance` the wrapped promise is only
  `getEquityOrders`; `notifyStaleLimitOrders` and `autoRemediateStaleExitOrders` hang off the rejected
  wrapper and are skipped for that tick.  Announcing a completed protective pass there was misleading on a
  safety path.  `withLaneDeadline` now takes `wraps: "pass" | "call"`, and the `"call"` wording states
  explicitly that the dependent remediation was already skipped and the next tick retries it.
- **P2 — broker and stall were not distinguishable.**  Threshold raised 0.25 → 0.75 and the stall metrics
  now ride on the `lane_degraded` Sentry event, so both causes stay visible regardless of the category.

Verification after the batch: `tsc --noEmit` clean; 68/68 across the six related test files (including the
peer lane's `fts-mirror-convergence`), with new regressions for each finding.
