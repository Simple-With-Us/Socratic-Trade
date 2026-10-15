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

25 passed.  `tsc` exit 0 (2026-10-15).

```bash
bash scripts/automerge-gate-dry-run.sh --files src/lib/broker.ts
bash scripts/automerge-gate-dry-run.sh --label do-not-automerge --files README.md
bash scripts/automerge-gate-dry-run.sh --files README.md
```

Money path: `arm=false` `disarm=true`.  `do-not-automerge`: `arm=false` `disarm=true`.  README: `arm=true` `disarm=false`.

## Next Steps & Blockers

- PR is ready for review with `do-not-automerge`.  Do not enable auto-merge.  GB-Deployer merges.  Do not merge from this lane.
- ST-4393: `GH_PAT` / `SHEPHERD_TOKEN` still return 401.  Non-money-path arming stays a no-op until that secret is rotated.  An already-armed money-path PR fails the disable job instead of merging.
- No phase doc covers this workflow.  Nothing under `docs/phase-*.md` was updated.

## Zero-Code Findings

- Agent-Sync `linear_claim` returns `not_configured` for CURSOR (`LINEAR_SEATS` is GROK-WEB only).  The claim was made with the board CLI as the Cursor Linear app.  Zulip post returned `not_authorized` (no CURSOR Zulip key on the MCP host).
