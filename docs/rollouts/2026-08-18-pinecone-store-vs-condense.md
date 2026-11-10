# 2026-08-18 — Pinecone store-more vs condense-first (report only)

## Context & Objective

Owner asked whether more Pinecone storage is better for Green/Red, or whether condensing the corpus (highlights, summaries, speaker turns, proposer-format) is the better way to make retrieval useful.  Trial still has $230.44 of $300 and 12 days; he will likely land on Builder (~Aug 30) and wants to keep using Pinecone, not prune-to-highlights.  This is a report-only answer.  No write-class flip, no prune, no condensation pipeline, no Stripe, no FilingAPI Plus.

## Changes Made

Docs only.  Explicit recommendation: **hybrid — condense-first for the Pinecone operational index, store-more locally.**  Builder is 10 GB / 5M WU/month with a hard cap, not unlimited raw 10-Ks.

Touched files:

- `docs/audits/2026-08-18-pinecone-store-vs-condense.md`
- `docs/rollouts/2026-08-18-pinecone-store-vs-condense.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`

## Decisions & Trade-offs

- Did not implement PR A/B or flip `RAG_PINECONE_WRITE_CLASS`.  Producers on `main` do not read that env yet.
- Did not raise the 2.5M daily fuse.  The trial pacer already lifts effective daily WU to remaining/days (~4.8M).  Unused retrieval is the #2800 remainder deadlock and the one-funnel writer, not the 2.5M knob.
- Kept extractive highlights.  No ingest-path LLM.
- FilingAPI left to #2792.
- "Do not prune-to-highlights" is treated as keep the live full-body index, not as fill Builder with more raw bodies.

## Verification State

```
# docs-only; no product-code compile required
npx tsc --noEmit   # not required for this PR; skipped
npm test           # not required for this PR; skipped
npm run lint       # not required for this PR; skipped
npm run build      # not required for this PR; skipped
```

Report cites current `main` paths (`strategy.ts` 8/1 retrieve, `vector-db.ts` `retrieveContextDetailed`, `pinecone-trial-window.ts` pacer, `evidence-consumption.ts`, `lookahead-audit.ts`, `document-summarizer.ts`, `roic-transcripts.ts` write class) plus #2803 and the 2026-08-16 proposer-corpus design.  Pinecone plan quotas taken from pinecone.io/pricing on 2026-08-18 (Builder 10 GB / 5M WU).

## Next Steps & Blockers

1. Land #2800 if ingest is still remainder-deadlocked.
2. Keep latest-first ingest at the paced effective WU rate; spend remaining trial on processed breadth, not Pass C full bodies.
3. Corpus-storage PR A then B, then env flip.
4. Production-eval merge gate on `retrieveContextDetailed` (#2803 R1).
5. Owner: Builder vs Standard at trial end; measure live GB before any prune talk.

## Zero-Code Findings

More Pinecone storage of raw 10-K/Q/transcript pages is not better for Green/Red.  The money path consumes 8/1 chunks and 24k filing characters.  Extra ANN neighbors lose to that budget.  Builder is a 10 GB hard cap.  Fill it with extractive highlights + signal sections + speaker-turn slices (plus latest high-interest full calls until transcript FTS exists).  Keep full bodies local for hydrate.  Keep the live index (no prune).  Keep the 2.5M fuse and $45 reserve.
