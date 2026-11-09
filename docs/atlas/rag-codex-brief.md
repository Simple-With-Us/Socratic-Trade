# Implementation brief for Codex — RAG (primary) + small alternatives

> Hand this to Codex as-is. It is scoped to this repo's conventions so the output drops in cleanly.
> **Base your branch off the latest `gh-pages`.** Some modules referenced below
> (`apps/bff/src/orders/blotter.mjs`, `apps/bff/src/alerts/store.mjs`, `apps/bff/src/brokers/test.mjs`)
> arrive via an in-flight PR; if they're not present yet, base off the branch that contains them, or
> proceed — the RAG task does not depend on them. Do **not** modify `orders/`, `brokers/`, or account
> labeling (a separate change is in flight there).

---

## Authorization & guardrails (non-negotiable)

You're working in `jaywedgeworth22/public` (app under `apps/`, `packages/`, `tests/`, `evals/`).
Work on a **new branch**; open a **draft PR**; do **not** merge.

- **Zero runtime dependencies.** Node 22 built-ins only (`node:http`, `node:crypto`, `node:fs`,
  `node:test`). No `npm install`, no packages. Must run with `node apps/bff/server.mjs` and test with
  `node --test tests/*.test.mjs`.
- **Secrets stay server-side** in the BFF; never reach `apps/web`; never commit keys. The
  secret-leakage CI gate must stay green.
- **Do not weaken the safety model:** the LLM has **no trade-execution tool**; orders stay
  draft → human-confirm. Don't touch the execution boundary, `orders/`, `brokers/`, or account labels.
- **Offline-first:** every external dependency (embeddings, LLM, market data) has a deterministic
  **mock default** with an **injectable transport**, so the full suite runs with no network/keys.
  Real providers are opt-in behind env vars.
- **Keep `node --test tests/*.test.mjs` and `node evals/run.mjs` green.** Add tests for new code.
  Match style: ESM `.mjs`, 2-space indent, small modules, `dump()/restore()/_reset()` on any store,
  and register new stores in `apps/bff/src/persistence/index.mjs`.
- Read first and follow: `docs/deep-dives/07-databases-and-rag.md`, `09-prompting-and-llm.md`,
  `08-cache-embeddings-memory.md`.

## Repo orientation

- **BFF** `apps/bff/server.mjs` — zero-dep HTTP server: routes + static-serves `apps/web`. Add
  `/api/...` routes here.
- **Orchestrator** `apps/bff/src/orchestrator.mjs` — per turn: memory write → context assembly →
  `llm.run({system,message,tools,executeTool,context})` → `{text, draft, citations, used_memories, intent}`.
- **LLM** `apps/bff/src/llm/client.mjs` — `MockLLM` (offline, intent-routed via `classifyIntent`) +
  `AnthropicLLM` (real tool loop, injectable `transport`). Contract:
  `run(...) -> { text, toolCalls:[{name,input,result}], citations }`. System prompt in
  `src/llm/prompt.mjs` already enforces grounding (answer only from tool results; cite; otherwise
  "I don't have data on that").
- **Tools** `apps/bff/src/tools/index.mjs` — registry of
  `{ description, input_schema, readOnly, execute(input,{userId,marketData}) }`. Existing: `get_quote`,
  `draft_order`, `create_alert`. The orchestrator auto-exposes these and runs them via `executeTool`.
- **Store pattern**: a module with a `Map`, CRUD fns, and `dump()/restore()/_reset()`, registered in
  `apps/bff/src/persistence/index.mjs` `stores` map (file snapshots when `STORE=file`). See
  `memory/store.mjs`, `alerts/store.mjs`.
- **Tests** `tests/*.test.mjs` (node:test). **Eval gate** `evals/golden.mjs` + `node evals/run.mjs`.
- **Provider factories** mirror `getLLM()` / `getMarketDataProvider(config)` — do the same for embeddings.

---

## TASK A (primary): RAG over a document knowledge base

**Goal:** the assistant answers questions from ingested documents (filings/news/notes) with
**citations**, grounded only in retrieved chunks. Offline-first; pgvector + real embeddings are
documented swap points (Deep Dive 7).

### Build

1. **Embeddings** `apps/bff/src/rag/embeddings.mjs`
   - Interface `embed(text) -> number[]` (fixed dim, e.g. 256), L2-normalized.
   - **`MockEmbeddings` (default):** deterministic zero-dep — hashed token uni/bi-grams → feature
     vector, normalized. Same text ⇒ same vector; similar finance text scores higher.
   - **Real provider** stub (e.g. **Voyage AI**, which Anthropic recommends) via `fetch` behind
     `EMBEDDINGS=voyage` + `VOYAGE_API_KEY`, **injectable transport** for tests. Pin `model`+`dim` on
     every stored vector; never mix vector spaces.
   - `getEmbeddings(config, {transport})` factory.

2. **Chunking** `apps/bff/src/rag/chunk.mjs`
   - `chunkDocument(doc) -> chunks[]`: split by heading/paragraph to a token budget (~300–600, ~12%
     overlap); keep tables atomic; prepend a short `context_header` (ticker/doc_type/section) before
     embedding (contextual retrieval, §7.2.3). Each chunk:
     `{doc_id, chunk_id, text, context_header, ticker[], doc_type, section, published_at, acceptance_datetime, source, url}`.

3. **Vector store** `apps/bff/src/rag/store.mjs`
   - In-memory `Map` of chunks + vectors. `upsertChunks`, `deleteDoc`, `listDocs`.
   - **Hybrid `search(query,{filter,k}) -> chunks[]`:** dense cosine **+** lexical (token-overlap /
     BM25-lite) fused with **Reciprocal Rank Fusion** (k=60). **Metadata pre-filter** (`ticker`,
     `doc_type`, point-in-time `as_of <= acceptance_datetime`) applied **before** ranking. Return
     top-k (~5) with scores. `dump()/restore()/_reset()`; register in persistence.

4. **Ingestion + API** (routes in `server.mjs`)
   - `POST /api/kb/ingest` `{doc_id?, title, text, ticker?, doc_type?, source?, url?, published_at?}`
     → chunk → embed → upsert; returns `{doc_id, chunks}`.
   - `GET /api/kb/docs`, `DELETE /api/kb {doc_id}`, `GET /api/kb/search?q=&ticker=` (debug).
   - Seed a tiny corpus `apps/bff/src/rag/seed/*.md` (2–3 fake filings/news) loaded on first run.

5. **`kb_search` tool** in `tools/index.mjs` (read-only) — input `{query, ticker?, doc_type?, k?}`;
   returns chunks (`text` + `source`/`as_of`/`chunk_id`). Add a `kb`/`research` intent in
   `classifyIntent` so "what did AAPL's last 10-K say about risks?" routes to `kb_search`; the model
   narrates **only** from returned chunks; orchestrator emits `citations` `[{source, chunk_id, as_of}]`.
   Empty retrieval → the existing "I don't have data on that" refusal.

6. **UI** `apps/web` — minimal "Knowledge" panel: textarea + "Ingest" button (`/api/kb/ingest`), a
   doc list with delete. Chat already renders citations.

7. **Tests** `tests/rag.test.mjs` — embedding determinism; chunking (split + overlap + atomic table);
   point-in-time pre-filter (excludes docs whose `acceptance_datetime` is after the as-of); RRF ranks
   an exact lexical (ticker/number) match above a fuzzy one; `kb_search` recall on a 5–10 query gold
   set; orchestrator answer **cites a source** and **refuses** when the KB is empty. Add 1–2 golden
   cases to `evals/golden.mjs` (KB question cites; out-of-KB question refuses).

### Acceptance
All tests + `node evals/run.mjs` green; runs fully offline (`EMBEDDINGS=mock`, `LLM=mock`);
`.env.example` + `MILESTONES.md` updated; the pgvector swap (replace `rag/store.mjs` internals;
interface unchanged) documented.

---

## TASK B (small alternative): Watchlist
Per-user watchlist that pairs with alerts. `apps/bff/src/watchlist/store.mjs` (`add/remove/list`,
`dump/restore/_reset`, persisted); `GET/POST/DELETE /api/watchlist`; a `watchlist_add` tool ("add NVDA
to my watchlist"); a Watchlist panel in `apps/web` showing live quotes (reuse `get_quote`) with a
one-click "set alert". Tests: CRUD, NL add via orchestrator, dedupe/canonical ticker. ~½ day.

## TASK C (small alternative): Conversation history persistence
Persist chat turns per user so the console reloads prior conversation. `apps/bff/src/history/store.mjs`
(append turn, `listTurns(userId, limit)`, `dump/restore/_reset`, persisted, length cap); orchestrator
appends each turn; `GET /api/history?userId=`; `apps/web` loads on boot. Tests: append/list/cap,
survives save→reset→load. Respect the PII rules from Deep Dive 12 (don't persist secrets). ~½ day.

---

## Definition of done (all tasks)
- `node --test tests/*.test.mjs` and `node evals/run.mjs` green; new tests cover new code.
- Zero new dependencies; offline by default; real providers behind env + injectable transport.
- New stores registered in `apps/bff/src/persistence/index.mjs`; `.env.example` + `MILESTONES.md` updated.
- Draft PR opened (not merged); no secrets committed; leakage gate green.
- Untouched: execution boundary, `brokers/`, `orders/`, account labeling.
