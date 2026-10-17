# 2026-10-15 — Restart sweep boot grace, instance scope, drain adoption (ST-8)

## Context & Objective

PR #3138 sweeps every `strategy_runs` row that started before this process booted, on the first tick, and the scheduler runs that sweep before the leader gate.  A follower can close a run the leader still owns.  The same sweep fails the matching `strategy_run_requests` row before drain can adopt it.  ST-8 asks for the boot grace back, an instance-scoped sweep, and no pre-emption of drain adoption.

## Changes Made

The restart arm stays quiet for `RESTART_SWEEP_BOOT_GRACE_MS` (two minutes).  `insertStrategyRun` stamps `owner_instance` with this process's id (migration 95).  The pre-gate sweep passes `reapUnowned: false`, so a follower's UPDATE cannot match the leader's rows.  After the scheduler lease is held, a second sweep may reap other instances.  A pre-boot row with a `running` request that is not a restart retry is left for `processPendingStrategyRunRequests`.  A time-stale run this process owns is still swept at 30 minutes, even while its lock guard renews.  A live lease still protects a run this process does not own, on both arms.

- `src/lib/process-instance.ts` (new)
- `src/lib/scheduler-lease.ts`
- `src/lib/db.ts`
- `src/lib/db-execution.ts`
- `src/lib/strategy-run-retry.ts`
- `src/lib/scheduler.ts`
- `test/restart-sweep-instance-scope.test.ts` (new)
- `test/stale-running-runs.test.ts`
- `test/stale-running-runs-adoption-grace.test.ts`
- `test/strategy-run-restart-retry.test.ts`
- `test/scheduler-leader-heartbeat.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-10-15-restart-sweep-instance-grace.md`
- `scripts/check-shared-package-pin.mjs`
- `.github/workflows/shared-package-pin-check.yml`
- `test/shared-package-pin-check.test.ts`

## Decisions & Trade-offs

Boot grace is two scheduler ticks, not the old 30-minute wait.  Restoring the full 30 minutes would hide a wedged run this process owns, which is the stuck-run case #3138 fixed.  Grace applies only to the restart arm.

`reapUnowned` defaults false.  The leader opts in only after `acquireOrRenewLeadership` returns true.  Legacy NULL `owner_instance` rows are unowned, so a follower does not sweep them either.  The leader may, after the grace, and only when no live lease and no adoptable request are present.

Drain adoption is detected by a `running` `strategy_run_requests` row with `retry_of_run_id` NULL.  The drain drops a running retry instead of adopting it, so those rows are still swept.  The 30-minute stall arm does not skip adoptable requests.  A wedge that old is not a fresh adopt.

## Verification State

Run on this branch after the sweep change.

- `npm run lint` — exit 0.  854 problems (0 errors, 854 warnings), the existing warning baseline.
- `npx tsc --noEmit` — exit 0.
- Targeted vitest (`test/restart-sweep-instance-scope.test.ts`, `test/stale-running-runs-adoption-grace.test.ts`, `test/stale-running-runs.test.ts`, `test/strategy-run-restart-retry.test.ts`, `test/scheduler-leader-heartbeat.test.ts`, `test/persistence-hardening.test.ts`) — pass.
- `npm test` — 9380 passed, 51 skipped, 25 failed.  The 25 are outside this diff: LLM and notify tests that see a sandbox `OPENROUTER` / Pushover credential, Twelve Data and Alpha Vantage provider fixtures, `cpuprofile-summary` failing on Node's `.ts` loader, and `server-metrics` `usesLocalHost`.  None are in the sweep files.
- `npm run build` — exit 0.  Compiled with the existing warnings, 43 static pages.

Re-run after the `origin/main` merge (`df7e6d10`) and the check-pin token-order fix.

- `npm run lint` — exit 0.  854 problems (0 errors, 854 warnings).
- `npx tsc --noEmit` — exit 0.
- `npx vitest run test/shared-package-pin-check.test.ts` — 6 passed.
- `env -u GH_PACKAGES_TOKEN node scripts/check-shared-package-pin.mjs` — `OK: ST/UM/CT share @jaywedgeworth22/congress-trading-shared@2.7.1`.
- `npm test` — 9366 passed, 51 skipped, 26 failed.  The 26 are outside this diff: LLM and notify tests that see a sandbox credential, Twelve Data and Alpha Vantage provider fixtures, `cpuprofile-summary` on Node's `.ts` loader, data-catalog completeness, and `server-metrics` `usesLocalHost`.  None are in the sweep files or `test/shared-package-pin-check.test.ts`.
- `npm run build` — exit 0.

## Check-pin (shared failure on every PR in the burst)

`check-pin` on this PR, and on the other open PRs between 07:32Z and 07:55Z, failed the same way: `API rate limit exceeded for user ID 12656028` while reading `jaywedgeworth22/Congress.Trade` `VENDOR-PROVENANCE.md`, then `::error::cannot read private Congress.Trade vendor provenance; set GH_PACKAGES_TOKEN`.  ST and UM were already both `v2.7.1` at lock SHA `5084afb3ffb269e7e28e0c30c880cab7d93409e7`, which matches the public provenance file.  Congress.Trade is public.  The script preferred `GH_PACKAGES_TOKEN`, a shared user PAT, over the Actions `GITHUB_TOKEN`.  That PAT is user 12656028.  When the fleet burns its hourly budget, every PR that runs this check goes red, including money-path PRs that do not touch the pin.  The three same-token retries do not clear a primary rate limit.  The script now tries `GITHUB_TOKEN`, then `GH_TOKEN` if it differs, then the PAT.  A rate-limit response switches credentials immediately and is reported as a rate limit.

`origin/main` (`df7e6d10`, #4703 / #4708 / #4702) is merged with a merge commit.  Migration 95 stayed the only new migration.  No review threads were open.

## Review threads on the shepherd merges

A later merge of the Quiver coverage branch added `installPlaywrightSession`.  Its cookie origin was hardcoded to port 4201 while `playwright.config.ts` honors `PLAYWRIGHT_PORT`.  The cookie now uses the same derivation.  Two Kody notes asked for a `visual-tests/` screenshot of the retired-lanes footnote.  That assertion is already in `test/e2e/visual.spec.ts`, which is this repo's Playwright visual suite.  The Auth.js smoke secret now uses `resolvePlaywrightAuthSecret()` (`test/e2e/playwright-auth-secret.ts`): local runs keep the shared fixture so webServer `AUTH_SECRET` and the test JWT match; CI requires `PLAYWRIGHT_AUTH_SECRET` (set per run in `.github/workflows/e2e.yml`).  Vitest `verify` must not import that resolver at module load: `playwrightBaseURL` moved to `test/e2e/playwright-base-url.ts`, and `installPlaywrightSession` resolves the secret only when e2e runs.  Screenshot threads stay open with defer replies only.

## Next Steps & Blockers

PR #4701 stays ready for review with `do-not-automerge`.  Auto-merge stays off.  Jay squash-merges.  Resolve ST-8 only after the fix has shipped.  Hosted `verify-hosted` passed on workflow_dispatch after `6ca8d224` (cloud-proxy pushes still need `gh workflow run ci.yml --ref cursor/restart-sweep-boot-grace-ab92`).  Kody `@kody start-review` after that commit failed with MiniMax-M3 unavailable; the prior `CHANGES_REQUESTED` on the Playwright secret thread remains until Kody can approve.

## Zero-Code Findings

Agent-Sync MCP Linear tools are not enabled for the CURSOR seat (`LINEAR_SEATS`).  The claim went through the fleet `board` CLI as CURSOR, which `board whoami` verified against `LINEAR_CURSOR_CLIENT_ID`.  Zulip `agent-sync whoami` has no key on this seat.

## Merge-main (MM takeover, 2026-10-16)

Cursor's agents hit their quota, so MM landed this branch.  The prior two
paragraphs above are Cursor's own record and are left as written; this section
is the takeover.

`origin/main` (`a5d45401e`) is merged with a merge commit — no rebase, no force-push.

**Migration renumbered 95 → 96.**  `main` already spent version 95 on
`strategy_runs_user_started_index` (the ops snapshot seek).  ST-8's
`strategy_runs_owner_instance` was also numbered 95, so the two migrations
collided in `src/lib/db.ts`.  Both are kept; ST-8's is now 96, and the twelve
`getSchemaVersion` / `applyVersionedMigrations` assertions in
`test/persistence-hardening.test.ts` move to 96.  The earlier note that
"migration 95 stayed the only new migration" described the pre-`a5d45401e` state.

**`test/e2e/visual.spec.ts`** — both sides are kept.  `main` added three console
header dropdown specs (`header-account-dropdown`, `header-notifications-dropdown`,
`header-profile-menu`); this branch added `installPlaywrightSession` to the login
and admin specs.  All four tests from `main` survive alongside the ST-3854
retired-lanes footnote spec and the session installs.  The login spec keeps its
session install: `/login` is in `PUBLIC_PREFIXES` (`middleware.ts:68`) and
`app/login/page.tsx:43` documents that there is deliberately no
"already signed in → redirect" branch, so the cookie cannot change that render
and the committed `login.png` baseline stays valid.

## Screenshot threads (the two unresolved ones)

Both unresolved threads ask for a Playwright screenshot of the new
`data-testid="enrichment-coverage-retired-lanes"` paragraph.  The coverage
exists and is committed: `test/e2e/visual.spec.ts` routes
`**/api/admin/enrichment-coverage**` to a populated `retiredLaneFields`
response, asserts the footnote is visible and contains a lane name, freezes
motion, and calls `toHaveScreenshot("enrichment-coverage-retired-lanes-footnote.png")`
against the committed baseline
`test/e2e/visual.spec.ts-snapshots/enrichment-coverage-retired-lanes-footnote-chromium-linux.png`.
Kody asked for a new `visual-tests/enrichment-coverage.spec.ts`; this repo's
convention is a single `test/e2e/visual.spec.ts` (per `AGENTS.md`), so the spec
was added there rather than in a second file.  The threads stay open until Kody
re-reviews the current head.

## Merge-main round 3 — the silent duplicate migration (MM, 2026-10-16)

PR #4720 merged to `main` as `4eae1fea`, and its squash brought the text-payload
codec with it.  That codec's schema migration is **also** numbered 96.

Merging `main` into this branch produced **no textual conflict**, which is what makes
this one worth writing down.  `git merge` reported a clean merge and `src/lib/db.ts`
happily ended up with two migration objects both declaring `version: 96`:
`text_payload_codec_columns` and `strategy_runs_owner_instance`.  Nothing in the
merge output complains, and a reviewer reading the diff would not necessarily
notice.  The runtime applies migrations in version order and would run the first and
skip the second, leaving `strategy_runs.owner_instance` unadded while every test
that asserts a schema version still passes.

ST-8's migration is renumbered to **97**, and the twelve
`getSchemaVersion` / `applyVersionedMigrations` assertions in
`test/persistence-hardening.test.ts` move to 97.

So ST-8's migration has now been renumbered twice: 95 collided with
`strategy_runs_user_started_index`, and 96 collided with #4720's codec columns.
The general lesson for the next agent taking over a long-lived branch: **after
every merge from `main`, re-check that migration versions are still unique**, and
do not trust a clean textual merge as evidence that the schema is coherent.

Verified after the renumber, in the repo-mandated order:

- `npm run lint` — exit 0 (871 warnings, 0 errors).
- `npx tsc --noEmit` — exit 0.
- `npm test` — 13 failures, all outside this diff and all reproduced
  identically on an unmodified `origin/main` checkout, so they are a sandbox
  credential-environment artifact rather than a regression from the renumber.
  They are `test/llm-provider.test.ts`, `test/openrouter-credits.test.ts`,
  `test/framework-review.test.ts` and `test/chat-llm.test.ts` — provider
  resolution and credit tests that assert a key is *absent* and find one
  present in this environment.  Every file this branch touches passes,
  including `test/persistence-hardening.test.ts` (the twelve renumbered
  version assertions) and `test/text-payload-codec.test.ts` from `main`.
- `npm run build` — exit 0.

## Merge-main round 4 — ST-3854 half now comes from `main` (CLAUDE, 2026-10-17)

`origin/main` (`b39ed8a7d`) is merged with a merge commit — no rebase, no force-push.
It brings #4707 (ST-3854), #4739 (ST-4542), #4784 and #4805.

**#4707 landed the ST-3854 half of this branch with a different final design.**
This branch had been carrying an earlier iteration of the ST-3854 work (the
second half of the PR description).  #4707 shipped it with the smoke harness
deliberately left auth-unconfigured and the admin footnote visual in its own
suite: `playwright.admin.config.ts`, `test/e2e/admin-enrichment-coverage-visual.spec.ts`,
`test/e2e/playwright-admin-auth.ts` and a generated per-run CI secret in
`.github/workflows/e2e.yml`.  The merge conflicted in `playwright.config.ts`,
`test/e2e/playwright-session.ts` and the ST-3854 rollout note (add/add).

All three conflicts, and the rest of this branch's ST-3854 e2e scaffolding, take
`main`'s version, because `main` is the landed, final form of the same feature.
Keeping both sides would have put `AUTH_SECRET` back into the default smoke
harness that #4707 deliberately removed, and run the footnote visual twice.  It
would also have left two `PLAYWRIGHT_AUTH_SECRET` sources in `e2e.yml`.

- Taken from `main`: `playwright.config.ts`, `test/e2e/playwright-session.ts`,
  `docs/rollouts/2026-10-15-st-3854-quiver-coverage-sanitize.md` (main's copy is a
  superset of this branch's), `test/e2e/visual.spec.ts`,
  `test/e2e/console-a11y.spec.ts`, `test/e2e/dashboard-smoke.spec.ts`,
  `.github/workflows/e2e.yml`.
- Removed as superseded: `test/e2e/playwright-auth-secret.ts`,
  `test/e2e/playwright-base-url.ts`, `test/playwright-auth-secret.test.ts`,
  `test/playwright-base-url.test.ts`, and
  `test/e2e/visual.spec.ts-snapshots/enrichment-coverage-retired-lanes-footnote-chromium-linux.png`
  (main keeps the same baseline under the admin spec's snapshot folder).

The "Review threads on the shepherd merges" and `visual.spec.ts` paragraphs above
describe that earlier iteration and are left as written.  After this merge, the
PR's diff against `main` is ST-8 only.

**Migration check.**  `main`'s highest migration is still 96
(`text_payload_codec_columns`).  #4739 touched `src/lib/db.ts` (slow-call timing)
without adding a migration, so ST-8's `strategy_runs_owner_instance` stays **97**
and is unique.
