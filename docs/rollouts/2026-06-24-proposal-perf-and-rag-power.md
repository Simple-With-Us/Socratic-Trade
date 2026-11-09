# 2026-06-24 — Performance-since-proposal surfacing + Voyage/Pinecone at full power

## Summary
Two requested upgrades, built after a 6-agent review of the proposal/counterfactual machinery and the
RAG pipeline.

### Part A — "performance since proposal" in the review UI (esp. rejected)
- **A1** `ensureReferencePrice` (`db-proposals.ts`): every stored proposal is guaranteed a positive
  `referencePrice` entry-anchor (enrichOpeningProposal sets it on the main path; this backfills
  limit→stop for any other path) so there's always something to measure from.
- **A2** Server computation (`dashboard.ts` + new pure `returnSinceProposalPct` in `performance.ts`):
  each recent/pending proposal gets a side-adjusted `performanceSinceProposalPct` (+ ref/current
  price) computed from prices already in hand (held-position quotes + the latest scan's quotes) — no
  new network calls. For a long it's the raw move; for sell/short the sign inverts.
- **A3** UI (`dashboard-client.tsx`): a colored "since X%" / "missed X%" chip on both pending and
  decision-ledger cards, and the counterfactual note now renders for ALL statuses ("Counterfactual
  since proposal: X% if accepted" for rejected/blocked/expired/withdrawn; "Performance since
  proposal: X%" for accepted), with the from→to prices.
- **A4** `recordRejectedProposalCounterfactual` (`counterfactual-learning.ts`), wired into
  `rejectProposal` (`strategy.ts`): a user-rejected proposal is now fed into the SAME skipped-candidate
  counterfactual pipeline, so its post-rejection return MATURES (via `fetchDailyOHLC` at the holding
  horizon) and feeds missed-opportunity analytics — closing the gap where only LLM-not-chosen names
  were analyzed. Additive (INSERT OR IGNORE, no schema change); writes no fills/orders.

### Part B — Voyage + Pinecone at fullest power
- **B1 (biggest lever)** Voyage reranking in `retrieveContextDetailed`: over-fetch by cosine recall
  (`overFetchK`), then `voyage.rerank` (rerank-2.5) reorders by true relevance and trims to the limit.
  ON by default (`VECTOR_ENABLE_RERANK`); fails safe to cosine order on any error.
- **B2** Look-ahead fix: 8-K vectors now carry `acceptance_datetime` (+ `doc_type:"8-k"`), activating
  the existing `isWithinAsOf` point-in-time guard for 8-Ks.
- **B3** Optional query-time metadata filters (`docType`/`section`/`source`) on `retrieveContextDetailed`,
  merged into both tenant-tier Pinecone filters.
- **B4** `minScore` cosine floor option.
- **B5** Memoized Voyage/Pinecone clients per resolved key-pair (no `new` per call).

## Why
The user asked to (1) show stocks' performance from the proposal date when reviewing — "especially
rejected, since the app analyzes that anyway", and (2) run Voyage/Pinecone at fullest power for the
learning/memory loop. A2/A3 show it; A4 makes the rejected ones actually mature into the learning
analytics. B1 is the dominant retrieval-quality win; B2 removes a real backtest-leakage bug.

## Safety
All changes are advisory/observability-only: no fills/orders written, no `setPolicy`, RAG output stays
DATA in the LLM user message, counterfactual numbers are display + learning inputs only.

## Files
- `src/lib/vector-db.ts` — client memoization, rerank config + `rerankMatches`, `RetrieveOptions`,
  `buildExtraFilters`, minScore/asOf/rerank pipeline.
- `src/lib/web-sources/sec8k.ts` — `acceptance_datetime` + `doc_type` on both 8-K store sites.
- `src/lib/performance.ts` — `returnSinceProposalPct`.
- `src/lib/dashboard.ts` — per-proposal performance enrichment.
- `src/lib/db-proposals.ts` — `ensureReferencePrice`.
- `src/lib/counterfactual-learning.ts` — `recordRejectedProposalCounterfactual`.
- `src/lib/strategy.ts` — wire rejection → counterfactual.
- `src/lib/types.ts` — perf fields on `RecentProposal`/`PendingProposal`.
- `app/dashboard-client.tsx` — perf/counterfactual badges + note.
- `.env.example`, `docs/prod-config-voyage.md` — rerank env + gated paid-key/reindex follow-ups.
- Tests: `test/vector-db-retrieval.test.ts`, `test/proposal-performance.test.ts`,
  `test/rejected-counterfactual.test.ts`; updated `test/vector-db.test.ts` (over-fetch topK).

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 1041 passed (118 files); +18 new.
- `npm run build` — green.
Built in isolated worktree `~/apps/trading-ag7` off `origin/main`; landing via PR.

## Follow-ups (gated / additive — see docs/prod-config-voyage.md)
- Paid Voyage tier batch profile (config-only); voyage-3-large 1536-dim model (full reindex).
- Voyage/Pinecone usage metering; chunk `content_hash` dedup; wire docType/minScore into specific callers.
- Also feed POLICY-BLOCKED proposals (not just user-rejected) into the counterfactual pipeline.
