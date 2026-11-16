# 2026-07-10 — Settings IA restructure: /console/settings is global-only

Agent: CLAUDE (Fable), worktree `vibrant-bouman-10388c`, branch `claude/settings-global-only`.
Owner-directed.

## Summary

`/console/settings` now contains ONLY global settings (all-account / browser /
operator / reference / danger). Account-specific config lives on the Framework
page (`/console/strategy`). Concretely:

1. **Models card DELETED from Settings** (`app/console/settings/models.tsx`
   removed entirely). Framework already had the same Proposer/Reviewer pickers
   WITH the working reasoning-effort controls that Settings' copy lacked
   (owner-reported inconsistency); deletion resolves it via single source of
   truth. The card's browser-local **Coach** picker is not lost — the Coach
   page itself reads/writes the same `CHAT_MODEL_STORAGE_KEY`
   (`app/console/assistant/chat.tsx:138-143`).
2. **Tax treatment MOVED to Framework.** `TaxSettingsCard` extracted from
   `settings/page.tsx` into its own module
   `app/console/strategy/tax-settings.tsx` and appended at the BOTTOM of
   `/console/strategy`, still account-scoped (correct there — Framework is
   per-account), with a visible `THIS ACCOUNT` chip in the card header.
3. **Advanced action confirmation MOVED under ALL YOUR ACCOUNTS** and its
   backing field **`requireTypedConfirmation` PROMOTED to
   `USER_LEVEL_POLICY_FIELDS`** (`src/lib/db-profiles.ts`) so one switch
   genuinely applies across all accounts. Card copy updated.
4. **Learning review**: verified ALREADY user-level
   (`learningReview*` in `USER_LEVEL_POLICY_FIELDS`, `db-profiles.ts` — was
   promoted with a lazy legacy seed in the #1278 follow-up) and already
   rendered under ALL YOUR ACCOUNTS. No storage change needed; only a stale
   comment in `learning-review.tsx` (pointing at "the account's Models card")
   was retargeted.
5. **THIS ACCOUNT section deleted** from Settings along with its scope-chip
   explainer; top-of-file doc comment rewritten so Settings reads as
   global-only. Existing deep-link anchors preserved (`#brokers`, `#api-keys`,
   `#sharing`, `#danger`, `#admin`); new anchors added: `#confirmation`
   (Settings), `#models` and `#tax` (Framework). Framework gained the same
   deferred hash-scroll effect Settings uses (both pages render only after the
   snapshot arrives, so native anchor jumps miss).

## Storage-scope findings (as verified, file:line at time of work)

- `learningReviewEnabled/Mode/Model/MinNewLessons/MaxWaitDays` — **user-level
  already** (`src/lib/db-profiles.ts:29-33`), including the one-time
  `seedLegacyLearningReviewFields` lazy seed from the account-scoped era.
- `requireTypedConfirmation` — **was account-scoped** (absent from
  `USER_LEVEL_POLICY_FIELDS`; stored per `account_strategy_state` row via
  `pickAccountFields`). Now promoted to user-level.

## Scope-promotion decision + migration effects (requireTypedConfirmation)

- User-level fields overlay every account on read (`getPolicy` →
  `readUserPolicyFields`), and `stripUserFields` drops them from account rows.
  **Existing divergent per-account values are therefore superseded.**
- **No legacy seed was added on purpose** (contrast with the learning-review
  promotion, which seeds): the owner is the sole user ("no compat tax"
  ruling), and the failure direction is safe — with no user-level value stored
  yet, reads fall back to `DEFAULT_POLICY.requireTypedConfirmation = true`
  (typed confirmation required). Practical effect: if the owner had switched
  it OFF pre-promotion, the toggle reads ON again after deploy until flipped
  once more — that single flip then persists at user level for all accounts.
- Enforcement sites are unchanged: every consumer reads
  `policy.requireTypedConfirmation` through `getPolicy`, which applies the
  overlay (order-replacement, strategy, bulk-approve, approval-card, mobile
  snapshot, guardrails typed-word gate, AI-review typed-word gate).
- New regression test: `test/per-account-policy-isolation.test.ts`
  ("requireTypedConfirmation is user-level — one switch spans every account"),
  including the stale-divergent-account-row supersession case.

## Links / copy retargeted

- `app/console/components/chrome.tsx` — run-failure fix link
  `/console/settings#models-green` → `/console/strategy#models`; label
  "Open Settings → LLM models" → "Open Framework → Models". (The `#api-keys` /
  `#brokers` fix links stay — those cards remain in Settings.)
- `src/lib/llm-required.ts` — `LLM_MODEL_REQUIRED_STRATEGY_MESSAGE` now says
  "under Framework → Models" (all consumers import the constant; chrome.tsx
  matches on it, so no string drift).
- `src/lib/red-team.ts` — reviewer-not-chosen message → "Framework → Models".
- `src/lib/defaults.ts`, `src/lib/db.ts` (migration-15 log) — comment/log
  copy → "Framework → Models".
- `app/console/guardrails/page.tsx` — "wash-sale guard … lives in Settings →
  Tax treatment" → "Framework → Tax treatment".
- `src/lib/policy.ts` — `accountTaxationType` doc comment corrected: the
  ConnectedAccount's own taxationType is set in Settings → Broker accounts
  (it was never the policy Tax card).
- `app/console/settings/help.tsx` — glossary: Green-team entry points at
  "Framework → Models"; the "THIS ACCOUNT vs ALL YOUR ACCOUNTS" entry
  rewritten (scopes now described as Framework/Mandates vs this Settings
  page).
- Stale comments referencing the deleted `settings/models.tsx` cleaned up:
  `app/ui/llm-model-catalog.ts` (now the ONLY catalog copy — one less
  keep-in-sync burden), `src/lib/llm-request.ts`,
  `app/console/components/model-stats-drawer.tsx`,
  `app/api/llm-usage/model-stats/route.ts`.
- `app/console/settings/lib.ts` — dead `fetchChatProviders` removed (only
  consumer was the deleted card).
- Checked and left alone: `app/settings-scope.ts` / `app/settings-search.ts`
  (legacy taxonomy for the retired /settings surface; imported only by tests
  and each other — no runtime consumer), mobile surfaces (no settings-section
  links), `chat.tsx` / `macro/page.tsx` plain `/console/settings` links (they
  point at API keys, which stayed).

## Files

- `app/console/settings/page.tsx` — restructure (THIS ACCOUNT section gone,
  confirmation card moved + `#confirmation` anchor, doc comment, scan-shape
  copy)
- `app/console/settings/models.tsx` — DELETED
- `app/console/settings/lib.ts`, `app/console/settings/help.tsx`,
  `app/console/settings/learning-review.tsx`
- `app/console/strategy/page.tsx` — TaxSettingsCard appended, `#models`/`#tax`
  anchors, hash-scroll effect, doc comment
- `app/console/strategy/tax-settings.tsx` — NEW (extracted card + scope chip)
- `src/lib/db-profiles.ts` — `requireTypedConfirmation` promotion
- `src/lib/llm-required.ts`, `src/lib/red-team.ts`, `src/lib/defaults.ts`,
  `src/lib/db.ts`, `src/lib/policy.ts`, `src/lib/llm-request.ts`
- `app/console/components/chrome.tsx`,
  `app/console/components/model-stats-drawer.tsx`,
  `app/console/guardrails/page.tsx`, `app/api/llm-usage/model-stats/route.ts`,
  `app/ui/llm-model-catalog.ts`
- `test/per-account-policy-isolation.test.ts` — new regression case
- Docs: `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note

## Verification

```
npx tsc --noEmit        # clean
npm run lint            # 0 errors (grandfathered warnings only)
npm test                # 3374 passed / 315 files (pre-change baseline 3373)
npm run build           # clean
npx vitest run test/per-account-policy-isolation.test.ts  # 12 passed
```

Runtime smoke (local `next dev` + browser): /console/settings renders
global-only (no THIS ACCOUNT chip/Tax/Models; #brokers/#api-keys/#sharing/
#danger/#confirmation anchors all resolve; confirmation card shows the
whole-login hint); /console/strategy shows card order …Presets → Tax treatment
(last) with the THIS ACCOUNT chip, `#models`/`#tax` anchors resolve, and
navigating to `/console/strategy#tax` scrolls the card into view; zero console
errors.

## Follow-ups / deferred

- The deleted Settings Models card had three niceties the Framework card
  lacks: per-provider key-availability annotations (options disabled when no
  key resolves), the "missing models fail closed" banner, and the
  same-model/same-provider independence hint. Worth porting to the Framework
  Models card in a follow-up if the owner misses them.
- Old rollout notes/STATUS history mention `#models-green` — left as-is
  (historical records).
