# 2026-10-14 Embed context budget and retrieval pressure

## Context & Objective

OpenRouter embed POSTs were still 400ing with `maximum context length` when a batch or a single dense string summed past bge-m3's 8192-token context.  SOCRATIC-TRADE-2G was paging "RAG retrieval failed" in a burst at the cash open because strategy symbol waves and query variants all hit the 15s deadline together.  SOCRATIC-TRADE-2E's ingest counter still charged one unit per text, so a text that cannot fit one embed window did not cost more than a short chunk.

## Changes Made

Embed input is fit to a token-aware budget before the POST.  Queries are truncated to one piece.  Documents are chunked and mean-pooled back to one vector so managed-commit cardinality stays the same.  If the provider still returns context length, a multi-text group is split in half and retried; a singleton is truncated once.  Truncating every string in a group that already fits the half budget was a no-op and resent the same POST.  Ingest metering records those windows (`batchCount`), and the daily prefix slice stops when the next text's windows do not fit.  The daily cap is not raised.  Retrieval takes a concurrency slot (default 4) before its inner deadline starts.  A timeout opens an exponential backoff; a caller that arrives during backoff gets no provider call and no extra retrieval-failed page.  A success clears backoff only for the epoch it observed when it took the slot, so a sibling timeout cannot be undone by a call that started earlier.  Backoff is off in vitest unless `RAG_RETRIEVAL_BACKOFF=1`.  Strategy filing waves use the same concurrency cap.  Search-fusion's alternate embed path truncates and packs the same way.  Empty embed text is one piece.  A non-string is rejected before `Buffer.byteLength`.

- `src/lib/rag/embed-request-pack.ts`
- `src/lib/rag/retrieval-pressure.ts`
- `src/lib/vector-db.ts`
- `src/lib/rag-metering.ts`
- `src/lib/rag/search-fusion.ts`
- `src/lib/strategy.ts`
- `test/embed-request-pack.test.ts`
- `test/retrieval-pressure.test.ts`
- `test/vector-db-chunk-cap.test.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The token estimate is the max of UTF-8 bytes/4 and a mixed floor (digits, `$`, and `|` at one token; other characters at 3.5 per token).  The byte cap stays 18750 so an ASCII piece cannot sneak past the provider even when the character floor is optimistic.  Mean-pooling keeps one Pinecone record per original text.  The 15s retrieval deadline and the 20000/day ingest cap are unchanged on purpose.  Concurrency defaults to 4 so a four-query fan-out is one wave.  Backoff does not run during the default vitest process, matching the embed circuit breaker, so one timed-out case cannot black-hole later tests.  SiliconFlow query rescue is unchanged.  This does not close Sentry 2G or 2E until a live deploy shows the burst and the context-length 400 are gone.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` ok (0 errors, 866 warnings).  `npx tsc --noEmit` ok.  `npm run build` ok.  `npm test` was 9278 passed, 51 skipped, 25 failed.  The failures are outside this diff: the sandbox has provider keys configured, so suites that expect no OpenRouter or Anthropic key fail, along with the local data-catalog database and `scripts/ops/summarize-cpuprofile.mjs`.  The first full run also failed four vector tests (table windowing and NaN batch counts).  Those are fixed.  A second full run no longer fails `test/vector-db-chunk-cap.test.ts`, `test/vector-db-embedding-integrity.test.ts`, or `test/embed-request-pack.test.ts`.

Targeted before the gate:

```bash
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/rag-multi-query-retrieval.test.ts test/embed-resilience.test.ts test/usage-compliance-classifier.test.ts
```

50 passed.

Follow-up after review (stale-success epoch, multi-text context-length split, empty-string and non-string estimates):

```bash
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/vector-db-chunk-cap.test.ts test/vector-db-embedding-integrity.test.ts
```

The first run failed the singleton shrink assertion because the default 2400 character cap already sat under the half-budget byte cap, so the retry text was the same length.  The test now uses an `is_table` string between the half-budget and full byte caps.  Re-run of the packer and pressure files: 18 passed.  The chunk-cap and integrity files passed in the same first run (the singleton failure was the only failure).  Follow-up `npm run lint` ok (0 errors, 866 warnings).  Follow-up `npx tsc --noEmit` ok.

## Next Steps & Blockers

Review the PR.  Do not merge from this lane.  After merge and the evening deploy, check Sentry 2G (retrieval-failed count at the open) and 2E (requested units vs 7500 windows).

Fleet board claim could not be filed from this seat.  `board whoami` and a Linear write were not run: this cloud VM has no fleet client credentials (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, or a seat `ZULIP_*`), and `scripts/install-fleet-coordination.sh` does not invent them.  The claim that would have been filed is Linear team ST, title "Fit embed input to the bge-m3 token budget and back off retrieval bursts", state In Progress, and Completed only after merge to `main`.  No Linear issue id was minted here.  `docs/EFFORT-LOG.md` is archived and was not edited.

Kody threads that this follow-up fixes (stale success clearing backoff, multi-text context-length resend, empty-string and non-string estimates, and the board-claim citation) can be resolved after the replies land.  Threads left open on purpose: process-global backoff dropping later symbols in the same wave, queue wait counting toward the outer strategy deadline, taking a retrieval slot before the embed-circuit check, recomputing `embedBudgetUnits` on the ingest slice, and the scope mismatch against GitHub #4660 / PRs #4658 and #4659.  Those last items are not this PR.

## Zero-Code Findings

Latest 2G event on 2026-10-14 was `strategy RAG retrieval timed out` for BUD on qdrant, not an embed 400.  Latest 1X was an embed provider timeout.  The context-length 400 is the packer path that still posted an over-budget string.  Raising the deadline or the daily text cap would not fit that string into 8192.
