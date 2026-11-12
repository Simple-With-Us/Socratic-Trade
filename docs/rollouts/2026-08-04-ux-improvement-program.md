# Rollout: UX improvement program (sequenced PR plan)

## Context & Objective

Owner asked for a thorough top-to-bottom review of the web and iOS products, then a **sequenced implementation plan** (PR slices on the effort board) rather than a single mega-PR. This rollout anchors that program so any agent can claim slices without re-deriving the review.

## Changes Made

- Added durable design/program doc: `docs/design/ux-improvement-program.md`
  - Waves A–F (trust → IA → speed → mobile → polish → later)
  - Concrete PR slices with effort, files, acceptance, verify, keepouts
  - Owner decision gates D1–D4
  - Binding non-goals (no primitive merge, no fake fills, no new destinations, no glass on data)
- Reserved Planned rows on live board + repo mirror for the program and Wave A first slices
- STATUS.md pointer to the program

## Decisions & Trade-offs

- **Docs-only PR-0** lands first so implementers share one source of truth before code churn.
- Phone product default if owner silent: **both PWA and console ship**; PWA = control remote.
- Nav renames (Thesis→Home etc.) gated on owner D2 — not forced in PR-0.
- Deliberately did **not** start implementation of A1/A2 in this unit (plan + reservation only).

## Verification State

- Docs only; no app code paths changed.
- Plan file path verified present under `docs/design/`.

## Next Steps & Blockers

1. Any agent claims **PR-A4** (Guardrails defaultOpen — S) or **PR-A5** (noun pass — S) as quick wins.
2. **PR-A2** (approval card density) and **PR-A1** (honest skips) are the high-impact P0 code slices.
3. Owner optional: answer D1–D4 in program doc to unblock B1 / B5 / E2.
4. Do not claim overlapping keepouts (approval-card, strategy run status, dashboard snapshot) without #ag***-s**c.

## Zero-Code Findings

Full review conclusions live in the session narrative and are operationalized in `docs/design/ux-improvement-program.md`. Highest leverage themes: plain nouns, progressive disclosure on proposals, first-run checklist, honest skip statuses, one phone IA, brand parity on iOS, snapshot/scan speed.
