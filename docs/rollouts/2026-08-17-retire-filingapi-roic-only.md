# 2026-08-17 — FilingAPI retired; ROIC.ai only

## Context & Objective
Owner: we are not using FilingAPI. Earnings and transcripts are ROIC.ai only. Agents kept asking for a Plus checkout. Stop that.

## Changes Made
- `retired-direct-vendors.ts`: FilingAPI is a retired vendor. `filingapi.dev` is blocked. Health shows intentional OFF.
- Do not register `FilingApiEnrichmentProvider` even if `FILINGAPI` is still in Infisical.
- `enrich()` is a no-op. Reprobe does not hit filingapi.dev.
- Board: dropped the Plus-checkout leftover. Cancelled row under Completed.

## Decisions & Trade-offs
Parsers stay for existing tests. Catalog status is `off`. Do not mint or ask for a key.

## Verification State
Focused: `retired-direct-vendors.test.ts`, `health-alert-noise-gate.test.ts`.

## Next Steps & Blockers
None for FilingAPI. Transcript ingest stays on ROIC.ai.

## Zero-Code Findings
The 401 was a dead trial key. Owner already said not to pay for Plus.
