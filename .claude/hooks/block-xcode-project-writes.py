#!/usr/bin/env python3
"""Block agent Edit/Write on Xcode-managed project files.

Claude Code PreToolUse hook: reads the tool-input JSON on stdin.
Exit 0 = allow.  Exit 2 = block (Claude convention).

Also accepts a file path as argv[1] for tests and other seats.
"""
from __future__ import annotations

import json
import re
import sys

BLOCK_RE = re.compile(
    r"(?:\.pbxproj$|\.xcworkspace$|\.xib$|\.storyboard$|\.entitlements$"
    r"|xcodeproj/|xcworkspace/)",
    re.IGNORECASE,
)

BLOCK_MSG = (
    "BLOCKED: Do not hand-edit Xcode project files "
    "(.pbxproj, .xcodeproj/, .xcworkspace, .xib, .storyboard, .entitlements). "
    "Create the .swift file and report that it needs target membership. "
    "Where the app uses XcodeGen, edit project.yml and run xcodegen generate."
)


def is_blocked(path: str) -> bool:
    if not path:
        return False
    return bool(BLOCK_RE.search(path.replace("\\", "/")))


def path_from_stdin(raw: str) -> str:
    if not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    if not isinstance(data, dict):
        return ""
    tool_input = data.get("tool_input") or data.get("toolInput") or {}
    if not isinstance(tool_input, dict):
        return ""
    for key in ("file_path", "filePath", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return ""


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        assert is_blocked("ios/Foo.xcodeproj/project.pbxproj")
        assert is_blocked("App/App.entitlements")
        assert is_blocked("Legacy/Main.storyboard")
        assert not is_blocked("ios/project.yml")
        assert not is_blocked("ios/Foo/Bar.swift")
        assert not is_blocked("Package.swift")
        return 0

    path = ""
    if len(argv) > 1:
        path = argv[1]
    else:
        path = path_from_stdin(sys.stdin.read())

    if is_blocked(path):
        print(BLOCK_MSG, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
