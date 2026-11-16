---
name: unstick-pr
description: Diagnose and repair a PR blocked at merge using the GitHub state machine decision tree (works on phantom conflicts, CI dispatch misses, thread hangs, and known flakes).
---

# Unstick a Blocked PR

Use this when a PR won't merge despite appearing ready. Classifies the blocker and applies the exact fix.

## Procedure

1. **Get current PR state:**
   ```bash
   gh pr view <N> --json state,mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup
   ```
   Note the `mergeable` field and `mergeStateStatus`. If state is OPEN but mergeable is false, continue.

2. **Classify the failure:**

   **A) CONFLICTING or DIRTY:**
   Verify REAL conflict vs. phantom (GitHub's mergeability cache gets stuck under concurrent push bursts). Use the 2-argument real-merge form of `git merge-tree` -- it sets an exit code; the older 3-argument `<base> <b1> <b2>` form always exits 0 and cannot be used for this check.
   ```bash
   git fetch origin
   git merge-tree --write-tree origin/main origin/<branch>
   ```
   - Exit 0 (clean) = **PHANTOM**. Not a real conflict.
   - Exit 1 (conflict markers shown) = **REAL conflict**. Proceed to B.

   **PHANTOM conflict fix:** Push a fresh head SHA. Merge origin/main into the branch in its worktree:
   ```bash
   cd ~/apps/trading-<your-agent>  # your worktree
   git fetch origin
   git merge origin/main --no-edit
   git push origin agent/<branch-name>
   ```
   GitHub recomputes mergeability in roughly 20-60 seconds and re-dispatches CI. Re-check with step 1. If several PRs are stuck at once, push one at a time spaced ~10-15s apart rather than as a simultaneous burst.

   **B) REAL conflict:** Merge origin/main manually in your worktree. `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md` carry `merge=union` in `.gitattributes`, so additive edits to those three files resolve automatically -- only genuinely overlapping code/prose needs a judgment call. Never delete another agent's row while resolving (see AGENTS.md effort-log rules). If intent on a real code conflict is unclear, abort and escalate.

   **C) BLOCKED with all checks green:** Unresolved review threads (branch protection enforces conversation resolution). Use the `codex-triage` skill to find and resolve threads. Re-check `gh pr view` after resolution.

   **D) Check FAILURE on `smoke` (Playwright Smoke workflow, `test/e2e/dashboard-smoke.spec.ts`):** Known recurring flake -- re-run once:
   ```bash
   gh run rerun <run-id> --failed
   ```
   A second identical failure is real; escalate. (Root cause of the original instance of this flake: `docs/rollouts/2026-06-22-e2e-smoke-auth-fix.md`.)

   **E) No CI dispatched for head SHA:** Phantom dispatch miss (same class as A). Push fresh head as in A's phantom fix.

3. **Re-arm auto-merge** (required after any fix):
   ```bash
   gh pr merge <N> --squash --auto
   ```
   Verify:
   ```bash
   gh pr view <N> --json autoMergeRequest
   ```
   Should show `autoMergeRequest` non-null (an object with `enabledBy`, not `null`).

4. **Monitor the merge:** Watch for the PR to merge once all checks pass. If it hangs again, repeat steps 1-3.

## Canon (source of truth -- read these if anything conflicts)

- **Multi-agent CI flakiness & phantom conflicts:** memory `github-ci-flakiness-multiagent` (the `git merge-tree --write-tree` diagnostic and spaced-push unstick, verified live on PRs #198/#202/#290-303)
- **Auto-merge race + board clobber pattern:** `docs/rollouts/2026-07-09-monet-usage-cap-pickup.md`
- **Branch protection & conversation resolution:** `AGENTS.md` Pull requests section
- **Auto-deploy & the merge flow:** `docs/rollouts/2026-07-10-auto-deploy-on.md` (merge to main auto-deploys; ANNOUNCE-THEN-DEPLOY is retired)
- **`smoke` flake origin:** `docs/rollouts/2026-06-22-e2e-smoke-auth-fix.md` (prod-mode auth middleware redirect; fixed in `playwright.config.ts`, may recur)
