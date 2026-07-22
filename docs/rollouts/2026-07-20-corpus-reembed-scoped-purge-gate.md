# 2026-07-20 — Corpus re-embed scoped-run purge gate

## Summary

Fixed a critical RAG data-loss path in `src/lib/rag/corpus-reembed.ts`: symbol-scoped re-embed
runs now persist in a separate scope-keyed progress map, never overwrite full-corpus watermarks or
`completedForEmbedRevision`, and every cursor is bound to its embedding revision. The explicit
`purge-legacy` action therefore stays blocked until an unscoped docType run completes under the
current embedding revision.

## Why

`purge-legacy` deletes every old-space vector for a docType by source receipt. Before this change,
a run like:

```json
{ "docTypes": ["sec-filings"], "symbols": ["AAPL"] }
```

could exhaust the scoped candidate set, mark `sec-filings` complete for the current bge-m3 revision,
and let a later:

```json
{ "action": "purge-legacy", "confirm": "purge-voyage-vectors", "docTypes": ["sec-filings"] }
```

delete all legacy SEC vectors, including symbols that had never been re-embedded. With prod's
corpus re-embed known incomplete, that would turn a targeted repair/testing run into broad RAG
data loss.

## Files

- `src/lib/rag/corpus-reembed.ts` — isolate scoped/full cursors and bind watermarks to the active
  embedding revision.
- `test/corpus-reembed.test.ts` — regressions for purge refusal, scoped-to-full watermark isolation,
  and preservation of prior valid full completion proof.
- `STATUS.md` — current state and validation note.
- `PLAN.md` — active plan item for the narrow purge-gate fix.
- `docs/EFFORT-LOG.md` — Cursor effort row.
- `docs/phase-9-web-sources.md` — durable RAG purge-safety invariant.
- `docs/rollouts/2026-07-20-corpus-reembed-scoped-purge-gate.md` — this receipt.

## Verification

First pass:

```bash
npm run lint        # failed before dependencies were installed: sh: 1: eslint: not found
npm install         # installed dependencies; npm reported existing audit warnings
npm run lint        # passed (existing warning backlog only)
npx tsc --noEmit    # failed: src/lib/rag/corpus-reembed.ts 'symbols' is possibly undefined
```

The TypeScript finding was fixed by using `Boolean(symbols?.length)` for scoped-run detection.

Planned ordered gate:

```bash
npm run lint        # passed (existing warning backlog only)
npx tsc --noEmit    # passed
npm test            # passed: 420 files / 4,901 tests
npm run build       # passed; existing middleware/proxy and Sentry Edge warnings only
```

Review remediation adds focused proof that a scoped watermark cannot skip earlier rows in a later
full run and that scoped maintenance cannot erase an existing valid full-corpus completion stamp.
`npx vitest run test/corpus-reembed.test.ts` passed all 10 tests in the isolated review worktree;
`npx tsc --noEmit` passed, and
`npx eslint src/lib/rag/corpus-reembed.ts test/corpus-reembed.test.ts` passed with no errors (one
pre-existing unused-parameter warning in the test mock).

## Follow-ups

- Do not run production `purge-legacy` until this fix is live and an unscoped full-corpus
  re-embed has independently completed for the covered docTypes.
- If a prior symbol-scoped run already poisoned the legacy shared progress state, run a full
  unscoped re-embed after this fix. Legacy partial progress without an embedding revision restarts
  conservatively; new scoped progress cannot mutate the full-corpus proof.
- Hold the local closeout behind PR #1857. Once released, push it to PR #1840's existing head,
  resolve the two review threads, obtain fresh required checks, merge, and verify the exact
  auto-deployed production SHA before any production corpus operation.
