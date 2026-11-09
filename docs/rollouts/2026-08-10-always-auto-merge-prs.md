# Always auto-merge non-draft PRs (PR #2597)

## Context & Objective

Owner fleet policy: every non-draft, same-repo PR should arm GitHub auto-merge so green CI lands without a human click. Production auto-deploys on every `main` push; a hold label (`do-not-automerge`) must be able to cancel an already-armed merge.

## Changes Made

- Added `.github/workflows/auto-merge-prs.yml`:
  - `pull_request_target` on open/sync/reopen/label/unlabel/ready_for_review
  - Arm squash auto-merge + delete branch for non-draft same-repo PRs without the hold label
  - `disable-on-hold` job: when `do-not-automerge` is present, run `gh pr merge --disable-auto`
  - Token preference: `GH_PAT` → `SHEPHERD_TOKEN` → `GITHUB_TOKEN` so merges can re-trigger post-merge workflows when a PAT is configured
  - Squash only (no merge-commit fallback); fail the job if arming fails for non-benign reasons
- Registered the new workflow name in `.github/workflows/sentry-ci-report.yml` so `test/sentry-ci-report-workflows.test.ts` stays green
- Merge-forward onto current `main`; `AGENTS.md` Apple Notes conflict resolved by keeping main's 2026-08-09 close-out stanza (supersedes the PR's shorter draft)

Touched paths:

- `.github/workflows/auto-merge-prs.yml`
- `.github/workflows/sentry-ci-report.yml`
- `AGENTS.md` (conflict resolve only)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- Reuses existing repo secrets (`GH_PAT` / `SHEPHERD_TOKEN`) already documented for codex-autofix / merge-shepherd; falls back to `GITHUB_TOKEN` if neither is set (arming still works; post-merge workflow recursion remains a known GITHUB_TOKEN limitation).
- Does not replace merge-shepherd; shepherd still re-syncs stale branches and digests. This workflow only arms auto-merge at PR lifecycle events.
- Cloud agents without Apple Notes still write a completion handoff body for local Notes publication (existing AGENTS rule).

## Verification State

```bash
npx vitest run test/sentry-ci-report-workflows.test.ts   # 2/2 pass
# Hosted verify re-run on push of merge-forward head
```

## Next Steps & Blockers

- Wait for required `verify` check on PR #2597; auto-merge is re-armed after push
- Confirm Coolify auto-deploy of the merge commit via `bash scripts/verify-deploy-sha.sh`
- Optional: ensure `GH_PAT` or `SHEPHERD_TOKEN` is present in repo secrets so post-merge e2e / effort-sync fire from workflow-driven merges

## Zero-Code Findings

- PR #2603 (`codex/codex-cloud-protocol`) was already MERGED 2026-08-10 ~01:59 CT before this unstick pass; only #2597 remained open
