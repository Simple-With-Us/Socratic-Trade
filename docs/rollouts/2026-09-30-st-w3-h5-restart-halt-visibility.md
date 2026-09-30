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

**Root cause (a hypothesis, not established; see Review round).**  Two mechanisms fit the evidence,
and this lane cannot tell them apart without production audit rows, which it did not read:

- **H2, leading: the pre-#3752 stale-snapshot drop.**  Before #3752, `applyBrokerOrderPlacementPause`
  decided on the CALLER's policy snapshot.  A caller that read "active" before the 18:20:24Z halt
  (the scheduled run `cf155501`, in flight 17:32Z to 18:32Z, whose entries were then blocked by the
  fresh-state check at 18:32:45Z, or an overlapping tick left behind by the tick watchdog) and then
  got a healthy probe took the "owner already re-armed" branch: it dropped the auto-resume marker,
  did not resume, and wrote no audit row.  From then on nothing could resume the account.  #3752's
  durable re-read closed this path; a new test pins it.
- **H1, the original theory: the boot interlock at the #3752 deploy.**  With "Auto-resume on boot"
  off, the first boot running #3752 (2026-09-26) ends every broker auto-pause and hands the halt to
  the owner.  Against it: on 2026-09-24, 11 runs were killed by restarts and Alpaca Paper kept
  starting new scheduled runs after each boot, which the interlock would have prevented with the
  setting off (the 2026-08-13 effort-log row also records it on).  H1 also leaves 18:20Z to the
  first #3752 boot (about 6 hours on pre-#3752 code, no boot release) unexplained.

Either way, the defect the owner saw is the same: nothing said what was holding the account.

- The console showed a bare "Stopped", identical to a manual stop.
- The ops snapshot had no boot setting, no halt reason, and none of the broker auto-pause audit
  kinds, so the operator could not tell these cases apart.
- The boot notification titled the event "Broker auto-pause kept after restart", which reads as
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
- Review round additions (details in section 7): the auto-pause cause carries the last failed
  probe and warns when a restart would end it; drawdown-breaker halts and auto-pauses whose resume
  record vanished are named from the audit trail; the fallback no longer blames a person; every
  connected account (switcher and Brokers rows) carries its cause; the auto-halt notification and
  the Settings card say a restart ends an auto-pause when the setting is off; the ops snapshot
  lists the auto-pause audit kinds; wiring tests for the tick, the ops route, and the snapshot.

Files touched:

- `src/lib/autonomy-halt-cause.ts` (new)
- `src/lib/scheduler.ts`
- `src/lib/ops-snapshot.ts`
- `src/lib/ops-account-control.ts`
- `src/lib/dashboard.ts`
- `app/dashboard-types.ts`
- `app/console/lib/derive.ts`
- `app/console/components/chrome.tsx`
- `src/lib/broker-health.ts` (review round: last failed probe on the marker, honest auto-halt note)
- `app/console/settings/brokers.tsx`, `app/console/settings/page.tsx` (review round)
- `test/autonomy-halt-cause.test.ts` (new)
- `test/scheduler-boot-halt-notify.test.ts`
- `test/scheduler-halt-cause-tick.test.ts`, `test/dashboard-halt-cause.test.ts` (new, review round)
- `test/ops-account-control.test.ts`, `test/console-brokers-account-visibility.test.tsx` (review round)
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
- **Receipt first, audit trail only as a fallback.**  Console and `/api/policy` state changes are
  not all audited by kind, so the restart cause stays a receipt, cleared when the account leaves
  halted.  The review round adds an audit fallback only for halts the APP made before any receipt
  existed (drawdown breaker, broker auto-halt): it names them only when no later row re-armed the
  account (`policy_change` to a non-halted state, `broker_placement_auto_resumed`) or handed the
  halt to someone (`broker_placement_pause_owner_override`, a non-dry-run ops `set_system_state`,
  `autonomy_halted_on_boot`).  Otherwise it says the app has no record, never "a person".
- **No self-heal from the audit trail.**  An auto-pause whose marker vanished is named
  (`auto_pause_lost`) but never auto-resumed: pre-#3752 owner stops on an auto-paused account wrote
  no distinguishing row, so resuming on audit evidence could lift an owner's halt.
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
  owner, `haltCause` for each halted account, and the broker auto-pause audit kinds.  Confirm the
  owner's current value there.
- **Confirming the root cause (operator, read-only prod query; this lane did not run it).**  For
  `connected_account_id = '4f7c96ba-4d47-45cc-abea-6e4f155aee38'` and `created_at` between
  2026-09-25T18:20Z and 2026-09-29T23:00Z, list kinds `broker_placement_auto_resumed`,
  `broker_placement_pause_owner_override`, `autonomy_halted_on_boot`, `ops_account_control`, plus the
  owner's `auto_resume_on_boot` rows (user-level) since 2026-08-13:
  - H1 predicts a `broker_placement_pause_owner_override` with `source: "boot-autonomy-interlock"`
    at the first #3752 boot, and a setting that was off then.
  - H2 predicts no override row, and the 22:41Z ops `set_system_state` row reporting
    `clearedBrokerAutoPause: false` (the marker was already gone).
  - `clearedBrokerAutoPause: true` on that row would rule both out: the marker survived four days,
    so probes never came back healthy or never ran, and the lane's `lastProbeAt` now shows which.

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
  even with the setting off (a bypass of the setting).  The only pre-#3752 code that removed the
  marker was inside `applyBrokerOrderPlacementPause`: the audited resume, and the silent "snapshot
  is not halted" branch that H2 uses.
- An audit dump taken 2026-09-25 19:22Z (one hour after the halt, read by the parent session) shows
  the halt, the 18:20:56Z skip row, and the in-flight run's 18:32Z blocked entries, then no resume,
  no owner override, and an `account_strategy_state` row last written at the halt.  It cannot say
  whether the marker was still there.

## 7. Review Round (2026-09-30)

Six P2 findings on PR #4008.  Each was checked against the code and the evidence on disk; all six
were real, and all six are fixed in this round.  No finding was declined.

1. **Root cause asserted but contradicted; the likely mechanism had no test.**  Verified.  The
   2026-08-13 effort-log row records `autoResumeOnBoot=true`, and on 2026-09-24 Alpaca Paper kept
   starting scheduled runs after each of 11 restart-killed runs, which the boot interlock would have
   stopped with the setting off.  The only pre-#3752 code that removed the marker was inside
   `applyBrokerOrderPlacementPause` (the audited resume and the silent "snapshot is not halted"
   branch), which also explains 18:20Z to the first #3752 boot.  Fixed: section 2 now states H1 and
   H2 as hypotheses with the evidence for and against, section 5 lists the read-only prod query that
   decides it (not run by this lane: no production access), and a new test pins the H2 hole (durable
   halted plus marker, caller snapshot `active`, healthy probe: resumed, marker cleared).
2. **Auto-pause cause promised self-resume that the next deploy would revoke.**  Verified: with the
   setting off, the next boot's interlock releases the marker.  Fixed: the `broker_auto_pause` cause
   carries `autoResumeOnBootNow` and, when it is off, says a restart or deploy before the broker
   recovers ends the auto-pause and leaves the account stopped.  The auto-halt notification note
   says the same (`autoHaltNotificationNote`).  The Settings card (After a restart) now says
   auto-paused accounts lose their auto-resume too.
3. **Root cause inferred, and a recurrence would look identical.**  Verified (same evidence as 1).
   Fixed: hypothesis wording in the note, STATUS.md, the effort log and the PR body.  Every failed
   probe while an auto-pause holds the account is now recorded on the marker (`lastProbeAt`,
   `lastProbeReason`) and surfaced in `haltCause` and its summary, so a pause whose probes keep
   failing reads differently from one whose probes stopped.  The ops snapshot's `recentAudit` now
   includes the auto-pause lifecycle kinds and `auto_resume_on_boot`.
4. **Breaker halts mislabeled "Stopped by a person".**  Verified: the drawdown breaker with hard
   action `halted` writes `policy_violation_drawdown` with `revertedTo: "halted"` and no marker or
   receipt.  Fixed: a `breaker` cause read from the audit trail (only while nothing later re-armed or
   took over the account), an `auto_pause_lost` cause for an auto-halt whose marker vanished, and a
   fallback that says the app did not record who or what stopped it.
5. **Console cause only for the loaded account.**  Verified: the switcher and Brokers rows used
   `connectedAccountPolicies`, which had no cause.  Fixed: each halted account in
   `connectedAccountPolicies` carries `haltCause`; the switcher and Brokers chips fold it in
   (`withHaltCause`) with a SENTENCE_GAP-safe tooltip (`stateChipTitle`).
6. **New ops and scheduler wiring untested.**  Verified.  Fixed:
   `test/ops-account-control.test.ts` (receipt cleared with `active`, `halted` and `close_only`,
   `restartHalt` and `clearedRestartHalt` in the response and the ops audit row, dry run keeps it),
   `test/scheduler-halt-cause-tick.test.ts` (the REAL tick drops a receipt after the account leaves
   halted and keeps it while halted; probes a halted auto-paused account and records the failed
   check; auto-halt, restart, healthy tick resumes with the setting on while a manual halt stays
   halted; with it off the restart ends the auto-pause and the cause says so), and
   `test/dashboard-halt-cause.test.ts` (the snapshot carries the loaded account's cause and each
   other halted account's cause; running accounts carry none).

Not changed, on purpose: no self-heal of an `auto_pause_lost` account from the audit trail
(section 3), and the owner's Auto-resume on boot value.
