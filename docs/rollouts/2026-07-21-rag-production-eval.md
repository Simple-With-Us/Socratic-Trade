# 2026-07-21 - Production-path RAG evaluation framework

## Summary

Added `npm run eval:rag-production` with required frozen JSON cases for evaluating the production
`retrieveContextDetailedWithStatus` path. It does not use the evaluation-only FTS fusion helper or
claim a production schema-migration number.

## Why

The previous harness measured `retrieveFusedContext`, while strategy retrieval uses the Pinecone/RAG production
path. Model selection requires real vector ids, authoritative point-in-time query timestamps, and receipts that
make relevance, leakage, duplicates, coverage, latency, status, and spend observable together.

## Design

- Golden cases are required frozen, version-controlled JSON (`--input cases.json`). This keeps the
  comparison set identical across model runs and avoids colliding with active migrations 55/56 on
  other open branches.
- Every case requires `authoritativeAsOf` and non-empty `expectedEvidenceRefs`. Each reference must carry
  either a content hash or an accession plus section/ordinal; source is only a qualifier. All supplied
  selectors must match.
  A vector id can be retained only as an optional diagnostic: it never establishes relevance, so re-embedding or an index
  rebuild cannot alter the ground truth.
- The CLI requires `--allow-live` before it imports and calls `retrieveContextDetailedWithStatus`. It performs
  retrieval reads only; it never writes embeddings or vectors. Native retrieval metering/audit receipts may still
  be emitted by the production function and are reported best-effort.
- The free-form `--profile` label does not alter runtime. Provider/model/index, credential-source,
  provider-authority, and ledger-authority fields are resolved from the actual production route after
  retrieval, so a comparison cannot be mislabeled by CLI model strings.
- Runs force strict point-in-time retrieval, report server-filter state, and fail the CLI on any future
  or undated result unless `--allow-pit-violations` is explicitly used for diagnosis.
- Case count and retrieval depth are hard-capped at 100. A generated `rag-eval:*` user isolates normal
  runs, and usage reads are bounded by both start and end timestamps.

## Files

- `scripts/eval/rag-production-eval.ts` - CLI, loaders, production adapter, machine-readable report/scoring.
- `test/rag-production-eval.test.ts` - hermetic evaluator mechanics.
- `package.json` - `eval:rag-production` script.
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/chat-assistant-rag-learning.md` - state and operating guidance.

## Verification

```bash
node node_modules/vitest/vitest.mjs run test/rag-production-eval.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Focused tests passed, TypeScript passed, and diff check passed. No live provider, Pinecone, corpus, or
production calls were made.

## Follow-ups

1. Curate source-anchored EDGAR cases with stable provenance; do not treat synthetic fixtures as model evidence.
2. Run each candidate embedding/reranker configuration as a separately labeled, read-only shadow run and compare
   the emitted JSON receipts.
3. Do not override the generated evaluation user with an active production user unless shared traffic in
   that bounded window is intentionally part of the receipt.
4. The evaluator refuses an empty golden set rather than emitting misleading all-zero quality metrics.

## Follow-up - Pinecone hosted inference candidate

`npm run eval:pinecone-inference -- --allow-live --input cases.json` is a separate frozen-pool benchmark for
Pinecone's standalone hosted `/embed` and `/rerank` APIs. It defaults to `llama-text-embed-v2` and
`bge-reranker-v2-m3`, accepts repeatable arbitrary `--embed-model`/`--rerank-model` values (including
account-exposed Cohere), and can list `/models` only when `--inventory` is selected. Every network path is gated
by `--allow-live`; the provider key is resolved without printing it. The script never creates, queries, or writes
an index/namespace/corpus, and its persisted JSON report excludes candidate text.

The default bounds are 25 cases and 50 candidates/case. Hard CLI caps refuse runs above 100 cases, 100
candidates/case, or 100 ranked results, and more than 10 distinct models of either kind. An empty golden set is
also refused. Rerank requests omit model-specific `parameters`, so Cohere and other account-exposed models use
their own defaults. Every report carries locally counted requests plus provider `usage.total_tokens` for embedding
and `usage.rerank_units` when supplied; dollar prices are deliberately not baked in. Run the inventory first, then
compare each candidate model under a distinct output file rather than treating public model-gallery availability
as account availability.
