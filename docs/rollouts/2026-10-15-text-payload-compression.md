# Text payload compression and RAG storage review (2026-10-15)

## Context & Objective

Transcript bodies and the SEC companyfacts JSON cache are large plaintext columns with a small reader set.  Audit JSON is not.  Jay's keep-forever set is RAG text, trade records, trade rationale, and past-decision analysis.  This change gzip-encodes the two columns that have one codec boundary, leaves FTS plaintext, and stops the 90-day audit prune from deleting post-mortem reflections.

## Changes Made

- Shared codec `gz1:` (base64 gzip) and `raw1:` (incompressible plaintext) so legacy rows still read.
- Writers encode.  Readers decode.  A 10-minute leader lane updates old rows in place.  No deletes.
- `post_mortem_reflection` added to `AUDIT_PRUNE_NEVER_PRUNED_KINDS`.  The settings blob only keeps the latest reflection.  The audit row is the history.
- Expert review with the reader/writer list and the ranked RAG recommendations: `docs/reviews/2026-10-15-rag-storage-expert-panel.md`.

Files:

- `src/lib/text-payload-codec.ts`
- `src/lib/text-payload-backfill.ts`
- `src/lib/db-earningscalls.ts`
- `src/lib/web-sources/sec-facts.ts`
- `src/lib/rag/hydrate-accession.ts`
- `src/lib/rag/corpus-reembed.ts`
- `src/lib/rag/persist-local-complete.ts`
- `src/lib/scheduler.ts`
- `src/lib/audit-prune.ts`
- `test/text-payload-codec.test.ts`
- `test/audit-hygiene.test.ts`
- `docs/reviews/2026-10-15-rag-storage-expert-panel.md`
- `docs/rollouts/2026-10-15-text-payload-compression.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- `audit_events.payload` is not compressed.  `verifyAuditChain` hashes the stored JSON, several queries use `json_extract`, and writers outside `audit()` include provider dispatch, FMP transcript audit, and `scripts/ops/backfill-pruned-latency-audits.ts`.
- Numeric XBRL `sec_facts.segment` values stay plaintext.  Only `concept = __companyfacts_json__` is encoded.
- ROIC JSON sidecars and on-disk SEC artifacts are a second copy.  They are outside the quoted SQLite sizes and were not compressed.
- FTS text stays plaintext.  Ingest and re-embed decode first.
- Embedding model, dimensions, and `VECTOR_EMBED_CLEAN_TEXT` are unchanged.  Path inventory after the first draft corrected the review: live embed is BAAI bge-m3 at 1024 (`activeEmbeddingModel`), and `voyage-finance-2` is test-only.  Corpus-wide FTS stays `sec-edgar` / `sec-8k` because licensed transcript sources lack rights metadata on the FTS row.  Do not add them to that filter in this pass.
- `embed_stage` and `chunk_occurrences` are not rewritten.  The review treats 1.9 GB of staged vectors as a delivery-delete question, and 2.2 GB of occurrences as the point-in-time ledger working as designed.
- No age deletes.  No outside price backfill.

Space, using the given production sizes and a conservative English gzip-plus-base64 ratio of about 55% for transcripts.  Companyfacts JSON is much more repetitive.  A local sample of that shape saved about 96% after base64.  Numeric fact rows are not compressed, so the `sec_facts` save depends on how much of the 1.67 GB is the cache blob.

- Transcripts ~0.87 GB: about 0.45-0.60 GB back.
- `sec_facts` ~1.67 GB: about 0.8-1.4 GB back if the cache dominates.
- `audit_events` ~4.1 GB: 0.  Not safe.
- Combined for this pass: about 1.3-2.0 GB.  FTS, `embed_stage`, and `chunk_occurrences` are extra and unchanged.

## Verification State

```bash
npx vitest run test/text-payload-codec.test.ts test/audit-hygiene.test.ts test/sec-facts.test.ts
# 22 passed
npx vitest run test/earningscalls-transcripts.test.ts test/corpus-reembed.test.ts test/hydrate-accession.test.ts test/persist-local-complete.test.ts test/memory-decay.test.ts
# 75 passed
npx tsc --noEmit
# clean
npx eslint <touched files>
# 0 errors, 3 pre-existing warnings in scheduler.ts and sec-facts.ts
npm test
# 9379 passed, 51 skipped, 25 failed.  Failures are outside this diff:
# alpha-vantage-key-pool, chat-llm, cpuprofile-summary, data-providers,
# framework-review, llm-provider, notify-body-tiers, notify-user-creds,
# openrouter-credits, persistence-notification, red-team, server-metrics.
# The llm/openrouter cluster matches the sandbox OPENROUTER_API_KEY fixture
# already noted on 2026-10-15 in STATUS.md.
npm run build
# exit 0
```

## Next Steps & Blockers

- Confirm in production, after deploy, that new transcript rows and companyfacts cache rows start with `gz1:` and that `readCompanyFactsCache` still parses.  The backfill is lazy (16 transcripts and 1 CIK cache per 10 minutes on the leader).
- Do not compress `audit_events` unless every `json_extract` and every raw insert moves behind one reader, and the hash chain is redefined.  That is a different project.
- Seed `sec_eval_golden_set` and run `scripts/eval/rag-eval-harness.ts` before any embed-model change.
- Inspect `embed_stage` row age versus Pinecone commits before lowering the 2 GiB cap.
- Linear team ST writes from this seat were budget-exhausted at file time.  Retry the effort row when the seat budget resets.

## Zero-Code Findings

None.  The review document is the written half.  The codec is the code half.
