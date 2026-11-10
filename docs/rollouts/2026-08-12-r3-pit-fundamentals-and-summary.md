# 2026-08-12 — Round 3 summary + PIT fundamentals revision chain

## Context & Objective

Round 3 of the external-repo lessons effort (owner: "build out more features if some are planned").  Four Planned-backlog features built by dedicated agents, each adversarially verified and integration-fixed; per-slice detail lives in the sibling notes (`2026-08-12-r3-proposal-scorecard.md`, `2026-08-12-r3-lookahead-audit.md`, `2026-08-12-r3-polymarket-context.md`).  This note covers the PIT slice (which had no note of its own) and the round's integration pass.

## Changes Made

PIT fundamentals revision chain (`ffe9e223`, scoped to SEC-XBRL GAAP facts):
- New `fundamental_revisions` table (migration; market facts, deliberately exempt from account deletion) using the `superseded_by` idiom: every filed value for a (symbol, field, fiscal-period) is a distinct row keyed by `filed_at`; restatements never rewrite history.
- `recordFundamentalRevision` writes from the SEC-XBRL enrichment branch (`parseCompanyFacts` now threads `end`/`filed`/`form` through its return shape); `getFundamentalAsOf(symbol, field, asOf, { strict })` reads point-in-time — lenient default falls back to `symbol_field_latest` (live behavior unchanged), strict (`FUNDAMENTALS_ASOF_STRICT`) returns undefined rather than guessing.
- Accessor contract documented: latest-wins reads are banned from historical-evaluation paths.

Integration pass (`64b85662`) fixed all 13 residual verifier findings across the four slices, including: windowed lookahead verdicts (90-day) shared by the lane and API route; `no_memory` RAG replays classified unverifiable; out-of-order revision inserts re-sweeping the supersede chain by `filed_at`; no synthesized original-filing rows (paired facts bound to the row's own `filed_at`); equity-concept consistency for debtToEquity revisions; Polymarket outcome/price index alignment + a 4s fetch timeout; sniper-accuracy receipts preserved across every outcome construction; literal 50/200-bar SMA windows.

## Verification State

- Integration commit ran the FULL suite: `npm test` 6423 passed / 51 skipped; `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm run build` clean (node 24).
- Post-merge with origin/main (incl. #2663 broker/venue changes): tsc clean; 207 tests across the merged data-provider/PIT/Polymarket/copy-intel seams.
- `scripts/land.sh` re-runs the trio before push; the `verify` CI gate re-runs everything before merge.

## Next Steps & Blockers

- This PR's deploy activates the re-enabled SEC ingest knobs (`SEC_INGEST_WORKER_ENABLED=on`, `SEC_FILING_RAG_MAX_PER_RUN=25`) — watch the first sync stretch for event-loop pinning (the 2026-08-10 pause reason); the yield fix is queued in round 5.
- Round 4 (owner directives): toggles-made-real sweep, advisory reword, ATR-based secondary-buy default, real-index benchmarks, admin Operations panel for env pause knobs, prompt data-age audit.
