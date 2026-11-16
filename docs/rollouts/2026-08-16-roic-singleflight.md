# 2026-08-16 — ROIC single-flight (stop the 22-minute crash loop)

## Context & Objective

#2741 made ROIC due every 6h and raised the per-run budget, but `lastAttemptAt` was written only after the walk finished.  Every 60s scheduler tick therefore started another universe refresh.  Production stacked 714 `roic-transcript-refresh` rows in `running` and Coolify recorded `last_restart_type=crash` about every 22 minutes.

## Changes Made

- Process-level single-flight so a second tick returns immediately while a walk is in flight.
- Stamp `lastAttemptAt` at start, not end.
- Persist the universe cursor after each symbol so a crash resumes instead of restarting from the head.
- Due logic: leftover cursor always resumes; `lastCompleteAt` is the 6h quiet period; `lastAttemptAt` is only a 30-minute in-flight window.

Ops while the app was stopped (no live writer): stamped `lastAttemptAt` and marked 714 stacked journal rows `error`.  Restarted the existing `4bd3bcc0` image (not a new build).  L1 keep-400 shrink on B2 is still running so the first L2 compact is small enough to finish.

### Files

- `src/lib/web-sources/roic-transcripts.ts`
- `test/roic-transcripts.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Did not add a durable operation lease.  An in-process guard plus the start watermark is enough for the one Next process, and a leftover cursor still resumes after a crash once the 30-minute window expires.
- Did not write `app.db` while the app was running (dual-writer holes).  The watermark write happened after Coolify stop, before start.
- FilingAPI is unchanged: the Infisical key is still the expired trial.  Do not charge the owner's Stripe merchant account for filingapi.dev Plus.

## Verification State

Focused vitest + land.sh trio before merge.  After deploy: at most one `roic-transcript-refresh` row in `running`, `lastAttemptAt` moves at the start of a walk, and `/api/health` stays up for more than 22 minutes.

## Next Steps & Blockers

- Confirm L2 `fileCount >= 1` after the L1 keep-400 delete finishes and one 5-minute compact runs.
- Owner: Plus checkout at https://filingapi.dev and put the new value in Infisical `FILINGAPI`.
- After this lands, watch the cursor walk beyond USB / OXY / SHEL.

## Zero-Code Findings

- Public `/api/health` `filingapi.ok: true` is still the softened streak, not a live 200.
- Coolify `start` on an `exited:unhealthy` app queues a deployment that reuses the existing image when the commit has not changed.
