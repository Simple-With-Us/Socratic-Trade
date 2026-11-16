# 2026-07-05 - claude-backlog-train

## Summary

A same-day, triage-first CLAUDE-lane backlog train: four independent isolated-worktree lanes
(prompt-safety fencing, usage-budget Phase 2 advisory wiring, durable due-jobs substrate, HyDE +
multi-query retrieval) were built, adversarially reviewed, and landed to `main` as four separate
PRs — #816, #819, #820, #822 — all merged 2026-07-05. This note is the session-level record tying
the four lanes together; the technical detail for each lane lives in its own per-lane rollout note
(linked below), not repeated here.

## Why

Owner-directed execution of the CLAUDE-lane backlog on `docs/EFFORT-LOG.md` (mirrors the canonical
live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`). Each lane was picked because it was either a
flagged "built-but-unwired" gap (usage-budget Phase 2: `evaluateBudgetForRun`/`cheaperModel` existed
and were unit-tested but had zero production callers), a documented deferred gap
(`outcome-horizons.ts`'s own comment on the intraday-sampling durability problem), a CR-H
prompt-injection-hardening item from the improvement audit, or a retrieval-quality upgrade already
queued (HyDE/multi-query). Before building, each lane's Planned-row description was checked against
current `main` to confirm it was still open — three rows turned out to already be done and were
triaged out rather than re-implemented (see below).

The usage-budget wiring in particular required applying this repo's binding advisory-guardrails
philosophy (`AGENTS.md` "Product philosophy" section: guardrails are owner-overridable preferences,
never hard cages) rather than the naive "just call the evaluator and enforce it" wiring the
deferred note's own caution implied would be dangerous. Two expert/adversarial reviews on this lane
converged on the same shape: advisory receipts always on (so the owner has data to decide), actual
enforcement strictly opt-in via the pre-existing `USAGE_BUDGET_ENFORCE` flag (default off), placed
after risk-reducing breakers and before any LLM call, with the downgrade scoped to an in-memory
policy object that can never leak into a persisted `setPolicy` call.

## Triage: 3 board rows already done, not re-implemented

Before starting the usage-budget/due-jobs/HyDE lanes, three adjacent Planned rows on
`docs/EFFORT-LOG.md` were checked against `main` and found to already be shipped:

- **RAG retrieval-quality eval harness** + its two prerequisite rows (golden-set anti-leakage
  lint; retrieval regression net) — already landed via PR #297 (`feat(rag): eval harness, rerank
  scoring, char-cap/doc_type/salience fixes (Workstream C)`) and PR #299 (`feat(rag): retrieval
  regression net + R1 strict as-of mode`).
- **Bull/Bear prompt eval + versioning harness** — already landed 2026-07-01 as part of the
  money-path landing: `STRATEGY_PROMPT_VERSION` discipline plus `npm run eval:strategy-offline`.
- **Per-user/day token-budget ceiling at trigger/strategy entry** — already landed via the PR #316
  series (per-user LLM reservation closing the concurrent-run TOCTOU). The "deferred" comment still
  present in `triggers.ts` refers to run-count caps, a different and still-open item, not the
  token-budget ceiling itself.

All three rows are annotated in place on `docs/EFFORT-LOG.md` (not deleted) with
`(triage 2026-07-05: already done — ...)` pointing at the PRs/mechanism that already closed them.

## Files

Each lane's exact touched files are listed in its own rollout note rather than re-listed here:

- `docs/rollouts/2026-07-05-prompt-safety-fencing.md` — PR #816.
- `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md` — PR #819.
- `docs/rollouts/2026-07-05-durable-due-jobs.md` — PR #820.
- `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md` — PR #822.

This closeout pass itself touched only: `docs/EFFORT-LOG.md` (moved the four In-Progress rows to
Completed with PR#/sha, annotated the three already-done Planned rows), `STATUS.md` (prepended this
summary section), and this new rollout note.

## Verification

Each lane ran its own local gate inside an isolated worktree before being handed to the central
landing operator, which then ran `scripts/land.sh`'s full gate (merge `origin/main`, `tsc --noEmit`
→ `npm test` → `npm run build`) immediately before each PR was opened/merged:

- **#816 (prompt-safety fencing):** full local gate green, 2577 tests total (incl. 31 in the new
  `test/prompt-safety.test.ts`, up from an initial 25 after the fence-escape review-fix pass, and 4
  in `test/strategy-prompt-safety.test.ts`); `tsc --noEmit` clean; `npm run lint` 0 errors.
- **#819 (usage-budget advisory wiring):** full local gate green, 2587 tests across 261 files
  (`npm test` run after the review-fix commit); `tsc --noEmit` clean; `npm run build` clean.
- **#820 (durable due-jobs substrate):** full local gate green; full suite 2529/2530 after the
  review-fix commit (the 1 pre-existing failure — `due_jobs` missing from account-deletion coverage
  — was fixed in a third commit on the same branch, bringing the suite fully green before merge);
  `tsc --noEmit` clean; `npm run build` clean.
- **#822 (HyDE + multi-query retrieval):** full local gate green, 2619 tests across 264 files;
  `tsc --noEmit` clean; `npm run build` clean.

All four PRs' required `verify` CI check (tsc → test → build), plus `smoke` and `gitleaks`, were
green on merge. Three of the four lanes had a genuine blocker caught by adversarial/expert review
**before** merge and fixed with a dedicated regression test in the same pass — see each lane's own
"Review fixes" section for full detail:

1. **Usage-budget (#819):** the enforcement block mutated the run's shared, in-memory `policy`
   object directly, so a same-run cap-breach demotion's `setPolicy({ ...policy, strategyAuthority:
   "propose" })` would have persisted the transient model downgrade to the DB permanently —
   contradicting the "never persisted, in-memory-only" contract the advisory design depends on.
   Fixed by introducing a derived `runPolicy` object that is the only thing passed to LLM-model-
   resolution call sites, while every `setPolicy`/`autoRevertOnCapBreach` call site keeps receiving
   the pristine `policy` object.
2. **Due-jobs (#820):** a lost-update race — `measureCase` builds its `outcome.outcomes` from a
   pass-start snapshot held across awaits, so its wholesale write could erase a 15m/1h horizon row
   the due-jobs worker had already persisted concurrently, even though the worker had already
   reported the job done. Fixed by re-merging against a fresh DB read of the persisted row
   immediately before every terminal/partial write, relying on `mergeHorizonRows`'s existing
   terminal-row-wins semantics to make the fix idempotent regardless of write order.
3. **HyDE/multi-query (#822):** the multi-query fan-out was fail-CLOSED, not fail-open — a bare
   `Promise.all` over per-variant embed+match calls meant one variant's rejected Voyage/Pinecone
   call discarded every other variant's already-successful results, returning empty filings context
   instead of falling back to the single-query path the module's own contract promised. Fixed so
   each fan-out call is caught individually and an all-fail case now falls back to plain
   single-query retrieval (i.e. behaves exactly as flags-off).

## Follow-ups

- **Headlines first-seen timestamps.** The prompt-safety evidence-age receipt (#816) covers only
  RAG chunks and learned facts in v1 — headlines carry no first-seen timestamp today. Persisting
  one (e.g. in the scan cache) would extend the receipt to news.
- **RAG eval comparing single- vs. multi-query before flipping the flags.** `RAG_MULTIQUERY` and
  `RAG_HYDE` (#822) both ship default OFF. No retrieval-quality eval yet compares single-query vs.
  multi-query vs. multi-query+HyDE recall@k/MRR on the existing
  `test/fixtures/rag-retrieval-eval-fixture.ts` harness — that comparison is the natural next step
  before either flag is considered for a default flip, giving the decision quantitative backing
  instead of "should help" reasoning alone.
- **Ops surface for `getDueJobStats`.** The due-jobs substrate (#820) exposes `getDueJobStats` but
  nothing surfaces it yet — a future addition to `/api/ops/snapshot` or an admin panel would give
  the owner visibility into queue depth/backlog without querying SQLite directly.
- **Outcome-engine lesson-pass budget exemption is documented-intentional, not a gap.** The
  outcome-engine's fire-and-forget lesson pass (`callLessonLlm`) does not pick up a same-run
  usage-budget downgrade (#819) because it runs detached from any single `runStrategyOnce`
  invocation's lifetime (can still be in flight after the triggering run returns, matures cases
  across accounts/runs) — there is no single well-defined "this run's downgrade" to hand it. Both
  call sites carry an "INTENTIONALLY EXEMPT" comment explaining this; it is not tracked as a
  follow-up to fix.
- **Board discrepancy note (unrelated to these four PRs, flagged for hygiene).** While auditing
  `docs/EFFORT-LOG.md` state during this closeout, a stray discrepancy was visible on the canonical
  live board (`/Users/jay/apps/TRADING-EFFORT-LOG.md`, not edited by this session per its
  instructions): a "PR #808 merged" row was recorded for Cursor's P0 `checkRegimeFlip` RMW fix work,
  but PR #808 does not exist — that work is actually tracked as an open PR (#805). The live board
  itself already carries a correction noting this (`PR #808 does not exist`); this note is a
  pointer for whoever next reconciles the live board, not a claim that this session touched it.

## Blockers

None — all four lanes landed clean same-day; the three review-caught issues above were fixed
before merge, not left as blockers.
