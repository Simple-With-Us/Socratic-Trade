# Evidence architecture, account-scoped learning, and GPT-5.6

Date: 2026-07-13  
Owner: CODEX  
Branch: `codex/evidence-architecture-program`  
State at this checkpoint: implementation, current-main reconciliation, local/landing verification,
and PR checks are complete; ready PR #1544 is open. Not merged, deployed, or production-verified.

> **Current truth (owner 2026-08-17):** paper→live pooling stays. The 20-paper+5-live transfer
> gate described below was later deleted (`src/lib/learning-transfer.ts` removed 2026-07-23;
> docs corrected 2026-08-18). Retrieval pools paper and live lots per user. See
> `docs/rollouts/2026-08-18-paper-live-pooling-cost.md`.

## Summary

- Added account-scoped relational/vector learning and (at this checkpoint) explicit, sample-gated
  paper-to-live research transfer — later removed; pooling is current retrieval. Legacy autonomous
  rows without reconstructable account provenance are quarantined.
- Removed the product Test Account create button/client helper/API creation/read exposure and added a
  production migration that purges legacy Test Accounts and associated simulated outcomes. The test
  broker remains unit-test infrastructure only.
- Widened pre-enrichment selection, added field-level evidence/failure receipts and deterministic
  source arbitration, deduplicated republished analyst consensus by upstream family, and retained
  source disagreements.
- Added immutable evidence references/packs, Green/Red evidence parity, exact opening-candidate
  enforcement, point-in-time retrieval, global context budgets, prompt-data containment, source
  coverage, shadow source ablations, and outcome-linked source-value telemetry.
- Applied the same containment/budget/evidence contract to Coach/chat, strategy tuning, Framework
  review, and learning review.
- Added GPT-5.6 Luna/Terra/Sol to all LLM surfaces with provider-supported reasoning effort and
  role-specific recommendations. Removed full GPT-5.4/5.5 from curated selectors while retaining
  Mini/Nano and custom/stored legacy IDs.

## Why

The app already gathered broad market, broker, filing, web, outcome, and learning data, but several
boundaries lost decision value: enrichment happened after a narrow rank; scalar merges hid source
quality/failure; Green and Red contexts could drift; paper/live and sibling-account learning could
contaminate each other; and each LLM surface budgeted/contained external text differently. The new
contracts make source use inspectable, account boundaries explicit, and outcome attribution possible
without pretending observational ablation is causal.

The source-by-source audit and residual gaps are documented in
`docs/reviews/2026-07-13-decision-evidence-architecture.md`.

## Files

Application/API/UI:

- `app/api/chat/route.ts`
- `app/api/connected-accounts/route.ts`
- `app/api/policy/route.ts`
- `app/console/assistant/chat.tsx`
- `app/console/assistant/models.tsx`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/console/lib/models.ts`
- `app/console/settings/brokers.tsx`
- `app/console/settings/learning-review.tsx`
- `app/console/settings/lib.ts`
- `app/console/strategy/page.tsx`
- `app/ui/llm-model-catalog.ts`

Core implementation:

- `src/lib/chat/llm.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/chat/prompt.ts`
- `src/lib/data-providers.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/db-learning.ts`
- `src/lib/db-profiles.ts`
- `src/lib/db.ts`
- `src/lib/evidence-budget.ts`
- `src/lib/evidence-facts.ts`
- `src/lib/evidence-pack.ts`
- `src/lib/evidence.ts`
- `src/lib/execution-mode.ts`
- `src/lib/experience-memory.ts`
- `src/lib/framework-review.ts`
- `src/lib/learned-context/store.ts`
- `src/lib/learning-review.ts`
- `src/lib/learning-transfer.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/market.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/model-rotation.ts`
- `src/lib/outcome-engine.ts`
- `src/lib/performance.ts`
- `src/lib/post-mortem.ts`
- `src/lib/prompt-safety.ts`
- `src/lib/socratic-memory.ts`
- `src/lib/source-value.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `src/lib/usage-budget.ts`
- `src/lib/vector-db.ts`

Tests:

- `test/chat-injection.test.ts`
- `test/chat-llm.test.ts`
- `test/congress-share.test.ts`
- `test/connected-accounts-route.test.ts`
- `test/data-providers.test.ts`
- `test/evidence-pack.test.ts`
- `test/experience-memory.test.ts`
- `test/learned-context-account-scope.test.ts`
- `test/learned-context-delete.test.ts`
- `test/learned-context-pending.test.ts`
- `test/learned-context-sharing.test.ts`
- `test/learned-context.test.ts`
- `test/learning-review-policy-route.test.ts`
- `test/learning-review.test.ts`
- `test/llm-request.test.ts`
- `test/market-preselection.test.ts`
- `test/model-rotation.test.ts`
- `test/outcome-engine.test.ts`
- `test/persistence-hardening.test.ts`
- `test/persistence-notification.test.ts`
- `test/prompt-safety.test.ts`
- `test/rag-doc-type-coverage.test.ts`
- `test/source-value.test.ts`
- `test/strategy-candidate-enforcement.test.ts`
- `test/strategy-episodic-injection.test.ts`
- `test/strategy-held-position-retrieval-scope.test.ts`
- `test/strategy-prompt-safety.test.ts`
- `test/strategy-tuning-reviews.test.ts`
- `test/vector-db-retrieval.test.ts`

Records/design:

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)
- `docs/chat-assistant-rag-learning.md`
- `docs/manager-model-options.md`
- `docs/phase-7-strategy.md`
- `docs/phase-9-web-sources.md`
- `docs/reviews/2026-07-13-decision-evidence-architecture.md`
- `docs/rollouts/2026-07-13-evidence-architecture-gpt56.md`

## Decisions

- Keep real broker paper accounts. Their outcomes stay exact-account scoped; only a corroborated
  aggregate thesis statement transfers to cross-account research.
- Delete the product Test Account, but preserve `TestBrokerGateway`/`broker: "test"` strictly for
  deterministic unit/integration tests.
- Treat source-value telemetry as observational and selection-biased. It may guide investigation,
  never automatically reweight source trust.
- Use Terra/Medium as the provisional OpenAI Green recommendation, Sol/High for Red and consequential
  review, and Luna/Low for high-volume Coach. Keep Mini/Nano because they remain cheaper than Luna.
- Do not request earnings-transcript RAG until a real licensed producer exists.
- No production configuration changes or corpus writes are part of this branch.

## Verification

Completed before current-main reconciliation:

- `npm run lint` — pass, 0 errors (435 grandfathered warnings).
- `npx tsc --noEmit` — pass.
- `npx vitest run test/model-rotation.test.ts test/llm-request.test.ts test/chat-llm.test.ts test/chat-injection.test.ts test/chat-orchestrator.test.ts test/chat-draft-policy.test.ts test/learning-review.test.ts test/learning-review-policy-route.test.ts test/framework-review.test.ts test/strategy-tuning.test.ts test/strategy-tuning-reviews.test.ts test/source-value.test.ts test/evidence.test.ts test/performance.test.ts test/strategy-prompt-safety.test.ts` — 15 files, 224 tests pass.
- `npx vitest run test/persistence-hardening.test.ts test/connected-accounts-route.test.ts test/model-rotation.test.ts` — 3 files, 41 tests pass.
- `git diff --check` — pass before documentation edits.

Current-main reconciliation:

- Merged `origin/main` at `1a90281b` and preserved its Red Team fallback chain/UI, defensive episodic
  retrieval fix, and exit-replacement state machine.
- Ordered the combined schema migrations as exit replacement 20–22, account-scoped learning 23,
  and product Test Account purge 24. The purge now removes matching `order_replacements` rows too.
- Resolved broker settings by retaining generic real-account capability display with no product Test
  Account special case.
- `npx tsc --noEmit` — pass after reconciliation.
- `npx vitest run test/persistence-hardening.test.ts test/connected-accounts-route.test.ts test/model-rotation.test.ts test/strategy-tuning-reviews.test.ts test/chat-injection.test.ts test/source-value.test.ts test/data-providers.test.ts test/red-team.test.ts test/order-replacement.test.ts` — 9 files, 205 tests pass after reconciliation.

Full required gate after reconciliation and final fixes:

- `npm run lint` — pass, 0 errors (448 grandfathered warnings).
- `npx tsc --noEmit` — pass.
- `npm test` — 355 files, 3,980 tests pass.
- `npm run build` — pass; Next.js generated all routes successfully.
- `git diff --check` — pass.
- `bash scripts/land.sh` — fetched current `origin/main` (already current), reran TypeScript, all
  3,980 tests, and the production build, pushed the branch, and opened ready PR #1544.
- PR #1544 checks — hosted lint/type/3,980-test/build gate, Playwright smoke, gitleaks, and aggregate
  `verify` all passed on commit `5734c13c`.

The first full-suite attempt exposed seven integration-test failures: five Congress sharing tests
were leaking real Yahoo/Stooq calls because `importOriginal(history)` traversed the DB/history cycle;
the test now supplies a cycle-free history mock. The outcome lesson fixture now carries an exact
internal test-infrastructure account and asserts account-scoped persistence. The strategy prompt
fixture now expects the accurate “deterministic fills / not a product account” description. The first
build also rejected `node:crypto` on the scheduler bundle path; the evidence pack now uses the
project-supported bare `crypto` import. Focused fixes (66 tests), the full suite, and the build pass.

## Follow-ups / risks

- Current `origin/main` is integrated and the combined migration/Red Team paths are verified.
- Source/provider recommendation quality starts with priors. Re-adjudicate from account-scoped
  realized outcomes after enough data accrues.
- Add an operator source-value dashboard only after enough directional outcomes exist.
- Continue the separate staged SEC backfill/occurrence-provenance program; this branch improves
  retrieval consumption but does not claim complete corpus coverage.
