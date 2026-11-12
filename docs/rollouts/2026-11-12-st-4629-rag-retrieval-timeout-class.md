# ST-4629 — Retrieval timeouts do not page

## Context & Objective

Sentry SOCRATIC-TRADE-3Q escalated on 2026-11-11 with 13 events titled "Error: RAG retrieval timed out", last seen 2026-11-11T21:27:01Z.  ST-4601 already classified the strategy deadline and reported it with captureMessage at warning.  That capture attaches a synthetic stack, so Sentry files an error issue and the issue escalates.  An AbortError that left acquireRetrievalSlot still hit the retrieve catch and captured error-level "RAG retrieval failed".

## Changes Made

A retrieval deadline, abort, or timeout on the retrieve path logs locally and fails open to empty chunks.  It does not call captureMessage.  A real non-timeout lookup failure still captures "RAG retrieval failed" at error.  acquireRetrievalSlot was already applied inside embedAndMatchOneQuery, before the embed and the vector read.  A timeout that still escapes that slot is classified in the retrieve catch.  Ingest-embed classification and trading behavior are unchanged.

- `src/lib/autonomy-halt-cause.ts`
- `test/st4561-audit-events-index.test.ts`
- `src/lib/vector-db.ts`
- `src/lib/rag/retrieval-pressure.ts`
- `test/rag-deadline-timeout-classification.test.ts`
- `test/retrieval-pressure.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-11-12-st-4629-rag-retrieval-timeout-class.md`

## Decisions & Trade-offs

Did not keep a warning-level captureMessage.  The production events were already level warning and still opened SOCRATIC-TRADE-3Q.  Skipping the Sentry issue is what stops the page.  The pressure gate still records the failure and backs off.  When backoff is already open, or the slot already degraded the call, the catch does not report again.  Did not change RAG_QUERY_IO_DEADLINE_MS, ingest-embed classification (ST-4607), RAG ingest caps (ST-4609), order placement, sizing, or strategy settings.  Merged origin/main through ba400936, which landed ST-4607.   The ingest document-embed timeout reporter and its embed-timeout fingerprint stay.   Only the retrieval reporter skips Sentry.  lookup_failed stays the status for a timed-out retrieve, so strategy failure accounting is unchanged.  Empty chunks stay the continue path.  A Sentry review on PR 5173 showed the backoff classifier matched any message containing timeout.   It now matches the deadline marker and an AbortError or TimeoutError by name.   An upstream HTTP 504 Gateway Timeout still captures RAG retrieval failed at error.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Ran on Node 26.13.1 with the nvm binary ahead of PATH.   `npm run lint` exited 0 with 869 grandfathered warnings.   `npx tsc --noEmit` was clean.   Focused vitest on the deadline, pressure, retrieval-deadline, and cooldown files passed 20 tests.   Those abort and deadline assertions failed before this classification change.   Full `npm test` reported 18 failures in 12 files and 10251 passes.   The failures are ambient provider keys plus a gh 401 in `test/automerge-reusable-pin.test.ts`, the same class noted for ST-4601, and none are in the retrieval files.   A clean `env -i` re-run of the five key-sensitive files passed 131 tests.   `npm run build` first aborted at the default 2 GB heap (exit 134).   The retry with `NODE_OPTIONS=--max-old-space-size=4096` exited 0.  After merging origin/main through ba400936, `npx tsc --noEmit` and `npm run lint` were clean again, the five retrieval and ingest-timeout files passed 26 tests, and `npm run build` with the 4 GB heap exited 0.  The provider-timeout assertions failed before this narrowing.   The same five files then passed 28 tests.  Hosted verify then failed one unrelated assertion in test/autonomy-halt-cause.test.ts.   A policy change written in the same millisecond before a breaker halt was counted as a later handover, so the cause read as stopped.   The handover check now requires a greater rowid as well as a timestamp that is not earlier.   That assertion failed before the tiebreaker and the halt-cause and index-plan files passed after it.

## Next Steps & Blockers

The PR is opened from this branch against main.   Do not merge, do not enable auto-merge, and do not deploy.   Jay merges after the required verify check is green.   GB-Trader already holds the Linear claim.

## Zero-Code Findings

acquireRetrievalSlot is called in embedAndMatchOneQuery before createRagQueryAbort.  A null slot sets quietEmbedDegrade and returns no matches without a Sentry error.  The 13 SOCRATIC-TRADE-3Q events were operation embed query, provider openrouter, level warning, interface_type exception, release d85f2224.  That shape is the synthetic stack on captureMessage, not a separate hard "RAG retrieval failed" title.
