# 2026-07-10 — Activity-audit P1 batch: Roth truncation, thesis-tag split-brain, reflection cross-account contamination

**Agent:** MONET (branch `monet/activity-audit-p1-batch`), owner-assigned in-session.
Implements the three P1 items from `docs/reviews/2026-07-09-activity-feed-audit.md` §1
plus the item-10 post-mortem/`setUserSetting` sub-parts. Built by a cost-tiered agent
team (2×Sonnet + 1×Fable implementers in isolated worktrees → integrated → 3 adversarial
verifiers + completeness critic → fix round), per owner directive. The ~54-site
`strategy.ts`/`synthetic-stops.ts` attribution sweep (audit item 10) is explicitly OUT of
this batch — released to a second owner-directed session (board row "Activity-audit
item 10"); this batch's only `strategy.ts` touches are the `strategy_bull_truncated`
site and the reflection read.

## Summary

1. **Roth proposer truncation (audit §1.1).** `LLM_OUTPUT_TOKEN_CAPS.strategyProposal`
   is a literal **4000** (was inheriting the shared 1500 default, which gemini-3.5-flash
   exhausted — prod Roth produced ZERO proposals on 6/10 runs 2026-07-09; every other cap
   untouched, test-locked). New exported `resolveLlmWireOutputCap(transport, bounds)`
   computes the actual post-headroom wire cap; `withLlmRequestBounds` now uses it on
   EVERY branch, so the audited cap can never desync from the request body. The
   `strategy_bull_truncated` audit now records `wireOutputCap` + `finishReason`
   (new `extractBullFinishReason` covering stop_reason / finish_reason /
   incomplete_details / status / Responses per-item `output[].status`) alongside the
   configured `cap`, and passes `connectedAccountId` as the audit 4th arg.
   NOTE: "verify with a Roth run producing >0 proposals" is a POST-DEPLOY step — not
   claimed here.
2. **Thesis-tag split-brain (audit §1.2).** `insertProposal` defaults
   `trade_thesis_tag`/`entry_market_regime` from the proposal object (extraction runs on
   the same object that gets persisted; `ensureReferencePrice` verified non-mutating for
   those fields; malformed proposals can't throw on the order path). COALESCE fallbacks
   (`json_extract(proposal, '$.tradeThesisTag')` etc.) in the post-mortem SELECT and in
   `getProposal`/`getProposalsByIds`. One-time backfill recovers the 543 historical rows —
   deliberately an always-run self-guarding UPDATE in `migrate()` (WHERE col IS NULL AND
   json value present) rather than a versioned migration: it self-heals stragglers (e.g.
   rows written by an old binary mid-rolling-deploy) and re-runs are no-ops; the
   versioned-MIGRATIONS header rule targets schema DDL.
3. **Reflection cross-account contamination (audit §1.3 — the live account was reading
   test/paper accounts' reflections).** Both keys account-scoped:
   `reflection_signature:${userId}:${accountNumber}` and
   `reflection_summary:${accountNumber}` (user-settings). New exported
   `getReflectionSummary(userId, accountNumber)` is the read for prompt assembly
   (strategy.ts) AND the chat `get_reflection` tool (orchestrator now answers from the
   ACTIVE account). Discriminator identity verified: writer and reader both use the
   broker `policy.accountNumber` (never the `connectedAccountId` UUID). **Legacy
   retirement (Fable design decision):** on the first scoped write the shared legacy
   `reflection_summary` row + legacy signature are DELETED — leaving them as a fallback
   would keep feeding one account's (possibly paper) lessons into sibling prompts
   indefinitely; siblings degrade to the legal "no reflection yet" prompt state for at
   most one cycle. `setUserSetting` gained `{ auditPolicyChange?: boolean }` (default
   true — all other call sites unchanged); the hourly reflection write opts out, killing
   the hourly phantom `policy_change` cards. `post_mortem_reflection` audit carries
   `connectedAccountId` (guarded: only when the resolved policy matches the reflected
   account) + `accountNumber` in the payload.

## Verification (agent team + gate)

- 3 implementers each ran tsc + focused tests in their worktrees before returning diffs;
  diffs applied cleanly (`git apply --3way`), integrated tree re-verified.
- Adversarial verify workflow (Sonnet ×2, Fable on fix 3, + completeness critic):
  - Wire-cap fidelity CONFIRMED — audit computation and request body proven to receive
    identical inputs; `resolveLlmWireOutputCap` brute-forced against the pre-change
    inline logic across 312 model×transport×effort combinations, 0 mismatches.
  - Discriminator identity CONFIRMED (sole prod caller passes `policy.accountNumber`);
    legacy retirement semantics verified; empty reflection safe in prompt assembly.
  - Fix 2 CONFIRMED_GOOD on all five attack vectors (same-object extraction, COALESCE
    key shapes, backfill idempotency, consumer return shapes, loop healing).
  - Findings fixed in a follow-up round: `extractBullFinishReason` now covers the
    Responses `output[].status === "incomplete"` shape; chat `get_reflection` no longer
    reads the (retired) bare key — this was the one real catch, a silent post-retirement
    feature death; last `withLlmRequestBounds` branch unified on the shared cap helper;
    reflection audit attribution guarded against active≠reflected account; 20s per-test
    timeout on test/post-mortem.test.ts (approval-lock flake-class precedent); new
    end-to-end COALESCE test (legacy NULL-column row → tag reaches the reflection
    prompt).
- Gate (node@24 — homebrew default node v26 ABI-breaks better-sqlite3):
  `npm run lint` 0 errors; `npx tsc --noEmit` clean; focused suites 113/113 + 35/35;
  full `npm test` + `npm run build` via `land.sh` (results in the PR).

## Files

- `src/lib/llm-request.ts` — cap 4000, `resolveLlmWireOutputCap` (all branches unified).
- `src/lib/strategy.ts` — bullResult carries `wireOutputCap`/`finishReason`; truncation
  audit honest + account-attributed; reflection read via `getReflectionSummary`.
- `src/lib/db-proposals.ts` — tag defaulting + read fallbacks.
- `src/lib/db.ts` — self-guarding thesis-tag backfill in `migrate()`.
- `src/lib/post-mortem.ts` — scoped keys, legacy retirement, audit attribution,
  `getReflectionSummary`.
- `src/lib/db-settings.ts` — `setUserSetting` audit opt-out + `deleteUserSetting`.
- `src/lib/chat/orchestrator.ts` — `get_reflection` reads the active account's scoped key.
- `test/llm-request.test.ts`, `test/post-mortem.test.ts` (+timeouts, +COALESCE e2e),
  `test/thesis-tag-persistence.test.ts` (new).
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board) — board rows for the batch AND the
  full audit backlog (item-10 sweep RESERVED for the second session; P2.4–9, P3 batch,
  4 owner-decision items as Planned).

## Follow-ups / risks

- POST-DEPLOY: watch one Roth run for >0 proposals (audit §1.1's acceptance step) and
  confirm `strategy_bull_truncated` stops recurring; watch that live-account prompts pick
  up their own reflections after the first scoped write.
- The attribution sweep (item 10), P2.4–9, P3 batch, and the 4 owner decisions remain
  open on the board.
- Cost note: the 4000-token cap raises worst-case Bull-step spend; budget code reads
  actual usage (no constant assumptions — verified), and the per-run reservation
  (80k tokens) already dominates the new worst case.
