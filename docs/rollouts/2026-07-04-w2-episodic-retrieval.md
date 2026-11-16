# 2026-07-04 — Wave-2 episodic-retrieval lane: experience memory + decision-time analogs

Branch: `claude/w2-episodic-retrieval` (worktree `~/apps/trading-wt-w2-episodic`), based on
`origin/claude/w1-rag-quickwins` (42679062 — provenance headers + stable chunk ids this lane
builds on). Push-only; NO PR — the landing train picks this up after its base branch lands.

## Summary

Implements the composite expert review's single highest-leverage item (section A item 1,
**[Both]** — independently surfaced by both expert panels): "Retrieve episodic decision memory
(closest historical analogs) at decision time." Decision vectors were WRITTEN
(`indexSocraticDecisionMemory`, once at proposal time) and NEVER read — the only strategy
retrieval filtered docType to filings, so the agent could not see its own past decisions or the
owner's coaching when deciding.

Four parts, per the review's "How" spec:

1. **Closed-lot experience writer** — new `src/lib/experience-memory.ts`, hooked fire-and-forget
   from `performance.recordFillFromProposal` on every sell/cover fill. Replays the account's fills
   through the SAME FIFO accounting the scorecards use (`calculatePnl`) to find exactly the lots
   that fill closed; resolves each lot's ENTRY fill for the entry proposal / factor snapshot /
   proposalId key; embeds one experience document per closed lot. State vector text = 8 factor
   sub-scores + `entryMarketRegime` + macro/breadth snapshot + thesisTag + sector + entry
   rationale (Voyage embeds the whole document, satisfying the "optional Voyage-embedded
   rationale"); metadata = realized `{return_pct, holding_days, risk_exit, mae?, mfe?}` plus
   `proposal_id` (ENTRY proposal — the review's "keyed by proposalId"), `run_id` (entry run),
   `exit_run_id`, thesis/regime/sector/side/confidence and per-factor `factor_<name>` scalars.
   Dedicated namespace = `source="experience-memory"` + accession `exp:<entryProposalId>:<exitProposalId>`
   + dedup prefix `experience-memory`; `doc_type="socratic-decision"` so experiences and
   proposal-time case files share one episodic retrieval surface. To make the entry state honest
   (not a lookahead reconstruction at exit), opening fills now stamp the FULL `factorBreakdown` +
   `scanBreadthPct` into the fill `raw` (additive; existing readers unaffected).
2. **Decision-time retrieval** — `retrieveDecisionExperiences`: a SECOND retrieval pass per run in
   `strategy.ts` (after the filings/learned-context blocks, same LLM-budget gate) over doc types
   `['socratic-decision','coach-note','lesson']`. `coach-note`/`lesson` writers land via parallel
   Wave-2 lanes (coaching-durable, reflection-decompose) — this lane CONSUMES the doc_types (a
   harmless no-match until they land). The query is a SITUATION SKETCH (`buildSituationSketch`:
   regime + top-3 candidates' dominant factor / sector / evidence bulletins), deliberately NOT the
   generic filings query. k-NN retrieves 5-10 closest priors (default 8, over-asked by 4 to
   survive exclusions), cross-symbol via the new additive `RetrieveOptions.matchAllSymbols`.
   Same-run neighbors are excluded (metadata `run_id` OR `exit_run_id` equal to the current runId)
   and the retrieval is stamped as-of (`asOf` = now, passed through to the vector store's
   point-in-time guard — no lookahead on replay).
3. **Injection with evidence parity** — labeled blocks injected into BOTH the Bull and the Bear
   userContent: `closestHistoricalAnalogs` ("CLOSEST HISTORICAL ANALOGS", as-of stamp + top-analog
   similarity in the header, each chunk provenance-headed via the base branch's
   `formatChunkWithProvenance`; priors with OPPOSITE realized sign labeled
   `[COUNTEREXAMPLE — opposite realized sign]`, never filtered) and `ownerCoaching`
   (doc_type `coach-note`). Advisory only — never threaded into deterministic sizing or policy.
4. **Per-run injected-id persistence** (the run-input side of retrieval-usefulness scoring; full
   scoring is a later item) — audit kind `experience_retrieval` records `{runId, asOf, query,
   analogIds, coachingIds, counterexampleIds, topAnalogSimilarity}`, and the retrieved chunks are
   appended to `socraticRagAttributions` so every decision case created that run carries the
   injected memory ids (persisted in `socratic_decisions` and re-indexed with the case).

Opt-out: `EXPERIENCE_MEMORY=off` disables both the write hook and the retrieval pass (default ON,
mirroring the rerank opt-out convention). All failure paths degrade to "no block / no write" —
nothing here can break a fill record or a run.

## Why

Both expert panels independently identified the write-only episodic memory as the top
decision-quality gap ("a trading mind with memory that cannot remember"). This closes the loop:
outcomes land in a retrievable experience namespace at lot close, and every run retrieves its
closest historical analogs + owner coaching into both debate sides before deciding. Philosophy
preserved: advisory receipts everywhere (counterexamples labeled, similarity shown, as-of
stamped), no new gates or blocks, sole-user design, no compat shims.

## Files

- `src/lib/experience-memory.ts` — NEW: write hook, situation sketch, decision-time retrieval,
  block formatting, injected-id refs. (`EXPERIENCE_MEMORY` opt-out flag.)
- `src/lib/performance.ts` — `recordFillFromProposal`: additive entry-state stamps
  (`factorBreakdown`, `scanBreadthPct` in `raw`, opening sides only; hoisted `entryCandidate`
  lookup) + fire-and-forget dynamic-import hook to `recordClosedLotExperience` on sell/cover.
- `src/lib/vector-db.ts` — additive only: `RetrieveOptions.matchAllSymbols` (drops the
  `symbol $eq` clause on both query tiers), `RetrievedChunk.metadata` passthrough (raw Pinecone
  metadata minus `text`) populated in `matchToChunk`.
- `src/lib/strategy.ts` — episodic retrieval block in the run loop (after learned-context, same
  budget gate); `experience_retrieval` audit; attributions append; `proposeTrades` input
  `experienceAnalogs`/`ownerCoaching`; `closestHistoricalAnalogs` + `ownerCoaching` injected into
  `userContent` AND `bearUserContent`. (Did NOT touch the Bear/proposal schemas ~2700-2977, the
  breaker/vol-brake region ~340-405, or drawdownAdvisory — other lanes own those.)
- `test/experience-memory.test.ts` — NEW: write-hook embeds on closed lot (state text + realized
  metadata + entry-proposalId key + dedup prefix); no write on opening fills; `EXPERIENCE_MEMORY=off`;
  situation-sketch shape (regime + factor/evidence, not the filings query); same-run exclusion
  (entry AND exit run ids); as-of stamping (option passthrough + result stamp + header);
  counterexample labeling; top-analog similarity; empty-result shape.
- `test/strategy-episodic-injection.test.ts` — NEW: full `runStrategyOnce` with LLM stubbed —
  episodic pass runs with sketch/docTypes/matchAllSymbols/asOf; analogs + coaching blocks present
  in BOTH Bull and Bear payloads (with similarity + counterexample label); injected ids
  recoverable from the `experience_retrieval` audit row.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification (run in order, all green)

```bash
npm run lint       # 0 errors (308 pre-existing grandfathered warnings; none in new files)
npx tsc --noEmit   # clean
npm test           # 2395 tests / 249 files passed (7 new)
npm run build      # Next.js production build succeeded
```

## Follow-ups / known gaps

- **Live-fill closes:** broker (live) closing fills insert as `pending_reconciliation`, which the
  FIFO accounting excludes until reconciliation — so the experience write no-ops for them at hook
  time. Paper/simulated closes (the current learning-loop population) are fully covered. Follow-up:
  fire the same hook from the reconciliation path when a live fill flips to `filled`.
- **mae/mfe:** persisted on fill rows later by the post-mortem path; included when present at
  close time, otherwise omitted. A re-index-on-lifecycle-update pass (the w1-learning-loops item)
  can refresh experience docs once excursions land.
- **`entryBreadthPct` as macro snapshot:** the entry-time macro snapshot is regime + scan breadth
  (what recordFillFromProposal can stamp synchronously without lookahead). Richer entry macro
  (curve spread, real rates) would need the strategy run to thread macro into the fill path —
  deferred rather than mislabeling exit-time macro as entry state.
- **Coach-note/lesson writers** are other Wave-2 lanes (coaching-durable, reflection-decompose);
  this lane retrieves those doc_types as they appear.
- **Retrieval-usefulness scoring** (joining the persisted injected ids to matured outcomes) is the
  later review item; this lane only guarantees the ids are recoverable per run.
