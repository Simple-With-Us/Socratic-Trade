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

### Codex autofix pass (ingest-budget memoization)

`embedBudgetUnits` is a char-walk plus a binary-search truncation, and the ingest path paid it twice for the same strings: once in the `budgetInputs` reduce and again inside `prefixCountWithinEmbedUnits` on the over-budget path.  `budgetInputs` also holds one entry per document, so repeated texts were re-walked per copy.  The reduce now memoizes per exact text in a `Map` and hands that map to the prefix walk as an optional `precomputedUnits` argument.  The parameter is additive with a compute-on-miss fallback, so the existing two-argument callers and tests are unaffected.

`src/lib/rag/embed-request-pack.ts`, `src/lib/vector-db.ts`, `test/embed-request-pack.test.ts`.

Autofix-pass gates: `npm run lint` ok (0 errors, 866 warnings, unchanged).  `npx tsc --noEmit` ok.  `npx vitest run test/embed-request-pack.test.ts` 13 passed.  Full `npm test` fails 13 tests across `llm-provider`, `chat-llm`, `openrouter-credits`, and `framework-review` — the sandbox-credential class above, reproduced identically with this diff stashed, so it is not from this change.  `npm run build` ok.

The other open Kody thread (acquiring the retrieval slot before the embed-circuit check) is deliberately not changed.  A breaker pre-check in front of `acquireRetrievalSlot` would suppress the OpenRouter to SiliconFlow query rescue that currently runs while the OpenRouter circuit is open, and it would also stop serving embeddings that `getCachedQueryEmbedding` already has.  Reordering the slot and the circuit check is a behavior change that needs a maintainer decision, not a mechanical fix.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` ok (0 errors, 866 warnings).  `npx tsc --noEmit` ok.  `npm test` was 9278 passed, 51 skipped, 25 failed.  `npm run build` ok.  The failures are outside this diff: the sandbox has provider keys configured, so suites that expect no OpenRouter or Anthropic key fail, along with the local data-catalog database and `scripts/ops/summarize-cpuprofile.mjs`.  The first full run also failed four vector tests (table windowing and NaN batch counts).  Those are fixed.  A second full run no longer fails `test/vector-db-chunk-cap.test.ts`, `test/vector-db-embedding-integrity.test.ts`, or `test/embed-request-pack.test.ts`.

Targeted before the gate:

```bash
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/rag-multi-query-retrieval.test.ts test/embed-resilience.test.ts test/usage-compliance-classifier.test.ts
```

50 passed.

Follow-up after review (stale-success epoch, multi-text context-length split, empty-string and non-string estimates):

```bash
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/vector-db-chunk-cap.test.ts test/vector-db-embedding-integrity.test.ts
```

The first run failed the singleton shrink assertion because the default 2400 character cap already sat under the half-budget byte cap, so the retry text was the same length.  The test now uses an `is_table` string between the half-budget and full byte caps.  Re-run of the packer and pressure files: 18 passed.  The chunk-cap and integrity files passed in the same first run (the singleton failure was the only failure).  Follow-up `npm run lint` ok (0 errors, 866 warnings).  Follow-up `npx tsc --noEmit` ok.  Follow-up `npm test` was 9282 passed, 51 skipped, 25 failed (the same sandbox-key and local-script failures; embed, retrieval-pressure, chunk-cap, and embedding-integrity are not in that list).  Follow-up `npm run build` ok.

### Merge main after #4663

`origin/main` at `82162336` merged cleanly.  No migration renumber.  The two open Sentry threads stay open: process-global backoff, and queue wait inside the outer strategy deadline.  Both match the tests and the comments in `retrieval-pressure.ts` and `embedAndMatchOneQuery`.

Verification on this head:

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/vector-db-chunk-cap.test.ts test/vector-db-embedding-integrity.test.ts test/trading-liveness.test.ts test/batched-halt-cause.test.ts test/rag-retrieval-deadline.test.ts test/rag-multi-query-retrieval.test.ts
npm test
```

`npm run lint` ok (0 errors, 866 warnings).  `npx tsc --noEmit` ok.  Targeted vitest 86 passed.  `npm test` was 9313 passed, 51 skipped, 3 failed (local catalog database, discord.com DNS, prune-vs-scan timing).  Those three are not in this diff.  Hosted `verify` on `cb81627e` succeeded before this merge was pushed.

`.github/workflows/autofix.yml` runs that fail with zero jobs also fail that way on `main` for `issue_comment` events.  They are not a required check.  Required checks are `verify` and `gitleaks`.

### Merge main at `3f4ef5e5` (2026-10-15, codex-autofix pass)

`origin/main` advanced to `3f4ef5e5` ("Approve succeeds only when the broker order is placed", ST-2582, #4698) while this PR sat open, and GitHub moved the PR from BLOCKED to `CONFLICTING`.  One content conflict, in `docs/phase-7-strategy.md`, where main added the 2026-10-15 approve entry directly above this PR's 2026-10-14 embed entry.  Resolved by keeping both, newest first.  `PLAN.md` and `STATUS.md` auto-merged and both PR entries survive in each.

No review-bot finding needed a code change on this pass.  All ten review threads on the PR were already resolved before this run, and every comment from the triggering `cursor[bot]` review was an explicit no-change disposition:

- Global backoff after one retrieval timeout, and slot-queue wait inside the outer strategy deadline — both are the SOCRATIC-TRADE-2G fix and the #2961 stall guard.  Jay's replies are the product decision.
- `embedBudgetUnits` memoization — Kody retracted its own suggestion after re-reading the head: `budgetUnitsByText` plus the `precomputedUnits` argument already remove the double walk.  The remaining reduce at `vector-db.ts:3391` is the provider meter over a different list, not a repeat.
- "Unhandled rejection" in the multi-text split — label was wrong.  The two awaits are sequential, so there is no orphaned promise, and returning the left half alone would desync piece indexes against `validateDocumentEmbeddingBatch`, which fails closed on cardinality.

Kody re-reviewed from scratch at 11:02Z and returned no new findings.

Verification on the merged head (`3f4ef5e5` + this branch):

```bash
npx tsc --noEmit
npm test
npm run build
```

`npx tsc --noEmit` ok.  `npm test` was 9395 passed, 51 skipped, 13 failed across `llm-provider`, `chat-llm`, `openrouter-credits`, and `framework-review`.  Those 13 reproduce identically on a clean `origin/main` worktree at `3f4ef5e5` (13 failed / 47 passed for the same four files), so they are the sandbox-credential class above, not this diff.  `npm run build` ok.

### 2026-10-15 CODEX landing pass after #4713

Checked PR #4662 head `148ce0875f1901a4eb142689fc08122110929e36` before editing.  Merged fresh `origin/main` at `8914af2621b790a3c657c746d991bddc057c435d` with a merge commit (`f433f89057262a1b28428d6d91f549b501371d2c`); no content conflicts.  The unique PR diff remains the 13 implementation, test, and rollout paths already listed above.

Verification on the merged head:

```bash
npm ci
npm run lint
npx tsc --noEmit
npx vitest run test/embed-request-pack.test.ts test/retrieval-pressure.test.ts test/vector-db-chunk-cap.test.ts
npm run build
```

`npm ci` completed.  Lint passed with 0 errors (866 existing warnings); TypeScript passed; focused Vitest passed (34 tests); production build passed with existing Next.js warnings.  The three requested empty-string cases and wrong-type rejection are present in `test/embed-request-pack.test.ts`.  No unresolved review threads remain.  Sentry SOCRATIC-TRADE-2G and SOCRATIC-TRADE-2E remain open pending live-open verification.

## Next Steps & Blockers

2026-10-15 shepherd: merged latest `origin/main` into this branch (phase-7 doc conflict kept both 2026-10-14 sections).  Sentry threads on global backoff and outer-deadline queue wait resolved with no code change per Jay.

After final-head CI is green, arm auto-merge and confirm the PR merges.  Keep Sentry 2G and 2E open until a live open confirms retrieval bursts and the context-length 400 are gone.

Fleet board claim could not be filed from this seat.  `board whoami` and a Linear write were not run: this cloud VM has no fleet client credentials (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, or a seat `ZULIP_*`), and `scripts/install-fleet-coordination.sh` does not invent them.  The claim that would have been filed is Linear team ST, title "Fit embed input to the bge-m3 token budget and back off retrieval bursts", state In Progress, and Completed only after merge to `main`.  No Linear issue id was minted here.  `docs/EFFORT-LOG.md` is archived and was not edited.

Kody threads that this follow-up fixes (stale success clearing backoff, multi-text context-length resend, empty-string and non-string estimates, and the board-claim citation) can be resolved after the replies land.  The recomputing `embedBudgetUnits` on the ingest slice thread is fixed by the Codex autofix pass above and resolved with it.  Threads left open on purpose: process-global backoff dropping later symbols in the same wave, queue wait counting toward the outer strategy deadline, taking a retrieval slot before the embed-circuit check (an ordering change that would disable the SiliconFlow rescue and the cached-embedding path), and the scope mismatch against GitHub #4660 / PRs #4658 and #4659.  Those last items are not this PR.

## Zero-Code Findings

Latest 2G event on 2026-10-14 was `strategy RAG retrieval timed out` for BUD on qdrant, not an embed 400.  Latest 1X was an embed provider timeout.  The context-length 400 is the packer path that still posted an over-budget string.  Raising the deadline or the daily text cap would not fit that string into 8192.
