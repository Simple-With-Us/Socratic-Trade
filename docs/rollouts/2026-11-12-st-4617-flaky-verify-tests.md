# ST-4617: flaky verify tests

## Context & Objective

Required `verify` was going red on main and in the merge queue because two proxy-gate assertions sampled wall-clock `Date.now()` during an immediate slot grant.  A loaded host can tick 1 to 4 ms inside that synchronous pump, so the tests reported a queue wait that never happened.

## Changes Made

The clock in those cases is frozen, and it advances only for a waiter that is actually queued.  Immediate grants must report `waitMs` 0 and must not call `onQueueWait`.  A 70 ms queue reports 70, and a 300 ms queue reports 300, which is stricter than the old `>= 40` and `>= 200` bounds.  `src/lib/proxy-fetch.ts` is not edited.  Open PRs #5146 and #5125 already change that file.

- `test/proxy-concurrency-gate.test.ts` — fake timers for the immediate-grant and queued-wait cases.
- `STATUS.md` — snapshot for this fix.
- `PLAN.md` — no roadmap change.
- `docs/rollouts/2026-11-12-st-4617-flaky-verify-tests.md` — this note.

## Decisions & Trade-offs

The old `toBeLessThan(5)` bound on an immediate grant was a loosened wall-clock check.  It still fails if the tick reaches 5 ms, and a 250,000-grant probe under CPU pressure already saw 4 ms.  Freezing the clock keeps `toBe(0)` and `onQueueWait` empty, which is the behavior the tests were written to prove.

`test/public-sentence-gap.test.ts` is unchanged.  Run 42937502799 failed it on `gb-engineer/st-2789-nonce-csp` (`7366a4ac`) because `WelcomePage` awaited `readRequestCspNonce()`, and `renderToStaticMarkup` throws when that render suspends.  Commit `7227e6b1` put `/welcome` back on hourly ISR with no per-request nonce, and that commit is on main.  Repeated shuffled runs of the file on this branch stayed green.

`test/signal-health.test.ts` failed three assertions on the two 2026-11-06 scheduled main runs (42239084947 and 42242600786) and did not fail on the later main or merge-queue runs checked here.  The lane injects its own `now`.  Ten shuffled reruns on current main passed, so the file was left as it is.

Other red CI in the same window was not this class.  `gb-engineer/st-4596-ios-keychain-app-lock` failed `verify` repeatedly on that branch.  Run 42467602235 failed `verify-ios` while `verify-hosted` succeeded.  Run 41861169800 cancelled `verify-ios` after a green hosted job.

## Verification State

Before the test change, under four busy loops:

- `ProxyConcurrencyGate` immediate `acquire`: 29 of 250,000 grants had `waitMs` > 0 (max 4).
- `createProxiedFetch` immediate call: 25 of 20,000 calls invoked `onQueueWait` (max 4).

After the change:

- 50 shuffled runs of `test/proxy-concurrency-gate.test.ts` and `test/public-sentence-gap.test.ts`, alternating `--pool=forks` and `--pool=threads`, with `--maxWorkers` 1 or 2: 50 passed, 0 failed.
- 8 pairs of those files run at the same time (forks plus threads): 8 passed, 0 failed.
- 10 shuffled runs of the same files under four CPU burners: 10 passed, 0 failed.
- 10 shuffled runs of `test/signal-health.test.ts`: 10 passed, 0 failed.

Full gate on this branch, after the clock freeze:

- `npm run lint` exited 0 (869 existing warnings, 0 errors).
- `npx tsc --noEmit` exited 0.
- `npm test` exited 0: 901 files passed, 1 skipped, 10245 tests passed, 42 skipped, duration 1363.84s.
- `npm run build` exited 0, including the CSP static-hash stamp.

The unit-test process did not inherit this seat's injected provider, Coolify, Resend, or Usage Monitor credentials.  Those variables make fetch-counting and "not configured" tests fail locally while CI, which does not set them, stays green.

## Merge with origin/main

`origin/main` is merged into this branch periodically with merge commits (no rebase), whenever GitHub marks the pull request dirty or behind.  The pull request's commit list is the record of which `main` commits are in.  `STATUS.md` and `PLAN.md` are the only paths both sides edit, and both files use the `merge=union` driver.  The first merge produced no conflict markers, and every heading from both parents remained, including the ST-4617 entry and the ST-4595 entry.

Verification on the first merged tree, Node 26.13.1:

- `npx vitest run test/proxy-concurrency-gate.test.ts test/cloudflare-origin-lock.test.ts test/health-liveness-await.test.ts test/liveness-warning-escalation.test.ts test/run-failure-watchdog.test.ts` exited 0 (5 files, 67 tests).
- `npx tsc --noEmit` exited 0.
- `npm run lint` exited 0 (869 existing warnings, 0 errors).

Review threads on pull request #5159 are answered and resolved on the pull request itself.

## Next Steps & Blockers

The branch tracks `origin/main` through those periodic merges.  Wait until required `verify` is green.  Do not merge, enable auto-merge, rebase, force-push, or deploy.

## Zero-Code Findings

The welcome-page suspense error was branch-caused by an async server render, and current main does not suspend in that test.  The Nov 6 signal-health failures did not reproduce.
