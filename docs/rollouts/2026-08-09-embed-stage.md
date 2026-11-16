# 2026-08-09 — Durable embed stage (embed-once guarantee for paid document embeddings)

Agent: MONET · Branch: `monet/embed-stage` (stacked on `monet/pinecone-wu-breaker` / PR #2596 — see Decisions)

## 1. Context & Objective

Owner directive (verbatim intent): *"if we spent on openrouter then we should spend on putting it
into the database so we aren't wasteful"* — a paid document embedding must NEVER be paid for twice.
Before this change, computed document vectors lived only in a bounded process-local cache
(`documentEmbeddingCache` in `src/lib/vector-db.ts`: 4096 entries, 6 h TTL, gone on restart). Any
Pinecone upsert failure — monthly WU exhaustion (now gated by the wu-breaker, PR #2596), per-second
429s, network errors, deploy restarts — discarded the computed vectors, and the retry re-embedded
the same text through paid OpenRouter.

## 2. Changes Made

**Architecture.** New SQLite table `embed_stage` acts as a durable L2 under the existing in-memory
L1. Rows exist ONLY in the window between a successful (paid) embed batch and the successful
Pinecone delivery of those vectors:

- `storeContextsImpl` persists one row per unique embed input immediately AFTER provider-response
  validation and BEFORE the Pinecone upsert attempt.
- On upsert success, the batch's rows are deleted (plain calls delete per upsert batch; managed
  two-phase commits — the `storeDocument` path — defer deletion until the committed re-upsert AND
  `markCommitted()` succeed, because a mid-commit failure aborts and re-runs the whole document and
  that retry must still find the paid vectors after a restart).
- On ANY upsert failure the rows remain. Every retry path checks the stage FIRST — the
  `reuseExactEmbeddings` prefill consults L1 then the stage; the plain (non-reuse) batch path
  consults the stage per batch — and replays staged vectors with NO provider call. Steady state is
  ~zero rows.

**Stage row key & contents.** `PRIMARY KEY (content_hash, model, revision)` where `content_hash` =
`hashContent()` (SHA-256/32) of the EXACT embed-input text (`documentEmbeddingInput()`, i.e.
`embeddingText || text` post clean-text processing — the same bytes the L1 cache keys on, NOT the
stored citation text), `model` = `activeEmbeddingModel(userId)`, `revision` =
`String(currentEmbedRev())`. Columns: `dims`, `vector BLOB` (Float32Array bytes, dims × 4 ≈ 4 KB
per 1024-dim chunk), context columns `symbol`/`source`/`chunk_id`/`user_scope` (observability
only), `created_at`.

**Files touched:**

- `src/lib/db-embed-stage.ts` (NEW) — CRUD (`stageEmbeddedVectors`, `getStagedEmbeddings`,
  `deleteStagedEmbeddings`), Float32 BLOB codec (`encodeEmbeddingF32`/`decodeEmbeddingF32`, exact,
  alignment-safe, corrupt rows self-heal to misses), `embedStageStats`, `sweepEmbedStage`
  (35-day retention + 2 GiB defensive cap, oldest-first, ONE audit row per cap event).
- `src/lib/db.ts` — `CREATE TABLE embed_stage` + `idx_embed_stage_created` in `migrate()`; barrel
  `export * from "./db-embed-stage"`.
- `src/lib/vector-db.ts` — stage wiring in `storeContextsImpl` (covers `storeDocument` too, which
  delegates its embed/upsert to `storeContextsImpl` with `reuseExactEmbeddings` + managed commit);
  new `StoreContextsResult.embedsFromStage`; `embed_stage_replay` audit receipt (one row per store
  call: `embedsAvoided`, `attempted`, `indexed`, `batches`); `embedsFromStage` added to the
  `vectorStore:lastIngest` snapshot and `vector_store` audit payload.
- `src/lib/audit-prune.ts` — daily housekeeping lane now calls `sweepEmbedStage`;
  `AuditPruneResult` gains `embedStageExpired`/`embedStageCapPruned`.
- `src/lib/scheduler.ts` — audit-prune lane summary includes the stage sweep counts.
- `test/embed-stage.test.ts` (NEW) — 11 tests, see Verification.
- `test/vector-db-lease-fencing.test.ts` — isolation fix only: clears `embed_stage` in
  `beforeEach` (a lease-loss abort after a paid embed deliberately leaves staged rows, and a later
  test reusing the same document text would replay them and never reach its embed-side abort hook).

## 3. Decisions & Trade-offs

- **Branched from the wu-breaker tip, not `origin/main`.** The task directive said branch from
  `origin/main`, but PR #2596 (`monet/pinecone-wu-breaker`) had not merged yet and this work
  integrates with (and tests against) the breaker's gate. `monet/embed-stage` is stacked on
  `8691b6c3` (= origin/main `448308bb` + the one breaker commit). When #2596 merges, this branch
  PRs clean on top.
- **The stage stores the VECTOR, not the Pinecone record.** The directive allowed storing full
  upsert metadata "if practical". It is deliberately NOT stored: replay is always a re-run of
  `storeContexts`/`storeDocument` from the same source document (the SEC ingest retry queue and
  hourly cycles re-drive the same producers), which rebuilds ids/metadata through the same code
  path — managed-commit receipts, lease fencing, tenant scoping, retrieval-metadata versioning.
  A persisted record copy would drift, and a replayed stale `attempt_token`/`commit_id` would
  actively violate the two-phase vector-commit ledger. The vector is the only artifact that costs
  money; `symbol`/`source`/`chunk_id` columns are observability context, not replay inputs.
- **WU-gate ordering: the breaker blocks EVERYTHING, including stage consumption.** While the
  monthly marker is active, upserts would 429 too, so replaying staged vectors would waste the
  replay. The early gates in `storeContextsImpl`/`storeDocumentImpl` sit before any stage read;
  staged rows are consumed only after the gate lifts (expiry, eager clear, or manual marker
  delete). Verified by test.
- **The stage is NOT a general-purpose cache.** Rows are deleted on successful delivery, so the
  deliberate "always re-embeds" refresh semantics of plain `storeContexts` (R10 note) are
  unchanged for routine cycles — a stage hit can only ever be a vector a prior FAILED attempt
  already paid for.
- **Stage ops are best-effort by construction** (try/catch around lookup/persist/delete): a stage
  failure degrades to today's behavior (re-embed / retention sweep), never fails a store. This
  also keeps the several existing suites that partially mock `../src/lib/db` green without edits.
- **f32 precision.** Replayed vectors are Float32-rounded (`Math.fround`) relative to the
  provider's f64 JSON — Pinecone stores f32 internally, so delivered precision is identical.
- **Budget interaction.** Stage hits in the `reuseExactEmbeddings` prefill are resolved BEFORE the
  paid-embed ingest budget is computed, so replays don't consume `RAG_INGEST_MAX_TEXTS_PER_DAY`.
  In the plain path the budget is still computed on the full document count (conservative
  over-count; acceptable — the realistic recovery run happens with a fresh daily budget). The
  Pinecone write-unit daily fuse still counts replayed docs (they DO cost WUs to upsert).
- **/admin "embeds saved" counter: skipped** (directive: nice-to-have only if trivial). The
  `embed_stage_replay` audit rows already surface in the admin activity feed, and
  `vectorStore:lastIngest` now carries `embedsFromStage`.

## 4. Verification State

```bash
npx tsc --noEmit                      # clean
npm run lint                          # 0 errors (728 grandfathered warnings)
npx vitest run test/embed-stage.test.ts                       # 11/11
npx vitest run test/embed-stage.test.ts test/pinecone-wu-breaker.test.ts \
  test/disclosure-rag.test.ts test/sec-ingest-seeder.test.ts test/sec-ingest-worker.test.ts \
  test/audit-hygiene.test.ts test/corpus-reembed.test.ts test/corpus-reembed-adversarial.test.ts
                                      # 8 files / 79 tests green
npx vitest run test/vector-db*.test.ts (10 store-path files)  # 10 files / 154 tests green
npx vitest run (14 retrieval/cache/scheduler-adjacent files)  # 14 files / 132 tests green
```

New tests prove: persist-BEFORE-upsert ordering (row count observed inside the upsert mock);
upsert-success deletes rows; upsert-failure keeps rows and the retry consumes them WITHOUT calling
the mocked embed provider — across a simulated restart (`vi.resetModules`, fresh L1, persistent
SQLite); same for the `reuseExactEmbeddings` path; a failed retry keeps rows parked; WU-gate
blocks embed + upsert + stage-consume and the stage replays only after the gate lifts; 35-day
retention sweep; size-cap oldest-first prune with exactly one audit row; audit-prune lane wiring;
Float32Array BLOB roundtrip exactness (incl. through real SQLite) and corrupt-shape rejection.

Not run per task scope: full `npm test`, `npm run build` (landing operator runs the full gate).

## 5. Next Steps & Blockers

- Landing operator: land AFTER (or with) PR #2596 — this branch contains the breaker commit; a PR
  opened before #2596 merges will show both commits (correct for a stacked land).
- Optional follow-up (cheap): surface `embedsFromStage` in the RAG coverage/admin stats card.
- Optional follow-up: consult the stage for QUERY embeddings too (out of scope — query embeds are
  cheap and cached separately in `rag/query-embed-cache`).

## 6. Zero-Code Findings

None — implementation change.
