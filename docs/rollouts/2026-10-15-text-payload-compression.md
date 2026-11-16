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
- Review follow-up on PR #4720.  `text_codec` / `segment_codec` and `plaintext_length` (migration 95) let the backfill probe an index and let `hasLocalFilingCopy` stop at `LIMIT 1` without gunzip.  The 10-minute watermark is written after a pass returns.  `raw1:` carries a length frame so a plaintext that starts with `gz1:` or `raw1:` round-trips.  A transcript that fails to decode is kept on `decodeRetries` and the re-embed watermark still advances.  #4722 was still open at merge time, so this branch does not include that retention rewrite.
- Review round (autofix), PR #4720.  One open item: the codec suite never exercised the empty-string branch of `if (!plain) return plain` on `encodeTextPayload` / `decodeTextPayload` / `encodeTextPayloadAsync`.  Added a case asserting all four entry points return `""` and that the sync and async encoders agree on it.  The remaining threads were already resolved or outdated.

Space, using the given production sizes and a conservative English gzip-plus-base64 ratio of about 55% for transcripts.  Companyfacts JSON is much more repetitive.  A local sample of that shape saved about 96% after base64.  Numeric fact rows are not compressed, so the `sec_facts` save depends on how much of the 1.67 GB is the cache blob.

- Transcripts ~0.87 GB: about 0.45-0.60 GB back.
- `sec_facts` ~1.67 GB: about 0.8-1.4 GB back if the cache dominates.
- `audit_events` ~4.1 GB: 0.  Not safe.
- Combined for this pass: about 1.3-2.0 GB.  FTS, `embed_stage`, and `chunk_occurrences` are extra and unchanged.

## Verification State

Order is lint, types, the full vitest run, then the production build.  Targeted codec and transcript suites are part of `npm test`, not a step ahead of lint.

```bash
npm run lint
# eslint on the touched files: 0 errors. Pre-existing warnings in db.ts, scheduler.ts, sec-facts.ts.
npx tsc --noEmit
# clean
npm test
# 9355 passed, 51 skipped, 36 failed on the first full run.
# 12 of those were persistence-hardening asserting schema version 94. Updated to 95.
# Re-run: test/persistence-hardening.test.ts and test/text-payload-codec.test.ts, 31 passed.
# Remaining failures are outside this diff: llm keys, notify, server-metrics,
# alpha-vantage, data-providers, cpuprofile, and data-catalog pe completeness.
npm run build
# exit 0
```

## Merge-main (2026-10-15)

Merged `origin/main` through `49a76da4` (#4695 Congress push receipt, #4716 iOS ASC) into `cursor/text-payload-compression-3897`.  GitHub reported `mergeable: CONFLICTING` whenever main moved ahead of the branch merge base.  Auto-merge on `PLAN.md` and `STATUS.md` only.  Removed committed `<<<<<<<` markers from `docs/rollouts/2026-10-15-st-4531-retire-slack-callers.md` (they were already on main from a bad union merge).

## Next Steps & Blockers

- Confirm in production, after deploy, that new transcript rows and companyfacts cache rows start with `gz1:` and that `readCompanyFactsCache` still parses.  The backfill is lazy (16 transcripts and 1 CIK cache per 10 minutes on the leader).
- Do not compress `audit_events` unless every `json_extract` and every raw insert moves behind one reader, and the hash chain is redefined.  That is a different project.
- Seed `sec_eval_golden_set` and run `scripts/eval/rag-eval-harness.ts` before any embed-model change.
- Inspect `embed_stage` row age versus Pinecone commits before lowering the 2 GiB cap.
- Linear team ST writes from this seat were budget-exhausted at file time.  Retry the effort row when the seat budget resets.

## Zero-Code Findings

None.  The review document is the written half.  The codec is the code half.

## Merge-main and review follow-up (MM takeover, 2026-10-16)

Cursor's agents hit their quota, so MM is landing this branch.  The sections
above are the original Cursor record and are left as written.

`origin/main` (`a5d45401e`) is merged with a merge commit — no rebase, no
force-push.  No conflict: main's `strategy_runs_user_started_index` landed as
migration 95 and the codec columns as 96, so the two did not collide and the
twelve `getSchemaVersion` / `applyVersionedMigrations` assertions stay at 96.

**Review findings addressed.**

`src/lib/rag/corpus-reembed.ts` no longer casts the boundary value.  The
decode-retry list is now a `.strict()` Zod object inferred into its type, so
extra and unknown keys in the persisted settings record are rejected instead of
being read back as if they were part of the decoded key.  Elements are parsed
one at a time on purpose: a single hand-edited element drops only itself, which
preserves the original skip-bad-row behaviour that a whole-array `safeParse`
would have lost.

`PLAN.md` carried three entries for this one workstream, two complete and one
missing its `Linear ST-4534, PR #4720` reference.  That duplication is why the
inconsistent entry existed at all, so all three were reduced to the single
canonical entry, which keeps the full dual reference.

**Follow-up: export the retry schema (Rule 21).**  Kody re-reviewed the merge
and accepted the Zod change, then flagged that `EarningsCallsDecodeRetrySchema`
was a bare `const`.  Rule 21 wants every Zod schema exported so it stays the
single source of truth and a future caller does not re-write the shape by hand.
It is now exported, and `test/corpus-reembed-adversarial.test.ts` covers the
schema directly: a well-formed key parses, an injected extra field is rejected
rather than absorbed, a missing field and a string quarter are rejected, and
`NaN` / `Infinity` are rejected rather than stored as decoded keys.

Re-verified after the export, in the required order:

```bash
npm run lint
# exit 0
npx tsc --noEmit
# exit 0
npx vitest run test/corpus-reembed-adversarial.test.ts test/corpus-reembed.test.ts test/text-payload-codec.test.ts
# 3 files, 27 tests passed
npm run build
# exit 0
```
