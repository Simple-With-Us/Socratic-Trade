# Handoff-file grep trap (do not print KEY=value lines)

## Context & Objective

A Grok session listed keys in `~/.secrets/global-api-keys` with
`grep '^[A-Z0-9_]+='`, which prints **values**.  Owner rotated and asked that
agent rules forbid the next seat from doing the same.

## Changes Made

- Fleet canonical: `/Users/jay/apps/AGENT-SYNC.md` § Handoff-file grep trap.
- `TEMPLATE-AGENTS.md` one-liner for new apps.
- This repo `AGENTS.md` (Coolify stanza + Don't list).
- Claude `secret-safety` skill: names-only requires `-o`.

## Decisions & Trade-offs

- Allowed name listing must use `grep -oE '^[A-Z][A-Z0-9_]*'` so the match
  cannot include `=value`.
- Rotation is done; this change is preventative only.

## Verification State

Docs-only.  `AGENTS.md` / AGENT-SYNC text review.

## Next Steps & Blockers

None.
