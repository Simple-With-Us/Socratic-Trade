# 2026-10-14 Embed context budget and retrieval pressure

## Context & Objective

OpenRouter embed POSTs were still 400ing with `maximum context length` when a batch or a single dense string summed past bge-m3's 8192-token context.  SOCRATIC-TRADE-2G was paging "RAG retrieval failed" in a burst at the cash open because strategy symbol waves and query variants all hit the 15s deadline together.  SOCRATIC-TRADE-2E's ingest counter still charged one unit per text, so a text that cannot fit one embed window did not cost more than a short chunk.

## Changes Made

Embed input is fit to a token-aware budget before the POST.  Queries are truncated to one piece.  Documents are chunked and mean-pooled back to one vector so managed-commit cardinality stays the same.  One context-length 400 still shrinks the payload once and retries.  Ingest metering records those windows (`batchCount`), and the daily prefix slice stops when the next text's windows do not fit.  The daily cap is not raised.  Retrieval takes a concurrency slot (default 4) before its inner deadline starts.  A timeout opens an exponential backoff; a caller that arrives during backoff gets no provider call and no extra retrieval-failed page.  Backoff is off in vitest unless `RAG_RETRIEVAL_BACKOFF=1`.  Strategy filing waves use the same concurrency cap.  Search-fusion's alternate embed path truncates and packs the same way.

- `src/lib/rag/embed-request-pack.ts`
- `src/lib/rag/retrieval-pressure.ts`
- `src/lib/vector-db.ts`
- `src/lib/rag-metering.ts`
- `src/lib/rag/search-fusion.ts`
- `src/lib/strategy.ts`
- `test/embed-request-pack.test.ts`
- `test/retrieval-pressure.test.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The token estimate is the max of UTF-8 bytes/4 and a mixed floor (digits, `$`, and `|` at one token; other characters at 3.5 per token).  The byte cap stays 18750 so an ASCII piece cannot sneak past the provider even when the character floor is optimistic.  Mean-pooling keeps one Pinecone record per original text.  The 15s retrieval deadline and the 20000/day ingest cap are unchanged on purpose.  Concurrency defaults to 4 so a four-query fan-out is one wave.  Backoff does not run during the default vitest process, matching the embed circuit breaker, so one timed-out case cannot black-hole later tests.  SiliconFlow query rescue is unchanged.  This does not close Sentry 2G or 2E until a live deploy shows the burst and the context-length 400 are gone.

## Verification State

Targeted, before the full gate:

```bash
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/rag-multi-query-retrieval.test.ts test/embed-resilience.test.ts test/usage-compliance-classifier.test.ts
```

50 passed.

Full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`) is recorded in the follow-up commit on this branch once those commands finish.

## Next Steps & Blockers

Review the PR.  Do not merge from this lane.  After merge and the evening deploy, check Sentry 2G (retrieval-failed count at the open) and 2E (requested units vs 7500 windows).  This cloud seat had no `board` / Linear client, so team ST was not claimed here.  Unfixed Kody threads stay open with a rationale.  None exist at PR open.

## Zero-Code Findings

Latest 2G event on 2026-10-14 was `strategy RAG retrieval timed out` for BUD on qdrant, not an embed 400.  Latest 1X was an embed provider timeout.  The context-length 400 is the packer path that still posted an over-budget string.  Raising the deadline or the daily text cap would not fit that string into 8192.
