# 2026-06-20 — Branch hygiene + Cursor Cloud docs integration

## Summary

Integrated the stranded Cursor Cloud dev-environment docs onto `main` and pruned
stale/orphaned/superseded branches. The branch namespace is now just `main` plus the
three active agent worktree branches (`agent/claude`, `agent/codex`, `agent/antigravity`).

## Why

Tidy the branch list before resuming phase work. The Cursor Cloud setup notes (authored
by the Cursor Cloud agent, co-authored by the owner) were stranded on a remote-only
branch and not on `main`; the other branches were either fully merged into `main`,
superseded by re-implemented work, or orphaned (their remote upstream had been deleted).

## What was done

- **Integrated** `origin/cursor/setup-dev-environment-a574` (`7e82278`, "docs: add Cursor
  Cloud dev environment setup notes") onto `main` via `git cherry-pick -x` → `55213d2`.
  The STATUS.md Active-Focus conflict was resolved by keeping BOTH the human-review-cockpit
  entry and the Cloud-setup entry; AGENTS.md auto-merged (adds a "## Cursor Cloud specific
  instructions" section).
- **Deleted branches** (tip SHAs recorded for recovery):
  - `agent/antigravity-local` @ `095175c` — force-deleted (`-D`). Its 6 commits' features
    (broker-UI split, $/% risk-limit toggles, universe "TBD") are already shipped on `main`
    via different SHAs; it also carried scratch artifacts (`codex_work.patch`,
    `scripts/refactor/`). Restore: `git branch agent/antigravity-local 095175c`.
  - `codex/phase-7-learning-plan-and-enrichment-review` @ `b990c14` — fully merged into
    `main` (`-d`). Restore: `git branch <name> b990c14`.
  - `codex/upload-current-state` @ `47786c4` — fully merged into `main` (`-d`). Restore:
    `git branch <name> 47786c4`.
  - remote `origin/cursor/setup-dev-environment-a574` @ `7e82278` — deleted after
    integration. Restore: `git push origin 7e82278:refs/heads/cursor/setup-dev-environment-a574`.
- **Also removed in parallel by the concurrent host-integration process** (not this
  session): local `ui-optimization-pass`, `ui-redesign`, `web-sources`, `phase-10`, and
  remote `cursor/setup-dev-environment-73ae`. `origin/phase-10` still exists.

## Files

- `STATUS.md` — Active-Focus cleanup entry (plus the merged Cloud-setup entry from `55213d2`).
- `docs/rollouts/2026-06-20-branch-hygiene-and-a574-integration.md` — this note.
- (cherry-pick `55213d2` also added `docs/rollouts/2026-06-20-cursor-cloud-env-setup.md` and
  the AGENTS.md "Cursor Cloud specific instructions" section.)

## Verification

- `git branch` → `main`, `agent/claude`, `agent/codex`, `agent/antigravity` only.
- `git branch -r | grep cursor` → none.
- No source code touched — docs + branch refs only; the `tsc`/`test`/`build` trio is not
  required for this change.

## Follow-ups

- An active concurrent host-integration process left untracked `ci-pending/` and
  `docs/rollouts/2026-06-20-loose-ends-cleanup.md` in the tree; left untouched (not this
  session's work).
- Ready to resume phase work — see `PLAN.md` and `docs/phase-*.md`.

## Blockers

- None.
