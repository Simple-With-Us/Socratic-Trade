# 2026-06-21 — Multi-agent coordination: verify + gap-fill (`agent/claude`)

## Summary
The multi-agent landing protocol (to stop the `main` push-races + the Q0 worktree collision) was
**already implemented on `main`** by a concurrent lane: `scripts/githooks/pre-push`, `scripts/land.sh`,
`core.hooksPath scripts/githooks` wired into `setup-agent-previews.sh`, and the AGENTS.md
"Multi-agent landing protocol" section. A 4-agent design workflow independently reproduced the same
design (validating it) and surfaced the residual limits. This change **verifies** the existing
implementation, **closes one real gap**, **resolves Q0**, and documents the honest limits.

## Why
After ~7 push-races landing the prior integration + the logged Q0 blocker (an agent editing core
files in the `main` integration worktree, leaving broken WIP that failed others' verify gate), the
user asked to set up coordination. Most of it already existed; this fills the gaps and documents it.

## Changes
- **`scripts/land.sh`** — added a self-heal preflight: if `core.hooksPath` isn't `scripts/githooks`
  (a worktree created outside `setup-agent-previews.sh` has **no** hooks → the direct-push-to-main
  guard silently wouldn't fire), `land.sh` now sets it before pushing. Closes red-team gap #3.
- **`docs/open-questions-for-jay.md`** — resolved **Q0** (option (a): one agent per worktree; never
  work in the `main` worktree; land via PR — now enforced by the hook + `land.sh`).
- **`docs/reviews/2026-06-21-multi-agent-coordination-review.md`** — the 4-agent design + adversarial
  review + the residual-gaps/limits analysis (the valuable artifact).
- STATUS updated.

## Verified (existing implementation, read + reasoned)
- `scripts/githooks/pre-push`: blocks any push whose remote ref is `refs/heads/main` (all forms),
  blocks pushes from the `~/Code/Agentic Trading` worktree, allows `HOOKS_ALLOW_MAIN_PUSH=1` override,
  ignores deletions. Correct.
- `scripts/land.sh`: refuses main worktree/branch → fetch → merge origin/main (abort on conflict) →
  `tsc`→`test`→`build` gate → refuses `.github/workflows/` diffs (no `workflow` scope) → push branch +
  `gh pr create`. Correct.
- `core.hooksPath=scripts/githooks` is set in this worktree and wired for all worktrees in
  `setup-agent-previews.sh`.

## Honest limits (cannot be enforced — see the review doc §5)
1. **No server-side branch protection** — private repo returns 403 ("Upgrade to Pro"); "require PR /
   no direct push / merge queue" can't be enforced server-side. **GitHub Pro/Team** is the real fix.
2. **`--no-verify` bypasses local hooks** — structural mitigation only (agents push only their own
   `agent/*` branch; the human integrator is the load-bearing gate).
3. **Hooks guard pushes, not file-writes** — they cannot prevent Q0's actual damage (broken files in
   the `main` worktree). Convention (rule 3) is primary; optional filesystem write-protection
   (`chmod -R a-w` or per-tool deny rules on `~/Code/Agentic Trading`) is **Jay's call**, not enabled.
4. **CI is inert** until a one-time human `gh auth refresh -s workflow` (workflows staged in `ci-pending/`).

## Follow-ups (for Jay)
- One-time: `gh auth refresh -s workflow` → move `ci-pending/*.yml` → `.github/workflows/` → land via PR.
- Consider GitHub Pro/Team (branch protection + merge queue) — subsumes most of this scaffolding.
- Consider filesystem write-protection / per-tool deny rules on the `main` worktree (review doc §5 gap 4).
- This change is landing via `scripts/land.sh` (PR) — **not** a direct push to `main`. Merge the PR to apply.
