# 2026-06-21 — Crossover-learning loop: FACT-TIER slice

## Summary
Built the fact-tier slice (Phases 0-6) of the tiered crossover-learning loop from
`docs/design/crossover-learning-loop.md`. Introduces a `learned_context` SQLite store, a
fail-closed risk classifier, a write/read store, two producers (chat salience + post-mortem),
and an advisory-only consumption seam in the strategy prompt. The risk/strategy-directive tiers,
the pending-changes queue, and the A2 prompt-block (Phase 7) are explicitly DEFERRED per the
owner-resolved decisions.

The whole point of the slice is the safety property, pinned by Phase 0: learned context reaches
the LLM ONLY as advisory prompt text and is NEVER an input to `applyDeterministicSizing` or to
`scoringWeights`.

## Why (owner-resolved decisions applied verbatim)
1. **Phase 0 first.** The safety regression test was written before any consumption code. It
   asserts `applyDeterministicSizing` output is byte-identical whether or not `learned_context`
   rows exist, and that its signature exposes no learned-context channel.
2. **Parallel to reflection.** The structured `learned_context` rows run IN PARALLEL with the
   existing `reflection_summary` injection — reflection is neither gated nor removed.
3. **Private-only.** Fact rows are written `scope:'private'` only. Cross-user shared-fact reads
   (`includeShared`/`contributeShared`) are wired through the signatures but never enabled.
4. **Fail-closed classifier.** `classifyRiskTier` returns `'risk'` for anything not clearly a
   non-risk fact (UNKNOWN → risk), using the conservative default `RISK_SUBJECTS` set plus
   intent keywords (increase/decrease/raise/lower/cap/limit/allocate/size/aggressive/conservative/
   leverage/%). Chat-origin candidates are hard-capped at `'fact'` — a chat message can never
   produce a risk-tier change.
5. **Drop, don't queue.** Risk/strategy-directive candidates are audit-logged-and-dropped (no
   pending queue in this slice). Fact rows are consumed as advisory DATA at the ragContext seam,
   beside `retrievedFinancialContext`. The dormant `pattern`/`decision` salience kinds are lit up
   as producers into `learned_context` (NOT `user_memory`).

## Files
- `src/lib/types.ts` — added `LearnedContextRow`, `LearnedContextCandidate`, and the
  scope/kind/origin/risk-tier string unions.
- `src/lib/db.ts` — added the `learned_context` table (+ two indexes) and userId-scoped helpers:
  `insertLearnedContext`, `findLiveLearnedContextBySubject`, `listLearnedContextForDecision`,
  `listLearnedContext`, `supersedeLearnedContext`.
- `src/lib/learned-context/classify.ts` (NEW) — `classifyRiskTier` (fail-closed), `RISK_SUBJECTS`,
  `RISK_INTENT_KEYWORDS`, numeric-risk matcher, `hasPii` (reuses salience PII patterns).
- `src/lib/learned-context/store.ts` (NEW) — `ingestLearned` (classify + PII gate, fact→write,
  risk→drop+audit, chat hard-cap) and `retrieveLearnedContext` (READ-ONLY advisory strings).
- `src/lib/memory/salience.ts` — added `extractLearnedCandidates` emitting the dormant
  `pattern`/`decision` kinds as durable learned-FACT candidates (carries the raw phrase as
  `intent` so risk-adjacent prose is caught by the classifier). `extractCandidates` (user_memory)
  unchanged.
- `src/lib/chat/orchestrator.ts` — routes `extractLearnedCandidates` through `ingestLearned(..,
  "chat")` after `ingestMessage`. `chat/tools.ts` untouched (chat stays type-isolated from the brain).
- `src/lib/strategy.ts` — exported `applyDeterministicSizing` (so the safety test can assert
  invariance); added a parallel `retrieveLearnedContext` call at the ragContext build; threaded a
  new optional `learnedContext` field through `proposeTrades` into `userContent` beside
  `retrievedFinancialContext`; added one system-prompt DATA-not-commands line. NOT passed to
  sizing or `scanMarket` scoringWeights.
- `src/lib/post-mortem.ts` — added `writeThesisTrackRecordFacts`, emitting durable QUALITATIVE
  (no-numeric) per-thesis track-record facts into `learned_context` (origin `autonomous`),
  alongside — not gating — the `reflection_summary` write.
- `test/learned-context.test.ts` (NEW) — 17 tests: Phase 0 safety invariant, classifier,
  store write/drop/PII/chat-hard-cap, chat producer routing, retrieval relevance.

## Verification
```
cd /Users/jay/apps/wt-learn && npx tsc --noEmit            # clean
cd /Users/jay/apps/wt-learn && npm test                    # 72 files, 610 tests, all pass
cd /Users/jay/apps/wt-learn && npx vitest run test/learned-context.test.ts  # 17/17 pass
```

## Follow-ups (DEFERRED to the second slice)
- Phase 7: `learned_context_pending` table, confirmation rail, A2 `prompt-block.ts`, the
  pending-changes UI, and routing risk-tier candidates to the existing
  `applyStrategyTuning → PUT /api/policy` rail with a typed second gate.
- Cross-user shared facts (`scope:'shared'`, `includeShared`/`contributeShared`) — signatures
  are wired through but the path is disabled. Needs a reviewed slice; the data-not-commands fence
  must be confirmed to cover the new `learnedContext` prompt section before enabling.
- Owner review of the exact `RISK_SUBJECTS` + intent-keyword vocabulary (security-critical;
  over-conservative recreates confirmation fatigue, under-conservative is the safety hole).
- Expiry/supersede policy: `expires_at` defaults to null today; supersede-on-write is implemented
  for matching `(kind, subject, symbol)` but no time-based expiry yet.
- Two autonomous→brain channels now coexist temporarily (opaque `reflection_summary` AND
  structured rows) — by design; a later agent must not assume reflection was already replaced.
```
