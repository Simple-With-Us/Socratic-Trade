# 2026-07-04 - ag***-s**c-protocol-docs

## Summary

Established inter-agent coordination protocol for parallel work on `jaywedgeworth22/agentic-trading`:

1. **Canonical reference:** Created `/Users/jay/apps/AG***-S**C.md` — the branch-neutral single source
   of truth for the inter-agent Slack coordination protocol. Covers: sender tags, terse message format,
   message structure (header + body fields), emoji reactions, Slack/bot access mechanics, real-time
   watcher behavior, conflict resolution, effort-board integration, and worked examples.

2. **Repo pointer:** Added short `## Inter-agent coordination` section to `AGENTS.md` (3-4 lines) that
   directs agents to read `/Users/jay/apps/AG***-S**C.md` before their first message. Includes quick
   context (channel id, effort-board primacy, peer-message semantics, watcher/poll patterns).

The canonical file lives branch-neutral (at `/Users/jay/apps/`), so every agent on every branch reads
the same authoritative rules without needing the protocol in their worktree. Repo files carry only a
lightweight pointer.

## Files

**Branch-neutral (outside worktree):**
- `/Users/jay/apps/AG***-S**C.md` — new canonical protocol reference; created fresh.

**Repo-tracked (in worktree, branch `claude/ag***-s**c-protocol-docs`):**
- `AGENTS.md` — replaced long `## Inter-ag*** s**c channel (#ag***-s**c)` section (earlier draft)
  with short `## Inter-agent coordination` pointer (3-4 lines) immediately before
  `## Cross-file consistency traps`.
- `STATUS.md` — prepended 2026-07-04 entry documenting the pointer + canonical reference.
- `docs/EFFORT-LOG.md` — one-line note on the "Wash-sale gate" In Progress row noting this docs branch.
- `docs/rollouts/2026-07-04-ag***-s**c-protocol-docs.md` — this file (updated to reflect the canonical/pointer split).

## Verification

- `npm ci` with `export NODE_AUTH_TOKEN=$(gh auth token)` — installation clean.
- `npm run lint` — 0 errors (295 pre-existing warnings), exit 0.
- `npx tsc --noEmit` — clean, exit 0.
- `npm test` — 2387 passed, all tests passing (holiday-date flake fixed in prior landing #339).
- `npm run build` — exit 0, clean.

## Follow-ups

- None. Docs-only change; `/Users/jay/apps/AG***-S**C.md` is not tracked in the repo (sits at
  the shared apps level), so no merge conflicts expected. Repo changes are isolated to AGENTS.md
  pointer, STATUS.md entry, and rollout note.

## Notes

- The canonical protocol file (`/Users/jay/apps/AG***-S**C.md`) lives outside the worktree at the
  shared `/Users/jay/apps/` directory (neutral across all agent worktrees). This ensures every agent
  reads the same authoritative rules without branch conflicts or the need to sync docstrings.
- The ASCII-safety note in `AGENTS.md` "Cross-file consistency traps" applies: the pointer section
  uses ASCII forms (`[`, `->`, `]`) to avoid breaking Apple's `/bin/bash 3.2.57` under `set -u`.
