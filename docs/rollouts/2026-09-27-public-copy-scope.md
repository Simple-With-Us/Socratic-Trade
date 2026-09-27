# Public description scope — 2026-09-27

## Context & Objective

The owner requested humbler descriptions of the public sites.  The welcome and framework pages described complete trace coverage and outcome learning more broadly than the source and available-data conditions justify.

## Changes Made

- `app/welcome/page.tsx`: replace universal trace and improvement claims with configured research, decision records, and outcome review; label access by invitation; remove unsupported zero-price structured offer.
- `app/how-it-works/page.tsx`: describe available evidence and review stages without guaranteeing improvement or complete outcomes.
- `README.md`: distinguish invite-only current-bundle iOS preparation from an available public release.
- `STATUS.md`, `PLAN.md`, `docs/phase-10-signals-learning-ui-v2.md`, and `docs/EFFORT-LOG.md`: record scope and preserve the prior footer release evidence.

## Decisions & Trade-offs

Source review included `framework-review.ts`, `learning-loop.ts`, `learning-review.ts`, and `guardrail-copy.ts`.  The shared authority strings and runtime behavior are unchanged.  Existing legal disclosures are retained.  Outcome review can inform decisions but does not prove a future performance improvement.

## Verification State

`git diff --check` passed.  The worktree has no installed dependencies, and the Mac is under heavy load, so the required lint, typecheck, test, and build checks run in the existing hosted CI workflow.  No additional local install or build was started.  CI and deployment results will be recorded after completion.

## Next Steps & Blockers

Merge PR #3864 after required hosted checks pass, then verify the automatic Coolify deployment and both public pages.  No manual deployment or native release dispatch belongs to this unit.

## Zero-Code Findings

The earlier full SWU footer asset is live at `/swu-logo-wide.webp`, byte-equal to source, with public health `ok: true`.  This new copy unit has not yet been deployed.
