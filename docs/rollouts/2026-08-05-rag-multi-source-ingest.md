# Rollout: multi-source RAG (earnings transcripts + SEC full/highlights)

## Context & Objective

Owner wants earnings-call transcripts, broader SEC filing depth, and LLM-friendly
highlights/key points in RAG so strategy can contemplate trades with both **full narrative**
and **compact abstracts**. Prior corpus was 10-K/10-Q bodies + 6-line 8-K summaries; full-body
8-K and transcript producers existed but were under-budgeted / abstract path unused.

## Changes Made

**Architecture (best for LLM trade use):**
- Keep full bodies under native `doc_type` (`10-k`, `10-q`, `8-k`, `earnings-transcript`).
- On successful ingest, also write extractive **highlight abstracts** (`document-summary` /
  `earnings-summary`) via `tradeHighlightChunksFromText` (no extra LLM spend on ingest).
- Retrieval: `filing_narrative` includes `document-summary`; `earnings_transcript_narrative`
  includes `earnings-summary`.

**Code:**
- `src/lib/rag/document-summarizer.ts` — `tradeHighlightChunksFromText`; short-summary guard;
  abstract vectors get `title` + `doc_id`.
- `src/lib/web-sources/sec8k.ts` — after full-body success → `8k-brief` abstract.
- `src/lib/web-sources/sec-filings.ts` — after 10-K/10-Q success → `10k-delta` / `10q-delta` abstract.
- `src/lib/earningscalls-transcripts.ts` — after transcript ingest → `earnings-summary` abstract.
- `src/lib/rag/information-routing.ts` — expand semantic doc types for filings/transcripts/research.
- `src/lib/strategy.ts` — coverage canary includes `earnings-transcript` when FMP **or**
  EarningsCalls producer is enabled.
- Tests: `test/document-summarizer.test.ts`, `test/rag-information-routing.test.ts`.

**Infisical prod knobs (ST project, set 2026-08-05):**
| Key | Value |
|-----|--------|
| `WEB_SOURCE_SEC8K_FULL_BODY` | `on` |
| `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT` | `25` |
| `WEB_SOURCE_SEC8K_RAG_LIMIT` | `48` |
| `WEB_SOURCE_SEC8K_WINDOW_DAYS` | `7` |
| `RAG_EMBED_DISCLOSURES` | `on` |
| `EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS` | `8` |
| `EARNINGSCALLS_BURST_MAX_TRANSCRIPTS` | `25` |
| `EARNINGSCALLS_TOP_CANDIDATES` | `40` |

(FMP transcripts stay dual-gated OFF — rights; use EarningsCalls.dev when key present.)

## Decisions & Trade-offs

- **Extractive** highlights (keyword-scored paragraphs), not LLM rewrite — cheaper, deterministic,
  still surfaces guidance/margins/items for proposals. Full text remains retrievable for deep reads.
- FMP transcript producer not enabled without rights claim (existing dual-gate).
- Abstracts are best-effort after full ingest; failure is logged, does not fail the parent ingest.
- Container restart required after Infisical flag changes (next-server loads env at boot).

## Verification State

```bash
npx vitest run test/document-summarizer.test.ts test/rag-information-routing.test.ts
npx tsc --noEmit
npm run lint
npm test   # land.sh runs full suite
npm run build
```

## Next Steps & Blockers

1. Land PR → auto-deploy main; **restart** `socratic-app` so new Infisical knobs load.
2. Confirm next-server env has `WEB_SOURCE_SEC8K_FULL_BODY=on` and raised EarningsCalls daily.
3. Watch Pinecone vector growth + `document_abstracts` rows after next scheduler tick / reindex-10k.
4. Optional later: DEF 14A / other form types if owner wants beyond 10-K/10-Q/8-K.
