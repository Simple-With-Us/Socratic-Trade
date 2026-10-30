# Repository Report Library

## Context And Objective

The owner requested a predictable location for reports, audits, reviews and overviews, with an additional central collection grouped by exact GitHub repository names.  Existing historical records must remain discoverable and retain their original paths.

## Changes Made

Adds `docs/reports/README.md`, updates `STATUS.md` and `PLAN.md`, and records this rollout.  The report index links the existing canonical collections.  New public-safe reports belong in `docs/reports/`; private operational evidence belongs in private Fleet-OPS.

## Decisions And Trade-Offs

The central collection is generated from published Git objects and records source commits and hashes.  Historical records are indexed in place, preserving links and archaeology.  The application roadmap and trading behavior are unchanged.

## Verification State

Index links are checked against the source Git tree.  This change contains Markdown documentation only; the repository's documentation classification and required current-head checks determine CI coverage.  Shared collector tests are tracked in AI-Fleet-Coordinator under AFC-580.

## Next Steps And Blockers

Publish and review the report index, then refresh the central collection from the merged source revision.  The server lane guard currently rejects writes under `Code/Docs`; final placement requires an approved narrow exception.  No deployment control or guard setting is changed by this PR.

## Zero-Code Findings

There is no application-source change.  This is document organization and provenance tracking.
