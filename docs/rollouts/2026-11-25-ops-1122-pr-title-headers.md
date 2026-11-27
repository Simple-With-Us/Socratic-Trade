# PR Title Header Rule Mirror (OPS-1122)

## Context & Objective

Owner ruling, November 26, 2026: every PR title begins with the compact lettered fleet header for the session that opens the PR -- `[<SEAT>:` + three U+200A hair spaces + `<PAIR>.<GEN>.<HOST>]`, or `[<SEAT>]` unlettered -- then one ASCII space, then the human title, and the title header is never omitted and never stacked under a formatter prefix.  PR descriptions and comments keep carrying the header as their first line.  This is the `Socratic-Trade` mirror of the fleet-wide rule.

## Changes Made

- `AGENTS.md`: the `### Fleet Post Headers` section now states that every PR title begins with the compact lettered header, then one ASCII space, then the human title, that descriptions and comments carry the header on their first line, and that the opening session supplies the letter.
- `STATUS.md`: dated stanza.
- this rollout note.

## Decisions & Trade-offs

Docs-only mirror.  The canonical definition lives in AI-Fleet-Coordinator `FLEET-PROTOCOL.md` (separate PR).  No code or CI-skip changes.

## Verification State

Docs-only change.  No local gate run: docs-only; the CI `verify` gate covers the PR.  The diff was byte-checked: U+200A hair spaces only inside header examples, sentence gaps as U+00A0 + space, zero U+202F.

## Next Steps & Blockers

Merge this mirror and its siblings, then refresh the per-platform `fleet-coordination` SKILL.md copies in a follow-up.
