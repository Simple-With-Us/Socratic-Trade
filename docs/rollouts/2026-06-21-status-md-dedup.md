# 2026-06-21 — STATUS.md dedup

## Summary

Removed an interleaved duplicate block of three `## Active Focus` entries in
`STATUS.md` (the second copies of the 2026-06-19 **Ops/observability/security
foundation**, **Broker Connection UI Split**, and **Composite Universe & System
State Migration** entries). The first occurrences are retained; the redundant
second copies (and a near-duplicate, slightly-reworded Ops entry) were deleted.

## Why

The three entries appeared twice — almost certainly the residue of a past
"keep both sides" merge-conflict resolution in this high-churn, multi-agent file.
Duplicated entries make the snapshot misleading. This note exists so the deletion
is on record and not mistaken for an accident (per the AGENTS.md "don't silently
delete without a paper trail" rule).

## Files

- `STATUS.md` — deleted the 12-line duplicate block (Active Focus); added this
  entry at the top of Active Focus.
- `docs/rollouts/2026-06-21-status-md-dedup.md` — this note.

## Verification

- Docs-only. `grep '^- ' STATUS.md | sort | uniq -d` is now empty (no duplicate
  bullets). No conflict markers; single `## Active Focus` header. tsc/test/build
  unaffected (not re-run for a markdown-only edit).

## Follow-ups

- `STATUS.md` has grown to ~160 Active Focus entries / ~950 lines — it has drifted
  from the "concise current snapshot" its own header (and the AGENTS.md
  Documentation Rules) prescribe, with the full chronology already preserved in
  `docs/rollouts/`. A future pass could trim Active Focus to the recent/relevant
  set and let `docs/rollouts/` carry the history. Not done here to avoid a
  large, judgment-heavy deletion on a file other agents are actively appending to;
  worth doing deliberately with owner sign-off. The recurring `STATUS.md`
  top-append merge conflicts in this repo are the same root issue.
