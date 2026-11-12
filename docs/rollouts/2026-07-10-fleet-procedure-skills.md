# 2026-07-10 — Fleet-procedure skills: land-lane/unstick-pr/codex-triage/pickup-seat/deploy-verify (CLAUDE)

## Summary

Added five Claude Code skills under `.claude/skills/`, each a self-contained `SKILL.md` with
frontmatter (`name`, `description`) plus a procedure body:

- **`land-lane`** — land a feature branch to `main` via the fleet worktree-and-script procedure
  (preconditions, the Node 24 `better-sqlite3` ABI trap, docs-before-landing checklist, git
  identity check, `scripts/land.sh` gate, arming `gh pr merge --squash --auto`, auto-deploy
  consequences, workflow-file push scope, multi-agent Slack coordination).
- **`unstick-pr`** — diagnose and repair a PR blocked at merge using a decision tree (phantom vs.
  real conflicts via `git merge-tree --write-tree`, blocked-on-unresolved-threads, the `smoke`
  flake class, no-CI-dispatched, re-arming auto-merge).
- **`codex-triage`** — triage unresolved codex-connector bot review threads on a PR (fetch via
  `gh api graphql`, classify addressed/false_positive/real, fix real findings in one batch with a
  regression test, reply-then-resolve, the auto-merge race on the last thread, stop at round 2-3).
- **`pickup-seat`** — pick up another agent seat's in-flight work after a usage/time cap
  (owner-directed only): inventory effort boards/PRs/dirty worktrees/Slack history, claim on
  `#ag***-s**c`, adopt uncommitted work with correct `Co-Authored-By` trailer, disposition each
  item, hand back gracefully, close out boards + rollout note + Slack summary.
- **`deploy-verify`** — verify production after a deploy fires (app health via `/api/health`,
  Coolify deployment status with the CF-IP-allowlist caveat, litestream backup continuity, the
  2026-07-10 TCP socket-churn failure class, box-local build-queue checks).

## Why

The pickup-era procedures (landing branches, unsticking PRs, codex bot triage, seat handoffs,
post-deploy verification) were being re-derived or re-spelled out per-prompt across sessions.
Encoding them as on-demand Claude Code skills lets a Claude seat invoke the procedure directly
instead of reconstructing it from scattered `AGENTS.md` sections and rollout notes each time,
while keeping `AGENTS.md` itself as the durable, cross-agent (non-Claude-specific) source of
truth — every skill's "Canon" section points back to it and to the specific rollout notes it
depends on, so drift is a doc-review problem, not a duplication-across-five-files problem.

`.claude/` is intentionally git-ignored repo-wide (see `scripts/setup-slack-sync.sh`) because it
holds per-agent, per-machine local settings and session hooks that must never be shared across
seats. Skills are different: they are Claude Code-specific *content* meant to be identical and
shared across every Claude seat that clones this repo, so `.gitignore` now carves out
`!.claude/skills/` specifically — nothing else under `.claude/` (settings, hooks, session state)
becomes trackable.

## Files

- `.claude/skills/land-lane/SKILL.md` (new)
- `.claude/skills/unstick-pr/SKILL.md` (new)
- `.claude/skills/codex-triage/SKILL.md` (new)
- `.claude/skills/pickup-seat/SKILL.md` (new)
- `.claude/skills/deploy-verify/SKILL.md` (new)
- `.gitignore` (carve out `!.claude/skills/` from the `.claude/*` ignore rule)
- `docs/EFFORT-LOG.md` (repo mirror — new In Progress row)
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board — mirrored row)
- `STATUS.md` (new stanza)
- `docs/rollouts/2026-07-10-fleet-procedure-skills.md` (this note)

## Verification

Docs-and-skills-only change; no application code touched. `scripts/land.sh` still runs the full
gate (`npx tsc --noEmit` -> `npm test` -> `npm run build`) before opening the PR, per the
Pre-Commit/Handoff Protocol — see the PR's CI `verify` run for the authoritative pass/fail record.
Confirmed locally before commit:

```bash
git config user.email   # 12656028+jaywedgeworth22@users.noreply.github.com
git check-ignore -v .claude/skills/land-lane/SKILL.md   # exit 1 (no longer ignored)
find .claude -type f                                     # only the 5 SKILL.md files
```

## Follow-ups

- Skills are Claude-only by design — they are not, and should not be, referenced from `AGENTS.md`
  as a requirement for Codex/Antigravity/Cursor, which have no equivalent loading mechanism.
  `AGENTS.md` remains the canonical, tool-neutral procedure text; the skills are a Claude-specific
  convenience layer on top of it, not a replacement.
- If `land.sh`, the auto-deploy mechanism, the codex-triage GraphQL shape, or the Coolify/litestream
  verification steps change, update the corresponding `SKILL.md` in the same PR as the underlying
  change — these five files will drift silently otherwise, same risk class as any other doc.

## Addendum: effort-log protocol enforcement hook (same PR)

`scripts/claude-hooks/board-check.sh` — a Claude Code PreToolUse (Bash) hook that DENIES
`git push` / `scripts/land.sh` / `gh pr create` when the current branch has not touched
`docs/EFFORT-LOG.md` since forking from origin/main (and it is not dirty), replying with the
full pre-push checklist (board row, STATUS stanza, rollout note, #ag***-s**c claim).
Escape hatch: `BOARD_CHECK_SKIP=1` prefix with stated reason. Fail-open on internal errors.
Self-scoping: only acts in repos that track `docs/EFFORT-LOG.md`; silent elsewhere.

Wired from USER-level `~/.claude/settings.json` (NOT a tracked `.claude/settings.json` —
this repo deliberately keeps that file untracked for per-machine session hooks; a tracked
copy would collide with existing local files in every worktree). The hook covers both the
CLAUDE and MONET seats and all worktrees. Verified: bash -n, ASCII-only, four pipe-test
scenarios (non-push allow / violating-push deny / BOARD_CHECK_SKIP allow / docs-touched
allow), settings schema via jq.

Why: owner 2026-07-10 — "I have to remind you about ag***-s**c and effort log all the
time." Prose in AGENTS.md reminds; the harness hook enforces at the moment it matters.
