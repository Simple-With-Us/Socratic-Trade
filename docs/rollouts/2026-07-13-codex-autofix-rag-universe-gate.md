# Codex Autofix: RAG Universe Gate — PR #1543

## Summary
Addressed all 11 Codex review findings across three review rounds on PR #1543 (`codex/sec-rag-program`):
1. **P1 — Freeze expected task count** (`src/lib/db-rag-ingest.ts`): `sealSecIngestJobIntake` now refuses to overwrite a non-null `job.expected_tasks` with a mismatched caller-supplied count, preventing a partial corpus from being sealed under a different contract.
2. **P2 — Reject impossible receipt dates** (`src/lib/rag/universe-manifest.ts`): `validDate()` now round-trips parsed calendar components to reject impossible dates (e.g. Feb 31) that `Date.parse` silently normalizes.
3. **P2 — Validate quarantined issuer entries** (`src/lib/rag/universe-manifest.ts`): `validateSecUniverseManifest` now shape-checks each quarantined entry (reason required non-empty, ticker/cik are non-empty when present).
4. **P2 — Preserve valid offset timestamps** (`src/lib/rag/universe-manifest.ts`): calendar validation now checks the original offset-local components instead of comparing them to a UTC date that may cross midnight.
5. **P2 — Normalize quarantined identities** (`src/lib/rag/universe-manifest.ts`): optional ticker/CIK values must satisfy the same uppercase ticker and 10-digit CIK contracts as included issuers.
6. **P2 — Validate artifact checksums** (`src/lib/db-rag-ingest.ts`): raw and normalized hashes must be 64-character lowercase SHA-256 before a task can advance.
7. **P2 — Reject blank terminal reasons** (`src/lib/db-rag-ingest.ts`): terminal status transitions now require and persist trimmed, non-empty reason fields.
8. **P2 — Preserve immutable task identity** (`src/lib/db-rag-ingest.ts`): stage advancement can verify, but never overwrite, parser/chunker/embedding revisions frozen at enqueue.
9. **P2 — Keep checkpoint receipts authoritative** (`src/lib/db-rag-ingest.ts`): caller receipt metadata can no longer override the actual next checkpoint.
10. **P2 — Replay sealed discovered-count jobs** (`src/lib/db-rag-ingest.ts`): omitting `expectedTasks` on replay is compatible with the count frozen during intake; explicit mismatches still fail.
11. **P2 — Sanitize retry bounds** (`src/lib/db-rag-ingest.ts`): NaN/infinite/extreme retry inputs now fall back or clamp to finite, date-safe delays.

## Files touched
- `src/lib/db-rag-ingest.ts` — freezes expected task counts, validates artifact hashes, and requires terminal reasons
- `src/lib/rag/universe-manifest.ts` — validates original calendar components and normalized quarantine identities
- `test/rag-ingest-worker.test.ts` — locks task-count, checksum, terminal-reason, identity, receipt, replay, and retry regressions
- `test/rag-universe-manifest.test.ts` — covers impossible/offset dates and malformed/unnormalized quarantine rows

## Verification
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`: 0 errors / 448 inherited warnings
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`: clean
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`: 352 files / 3,953 tests passed
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build`: clean; known non-fatal Tailwind prose-scan warning recorded separately
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-ingest-worker.test.ts test/rag-universe-manifest.test.ts`: 2 files / 26 tests passed after all three review rounds
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint test/rag-ingest-worker.test.ts test/rag-universe-manifest.test.ts`: 0 errors
- `git diff --check`: clean
- Second full gate after review round 2: lint 0 errors / 448 inherited warnings; TypeScript clean; 352 files / 3,957 tests; production build clean with only the same known non-fatal Tailwind prose-scan warning
- Final full gate after review round 3: lint 0 errors / 448 inherited warnings; TypeScript clean; 352 files / 3,960 tests; production build clean with only the same known non-fatal Tailwind prose-scan warning
- Post-`origin/main` merge gate: lint 0 errors / 452 inherited warnings; TypeScript clean; 352 files / 3,960 tests; production build clean with only the same known non-fatal Tailwind prose-scan warning

## Follow-ups
- All 11 Codex findings are addressed and regression-covered. Auto-merge remains enabled; refreshed hosted checks, review-thread triage, and merge/deploy verification remain.
