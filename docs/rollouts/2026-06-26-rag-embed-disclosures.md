# 2026-06-26 — Embed congressional + insider disclosures into the vector store (item #3)

Branch `agent/claude-rag-embed-disclosures`. Improvement-program item #3.

## Summary
Congress trades and insider filings were stored **structured-only** (`congress.ts` / `sec.ts`) and never
embedded, so "congressional-context retrieval" wasn't real RAG. This adds an opt-in path that vectorizes them.

- New `src/lib/web-sources/disclosure-rag.ts`:
  - `tradeToDoc` / `filingToDoc` render each disclosure as a short natural-language summary (who, symbol,
    side, amount range, dates).
  - `acceptance_datetime` set to the disclosure date — `disclosedAt ?? tradedAt` (congress), `filedAt`
    (insider) — which is the first field `isWithinAsOf()` checks, so the point-in-time as-of guard never
    leaks a future disclosure.
  - `doc_type` lowercase canonical: `congress-trade` / `insider-filing` (retrieval's `buildExtraFilters` is
    casing-tolerant regardless).
  - Upserts through the existing `storeContexts` path; `vector-db` is pulled in via **dynamic import** so the
    Voyage/Pinecone stack only loads when the flag is on and there's data.
  - `embedDisclosures()` early-returns `{skipped:true}` before any import when the flag is off; never throws;
    best-effort audit (`disclosure_rag_embed`).
- `src/lib/web-sources/index.ts`: flag-gated, fire-and-forget hook at the end of `runDueRefreshes` — advisory
  RAG only, never blocks or errors the refresh loop.
- Flag `RAG_EMBED_DISCLOSURES` (default OFF) documented in `.env.example`.
- `test/disclosure-rag.test.ts`: 22 hermetic tests (vector-db upsert mocked via `vi.hoisted`/`vi.mock`) —
  flag off/on, text content, metadata (doc_type/symbol/source/acceptance_datetime), point-in-time fallback,
  amount-format edges, empty/mixed input.

## Why
Item #3 — make congressional/insider context retrievable as real RAG. Additive + flag-gated so there's zero
behavior change until enabled (advisory only; not a money path).

## How (model-tiered subagent team)
Built by a workflow team (run `wf_e02e0163-a3b`): sonnet recon → sonnet design → sonnet implement → sonnet
adversarial review. Review verdict: `implementsSpec/correct/moneySafe/tscGreen/testsGreen` all true, no
required fixes. Orchestrator pass: fixed one misleading "circular import" code comment (vector-db does not
import web-sources; the dynamic import is for lazy loading of the heavy embed stack).

## Deviations / follow-ups
- Short 1-2 sentence disclosures are sent directly to `storeContexts`, **not** through `rag/chunk.ts` — the
  chunker targets long documents and adds nothing here.
- The hook re-embeds the whole dataset each refresh. The upsert id is deterministic (so no duplicates), but
  it's redundant embedding cost when enabled; a fresh-delta-only pass is a cheap later optimization.

## Files
- new `src/lib/web-sources/disclosure-rag.ts`
- `src/lib/web-sources/index.ts` (flag-gated hook)
- `.env.example` (`RAG_EMBED_DISCLOSURES=off`)
- new `test/disclosure-rag.test.ts`
- `docs/improvement-program-2026-06-26.md`, `STATUS.md`

## Verification
- `npx tsc --noEmit` clean; `npx vitest run test/disclosure-rag.test.ts` → 22 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.
