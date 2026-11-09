# 2026-06-26 — Improvement program: status + Codex handoff

Single source of truth for the 14-item RAG / learning-loop / risk / observability program. Reflects live
state as of this note. Companion to `docs/improvement-program-2026-06-26.md` (the per-item spec table). All
work was built by a model-tiered subagent team (sonnet default; opus design + dual opus review for money-path
items) and verified to `tsc --noEmit` + targeted tests; each PR additionally runs the full `verify` trio
(tsc → test → build) in CI.

## TL;DR
- **12 of 14 user-listed items are DONE** (merged or in-review); **1 is NOT STARTED** (multi-query/RRF —
  genuinely last because it serializes on `vector-db.ts` + `strategy.ts`); **1 is a deliberate SKIP**
  (Self-RAG/HyDE/sentence-window/contextual-compression, with rationale). The "karpathy/autoresearch" item is
  a **research read**, not a build (the planner misread it as a feature — ignore that).
- Everything additive + flag-gated where it changes money-path behavior. **No `paperMode` flip. No live orders.**

## Merged to `main` (9 PRs)
| PR | Item | What landed | Flag (default) |
|----|------|-------------|----------------|
| #186 | risk-breaker tests (#2) | `test/risk-breaker.test.ts` (13) — drawdown/daily-loss breaker, HWM/SOD persistence | n/a (tests) |
| #190 | four-side P&L (#2) | `calculatePnl` short/cover/interleave realized-P&L + notional cross-boundary (8 tests). **No prod bug found.** | n/a (tests) |
| #187 | RAG filters (#1/#6) | `defaultMinScore()` (`VECTOR_MIN_SCORE`=0.30) wired into strategy + chat; `buildExtraFilters` made **casing-tolerant** (10-K vs 8-k) | no flag (advisory) |
| #191 | embed disclosures (#3) | `web-sources/disclosure-rag.ts` → congress/insider as RAG docs via `storeContexts`; `acceptance_datetime`=disclosure date | `RAG_EMBED_DISCLOSURES` (off) |
| #193 | scheduler lease (#3) | `scheduler-lease.ts` CAS lease in `settings` KV (no migration); single-leader tick gate; SIGTERM/SIGINT/beforeExit release; /health+/ready | `SCHEDULER_SINGLE_LEADER` (off) |
| #195 | reasoning-diversity (#8) | `rationale-diversity.ts` (char-trigram Jaccard); per-run collapse metric; advisory-only via `audit()` | no flag (advisory, never blocks) |
| #197 | staleness-gate (#5) | `maxQuoteAgeSec`/`maxFundamentalsAgeSec` on `TradingPolicy`; OPENING-only fail-safe block in `evaluateTradeProposal` | both unset = off |
| #192 | langfuse evals (#6/#7) | `scripts/eval/{dataset,score,run-offline}.ts` + `npm run eval:offline` (15/15); MockLLM default, real-providers/Langfuse opt-in; 49 tests. **12 Codex comments addressed.** | env-gated (offline default) |
| #196 | hybrid BM25 (#4) | `rag/hybrid.ts` BM25+RRF over the dense candidate pool, before rerank; reusable `rrfFuse`. **2 Codex comments addressed.** | `HYBRID_RETRIEVAL` (off) |

## Open / remaining (what Codex can pick up)

### A. PR #199 — coarse-credit attribution (#7/#4) — IN REVIEW, finish the merge
- **Branch:** `agent/claude-coarse-credit`. Code complete; dual opus review all-green; 47 tests pass; tsc clean.
- **What it does (all additive, default-safe):**
  - (A, the real bug) attribution credited 100% of realized P&L to the EXIT run (`addAttribution` keyed by the
    closing fill's runId) → the ENTRY-decision run got 0. Added NEW optional `RunAttribution.realizedPnlAsEntry`
    / `realizedPnlAsExit` + a separate `addEntryAttribution`; existing `realizedPnl` semantics UNCHANGED
    (all consumers grepped). Any consumer that switches to entry-credit for tuning must be flag-gated off.
  - (B) read-path plumbing for `ClosedLot.mae/mfe` (DB columns + post-mortem writer already existed); undefined
    when not computed (no fabrication). No MAE/MFE-weighted credit added.
  - (C) `strategy-tuning.ts` now WITHHOLDS weight changes the OOS gate couldn't validate (was keep-with-caution).
- **To land:** (1) it is currently BEHIND `main` — `git merge origin/main` (clean last time), push. (2) When the
  Codex reviewer (`chatgpt-codex-connector`) posts inline comments, address the legitimate ones, then RESOLVE
  the review threads (see "Merge mechanics" below) — the branch policy requires all conversations resolved.
  (3) `gh pr merge 199 --squash --auto`.
- **Docs owed (deferred to the consolidation PR, see C):** STATUS.md entry + a rollout note + flip the item
  #7/#4 row to DONE. A rollout note already exists for it? No — coarse-credit was committed code-only; add one.

### B. Multi-query / RRF — RAG-Fusion (#2) — NOT STARTED (the last build)
- **Why last:** it edits the `vector-db.ts` retrieval region (now also touched by #187 wire-filters + #196
  hybrid) and `strategy.ts`; build it on `main` AFTER #199 lands so there's no collision. It **reuses
  `rrfFuse` from `src/lib/rag/hybrid.ts`** (already merged).
- **Spec (opus, from the program doc "Opus specs" section), do Stage 1 only:**
  - Stage 1: template-mode multi-query — derive a few deterministic query variants, embed them in ONE batched
    `embedWithRetry(voyage, [variants], ...)` call (the embed call already takes an array, so cost stays ~flat),
    retrieve a candidate list per variant, **RRF-fuse the lists via the existing `rrfFuse`** BEFORE the
    cross-encoder rerank (rerank still runs against the TRUE query for final precision). Flag-gated OFF
    (`RAG_MULTIQUERY` or similar); when off, byte-for-byte the current single-query path.
  - Stage 2 (LATER, separate PR, do NOT do now): LLM-generated query variants (adds an LLM round-trip).
  - New `test/vector-db-fusion.test.ts`: variant generation determinism, multi-list RRF fusion, flag gate.
- **Caution:** preserve the landed dense path (minScore floor, casing-tolerant docType filter, hybrid fusion,
  rerank). Advisory RAG, not money-path.

### C. Final consolidation docs PR (small, do after #199 + multiquery)
- Flip the remaining item rows to DONE in `docs/improvement-program-2026-06-26.md`, add STATUS.md entries +
  rollout notes for coarse-credit and multiquery. (Per-PR shared-doc edits were deliberately minimized to avoid
  the STATUS.md / program-doc merge-conflict cascade — see "Merge mechanics".)

### D. Research read — karpathy/autoresearch (#9) — NOT a build
- The planner agent misread this as an "autonomous tuning loop" feature. It is a **research read only**: skim
  karpathy/autoresearch for ideas, write findings into a doc, propose follow-ups. Do NOT auto-build a tuning
  loop from it.

### E. DECISION — Self-RAG / HyDE / sentence-window / contextual-compression (#5 "reconsider") — SKIP
- Documented decision (program doc "Opus specs"): the recall gap these target is already covered by the
  domain embedder (`voyage-finance-2`) + the hard symbol metadata filter + the cross-encoder reranker +
  over-fetch (and now hybrid BM25). Revisit ONLY if relevance-floor telemetry shows frequently empty/weak
  candidate pools for legitimate queries. No code.

## Merge mechanics (IMPORTANT — read before landing anything)
1. **`verify` is the only required status check** (repo ruleset). It runs `tsc → test → build`. It must be green.
   `gh pr merge <n> --squash --admin` does NOT bypass it.
2. **The branch policy ALSO requires all review conversations resolved.** The Codex reviewer
   (`chatgpt-codex-connector[bot]`) leaves ~2-12 inline comments per PR. Until those threads are resolved, the
   PR is `mergeStateStatus: BLOCKED` ("All comments must be resolved") even with `verify` green.
3. **The `autofix` CI bot is BROKEN** (`anthropics/claude-code-action`, added in #188). It is supposed to
   address Codex comments and resolve the threads automatically, but it errors on its own Bun/tsconfig internal
   bug ("Internal error: directory mismatch for directory .../tsconfig.json") before doing any work. **Until it
   is fixed, every PR stalls with unresolved Codex comments and must be handled manually.** (A separate task was
   spawned to fix the action.) To resolve threads manually after addressing the comments:
   ```bash
   gh api graphql -f query='query { repository(owner:"jaywedgeworth22", name:"agentic-trading") {
     pullRequest(number:<N>) { reviewThreads(first:50){ nodes { id isResolved } } } } }' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .id' \
   | while read tid; do gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:\"$tid\"}){ thread { isResolved } } }"; done
   ```
4. **Shared-doc cascade:** every PR touching `STATUS.md` + `docs/improvement-program-2026-06-26.md` conflicts
   with the others on those two files. Mitigation used here: keep code PRs to code + a NEW rollout note (new
   files never conflict) and batch the shared-doc status flips into a single consolidation PR (C above).
5. Land via `scripts/land.sh` (refuses dirty tree / main / stale-overlap; merges origin/main; runs the trio;
   pushes; opens a PR). Auto-merge with `gh pr merge <n> --squash --auto`.

## Worktrees used (each its own branch + node_modules)
- `~/Code/agentic-trading-program`, `~/Code/agentic-trading-ragfilters`, `~/Code/agentic-trading-stops` —
  reused across items (synced to `origin/main` per item). Git author email is the noreply address (repo-local).

## Verification summary
- Per item: `tsc --noEmit` clean + the item's targeted vitest file(s) green; `verify` trio green in CI on each
  merged PR. Money-path items (scheduler lease, staleness gate, coarse-credit) additionally got opus design +
  dual opus review (correctness + money-safety lenses), all-green.
