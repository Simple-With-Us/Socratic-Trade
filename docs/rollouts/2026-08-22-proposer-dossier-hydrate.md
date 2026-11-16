# 2026-08-22 PR B: money-path hydrate + moveable corpus root

## Context & Objective

PR A (split writer) is on main.  PR B was the flip gate: Green/Red still cosine-first into 8/1 + 24k, but they must be able to recover parent/1A from local FTS/artifacts without EDGAR.  This change lands `hydrateAccession`, `assembleProposerDossier`, and a bind-mountable `data/corpus` root.  It does **not** flip `RAG_PINECONE_WRITE_CLASS`, prune, re-embed, or bounce prod.

## Changes Made

- New `src/lib/rag/corpus-layout.ts`: `CORPUS_DIR` or `DATA_DIR/corpus` with kinds `sec`, `roic`, `eight-k`, `form4`, `thirteen-f`, `ark`, `transcripts`, `experience`.  Reads try the new path then legacy `data/sec-artifacts` / `data/roic-artifacts`.  Writes go to the corpus subdir.
- `src/lib/web-sources/sec-filings.ts` and `src/lib/roic-archive-artifacts.ts` wired through that layout.  8-K has no filesystem path helper (SQLite `sec_artifacts.raw_uri` only) so it was left alone.
- New `src/lib/rag/hydrate-accession.ts`: local-only, 150ms fail-open, no network.  Order: `chunks.json` -> sections artifact -> FTS on the bare SEC accession -> `earningscalls_transcripts` / ROIC sidecar.
- New `src/lib/rag/proposer-dossier.ts`: scout stub 1,200 chars, latest-per-type abstracts, suppress twin compact vectors, hydrate winning hits.  `RAG_PROPOSER_DOSSIER` defaults ON (`envFlagOn(..., true)`).
- `src/lib/strategy.ts` filings retrieve: flag on -> `assembleProposerDossier` then the existing 24k family budget.  Flag off -> the previous `retrieveContextDetailed` loop.  Episodic/experience retrieve is unchanged.
- `document-summarizer` highlight ids use real `content_hash` when source chunks or sectioned text is known.  `formatChunkWithProvenance` prints a bare SEC accession from metadata when present.
- EarningsCalls ingest skips `storeDocument(row.content)` when write-class is not `full-body`.  Default remains `full-body`, so this is inert until the Infisical flip.

## Decisions & Trade-offs

- Hydrate never imports `sec-filings` fetch.  HTML artifacts are not dumped into the prompt; `chunks.json` / sections.json / FTS are the recovery path.
- 8-K bodies still have no on-disk helper.  A later bind-mount can grow `corpus/eight-k` without a producer change this week.
- EarningsCalls honor write-class by skipping the full-body upsert only.  Signal-section documents for that producer are still a later flip item (ROIC already writes them).

## Verification State

Focused vitest (no `land.sh`, no full build):

```
npx vitest run test/corpus-layout.test.ts test/hydrate-accession.test.ts test/proposer-dossier.test.ts test/document-summarizer.test.ts test/vector-db-provenance.test.ts test/strategy-rag-quickwins-wiring.test.ts
```

## Next Steps & Blockers

Still missing for a later write-class flip (do not do these here):

1. Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal` only after this PR is on main and hydrate is proven in a live run.
2. EarningsCalls `storeSignalSectionDocuments` + transcript FTS mirror so the high-interest full-call exception can retire.
3. 8-K filesystem sidecar under `corpus/eight-k` if we want hydrate from HTML without FTS.
4. Receipt-gated prune (`--apply`) after FTS counts match.  Dry-run only until then.
5. `corpus-reembed` already honors write-class on main; do not run it this week.

## Zero-Code Findings

None.  This is the PR B implementation.
