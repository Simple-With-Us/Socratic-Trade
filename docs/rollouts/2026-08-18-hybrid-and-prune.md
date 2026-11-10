# 2026-08-18 — Hybrid AND prune (processed operational index)

## Context & Objective

Owner cut after the #2811 store-vs-condense audit: condense-first for the Pinecone operational index, store-more locally, then prune junk so Green/Red retrieve (scout k=1 / deep k=8 + 24k filings budget) actually sees useful vectors.  This lands the minimum corpus-storage PR A split so processed writes can complete without flipping `RAG_PINECONE_WRITE_CLASS`, plus a receipt-safe prune of junk / raw-HTML / duplicates / low-value.  Full-body useful vectors that are the only copy stay.

## Changes Made

- New `pineconeWriteClass()` reader defaults to `full-body`.  Producers honor `highlight+signal` when set; the env is not flipped.
- `persistLocalComplete` writes full FTS on the bare SEC accession (and ledgers when write-class is not full-body) without requiring a body `storeDocument`.
- `selectSignalChunks` is form-aware and parses `itemCode` from `{code}. {title}`.  Transcripts keep management + first 8 qa/analyst turns.  Item 8 stays local.
- SEC ingest and ROIC write extractive highlights plus those signal / speaker-turn slices as their own complete `storeDocument`s.  Full-body 10-K/Q upserts still run while write-class is `full-body`.
- Worker embed text prefers parsed section text over raw HTML.
- `corpus-reembed` treats a highlight+signal commit as accession coverage so leftover FTS body rows are not re-uploaded.
- `ingested_accessions` gains `pinecone_write_class` + `pinecone_vector_count` (migration 84).  The migration no-ops when that table is absent so legacy hardening DBs can still apply later versions.
- Safe prune planner + `npx tsx scripts/prune-operational-index.ts` (dry-run default; live delete needs `--apply --confirm=prune-operational-junk`).
- Signal-section writes now carry the shared RAG lease guard.  Filing tests route mocks by document class so processed abstracts/sections cannot consume the full-body receipt.

Touched files:

- `src/lib/rag/pinecone-write-class.ts`
- `src/lib/rag/persist-local-complete.ts`
- `src/lib/rag/processed-corpus-write.ts`
- `src/lib/rag/operational-index-prune.ts`
- `src/lib/rag/corpus-reembed.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/db.ts`
- `src/lib/db-learning.ts`
- `scripts/prune-operational-index.ts`
- `test/pinecone-write-class.test.ts`
- `test/operational-index-prune.test.ts`
- `test/sec-filings.test.ts`
- `test/persistence-hardening.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-7-strategy.md`
- `docs/designs/2026-08-16-proposer-corpus-storage.md`
- `docs/rollouts/2026-08-18-hybrid-and-prune.md`

## Decisions & Trade-offs

- Did **not** flip `RAG_PINECONE_WRITE_CLASS`.  PR B (money-path hydrate) is still required before that Infisical set.
- Did **not** start a Pass C full-body 10-K wave.  Remaining trial WU should go to latest-first processed breadth.
- Kept the 2.5M configured fuse and $45 reserve.  Unused retrieval is still the #2800 remainder deadlock, not this knob.
- Prune is junk-class only.  Useful full-body pages are kept when they are the only copy (no local FTS/artifact/abstract and no other useful vector for that accession).  Raw HTML is still deleted — it is not a useful copy.
- Experience-memory / lesson / coach-note stay do-not-touch.
- Did not rewrite #2800, #2792, #2798, or #2794.
- No Stripe.  No FilingAPI Plus.

## Verification State

```
npm run lint                          # exit 0
npx tsc --noEmit                      # clean
npx vitest run test/sec-filings.test.ts test/pinecone-write-class.test.ts test/operational-index-prune.test.ts
                                      # 60/60 pass
SILICONFLOW_API_KEY= OPENROUTER_API_KEY= npx vitest run \
  test/sec-ingest-worker.test.ts test/sec8k-full-body.test.ts \
  test/pinecone-wu-breaker.test.ts test/corpus-reembed.test.ts
                                      # 64/64 pass
```

`npm run build` — exit 0.

Full `npm test` on this cloud VM still hits live-key noise (TwelveData / Massive / health / monitor).  Isolated RAG + migration files pass.  CI `verify` is the merge gate.

## Next Steps & Blockers

- Land #2800 if writes are still remainder-deadlocked (do not raise the 2.5M fuse).
- PR B: local-only `hydrateAccession` + `assembleProposerDossier`.  Then the operator may flip `RAG_PINECONE_WRITE_CLASS=highlight+signal`.
- Dry-run the prune against production local inventory before `--apply`.
- Transcript FTS mirror is still the gate for dropping the high-interest latest-full-call exception.

## Zero-Code Findings

None.  This is the implementation PR for the #2811 hybrid cut.
