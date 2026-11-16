# 2026-07-08 — Proposer/Reviewer Model naming + accurate Red-team description (MONET)

## Summary
Owner review of the model pickers (strategy page + settings/models):
- "Proposer model" → "Proposer Model" (capital M), hint now "aka Green Team or Bull — writes
  the trade proposals each run."
- "Red-team model" / "Reviewer / Strategy Review (red team)" → "Reviewer Model", hint
  "aka Red Team or Bear — reviews every proposal each run, and runs a deeper adversarial
  debate on high-conviction or dissent-flagged ideas."
- The "tries to kill high-conviction ideas" description was factually stale: the Red model
  reviews ALL proposals via the inline Bear every run; the conviction/dissent-gated
  debateProposal is the ADDITIONAL deeper pass. Copy now states both. Settings-page intro
  blurb aligned to the same naming.

## Owner question answered: per-seat model outcome attribution
- GREEN: first-class — every proposal persists `proposedByModel` (failover-aware; the
  model that actually served, not just policy.llmModel), surfaced by the 2026-07-08
  attribution UI (#1076) and joinable to realized outcomes.
- RED: partial — the debateProposal verdict record carries the reviewer `model`
  (red-team.ts `debate: {..., model}`), and each run's inline-Bear provider/model is in the
  `candidates_considered.llmSteps` / `llm_step` audits (per-run, not stamped per proposal).
  Follow-up for the single-adversary consolidation (which restructures this exact path):
  stamp `reviewedByModel` on the proposal like `proposedByModel`, so Red attribution joins
  outcome analytics symmetrically.

## Files
app/console/strategy/page.tsx, app/console/settings/models.tsx (copy only).

## Verification
tsc 0 errors; lint 0 errors; no tests assert the old labels; full gate via land.sh.
