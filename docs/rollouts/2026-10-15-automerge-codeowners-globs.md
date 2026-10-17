# 2026-10-15 — Auto-merge uses CODEOWNERS globs (ST-3326)

## Context & Objective

ST-3326: `.github/workflows/auto-merge-prs.yml` must not arm auto-merge on a PR that touches money-path files or carries `do-not-automerge`, and it must disarm auto-merge that was already armed.  PR #4221 added that gate, but production runs fail-closed before the globs are read.  `gh api --jq -r '.content // empty'` passes two arguments.  `gh` exits `accepts 1 arg(s), received 2`, and every non-draft same-repo PR is treated as protected.  The CODEOWNERS list never decides anything.

## Changes Made

- Fetch base CODEOWNERS with a single `--jq '.content // empty'` expression, and fail closed if that payload decodes empty or the step errors.
- Document the money-path globs in the workflow header.  They are the CODEOWNERS path patterns (owners stripped).  A test locks that comment to `.github/CODEOWNERS` and to `scripts/automerge-gate-dry-run.sh --list-globs`.
- Dry-run the arm/disarm decision with no GitHub calls.  Money-path files and `do-not-automerge` both print `arm=false` and `disarm=true`.  A docs-only diff prints `arm=true`.

Touched paths:

- `.github/workflows/auto-merge-prs.yml`
- `scripts/pr-touches-codeowners-paths.sh`
- `scripts/automerge-gate-dry-run.sh`
- `scripts/disable-pr-automerge.sh`
- `test/automerge-gate-dry-run.test.ts`
- `test/disable-pr-automerge.test.ts`
- `test/branch-protection-gate.test.ts`
- `STATUS.md`, `PLAN.md`, this rollout note

## Decisions & Trade-offs

- The glob list stays in CODEOWNERS.  The workflow comment is a mirror, not a second policy.  CI fails if they diverge.
- `disarm=true` means the workflow runs `gh pr merge --disable-auto` on a PR that was already armed.  The dry run does not call GitHub, and this lane does not arm auto-merge.
- `needs-human-merge` still disarms, same as `do-not-automerge`.
- A rejected elevated token retries disable once with the Actions `GITHUB_TOKEN`.  That token is not used to arm.  Disable jobs set `contents: write` and `pull-requests: write` so that token can call `disablePullRequestAutoMerge`.  The arm job stays at the workflow `contents: read` permission.
- If the disable mutation is still forbidden, the script reads `autoMergeRequest`.  Null is success (`already off`).  A non-null value, or an unreadable PR, exits 1.  PR #4697's disable jobs exited 1 while auto-merge was already null, because `GH_PAT` is 401 and `GITHUB_TOKEN` returned `Resource not accessible by integration`.
- The dry run exports `CODEOWNERS_FILE` to the repo copy so it still classifies when the shell is not at the repo root.  Sentry's review on #4697 asked for that export.  It is in `scripts/automerge-gate-dry-run.sh`.
- `test/disable-pr-automerge.test.ts` passes `NODE_ENV: "test"`.  Next's `ProcessEnv` requires that literal, and hosted `tsc` failed the #4697 head without it.
- Out of scope: a ruleset required review on those paths, and rotating `GH_PAT` / `SHEPHERD_TOKEN` (ST-4393).  This change stops the workflow from arming money-path PRs.  It cannot disarm an already-armed PR while every token is rejected.

## Money-path globs

```
/src/lib/broker.ts
/src/lib/broker-*.ts
/src/lib/public-broker.ts
/src/lib/alpaca.ts
/src/lib/alpaca-*.ts
/src/lib/tradier.ts
/src/lib/robinhood.ts
/src/lib/etoro.ts
/src/lib/etoro-*.ts
/src/lib/webull.ts
/src/lib/kalshi.ts
/src/lib/kalshi-*.ts
/src/lib/order-*.ts
/src/lib/option-orders.ts
/src/lib/stale-limit-orders.ts
/src/lib/proposal-*.ts
/src/lib/execution*
/src/lib/db-execution.ts
/src/lib/db-proposals.ts
/src/lib/strategy-execution.ts
/src/lib/strategy-run-execution-registry.ts
/src/lib/trading-liveness.ts
/src/lib/tradingview-trigger.ts
/src/lib/scheduler.ts
/app/api/orders/
/app/api/proposals/
```

## Verification State

```bash
npx vitest run test/automerge-gate-dry-run.test.ts test/pr-touches-codeowners-paths.test.ts test/branch-protection-gate.test.ts
```

18 passed.

Live dry run of the fixed fetch against the eslint renovate compare (`1c730fff...558a417e`, `package.json` and `package-lock.json` only): classifier exit 1, `arm=true`, `disarm=false`.  The previous workflow run on that PR fail-closed and skipped `auto-merge` (`actions/runs/38693247210`, log line `accepts 1 arg(s), received 2`).

```bash
bash scripts/automerge-gate-dry-run.sh --files src/lib/broker.ts
bash scripts/automerge-gate-dry-run.sh --label do-not-automerge --files README.md
bash scripts/automerge-gate-dry-run.sh --files README.md
```

Money path: `arm=false` `disarm=true`.  `do-not-automerge`: `arm=false` `disarm=true`.  README: `arm=true` `disarm=false`.

Full `npm run lint` exit 0 (0 errors, 854 warnings).  `npx tsc --noEmit` exit 0.  `npm test` 9378 passed, 51 skipped, 25 failed across 12 files.  None of the failures are in the auto-merge classifier, dry run, or workflow text tests.  They are the sandbox LLM-key, notify-credential, server-metrics host, cpuprofile, Twelve Data, and Alpha Vantage failures.  `npm run build` exit 0.

Follow-up after that gate: live `disable-auto` on PR #4697 returned `401 Bad credentials` and the job still exited 0.  `scripts/disable-pr-automerge.sh` retries once with `DISABLE_AUTOMERGE_FALLBACK_TOKEN` (the Actions `GITHUB_TOKEN`).  The retry on that PR then returned `Resource not accessible by integration` and exited 1 even though `autoMergeRequest` was null.  Hosted `tsc` also failed because the test env omitted required `NODE_ENV`.

This branch (`cursor/automerge-money-path-gate-c050`) merges current `main` and fixes both.  A forbidden disable is success only after a read shows auto-merge is off.  A still-armed PR fails.

```bash
npx vitest run test/disable-pr-automerge.test.ts test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/pr-touches-codeowners-paths.test.ts
npx tsc --noEmit
```

25 passed.  `tsc` exit 0 (2026-10-15).  Merged `origin/main` at `3f4ef5e5` into `cursor/automerge-money-path-gate-c050` (PR #4727 conflict sweep); re-ran the same vitest slice and `tsc` clean.

```bash
bash scripts/automerge-gate-dry-run.sh --files src/lib/broker.ts
bash scripts/automerge-gate-dry-run.sh --label do-not-automerge --files README.md
bash scripts/automerge-gate-dry-run.sh --files README.md
```

Money path: `arm=false` `disarm=true`.  `do-not-automerge`: `arm=false` `disarm=true`.  README: `arm=true` `disarm=false`.

### 2026-10-15 CODEX landing pass after #4662

Checked PR #4727 head `c116c6738f14b0cb3c8d787b4e6285915e1fd6d1` before editing; no newer Cursor commit was present.  Merged current `origin/main` at `7bfb84ef193196f1b77c9bfe0573c012e656c8c0` with merge commit `a80b3564a77f428930eea5fd138f0038a9c49cf4`; no conflicts.  The unique PR diff remains 10 paths.

Verification on the merged head:

```bash
npm ci
npm run lint
npx tsc --noEmit
npx vitest run test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/disable-pr-automerge.test.ts
npm run build
```

Lint passed with 0 errors (866 existing warnings); TypeScript passed; focused Vitest passed (21 tests); production build passed with existing Next.js warnings.  The `do-not-automerge` label is present, and auto-merge remains unarmed.  This work is ready for Jay's review after the final CI run.

## CI follow-up (same day)

Merged `origin/main` (`df7e6d10`, #4703 / #4708 / #4702) with a merge commit, then `3f4ef5e5` (#4698) with a second merge commit.  No rebase.  No force-push.  #4698 already changed the pin check the same way.  The second merge keeps main's `isGithubRateLimit` / `ctReadTokens` copy.  The disable-job and `NODE_ENV` fixes stay on this branch.  `git merge-tree --write-tree` was clean.  `STATUS.md` and `PLAN.md` union-merged.

`check-pin` root cause, shared by every PR in the 2026-10-15 07:32-07:55 UTC window (money-path and otherwise, including `main`): `scripts/check-shared-package-pin.mjs` preferred `GH_PACKAGES_TOKEN` over the Actions `GITHUB_TOKEN`.  That secret is one user PAT for GitHub user 12656028.  Every concurrent pin check shares that user's REST budget.  When it is exhausted, `gh api` returns HTTP 403 `API rate limit exceeded for user ID 12656028` (this PR: request `D82C:1BBE27:4381472:DDDC128`, run `38699553078`).  The script then reported `cannot read private Congress.Trade vendor provenance; set GH_PACKAGES_TOKEN` even though the secret was set, Congress.Trade is public, and the ST and UM pins already matched at `v2.7.1` / `5084afb3`.  Money-path PRs keep re-entering that window because this gate refuses auto-merge, so they stay open and re-run the required check.  The fetch now tries the Actions token first and only then the user PAT.  A rate limit that survives both tokens is a retry message, not a missing-token message.  A real auth failure still names `GH_PACKAGES_TOKEN`.

`verify-hosted` failed `tsc` on `test/disable-pr-automerge.test.ts:25` (`TS2769`).  Next.js makes `NODE_ENV` required on `NodeJS.ProcessEnv`.  The fake `gh` env now sets `NODE_ENV: "test"`.

`disable-on-hold` and `disable-on-skip-automerge` (run `38699553074`) got `401 Bad credentials` on the elevated token, then `GraphQL: Resource not accessible by integration (disablePullRequestAutoMerge)` on the Actions token.  The job now reads `autoMergeRequest` with that token.  Null exits 0.  A non-null value exits 1.

Touched again:

- `scripts/check-shared-package-pin.mjs`
- `scripts/disable-pr-automerge.sh`
- `.github/workflows/shared-package-pin-check.yml`
- `test/shared-package-pin-check.test.ts`
- `test/disable-pr-automerge.test.ts`
- `STATUS.md`, `PLAN.md`, this note

```bash
npx tsc --noEmit
npx vitest run test/disable-pr-automerge.test.ts test/shared-package-pin-check.test.ts test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/pr-touches-codeowners-paths.test.ts
npx eslint scripts/check-shared-package-pin.mjs test/disable-pr-automerge.test.ts test/shared-package-pin-check.test.ts
```

`tsc` exit 0.  Vitest 32 passed.  ESLint 0 errors on those files.

## Port from #4727

#4727 had the same gate plus two pieces this branch lacked.  Those are now here.

- Each disable job sets `contents: write` and `pull-requests: write`.  The arm job stays read-only.  `test/branch-protection-gate.test.ts` locks the block and rejects `contents: write` on `auto-merge`.
- `scripts/disable-pr-automerge.sh` reads `autoMergeRequest` with `gh pr view --jq` and prints `off`, `armed`, or `unreadable`.  `off` exits 0.  `armed` exits 1.  A failed read is `unreadable` and also exits 1, so a dead token is not reported as disarmed.

Touched: `.github/workflows/auto-merge-prs.yml`, `scripts/disable-pr-automerge.sh`, `test/disable-pr-automerge.test.ts`, `test/branch-protection-gate.test.ts`, `STATUS.md`, `PLAN.md`, this note.

Superseded on 2026-10-17: #4727 has since landed on `main`.  The workflow, `scripts/disable-pr-automerge.sh`, and `test/branch-protection-gate.test.ts` on this branch now match `main` byte for byte.  What this branch still adds over `main` is the `unreadable` read test in `test/disable-pr-automerge.test.ts` and this history.

## Next Steps & Blockers

- PR stays open with `do-not-automerge`.  Do not enable auto-merge or merge.  After final CI is green, post that it is ready for Jay's review in the PR and ST-3326 Zulip topic.
- ST-4393: `GH_PAT` / `SHEPHERD_TOKEN` still return 401.  Non-money-path arming stays a no-op until that secret is rotated.  An already-armed money-path PR fails the disable job instead of merging.
- Merged `origin/main` `49a76da4` (#4695, congress webhook receipt) with no conflicts.  Docs-only union on `STATUS.md`.
- PR #4697 stays ready for review with `do-not-automerge`.  Do not enable auto-merge.  Owner squash-merges.
- Leave ST-3326 In Progress until this has shipped.
- 2026-10-17 CLAUDE sweep: merged `origin/main` (`1cbe9f06`, #4727) into this branch, which conflicted in this note and `test/disable-pr-automerge.test.ts`.  Resolved by keeping both sides.  #4697 is now almost fully covered by #4727 on `main`.  Jay can squash-merge the small remainder or close the PR as superseded.  `do-not-automerge` stays on and auto-merge is not armed.
- No phase doc covers this workflow.  Nothing under `docs/phase-*.md` was updated.

## Zero-Code Findings

- The first Agent-Sync `linear_claim` returned `not_configured` for CURSOR.  A later session confirmed `linear_whoami` is CURSOR, and the claim plus the progress comment with the PR link are on ST-3326 through Agent-Sync.  Zulip post returned `not_authorized` (no CURSOR Zulip key on the MCP host).
- Agent-Sync `linear_claim` returns `not_configured` for CURSOR (`LINEAR_SEATS` is GROK-WEB only).  The claim was made with the board CLI as the Cursor Linear app.  Zulip post returned `not_authorized` (no CURSOR Zulip key on the MCP host).

## Merge-main (MM takeover, 2026-10-16)

Cursor's agents hit their quota, so MM is taking this branch to the owner for
review.  This PR is NOT merged and auto-merge stays unarmed; the `do-not-automerge`
hold stays on.  The sections above are the original Cursor record and are left as
written.

`origin/main` (`a5d45401e`) is merged with a merge commit — no rebase, no
force-push.  No conflicts; the branch touches only the workflow, its scripts,
its tests and docs, and `main` had moved in none of them.

Gate re-run after the merge:

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/disable-pr-automerge.test.ts
npm run build
```

All four exit 0.  Focused Vitest 21 tests passed.

Why the hold stays even though the PR is ready: this diff adds
`permissions: contents: write` to the three `disable-*` jobs so they can turn
auto-merge off with an elevated token.  Granting write scope to the job that
disables merges is the owner's call, and ST-4393 shows `GH_PAT` /
`SHEPHERD_TOKEN` still return 401, so the elevated-token path this PR depends on
is not yet working.  It needs Jay's review before it lands.

## Merge-main (CLAUDE sweep, 2026-10-17)

PR #4727 had fallen BEHIND `main` (four commits, through `b39ed8a7d`, #4805).  `origin/main` is merged with a merge commit — no rebase, no force-push.  No conflicts and no conflict markers; `main` changed `.github/workflows/e2e.yml` only among workflow files and moved none of this PR's ten files.  The PR has no review threads.

Local check after the merge:

```bash
npx vitest run test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/disable-pr-automerge.test.ts
```

21 tests passed.  Repo-wide `tsc` and `next build` were left to hosted CI: this lane cannot install the private `@jaywedgeworth22/congress-trading-shared` package, so a local `tsc` reports unrelated TS2307 errors for it.

The `do-not-automerge` hold stays on and auto-merge is not armed.  Merging stays Jay's decision (see the hold reasons above).
