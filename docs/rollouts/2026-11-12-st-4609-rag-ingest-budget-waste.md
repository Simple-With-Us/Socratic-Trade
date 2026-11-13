# 2026-11-12 — ST-4609 RAG ingest daily cap waste

## Context & Objective

SOCRATIC-TRADE-2E ("RAG ingest text budget reached") fires because the operator ingest ledger is full and new SEC chunks are skipped.  The 2026-11-11 event `cc88b0c453294a3cbf21177bbecd542c` (release `d85f2224`, host `fleet-hetzner-nbg1`) reported `usedLast24h` 19981, `limitPer24h` 20000, `requested` 797, `allowed` 19, `skipped` 778, `skippedOccurrences` 784, provider `openrouter`, source `operator`.  The cap must not be raised.  This change stops spend that does not produce a retrievable vector.

## Changes Made

The ingest cap now counts embed windows that still need a provider call for document ingest.  Retrieval query embeds and search-fusion embeds stay in the cost ledger and do not spend the cap.  Legacy `rag_usage` rows with a NULL flag still count, so the rolling window does not get a holiday.  Before the slice, every `storeContexts` path drops texts already in the document cache, the content cache, or the embed stage, and a repeated string in the same batch is one window.  A managed commit whose fresh texts do not fit is not sent to the provider.  The slots stay for a document that can commit.  Dedup hashes are recorded for chunks that were indexed even when a sibling embedding was rejected.  The audit and Sentry payload keep `requested` as the window sum and add `requestedTexts` plus `unit: "embed windows"`.

Files:

- `src/lib/rag/ingest-budget.ts` — pure keep/charge decision.
- `src/lib/rag-metering.ts` — `countsTowardIngest` on embed rows and `usedIngestEmbedWindowsLast24h`.
- `src/lib/db.ts` — nullable `rag_usage.counts_toward_ingest`.
- `src/lib/vector-db.ts` — pre-budget reuse, managed withhold, window labels, retrieval meter flag, dedup recording.
- `src/lib/rag/search-fusion.ts` — search-fusion embeds do not spend the ingest cap.
- `test/rag-ingest-budget-accounting.test.ts` — reuse, units, repeated tick, retrieval exclusion.
- `test/rag-ingest-budget-sentry-rollup.test.ts`, `test/rag-ingest-budget-sentry-cooldown.test.ts`, `test/vector-db-lease-fencing.test.ts` — budget fixtures use two distinct texts, because identical copies are one window.
- `test/vector-db-document-receipts.test.ts` — a managed prefix is not embedded; the retry commits the full document.
- `test/embed-request-pack.test.ts` — the 32-count fixture uses distinct texts so packing still splits after identical strings became one window.
- `STATUS.md`, `PLAN.md`, this note.

## Decisions & Trade-offs

The cap default stays `DEFAULT_INGEST_MAX_TEXTS_PER_DAY` 20,000.  Embedding provider, model, and dimensions are unchanged.  A short text still costs one window.  Charging one unit per packed POST would multiply effective capacity and was rejected.

The cap is also too small for the paid ingest cadence, and that is stated here without changing it.  `DEFAULT_PAID_MAX_FILINGS_PER_RUN` is 200.  Child chunks are about `maxTokens / 3`.  The live event was one filing of 797 windows against 19 slots left in a 19,981 / 20,000 ledger.  A backlog drains across days.  Query volume under user `local` is far below 20,000, so excluding retrieval embeds does not by itself empty that ledger.  It stops retrieval from sharing the ingest counter.

Sources still share one ledger.  There is no per-source quota.  The managed withhold stops one oversized filing from burning the last slots on a commit that cannot succeed.

The SEC worker stores filings at `maxTokens` 400 and overlap 0.15.  The scheduled filings path uses the default 480 and overlap 0.12.  Those boundaries can miss stage reuse between the two producers.  Chunk size was left unchanged because it changes retrieval, not the accounting bug.

## Verification State

Commands (Node on this seat is v22.23.4; CI and `.nvmrc` are Node 26):

```bash
npx tsc --noEmit
npm run lint
node_modules/.bin/vitest run test/rag-ingest-budget-accounting.test.ts test/rag-ingest-budget-sentry-rollup.test.ts test/rag-ingest-budget-sentry-cooldown.test.ts test/embed-stage.test.ts test/vector-db-document-receipts.test.ts test/vector-db-lease-fencing.test.ts test/corpus-reembed.test.ts test/system-symbol-rag-alias.test.ts test/embed-request-pack.test.ts
npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

`npx tsc --noEmit` passed.  `npm run lint` passed with 0 errors (existing warnings only).  The focused vitest files above passed, including the new accounting tests, the rollup tests, the receipt withhold test, corpus-reembed budget resume, and embed-request-pack (13 tests) after the distinct-text fixture.  Full `npm test` was 19 failed, 10234 passed, 41 skipped.  One failure was this change: 32 identical texts collapsed to one POST.  That fixture now appends the index, and the file passes.  Seventeen failures are this seat's injected provider credentials.  Those files pass when names containing KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, or DSN are removed from the environment (375 passed, 1 still failed).  `test/automerge-reusable-pin.test.ts` failed on `gh` HTTP 401.  `test/server-metrics.test.ts` expects `usesLocalHost` true, and this VM reports false.  The first `npm run build` aborted at the default V8 heap (~2 GB).  The retry with `NODE_OPTIONS=--max-old-space-size=4096` finished exit 0, including the CSP hash stamp.

## Next Steps & Blockers

Open the PR against `main`.  Wait for the required `verify` check.  Do not merge, do not enable auto-merge, and do not raise `RAG_INGEST_MAX_TEXTS_PER_DAY`.  If Kody has not started a review, comment `@kody start-review` once.

## Zero-Code Findings

The 97 percent skip on that event is one 797-window batch hitting a ledger 19 slots from the ceiling.  The code waste is separate from the cap being tight.  Prior work (2026-09-08) raised the Sentry cooldown and did not change the cap.  This note does not replace that rollout.
