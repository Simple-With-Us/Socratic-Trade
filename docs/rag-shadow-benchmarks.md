# RAG Shadow Benchmarks: Turso/libSQL and Pinecone Assistant

`npm run eval:rag-shadow-benchmarks` is a read-only capability/context probe. It is
not part of production retrieval, ingestion, migration, or re-embedding.

## Safety boundary

- The Turso/libSQL portion opens only an in-memory local SQLite probe. It
  reports whether this checkout has `@libsql/client` and the Turso vector SQL
  functions (`vector32`, `vector_distance_cos`). It never opens a Turso URL.
- The Pinecone portion is disabled unless `RAG_SHADOW_BENCHMARK_LIVE=1` (also
  accepts `true`, `on`, or `yes`), `PINECONE_ASSISTANT_NAME`, and
  `PINECONE_API_KEY` are supplied.
- It calls only `Assistant.context` against that pre-existing named Assistant.
  It never creates/describes/updates/deletes Assistants, files, operations,
  indexes, vectors, or corpus data, and does not use generation/chat.
- It runs serially, caps calls at 100, clamps per-call timeout to 30 seconds,
  aborts the underlying HTTP request at the deadline, and requests text-only
  context (`topK: 16`, 512-token snippets).
- JSON receipts retain only frozen case IDs, elapsed time, counts, token usage,
  and SHA-256-truncated provider-file fingerprints. They never print or write
  prompt text, snippets, answers, file names, raw provider errors, or keys.

## Run

Provide an external, ephemeral JSON array of frozen evaluation cases:

```json
[{"id":"stable-case-id","query":"evaluation query"}]
```

The script will make no Assistant call unless all live conditions are met:

```bash
RAG_SHADOW_CASES_PATH=/secure/eval-cases.json \
RAG_SHADOW_BENCHMARK_LIVE=1 \
PINECONE_ASSISTANT_NAME=existing-assistant \
PINECONE_API_KEY=... \
npm run eval:rag-shadow-benchmarks
```

Keep case material out of the repository and command output. The harness reads
it into memory only. Without the live gate, it emits a `live_gate_off` receipt
and still performs the local Turso capability inspection.

## Interpretation

An `unsupported` Turso result means only that this checkout lacks an installed
libSQL client or the local vector functions needed for a meaningful benchmark;
it is not a claim about a remote Turso database. Add a dev-only benchmark
adapter only after a measured decision to run the shadow test; do not add it to
the production runtime by default.

Pinecone Assistant is useful as a managed contextual-retrieval probe and
for a scoped "ask this filing" workflow. It is not a replacement for the
app-owned evidence ledger until it can meet the required immutable filing/PIT,
exact prompt-consumption, and tenant-erasure receipts under our real corpus.
Citation counts and hashed file IDs alone do not measure relevance; provider
selection requires a frozen-golden mapping against the same approved corpus.
