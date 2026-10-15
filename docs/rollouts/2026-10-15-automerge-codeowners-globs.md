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
- A rejected elevated token retries disable once with the Actions `GITHUB_TOKEN`.  That token is not used to arm.  If both disables are rejected, the job reads `autoMergeRequest`.  Null is success (the Actions token cannot call `disablePullRequestAutoMerge`).  A still-armed merge fails the job.
- The dry run exports `CODEOWNERS_FILE` to the repo copy so it still classifies when the shell is not at the repo root.
- Out of scope: a ruleset required review on those paths.  This change only stops the workflow from arming.

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

Follow-up after that gate: live `disable-auto` on PR #4697 returned `401 Bad credentials` and the job still exited 0.  `scripts/disable-pr-automerge.sh` retries once with `DISABLE_AUTOMERGE_FALLBACK_TOKEN` (the Actions `GITHUB_TOKEN`) and exits 1 if that credential is rejected too.  Already-off stays exit 0.

```bash
npx vitest run test/disable-pr-automerge.test.ts test/automerge-gate-dry-run.test.ts test/branch-protection-gate.test.ts test/pr-touches-codeowners-paths.test.ts
```

22 passed.

## CI follow-up (same day)

Merged `origin/main` (`df7e6d10`, #4703 / #4708 / #4702) with a merge commit.  No rebase.  No force-push.  `git merge-tree --write-tree` was clean.  `STATUS.md` and `PLAN.md` union-merged.

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

## Next Steps & Blockers

- PR #4697 stays ready for review with `do-not-automerge`.  Do not enable auto-merge.  Owner squash-merges.
- Leave ST-3326 In Progress until this has shipped.
- No phase doc covers this workflow.  Nothing under `docs/phase-*.md` was updated.

## Zero-Code Findings

- The first Agent-Sync `linear_claim` returned `not_configured` for CURSOR.  A later session confirmed `linear_whoami` is CURSOR, and the claim plus the progress comment with the PR link are on ST-3326 through Agent-Sync.  Zulip post returned `not_authorized` (no CURSOR Zulip key on the MCP host).
