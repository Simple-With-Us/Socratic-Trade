# RAG, trade memory, and storage expert panel (2026-10-15)

Jay's keep-forever core is RAG text, trade records, trade rationale, and past-decision analysis (what was decided, why, what happened, and the lesson).  This note is the reader/writer audit for transcript text, SEC text, and `audit_events` JSON, plus a retrieval review grounded in the current code.  It does not propose deleting history by age, and it does not propose backfilling ST price history from Yahoo, Tradier, or any other outside source.  Stored bars in `history_cache_eod` / `imported_price_eod` stay the price source of truth.

Fleet recall and recent `main` were checked first.  The August 2026 RAG audit (`docs/audits/2026-08-17-rag-learning-recall.md`) and the July expert reviews still describe real gaps (no speaker field, clean-text embed flag default off, near-dedupe only after rank).  Later work already shipped outcome closure (`docs/rollouts/2026-09-27-outcome-closure.md`), a deterministic thesis tag (PR #3914), extractive document abstracts, hybrid FTS with `accepted_at`, and market-data hygiene exemptions (PR #4683).  This review does not repeat those as if they were unbuilt.  A 2026-08-27 Supabase/pgvector migration was planned and was not the live store.  Vectors still go through `src/lib/vector-db.ts`.  The live embed model is BAAI bge-m3 at 1024 dimensions (OpenRouter `baai/bge-m3`, SiliconFlow `BAAI/bge-m3`).  `voyage-finance-2` remains only on the test path.

## Space

| Store | Prod size given | This change | Expected bytes back |
| --- | --- | --- | --- |
| `earningscalls_transcripts` | ~0.87 GB | gzip the `content` body in place | about 0.45-0.60 GB |
| `sec_facts` | ~1.67 GB | gzip only the companyfacts JSON cache in `segment` | about 0.8-1.4 GB if that cache is most of the table |
| `audit_events` | ~4.1 GB including indexes | not compressed | 0 |
| `embed_stage` | ~1.9 GB | not compressed (already float32) | 0 until delivery-delete is shown to be stuck |
| `chunk_occurrences` | ~2.2 GB | not compressed (no document text) | 0 |

Transcript estimate: English prose gzip is about 3:1 before base64.  The stored form is `gz1:` plus base64, so the column lands near 45% of the plaintext and the save is about 55%.  A templated local sample compressed much harder (95%) and is an upper bound, not the production forecast.  Indexes and the negative-cache rows stay.  Companyfacts JSON repeats taxonomy keys and unit entries.  A varied local sample of that shape saved about 96% after base64.  Real EDGAR companyfacts documents are the same shape, so 85-95% of the cache blobs is a fair range.  Numeric XBRL rows in `sec_facts` are small and stay plaintext.  Without a production split of cache blobs versus numeric rows, the honest `sec_facts` range is 0.8-1.4 GB.  Combined, this pass is about 1.3-2.0 GB, not the whole 0.87+1.67+4.1.

`document_chunks_fts` is a second copy of chunk text and is left plaintext so `MATCH` and `bm25` keep working.  Compressing the source column does not shrink that FTS copy.

## Part A. Reader and writer list

### Transcript body (`earningscalls_transcripts.content`)

One writer, several readers.  A shared codec is feasible.  Shipped in this change.

| Path | Role | Notes |
| --- | --- | --- |
| `upsertEarningsCallsTranscript` in `src/lib/db-earningscalls.ts` | writer | Only `INSERT` of this table.  Encodes on the way in.  `COALESCE` still refuses to replace a real body with null. |
| `toRow` in the same file | reader | `getEarningsCallsTranscript`, `listUningestedEarningsCallsTranscripts`, `listEarningsCallsTranscriptsForSymbol` all decode here. |
| `summarizeEarningsCallsTranscriptCoverage` | reader of presence only | `content IS NOT NULL`.  Does not read the bytes.  Stays that way so ops snapshot does not scan every blob. |
| `hydrateTranscript` in `src/lib/rag/hydrate-accession.ts` | reader | Decodes, then applies the old "longer than 80 characters" check on plaintext. |
| `listEarningsCallsCandidates` / `reembedEarningsCallsTranscripts` in `src/lib/rag/corpus-reembed.ts` | reader | Decodes before `storeDocument`, so re-embed and FTS see plaintext. |
| `hasLocalFilingCopy` in `src/lib/rag/persist-local-complete.ts` | reader | Decodes a few candidate rows.  Stored `length(content)` is not used, because gzip changes it. |
| `backfillCompressedTextPayloads` in `src/lib/text-payload-backfill.ts` | in-place update | Lazy.  Compare-and-swap on the exact stored text.  No deletes. |
| `readRoicTranscriptArtifact` in `src/lib/roic-archive-artifacts.ts` | separate filesystem copy | `data/corpus/roic` JSON sidecars.  Not the 0.87 GB SQLite figure.  Left as plaintext files.  Hydrate falls through to them. |
| `fmp_transcript_versions` | not a body store | SHA-256, fiscal period, commit state.  No transcript prose column. |
| `fmp_transcript_derived_artifacts` | provenance pointers | Rights generation and artifact ids.  Not the call text. |
| `src/lib/earningscalls-transcripts.ts`, `src/lib/web-sources/roic-transcripts.ts` | producers | They call the CRUD helper.  They do not insert SQL themselves. |

FTS does not read the compressed column.  Ingest chunks the decoded string and `insertDocumentChunkFts` / `insertDocumentChunkFtsBatch` (`src/lib/db-learning.ts`) write plaintext into `document_chunks_fts.text`.

### SEC text

`sec_facts` is not the filing body.  Filing prose lives in on-disk artifacts and in FTS chunks.  The large `sec_facts` bytes are the companyfacts JSON cache.

| Path | Role | Column |
| --- | --- | --- |
| `upsertCompanyFactsCache` / `ingestCompanyFacts` in `src/lib/web-sources/sec-facts.ts` | writer of the cache | `segment` where `concept = __companyfacts_json__`.  Encoded. |
| `readCompanyFactsCache` | reader of the cache | Decodes.  Callers: `SecXbrlEnrichmentProvider` in `src/lib/data-providers.ts`, the nightly sweep. |
| `ingestCompanyFacts` fact loop | writer of numeric rows | Same table, real concepts.  `segment` is a small XBRL dimension or null.  Not compressed. |
| `formatCompanyFactsEvidenceCard` | reader of numeric rows | Selects concept, value, unit, period.  Excludes the cache concept.  Never sees the blob. |
| `sec_filings`, `sec_artifacts` | filing metadata | `sec_artifacts.raw_uri` points at the on-disk artifact.  The bytes are not in this table. |
| `insertDocumentChunkFts` | writer of chunk text | Plaintext.  Must stay plaintext. |
| `search-fusion.ts`, `corpus-wide-lexical.ts`, `hydrate-accession.ts` (FTS branch), `corpus-reembed.ts` | readers of FTS text | `MATCH` / `LIKE` / `bm25` on `document_chunks_fts.text`. |
| `document_abstracts` via `src/lib/db-document-abstracts.ts` and `src/lib/rag/document-summarizer.ts` | extractive summary | `summary_text` plus guidance/drivers/risks JSON.  Embedded as `document-summary` / `earnings-summary`.  Not the raw filing. |
| `chunk_occurrences` | no text | Identity, symbol, accession, section, `accepted_at`, commit, receipt. |
| `embed_stage` | no text | Float32 vector blob plus hash, model, revision. |

On-disk `sec-artifacts` and ROIC JSON are a second copy outside the quoted table sizes.  Compressing them would be a different reader/writer set (filesystem, not one SQL column).  Not in this pass.

### `audit_events.payload`

Not a single path.  Compression is not feasible without breaking the hash chain or SQL.

Writers:

- `audit()` in `src/lib/db.ts`.  Canonical writer.  `chain_hash` is SHA-256 over the plaintext JSON (`auditChainMaterial`).  `verifyAuditChain` recomputes from the stored payload.
- One-time migration 68 insert (`fill_unreconcilable_backfill`) in `src/lib/db.ts`.  Historical, not a live path.
- `src/lib/db-provider-dispatch.ts` inserts `provider_dispatch_stale_owner_resolved` with its own SQL, no chain columns.
- `recordFmpTranscriptDerivedAudit` in `src/lib/web-sources/fmp-transcripts.ts` inserts with its own SQL.  The same file can delete a specific audit id.  That is not age pruning.  It is another writer outside `audit()`.
- `scripts/ops/backfill-pruned-latency-audits.ts` inserts `llm_call_latency` with `INSERT OR IGNORE` and no chain hash.  Ops-only.

Readers that require plaintext JSON inside SQLite (not an application decode):

- `json_extract(payload, ...)` in `src/lib/mobile-api.ts`, `src/lib/db-execution.ts`, `src/lib/strategy-run-retry.ts`.
- Payload selected and parsed in `src/lib/db-learning.ts`, `src/lib/ops-snapshot.ts`, `src/lib/ops-performance.ts`, `src/lib/model-rotation.ts`, `src/lib/autonomy-halt-cause.ts`, `src/lib/web-sources/fmp-transcripts.ts`.
- `src/lib/sqlite-storage-hygiene.ts` sums `length(payload)` for sizing.  It does not need to parse, but a compressed payload would lie about the logical size.

A gzip payload would fail `json_extract`, fail `verifyAuditChain`, and miss every insert that does not call `audit()`.  That list is not clean.  This pass does not compress it.  Theoretical save if it were safe would be large (audit JSON is repetitive), and it is explicitly not taken.

Age deletion of audit rows still exists in `src/lib/audit-prune.ts` (14-day observability kinds, 90-day default).  That lane is not expanded.  `post_mortem_reflection` is now on `AUDIT_PRUNE_NEVER_PRUNED_KINDS` because that row is the history of past-decision analysis.  See below.

### Codec

`src/lib/text-payload-codec.ts`.

- `gz1:` + base64(gzip).  Used only when the stored form is smaller than the plaintext.
- `raw1:` + plaintext when gzip does not shrink the string, so the lazy backfill can mark the row done.
- Unmarked text is legacy plaintext and decodes as itself.
- A broken `gz1:` payload throws.  Callers never treat gzip bytes as a transcript.
- Scheduler lane `text-payload-backfill` (`src/lib/scheduler.ts`), leader only, every 10 minutes, 16 transcripts and 1 companyfacts blob.  `UPDATE` only.  Compare-and-swap.  No `DELETE`.

## Part B. What to save, and how past decisions should come back

### Already durable (keep)

- Trade records: `trade_proposals`, `fill_events`, `order_replacements`.  Hygiene refuses these tables (`MONEY_PATH_TABLES` in `src/lib/sqlite-storage-hygiene.ts`).
- Decision case: `socratic_decisions` holds thesis, rationale, green-team rationale, sizing snapshot, evidence, `rag_attributions`, dissent, outcome JSON (status, return, P&L, horizons), lessons, and coach notes.  `socratic_coach_note_archive` keeps notes that fall out of the live cap.  Nothing in the hygiene target list deletes these tables.
- Outcome receipt: `writeSocraticDecisionOutcome` in `src/lib/db-socratic.ts` writes the case first, then audits `socratic_outcome_recorded`.  The case row is the source of truth.  The audit kind is on the 14-day observability list because it is a duplicate receipt, not the only copy.  Leaving that prune in place does not drop the outcome.
- Lessons: `learned_context` and `learned_context_pending` are money-path tables.  Thesis track-record facts are written from `src/lib/post-mortem.ts` (`writeThesisTrackRecordFacts`).  Outcome closure (2026-09-27) stopped system lessons from being upgraded into the human risk queue solely because they mention behavior.  Keyword risk matches still queue.  That gate should stay.
- Episodic vectors: closed lots are embedded as `experience-memory`.  `pinecone-write-class.ts` lists `socratic-decision`, `coach-note`, `lesson`, `experience-memory`, and `user-memory` as do-not-touch.  `operational-index-prune.ts` says it does not delete them.
- Prices used to score outcomes: fills plus `history_cache_eod`.  Do not backfill that from an outside vendor.

### Gap in past-decision analysis

The pieces of "what / why / what happened / lesson" are split, and one of them was being thrown away.

| Piece | Where it lives | Gap |
| --- | --- | --- |
| What was decided | `socratic_decisions` (action, side, symbol, thesis tag, notional) and `trade_proposals.proposal` | Durable. |
| Why | `socratic_decisions.rationale`, `green_team_rationale`, `evidence`, `rag_attributions` | Durable on the case.  The hourly reflection blob is not. |
| What happened | `socratic_decisions.outcome`, `fill_events` | Durable on the case.  Audit receipt is pruned at 14 days and that is acceptable because the case remains. |
| Lesson | `socratic_decisions.lessons`, `learned_context`, and `post_mortem_reflection` | The settings key `reflection_summary:<account>` is last-writer-wins.  The audit row was the only history, and the 90-day default deleted it.  This change exempts that kind. |

There is still no one row keyed by decision id that stores the reflection text next to the outcome.  Retrieval of "last time we bought this name under this thesis" goes through vector memory (`indexSocraticDecisionMemory`, experience-memory) rather than a structured filter on symbol, thesis tag, regime, and outcome sign before the embed.  `memory-decay.ts` computes a half-life blend and is only imported by its unit test.  `shouldSoftArchive` must not be wired as a delete.

Recommended shape, not built here because it is a schema and retrieval change, not a one-line win:

- Append-only `decision_postmortems` (or extra columns the reflection writer fills on the existing case): `decision_id`, `as_of`, `what_decided`, `why`, `what_happened`, `lesson`, `outcome_status`, `thesis_tag`, `regime`, `symbol`.  Never updated into oblivion.  A newer lesson inserts a new row.
- Retrieval: SQL filter (symbol, thesis tag, regime, outcome sign, `as_of <= decision time`) then a small embed only if the filtered set is large.  Put the winning rows in the prompt as cases, not as another undifferentiated chunk.
- Keep embedding the lesson once.  Do not re-embed the whole case on every horizon tick if the text did not change.  `writeSocraticDecisionOutcome` already re-indexes when the outcome lands.  That is the right moment.
- Grade the lesson later with the same fill and stored-bar prices.  A lesson that does not predict the next similar case gets a lower usefulness weight.  It is not deleted.

`tradeThesisTag` is no longer only the model's self-grade (PR #3914).  Three tags still abstain (Mean-Reversion, Defensive-Rotation, Analyst-Revision).  Until those have a scorer, do not treat their scorecards as independent evidence.

## Embedding, chunking, search

Live embed is BAAI bge-m3 at 1024 dimensions.  `activeEmbeddingModel` in `src/lib/vector-db.ts` returns `baai/bge-m3` for OpenRouter and `BAAI/bge-m3` for SiliconFlow.  Provider order is a pin (`RAG_EMBED_PROVIDER`), then an OpenRouter key, then a SiliconFlow key.  `voyage-finance-2` is selected only when `NODE_ENV=test`.  `EMBEDDING_DIMENSION` is still 1024, so a dimension change is still a full re-embed.  `currentEmbedRev()` is 1, or 2 when `VECTOR_EMBED_CLEAN_TEXT` is on.  That flag defaults off.  Stored chunk text can include a `[Published: …]` header while the query embed is the raw query.  Flipping the flag changes the space and needs `corpus-reembed.ts`.  Do not flip it in this pass.

Default lexical recall is corpus-wide FTS inside `retrieveContextDetailed`, and it is on.  The SQL in `src/lib/rag/corpus-wide-lexical.ts` keeps `o.source IN ('sec-edgar', 'sec-8k')`.  Earnings-call chunks can sit in `document_chunks_fts` after an EarningsCalls `persistLocalComplete`, and they still do not join this query.  The comment on that filter says licensed transcript text needs rights metadata the FTS row does not store.  Dense retrieval can still return those chunks from vector metadata.  Do not add transcript sources to that `IN` list until the rights metadata exists.  ROIC full calls are in `earningscalls_transcripts` and the JSON sidecar.  ROIC ingest does not mirror the full call into FTS.  It does put speaker role on section `itemCode` via `roleOfSpeaker` at ingest time.  A cache hit rebuilds with `turns: []`, so that speaker label is lost until a refetch.  FMP call text is embedded and is not stored as a SQLite body.  `fmp_transcript_versions` keeps the hash.

Chunking is 480 tokens with 12% overlap (`src/lib/rag/chunk.ts`).  There is still no speaker column on `DocumentChunk`.  ROIC can stamp a role onto section `itemCode` only while the live payload still has turns.  EarningsCalls and the cache rebuild cannot be filtered to CEO versus analyst.  The SEC worker's chunk budget is not the same object as `chunk.ts` (the August audit already noted 400 / 0.15 on one worker path).  One budget should win before any re-chunk.

Hybrid search is real.  `src/lib/rag/search-fusion.ts` and `src/lib/rag/corpus-wide-lexical.ts` run FTS `bm25` and require `chunk_occurrences.accepted_at <=` the query as-of.  That clock covers the filing sources the lexical query actually joins.  Transcript chunks with occurrences are still outside that `IN` list.  Experience-memory does not go through `chunk_occurrences` (called out in `corpus-reembed.ts`).  A lesson written after the decision time can still be retrieved for a historical replay unless the caller passes an as-of into that path.  `resolveRetrievalAsOf` exists and the eval harness uses it.  The production strategy retrieval path should use the same clock.

Rerank exists and is budget-gated (`src/lib/rag/run-budget.ts` can skip rerank and hybrid, not the core retrieve).  Usefulness re-ranking is advisory, at most ±10%, rank-stable, and flag-gated (`applyRetrievalUsefulnessWeighting`).  Callers include experience-memory and the filings path in `src/lib/strategy.ts`.  It never drops a chunk.  That matches the product rule.  Leave the cap.

`scripts/eval/rag-eval-harness.ts` scores recall@10, recall@50, and nDCG against `sec_eval_golden_set`.  The table is created in migration 48 and the harness returns zeros when it is empty.  There is no checked-in golden set of decision questions.  That is the evaluation gap.  Do not add sources until this harness, pointed at as-of retrieval, says the source moves recall.

## embed_stage and chunk_occurrences

`embed_stage` (`src/lib/db-embed-stage.ts`) is the paid-vector shock absorber.  A row is written after a successful embed and deleted by `deleteStagedEmbeddings` once Pinecone has the vector.  The comment in that file says steady state is about zero rows.  A 35-day sweep removes orphans.  A 2 GiB cap deletes oldest rows and writes one audit.  Production at ~1.9 GB is the cap, not the steady state.  `INSERT OR REPLACE` refreshes `created_at`, so a retry loop can keep a row young forever while the cap deletes some other symbol's undelivered vector.  That is the failure mode to confirm in prod (count rows, age of `created_at`, whether deletes follow commits).  Do not compress the blob.  Do not shorten the 35-day window in order to "save space" if those rows are the only copy of a paid embed that never landed.  Fix delivery-delete first.

`chunk_occurrences` is the occurrence ledger: one row per location of a content hash, with `accepted_at` as the availability clock the lexical search joins on.  It does not store chunk text.  `document_chunks` is the hash set.  FTS is the text.  2.2 GB is cardinality plus indexes (hash, symbol, accession, commit, tenant), inflated by 12% overlap and by keeping every occurrence forever.  That is the design.  It is working.  Do not drop the table and do not prune it by age.  Future growth is an ingest-time near-dedupe question, not a retention question.  Near-dedupe today is Jaccard 0.6 inside rank (`dedupeSimilar`), after the embed was already paid.

## Summaries, more data, dedupe

Extractive highlights already run (`document-summarizer.ts`, model label `extractive-highlights-v2`).  They are saved and embedded.  The ingest path does not call a generative LLM to summarize a 10-K.  Adding one would spend tokens and can put a paraphrased number next to the filing.  Do not add that until the golden set shows the extractive abstract missed a catalyst the full chunk also missed.

The summary that does help is the one the app already writes about its own trades: post-mortem reflection grounded in thesis scorecards (`src/lib/post-mortem.ts`).  Keep it.  Key it to decision ids.  Do not summarize news into the same corpus without a source timestamp and an as-of filter.  More newswire text, without that filter, is noise and look-ahead.

More SEC and more transcripts of names we actually trade is signal, because those documents are timestamped and already have an occurrence row.  More of the same filing re-chunked under a second model is cost.  FMP call text is rights-gated and is not in the local re-embed set on purpose.  Do not mirror it into SQLite "for RAG" ahead of the rights gate.

Dedupe that exists: `content_hash` primary key on `document_chunks`, optional `storeContexts` dedupe, FTS occurrence identity.  Dedupe that does not exist at ingest: near-duplicate windows.  Build the eval before paying for a second embed of a 12% overlap.

## Top 10, by impact on the next trade and on cost

1. **Retrieve past decisions as cases, and stop losing the reflection history.**  Quality: the model sees what it decided, why, what the fill did, and the lesson, for the same symbol and thesis, as-of the new decision.  Cost: small.  This PR keeps `post_mortem_reflection` forever.  The follow-up is a decision-keyed append-only lesson, SQL-filtered before any embed.
2. **Point-in-time on every memory path, using stored prices only.**  Quality: stops a later lesson or a later filing from teaching a past decision.  `accepted_at` already gates FTS.  Experience-memory and abstracts need the same clock.  Do not import outside prices to fill gaps.
3. **Confirm `embed_stage` delivery-delete before buying more embed capacity.**  ~1.9 GB against a 2 GiB cap means the paid-vector cache is not at the designed empty steady state.  Fixing a stuck delete saves disk and stops the cap from dropping an undelivered vector that would be paid for again.  No model change.
4. **Wire `blendedScore` from `memory-decay.ts` as an advisory rank nudge.  Do not call `shouldSoftArchive`.**  The math is tested and unused.  Recency then affects order without a re-embed and without deleting lessons.
5. **Keep bge-m3 at 1024 dimensions, and leave `VECTOR_EMBED_CLEAN_TEXT` off, until the golden set has rows.**  The live model is already BGE, not Voyage.  A swap or a clean-text flip hides the current corpus until `corpus-reembed.ts` finishes.  `scripts/eval/rag-eval-harness.ts` is the harness.  Seed decision-quality questions with an as-of.
6. **One chunk budget, then keep speaker turns on the transcript ingest that already has them.**  `chunk.ts` is 480 tokens and 12% overlap.  The SEC worker uses 400 and 0.15.  ROIC already stamps `roleOfSpeaker` onto section `itemCode` when the live payload has turns.  The SQLite cache path rebuilds with empty turns, so the label disappears on the next ingest from cache.  Persist the turns next to `content` before paying to re-chunk the SEC corpus.  Corpus-wide FTS still will not see those chunks until the rights filter allows the source.
7. **Keep extractive abstracts.  Do not add generative filing or news summaries.**  Abstracts are already stored and embedded.  A generative layer costs tokens and can invent figures.  The post-mortem of our own trades is the summary worth extending, because it is tied to realized P&L.
8. **Ingest-time near-dedupe for new chunks only.**  Today's Jaccard dedupe runs after rank, so overlap windows are still embedded and still insert `chunk_occurrences` rows.  Doing it before the embed cuts bge-m3 and Pinecone cost and slows the 2.2 GB ledger.  Do not delete existing occurrences.
9. **Leave `chunk_occurrences` and FTS plaintext alone.**  The ledger is the as-of authority.  FTS is the text index.  Compressing either breaks search or the point-in-time join.  The gzip in this PR is only the transcript body and the companyfacts cache.
10. **More data only when the harness says so.**  More filings and transcripts for names we trade, with `accepted_at`, is the useful direction.  A wider newswire, a second embed model, or a Yahoo price backfill adds noise or violates the price source of truth.  FMP full text stays behind the rights gate.

## What this change shipped

- Transparent gzip for `earningscalls_transcripts.content` and for the companyfacts cache in `sec_facts.segment`, behind decode on every reader of those bodies.
- Lazy in-place backfill.  No deletes.  FTS still indexes plaintext.
- `post_mortem_reflection` is never age-pruned.
- `audit_events` payload is unchanged, on purpose.
