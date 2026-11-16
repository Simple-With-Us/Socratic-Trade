# 2026-07-20 — Corpus re-embed scoped-run purge gate

## Summary

Fixed a critical RAG data-loss path in `src/lib/rag/corpus-reembed.ts`: symbol-scoped re-embed
runs no longer persist a full-docType `completedForEmbedRevision` stamp. The explicit
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

- `src/lib/rag/corpus-reembed.ts` — withhold full-corpus completion stamps when `symbols` scopes
  the run.
- `test/corpus-reembed.test.ts` — regression: scoped completion does not authorize
  `purge-legacy`.
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

The focused regression is included in `test/corpus-reembed.test.ts` and was exercised by the full
Vitest suite.

## Follow-ups

- Do not run production `purge-legacy` until this fix is live and an unscoped full-corpus
  re-embed has independently completed for the covered docTypes.
- If a prior symbol-scoped run already poisoned progress state, run the fixed scoped path again
  or, preferably, the full unscoped re-embed before considering purge. The fixed scoped write
  replaces the docType progress without `completedForEmbedRevision`.
