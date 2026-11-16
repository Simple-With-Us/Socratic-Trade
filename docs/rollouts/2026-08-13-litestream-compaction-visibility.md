# Litestream compaction visibility: make a silent backup failure loud

## 1. Context & Objective

A multi-agent investigation (2026-08-13) diagnosed a five-day-old, fully silent
production incident: litestream's level-2 ("deep") compaction on
`socratictrade.com` froze at 2026-08-08T14:35Z and stayed frozen, while
`/api/health` reported `ok: true` and `checks.storage.litestreamDegradedReasons: []`
the entire time.  Root cause (not this PR's to fix): every Coolify rolling
deploy briefly runs two `litestream replicate` processes against the same B2
prefix; litestream 0.5.12 has no fencing between them, so they can emit L1
objects with the same MaxTXID, which fails `ltx.IsContiguous` forever and
blocks L1->L2 promotion.  ~90,000 LTX files accumulated in B2 as a result (see
`src/lib/litestream-remote-inventory.ts`'s own measured `-level all` count).
Data was never at risk (the L9 snapshot is a full-DB image outside the level
chain), but the monitoring gap — a real backup-continuity failure producing
zero signal for five days — was the actual problem this PR (Step 3 of the
diagnosed fix) exists to close.  Steps 1 and 2 (disabling Coolify's rolling
container replacement, and a one-time B2 delete of the poison objects) are the
owner's to do — see section 5.

## 2. Changes Made

Three additive, independent signals, plus one architectural correction found
while implementing the first of them.

### 2a. `litestream.coolify.yml`: enable litestream's own validation, at the
correct scope

Added a top-level `validation: { interval: 1h }` block. **The task brief that
kicked this off said to add this "at the DB level" — that is wrong for
litestream 0.5.12 and was corrected here.** Verified against the pinned
version's actual source
(`github.com/benbjohnson/litestream` tag `v0.5.12`, `cmd/litestream/main.go`):
`Validation ValidationConfig` (yaml tag `validation`) is a field on the
top-level `Config` struct, wired through `Store.ValidationInterval` ->
`Store.Validate` -> `Replica.ValidateLevel` (`store.go`). `DBConfig` (the
struct that backs each entry in `dbs:`) has no such field at all — nesting it
under `dbs:` would have made litestream either ignore it silently or fail to
parse, defeating the entire point of this line. Confirmed the corrected
placement parses with a local `python3 -c "import yaml; yaml.safe_load(...)"`
structural check (top-level `validation` sibling to `socket`/`dbs`).

Deliberately did **NOT** add `verify-compaction: true` (also global,
`Config.VerifyCompaction`) — that option LISTs the entire destination level
after every single compaction, which at L1's ~90k-object backlog is the same
S3 request/socket-churn class that exhausted kernel `tcp_mem` and wedged every
Coolify deploy on 2026-07-10
(`docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md`).
`validation.interval` runs on its own schedule instead of after every
compaction, so it cannot reproduce that failure mode.

### 2b. A third, independent detection signal: litestream's own log lines

`checks.storage.litestreamDegradedReasons` (from `assessLitestreamRuntimeHealth`)
only ever reflects level 0 by design — it is documented as structurally blind
to a higher-level wedge, and that has not changed here (see the "Zero-code
findings" note below on why this field legitimately stayed `[]` throughout the
real incident). The 2026-08-11/12 `assessLitestreamTierFreshness` /
`litestreamTiers` mechanism (already on `main`, not introduced by this PR) is
the real per-level breakdown, and it correctly separates `state: "known" &&
degraded: true` (a real alarm) from `state: "not-observable"` (a coverage
gap it refuses to fabricate a verdict for) — but every level above 0 depends
entirely on a scheduled remote LTX inventory
(`src/lib/litestream-remote-inventory.ts`), and that pipeline has a *separate*,
already-known, in-flight bug on `monet/durable-inventory-cache`
(`cachedInventory` is module-level; the Next route handlers don't share the
scheduler's module instance, so `remoteInventoryState` is always `"missing"`
in production). Until that lands, every tier above 0 reports
`not-observable` in production — correctly honest, but blind.

This PR adds a THIRD signal that needs neither fix: litestream's own log
lines. Litestream logs `compaction failed` (store.go, on every failed
compaction attempt) and — now that 2a is live — `validation error detected`
(store.go's `monitorValidation`, gap/overlap/unsorted classification) at
ERROR/WARN. The problem: litestream owns the container's real stdout (it
wraps the app via `-exec`, not the other way around), so nothing inside the
Node process can read that stream at all without help from the boot script.

- `scripts/coolify-prod-start.sh`: the single `run_app litestream replicate
  ...` invocation now tees its combined stdout+stderr to
  `$DATA_DIR/litestream-runtime.log` via `> >(tee -a "$LITESTREAM_LOG_FILE")
  2>&1` — process substitution, not a `| tee` pipe, specifically because a
  pipe backgrounds the whole pipeline and makes `run_app`'s `$!` resolve to
  `tee`'s PID instead of litestream's, silently breaking the
  SIGTERM-forwarding contract the 2026-08-02 exit-code audit exists to
  protect. Verified locally before landing (see Verification State) that PID
  capture, SIGTERM forwarding, and exit-code propagation are all byte-for-byte
  unchanged, and that `tee` still mirrors everything to the script's own
  stdout/stderr so Coolify's log collector loses nothing. This is the ONLY
  change to the script; every other line, every other `run_app` call site
  (fresh mode, both kill-switches), is untouched.
- `src/lib/runtime-health.ts`: new `defaultLitestreamRuntimeLogPath`,
  `scanLitestreamRuntimeLogText` (pure — splits text into lines, matches
  against `LITESTREAM_RUNTIME_LOG_FAILURE_MARKERS`, caps findings at 5 and
  each line at 500 chars), and `scanLitestreamRuntimeLogFile` (I/O — reads
  only the last 256 KiB of the file via `openSync`/`readSync` at a computed
  offset, never the whole thing, so cost is bounded regardless of how long
  the container has been up; never throws — a missing file, e.g. because
  litestream isn't running this boot, reports zero findings rather than an
  error).
- `app/api/health/route.ts`: computes `litestreamCompactionLogFindings` via
  the above (path overridable with `LITESTREAM_RUNTIME_LOG_PATH`, mirroring
  the existing `LITESTREAM_SOCKET_PATH`/`LITESTREAM_STATE_PATH` overrides),
  publishes only a COUNT as `checks.storage.litestreamCompactionLogFailureCount`
  (the raw matched lines are never put in the world-readable body — this
  route is in `middleware.ts`'s `PUBLIC_PREFIXES`, and litestream's own error
  text could echo path/bucket detail), folds a nonzero count into
  `storageDegraded` alongside the pre-existing disk/WAL/litestream/tier
  conditions, and calls the EXISTING `alertStorageWarning("litestream_compaction_log_failure",
  ...)` with a sample line for the operator alert.
- `.claude/skills/deploy-verify/SKILL.md`: extended the `/api/health` jq
  filter operators already use during deploy verification to include
  `litestreamTierCoverage` and the new `litestreamCompactionLogFailureCount`,
  with an explanation of what each should read when healthy.

### 2c. Design of the degraded-vs-not-observable distinction (how items 1-3
fit together)

No new "degraded reason" enum was added to `LitestreamDegradationReason` —
that type is deliberately scoped to what the level-0 IPC signal can prove and
extending it to cover things it cannot observe would be exactly the kind of
fabrication the honesty requirement rules out. Instead:

- `litestreamDegradedReasons` (existing): level-0-only, unchanged, correctly
  stays `[]` during an L2-only wedge.
- `litestreamTiers[].state` (existing): `"known" && degraded: true` is a real
  alarm (folds into `storageDegraded`); `"not-observable"` is a coverage gap
  and — also existing behavior, not touched here — is alerted on separately
  (`litestream_tier_coverage_blind`) WITHOUT flipping `storageDegraded`, so a
  level nobody can currently see never pages as if it were failing.
- `litestreamCompactionLogFailureCount` (new, this PR): a nonzero count is
  ALWAYS a real alarm (folds into `storageDegraded`) — there is no
  not-observable state for it, because an empty result here is not a claim of
  "confirmed healthy," only "no evidence of failure in the tail we read." The
  function's own doc comment states this explicitly so a future caller does
  not mistake zero findings for a clean bill of health.
- None of the three ever sets the top-level `ok` / HTTP status — confirmed by
  reading the whole route: only DB reachability and a hard-stopped critical
  dependency lane can do that (`ok = false` appears exactly twice in
  `app/api/health/route.ts`, neither inside the storage block). Backup
  continuity staying a `storageDegraded`-only signal, never a 503, is
  pre-existing behavior this PR extends rather than changes.

### 2d. Tests

- `test/runtime-health.test.ts`: 11 new unit tests —
  `defaultLitestreamRuntimeLogPath` path shape; `scanLitestreamRuntimeLogText`
  against a real `compaction failed` line, a real `validation error detected`
  line, routine healthy INFO-level lines (proves no false positives), a
  finding/line-length cap test, and blank/empty input; `scanLitestreamRuntimeLogFile`
  against a missing file, a real failure line read off disk, an empty file,
  and two tail-bound tests (an old failure pushed out of a small tail window
  is correctly NOT reported; a recent one within that same small window is).
- `test/connection-health-routing.test.ts`: 3 new integration tests against
  the real route — (1) a log file with a `compaction failed` line flips
  `storageDegraded`, sets `litestreamCompactionLogFailureCount: 1`, and fires
  a real `alertStorageWarning` (verified via the `audit_events` table and the
  stubbed Resend fetch, polled with `vi.waitFor` since the route fires the
  alert fire-and-forget) — deliberately run with NO socket/state dir/remote
  inventory configured, so the pre-existing `litestreamDegradedReasons` stays
  `[]` and every `litestreamTiers` entry is `not-observable`, proving the new
  signal is what catches it, not either pre-existing mechanism; (2) a log
  file with only healthy lines reports zero findings; (3) a missing log file
  reports zero findings.
- **Verified all 14 new tests fail without the implementation**: `git stash
  push` on the four non-test changed files, re-ran both test files (14
  failed / 50 passed — the 50 are pre-existing tests in those two files,
  unaffected), then `git stash pop` to restore.

## 3. Decisions & Trade-offs

- **No new `NotificationEventType` / migration.** `alertStorageWarning`
  already takes a free-text `warningType` for the cooldown key + alert title
  and always sends the SAME underlying event, `type: "storage_warning"`
  (`src/lib/db-health.ts`). The new `litestream_compaction_log_failure`
  warningType reuses that function exactly like the seven other storage
  alerts already do (`disk_space_low`, `litestream_tier_${tier}_stale`,
  etc.) — no new type to backfill, no migration-version collision risk. This
  also means this PR is naturally unaffected by whether `monet/real-toggles`
  (#2682, open at the time of writing, removes `alertStorageWarning`'s
  force-include pattern per the owner's 2026-08-12 "ALL toggles must be real"
  ruling) merges before or after it — this PR calls the function, never
  redefines it, so neither ordering changes anything here. `git fetch
  origin && git log origin/main` confirmed #2682 had not yet merged as of
  landing this branch.
- **No offset-tracking / no log truncation.** Considered persisting a
  last-read byte offset (via `getInternalSetting`/`setInternalSetting`,
  the pattern used elsewhere in this codebase) so each health check only
  scans genuinely new bytes, and considered periodically truncating the log
  file to bound its size. Both add real risk (a truncate racing a concurrent
  `tee -a` append can lose the last few bytes written in that window) for
  benefit that doesn't exist here: litestream logs almost nothing at its
  default INFO level in normal operation (checked the pinned source —
  routine "no compaction"/"db not ready" ticks are DEBUG-level, never
  written; `compaction complete`/`snapshot complete` fire only on real work).
  A sustained wedge — the only scenario that produces meaningful volume —
  logs at most one line per compaction-monitor interval (30s for L1 up to
  1h for L3), so even weeks of an unnoticed incident stay well under a few
  MB. The bounded 256 KiB TAIL read (not the whole file) is the only bound
  actually needed, and it is stateless: every health check independently
  re-derives the answer from disk, with no offset to get out of sync or
  reset incorrectly across a container restart.
- **Raw log lines never appear in the public `/api/health` body**, only a
  count. The matched text does go into the operator-facing
  `alertStorageWarning` message (not world-readable — routed to the
  configured notification channels), which is where a human actually needs
  to see it.
- **The boot-script change is the smallest one I could justify touching a
  file with this history.** Considered NOT touching it at all (accepting
  that item 3 stays inert), given `scripts/coolify-prod-start.sh` has a
  documented trail of real production outages traced to small changes
  (tcp_mem, exit-code contract, litestream version pins) and litestream is,
  as of today, freshly disabled in production via the
  `.litestream-disabled` marker after an unrelated OOM crash loop
  (`docs/rollouts/2026-08-13-dashboard-parallelization-and-litestream-disable.md`).
  Decided to proceed because (a) the change is additive to exactly one
  existing line, changes no control flow, and does not touch the
  trap/PID/exit-code machinery at all; (b) it is currently INERT — the
  `.litestream-disabled` kill-switch check happens before the modified line,
  so this ships zero behavior change until the owner clears that marker;
  (c) it was verified end-to-end against a full local simulation of the
  script (fake `litestream`/`next` binaries, real SIGTERM delivery) before
  landing — see Verification State.

## 4. Verification State

Node 24 pinned: `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

```
npx tsc --noEmit    -> clean, no output
npm run lint        -> 764 problems (0 errors, 764 warnings) — grandfathered backlog only;
                        confirmed no new warnings on lines this PR added
npm run build       -> exit 0; "Generating static pages using 9 workers (40/40) in 2.0s";
                        full route table printed (only happens on success); the one
                        "Compiled with warnings" is next's own pre-existing Edge-Runtime
                        process.cwd() warning inside node_modules/next, unrelated to this PR
npm test            -> Test Files  566 passed | 1 skipped (567)
                             Tests  6581 passed | 51 skipped (6632)
                        Duration 629.34s. Exit code 0.
```

Targeted runs (all green before the full suite):
`npx vitest run test/runtime-health.test.ts test/connection-health-routing.test.ts`
-> 64 passed (2 files).

Boot-script dry run (outside vitest, since bash isn't something the test
suite exercises): built fake `litestream` and `node_modules/.bin/next`
scripts in a sandboxed copy of `scripts/coolify-prod-start.sh` (only the two
hardcoded `DATA_DIR`/`CONFIG` paths redirected to the sandbox; every other
line identical to what's in this PR), ran it under `DB_BOOTSTRAP=live`, sent
it `SIGTERM` mid-flight, and confirmed: (1) `litestream-runtime.log` contains
the fake `compaction failed level=2` line plus everything else that would
have gone to the container's stdout; (2) the outer script's own stdout log
ALSO contains everything (nothing lost from what Coolify would still see);
(3) SIGTERM correctly forwarded litestream -> the fake `next` process; (4)
the fake `next` process's clean 143 exit propagated all the way out as the
outer script's own exit code. Also confirmed separately, with a minimal
isolated bash harness, that `> >(tee -a file) 2>&1` (vs. a `| tee` pipe)
preserves `$!` as the real command's PID, not `tee`'s — the property the
whole SIGTERM-forwarding contract depends on.

`litestream.coolify.yml` structural check: `python3 -c "import yaml;
yaml.safe_load(open('litestream.coolify.yml'))"` confirms `validation` now
parses as a top-level key, sibling to `socket`/`dbs` (not nested under
`dbs:`, which is what the original task brief asked for and which the
pinned v0.5.12 Go source shows does not exist as a field on `DBConfig`).

`scripts/coolify-prod-start.sh` ASCII check: `grep -nP '[^\x00-\x7F]'
scripts/coolify-prod-start.sh` finds one PRE-EXISTING non-ASCII em dash on
line 197 (unrelated to this change, not adjacent to a `$VAR` token so it
does not trigger the documented bash-3.2.57 trap) — confirmed via `git diff
... | grep -nP '^\+.*[^\x00-\x7F]'` that none of the lines THIS PR adds
contain non-ASCII bytes.

## 5. Next Steps & Blockers

**Owned by the owner, not this PR (do not implement without their
go-ahead):**

- **Step 1**: disable rolling container replacement for the Coolify app
  `socratic-app` — enable "Consistent Container Names"
  (`application_settings.is_consistent_container_name_enabled`) and drop
  `health_check_start_period` from 180s to roughly 60s. This is what
  actually stops two `litestream replicate` processes from ever overlapping
  during a deploy again. It reintroduces a brief per-deploy downtime window,
  which is why it's the owner's call, not an agent's.
- **Step 2**: a one-time Backblaze B2 delete of the non-advancing duplicate
  L1 objects (the actual poison currently blocking L1->L2 promotion). Needs
  write-capable B2 credentials the owner hands over via the normal
  `chmod 600` route in `/Users/jay/.secrets/` — never something an agent
  provisions itself.
- **A finding not in the original investigation, verified here and worth
  recording**: the B2 cutover commit `26f5fa5b` (2026-08-07) raised
  `snapshot.retention` from 24h to 168h in the SAME commit that changed the
  replica destination (visible in `litestream.coolify.yml`'s current
  `retention: 168h`, with the comment "B2 is paid capacity ... keep 7d of
  LTX for restore headroom"). Before that commit, poison L1 objects aged out
  within a day and a wedge would self-heal invisibly; after it, they persist
  7 days — longer than the roughly 1 day it takes to re-mint one during
  normal deploy cadence, which is why the freeze that began ~31h after the
  cutover never cleared on its own. This also means LOWERING retention would
  only mask the symptom (by letting poison objects expire before anyone
  notices) at the cost of real backup depth — not a fix, and not proposed
  here.

**Not blocked, ready to merge on its own:**

- This PR's three signals are independent of Steps 1/2 and of the
  `monet/durable-inventory-cache` fix — they will start producing real
  evidence as soon as litestream is next enabled in production (currently
  paused via `.litestream-disabled` for an unrelated OOM incident) and a
  compaction actually fails, with zero further code changes needed.
- Once `monet/durable-inventory-cache` lands, `litestreamTiers` should start
  reporting `known` states for levels 1/2/3/9 instead of `not-observable`;
  no coordination needed from this PR either way (confirmed by design: this
  PR does not touch `litestream-remote-inventory.ts` or anything that reads
  its module-level cache).

## 6. Zero-Code Findings

- **The record did not need correcting.** The task brief asked to find and
  fix any doc claiming the L2 wedge was "cleared" or "fixed" by the two
  earlier local resets (`docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`'s
  2026-08-12 `rm -rf .app.db-litestream/ltx`, and the 2026-08-12
  `backup-tier-monitor-real` work). A thorough grep across `docs/rollouts/*.md`,
  `docs/EFFORT-LOG.md`, and `STATUS.md` for "cleared"/"fixed"/"resolved"
  near litestream/compaction/wedge language found NO incorrect claim —
  every relevant entry already says, explicitly, that the underlying wedge
  was NOT cleared: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`
  ("clearing local state ... does not explain *why* the old generation's
  uploads were failing"), `docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md`
  ("Clear the wedged level-2 compaction in production — still open,
  unchanged by this PR"), and `STATUS.md` (twice: "Does NOT clear the
  underlying wedged level-2 compaction - still open ops work"). Verified the
  mechanism itself against the pinned litestream source
  (`db.go`'s `DB.ResetLocalState`): it removes only `db.LTXDir()` (the local
  `ltx/` directory) and an in-memory cache — it has no B2/S3 call anywhere
  in its body, confirming the existing docs' claims are accurate as written.
  No doc edits were made for this item; this section is the record of having
  checked rather than assumed.
- **litestream's INFO-level log volume is low by design**, confirmed by
  reading `store.go`/`db.go`: routine compaction no-ops and successful
  60-second syncs are logged at DEBUG (never emitted at the default level),
  so the new `litestream-runtime.log` stays near-empty under healthy
  operation and grows meaningfully only during an actual incident — this is
  what makes skipping offset-tracking/rotation (see Decisions above) a
  reasonable trade rather than a latent unbounded-growth bug.
