# Accounts Stranded Halted After a Transient Broker-Health Auto-Halt (Lane h5)

Board `687a5fb4`, seat CLAUDE, branch `claude/st-w3-h5`.

## 1. Context & Objective

Alpaca Paper (connected account `4f7c96ba-4d47-45cc-abea-6e4f155aee38`, the owner's Autopilot
account) was auto-halted at 2026-09-25 18:20:24Z by "Broker health check timed out"
(`broker_placement_auto_halted`, active to halted).  Earlier that day the same pattern
auto-resumed within minutes.  After 18:20Z it stayed halted for four days, with no runs, until an
operator re-armed it through `/api/ops/account-control` on 2026-09-29 22:41Z.  In between, #3752
merged (2026-09-26 00:35Z) and deployed, and there were several weekend deploys and restarts.

Objective: find why the auto-owned pause never lifted, make an AUTO-owned health halt lift by
itself once the broker is healthy (including across restarts and deploys) while an OWNER halt never
auto-lifts, and, where a deploy halts an armed account by the owner's own setting, make that
visible and honest instead of silent.

## 2. Changes Made

**Root cause.**  The only thing that removes a broker auto-pause marker without an owner or operator
action is the boot autonomy interlock (`reconcileAutonomyOnBoot`), and it does so only when the
user's "Auto-resume on boot" setting (`getAutoResumeOnBoot`, default off) is off and
`AUTONOMY_RESUME_ON_BOOT` is not `1`.  #3752 added that release deliberately: with the setting off,
a restart stops every Running account until a person starts it again, and an auto-paused account is
an armed account.  So on the first boot that ran #3752 (the deploy right after it merged), the
interlock took the auto-resume away from Alpaca Paper and handed the halt to the owner.  Every later
restart found a plain halted account and did nothing.  With the setting on, the interlock skips the
user entirely, the marker survives, and the next healthy probe resumes the account: pinned by a new
test.

What was actually broken is that nothing said any of this:

- the console showed a bare "Stopped", identical to a manual stop;
- the ops snapshot had no boot setting and no halt reason, so the operator could not tell a
  restart halt from an owner halt;
- the boot notification titled the event "Broker auto-pause kept after restart", which reads as
  "still resuming by itself" when the restart had just removed the auto-resume.

**Fix.**

- New `src/lib/autonomy-halt-cause.ts`.  The boot interlock now writes a per-account receipt
  (`autonomy:boot-halted:<user>:<account>`) when it halts a Running account or ends a broker
  auto-pause.  `describeAutonomyHaltCause` turns durable state into one answer for a halted
  account: `broker_auto_pause` (resumes by itself on the first healthy probe), `restart` (stays
  halted until someone re-arms it; says whether Auto-resume on boot is on now), or `stopped` (a
  person, or no record).  Summaries use Central Time and two spaces between sentences.
- `src/lib/scheduler.ts`: the interlock records receipts; every tick drops a receipt once the
  account is no longer halted (read-only unless there is one to drop), so a later manual stop is
  never blamed on an old restart.  Notification copy: the auto-pause title is now "Restart ended
  the broker auto-pause: <label> stays stopped", and every body says nothing starts by itself,
  how to start it (Start Agent), and how to keep accounts running through deploys (Settings, After
  a restart, Auto-resume on boot).
- `src/lib/ops-snapshot.ts`: each user now carries `autoResumeOnBoot` (true when the env override
  is set), and each account a `haltCause`.
- `src/lib/ops-account-control.ts`: `describeNextEligibleRun` adds a "Why halted:" note (account
  number redacted); `set_system_state` clears the receipt with the marker in the same transaction
  and reports `restartHalt` and `clearedRestartHalt`.
- `src/lib/dashboard.ts` + `app/dashboard-types.ts`: the console snapshot carries `haltCause` for
  the viewed account (optional field; null when not halted or on lookup failure).
- `app/console/lib/derive.ts` + `app/console/components/chrome.tsx`: `withHaltCause` folds the cause
  into the top-bar run-state chip ("Stopped · auto-paused" in amber, "Stopped · by restart"), its
  tooltip, the Start Agent tooltip, and a sentence at the top of the control sheet.  The shared
  run-state word stays "Stopped".
- Docs: `docs/runbooks/ops-account-control.md` documents the owner setting and the halt causes.

Files touched:

- `src/lib/autonomy-halt-cause.ts` (new)
- `src/lib/scheduler.ts`
- `src/lib/ops-snapshot.ts`
- `src/lib/ops-account-control.ts`
- `src/lib/dashboard.ts`
- `app/dashboard-types.ts`
- `app/console/lib/derive.ts`
- `app/console/components/chrome.tsx`
- `test/autonomy-halt-cause.test.ts` (new)
- `test/scheduler-boot-halt-notify.test.ts`
- `docs/runbooks/ops-account-control.md`
- `docs/rollouts/2026-09-30-st-w3-h5-restart-halt-visibility.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- **The owner's setting decides, and it is not flipped here.**  The Settings copy the owner agreed
  to says "whenever the server restarts, any Running account is stopped until a person starts it
  again, a restored backup or crash-loop can never silently resume trading."  Letting an
  auto-paused account survive a restart while an active one is halted would reopen the hole #3752's
  review closed (a restored backup resuming an auto-paused account on its first healthy probe) and
  would make the outcome depend on whether the broker happened to blip at deploy time.  So: with
  Auto-resume on boot ON (or `AUTONOMY_RESUME_ON_BOOT=1`) an auto-owned halt survives any number of
  restarts and lifts on the first healthy probe; with it OFF a restart stops the account by design,
  and every surface now says so and says how to change it.  The owner's value was not changed.
- **Receipt, not audit archaeology.**  Console and `/api/policy` state changes are not all audited,
  so deriving the cause from `audit_events` could not tell a later owner stop from the restart.  A
  small internal setting, cleared when the account leaves halted, is exact.
- **Known edge.**  An owner Stop pressed on an account that is already restart-halted leaves the
  receipt until the account is re-armed, so the cause still reads "stopped by the restart".  That
  is still true (it is stopped, and Start Agent re-arms it); not worth touching the pause routes.
- **Run-state vocabulary unchanged.**  `RunStateWord` is shared with iOS, so the word stays
  "Stopped"; only the chip label, tone and a cause sentence change.  No iOS change.

## 4. Verification State

Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`); host load average 300 to 400 throughout.

```bash
npx tsc --noEmit -p .                     # exit 0, 0 errors (55 min wall clock under load)
npx eslint src/lib/autonomy-halt-cause.ts src/lib/scheduler.ts src/lib/ops-snapshot.ts \
  src/lib/ops-account-control.ts src/lib/dashboard.ts app/dashboard-types.ts \
  app/console/lib/derive.ts app/console/components/chrome.tsx \
  test/autonomy-halt-cause.test.ts test/scheduler-boot-halt-notify.test.ts
                                          # 0 errors, 4 pre-existing warnings
npx vitest run test/autonomy-halt-cause.test.ts --testTimeout=900000 --hookTimeout=900000
                                          # 10/10 passed
npx vitest run <temp copies of broker-health-probe-resilience, ops-account-control, ops-snapshot> \
  test/scheduler-boot-halt-notify.test.ts --testTimeout=1800000 --hookTimeout=1800000
                                          # 4 files, 67/67 passed
```

The three adjacent suites hard-code 120s to 300s `beforeAll` timeouts that a cold import misses at
this load (the first resilience run timed out in its hook, not an assertion), so they were run from
temporary copies with only that number raised, then deleted.  The first full `tsc` started before
the last small scheduler edit and the new test file, so a second `tsc` over the touched files and
their import graph ran on the final tree (see the PR body).  Full `npm test` and `npm run build`
were not run locally under this load; the required CI `verify` check is the binding gate.

## 5. Next Steps & Blockers

- **Owner decision:** if Autopilot should keep running through deploys, turn on Settings, After a
  restart, Auto-resume on boot (or run `npx tsx scripts/set-autopilot-accounts.ts --apply`, which
  also re-arms the named accounts).  This lane did not change it.
- After this deploys, `bash scripts/fetch-prod-ops-snapshot.sh` shows `autoResumeOnBoot` for the
  owner and `haltCause` for each halted account; confirm the owner's current value there.  The
  2026-08-13 effort-log row recorded it as true, but the stranding is only possible with it off,
  so it was off by 2026-09-26.

## 6. Zero-Code Findings

- Halted accounts ARE probed every tick: the scheduler's broker-health gate runs before its
  `systemState !== "active"` skip, and `deriveExecutionState` does not depend on `systemState`.  A
  probe that never re-runs is not the cause.
- No weekend or closed-market gate sits in front of the health gate; Alpaca's account API answers
  on weekends.  Market hours are not the cause.
- The marker scope matches: the 18:20Z halt came from the scheduler gate
  (`healthSignalsFromProbeFailure` is scheduler-only), scoped by connected-account id, the same
  scope the resume and the boot release use.
- Pre-#3752 code never released the marker at boot, so an auto-paused account survived restarts
  even with the setting off (a bypass of the setting).  Between 18:20Z and the first #3752 boot the
  marker was still in place and the account still did not resume; the likeliest reason is that the
  probe kept failing in those hours (pre-#3752 a stalled-loop timeout was not attributed to the
  process), which this lane cannot verify without production audit rows.  From that boot on, with
  the marker gone, no healthy probe could have resumed it.
