# Improvement program — RAG / learning-loop / risk / observability (2026-06-26)

Owner-approved batch of 14 items (some overlap → 11 distinct workstreams). Planned by a model-tiered
fan-out (workflow `wf_078f533f-979`); sequenced to minimize file conflicts. **Autonomy is now treated as
potentially live**, so risk/correctness items are production-grade. This doc is the handoff source of truth —
another platform (Codex/Antigravity) or a fresh session can pick up any item from its spec + status.

## How to work this program
- **One PR per item** (or per safe batch). Land via `scripts/land.sh` (tsc → test → build). Money-path /
  risk items get an adversarial review pass before merge.
- **File-overlap is the constraint.** The RAG-retrieval items all rewrite the same regions of
  `vector-db.ts`; `strategy.ts` and `types.ts` are touched by several items; `db.ts migrate()` is the
  documented merge-conflict trap. Do NOT parallelize items that share a hot file — follow the order below.
- Keep changes **additive + flag-gated** where they alter money-path behavior. **STALE 2026-07-03:**
  this program predated removal of the legacy paper-mode policy; use current AGENTS.md execution rules.

## Sequenced order (from the opus sequencer)
1. **risk-tests** (tests-only, parallel-safe) — Batch 1
2. **langfuse-evals** (new files, parallel-safe) — Batch 1
3. **rag-wire-filters** (vector-db base layer; land before hybrid) — Batch 2
4. **rag-hybrid-bm25** + **rag-embed-congress-insider** (review) — Batch 3
5. **learning-reasoning-diversity** + **staleness-gate** (strictly sequential; both touch strategy.ts/types.ts) — Batch 4
6. **rag-multiquery-rrf**, **learning-coarse-credit**, **scheduler-durable** (opus designs) — after their specs land
7. **rag-selfrag-hyde-decision** (decision, may be mostly "skip")

## Item status
| # | Item | Spec | Status | Files (primary) |
|---|---|---|---|---|
| 10/#2 | **risk-breaker + short/cover P&L + notional tests** | ready | **DONE** — risk-breaker (13) ✅; calculatePnl four-side realized-P&L + notional cross-boundary (8 added) ✅. No production bugs found (adversarially verified). | `test/risk-breaker.test.ts` ✅, `test/performance.test.ts` ✅, `test/daily-notional-reset.test.ts` ✅ |
| 6+7 | **Langfuse offline eval/regression + 6-provider answer-quality suite** | ready | **DONE** — 15-case dataset + 6 deterministic scorers + optional LLM-judge + offline runner (MockLLM default, real-providers opt-in via `EVAL_REAL_PROVIDERS=1`, Langfuse gated on env); `npm run eval:offline` → 15/15 PASS; 49 hermetic tests | `scripts/eval/{dataset,score,run-offline}.ts`, `test/eval-offline.test.ts`, `package.json` |
| 1+#6 | **Wire RAG metadata filters + minScore floor** | ready | **DONE** (PR after #186) — `defaultMinScore()` (env `VECTOR_MIN_SCORE`=0.30) wired into strategy + chat retrieval; **buildExtraFilters made CASING-TOLERANT** (stored doc_type is inconsistent: sec-filings "10-K" vs sec8k "8-k" — a single-casing filter would have silently excluded 10-K/10-Q; fixed) | `vector-db.ts`, `strategy.ts`, `chat/orchestrator.ts`, `.env.example`, `test/vector-db-retrieval.test.ts` |
| 4 | **Hybrid dense+sparse/BM25 retrieval** | ready | **DONE (PR #196 merged)** — infra-free: BM25 over the dense candidate pool, RRF-fused after minScore+as-of, before rerank; flag `HYBRID_RETRIEVAL` (default OFF). Reusable `rrfFuse`. Codex review addressed (positive-score BM25 list; hybrid included in over-fetch). 29 tests | `src/lib/rag/hybrid.ts`, `vector-db.ts`, `.env.example`, `test/vector-db-hybrid.test.ts` |
| 3 | **Embed congressional + insider disclosures into vector store** | ready | **DONE** — `disclosure-rag.ts` converts congress trades + insider filings → RAG docs (doc_type `congress-trade`/`insider-filing`, `acceptance_datetime`=disclosure/filing date for the as-of guard) → `storeContexts`; flag `RAG_EMBED_DISCLOSURES` (default OFF); 22 tests | new `web-sources/disclosure-rag.ts`, `web-sources/index.ts`, `.env.example`, `test/disclosure-rag.test.ts` |
| 8 | **Reasoning/template-collapse diversity check on rationales** | ready | **DONE** — `rationale-diversity.ts` (multiset char-trigram Jaccard) computes per-run `{meanPairwiseSimilarity, maxPairwiseSimilarity, collapsed}`; wired into `runStrategyOnce` after the proposal set is finalized, attached to `StrategyResult` + `audit("rationale_diversity")`; advisory-only (no flag, never blocks/alters proposals); 30 tests | new `rationale-diversity.ts`, `strategy.ts`, `types.ts`, `test/rationale-diversity.test.ts` |
| 5 | **Market-data staleness gate** | ready | **DONE** — `maxQuoteAgeSec`/`maxFundamentalsAgeSec` on `TradingPolicy`; OPENING-only fail-safe gate in `evaluateTradeProposal` (stale/missing timestamp → block; reads `marketScan` asOf + `generatedAt`); default OFF; 9 tests. No defaults/market/strategy change needed (asOf already flows). Opus design + dual opus review. | `types.ts`, `policy.ts`, `app/api/policy/route.ts`, `test/staleness-gate.test.ts` |
| 2 | **Query expansion / multi-query / RRF (RAG-Fusion)** | ready (opus) | **NOT STARTED (last item)** — build on `main` (needs #196 hybrid + #199 coarse-credit landed; reuses `rrfFuse`). See "Opus specs" + handoff note. | retrieval path in `vector-db.ts` + `strategy.ts`, `test/vector-db-fusion.test.ts` |
| 7/#4 | **Coarse credit assignment + attribution** | ready (opus) | **IN REVIEW (PR #199, OPEN)** — code done + dual-opus-reviewed (all-green); awaiting Codex thread-resolution + merge. Dual-sided attribution (new `realizedPnlAsEntry`/`realizedPnlAsExit`), MAE/MFE read-path, OOS-withhold. 47 tests. | `performance.ts`, `types.ts`, `strategy-tuning.ts`, `db-fills.ts`, `test/coarse-credit.test.ts` |
| 3/#3 | **Durable/locked autonomy scheduler** | ready (opus) | **DONE** — CAS lease in `settings` KV (no migration); tick per-account body gated behind `SCHEDULER_SINGLE_LEADER` (default ON as of 2026-07-11, including unset/empty; explicit false values disable); fail-closed; SIGTERM/SIGINT/beforeExit release; lease surfaced on /health + /ready. The 2026-07-11 correctness follow-up also gives approval calls unique strategy-lock owners and refuses broker placement after heartbeat ownership loss. | `scheduler-lease.ts`, `scheduler.ts`, `strategy-lock-guard.ts`, `health`/`ready` routes, `.env.example`, focused lease/default tests |
| 5 | **Reconsider Self-RAG / HyDE / sentence-window / contextual compression** | ready (opus) | **DECISION: SKIP all four now** — see "Opus specs" below | n/a |
| 9 | **karpathy/autoresearch review** | research | the planner agent MISREAD this as an "autonomous tuning loop" feature — IGNORE that; treat as a research read only (retry pending) | n/a |

## Key spec notes (the ready ones)
- **rag-wire-filters (S, no flag) — DONE:** `buildExtraFilters` + `minScore` were built but every caller
  passed `undefined`. Added `defaultMinScore()` (env `VECTOR_MIN_SCORE`, default 0.30, clamped [0,1]); wired
  `{docType, minScore}` into the `strategy.ts` per-symbol call and forwarded `args.doc_type`/`minScore` in
  `chat/orchestrator.ts`. **Deviation from spec:** the spec's single-casing docType list would have silently
  excluded all uppercase-stored 10-K/10-Q chunks (sec-filings writes "10-K", sec8k writes "8-k", Pinecone
  `$in` is exact-match). Made `buildExtraFilters` casing-tolerant (each type → original+lower+upper, deduped).
  Advisory path only; no flag.
- **risk-tests (M, no flag) — DONE:** risk-breaker.test.ts ✅ (PR #186). `calculatePnl` four-side realized-P&L
  + the notional cross-boundary case ✅ (this PR). **Stale-plan correction:** daily-notional *accounting/reset*
  was NOT a gap — `daily-notional-reset.test.ts` already covered buy/short-counted vs sell/cover-exempt,
  tenant isolation, fallback, and the NY-midnight boundary math (T6/T13). The genuine `calculatePnl` gap was
  the realized-P&L side coverage (only long-FIFO + basic short/cover existed); added short returnPct/side,
  partial cover, partial-then-full sell, the all-four-side interleave (the critical FIFO/sign case), both
  flat-close mirrors, and a mixed residual long+short mark-to-market. The only notional addition was a
  cross-boundary (orders-age-out) case. All values adversarially re-derived from first principles; no
  production bug found (the CLAUDE.md "verify all four sides explicitly" code is correct).
- **staleness-gate (M, flag) — DONE:** `maxQuoteAgeSec`/`maxFundamentalsAgeSec` on `TradingPolicy` (default
  unset = OFF). OPENING-only fail-safe gate in `evaluateTradeProposal`: quote age from
  `marketScan.quotesBySymbol[sym].asOf` (fallback topCandidates), fundamentals age from
  `MarketScan.generatedAt`; `age > threshold` (strict) or missing/unparseable timestamp → block with a clear
  reason — but only inside the gate-on branch. Pure read + reason-push; never approves/mutates/sizes; exits
  never gated; off-path byte-for-byte. No defaults/market/strategy change needed (asOf already flows onto
  `quotesBySymbol`; the gate reads `context.marketScan` at check time). Original spec note (superseded):
  proposal review so the strategy can't act on stale-but-cached data (today freshness is only a label).
- **langfuse-evals (M) — DONE:** `scripts/eval/dataset.ts` (15 cases: chat/quote/alert/order/watchlist/kb/
  positions/advice/views) + `score.ts` (6 deterministic scorers: contains/notContains/regex/notRegex/equals/
  jsonShape + LLM-judge that no-ops when `EVAL_JUDGE_API_KEY` absent) + `run-offline.ts` (MockLLM default;
  real providers opt-in `EVAL_REAL_PROVIDERS=1`; Langfuse gated on `LANGFUSE_PUBLIC_KEY`; exit-1 below 0.75).
  `npm run eval:offline` → 15/15, 100%. 49 hermetic tests (no network/keys). Reuses the real provider registry
  (`chatProviderForModel`/`llmForModel`) + `MockLLM` from `chat/llm.ts`. Real-provider replay across all 6
  (openai/anthropic/xai/gemini/mistral/deepseek) is wired but opt-in.
- **rag-embed-congress-insider (M, flag) — DONE:** `web-sources/disclosure-rag.ts` turns structured congress
  trades + insider filings into natural-language RAG docs and upserts via `storeContexts` (reuses the
  embedding stack; loaded by dynamic import so the heavy Voyage/Pinecone deps only load when the flag is on).
  `acceptance_datetime` = `disclosedAt ?? tradedAt` (congress) / `filedAt` (insider) so the point-in-time
  as-of guard never leaks a future disclosure. doc_type lowercase canonical. Flag `RAG_EMBED_DISCLOSURES`
  (default OFF); fire-and-forget hook in `runDueRefreshes`. Deviation: short 1-2 sentence disclosures are sent
  directly (not through `rag/chunk.ts`) — the chunker targets long docs. **Follow-up:** embeds the whole
  dataset each refresh (deterministic upsert id → no dupes, but redundant embed cost); a fresh-delta-only
  pass is a cheap later optimization.
- **rag-hybrid-bm25 (M, flag):** Pinecone sparse-dense; needs a reindex (admin route). Land after wire-filters.
- **reasoning-diversity (M) — DONE:** `rationale-diversity.ts` — multiset character-trigram Jaccard over
  normalized rationale text → `{count, meanPairwiseSimilarity, maxPairwiseSimilarity, collapsed, threshold}`
  (`collapsed` = mean > 0.85). Wired into `runStrategyOnce` after the proposal set is finalized; attached to
  `StrategyResult` (optional, non-breaking) + persisted via `audit("rationale_diversity")`; `console.warn` on
  collapse. **Advisory-only, no flag** (pure, no side effects beyond the audit write) — never blocks, drops,
  or modifies a proposal. 30 tests.

## Opus specs (the 4 hardest designs — recovered from the re-run)
- **rag-multiquery-rrf (M, flag) — DO IT, two stages.** Stage 1: template-mode multi-query + Reciprocal Rank
  Fusion *before* the cross-encoder rerank, flag-gated OFF. The single embed call already takes an array
  (`vector-db.ts:558` `embedWithRetry(voyage, [query], ...)`), so batching N query variants needs no SDK
  change and keeps embed cost ~flat; the expensive rerank stage is unchanged (RRF only widens recall, rerank
  still does final precision against the true query). Stage 2 (later opt-in): LLM-generated query variants.
  New `test/vector-db-fusion.test.ts`. NOTE: shares `vector-db.ts` retrieval region with rag-wire-filters +
  rag-hybrid-bm25 → land sequentially after both.
- **learning-coarse-credit (L, flag) — DO 3 additive changes, in order.** (B) plumb `ClosedLot.mae/mfe`
  (read-only prereq). (A) **the real "coarse" miss:** attribution currently credits 100% of realized P&L to
  the EXIT run (`performance.ts:414` `addAttribution` keys by the closing `fill.runId`), so the run whose
  ENTRY decision generated the edge gets 0. Fix = add dual-sided/decision-run attribution as NEW optional
  fields (don't redefine `RunAttribution.realizedPnl` — too many silent consumers). Highest-value, lowest-risk
  (purely additive, no money path). (C) withhold weight changes the OOS gate couldn't validate. **Defaults:**
  B's MAE/MFE-weighted credit OFF (changes sizing math → opt-in); C ON (only makes the advisory tuner more
  conservative).
- **scheduler-durable (M, flag) — DO a CAS lease.** New `scheduler-lease.ts` with a single-statement
  compare-and-swap lease stored in the existing `settings` table (NO migration — mirrors the proven
  `acquireStrategyLock` pattern). Gate the whole `tick()` body behind `SCHEDULER_SINGLE_LEADER` (default OFF);
  register SIGTERM/SIGINT/beforeExit release; surface lease owner+age on `/health` + `/ready`. **The real
  gap:** `runStrategyOnce` already holds a cross-process lock, but the synthetic-stop monitor in the tick body
  (`scheduler.ts:~200`) can place broker exit orders and is only in-process guarded → two processes double-fire.
  SKIP (separate PRs): the `acquireStrategyLock` TOCTOU rewrite (money-path) and a durable external scheduler.
  **DONE as specified.** Implemented `acquireLease`/`renewLease`/`releaseLease`/`getLease` +
  `acquireOrRenewLeadership` (renew-then-acquire); gate placed before the per-account loop (synthetic-stop
  monitor + strategy runs); fail-closed; TTL default 90s (1.5 ticks). The one-tick cross-process TOCTOU is
  unchanged (same as `acquireStrategyLock`, left per spec) — TTL-steal + the per-process `stopMonitorInFlight`
  guard + flag-default-OFF make a real double-exit vanishingly unlikely; a true atomic fix is the deferred PR.
- **rag-selfrag-hyde-decision (S) — DECISION: SKIP all four now.** The recall gap HyDE/Self-RAG/sentence-
  window/contextual-compression address is already covered by domain-tuned `voyage-finance-2` embeddings + the
  hard symbol metadata filter (`vector-db.ts:572`) + the cross-encoder reranker + over-fetch. Strategy queries
  are already elaborated pseudo-documents (`strategy.ts:299`); HyDE would add an LLM round-trip per symbol for
  near-zero embedding-space movement on a latency-sensitive chat path + a deterministic money path. Revisit
  ONLY if relevance-floor telemetry shows the candidate pool is frequently empty/weak for legitimate queries
  (a measured problem, not a speculative one). No code now.

## Verification
- risk-breaker.test.ts: 13 tests pass (PR #186).
- rag-wire-filters: `tsc --noEmit` clean; `vector-db-retrieval` + `chat-orchestrator` tests pass (21); full
  trio via land.sh.
