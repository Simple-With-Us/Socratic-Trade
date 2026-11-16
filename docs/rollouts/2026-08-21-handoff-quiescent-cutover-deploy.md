# 2026-08-21 — HANDOFF: replace the daytime deploy ban with a quiescent-cutover swap

**Status: design handoff, NOT implemented.**  Written by MONET at the owner's request after
diagnosing the RTH latch.  No code changed.

## What the owner asked for, in their words

> "stop the daytime ban on updating the app and just make it so that the container continues
> running while new build is made and then when a strategy run or embed isn't happening so pause
> everything and then jump from old container to new one or something like that"

Restated as requirements:

1. **Remove the RTH build ban.**  Merging at 10:00 AM Central should produce an image.
2. **Old container keeps serving while the new image builds.**
3. **Cut over only at a quiescent moment** — no strategy run in flight, no embed/ingest in flight.
4. Quiesce first ("pause everything"), then swap.

Requirements 1, 3 and 4 are real work.  **Requirement 2 already happens** — see below.

## Read this first: the constraint that shapes the whole design

**The app is a single-writer SQLite process.**  `DB_PATH="$DATA_DIR/app.db"`
(`scripts/coolify-prod-start.sh:41`) on a persistent volume, with litestream replicating it.

**Two containers cannot run against that database at the same time.**  So the literal
blue-green reading of "jump from old container to new one" — both alive, then flip traffic — is
**not achievable** without changing the data layer.  Do not design toward it.  Do not "solve" it
by pointing the new container at a copy; two writers plus litestream is how you corrupt a
real-money ledger.

What IS achievable, and is almost certainly what the owner actually wants:

> **A brief, deliberate restart taken at a moment when nothing is mid-flight**, instead of a
> restart that can land in the middle of a strategy run or an order placement.

The difference that matters is not seconds of downtime.  It is **never cutting a run in half**.
Say this back to the owner before building, because "zero downtime" and "never mid-run" are
different promises and only the second one is on the table today.

If the owner does want true zero-downtime later, that is a separate and much larger project
(moving off a single-file embedded DB, or a read-replica + failover design).  Scope it separately.

## What is already true, so you do not rebuild it

- **The build does not stop the old container.**  Coolify builds the image first and only then
  swaps.  The current pain is not "the old container dies during the build" — it is that the
  build itself is *refused* during market hours, so there is nothing to swap to.
- **The RTH refusal is a BUILD-time failure**, not a swap-time one:
  `scripts/assert-rth-deploy-latch.ts` runs at `Dockerfile:53` and exits **2** with
  `RTH deploy latch: block (rth-blocked)`.  Coolify records a failed deployment and keeps the last
  healthy container.  The decision logic is `src/lib/rth-deploy-latch.ts`.
- **SIGTERM already reaches the app and already produces clean exit codes.**
  `scripts/coolify-prod-start.sh:140-141` traps TERM/INT and forwards to the app PID;
  `src/lib/exit-guard.ts:29-31` maps SIGTERM→143 and SIGINT→130.
  **You are adding a drain to an existing graceful path, not building shutdown from scratch.**
- **An in-flight predicate already exists**: `hasInFlightStrategyWork()`
  (`src/lib/db-execution.ts:337`) — checks `strategy_runs.status='running'` and
  `strategy_run_requests.status IN ('queued','running')`.  **Read the warning about it below.**
- **The evening retry already exists**: `scripts/rth-deploy-drain.sh` +
  `.github/workflows/rth-deploy-latch.yml`.  Decide deliberately whether to keep, repurpose or
  retire it — do not leave it firing at a latch that no longer exists.

## The shape of the change

**Move the gate from build time to stop time.**

1. **Stop failing the build during RTH.**  Either delete the `RUN tsx scripts/assert-rth-deploy-latch.ts`
   step or convert it to advisory (log the decision, always exit 0).  Keep the *image-noop* check
   (exit 3) if it still earns its keep — that one saves ~30 minutes on docs-only merges and is
   unrelated to market hours.
2. **Add a process-level drain on SIGTERM.**  On signal: set a module-level "no new work" flag,
   let in-flight work finish, then exit 143.  Concretely the flag must make the scheduler tick
   refuse to *start* a new strategy run, and make the background RAG/ROIC/FTS lanes refuse to
   start new batches.
3. **Bound the wait.**  Pick a cap and decide explicitly what happens when it expires — see the
   money-path question below.  Do not wait forever.
4. **Give Docker a matching grace period.**  Coolify sends SIGTERM, waits, then SIGKILL.  If the
   grace period is shorter than your drain cap, the drain is decorative.  These two numbers must
   be chosen together and documented together.

## Traps, each of which will bite you

**`draining` in this repo means something else.**  Grepping `draining` finds
`account.isDraining` and `drainingAccountLiveOrders` (`src/lib/scheduler.ts:95`, `:887`) — that is
*account* wind-down, a completely unrelated product concept.  Name your flag something distinct
(`processQuiescing`, not `draining`) or you will confuse every future reader.

**`hasInFlightStrategyWork()` is unscoped, unbounded and has no age floor.**  It is a bare
`SELECT 1 ... WHERE status='running'` with **no user scope, no account scope, and no staleness
cutoff**.  One permanently-`running` row — which is exactly the failure mode seen in the current
stall investigation — would make the app believe it is *never* quiescent and refuse to ever cut
over.  **Do not use it as-is as the quiescence gate.**  Either add an age floor (there is already
`STALE_RUN_THRESHOLD_MS`, 30 min, at `db-execution.ts:354`) or track in-flight work in memory for
this process rather than reading a table that outlives it.  In-memory is the better answer: what
you care about is "is *this* process mid-run", not "does the database contain a running row".

**Never `process.kill(process.pid, signal)` to re-raise.**  Documented in `AGENTS.md`: pid 1
ignores default-disposition signals, the process drains to a bogus **exit 0**, and
`restart: unless-stopped` then restarts it while Coolify believes it stopped cleanly.  Use
`process.exit(128 + N)`.

**Never put `npm run <script>` in the container exec chain.**  In-container npm dies on SIGTERM
*without forwarding it*, so the app is hard-killed on every stop and your drain never runs.
Invoke `node_modules/.bin/next` directly.  This is documented and was proven by sandbox repro.

**No production code path may exit 0 spontaneously.**  The exit-code contract is in `AGENTS.md`:
40 = boot-supervisor re-tag, 41/42 = R2 kill-switch/resume, 43 = in-app exit-guard re-tag,
130/143 = graceful.  A drain that finishes and exits 0 will be misread as a crash.

**A quiescent moment may never arrive during market hours.**  The scheduler ticks every 60s and
runs can take minutes.  If your gate is "wait for perfectly idle", you may have rebuilt the RTH
ban with extra steps.  Decide up front what the cap does when it expires.

## The money-path question the owner must answer before you build

**When the drain cap expires and a strategy run is still in flight, what happens?**

- **Interrupt it** — accepts that a run can be cut mid-flight, which is what the RTH latch exists
  to prevent.  If a placement is in flight, an aborted call may still have reached the broker;
  `#2960` and `#2962` encode hard-won caution about exactly this.
- **Abandon the deploy and retry later** — safe, but if runs are frequent the container may go a
  long time without updating, and a security fix could sit unshipped.

There is a defensible middle: **allow interruption between runs but never during an order
placement**, since placement is the only step where an interrupted call can produce a real-money
ambiguity.  That likely means the quiescence gate needs to be finer-grained than
"is a run happening" — it needs "is an order placement in flight".

**Do not pick this yourself.  It is the owner's risk call, and it is the whole point of the
feature.**

## Verification bar

- Failing-first per behavior: a test proving a new run is *refused* once quiescing is set, and a
  test proving the process exits 143 (not 0, not 1) after the drain completes.
- A test that the cap actually fires — a drain that hangs forever must fail a test, not
  production.
- Full gate: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
  **Capture real exit codes.**  `cmd | tail; echo $?` reports *tail's* status — that hid a failing
  `tsc` for hours on 2026-08-21.  Run unpiped or use `if ! cmd; then`.
- Because this changes the stop path, verify against a real `docker stop`, not just unit tests.
  A drain that works in vitest and not under pid 1 is the exact failure class this repo has hit
  before.

## Coordination

The RTH latch is **peer PR #2817's** work and the design is sound for the problem it was solving —
do not frame this as fixing a mistake.  It is an owner-directed change of policy: from "never swap
during market hours" to "swap at a quiescent moment, any time of day".  Tell that seat before
starting; they hold context on `rth-deploy-latch.ts`, `rth-deploy-drain.sh` and the workflow.

Related: `#2967` (event-loop freezes, and the `hasInFlightStrategyWork` unboundedness),
`#2970` (abandoned Alpaca reads still hold sockets — relevant, because a socket that never closes
is work that never drains).

## One honest caveat

The current stall investigation shows production is skipping runs at an equity-floor gate
(`Account equity (0) is too low to trade`).  While that is true, the app is *trivially* quiescent
and this feature will look like it works perfectly.  **Do not validate the drain only in that
state.**  Test it against a real in-flight run, or you will ship a gate that has never actually
had to wait for anything.
