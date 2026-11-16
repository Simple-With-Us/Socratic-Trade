#!/usr/bin/env bash
# Retired: Slack coordination for Codex Cloud.  Zulip via simple-chat is the only path.
set -u
printf '%s\n' \
  'codex-coordination.sh is retired (Slack hard cut 2026-10-08).' \
  'Install fleet coordination: bash scripts/install-fleet-coordination.sh' \
  'Post: simple-chat post --topic "<topic>" --as <SEAT> "repo: Socratic-Trade | ..."' \
  >&2
exit 1
