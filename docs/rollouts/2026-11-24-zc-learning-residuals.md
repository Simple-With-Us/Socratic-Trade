# 2026-11-24 — ST-4678 Learning residuals: failover weighting, real Green/Red parity receipt, horizon-matched Red efficacy, RAG outcome-lift eval, memory-write retry outbox

## 1. Context & Objective

Close the small residual gaps left in the learning plumbing and Red Team context parity that PR #5466 (ST-4665) landed, plus two roadmap items it did not cover (ST-4678, child of ST-4668).  The reconciliation found that the SQLite/FTS5 failover retrieval path still weighted after truncation, the Green/Red parity receipt compared the Green evidence pack with itself, and the Red efficacy snapshot omitted the horizon-matched approved-hold arguments.  None of these changes alter order sizing, stops, or order placement.

## 2. Changes Made

Item 1 — failover-path usefulness weighting before truncation: `localFilingsFailover` in `src/lib/strategy.ts` now overfetches lexical candidates (`Math.max(targetLimit + 4, targetLimit * 2)`) and applies `stampUsefulnessOrderOnChunks(applyRetrievalUsefulnessWeighting(...))` before the `limit` slice, mirroring the vector path's `retrieveWeighted`, so a usefulness-promoted chunk outside the lexical top-k can still enter the dossier.  The dead `void isCompactRagSummaryDocType` statement and its now-unused import were removed.

Item 2 — a real Green/Red parity receipt: `compareRedTeamContextParity` in `src/lib/red-team.ts` compares the documented reviewer-contract keys (`RED_TEAM_REVIEW_CONTEXT_KEYS`) that are non-empty in the Green proposal context against those non-empty in the projected Red context and names every dropped key (`RedTeamContextParityReceipt { matches, missingKeys }`).  `proposeTrades` in `src/lib/strategy.ts` now builds the `parityReceipt` from this key-set comparison instead of `compareGreenRedParity(evidencePack, redEvidencePack)` (which rebuilt the Red pack from the same refs and always matched).  Evidence-pack hash parity still travels verbatim via `evidenceManifest`; the projection, the contract keys, and the prompt templates are unchanged.

Item 3 — horizon-matched Red efficacy: `approvedHoldStatsFromClosedLots` and `buildRedTeamEfficacySnapshot` in `src/lib/performance.ts` derive the approved book's median realized hold (calendar days) and sample size from the same closed lots Green's scorecards grade, and build the efficacy snapshot carrying the `horizon` disclosure.  `proposeTrades` passes those approved-hold arguments into the snapshot, so the efficacy Red sees equals a direct `getRedTeamEfficacy` call with the same horizon; with no closed lots the prior 'not supplied' disclosure is preserved.

Item 4 — RAG outcome-lift scorecard (offline eval): `scripts/eval/rag-outcome-lift.ts` reads matured closed decisions (status placed/filled with a won/lost/flat outcome) from a SQLite path given by a required `--db` flag, splits them by whether `socratic_decisions.rag_attributions` includes a RAG retrieval, and prints mean/median outcome, win rate and count per bucket at each matured horizon (1d, 5d = the persisted 1w row, holding) with a 95% normal-approximation CI.  The pure aggregation lives in `scripts/eval/rag-outcome-lift-score.ts`; `eval:rag-outcome-lift` was registered in `package.json` like its sibling eval scripts.  No network, no LLM, no writes, and no default database path.

Item 5 — memory-write retry outbox: a new user-scoped `memory_write_outbox` table (migration 105 in `src/lib/db.ts`, CRUD + bounded drain in `src/lib/db-memory-outbox.ts`, listed in `DELETE_TABLES_BY_USER_ID` in `src/lib/account-deletion.ts`) gives the fail-open memory writers a durable retry.  The catch sites in `src/lib/experience-memory.ts` (closed-lot experience), `src/lib/db-socratic.ts` (decision re-index, both the lifecycle hook and the outcome write), and `src/lib/chat/coach-learning.ts` (coach-URL lesson vector) now enqueue the kind + payload instead of only warning.  `drainMemoryWriteOutbox` replays each entry through the existing writer for its kind, deletes on success, backs off on failure, and drops after `MEMORY_WRITE_MAX_ATTEMPTS` (5) with one warning; it is called at the start of the periodic `matureSocraticDecisionOutcomes` pass in `src/lib/outcome-engine.ts`.  The coach-URL accession is now a deterministic content hash (`coachUrlLessonAccession`) so a replay reconciles in place.

Moved from ST-4677 for file ownership: the stale 'known v1 gap' comment in `src/lib/experience-memory.ts` now states what actually happens today — live fills sit at `pending_reconciliation` until the broker confirms, and `strategy-execution.ts` re-fires the hook when the receipt flips to `filled` (the only point live closed lots become experience memory), with ST-4653 broker-native bracket exit legs firing it from `fill-reconciliation.ts`.

### Exact Touched Files

- `src/lib/strategy.ts`
- `src/lib/red-team.ts`
- `src/lib/performance.ts`
- `src/lib/db.ts`
- `src/lib/db-memory-outbox.ts (new)`
- `src/lib/db-socratic.ts`
- `src/lib/experience-memory.ts`
- `src/lib/chat/coach-learning.ts`
- `src/lib/outcome-engine.ts`
- `src/lib/account-deletion.ts`
- `scripts/eval/rag-outcome-lift.ts (new)`
- `scripts/eval/rag-outcome-lift-score.ts (new)`
- `package.json`
- `test/retrieval-usefulness.test.ts`
- `test/red-team-context-projection.test.ts`
- `test/red-team-efficacy-honesty.test.ts`
- `test/rag-outcome-lift.test.ts (new)`
- `test/memory-write-outbox.test.ts (new)`
- `STATUS.md`
- `docs/rollouts/2026-11-24-zc-learning-residuals.md (new)`

## 3. Decisions & Trade-offs

Outbox design: the table stores `id, user_id, kind, payload (JSON), attempts, last_error, next_attempt_at, created_at`.  Three kinds map to the existing writers — `closed-lot-experience` replays `recordClosedLotExperienceCore`, `socratic-decision-reindex` re-fetches the decision and calls `indexSocraticDecisionMemory`, and `coach-url-lesson` calls `indexStandaloneLesson`.  `recordClosedLotExperience` was split into a throwing core (used by the drain) and the fail-open public wrapper (catch -> enqueue -> warn -> null), so the money-path hook keeps its never-throw contract while the drain can count genuine failures.  Both enqueue and drain are fail-safe: neither can throw into its caller, and a deleted decision is a no-op success on replay.
Drain call site: `src/lib/scheduler.ts` and `src/lib/strategy-execution.ts` are CODEOWNERS owner-merge paths and were not edited, so the drain runs at the start of the periodic outcome-engine pass (`matureSocraticDecisionOutcomes`) instead.  An empty outbox is a single cheap SELECT, so the common case adds nothing.
Attempt cap and backoff: `MEMORY_WRITE_MAX_ATTEMPTS = 5`; exponential backoff from `MEMORY_WRITE_BACKOFF_BASE_MS = 60_000` doubling per attempt, capped at `MEMORY_WRITE_BACKOFF_MAX_MS = 3_600_000` (1 h).  After the cap the entry is dropped (not parked) with one warning, bounding outbox growth.
Parity receipt scope: the receipt compares only the documented reviewer-contract keys, so intentionally-dropped Green-only bulk (marketScan, the full retrievedFinancialContext) is never reported as missing.  The receipt value is diagnostic metadata; the set of context keys passed to Red and the prompt wording are unchanged.
Horizon mapping: the outcome engine grades daily horizons 1d (1 trading day) and 1w (5 trading days), so the scorecard reports 1d, 5d (= the persisted 1w row) and holding (the headline realized return).  The RAG bucket is any decision whose `rag_attributions` ledger carries a retrieved-chunk ref (filings RAG plus episodic analog/coaching retrievals).

## 4. Verification State

The full `npm test` and `npm run build` gate was NOT run by this session — this box hosts production, so the lead runs the serialized full gate before push.  Node on this box is v22 (CI uses v26); the known local-only `test/cpuprofile-summary.test.ts` failure on Node 22 was not exercised.

Commands run (all from the lane worktree):

```bash
npm run lint                                  # 0 errors (916 grandfathered warnings)
npx vitest run test/retrieval-usefulness.test.ts                       # 18 passed
npx vitest run test/red-team-context-projection.test.ts                # 12 passed
npx vitest run test/red-team-efficacy-honesty.test.ts test/strategy-rag-timeout-skip.test.ts   # 15 passed
npx vitest run test/strategy-prompt-safety.test.ts test/strategy-episodic-injection.test.ts test/retry-red-team.test.ts test/evidence-pack.test.ts   # 19 passed
npx vitest run test/rag-outcome-lift.test.ts                           # 6 passed
npx vitest run test/memory-write-outbox.test.ts test/account-deletion-coverage.test.ts         # 13 passed
npx vitest run test/memory-write-outbox.test.ts test/coach-learning.test.ts test/experience-memory.test.ts test/socratic-memory.test.ts test/pending-fill-reconcile-refire.test.ts   # 63 passed
npx vitest run test/outcome-engine.test.ts                             # 22 passed
```

The RAG outcome-lift CLI was also smoke-tested offline against a throwaway temp SQLite DB: it refuses to run without `--db` (exit 2) and prints both the table and `--json` output correctly.  `npx tsc --noEmit` was not run per the task constraint; type correctness is covered by the lead's serialized full gate.

## 5. Next Steps & Blockers

The lead merges `origin/main` (now a61b531789) at push time — this lane was deliberately not merged or rebased.  Push `zc/4678-learning-residuals`, open the PR for ST-4678 through the relay, pass Kody review and the `verify` CI gate, and merge through the queue.  `src/lib/scheduler.ts` and `src/lib/strategy-execution.ts` were not touched; the drain lives in the outcome-engine pass.

## 6. Zero-Code Findings

None.
