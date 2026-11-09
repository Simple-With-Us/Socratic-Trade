# Rollout Note - 2026-07-13 - Codex Autofix: RAG Backfill P0 (PR #1495)

## Summary
Addressed 3 of 4 P2 Codex review findings from `chatgpt-codex-connector[bot]` on PR #1495 (`agent/ag-rag-backfill-p0`). The 4th item (ticker aliases for shared-CIK issuers) is architecturally significant and was left open with a maintainer question.

## Changes

### 1. Stripped `"held-history"` provenance from frozen manifest
- **Generator** (`scripts/eval/generate-universe-manifest.ts`): Changed the DB-history tranche's `inclusionReason` from `"held-history"` to `"top-prominence"` so the frozen manifest never leaks which symbols come from the owner's real trade/watch history.
- **Frozen manifest** (`data/rag-universe-manifest.json`): Replaced all 170 occurrences of `"held-history"` with `"top-prominence"`.

### 2. Excluded 8-K body accessions from missing-chunks parity check
- **Census script** (`scripts/eval/rag-census.ts`): Added a `NON_ACCESSION_BEARING_DOC_TYPES` set (starting with `"8-K-body"`) that skips the missing-chunks substring check for doc types whose chunk_ids do not embed the accession. `ingestEightKBody` passes no `doc_id` to `storeDocument`, so chunks get UUID-based IDs and the `chunk_id.includes(accession)` check would always false-flag them.

### 3. Replaced quadratic nested scans with Set-based O(1) lookups
- **Census script** (`scripts/eval/rag-census.ts`): The parity check was `O(N*M + M*N)` with two nested loops scanning the full `accessions` and `chunks` arrays. Now builds `accessionSet` and `accessionInChunkIds` upfront as `Set`s, making both checks `O(N+M)`.

### 4. Left open: shared-CIK ticker alias handling
- The Codex finding about GOOG/GOOGL-style ticker aliases for shared CIKs is architecturally significant — a PR comment asking the maintainer how to handle it was posted. The thread stays unresolved pending guidance.

## Files Touched
- `scripts/eval/rag-census.ts`
- `scripts/eval/generate-universe-manifest.ts`
- `data/rag-universe-manifest.json`
- `STATUS.md`

## Verification
- `npx tsc --noEmit`: clean
- `npm test`: 350 files / 3927 tests passed
- `npm run build`: clean
