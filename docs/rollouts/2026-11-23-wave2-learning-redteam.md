# 2026-11-23 — Wave 2B Learned-Context Retention, Retrieval-Usefulness Join, Held-First Dossier Budget & Red Team Context Parity (ST-4665)

## 1. Context & Objective

Close three interconnected learning-loop, RAG dossier budgeting, and Red Team adversarial context blind spots identified in the Wave 2 audit (`ST-4665`).  Prior to this change, multi-lesson outputs in post-mortem outcomes, coach learning, and chat salience overwrote earlier lessons on the same symbol/thesis via coarse `subject` keys and `listLearnedContextForDecision` excluded owner-approved active `risk`-tier lessons; episodic analog prompt-consumption attribution failed to match rendered `formatAnalogCard` blocks and dropped `"PORTFOLIO"` attributions while `orderChunksForProposer` wiped usefulness-weighted chunk order and scout filings could crowd out held-position dossiers or a single vector timeout killed all remaining RAG and episodic memory; and Red Team reviews dropped critical Green decision context and reviewed blind on manual retry (`retryProposalRedTeam`) and approval-time final-size re-review (`executeProposal`).

## 2. Changes Made

- **Learned-Context Multi-Lesson Retention & Approved Risk-Tier Retrieval (`src/lib/outcome-engine.ts`, `src/lib/chat/coach-learning.ts`, `src/lib/memory/salience.ts`, `src/lib/db-learning.ts`)**:
  - Updated post-mortem lesson ingestion in `src/lib/outcome-engine.ts` to key each lesson as `decision_lesson:${decisionCase.symbol ?? "portfolio"}:${decisionCase.thesisTag ?? "untagged"}${regimeSegment}:${decisionCase.id}:${idx}` (including `:regime` when set), preventing Lesson #2 from self-overwriting Lesson #1 on the same decision case.
  - Updated `src/lib/chat/coach-learning.ts` and `src/lib/memory/salience.ts` to append a deterministic 12-hex SHA-256 content/URL digest suffix to `coach-directive`, `coach-url-lesson`, `pattern`, and `fact` subject keys so distinct lessons on the same ticker or channel coexist while identical text reconciles in-place.
  - Updated `listLearnedContextForDecision` in `src/lib/db-learning.ts` to include owner-approved active private `risk_tier = 'risk'` rows from `learned_context` alongside `risk_tier = 'fact'` rows, keeping unapproved drafts in `learned_context_pending`, `strategy-directive` rows, and other users' private `risk` rows excluded.
- **Episodic Retrieval-Usefulness Join, Pre-Limit Usefulness Ordering, Held-First Dossier Budgets & 2-Strike Vector Failover (`src/lib/strategy.ts`, `src/lib/socratic-runtime.ts`)**:
  - Stored `formatAnalogCard(chunk)` for episodic analog chunks and `formatCoachingChunk(chunk, metaSym)` for coaching chunks in `ragPromptCandidates.serializedText` (`src/lib/strategy.ts`) so `evaluateRagPromptConsumption` matches the actual rendered prompt cards, and updated `buildSocraticDecisionCase` (`src/lib/socratic-runtime.ts`) to retain `"PORTFOLIO"` `ragAttributions` alongside the proposal's symbol.
  - Added `retrieveWeighted` and `stampUsefulnessOrderOnChunks()` in `src/lib/strategy.ts` so `applyRetrievalUsefulnessWeighting(chunks, userId)` executes on overfetched candidates *before* `limit` truncation and stamps monotonically decreasing synthetic `relevanceScore` values so `orderChunksForProposer` preserves usefulness-weighted ordering within summary and non-summary buckets.
  - Ordered filings dossier assembly **Held -> Deep -> Scout** and enforced explicit per-symbol character caps (`HELD_DOSSIER_CHAR_BUDGET = 6_000`, `DEEP_DOSSIER_CHAR_BUDGET = 4_500`, `SCOUT_DOSSIER_CHAR_BUDGET = 2_000`) via `orderAndBudgetRagDossierSections()` before global `applyEvidenceBudget` truncation.
  - Replaced single-strike run-killing `ragTimedOutThisRun` with a 2-strike consecutive timeout breaker (`EXTERNAL_VECTOR_TIMEOUT_BREAKER_STRIKES = 2`) on external vector I/O only, failing over on timeout or open breaker to local SQLite/FTS5 lexical abstracts (`searchCorpusWideLexicalCandidates`) and never skipping episodic decision memory (`retrieveDecisionExperiences`).
- **Red Team Context Parity & Persisted Retry / Final-Size Review Context (`src/lib/red-team.ts`, `src/lib/retry-red-team.ts`, `src/lib/strategy-execution.ts`, `src/lib/types.ts`)**:
  - Expanded `RedTeamReviewContext` and `RED_TEAM_REVIEW_CONTEXT_KEYS` in `src/lib/red-team.ts` to retain `drawdownAdvisory`, `budgetAdvisory`, `confidenceCalibration`, `learnedContext`, `reflectionSummary`, `sectorOutcomes`, `factorOutcomes`, `signalEfficacy`, `sourceValueScorecard`, `strategyOverlays`, `skippedCounterfactuals`, `marketInternals`, `activeProtection`, `recentOrders`, `taxContext`, runner-up `topCandidates` (projected from `marketScan.topCandidates.slice(0, 8)`), `redTeamEfficacy` (`getRedTeamEfficacy()`), `parityReceipt` (`compareGreenRedParity()`), and held-first `reviewerFilingsPack`.
  - Added `PersistedAdversaryContextSchema` (using Zod `.strip()`), `compactAdversaryContextForPersistence()`, `parsePersistedAdversaryContext()`, and `verifyRedTeamEvidenceParity()` in `src/lib/red-team.ts`, persisted the compact `adversaryContext` snapshot on pending opening proposals in `src/lib/strategy.ts`, and restored it in `src/lib/retry-red-team.ts` and `src/lib/strategy-execution.ts`.

### Exact Touched Files

- `src/lib/outcome-engine.ts`
- `src/lib/chat/coach-learning.ts`
- `src/lib/memory/salience.ts`
- `src/lib/db-learning.ts`
- `src/lib/strategy.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/red-team.ts`
- `src/lib/retry-red-team.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/types.ts`
- `test/coach-learning.test.ts`
- `test/prompt-trust-boundary.test.ts`
- `test/salience-ticker-binding.test.ts`
- `test/learned-context.test.ts`
- `test/learned-context-pending.test.ts`
- `test/outcome-engine.test.ts`
- `test/retrieval-usefulness.test.ts`
- `test/red-team-context-projection.test.ts`
- `test/strategy-prompt-safety.test.ts`
- `test/strategy-episodic-injection.test.ts`
- `test/retry-red-team.test.ts`
- `STATUS.md`
- `docs/rollouts/2026-11-23-wave2-learning-redteam.md`

## 3. Decisions & Trade-offs

- **Deterministic content-hash suffix vs random UUID for subject keys**: Using a 12-hex SHA-256 prefix of the normalized value/URL in `coach-learning.ts` and `salience.ts` (and `${decisionId}:${idx}` + regime in `outcome-engine.ts`) ensures distinct lessons never collide while repeated ingestion of the exact same lesson still reconciles in-place via `findLiveLearnedContextBySubject`.
- **Private-only scope for active `risk`-tier rows in `listLearnedContextForDecision`**: When `includeShared` is enabled, `fact`-tier rows can be shared across users (`user_id = ? OR scope = 'shared'`), whereas `risk`-tier rows are restricted to `user_id = ? AND scope = 'private'` so another user's risk-tier observation never leaks into a decision prompt via shared scope.
- **Bounded persistence for `adversaryContext`**: `compactAdversaryContextForPersistence` validates with `PersistedAdversaryContextSchema` (`.strip()`) and bounds large text/array fields (`learnedContext`, `reflectionSummary`, `closestHistoricalAnalogs`, `ownerCoaching`, `reviewerFilingsPack`, `topCandidates`, `recentOrders`) so SQLite proposal rows remain compact while giving manual retries and approval-time final-size Red reviews complete decision context.

## 4. Verification State

- `cd <install-path> && npm run lint` — passes with `0` errors.
- `cd <install-path> && npx tsc --noEmit` — passes with `0` type errors.
- `cd <install-path> && npx vitest run test/coach-learning.test.ts test/prompt-trust-boundary.test.ts test/salience-ticker-binding.test.ts test/salience-llm.test.ts test/learned-context.test.ts test/learned-context-pending.test.ts test/learned-context-sharing.test.ts test/learning-review.test.ts test/outcome-engine.test.ts test/retrieval-usefulness.test.ts test/filings-chunk-depth.test.ts test/red-team-context-projection.test.ts test/strategy-prompt-safety.test.ts test/strategy-episodic-injection.test.ts test/retry-red-team.test.ts test/final-size-red-autonomous.test.ts` — all 16 test suites pass.
- `cd <install-path> && npm run build` — full Next.js production build passes cleanly.

## 5. Next Steps & Blockers

- Push `ag/kk-wave2-learning-redteam`, open/update PR for `ST-4665`, pass CI `verify` and review, and merge through the queue.

## 6. Zero-Code Findings

- None; all three Wave 2B scope items required code and test updates.
