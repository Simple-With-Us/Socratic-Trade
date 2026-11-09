# 2026-08-05 — Framework proposal agent review + reopenable UI

## Context & Objective

Owner accidentally accepted/applied Framework Improvement cards in the console and
could not undo them (buttons disabled once `status !== "pending"`). They asked for
an agent review of every proposal, clarification of **Accept vs Applied**, and
correction of the accidental selections.

## Changes Made

### Production data (ops, not in this commit)

Queried `socratic_framework_proposals` on prod (`socratic-app` container). Only
**3** rows exist (not 4). Reviewed underlying `socratic_decisions` and set all three
to **rejected** with owner_response notes:

| Title | Was | Now | Why |
| --- | --- | --- | --- |
| Blocked override request for PG | applied | rejected | Hard accounting gate (`Sell quantity exceeds… holdings`), not a preference. No allowlist change. |
| Blocked override request for T | accepted | rejected | Same hard-gate class as PG. |
| Review overridden BAC gate | accepted | rejected | Override applied over red_team_veto but trade `status=error` / no fill — cannot score outcome; do not relax red-team gate from this case. |

Accept/Applied/Reject on framework proposals are **workflow markers only** — they
do not mutate policy, allowlists, or prompts. Correcting status undoes only the
label, not any code change (none had been implemented).

### Code (this PR)

- `app/console/page.tsx` — `FrameworkProposalList`:
  - Legend explaining Accept vs Applied vs Rewrite vs Reject.
  - Accept / Rewrite / Reject remain enabled after resolution (change of mind).
  - **Reopen** → `status: pending` for a clean re-review.
  - Tooltips on each action.
  - Applied still requires prior Accept (or already Applied).

## Decisions & Trade-offs

- **Reject** rather than rewrite for PG/T: the proposed text is a generic audit
  checklist; the correct audit conclusion is already encoded in
  `HARD_GATE_REASON_PATTERNS` / `isHardGateReason`. A rewrite would restate
  product truth without changing behavior.
- **Reject** BAC rather than leave Accepted: "score after matures" is good process
  in general, but this case cannot mature; leaving Accepted implies future gate
  relaxation homework that should not run on a failed fill.
- UI allows flipping decisions without a two-step reopen first; Reopen is still
  there for a clean Pending badge.

## Verification State

```bash
# prod statuses (post-update)
# PG/T/BAC all status=rejected, owner_verb=reject

# local (land.sh gate)
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Optional: agent prompt fix so openings do not request overrides of hard
  accounting gates (phantom shorts / long-only mislabel on PG/T).
- Optional: run "AI review pending" on future proposals so advisory verdicts
  appear before owner clicks.
- No deploy claim needed beyond merge-to-main auto-deploy for the UI fix; prod
  status corrections already live via DB update.

## Zero-Code Findings

- Accept ≠ Applied: Accept = intent; Applied = "I already implemented it."
- Neither auto-implements framework changes today.
- Only three framework proposals existed in prod at review time.
