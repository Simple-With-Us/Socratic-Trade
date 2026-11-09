# 2026-07-08 — Activity log: consolidate run-scoped + housekeeping events (MONET)

## Summary
Owner: the Activity log showed 30-40 separate entries per hour where 2-3+ always occur
together (a run plus its subcomponents; a notification plus its delivery mechanics).
Keep all data, bundle visually. Fixed in the shared feed builder (`dashboard-feed.ts`) —
no schema/API change, pure presentation grouping.

## Why it under-grouped
The grouping architecture existed but ran on narrow allowlists: only 5 audit kinds
joined a `run-<runId>` group while a real run emits 15+ runId-tagged kinds
(rag_retrieval_status, experience_retrieval, evidence_age_anomaly, llm_call_latency,
socratic_outcome_job, strategy_bear_review_*, ...), each rendering as its own card.
Run-scoped notifications ("Sell blocked", "Run failed") ignored their payload runId and
rendered standalone. Only 3 kinds counted as housekeeping.

## Changes (src/lib/dashboard-feed.ts + test/dashboard-feed.test.ts)
- `runGroupIdForAudit`: generic — ANY audit event whose payload carries a runId joins
  `run-<runId>` (proposal-linked events keep `prop-` precedence; the run card's title
  stays anchored on the strategy_run summary event). New run-scoped kinds bundle
  automatically — no more allowlist maintenance.
- Notifications: precedence proposal > run > standalone (payload.runId now honored).
- `OPS_AUDIT_KINDS` widened: + notify.sent, notify.error (channel-delivery mechanics —
  the notification row with content/status stays in the main feed),
  due_jobs_intraday_sample_drain, vector_store, recoverable_issue, llm_cache_usage.

## Measured on real production data
Replayed the busiest recent hour (2026-07-07T13, 54 raw events) through the new builder:
**8 main cards + 1 collapsed System row (14 background events)** vs ~40 cards before.
Each run = one card with ~15 expandable sub-events. Nothing dropped.

## Verification
- `npx tsc --noEmit` 0 errors; dashboard-feed suite 23/23 incl. a new consolidation test
  (7 previously-stray audit kinds + a run-scoped notification -> ONE card; cross-run
  isolation; no stray standalone cards).
- Real-data replay above. Full gate via land.sh.

## Follow-ups
- fill_reconciled rows still standalone (meaningful; could group per reconcile sweep).
- The System bucket counts each ops event as its own collapsed group; could merge
  same-kind consecutive events into counted entries ("9x due-jobs drain").
