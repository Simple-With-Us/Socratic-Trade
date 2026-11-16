# 2026-07-11 — Settings + LLM usage telemetry consolidation (CLAUDE)

## Summary

Seven-item owner-directed batch: unified LLM usage labeling, strategy-review persistence
server-side, account-attribution fix for review-cost tracking, cross-account settings
import, framework-page width fixes, strategist model-cost visibility, and telemetry
coverage closure. Root cause unearthed by owner observation: strategy reviews (including
high-cost Fable runs) were being attributed to whichever account was globally `is_active`
at POST time rather than the account that initiated the tuning request. A Roth-IRA review
cost appeared missing because it was filed under a different account's ledger. This batch
wires account ownership through the entire review lifecycle.

## Why

Owner-directed: consolidate fragmented LLM telemetry paths (benchmark, eval, salience
chat, strategy tuning), wire review persistence server-side to prevent browser-close
data loss, fix the account-attribution gap that hid multi-account usage patterns, expose
strategist model costs in the dashboard, and harmonize settings imports across all
account types (not paper-only). Also cleanup UI layout caps on the framework page now
that sibling fields use the fluid grid pattern.

## Files

**New:**
- `app/ui/llm-usage-labels.ts` — centralized label map for all LLM contexts (sentence-case,
  consistent humanization, raw context in title).
- `src/lib/db-tuning-reviews.ts` — CRUD for new `strategy_tuning_reviews` table (insert,
  findLatestOpenReview, markApplied/Dismissed, deleteByUserId).
- `app/api/connected-accounts/[id]/import-settings/route.ts` — POST endpoint for cross-account
  settings import (ownership validated, identity fields stripped, lineage tracked, audit
  event recorded).
- `app/ui/` (directory) — new sheet/action for "Import from account…" on Framework page.
- `test/llm-usage-labels.test.ts` — coverage for label rendering + humanization.
- `test/strategy-tuning-reviews.test.ts` — coverage for review persistence, apply, dismiss.
- `test/settings-import.test.ts` — coverage for cross-account import, validation, lineage.

**Modified:**
- `app/console/strategy/page.tsx` — removed max-w-xl / w-64 / w-56 caps on input/selects;
  now use min-w-0 flex-1 grid pattern like siblings.
- `app/console/components/model-stats-drawer.tsx` — ModelStatsButton gains `role="strategist"`;
  drawer now shows historical Cost/call, Runs, Total cost per model.
- `src/lib/model-stats.ts` — context "strategy-tuning" renamed to "strategist" internally;
  no client-facing change (already shows as "Strategist" in UI).
- `app/api/llm-usage/model-stats/route.ts` — adjusted context handling for "strategist".
- `app/api/strategy/tune/route.ts` — accepts `targetConnectedAccountId` (ownership-checked);
  persists review to new `strategy_tuning_reviews` table; returns `reviewId`; new GET
  (latest open review per account) + PATCH (applied/dismissed) handlers; client pins
  `policy.connectedAccountId` via `targetConnectedAccountId`.
- `src/lib/strategy-tuning.ts` — evidence pack widened: lessons (retrieveLearnedContextDetailed,
  capped 12), reflection summary, global decision memory (10), thesis+sector scorecards,
  cross-account performance digest (cap 4), learning mutations (30d/20), regime label+flips.
  All try/catch-guarded and capped.
- `src/lib/db-profiles.ts` — new `importAccountSettings()` CRUD function (source account settings,
  target account state, lineage marker, ownership validation).
- `src/lib/db.ts` — new `strategy_tuning_reviews` table migration + `export * from
  "./db-tuning-reviews"`.
- `src/lib/memory/salience-llm.ts` — now records LLM usage via `recordLlmUsage()` (context
  "chat-salience").
- `src/lib/account-deletion.ts` — added `strategy_tuning_reviews` to `DELETE_TABLES_BY_USER_ID`.
- `scripts/benchmark-llm-models.ts` — records telemetry unconditionally via `recordLlmUsage()`;
  `--record-usage` flag now a no-op (backwards compat).
- `scripts/eval/score.ts` + `faithfulness.ts` — record as context "eval-judge" / "eval-faithfulness".
- `app/console/lib/api.ts` — client-side review fetch + apply/dismiss wrappers.
- `app/admin/llm-usage/llm-usage-client.tsx` — uses centralized labels.
- `test/model-stats.test.ts` — updated for "strategist" context.
- `test/salience-llm.test.ts` — verified salience LLM recordings.
- `test/public-auth-rate-limit-hardening.test.ts` — incidental no-op diffs (formatting).

## Verification

**Type + lint + test (state at doc-writing time):**
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors, inherited-warnings only.
- Focused test suites:
  - `test/strategy-tuning-reviews.test.ts` → 10/10 green.
  - `test/settings-import.test.ts` → 8/8 green.
  - `test/model-stats.test.ts` → 21/21 green.
  - `test/llm-usage-labels.test.ts` + `test/salience-llm.test.ts` → 118/118 combined green.
- Full `npm run lint` + `npm run test` + `npm run build` gate: running at doc-writing time;
  committer will confirm green before push.

**Manual review:** 4 parallel Sonnet subagents + 5 Explore scouts + adversarial review
workflow over diff. Account-scope isolation boundary confirmed (POST /api/strategy/tune
carries ownership validation; review table is per-account latest; client correctly pins
`targetConnectedAccountId`). LLM telemetry paths unified; coverage closure verified.
Review restore on mount gated per-account (no cross-account leakage). Settings import
strips identity fields (email, api keys, auth state) while preserving target's systemState
and recording lineage.

## Follow-ups / risks

1. **Benchmark fallback latency:** strategist uses benchmark model fallback when primary
   unavailable; benchmark runs synchronously. If benchmark is slow or fails, strategy
   review latency suffers — future work: make benchmark async or cache results server-side.
   Not a blocker; owner is aware.

2. **Dual-write design (getDb() singleton):** db-tuning-reviews and db-profiles both call
   `getDb()` (singleton instance). Multi-write transactions (review insert + llm_usage
   record + account state update) hit the same DB instance. Future design doc to clarify
   transaction boundaries and rollback semantics. Deferred; tests pass today.

3. **Review restore per-account only:** AiReviewPanel restores only the latest open
   review for the current account. A user with 10 accounts and 10 in-flight reviews sees
   only 1 restored on page load. This is correct per design (strategy tuning is per-account),
   but the UX could show a "n pending reviews in other accounts" summary. Deferred; owner
   accepted.

4. **Settings import & Roth-IRA precedent:** import carries account lineage but does not
   carry historical review outcomes (learned context, prior rejection reasons, etc.).
   A user who imports settings from an account with mature strategy history will start
   fresh on tuning decisions in the target account. This is intentional (learning is
   account-bound) but worth noting if the owner later wants cross-account pattern replay.

5. **LLM telemetry label continuity:** the centralized label map (`llm-usage-labels.ts`)
   is now the source of truth. If new context types are added, they must be registered
   there before they reach the telemetry UI. Grep the codebase for `recordLlmUsage()` calls
   before adding contexts to ensure coverage.
