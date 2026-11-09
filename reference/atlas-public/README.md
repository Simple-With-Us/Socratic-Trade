# Atlas — AI Trading / Financial Assistant

An AI-powered trading & financial-assistant, built per the [multi-expert analysis](docs/multi-expert-app-analysis.md) and [implementation plan](docs/deep-dives/11-implementation.md).

> **Informational only — not personalized financial advice. The assistant can only _draft_ orders; a human confirms every one. Paper trading only; no live routing.**

## Quick start

Zero dependencies — Node 18+ only (built with Node 22):

```bash
node apps/bff/server.mjs       # → http://localhost:8787  (serves the web console + API)
node --test tests/*.test.mjs   # run the test suite
```

It runs fully offline with a **mock LLM** and **mock market data**, on the **Test (local) account** — a fake, app-simulated account (it is *not* "paper trading" of any real broker). To use the real model, set `LLM=anthropic` and `ANTHROPIC_API_KEY` (server-side only). See [`.env.example`](.env.example).

The knowledge-base RAG path also runs offline by default with deterministic mock embeddings. Set `EMBEDDINGS=voyage` and `VOYAGE_API_KEY` only when you want the server-side Voyage embedding provider.

## Accounts (Test/local vs. real brokers)

- **Test (local)** — always available, explicitly fake: the app owns the ledger and picks the starting buying power *because it's simulated*. Not a real broker; not "paper of" anything.
- **Alpaca Paper / Alpaca Live** — *connected* accounts (provide API keys via `POST /api/accounts/connect` or `ALPACA_*` env). Buying power, positions, and fills come **from Alpaca**, not from this app. "Paper" is one connected Alpaca account, not a global mode and not an always-available equivalent to live.

Orders route to the user's **active account**'s broker. Routing to a connected **Live** account additionally requires `ALLOW_LIVE_TRADING=true`. The execution boundary (human-confirmed, server-issued `draft_id`) is identical across all brokers.

## Architecture (the BFF is the security boundary)

```
Browser (no secrets)  ──HTTPS──►  BFF (apps/bff)  ──►  LLM / market-data / (future) broker
   apps/web                        - holds all secrets
   chat · quote · draft-card       - mediates LLM calls + tool execution
                                    - owns the human-confirmed execution boundary
```

- `apps/web` — dark-first console (chat, quote, draft-order cards, "what I remember" panel). No secrets, ever.
- `apps/bff` — zero-dependency Node server:
  - `src/orchestrator.mjs` — per-turn flow: memory write → context assembly → bounded tool loop → guardrailed reply.
  - `src/memory/` — the **salience-gated write policy** + reconcile-on-write store (Deep Dive 12).
  - `src/history/` — per-user conversation transcript for UI reload, capped and redacted before persistence.
  - `src/watchlist/` — per-user symbol watchlist with canonicalized/deduped tickers and file persistence.
  - `src/rag/` — document chunking, deterministic embeddings, and a hybrid dense+lexical KB store. The store interface (`upsertChunks`, `search`, `dump`/`restore`) is the pgvector swap point: replace the in-memory internals with DB-backed chunk/vector rows while preserving BFF/tool call sites.
  - `src/orders/registry.mjs` — draft registry, deterministic pre-trade risk checks, **human-confirmed paper execution**.
  - `src/tools/` — read-only `get_quote` + draft-only `draft_order`. **No execution tool exists.**
  - `src/llm/` — `MockLLM` (offline, tool-loop-shaped) + optional real `AnthropicLLM`.
  - `src/providers/` — `MarketDataProvider` (mock; real providers drop in behind the interface).
  - `src/audit.mjs` — append-only audit log.
- `packages/shared` — provider-neutral types + a tiny JSON-schema validator + canonicalization helpers.

## Knowledge base / RAG

- `POST /api/kb/ingest` — ingests `{title,text,ticker?,doc_type?,source?,url?,published_at?,acceptance_datetime?}` into cited chunks.
- `GET /api/kb/docs` / `DELETE /api/kb` — list and delete indexed docs.
- `GET /api/kb/search?q=&ticker=&doc_type=&as_of=` — debug hybrid retrieval. `as_of` filters out chunks whose `acceptance_datetime` was not yet public.
- `kb_search` is read-only and available to the LLM for filing/news/note questions. Empty retrieval returns an explicit "I don't have data" refusal.

Seed demo docs under `apps/bff/src/rag/seed/` load on first BFF use. They are fake fixtures for local smoke tests and evals, not market data.

## Conversation history

- `GET /api/history?userId=&limit=` returns the most recent per-user chat turns for the web console to reload on boot.
- `src/history/store.mjs` caps each user to the latest 100 turns, redacts obvious secrets/SSNs/card-like values before storage, and participates in `STORE=file` snapshots.
- Durable preferences and constraints still go through `src/memory/`; history is a transcript layer, not a long-term preference store.

## Watchlist

- `GET /api/watchlist` returns the user's symbols hydrated with live/mock quotes from the active market-data provider.
- `POST /api/watchlist` / `DELETE /api/watchlist` add and remove canonicalized tickers.
- `watchlist_add` lets the assistant handle requests like "add NVDA to my watchlist" without creating an order draft or touching the execution path.
- The web console has a Watchlist panel with quote refresh and remove actions. Alert integration is intentionally deferred until the alerts store/tool from the adjacent branch lands.

## Safety invariants (enforced by code + tests)

1. **The model never executes a trade.** It only produces a `DraftOrder` (`requires_confirmation: true`). Execution lives on a separate route reached only by an explicit human action carrying a server-issued `draft_id`.
2. **Deterministic risk checks live outside the model** (restricted symbols, fat-finger notional, price collar, buying power) — no prompt can route around them.
3. **Grounded answers carry an `as_of` timestamp + citation;** advice questions refuse a recommendation and disclaim.
4. **Memory remembers purposes/constraints, not live state** (positions/balances are fetched). PII is a hard write-gate.
5. **RAG answers cite retrieved chunks and refuse when the KB lacks support.** Point-in-time filters use `acceptance_datetime` so future documents are not visible early.
6. **Conversation history redacts obvious secrets before persistence** and is capped per user.
7. **Watchlist changes are reversible state, not orders.** The assistant can add a symbol to the watchlist, but it still cannot draft unless the user asks for an order and cannot execute at all.
8. **The Test (local) account is the default** (explicitly fake, not "paper"); real brokers are opt-in connections, and routing to a **Live** account requires `ALLOW_LIVE_TRADING=true`.

See [`MILESTONES.md`](MILESTONES.md) for progress.
