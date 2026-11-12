#!/bin/bash
# Claude Code PreToolUse hook (Bash matcher): enforce the effort-log/handoff
# protocol at PUSH/LAND time, not every commit. Wired from the USER-level
# ~/.claude/settings.json (this repo keeps .claude/settings.json untracked,
# per-machine). Self-scoping: only acts in repos that track docs/EFFORT-LOG.md.
#
# Behavior: when the Bash command is a git push / scripts/land.sh / gh pr create
# and the current branch has NOT touched docs/EFFORT-LOG.md since forking from
# origin/main (and the file is not dirty in the working tree), DENY with the
# protocol checklist so the session fixes the boards first.
#
# Escape hatch: prefix the command with BOARD_CHECK_SKIP=1 (state why in your
# message). Fail-OPEN by design: any internal error allows the call -- this is
# a protocol nudge, not a security boundary.
#
# Added 2026-07-10 (owner-directed: "I have to remind you about ag***-s**c and
# effort log all the time"). See docs/rollouts/2026-07-10-fleet-procedure-skills.md.
set -u

IN=$(cat 2>/dev/null) || IN=""
CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

printf '%s' "$CMD" | grep -qE '(git push|scripts/land\.sh|gh pr create)' || exit 0
printf '%s' "$CMD" | grep -q 'BOARD_CHECK_SKIP=1' && exit 0

# Resolve the repo the command targets: explicit cd <dir> in the command wins,
# else the hook input's cwd, else the process cwd.
DIR=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null) || DIR=""
CDDIR=$(printf '%s' "$CMD" | sed -n 's/^cd \([^ ;&|]*\).*$/\1/p' | head -1)
[ -n "$CDDIR" ] && [ -d "$CDDIR" ] && DIR="$CDDIR"
[ -z "$DIR" ] && DIR=$(pwd)

GITTOP=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null) || exit 0
# Self-scope: only repos that track the effort-log mirror.
git -C "$GITTOP" ls-files --error-unmatch docs/EFFORT-LOG.md >/dev/null 2>&1 || exit 0

BR=$(git -C "$GITTOP" branch --show-current 2>/dev/null) || exit 0
[ -z "$BR" ] && exit 0
[ "$BR" = "main" ] && exit 0

BASE=$(git -C "$GITTOP" merge-base HEAD origin/main 2>/dev/null) || exit 0
TOUCHED=$(git -C "$GITTOP" diff --name-only "$BASE" HEAD -- docs/EFFORT-LOG.md 2>/dev/null)
DIRTY=$(git -C "$GITTOP" status --porcelain -- docs/EFFORT-LOG.md 2>/dev/null)
if [ -n "$TOUCHED" ] || [ -n "$DIRTY" ]; then
  exit 0
fi

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Pre-push protocol check (AGENTS.md): this branch has not touched docs/EFFORT-LOG.md since forking from main. Before pushing/landing: (1) add or flip your effort row in docs/EFFORT-LOG.md; (2) add a STATUS.md stanza; (3) write/update the docs/rollouts/YYYY-MM-DD-slug.md note; (4) confirm your #ag***-s**c claim was posted (scripts/slack-sync.sh post). If this push is genuinely exempt (docs already landed via an earlier commit on another branch, pure re-push, etc.), re-run prefixed with BOARD_CHECK_SKIP=1 and state why."}}
EOF
exit 0
