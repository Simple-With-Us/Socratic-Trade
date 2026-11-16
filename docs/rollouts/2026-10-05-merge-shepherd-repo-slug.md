# 2026-10-05 — Merge shepherd canonical repo slug + BLOCKED bucket

## Context & Objective

The Mac launchd merge shepherd defaulted `REPO` to `jaywedgeworth22/Socratic-Trade`.  REST calls follow the rename, but `gh issue list --search` against the legacy slug returns empty, so each run created a new "Merge shepherd status" issue (~430 duplicates).  Armed PRs with `mergeStateStatus: BLOCKED` failed `gh pr merge` with "not mergeable", which the script treated as behind-main and ran `update-branch` every tick.

## Changes Made

- Pin `REPO` to `Simple-With-Us/Socratic-Trade` via `GITHUB_REPOSITORY` / `SHEPHERD_REPO` overrides (`merge-shepherd.sh`, `runner-availability.sh`, `rth-deploy-drain.sh`).
- Poll `mergeStateStatus` before acting on green armed PRs; `BLOCKED` / `UNKNOWN` / `BEHIND` never fall through to a blind `gh pr merge`.
- Point `merge-shepherd.yml` reusable workflow `uses:` at `Simple-With-Us/Socratic-Trade`.

**Files:** `scripts/merge-shepherd.sh`, `scripts/runner-availability.sh`, `scripts/rth-deploy-drain.sh`, `.github/workflows/merge-shepherd.yml`, `docs/rollouts/2026-10-05-merge-shepherd-repo-slug.md`, `STATUS.md`.

## Decisions & Trade-offs

- Did not bulk-close duplicate tracking issues (owner approval required).
- Did not change `src/lib/rth-deploy-latch.ts` defaults (TypeScript deploy latch, not shepherd issue search).

## Verification State

```bash
bash -n scripts/merge-shepherd.sh scripts/runner-availability.sh scripts/rth-deploy-drain.sh
GITHUB_REPOSITORY= SHEPHERD_DRY_RUN=1 bash scripts/merge-shepherd.sh  # REPO=Simple-With-Us/Socratic-Trade
```

## Next Steps & Blockers

- Merge PR after review; Mac launchd picks up script on next `git pull` in the shepherd worktree.
- Owner: bulk-close duplicate "Merge shepherd status" issues separately.

## Zero-Code Findings

None.
