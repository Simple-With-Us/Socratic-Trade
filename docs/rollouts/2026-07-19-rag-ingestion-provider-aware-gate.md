# 2026-07-19 — RAG SEC-filing ingestion throttle: provider-aware gate fix

## Summary

`isFreeTier()` in `src/lib/web-sources/sec-filings.ts` — which gates the 10-K/10-Q
full-body ingestion per-run cap between 1 filing (free tier) and 200 filings (paid tier)
— was keyed purely off `VECTOR_EMBED_BATCH_DELAY_MS`, a Voyage-pricing-era env var. It had
no awareness of `RAG_EMBED_PROVIDER`. Fixed it to check the active embedding provider first.

## Why

Investigated at the owner's request after another session's RapidAPI-source subscription
batch prompted the question "does the RAG pipeline need more ingestion sources?". It doesn't
— the existing EDGAR-direct fetch already works. The actual bottleneck is this throttle:
`vector-db.ts` already has a proper provider-aware resolver (`activeEmbeddingProvider`,
built in PR #1766's "provider-aware metering" fix), but `sec-filings.ts` was never updated to
consult it. Anyone migrating `RAG_EMBED_PROVIDER` to `openrouter`/`siliconflow` (the bge-m3
program, already landed) without ALSO remembering to zero out the unrelated
`VECTOR_EMBED_BATCH_DELAY_MS` var would find ingestion silently still capped at 1 filing per
scheduler tick, regardless of the new provider's real capacity — openrouter/siliconflow are
rate-limited per-request, not by the Voyage free-tier trickle this gate was written for.

## Files

- `src/lib/web-sources/sec-filings.ts` — `isFreeTier()` now short-circuits to `false`
  (paid-tier) when `activeEmbeddingProvider("local")` is `"openrouter"` or `"siliconflow"`;
  only checks `VECTOR_EMBED_BATCH_DELAY_MS` when the active provider is `"voyage"`. Updated
  the function's doc comment; module-header comments (lines 7-13) still describe the
  legacy Voyage-only framing and could use a follow-up pass but aren't functionally wrong.
- `test/sec-filings.test.ts` — added `activeEmbeddingProvider` to the existing partial
  `vector-db` mock (defaults to `"voyage"` so every pre-existing
  `VECTOR_EMBED_BATCH_DELAY_MS`-driven test is unaffected), plus a new regression test:
  "does NOT apply the free-tier cap when the active provider is bge-m3 (openrouter), even
  with a stale free-tier-looking VECTOR_EMBED_BATCH_DELAY_MS" — proves 4 filings get
  attempted (not capped at 1) under exactly the failure scenario above.
- STATUS.md, docs/EFFORT-LOG.md, `/Users/jay/apps/TRADING-EFFORT-LOG.md` updated.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/sec-filings.test.ts --no-file-parallelism` — 45/45 pass (1 new,
  44 pre-existing unaffected).
- `npm run lint` / `npm run build` — run as part of `scripts/land.sh`'s gate; see that
  run's output for the authoritative result at land time.

## Follow-ups

- Landing was blocked purely by the shared self-hosted CI runner's queue depth at the time
  of this note (20-30 jobs queued fleet-wide, ~7h wait observed on one job; runner itself
  confirmed alive/draining, not hung) — an infrastructure capacity issue unrelated to this
  change's correctness, posted to #ag***-s**c separately. `scripts/land.sh` will push and
  open the PR once local verify passes; the PR's own CI checks then queue like everyone
  else's.
- The module-header comment block (lines 7-13) still frames the gate as purely
  Voyage-pricing-based; a follow-up doc-only pass could update it to mention the
  provider-aware check, but it isn't misleading enough to block this fix.
