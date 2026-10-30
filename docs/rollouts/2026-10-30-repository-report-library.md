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

The initial, pre-approval placement caveat was:

> The server lane guard currently rejects writes under `Code/Docs`; final placement requires an approved narrow exception.

## Placement Update — October 30, 2026

The owner-approved Docs-only exception is installed; Git integration checkouts remain protected.  Verification against the installed guard passed eight dedicated Docs cases and ten existing baseline cases.  The [private installation receipt](https://github.com/Simple-With-Us/Fleet-OPS/blob/402192b40ec45d719cea70f915461f8788ab2b79/docs/reports/evidence/2026-10-30-docs-guard-installation.jsonl) records before/after hashes and unchanged configuration/registration digests.  The initial collection covers 16 repositories, and its subsequent collector check returned `validated 0 planned operation(s)`.  Source refresh follows final repository delivery.

The security scan still needs an authorized workflow publisher to admit the approved exact CODEX actor.  This Markdown change does not alter deployment controls or workflow settings.

## Zero-Code Findings

There is no application-source change.  This is document organization and provenance tracking.
