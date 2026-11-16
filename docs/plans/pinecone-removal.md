# Pinecone surface removal (ST-4598)

## Context and objective

Owner intent from 2026-10-14 stands: retrieval and ingest use Qdrant, and embeddings use OpenRouter.  Closed draft #5093 (`grok-web/remove-pinecone-voyage`, cut 2026-10-14) could delete `src/lib/rag/pinecone-write-class.ts` because that branch had no importers.  On `main` as of 2026-11-12 the file is load-bearing.  This note is the inventory and the order for the later slices.  It does not flip `RAG_PINECONE_WRITE_CLASS`, uninstall the SDK, or delete a live read.

Qdrant is already the default write backend when `QDRANT_URL` is usable (`vectorWriteBackend` in `src/lib/vector-store/qdrant-write.ts`), and the default read backend when an embed-space filter is present (`vectorReadBackend` in `src/lib/vector-store/qdrant-read.ts`).  Pinecone remains a reachable fallback.  Production's active embed model is `baai/bge-m3` unless a test pins Voyage, so the filter is present and reads follow the knob.  The knob still returns `pinecone` when `RAG_VECTOR_READ_QDRANT` is off, when `RAG_VECTOR_READ_BACKEND=pinecone`, or when `QDRANT_URL` is missing.  `retrieveContextDetailed` also forces Pinecone when `embedSpaceFilterForModel` is empty, which is the `voyage-finance-2` case.

## Slice 0 (this change)

Three exports in `src/lib/rag/pinecone-write-class.ts` had zero references in `src/`, `app/`, `scripts/`, and `test/` before this change.  They are removed.  Nothing else in the Pinecone surface is removed.

| Symbol | Why it can go | Replacement |
|---|---|---|
| `writesProcessedToPinecone` | No callers. The body is true for every `PineconeWriteClass` (`full-body`, `highlight+signal`, `highlight-only`), so it never changed a write. | None. Producers keep using `writesFullBodyToPinecone` and `pineconeWriteClass`. |
| `isTranscriptRoleCode` | No callers. `selectSignalChunks` already matches `management`, `qa`, and `analyst` inline. | None. |
| `filingTextFromParsedSections` | No callers. The 2026-08-18 review named an older call site that is no longer in `sec-filings.ts`. | None. |

`test/pinecone-write-class.test.ts` asserts those three names are not exported.  The live helpers in the same file stay, and their existing tests stay.

## Live read path (do not delete yet)

`retrieveContextDetailed` in `src/lib/vector-db.ts` chooses the read backend, then `denseTierQuery` calls `index.query` when the backend is `pinecone`.  That call is wrapped in `withRagApiHealth("pinecone", ...)` and `withSentrySpan("pinecone.query", ...)`.  Qdrant reads go through `qdrantQueryTier` in `src/lib/vector-store/qdrant-read.ts` and never enter that span.  Deleting `index.query` before the empty-filter branch and the pinecone knob are gone would drop retrieval wherever Qdrant is not selected.

| Piece | File | Role | Replacement, later |
|---|---|---|---|
| `embedSpaceFilterForModel` | `src/lib/vector-db.ts` | Empty object for `voyage-finance-2` forces the Pinecone read. Non-empty filter (including `baai/bge-m3`) delegates to `vectorReadBackend`. | Keep until Voyage cannot be the active model outside tests, then stop forcing Pinecone on an empty filter. |
| `vectorReadBackend` | `src/lib/vector-store/qdrant-read.ts` | Knob `RAG_VECTOR_READ_QDRANT`, then `RAG_VECTOR_READ_BACKEND`, default Qdrant. Missing `QDRANT_URL` stays on Pinecone. | Fail closed on Qdrant once production has no Pinecone read. |
| `qdrantQueryTier` | `src/lib/vector-store/qdrant-read.ts` | Live dense query. | Stays. This is the replacement. |
| `pineconeNamespaceToQdrantTenant` | `src/lib/vector-store/qdrant-read.ts` | Maps the copied namespace onto payload `ns`. | Stays until point ids no longer carry the Pinecone id. |
| `pineconeFilterToQdrant`, `qdrantTenantFilter`, `ABSENT_FIELD_SENTINELS` | `src/lib/vector-store/pinecone-filter-to-qdrant.ts` | Live filter translation for Qdrant search, scroll, and delete. | Rename only after filters are authored as Qdrant filters. Do not delete with the SDK. |
| `index.query` | `src/lib/vector-db.ts` (`denseTierQuery`) | Live Pinecone read. | Delete in slice 1, after the branch cannot return `pinecone`. |
| `meterPineconeQuery` | `src/lib/rag-metering.ts` | Books read units on the Pinecone query path. | Delete with `index.query`. |
| `GET /api/health` | `app/api/health/route.ts` | `checks.pineconeConfigured` is telemetry. `pinecone` is a critical liveness service only when `vectorReadBackend() !== "qdrant"`. | Stop adding `pinecone` to `criticalServices` in slice 1. Leave the field until dashboards stop reading it. |

## Live write path and write-class (do not delete yet)

Default writes are Qdrant.  `vectorWriteBackend` throws if Qdrant is selected but not usable, so a missing `QDRANT_URL` does not silently resume Pinecone upserts.  An explicit `RAG_VECTOR_WRITE_QDRANT=off` or `RAG_VECTOR_WRITE_BACKEND=pinecone` still reaches `index.upsert`, `deleteMany`, `fetch`, `listPaginated`, `describeIndex`, and `describeIndexStats` in `src/lib/vector-db.ts`.  Those calls are the rollback switch.  They are not dead.

### `src/lib/rag/pinecone-write-class.ts` (module stays)

This module does not construct a Pinecone client.  It decides which filing and transcript slices are stored, and it builds accession keys the local ledger and FTS path still use.  The 2026-08-18 store-vs-condense audit and the 2026-08-22 panel-corpus audit call the hydrate work PR B.  That work is not done.  `RAG_PINECONE_WRITE_CLASS` still defaults to `full-body`.

| Export | Callers | Disposition |
|---|---|---|
| `pineconeWriteClass` | `persist-local-complete.ts`, `sec-filings.ts`, `roic-transcripts.ts` | Stays until slice 3 renames it. Still read by producers. |
| `writesFullBodyToPinecone` | `sec-filings.ts` (skips extra signal-section upserts while the class is `full-body`), `earningscalls-transcripts.ts` | Stays. Slice 3 replaces the SEC decision with a backend-neutral flag after hydrate exists. |
| `normalizeFormHint` | `selectSignalChunks` in the same file | Stays. |
| `parseItemCodeFromSection` | `document-summarizer.ts`, `hydrate-accession.ts`, `operational-index-prune.ts`, `proposer-dossier.ts`, `sec-filings.ts` | Stays. Not a Pinecone API. |
| `itemCodeOfChunk` | `operational-index-prune.ts`, `selectSignalChunks` | Stays. |
| `bareSecAccession` | `vector-db.ts`, `sec8k.ts`, `operational-index-prune.ts`, `persist-local-complete.ts`, `proposer-dossier.ts`, `hydrate-accession.ts` | Stays. |
| `sectionDocumentKey` | `processed-corpus-write.ts` | Stays. |
| `isDoNotTouchDocType`, `isProcessedDocType` | `operational-index-prune.ts` | Stays. Prune must not touch lessons, coach notes, or experience memory. |
| `selectSignalChunks` | `processed-corpus-write.ts`, `earningscalls-transcripts.ts` | Stays. |
| `groupChunksByItemCode` | `processed-corpus-write.ts` | Stays. |
| `PINECONE_SIGNAL_ITEM_CODES`, `PROCESSED_DOC_TYPES`, `DO_NOT_TOUCH_DOC_TYPES`, `SIGNAL_MAX_CHUNKS`, `SIGNAL_MAX_SOURCE_CHARS`, `TRANSCRIPT_QA_SIGNAL_TURNS`, `SignalChunkLike`, `PineconeWriteClass` | Used inside this module or by `persist-local-complete.ts` | Stay with the module. |

### Write-class callers that are not the Pinecone SDK

| File | What it uses | Why it stays |
|---|---|---|
| `src/lib/web-sources/sec-filings.ts` | `writesFullBodyToPinecone`, `pineconeWriteClass`, `parseItemCodeFromSection` | Live SEC ingest. The `full-body` branch is the current production default. |
| `src/lib/earningscalls-transcripts.ts` | `writesFullBodyToPinecone`, `selectSignalChunks` | Live transcript ingest. |
| `src/lib/web-sources/roic-transcripts.ts` | `pineconeWriteClass`, local type `RoicPineconeWriteClass`, `roicPineconeWriteClass` | Live ROIC writer. The local type is the transcript write-class, not a client. |
| `src/lib/web-sources/sec8k.ts` | `bareSecAccession` | Live 8-K body path. |
| `src/lib/rag/persist-local-complete.ts` | `pineconeWriteClass`, `bareSecAccession` | Local-complete FTS mirror. Runs beside the vector write. |
| `src/lib/rag/processed-corpus-write.ts` | `sectionDocumentKey`, `selectSignalChunks`, `groupChunksByItemCode` | Signal-section documents. Used when the class is not `full-body`. |
| `src/lib/rag/document-summarizer.ts` | `parseItemCodeFromSection` | Summary sections. |
| `src/lib/rag/hydrate-accession.ts` | `bareSecAccession`, `parseItemCodeFromSection` | Hydrate helper the audits still require before a class flip. |
| `src/lib/rag/operational-index-prune.ts` | `itemCodeOfChunk`, `bareSecAccession`, `isDoNotTouchDocType`, `isProcessedDocType`, `parseItemCodeFromSection` | Prune classification. |
| `src/lib/rag/proposer-dossier.ts` | `bareSecAccession`, `parseItemCodeFromSection` | Dossier coverage. Does not flip the env. |
| `src/lib/db-learning.ts` `insertIngestedAccession` | columns `pinecone_write_class`, `pinecone_vector_count` | Persisted ledger. |
| `src/lib/db.ts` migration `ingested_accessions_pinecone_write_class` | `ALTER TABLE` for those two columns | Schema. Do not drop. A later rename needs a compatibility read. |

### Pinecone client, budgets, and breakers (reachable on the pinecone write backend)

| File | Exports that production or admin still call | Replacement |
|---|---|---|
| `src/lib/vector-db.ts` | `new Pinecone`, `getClients`, `index.upsert`, `index.deleteMany`, `index.fetch`, `index.listPaginated`, `describeIndex`, `describeIndexStats`, `hasPineconeWriteBudget`, `enforcePineconeMetadataLimit`, `applyPineconeWriteBudget`, `estimatePineconeRecordWriteUnits`, `estimatePineconeWriteUnitsForDocument` | Qdrant functions in `qdrant-write.ts` already handle the default. Delete the Pinecone branches in slice 2, after the write knob cannot select Pinecone. |
| `src/lib/pinecone-wu-breaker.ts` | `pineconeWuExhaustedUntil` (`scheduler.ts`, `sec-ingest-worker.ts`, `sec-filings.ts`, `ops-snapshot.ts`, `connections-health`), `tripPineconeWuBreaker`, `notePineconeWriteSuccess`, `isPineconeWuExhaustedError`, `auditPineconeWuGateSkip` | Delete with the Pinecone upsert path. The breaker only parks Pinecone writes. |
| `src/lib/pinecone-monthly-pace.ts` | `recordPineconeWriteUnits` via `meterPineconeUpsert`, `pineconeMonthToDateWriteUnits`, `pineconeWuPaceState`, `pineconeBackfillPaceGate` (`sec-ingest-worker.ts`) | Delete with metering of provider `"pinecone"`. Qdrant upserts use `meterQdrantUpsert` and do not need this counter. |
| `src/lib/pinecone-trial-window.ts` | `pineconeTrialState` (admin RAG coverage, ops snapshot), `maybeAdvisePineconeTrialRollback` (scheduler), `isPineconeTrialActive` | The calendar default `2026-08-27T00:00:00.000Z` is in the past. The functions still run. Delete in slice 2 with the breaker, not before, because `PINECONE_TRIAL_ENDS_AT` can still change the advice. |
| `src/lib/pinecone-write-budget.ts` | `selectItemsWithinWriteBudget` from `vector-db.ts` | Delete with the daily WU fuse. The fuse applies only when the write backend is Pinecone. |
| `src/lib/rag-metering.ts` | `meterPineconeQuery`, `meterPineconeUpsert`, provider `"pinecone"` on `RagUsageEntry` | Keep until slice 2. Historical `rag_usage` rows with that provider stay readable. |
| `src/lib/server-knobs.ts` | knob `RAG_PINECONE_WRITE_BUDGET_ENABLED` | Remove from the catalog in slice 2, with the fuse. |
| `src/lib/network-errors.ts` | `isPineconeHttpResponseError` and the Pinecone SDK error-name matcher | Keep until slice 2 so a Pinecone 429 on the fallback path still classifies. |
| `src/lib/audit-prune.ts` | comment only, pointing at staged-embed delete after a successful delivery | No code change until the comment is wrong. |

Internal setting keys that slice 2 may stop writing, and must not delete from existing databases in slice 0: `pinecone:wuExhaustedUntil`, `pinecone:wuGateLastAuditDay`, `pinecone:monthWriteUnits`, `pinecone:monthWuPaceAdvisedMonth`, `pinecone:trialRolledBackAt`, `pinecone:wuBudgetSentryAt`.

## Admin routes (reachable, not dead)

These routes are admin-gated and still mounted.  They are not Pinecone-only dead ends.  Re-embed and 8-K reindex call the shared vector store, which writes Qdrant by default.  The Pinecone words in their comments and in the coverage UI describe the old quota.  Retitle them in slice 4.  Do not unmount them here.

| Route | File | What it does today |
|---|---|---|
| `GET /api/health` | `app/api/health/route.ts` | Reports `pineconeConfigured`, `ragVectorReadBackend`, `ragVectorWriteBackend`. Critical `pinecone` only when reads are not on Qdrant. |
| `GET /api/admin/connections-health` | `app/api/admin/connections-health/route.ts` | Service row `pinecone`. Softens the lane while `pineconeWuExhaustedUntil()` is set. UI: `app/admin/connections/connections-health-client.tsx`. |
| `GET /api/admin/rag-coverage` | `app/api/admin/rag-coverage/route.ts` | Returns `providerUsage.pinecone`, `monthlyWriteUnitPace`, `trialWindow`. UI: `app/admin/rag-coverage/rag-coverage-client.tsx` still labels the vector count as the Pinecone index. |
| `GET` and `POST /api/admin/reembed` | `app/api/admin/reembed/route.ts` | Corpus re-embed through `storeDocument` / `storeContexts`. Comment mentions Pinecone spend. The run follows the write backend. |
| `GET` and `POST /api/admin/reindex-8k` | `app/api/admin/reindex-8k/route.ts` | Re-embeds the stored 8-K dataset through `reindexEightKDataset` and `getVectorStoreStats`. |
| `GET /api/ops/snapshot` | `src/lib/ops-snapshot.ts` | Field `pineconeIngest` (month-to-date units, trial state, breaker). |

## Keys and environment

Do not delete Infisical values in a code change, and do not print them.  Slice 6 is an owner delete of the named keys after no resolver reads them.  `src/lib/db-api-keys.ts` still maps service `pinecone` to env `PINECONE_API_KEY`, class `shared-operator-infra`.  `getClients` and `/api/health` still resolve that service.  Removing the row first would make a Pinecone fallback look like a missing key with no operator-visible service.

| Name | Read by | When it can go |
|---|---|---|
| `PINECONE_API_KEY` | `db-api-keys.ts`, `getClients`, eval scripts, `scripts/qdrant/pinecone-to-qdrant-copy.py` | Slice 6, after slices 1, 2, and 5. |
| `PINECONE_INDEX_NAME` | `indexName()` in `vector-db.ts` | Slice 2. |
| `PINECONE_INDEX_READY_WAIT_MS` | `indexReadyWaitMs()` in `vector-db.ts` | Slice 2. |
| `PINECONE_MONTHLY_WU_BUDGET` | `pinecone-monthly-pace.ts`, `pinecone-trial-window.ts` | Slice 2. Default 0 already disables the throttle. |
| `PINECONE_TRIAL_ENDS_AT` | `pinecone-trial-window.ts` | Slice 2. `off` / `0` / `never` disables the window. |
| `PINECONE_TRIAL_CREDIT_USD` | `pinecone-trial-window.ts` | Slice 2. |
| `PINECONE_WU_USD_PER_MILLION` | `pinecone-trial-window.ts` | Slice 2. |
| `PINECONE_TRIAL_RESERVE_USD` | `pinecone-trial-window.ts` | Slice 2. |
| `PINECONE_ASSISTANT_NAME` | `scripts/eval/rag-shadow-benchmarks.ts` | Slice 5. |
| `RAG_PINECONE_WRITE_CLASS` | `pineconeWriteClass` | Slice 3, only after the hydrate replacement is the default. Do not flip it in an earlier slice. |
| `RAG_PINECONE_WRITE_BUDGET_ENABLED` | server knob and `pineconeWriteBudgetEnabled` | Slice 2. |
| `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` | daily fuse and the trial window | Slice 2. |
| `RAG_VECTOR_READ_QDRANT` | `vectorReadBackend` | Keep. This is the read replacement switch. |
| `RAG_VECTOR_READ_BACKEND` | `vectorReadBackend` (`qdrant` or `pinecone`) | Keep through slice 1. It is the read rollback. |
| `RAG_VECTOR_WRITE_QDRANT` | `vectorWriteBackend` | Keep. This is the write replacement switch. |
| `RAG_VECTOR_WRITE_BACKEND` | `vectorWriteBackend` | Keep through slice 2. It is the write rollback. |

`.env.example` does not list these names.  Infisical is the source.  This inventory is the name list only.

## Package and bundler

| Piece | File | Disposition |
|---|---|---|
| `@pinecone-database/pinecone` `^9.0.0` | `package.json`, `package-lock.json` | Uninstall in slice 5, after no import remains. `vector-db.ts` and `scripts/eval/rag-shadow-benchmarks.ts` still import it. |
| `serverExternalPackages` and client `false` alias | `next.config.mjs` | Drop the package name in the same slice as the uninstall, so the client bundle does not start resolving it. |
| `npm run eval:pinecone-inference` | `package.json` | Remove in slice 5 with the script. |

## Evals and ops scripts

These are operator entry points with tests or a package script.  They are not request-path dead code.  Slice 5 removes the Pinecone-only ones.  The production-path evals stay and should call `retrieveContextDetailed` on Qdrant.

| Script | Pinecone behavior | Tests | Disposition |
|---|---|---|---|
| `scripts/eval/pinecone-inference-benchmark.ts` | Hosted `/embed`, `/rerank`, `/models` at `api.pinecone.io`. Refuses the network without `--allow-live`. | `test/pinecone-inference-benchmark.test.ts` | Slice 5. OpenRouter already embeds. Do not replace this with a new Pinecone call. |
| `scripts/eval/rag-shadow-benchmarks.ts` | `runPineconeAssistantShadow` uses `Pinecone.assistant` when `PINECONE_ASSISTANT_NAME` and `PINECONE_API_KEY` are set. Read-only. | `test/rag-shadow-benchmarks.test.ts` | Slice 5. The shadow target is not the production retriever. |
| `scripts/eval/rag-census.ts` | Prints the WU budget env and live stats from the vector store. | none dedicated | Slice 4. Point the stats label at the active backend. |
| `scripts/eval/corpus-coverage.ts` | Optional `describeIndexStats` when a Pinecone key resolves. SQLite coverage does not need it. | none dedicated | Slice 4. Drop the live Pinecone cross-check. |
| `scripts/eval/rag-production-eval.ts` | Receipt fields `pineconeIndexName`, `pineconeCredentialSource`, `pineconeProviderAuthority` from `resolvedRagRuntimeConfiguration`. | `test/rag-production-eval.test.ts` | Slice 4. Rename the receipt fields. Do not change the scored retrieval path in that slice. |
| `scripts/qdrant/pinecone-to-qdrant-copy.py` | One-shot read-only copy. Point ids are uuid5 of namespace plus Pinecone id. | none | Keep until a later operator says the copy will not be rerun. `qdrantPointId` in `qdrant-write.ts` must keep matching it. |
| `scripts/qdrant/sentinel-backfill.py` | Payload backfill for points the copy wrote. | none | Same as the copy script. |
| `scripts/backfill-asof-epoch.ts` | Patches `as_of` on existing Pinecone vectors. | none | Slice 2 or 5. The 2026-09-01 rollout said the copied corpus was already stamped. Do not run it against Pinecone as part of removal. |
| `scripts/prune-operational-index.ts` | Dry-run inventory comment still says Pinecone. The prune module is backend-agnostic classification plus the vector store. | via `operational-index-prune` callers | Slice 4 comment only, unless the script imports the client (it does not). |
| `scripts/migrate-market-keys-to-user.ts` | Comment lists Pinecone as an operational key that stays shared. | none | Slice 6, with the key row. |

## Tests that lock the live surface

Do not delete these in slice 0.  Each later slice deletes or rewrites only the tests for the branch it removes, and keeps a Qdrant test that covers the same behavior.

| Test | What it locks |
|---|---|
| `test/pinecone-write-class.test.ts` | Write class, signal chunks, section keys, and the absence of the three deleted helpers. |
| `test/pinecone-wu-breaker.test.ts` | Monthly exhaustion matcher and the park marker. |
| `test/pinecone-monthly-pace.test.ts` | Month counter and backfill gate. |
| `test/pinecone-trial-window.test.ts` | Trial calendar and rollback advice. |
| `test/pinecone-write-budget.test.ts` | `selectItemsWithinWriteBudget`. |
| `test/pinecone-metadata-and-rag-limits.test.ts` | 40 KiB metadata cap. |
| `test/pinecone-filter-to-qdrant.test.ts` | Filter translation used by live Qdrant reads and writes. |
| `test/pinecone-inference-benchmark.test.ts` | Offline benchmark parser and metrics. |
| `test/vector-fetch-id-chunks.test.ts` | Fetch URL budget. |
| `test/qdrant-read.test.ts`, `test/qdrant-write.test.ts`, `test/vector-db-qdrant-retrieval.test.ts` | The replacement path, including store and inventory without a Pinecone client. |
| `test/vector-db*.ts`, `test/rag-retrieval-*.ts`, `test/corpus-reembed*.ts`, and the other suites that `vi.mock("@pinecone-database/pinecone")` | They mock the SDK because `vector-db.ts` still imports it. The mock is not evidence the test calls Pinecone. |
| `test/health-route-exposure.test.ts`, `test/connection-health-routing.test.ts`, `test/ops-snapshot.test.ts` | Health and snapshot fields named above. |
| `test/sec-filings.test.ts`, `test/sec8k-full-body.test.ts`, `test/earningscalls-transcripts.test.ts`, `test/roic-transcripts.test.ts` | Producers that still consult the write class. |

## Ordered removal sequence

Do not start a slice until the previous slice is on `main` and `verify` is green.  Do not combine slice 1 with slice 2.  A read fallback and a write fallback fail differently, and the write path throws when Qdrant is selected but unusable.

1. Slice 0, this change. Delete the three uncalled write-class helpers. No runtime change.
2. Slice 1, reads. Make `retrieveContextDetailed` unable to select `pinecone`: remove the empty-filter force, and make `vectorReadBackend` stop returning `pinecone` once `QDRANT_URL` is required for RAG. Then delete `index.query`, `meterPineconeQuery`, and the health critical-service add. Keep `pinecone-filter-to-qdrant.ts`. Add a test that a bge-m3 retrieval with Qdrant configured never constructs `Pinecone`.
3. Slice 2, writes. Remove `RAG_VECTOR_WRITE_BACKEND=pinecone` and `RAG_VECTOR_WRITE_QDRANT=off` as a silent second store. Delete upsert, delete, fetch, list, and describeIndex branches, the WU breaker, monthly pace, trial window, write budget, and the `RAG_PINECONE_WRITE_BUDGET_ENABLED` knob. SEC ingest and the scheduler must not import those modules. Keep Qdrant fail-closed when the endpoint is missing.
4. Slice 3, write class. Land the hydrate path the 2026-08-18 and 2026-08-22 audits call PR B. Rename `pinecone-write-class.ts` to a corpus write-class module without changing default `full-body` behavior in the same pull request as the rename. Only then decide the replacement for `writesFullBodyToPinecone` on `sec-filings.ts`. Do not flip `RAG_PINECONE_WRITE_CLASS` until that replacement is the default and the tests say so.
5. Slice 4, admin and eval labels. RAG coverage, connections health, ops snapshot, census, and corpus-coverage stop saying the live index is Pinecone. Routes stay.
6. Slice 5, package and Pinecone-only tools. Delete `scripts/eval/pinecone-inference-benchmark.ts`, the assistant half of `rag-shadow-benchmarks.ts`, and `eval:pinecone-inference`. Uninstall `@pinecone-database/pinecone`. Drop it from `next.config.mjs`. Leave `pinecone-to-qdrant-copy.py` until an operator retires the copy.
7. Slice 6, keys. Remove the `pinecone` service from `db-api-keys.ts` after no resolver remains. The owner deletes `PINECONE_API_KEY` in Infisical. Do not mint a replacement key, and do not print the value.

## Rollback

Slice 0 rolls back by reverting the commit.  Ingest, retrieval, health, and the admin routes do not change in this slice.  The three helpers can be restored from the parent of this commit if a later design wants them.  `writesProcessedToPinecone` should not come back as a tautology.  If a producer needs a processed-write predicate, it has to be false for at least one class.

Until slice 1 deletes `index.query`, read rollback is `RAG_VECTOR_READ_BACKEND=pinecone` or `RAG_VECTOR_READ_QDRANT=off`.  Until slice 2 deletes the upsert branch, write rollback is `RAG_VECTOR_WRITE_BACKEND=pinecone` or `RAG_VECTOR_WRITE_QDRANT=off`.  Those switches bill Pinecone write units and require `PINECONE_API_KEY` plus `PINECONE_INDEX_NAME`.  They are not a data restore.  The 2026-09-01 write cutover stopped new Pinecone upserts on the default path and skipped the delta copy, so the Pinecone index is not the current corpus.

After slice 2, rollback is reverting the pull request, not flipping an env var.  Qdrant collection `socratic-trade` remains the store.  Do not point Socratic-Trade embeddings at the fleet bge-m3 endpoint.  The spaces do not match.  Do not drop `ingested_accessions.pinecone_write_class` in a rollback or in a forward slice without a migration that still reads old rows.

## Historical docs

Rollouts, audits, and reviews under `docs/` that mention Pinecone are history.  This plan does not edit them.  The design that slice 3 still has to satisfy is `docs/designs/2026-08-16-proposer-corpus-storage.md`, `docs/audits/2026-08-18-pinecone-store-vs-condense.md`, and `docs/audits/2026-08-22-panel-corpus.md`.  The cutover that made Qdrant the default writer is `docs/rollouts/2026-09-01-qdrant-write-cutover.md`.
