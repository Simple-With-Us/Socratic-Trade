# 2026-09-07 - sec-ingest-error-classification

## Summary

Fixes three error-handling defects in the RAG/SEC ingest path, all filed 2026-08-23 by a
full-stack review pass and still unfixed at HEAD (`14eabced9`), plus a related Sentry
observability gap surfaced by production evidence while this work was in flight.

1. **P0 — SEC ingest dead-letters misclassify errors** (`src/lib/rag/sec-ingest-worker.ts:407-448`).
   Any non-complete `storeDocument` result that was not a recognized budget/quota condition was
   thrown as a generic `"Ingestion budget or capacity exceeded mid-task"` message. The
   `runTick` catch then dead-lettered it with `retryable: true` unconditionally, and the
   worker's own startup cleanup (`requeueSecIngestDeadLetters` in `start()`) revives any
   dead-lettered task whose `last_error` matches that literal string — so a genuinely
   permanent embed rejection (HTTP 400) was requeued and re-failed forever, filling the
   dead-letter queue with unrecoverable work while masking the real cause as a budget problem.

2. **P1 — query-embed failures return null and retrieval silently continues**
   (`src/lib/rag/search-fusion.ts` — `retrieveFusedContext`). `retrieveContextDetailed` already
   has a typed `RetrievalStatus`/`onStatus` receipt for `lookup_failed`/`budget_skipped`, but
   `retrieveFusedContext`'s hybrid dense+lexical fusion never wired it up: a query-embed
   400/429/connection failure came back as an empty `vectorResults` array indistinguishable
   from "no semantic match," and a thrown failure was swallowed by a bare
   `console.warn(...)`. The fused result silently proceeded lexical-only with no signal
   anywhere.

3. **P1 — incremental SEC refresh counts a skip as success even when an error is set**
   (`src/lib/web-sources/sec-filings.ts` — `refreshFilingBodiesUnlocked`). `ingestFiling` can
   return `{ skipped: true, error: "..." }` (e.g. `document-commit-proof-missing`/`-lost`) — a
   genuine failure that also happened to stop short of a full ingest. The aggregation checked
   `ingestResult.skipped` BEFORE `ingestResult.error`, so this case took the "skipped" branch
   and the error was never pushed into `result.errors`. The refresh reported success (an empty
   `errors` array) while a filing had actually failed, so monitoring never fired.

**Related observability gap** (found via production Sentry evidence gathered mid-fix,
`SOCRATIC-TRADE-27` / `SOCRATIC-TRADE-1X`): the "RAG ingest text budget reached" Sentry warning
(`src/lib/vector-db.ts`, inside `storeContextsImpl`) had no rate limiting, unlike its sibling
`alertRagConnectionFailure`. It fired 8,036 times in 2 days (roughly every 10-20s, matching the
SEC ingest worker's 5s tick × up to 5 tasks/tick against one persistent condition) while the real
underlying failure ("OpenRouter embed connection failed") surfaced only 5 times — burying the
real signal. Also, a genuine unclassified embed/connection failure was always logged at
`warning` level even when it was not a known rate-limit/billing/quota condition.

**Codex round-1 review (post-merge-gate, fixed in this same PR before merge):**

4. **P2 — 408 misclassified as permanent** (`src/lib/vector-db.ts` — `classifyEmbedFailure`).
   The blanket `/\b4\d\d\b/` permanent match caught HTTP 408 (Request Timeout) too. A 408 means
   the provider never actually evaluated the request, so unlike a genuine 400 it is not
   "byte-identical content that can never succeed" — it is transient and worth a bounded retry.
   429 and 408 now both classify as transient explicitly, before the generic 4xx-is-permanent
   fallback.

5. **P1 — production retrieval paths never received the degradation signal**
   (`src/lib/rag/search-fusion.ts` / `src/lib/vector-db.ts`). `retrieveFusedContext` has zero
   non-test production callers — `test/rag-production-path-contract.test.ts` ("audit R1") pins
   strategy and chat orchestrator to `retrieveContextDetailed` and explicitly forbids
   `retrieveFusedContext` in those paths by design. So the defect-2 fix above never actually
   reached chat, strategy, proposer-dossier, experience-memory, or lookahead-audit — every real
   production caller of RAG retrieval. `reportRetrievalStatus` (`vector-db.ts`) now emits the
   `rag.dense_recall_degraded` log + `embed.failed` metric itself on `lookup_failed`,
   unconditionally, so every caller of the shared `retrieveContextDetailed` path gets the signal
   regardless of whether it supplies its own `onStatus`. `budget_skipped` is deliberately excluded
   (see #6).

6. **P2 — `budget_skipped` counted as an embed failure** (`src/lib/rag/search-fusion.ts`). The
   `retrieveFusedContext` wrapper treated `lookup_failed` and `budget_skipped` identically,
   feeding both into the same error-level Sentry log + `embed.failed` metric bump. A deliberate,
   expected budget skip is not a provider/lookup failure — a persistently exhausted daily budget
   would otherwise flood Sentry and falsely inflate the provider-failure metric on every fused
   retrieval. `budget_skipped` still marks the result degraded via `wasDenseRecallDegraded()`
   (dense recall genuinely did not run) but no longer triggers the Sentry/metric emission; the
   same split applies to the new central emission in `vector-db.ts` (#5 only fires on
   `lookup_failed`, never `budget_skipped`).

7. **P2 — cooldown persistence failure could reject an ingest** (`src/lib/vector-db.ts` —
   `shouldEmitRagIngestBudgetSentry`). `getInternalSetting`/`setInternalSetting` are synchronous
   SQLite calls that can throw (e.g. `SQLITE_BUSY` under contention). This helper is called from
   inside `storeContextsImpl`'s budget-exceeded branch, before that function's own error handling
   — an uncaught throw here would escape all the way out of `storeContexts`, turning an expected,
   otherwise-successful budget-skip into a rejected store operation. Now fail-soft: any
   getInternalSetting/setInternalSetting failure logs a warning and falls back to emitting
   (fail-open) rather than throwing.

## Why

Guiding principle: classify errors by what they actually are, and fail loudly rather than
silently degrading. A 400 is permanent (the provider rejected the request itself; retrying the
identical request can never succeed) — dead-letter it immediately with its real reason. A 429
or connection failure is transient — back off and retry with the existing bounded
stage-attempts budget. Never let "budget exceeded" absorb unrelated failures.

For defect 2, deliberately chose **proceed degraded** over hard-failing the whole hybrid query:
`retrieveFusedContext` backs chat/dossier/proposer answer quality broadly, and a hard failure on
every transient embed hiccup would take down more than it protects. Instead the result is
marked degraded (`wasDenseRecallDegraded()`) and a structured `logError` + `recordEmbedFailure`
signal fires — visible, not silent.

## Files

- `src/lib/rag/sec-ingest-worker.ts` — real classify-and-fail instead of the generic budget throw.
- `src/lib/vector-db.ts` — `classifyEmbedFailure` classifier (429 and 408 transient, other 4xx
  permanent); threads the real embed failure message from `embedDocumentsLaneOrSkip` →
  `embedPackedInputGroups` → `storeContextsImpl` (`embedFailureMessage` field, kept separate from
  `error` which existing callers treat as "the whole call threw"); `alertRagConnectionFailure` now
  logs at `error` level for a genuinely unclassified failure instead of always `warning`;
  cooldown-gated the "RAG ingest text budget reached" Sentry capture and gave it its own
  fingerprint lane (`rag-ingest-budget`), now fail-soft against a cooldown-persistence throw;
  `reportRetrievalStatus` centrally emits `rag.dense_recall_degraded` + `embed.failed` on
  `lookup_failed` (never `budget_skipped`) so every production caller of `retrieveContextDetailed`
  gets the signal, not just `retrieveFusedContext` callers.
- `src/lib/rag/search-fusion.ts` — `retrieveFusedContext` tracks dense-recall degradation via
  `retrieveContextDetailed`'s `onStatus` callback and thrown errors; `wasDenseRecallDegraded()`
  exported for callers that want to check; structured `rag.dense_recall_degraded` log + metric,
  now reported only for genuine failures (`lookup_failed`, `threw`) and not for the deliberate
  `budget_skipped` case.
- `src/lib/web-sources/sec-filings.ts` — `refreshFilingBodiesUnlocked` checks `ingestResult.error`
  before `ingestResult.skipped`.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `PLAN.md`, this rollout note — mandatory handoff records.
- Tests: `test/sec-ingest-worker.test.ts`, `test/pinecone-metadata-and-rag-limits.test.ts`,
  `test/search-fusion.test.ts`, `test/sec-filings.test.ts`, `test/rag-retrieval-status.test.ts`,
  `test/rag-ingest-budget-sentry-cooldown.test.ts` (new).

## Verification

- `npx tsc --noEmit` — clean on every file this PR touches (`app/console/components/nav.tsx` has
  3 pre-existing implicit-`any` errors unrelated to this change and present on `origin/main`
  before this branch; not introduced here).
- `npm run lint` — 0 errors (warnings only, `warn`-only per `eslint.config.mjs`).
- `npm test` (vitest), targeted — `test/sec-ingest-worker.test.ts`, `test/sec-filings.test.ts`,
  `test/pinecone-metadata-and-rag-limits.test.ts`, `test/search-fusion.test.ts`,
  `test/rag-retrieval-status.test.ts`, `test/rag-ingest-budget-sentry-cooldown.test.ts`,
  `test/vector-db-lease-fencing.test.ts` — 128 tests, all green. A whole-repo `npm test` run was
  started locally but did not finish within this session (large suite; no failures observed in
  the output produced before it was stopped) — the `verify` CI check is the authoritative
  full-suite gate and runs automatically on push.
- `npm run build` — production build clean (after fixing a stale `node_modules` in this worktree
  with `npm install`; unrelated to this PR's code).

## Follow-ups

- Historical dead-lettered tasks whose `last_error` still matches the old generic budget message
  will be requeued once more by the existing startup cleanup and re-classified correctly on
  their next failure (one-time correction, not a new loop).

## Blockers

- None.
