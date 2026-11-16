#!/usr/bin/env bash
# Retired installer compatibility path.  Remove the Slack SessionStart hook only.
# Preserve other hooks and settings, including other hooks in the same group.
# No network requests and no credentials are read.
set -euo pipefail
python3 - "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" <<'PYTHON'
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1])
settings = root / "settings.json"
legacy = root / "slack-sync.sh"
if settings.is_symlink() or legacy.is_symlink():
    raise SystemExit("Retired-hook cleanup refuses symlinks; inspect the cloud settings.")
if settings.exists():
    try:
        data = json.loads(settings.read_text())
        if not isinstance(data, dict):
            raise ValueError()
        hooks = data.get("hooks", {})
        if not isinstance(hooks, dict):
            raise ValueError()
        groups = hooks.get("SessionStart", [])
        if not isinstance(groups, list):
            raise ValueError()
    except (OSError, ValueError):
        raise SystemExit("Retired-hook cleanup requires valid settings JSON; left unchanged.")
    changed = False
    kept = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            kept.append(group)
            continue
        entries = []
        for hook in group["hooks"]:
            command = hook.get("command", "") if isinstance(hook, dict) else ""
            if isinstance(command, str) and re.search(r"(?:^|[/\s\"'])slack-sync\.sh(?:$|[\s\"'])", command):
                changed = True
            else:
                entries.append(hook)
        if entries or not group["hooks"]:
            kept.append({**group, "hooks": entries})
    if changed:
        hooks["SessionStart"] = kept
        fd, temporary = tempfile.mkstemp(prefix=".retired-hook-", dir=root)
        try:
            os.fchmod(fd, stat.S_IMODE(settings.stat().st_mode) & 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream, indent=2)
                stream.write("\n")
            os.replace(temporary, settings)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
if legacy.is_file():
    legacy.unlink()
print("Retired Slack hook cleanup complete; unrelated settings preserved.")
PYTHON
