# SEC/RAG foundation post-merge durability follow-up

## Summary

PR #1543 merged as `cbe3e532` after all required local and hosted checks passed. Three Codex P2 findings arrived
after merge, so this follow-up preserves failure, checksum, and lease invariants in the durable ingest state.

## Why

- Blank provider error fields could produce unauditable dead-letter receipts.
- Later checkpoints could overwrite already-recorded artifact hashes with different valid SHA-256 values.
- NaN or infinite lease configuration could reach `Date#toISOString()` and stop claims/heartbeats.

## Files

- `src/lib/db-rag-ingest.ts`
- `test/rag-ingest-worker.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-sec-rag-foundation-postmerge.md`

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-ingest-manifest.test.ts test/rag-ingest-worker.test.ts`
  - 2 files / 29 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/db-rag-ingest.ts test/rag-ingest-worker.test.ts`
  - 0 errors.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`
  - 0 errors / 452 inherited warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
  - passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`
  - 352 files / 3,963 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build`
  - passed.
- `git diff --check`
  - passed.
- `https://socratictrade.com/api/health`
  - production reported exact foundation release `cbe3e532`; database, scheduler, storage, and Litestream were
    healthy. Alpha Vantage remained at its pre-existing noncritical quota degradation.

## Follow-ups

- Monitor ready PR #1559 through hosted acceptance, merge, and exact auto-deploy/live SHA verification.
- Keep all provider, object-store, vector, and corpus writes disabled until the broader SEC/RAG gates pass.
