# 2026-07-04 — Hybrid resource-aware runner routing for the `verify` gate

Branch `claude/ci-hybrid-runner-verify`, worktree `~/apps/trading-wt-ci-efficiency`, off
`origin/main` at `370692cf` (immediately after PR #370 merged). Own clearly-labeled PR by
explicit owner instruction — deliberately NOT bundled into #370.

## History and decision record (required reading before touching this again)

1. **2026-07-01:** `verify` was deliberately moved OFF the self-hosted `trading-live` Mac runner
   onto `ubuntu-latest` (PR #285 lineage; see the old ci.yml comment) because the single Mac
   runner was serializing a backlog of CI runs — "the main source of the runner queue
   bottleneck."
2. **2026-07-04 (this task's first round):** hybrid self-hosted/hosted routing was proposed
   mid-task. The implementing agent escalated back instead of building, with three objections:
   (a) **contention** — the Mac is the production box (pm2 `trading`, live trading process);
   running 2,436 tests + a Next build on it risks CPU/RAM contention with production;
   (b) **bottleneck** — a `max-in-flight 1` self-hosted lane is by definition the serialization
   the 2026-07-01 change eliminated;
   (c) **gate determinism** — a required check whose result depends on which of two OS/toolchain
   environments (macOS ARM64 vs Linux x64) happened to execute it weakens what "verify passed"
   means.
3. **2026-07-04 (owner re-confirmation):** the owner re-confirmed hybrid AFTER seeing those
   objections, with a resource-aware design that answers each one. Verbatim intent: **"hybrid so
   that it only uses local when there is sufficient extra CPU/RAM available."** The design below
   is that answer, point by point:
   - (a) answered by the **availability publisher**: the Mac itself advertises capacity only
     when 1-min loadavg/ncpu < 0.6 AND free+inactive RAM > 6 GB AND the runner process is alive
     AND pm2 `trading` is online — with hysteresis (2 consecutive available checks to flip to
     self, instant flip to hosted on any busy check). Self-path gate commands additionally run
     under `nice -n 19`, so the trading process always outbids CI for CPU.
   - (b) answered by **instant hosted fallback**: the router reads the published state natively
     from `vars.VERIFY_RUNNER_STATE` (no API call); mode!=self OR ts stale >5 min OR var absent
     → hosted immediately. A busy or asleep Mac never queues anything; the self-hosted
     concurrency-1 group is a load-shed detail, not the throughput path.
   - (c) answered by **Linux as arbiter**: a verify-self FAILURE triggers exactly one automatic
     hosted re-run and the required gate takes the hosted result on disagreement — a
     Mac-environment flake can never block or fake-fail a merge. A self-hosted PASS stands (the
     suite is environment-agnostic by design and macOS is exercised daily by every local gate
     run on this fleet). A nightly scheduled hosted full-gate canary on `main` maintains a
     continuous Linux baseline, and the gate summary annotates which environment produced the
     accepted result on every run (the audit receipt).

## What changed

### `.github/workflows/ci.yml` — restructured from 2 jobs to 4

- **`classify`** (existing, extended): now also emits a `route` output (`self`|`hosted`).
  Routing rules, all fail-safe to hosted: only `pull_request`/`push` events are eligible
  (merge_group/schedule/dispatch always hosted); fork PRs never route self; absent variable,
  non-`self` mode, corrupt JSON, stale ts (>300 s), or negative age (clock skew) all route
  hosted. The state JSON is passed via `env:` (not inline interpolation) so quoting can't break
  the script.
- **`verify-self`** (new): the opportunistic macOS lane. Runs only when routed self and the
  diff is not docs-only. `runs-on: [self-hosted, trading-live]`, `timeout-minutes: 30`,
  job-level `concurrency: verify-self-hosted` (max 1, no cancel). Steps mirror the hosted lane
  plus: the same untrusted-source guard, a node fail-fast sanity step, and `nice -n 19` on
  every heavy command (install/lint/tsc/test/build). Uses the same cache keys — `runner.os` =
  `macOS` gives it an automatically separate cache namespace from the Linux lineage.
- **`verify-hosted`** (new name for the old verify body): the deterministic Linux lane. Runs
  when routed hosted OR as the exactly-one automatic re-run whenever verify-self did not
  succeed (failure, timeout, unexpected skip). Also now saves the Linux `.next/cache` on the
  nightly schedule leg (not just main pushes) so the Linux cache stays fresh even during
  stretches where every main push routes to the Mac.
- **`verify`** (the REQUIRED check, now a pure gate job): interprets the lanes and reports
  under the exact context name the ruleset requires. Decision table below. Writes the
  environment-attribution receipt to the job log and `$GITHUB_STEP_SUMMARY` on every run.
  Uses `if: ${{ !cancelled() }}` (not `always()`) so superseded-run cancellation still works
  while classify/lane failures can never silently skip the required check.
- **`schedule` trigger added** (`47 7 * * *` UTC ≈ 01:47/02:47 America/Chicago): the nightly
  hosted full-gate canary on `main`.

### `scripts/runner-availability.sh` — new Mac-side publisher (owner-run)

Pure-ASCII bash (Apple bash 3.2-safe, `bash -n` verified against `/bin/bash` 3.2.57). Every
60 s: computes availability per the formula above and publishes
`VERIFY_RUNNER_STATE = {"mode":"self"|"hosted","ts":<epoch>}` via `gh api` PATCH (POST-creates
the variable if missing). Hysteresis: 2 consecutive available checks before `self`; any single
busy check flips `hosted` immediately. An EXIT/INT/TERM trap publishes `hosted` on shutdown so
a stopped publisher fails toward hosted even before staleness kicks in. All thresholds
env-tunable (`RUNNER_AVAILABILITY_LOAD_THRESHOLD`, `_MIN_FREE_RAM_GB`, `_HYSTERESIS`,
`_INTERVAL`, `_PM2_APP`, `_RUNNER_PATTERN`, `_REPO`).

**Owner activation (one-time, idempotent — NOT performed by the agent):**

```bash
pm2 start ~/apps/trading-live/scripts/runner-availability.sh \
  --name runner-availability --interpreter bash && pm2 save
```

Until this is run, `VERIFY_RUNNER_STATE` stays at its safe default (`{"mode":"hosted","ts":0}`,
created by the agent via the API on 2026-07-04) and **everything routes hosted — merging this
PR changes no behavior until the owner activates the publisher.** Deactivation is equally
simple: `pm2 stop runner-availability` (the trap publishes hosted; staleness is the backstop).

## Gate decision table

| classify | docs-only | route | verify-self | verify-hosted | `verify` gate result | Annotated environment |
|---|---|---|---|---|---|---|
| failure/cancelled | — | — | skipped | skipped | **FAIL** (fail-closed) | — |
| success | true | — | skipped | skipped | **PASS** ("docs-only diff — gate skipped by path filter") | none (no suite ran) |
| success | false | hosted | skipped | success | **PASS** | hosted ubuntu-latest |
| success | false | hosted | skipped | failure | **FAIL** | — |
| success | false | self | success | skipped | **PASS** | self-hosted macOS |
| success | false | self | failure/timeout | success | **PASS** (disagreement noted; Linux arbiter) | hosted ubuntu-latest (arbiter) |
| success | false | self | failure/timeout | failure | **FAIL** (both lanes agree or Linux fails) | — |
| any run cancelled (superseded push) | — | — | — | — | gate skipped with the run (`!cancelled()`) — new run supersedes | — |

## Failure-mode table (operational)

| Failure | Behavior | Recovery |
|---|---|---|
| Publisher not started / stopped | Var absent or shutdown-trap published hosted; stale after 5 min regardless | Everything routes hosted (the pre-activation default state) |
| Mac busy (load/RAM), trading restarting, runner dead | Publisher flips hosted immediately (no hysteresis on the busy direction) | Routes hosted; flips back only after 2 consecutive available checks |
| Mac dies suddenly INSIDE the 5-min freshness window with a job already routed self | verify-self sits queued on the offline runner; GitHub fails a job queued for an unavailable self-hosted runner after its queue timeout, then verify-hosted auto-runs and the gate takes it | Slow-path but self-healing; short window (60 s cadence + hysteresis + EXIT trap) makes this rare. Manual fast path: cancel the run / `gh run rerun` |
| verify-self flakes (macOS-only failure) | Exactly one automatic hosted re-run; gate takes the hosted PASS with a disagreement annotation | Check verify-self logs for the flake; no merge impact |
| verify-self passes but macOS masked a Linux-only failure | Possible in theory (self PASS stands per owner decision) | Nightly hosted canary on main catches Linux-only breakage within 24 h; `smoke` (hosted Playwright) still runs on every PR as an independent hosted build signal |
| Corrupt/garbage variable value | jq parse fails → hosted | Publisher's next cycle overwrites |
| Clock skew (future ts) | Negative age treated as stale → hosted | Self-corrects when clocks agree |
| Actions spending limit $0 | Hosted jobs (classify/gate/verify-hosted) fail — same exposure as before this PR; the self lane cannot save the gate because the gate job itself is hosted | Raise the spending limit (pre-existing constraint, unchanged by this PR) |
| Fork PR | Router refuses self; both lanes also carry the untrusted-source guard; repo is private (verified `visibility=private`) | Hosted path with the existing guard, unchanged |

## Minutes impact

- When the Mac advertises capacity: the ~4-6 min suite runs on the Mac at $0 hosted-minute
  cost; hosted spend for such a run is only classify (~10 s) + gate (~10 s) — billed as 2 min
  due to per-job rounding, vs ~5-6 min for a hosted suite run. Net ~60-70% hosted-minute
  reduction on self-routed runs.
- When the Mac is busy/asleep: identical to pre-PR behavior plus the gate job (~1 billed min).
- Docs-only PRs: unchanged from #370 (~2 billed min: classify + gate short-circuit).
- Nightly canary: ~5-6 hosted min/night (~165/mo) — the price of the continuous Linux baseline;
  it also refreshes the Linux `.next` cache.

## Files touched

- `.github/workflows/ci.yml` — restructure described above.
- `scripts/runner-availability.sh` — new, owner-run Mac-side publisher (ASCII-only, bash-3.2
  safe).
- `docs/rollouts/2026-07-04-ci-hybrid-runner-verify.md` — this note.
- `STATUS.md` — prepended entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — row moved Planned → In
  Progress → (Completed on merge).
- Repo variable `VERIFY_RUNNER_STATE` created via API with safe default
  `{"mode":"hosted","ts":0}` (settings change, not a file).

Explicitly NOT in scope (unchanged): `e2e.yml` (`smoke`), `security.yml` (`gitleaks`),
`shared-package-pin-check.yml` (`check-pin`) — all stay hosted per the owner's spec;
`cleanup-caches.yml` continues to cover the macOS cache lineage automatically (its grouping is
per key-prefix per ref, and the macOS lineage is just another prefix). The cross-repo
`workflow_call` reusable gate remains deferred until this PR proves itself; hosted-only default
stands when it is eventually built, with resource-aware routing as explicit per-repo opt-in.

## Verification

- `npx yaml-lint .github/workflows/ci.yml` — valid.
- `bash -n` and `/bin/bash -n` (Apple 3.2.57) on `scripts/runner-availability.sh` — clean;
  `grep -nP '[^\x00-\x7F]'` — pure ASCII.
- Route logic exercised standalone against 8 state shapes (absent var, hosted default, fresh
  self, stale self, fresh-self-but-merge_group, fresh-self-but-schedule, corrupt JSON, future
  ts) — every non-happy path routes hosted.
- Availability probes exercised read-only on the actual production Mac: ncpu/loadavg parse OK,
  vm_stat free+inactive parse OK, runner process detected alive, pm2 `trading` parsed online.
  Live validation of the premise: at test time the Mac was genuinely busy (load 13.9/10 cores,
  3.2 GB free+inactive — an agent build was running) and the formula correctly said "hosted".
- `VERIFY_RUNNER_STATE` created and read back via API.
- Full local quartet: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), `npm test`
  (2436/2436), `npm run build` (green) — commands run in this worktree on this branch.
- Post-merge watch plan: first PR after merge shows route=hosted (publisher not yet started);
  after owner activation, watch one self-routed run's gate annotation and one forced-busy
  fallback.

## Follow-ups

- Owner: start the publisher (`pm2 start ... runner-availability`) when ready to activate;
  also add the pm2 one-liner to `~/apps/README.md` on the deployment machine (host-local ops
  doc — outside this repo).
- After a week of hybrid operation, compare hosted-minutes burn (Actions usage API) against the
  #370 baseline and record the measured split (self-routed vs hosted-routed run counts).
- The cross-repo reusable `workflow_call` gate (deferred): hosted-only default, routing opt-in.

## 2026-07-04 addendum — landing operator merge-forward + re-verify

PR #372 had drifted behind `main` (GitHub reported `mergeStateStatus: DIRTY` /
`mergeable: CONFLICTING`) after several other cars (#433, #436, #437, #365, and the W1/W2
learning-loop and effort-issues-mirror work) landed on top of the #370 base this branch forked
from. Re-fetched `origin` and ran `git merge origin/main --no-edit` in this worktree
(`~/apps/trading-wt-ci-efficiency`) — merged clean via the `ort` strategy with **zero textual
conflicts** (`STATUS.md` and `docs/EFFORT-LOG.md` both auto-merged; no `db.ts`/`strategy.ts`
overlap since this branch only touches CI/workflow files). Merge commit `1047c337` on top of
main tip `57a575f7` (#437).

Re-ran the full local quartet post-merge in this worktree:
- `npm run lint` — 0 errors (308 pre-existing warnings, unrelated backlog).
- `npx tsc --noEmit` — clean.
- `npm test` — 251 files / 2449 tests passed (test count grew from 2436 due to merged-in W1/W2
  learning-loop and episodic-retrieval test files; deleted stale gitignored `data/app.db` first).
- `npm run build` — green.

No follow-up beyond the items above; landing via `scripts/land.sh` next.

## 2026-07-04 addendum #2 — second merge-forward after #440 landed

Between the first merge-forward above and #372's actual merge, PR #440 (`claude/w2-outcome-engine`,
the Wave-2 Outcome Engine lane) landed on `main` first (sha `2a0f8eac`), which is exactly why
#372's `mergeStateStatus` flipped `BLOCKED` → `DIRTY` mid-wait — the base moved out from under it.
Re-fetched and re-merged `origin/main` in this worktree: one conflict this time, in
`docs/EFFORT-LOG.md` (both sides added an "In Progress" entry in the same slot — this branch's own
PR #372 status line, and the Outcome Engine's entry). Resolved keep-both-newest-first per the docs
protocol, updating the Outcome Engine entry's status to **merged (PR #440)** since that had since
become true. No other file conflicted (still a CI/workflow-only branch). Merge commit `5e3b496` on
top of main tip `2a0f8eac`.

Re-ran the full local quartet again: `npm run lint` (0 errors), `npx tsc --noEmit` (clean),
`npm test` (252 files / 2455 tests, matching car 11's post-merge count exactly), `npm run build`
(green). Landing via `scripts/land.sh` again next.

## 2026-07-05 — calibration audit + fixes (owner-directed activation)

Owner asked to make the runner actually offload safely. A live diagnosis found the feature
was 100% inert: PR #372 unmerged, the publisher never started (repo var `VERIFY_RUNNER_STATE`
still the `{"mode":"hosted","ts":0}` seed), and — critically — the availability metric could
never open on the real hardware. The production Mac is **16 GB** and chronically swapping
(measured ~11–20 GB swap used, `kern.memorystatus_vm_pressure_level == 2`), so the old
`free+inactive > 6 GB` gate was both unsatisfiable AND the wrong signal (it undercounts
reclaimable macOS cache yet is blind to swap/compressor — it can read "healthy" on a
thrashing box). An adversarial audit (4 lenses) and a pre-land review (3 lenses) backed the
following changes; this merge-forward (33 commits behind main) also had to re-resolve `ci.yml`
against main's docs-only fast path (#370), the tokenless-install migration (`.npmrc` +
`npm-ci-with-shared-deps.sh` both removed from main), and the dropped `agent/**` push trigger.

### What changed

`scripts/runner-availability.sh` — availability metric rewritten to a **pressure-based gate**
(all required): `kern.memorystatus_vm_pressure_level == 1` (kernel says normal) AND
`vm.page_free_wanted == 0` AND swap used `< 3 GB` AND compressor occupancy `/ RAM < 0.25` AND
`free+inactive > 3 GB` (tertiary floor). CPU load ratio loosened `0.6 → 0.8` (every self-path
command runs under `nice -n 19`, which protects CPU scheduling — but NOT memory, which is why
the memory gate is the load-bearing safety term). Verified under Apple bash 3.2, ASCII-clean;
correctly returns BUSY on the current box (pressure level 2) and AVAILABLE only when the box
truly has headroom.

`.github/workflows/ci.yml`:
- **Router `ts` bug fix (was a latent merge-blocker):** `.ts // 0` does not coerce a
  present-but-non-numeric `ts`; an operator typo like `{"ts":"oops"}` would flow a bad token
  into `age=$(( now - ts ))` under `set -euo pipefail` and hard-fail the required check for
  every PR. Now `(.ts | numbers) // 0` + an integer belt (`[ "$ts" -eq "$ts" ] || ts=0`).
- Staleness window `300s → 180s` (publish interval is 60s, so 3 samples).
- `verify-self`: **dropped `actions/setup-node`** — its npm-cache post-action wedges on the
  long-lived self-hosted Mac (see `2026-06-29-self-hosted-ci-billing-block.md`); uses the
  system node like `deploy.yml`. Install is tokenless `npm ci` (the stale
  `npm-ci-with-shared-deps.sh` + deploy key are gone from main). Added
  `NODE_OPTIONS=--max-old-space-size=3072` (job env) and `npm test -- --maxWorkers=2` to
  **bound peak RSS** on the 16 GB box — the precondition that makes self-routing safe here.
- `verify-hosted` (the arbiter): main's tokenless `npm ci`; dropped redundant per-step
  docs-only guards (its job-level `if` already excludes docs-only); kept the nightly canary in
  the cache-save condition.
- Triggers: dropped `agent/**` push (main's cost decision — PRs already run `verify`); kept the
  nightly hosted canary + `workflow_dispatch` re-kick lever.

### Why this is safe to activate on the production trading box

Defense in depth on the axis that matters (memory): the publisher only advertises `self` when
the kernel reports normal pressure AND swap/compressor are low — i.e. only when the box has
real headroom — and even then the self verify job is RSS-capped and `nice -n 19`. Any
self-lane failure (including a system-node-version flake) triggers exactly one hosted arbiter
re-run and the gate takes the hosted result, so a Mac hiccup can never block or fake-pass a
merge. On the current memory-tight box the gate correctly stays closed (stays hosted); it opens
only if the box is upsized or sheds resident services.

### Verification

- `runner-availability.sh`: `bash -n` clean under `/bin/bash` 3.2.57; `grep -nP '[^\x00-\x7F]'`
  empty (ASCII); `check_available` run live returns BUSY (pressure level 2); swap/compressor/
  free parsers exercised directly with no awk errors; healthy-box simulation returns available.
- `ci.yml`: `python3 yaml.safe_load` OK; no conflict markers; `(.ts|numbers)//0` confirmed to
  map `oops→0`, `1751742000→1751742000`, missing→0.
- Full local gate (`tsc`/`test`/`build`) via `scripts/land.sh` at landing.
- Adversarial reviews: calibration audit (4 lenses) + pre-land review (3 lenses:
  workflow-semantics, shell-correctness, production-safety).

### Follow-ups / activation

After landing: start the publisher under pm2 on the production Mac
(`pm2 start ~/apps/trading-live/scripts/runner-availability.sh --name runner-availability
--interpreter bash && pm2 save`) and confirm it publishes a fresh `{"mode",...}` value. It will
report `hosted` while the box is memory-tight (expected); offload activates automatically when
the box has headroom.

### Pre-land review (2026-07-05) — findings applied + known residual

A 3-lens pre-land review (workflow-semantics, shell-correctness, production-safety) returned
**GO to land / GO to activate, zero blockers**. Two hardenings were applied from it:
- `runner-availability.sh` compressor term made **fail-closed** (it was the lone term that
  skipped rather than returned busy when `hw.memsize`/the compressor `vm_stat` line was
  unreadable — now `... || { log busy; return 1; }` like every sibling term).
- swap parser now **asserts the `M` (megabyte) suffix** macOS emits; a future `G`/`K` units
  change yields an empty value -> busy, instead of mis-scaling a large swap down into a false
  "available".

**Known residual (documented, not a blocker): a self-hosted queue-wait *stall* — never a
fake-pass.** If `classify` routes `self` while `VERIFY_RUNNER_STATE` is still fresh (<180s) but
the Runner.Listener has since died or is queued behind another self job (`verify-self-hosted`
concurrency, `cancel-in-progress: false`), `verify-self` sits Queued; `verify-hosted` and
`verify` gate on its `needs` completion, so the required check stays Pending and auto-merge does
not fire. `timeout-minutes: 30` bounds execution, not queue-wait. The window is small (60s
publish cadence + 180s staleness + the `pgrep Runner.Listener` availability check flip the state
to `hosted` within ~180s of a runner death) and there is exactly ONE registered runner
(`/Users/jay/actions-runner`, single Runner.Listener), so `verify-self` never runs concurrently
with a `deploy` build. This can only *stall* a routed PR, never fake-pass or block via a wrong
result. **Follow-up if ever observed:** a lightweight scheduled/dispatch watchdog that
`gh run cancel`s a `verify-self` job still Queued after N minutes, which flips it to `cancelled`
and fires `verify-hosted`'s `self.result != 'success'` arbiter branch promptly.

Confirmed non-issues (reviewed, no change): the gate is fail-closed (`verify` uses
`if: !cancelled()`, classify-fail -> exit 1, self accepted only when `HOSTED==skipped &&
SELF==success`); dropping `setup-node` for system node only ever makes verify-self *fail* ->
hosted arbiter re-runs (never fake-pass); the RSS heap cap is belt-and-suspenders atop the
load-bearing availability gate; `deploy.yml` already runs the same `npm ci`+`next build` on this
identical runner every main push, so the self lane adds no new class of load.
