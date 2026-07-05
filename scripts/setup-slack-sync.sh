#!/usr/bin/env bash
# setup-slack-sync.sh - install the Slack coordination sync GLOBALLY for every
# Claude Code session on this machine (or cloud container), across ALL repos.
#
# Why global: the owner wants coordination to "just work" in every session and
# repo, not only this one. Claude Code merges hooks across settings scopes, so a
# single SessionStart hook in ~/.claude/settings.json fires for every repo. This
# repo intentionally git-ignores .claude/, so we do NOT commit a per-repo hook -
# the global install is the portable, one-machine-one-setup path.
#
# What it does (idempotent - safe to re-run; upgrades in place):
#   1) Copies scripts/slack-sync.sh -> ~/.claude/slack-sync.sh (stable path the
#      global hook calls).
#   2) Merges a SessionStart hook into ~/.claude/settings.json that runs
#      slack-sync.sh in "hook" mode at the start of every session. That hook is a
#      SILENT no-op unless SLACK_BOT_TOKEN is set, so it is safe in every repo.
#
# It does NOT set SLACK_BOT_TOKEN - that is a secret you provide separately:
#   - Local Mac : export SLACK_BOT_TOKEN=xoxb-... where Claude Code sees it
#                 (shell profile / launch env). Never commit it.
#   - Cloud/web : add SLACK_BOT_TOKEN as a Runtime Secret in the environment
#                 config (Dashboard -> environment -> Secrets).
#
# Usage:
#   bash scripts/setup-slack-sync.sh
#
# PURE ASCII ONLY (this runs under Apple's bash 3.2 on the production Mac; see
# AGENTS.md). Use '-', '->', '...' - never smart quotes / em dashes / arrows.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
SRC="$REPO_ROOT/scripts/slack-sync.sh"
DEST="$CLAUDE_DIR/slack-sync.sh"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found - run this from inside the repo." >&2
  exit 1
fi

mkdir -p "$CLAUDE_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "==> installed $DEST"

# The global hook calls the installed copy. slack-sync.sh 'hook' is hook-safe:
# no token -> silent no-op; with a token -> injects recent channel messages as
# session context. The trailing '|| true' guarantees the hook never fails a
# session start.
HOOK_CMD="bash \"$DEST\" hook 2>/dev/null || true"

# Merge (do not clobber) the hook into ~/.claude/settings.json. Prefer python3
# for a real JSON merge; fall back to writing a fresh file only when none exists.
if command -v python3 >/dev/null 2>&1; then
  SLK_SETTINGS="$SETTINGS" SLK_HOOK_CMD="$HOOK_CMD" python3 - <<'PY'
import json, os, sys

path = os.environ["SLK_SETTINGS"]
cmd = os.environ["SLK_HOOK_CMD"]

data = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write("error: %s is not valid JSON (%s); refusing to overwrite.\n" % (path, e))
        sys.stderr.write("Fix or remove it, then re-run scripts/setup-slack-sync.sh.\n")
        sys.exit(1)

if not isinstance(data, dict):
    sys.stderr.write("error: %s does not contain a JSON object; refusing to overwrite.\n" % path)
    sys.exit(1)

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    sys.stderr.write("error: 'hooks' in %s is not an object; refusing to overwrite.\n" % path)
    sys.exit(1)

groups = hooks.get("SessionStart")
if not isinstance(groups, list):
    groups = []

# Idempotent upgrade: drop any prior slack-sync hook entries, then re-add.
def has_slack(group):
    for h in group.get("hooks", []) if isinstance(group, dict) else []:
        if isinstance(h, dict) and "slack-sync.sh" in str(h.get("command", "")):
            return True
    return False

groups = [g for g in groups if not has_slack(g)]
groups.append({"hooks": [{"type": "command", "command": cmd}]})
hooks["SessionStart"] = groups
data["hooks"] = hooks

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print("==> merged SessionStart hook into %s" % path)
PY
else
  if [ ! -e "$SETTINGS" ]; then
    cat > "$SETTINGS" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOOK_CMD" }
        ]
      }
    ]
  }
}
EOF
    echo "==> wrote $SETTINGS"
  else
    echo "warning: python3 not found and $SETTINGS already exists." >&2
    echo "Add this SessionStart hook to it manually:" >&2
    echo "  { \"type\": \"command\", \"command\": \"$HOOK_CMD\" }" >&2
  fi
fi

echo "==> Slack sync installed globally for all Claude Code sessions/repos."
echo "    Set SLACK_BOT_TOKEN (env secret) to activate; without it the hook is a no-op."
echo "    Test now with: SLACK_BOT_TOKEN=xoxb-... bash \"$DEST\" test"
