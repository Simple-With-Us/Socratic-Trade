# 2026-11-25 — ST-4683 OD-7 operational vector index prune, live reconcile, decay on, weekly soft-archive

## 1. Context & Objective

ST-4683 is the OD-7 child of the ST-4668 roadmap: prune the operational vector index (Form 4 XML vectors, empty-ticker 13F vectors, superseded generations), turn decay weighting on, wire the weekly soft-archive, and continue the Pinecone removal (reconciliation rows A2, A4b, C1, C2).  Owner-approved order, three steps with receipts: (1) dry-run counts report first, (2) live junk delete (empty-ticker 13F + superseded generations), (3) weekly soft-archive.  Everything here is code and wiring; the receipts themselves are run by the lead server-side against production and pasted into section 6.

## 2. Changes Made

- `src/lib/memory-decay.ts` — `memoryDecayWeightingEnabled()` default flips from OFF to ON (OD-7); `RAG_MEMORY_DECAY_WEIGHTING=off / 0 / false / no` is the explicit kill switch (envFlagOn fail-closed parsing unchanged).  Header + doc-comment text updated; the bounded +/-15% positional nudge math is untouched.
- `src/lib/soft-archive.ts` (NEW) — the only writer of `vector_doc_lifecycle.archived_at`.  `planSoftArchiveForUser` grades every live lifecycle row with the same `kindStatsFor` selection the retrieval nudge uses; `decideSoftArchiveRow` archives only when: type is socratic-decision or experience, age >= 90 days, recency under the 0.15 floor, and the credited importance <= 25 with >= 5 samples (neutral 50 without evidence).  `softArchiveComposite` reuses `blendedScore` with the outcome hit rate as the semantic-proxy term, so nothing synthetic is invented.  `runSoftArchiveIfDue` is the weekly per-user watermark pass that archives, audits (`soft_archive_sweep`), and never throws.
- `src/lib/db-memory-lifecycle.ts` — new `listArchivedVectorIds(userId, ids)` batched lookup for the read side.
- `src/lib/experience-memory.ts` — `retrieveDecisionExperiences` drops soft-archived ids (fail-open) before the usefulness/affinity/decay re-ranks; comment updated for the default-ON decay flag.
- `src/lib/retrieval-usefulness.ts` — `kindStatsFor` (and `KindStats`) exported so the archive sweep grades docs exactly as retrieval graded them.
- `src/lib/vector-db.ts` — `reconcileManagedVectorRecords` gains `purgeSuperseded` (OD-7): committed non-head commits have their provider vectors deleted under the same claim/CAS/lease fences, then the commit is invalidated in the ledger; dry-run reports the ids without claiming.  `inventoryVectorRecordsByMetadata` now passes its computed 250k envelope to the Qdrant inventory (was silently clamped to 50k).  Stored `parent_text` metadata is bounded to the 6,000 chars retrieval can attach (`boundStoredParentText`).  The 40,896-byte Pinecone metadata soft limit now applies only on the Pinecone write path.
- `src/lib/rag/parent-context.ts` — new `MAX_STORED_PARENT_TEXT_CHARS` + `boundStoredParentText`.
- `src/lib/vector-store/qdrant-write.ts` — `qdrantInventoryByMetadata` hard ceiling raised 50k -> 1,000,000; caller/env may raise the default toward it (`VECTOR_INVENTORY_MAX_SCANNED`); the count pre-check and mid-scroll checks unchanged otherwise.
- `src/lib/scheduler.ts` — scheduled managed-vector reconcile runs `dryRun: false` (lease + CAS fences intact); the journal summary carries promoted/deleted counts; the two Pinecone maintenance ticks (`pinecone-trial-rollback`, `pinecone-wu-breaker-trial-clear`) and their imports are removed; a new `soft-archive-sweep` journal lane runs `runSoftArchiveIfDue` per user.  CODEOWNERS money path - owner merge required.
- `src/lib/rag/thirteen-f-vector-prune.ts` (NEW) — provider-side A4b prune: classifies `13f-holdings` rows by symbol, deletes empty/missing-ticker ones, keeps tickered; dry-run by default, live delete needs the shared `prune-operational-junk` confirm token, audit `od7_thirteen_f_prune`.
- `scripts/od7-vector-prune.ts` (NEW) — the receipts CLI.  No flags: JSON dry-run report (operational prune classes, superseded ledger census, reconcile dry-run with `purgeSuperseded`, 13F empty-ticker inventory).  `--apply --confirm=prune-operational-junk`: live reconcile-with-purge then the live 13F delete; the token is validated before any mutation.
- Tests: `test/memory-decay.test.ts` (default-ON + kill switch), `test/experience-memory.test.ts` (default-ON wiring), `test/soft-archive.test.ts` (NEW, pure classification + composite), `test/thirteen-f-vector-prune.test.ts` (NEW, pure classifier/planner), `test/qdrant-write.test.ts` (ceiling raise + 1M clamp), `test/vector-db-qdrant-retrieval.test.ts` (250k envelope skip), `test/scheduler-managed-vector-reconcile.test.ts` (live-pass contract + count-shaped success receipt).

## 3. Decisions & Trade-offs

- The routine scheduled reconcile goes live WITHOUT `purgeSuperseded`: overnight crash repair stays exactly as fenced as before, and the superseded-generation delete is the operator-flagged step-2 receipt, so the two changes land separately reviewable.
- Superseded-generation invalidation reuses `invalidateVectorCommitForReconciliation`: the retired commit moves to aborted, its receipts go pending, its `vector_document_versions` row is dropped in the same transaction that deletes its provider vectors (one version row without vectors cannot be replayed, and a later backfill rebuilds from the preserved receipts because v3 ids are content-derived).
- The soft-archive predicate manufactures nothing: no credited history means neutral importance 50, which can never pass the 0.25 blend floor, so unjudged docs are never archived by this pass.  `lesson`/`coach-note` remain unarchivable, matching `shouldSoftArchive`.
- The archive READ side excludes only in `retrieveDecisionExperiences` (the sole lifecycle-tracked episodic reader).  Chat-search paths may still surface an archived decision; that is deliberate and noted as a follow-up, not a bug.
- Empty-ticker 13F vectors are deleted even though `refreshThirteenF` will recreate them on the next refresh (the producer still embeds with `ticker: ""`).  That producer decision (stop embedding, or resolve the filer ticker) is a separate follow-up kept off this PR; re-running the receipt CLI re-prunes until then.
- Qdrant inventory ceilings: 50k was a cheap private default that parked the whole reconcile behind "over scan ceiling" skips; the new 1M hard cap preserves the one-bad-scroll guard while the wrapper defaults to 250k.

## 4. Verification State

Run in this lane (Linux, Node v22 - the box hosts production, so full `npm test`/`npm run build` are deliberately left to the lead; swift is untouched):

```bash
npx tsc --noEmit     # clean, no output
npm run lint         # 0 errors, 918 warnings (all grandfathered backlog)
npx vitest run test/memory-decay.test.ts test/soft-archive.test.ts test/thirteen-f-vector-prune.test.ts test/experience-memory.test.ts test/scheduler-managed-vector-reconcile.test.ts test/rag-parent-context.test.ts test/memory-lifecycle-wiring.test.ts test/pinecone-trial-window.test.ts test/qdrant-write.test.ts test/qdrant-read.test.ts test/vector-db-qdrant-retrieval.test.ts test/vector-db-document-receipts.test.ts test/vector-db.test.ts test/operational-index-prune.test.ts test/pinecone-write-class.test.ts test/scheduler-cadence.test.ts test/scheduler-connectivity-skip-row.test.ts test/scheduler-boot-halt-notify.test.ts test/scheduler-draining.test.ts test/auto-tune-scheduler-lease.test.ts   # 20 files, 202 passed
```

No console (`app/console/**`) files touched, so `copy-rules-lint` has nothing to run on.

## Next Steps & Blockers

- Lead sync (Nov 25 night): base includes ST-4677/#5476 and #5479; this amendment is the real tip commit so the Kody review has a changed head.
- PR is READY with CODEOWNERS: src/lib/scheduler.ts touched — OWNER MERGE REQUIRED; do not auto-merge or enqueue.
- After the owner merge: run the three receipts server-side in order (dry-run, live prune with --confirm, weekly soft-archive lane) and paste results into section 6.


## 6. Receipts (fill in live numbers)

| Step | Command | Result |
|---|---|---|
| 1. dry-run counts | `npx tsx scripts/od7-vector-prune.ts` | PENDING - paste JSON report here |
| 2. live junk delete | `npx tsx scripts/od7-vector-prune.ts --apply --confirm=prune-operational-junk` | PENDING - paste JSON report here |
| 3. weekly soft-archive | scheduler lane `soft-archive-sweep` + audit event `soft_archive_sweep` | PENDING - first-pass scanned/archived counts here |

## 7. Zero-Code Findings

- `scripts/prune-operational-index.ts` (the existing operator CLI) already covers the Form 4 XML vector class through item code 0 / "XML Document" low-value rules, which is why OD-7 adds a separate CLI only for the two provider-side classes (superseded generations, empty-ticker 13F) instead of a third planner.
- The `pinecone-wu-breaker` trial-clear lane had a side effect (lazily clearing a stale Starter WU marker); with writes on Qdrant that breaker only gates the retired Pinecone fallback, so removing the tick is safe, and any remaining read of the getter still self-clears.
