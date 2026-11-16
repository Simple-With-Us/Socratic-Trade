# Deduplicate SEC 10-K Evidence Cards in Console Proposal Drawer

**Date:** 2026-08-03
**Agent:** Antigravity

## Context & Objective
The user reported two issues on proposal detail drawers:
1. Two separate evidence cards (`sec-edgar` and `Retrieved 10 K`) were rendered for the exact same SEC 10-K document and score (e.g. score 0.40).
2. Proposed trades hit `staleness_gate: quote is 934574s old (max 120s)` because old pending proposals retain the scan timestamp from when the proposal was generated rather than dynamically updating the UI state until approval.

## Changes Made
- `app/console/page.tsx`: Updated `deriveEvidenceRows()` to check if a RAG attribution's `contribution` body string is already present in the formatted evidence rows before appending a second card.

## Verification State
- `npx tsc --noEmit`: Clean (0 errors).
- `npm test`: 46 test files passed, 224 tests passed.
