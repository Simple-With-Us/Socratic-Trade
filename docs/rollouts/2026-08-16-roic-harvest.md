# ROIC Individual harvest (local-first, latest then deepen then archive)

## Context & Objective

Owner: Individual ROIC may last only a couple more weeks.  Pull as much breadth as we can across the trading universe, plus depth on names of most interest.  Confirm whether an expert panel already decided how earnings calls / highlights should live in RAG for Green/Red proposers — if not, run one.

A panel already approved that decision on 2026-08-16: `docs/designs/2026-08-16-proposer-corpus-storage.md` rev 3 (PR #2760, 0 open issues).  No second panel.

## Changes Made

Implement the **transcript slice** of rev 3 so the Individual window is not wasted on Pinecone-full-body or skipped when the write fuse trips.

- Persist every fetched call into `earningscalls_transcripts` first (existing immutable cache).  Content stays after the tier ends.
- Remove the early `hasPineconeWriteBudget` return that skipped the entire ROIC walk.
- Three-pass cursor: `latest` (one newest call, demand-first universe) → `deepen` (plan-tier quarters for held/watchlist/technical) → `archive` (same cap for everyone else, local only).
- Pinecone write class: full-body only for the newest high-interest call (transcript exception until a transcript FTS mirror exists); extractive `earnings-summary` for other latest/deepen calls; archive is local-only.
- Leftover next-phase queue is persisted even when the per-run budget is exhausted, so we do not stamp `lastComplete` and sleep 6h before archive.

Touched:

- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/scheduler.ts` (comment)
- `test/roic-transcripts.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- this rollout

## Decisions & Trade-offs

- Did **not** re-run a panel.  Rev 3 already chose extractive highlights in Pinecone, full bodies local, latest-first then deepen high-interest, no ingest LLM.
- Did **not** flip `RAG_PINECONE_WRITE_CLASS` or land PR A/B (split writer + money-path hydrate).  Those stay the gate for filings.  Transcripts already have a local table (`earningscalls_transcripts`) so this producer can honor the keep-set now.
- Reused `earningscalls_transcripts` instead of a new table (rev 3 "prefer existing tables").  First writer still wins on content (COALESCE).
- Archive is local-only so a 1k-name × 20-quarter pass does not fill the Pinecone trial with history we do not intend to keep.
- Infisical `ROIC_TRANSCRIPTS_MAX_PER_RUN=300` (set earlier this session) still applies after the next container start.

## Verification State

```bash
cd ~/apps/trading-grok-roic-harvest
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/roic-transcripts.test.ts
# 14 passed
```

Full `land.sh` gate (tsc → test → build) runs at land time.

## Next Steps & Blockers

- Landed #2763.  Follow-up: skip cached re-lists and write `data/roic-artifacts` — `docs/rollouts/2026-08-18-roic-individual-archive.md`.
- Watch ticker breadth leave USB/SHEL/OXY.
- FilingAPI still owner Plus — not this PR.
- PR A (split writer) + PR B (hydrate) still required before flipping the global write class for filings.
- #2751 (rotation/Red/Alpaca/ingest unstick) was DIRTY vs #2750 and is a sibling, not this harvest.

## Zero-Code Findings

Panel already existed and is approved.  Do not invert to deepen-first.  High-interest = `rankHighInterestSymbols` (holdings, watchlists, technical).  Individual depth is 20 quarters.
