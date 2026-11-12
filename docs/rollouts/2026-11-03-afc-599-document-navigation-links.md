# AFC-599 Document Navigation Link Repair

## Context & Objective

The document-library audit found broken local links in the settings-navigation implementation spec.  This change points its parent-design links at the existing canonical document so readers can navigate from each section.

## Changes Made

- Updated 12 Markdown links across `docs/settings-navigation-redesign/spec/00-README.md`, `01-global-frame.md`, `02-destinations-dashboard-approvals-scan.md`, `04-settings-field-reference.md`, `05-scoping-and-safety-model.md`, `06-data-model-and-api-changes.md`, `07-frontend-architecture-and-decomposition.md`, `08-delivery-plan-prs-and-tests.md`, `09-copy-deck.md`, `10-onboarding-modes-and-first-run.md`, and `11-accessibility-responsive-mobile.md` to resolve to `docs/settings-navigation-redesign.md`.
- Corrected the plain-text breadcrumb in `00-README.md` to the same target.
- Updated `STATUS.md`.

## Decisions & Trade-offs

The referenced design already exists at the repository root under `docs/`.  This was a relative-path repair only; it does not change product behavior, settings, or the archived design content.

## Verification State

- Checked the changed Markdown targets against the repository tree from this lane.
- Local application tests were not run because this change only edits documentation links.
- Hosted pull-request checks and review remain pending.

## Next Steps & Blockers

Review the published pull request and its hosted documentation checks.  Recollect the document library from published `main` after the correction is merged.

## Zero-Code Findings

The canonical parent design is present at `docs/settings-navigation-redesign.md`; the broken links came from relative paths that resolved inside the `spec/` subdirectory.
