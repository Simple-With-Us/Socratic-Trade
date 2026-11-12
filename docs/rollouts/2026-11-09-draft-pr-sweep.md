# 2026-11-09 — Draft-PR sweep (ST-4597): triage of 44 restore-event drafts; port of telemetry URL redaction

## Context & Objective  
The Nov 8 branch-restore event auto-opened 44 visibility draft PRs for agent branches 2-4 months old and 300-2000 commits behind main.  Owner directive: finish, combine, merge, or close as many as possible.  Four read-only workers triaged every draft against current main; 39 were closed with evidence comments (substance landed evolved, or the branch would regress an owner ruling); #5062 (owner-approved autofix token grants) landed via branch update + verify; three carried real unlanded work and are being finished as fresh branches: this one (#5046 intent), #5098 (FilingAPI retirement), #5093 (pinecone residual removal).

## Changes Made  
- Ported `sanitizeTelemetryUrl` from the #5046 branch into `src/lib/telemetry-sanitize.ts`: parses query-param names generically and redacts sensitive ones. This closes a real gap: providers this app actually uses pass `?apikey=` (no separator), which the old patterns missed, so provider keys could reach Sentry unredacted inside request URLs.
- Wired it into all three Sentry runtime configs (`instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`) in both `beforeSend` and `beforeSendTransaction`.
- Added `test/telemetry-sanitize.test.ts` (5 cases) covering the `?apikey=` shape, the legacy param names, non-sensitive passthrough, no-query URLs, and non-string input.
- Did NOT port the Session Replay sanitizers or `redactTransactionEvent`: Session Replay landed on main via a newer env-knob design (2026-09-04) and the rest of the #5046 branch is superseded.

## Decisions & Trade-offs  
- Fresh branch instead of updating the stale one: the branch is 1,018 commits behind; a fresh port keeps CI meaningful and drops its landed/declined halves.  
- Closing other seats' visibility drafts happens with a written evidence comment on each (canonical PR numbers, file paths, Linear receipts); branches are kept, nothing force-deleted.  
- Relay gr_* verbs are unavailable from this seat/session (same gap as OPS-1055), so all PR writes this sweep use gh under the owner account; logged for the GitOPS deficiencies doc.

## Verification State  
- `npx tsc --noEmit` clean; `npx vitest run test/telemetry-sanitize.test.ts` 5/5 green.  
- Full trio (tsc + vitest + next build) runs in CI `verify` on this PR.

## Next Steps & Blockers  
- #5098 (FilingAPI retirement): needs a 4-file conflict resolution against main's newer retired-direct-vendors machinery.  
- #5093 (pinecone residual): `pinecone-write-class.ts` deletion requires rewiring 5 importer modules plus dropping the dependency.  
- 39 drafts closed; full disposition list in ST-4597 and per-PR comments.

## Zero-Code Findings  
- All 44 drafts trace to the same restore event; none carried a hold or do-not-close marker.  
- #5110 and #5112 would have REGRESSED main (re-clamping enrichment symbols the owner un-clamped 2026-07-09; deleting live #2353 content whose wedge was durably fixed 2026-08-02) - closing them prevented a regression, not just cleanup.
