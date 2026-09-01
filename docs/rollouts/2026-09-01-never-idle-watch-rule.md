# 2026-09-01 — Codify "Never idle-watch a PR" as a binding fleet rule

## Context & Objective

Owner ruling, 2026-09-01: agents "should never just wait and watch for things to merge
since that wastes tokens/time and they inevitably almost invariably end up slowly wasting
money/quota while the PR sits there with conflicts or comments/issues unresolved."  This
lands that rule in the places agents actually read, so the failure mode — a seat burning
turns polling a PR that is blocked on an action nobody took — stops recurring.

The rule is the missing second half of "Always commit + land finished work": landing work
means *driving* it to merge, never watching it.

## Changes Made

Docs/rules only.  No runtime code touched.

This repo:

- `AGENTS.md` — new bullet block at the end of the `## Pull requests` section (`CLAUDE.md`
  is a symlink to `AGENTS.md`, so it carries the same text; do not edit both).
- `docs/EFFORT-LOG.md` — effort row.
- `STATUS.md` — snapshot entry.
- `docs/rollouts/2026-09-01-never-idle-watch-rule.md` — this note.

Outside this repo (same rule, each in that file's own voice):

- `/Users/jay/apps/AGENT-SYNC.md` — new canonical section `## Never idle-watch a PR
  (owner ruling 2026-09-01 — ALL agents, ALL platforms, ALL repos)`, placed directly after
  `## Merge requirements`.  Everything else cross-references it.
- `/Users/jay/Code/ai-fleet-coordinator/AGENT-SYNC.md` — same section, landed by PR so the
  GitHub copy does not drift from the live file.
- `/Users/jay/.claude/CLAUDE.md` — short stanza after "Always commit + land finished work".
- `Congress.Trade` and `Usage-Monitor` `AGENTS.md` — same rule, in each repo's own voice.

## Decisions & Trade-offs

- **Canonical home is AGENT-SYNC.md.**  The app repos and the global `CLAUDE.md` state the
  rule in full enough form to act on without a second lookup, then point at AGENT-SYNC for
  the authoritative version.  Restating rather than linking-only is deliberate: an agent
  that has only loaded this repo's `AGENTS.md` must still get the whole behavior.
- **The rule names a diagnosis, not a prohibition on waiting.**  A single bounded
  `gh pr checks <n> --watch` is explicitly allowed — what is banned is the *second* wait,
  and any turn whose only output is "still running".  Framing it as "a PR is waiting on an
  ACTION, here is the table of causes" gives the agent something to do instead.
- **Not enforced in code.**  There is no lint or CI gate that can detect idle polling; this
  is a behavioral rule in the instruction files, same class as "always commit + land".
- `CLAUDE.md` symlink verified with `ls -l` before editing (`CLAUDE.md -> AGENTS.md`), so
  only `AGENTS.md` was modified.

## Verification State

Docs-only change; the full gate was still run via `scripts/land.sh`:

```bash
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

None.  The other four files land on their own paths (two live files edited in place, three
repo PRs).  Nothing here needs a production deploy — `docs/**`, `STATUS.md`, and
`AGENTS.md` are outside the Coolify `watch_paths` list, so this merge is an image-noop.
