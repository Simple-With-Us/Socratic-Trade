# 2026-08-14 — Pickup Monet Backend updates (r4 land + r5)

## 1. Context & Objective

Monet's "Backend updates (ST - Monet)" session hit the usage cap after r4 builders finished and before landing.  The owner directed GROK to complete that chat.  Ingestion was already closed end-to-end (#2680 adaptive FTS + worker re-enabled).  Toggles already merged (#2682).

## 2. Changes Made

### Leftover PRs unstuck

- **#2689** `grok/claude-r4-pickup` — r4 leftovers (real-index benchmarks, ATR pullback default, admin Operations panel, prompt data-age).  Merged current `main` (including #2713 and #2692) so GitHub mergeability is real again.  Squash auto-merge re-armed.
- **#2691** `grok/claude-r5-residue` — advisory-tail reword.  Same merge + re-arm.

### Round 5 (this branch)

1. **Scoped protection locks** — `trade-locks.ts` + `db-trade-locks.ts` (migration 79).  Per-symbol losing-streak and cooldown evaluators; overridable policy gate when `symbolLockAction=close_only`.  Off by default.
2. **Memory decay / prune** — `memory-decay.ts` + `db-memory-lifecycle.ts` (migration 80).  Recency/importance/blend math; soft-archive helper; retrieval bumps `last_retrieved_at`.  Hard Pinecone delete stays opt-in and is not flipped here.
3. **Strategy overlay library** — `overlay-router.ts` + `db-overlays.ts` (migration 81).  Regime-tagged owner templates; injected only when `tuning.strategyOverlaysEnabled` is true.  Prompt version `agentic-strategy@2.6.0` (DATA-NOT-COMMAND names `strategyOverlays`).
4. **Chat SSE + cancel + budget** — `chat-turn` dashboard events, `turn-registry` 409 on duplicate, `POST /api/chat/cancel`, stage-budget skip after step 0, Coach Cancel button.
5. **Scorecard alpha stretch** — `stampClosedLotAlpha` + optional `avgAlphaPct` / `shrunkAvgAlphaPct` on thesis/regime/sector stats.  Never fabricated.

Also: Settings `risk_advisory` helper now says "nothing was blocked or changed."

### Files touched (r5)

- `src/lib/trade-locks.ts`, `src/lib/apply-trade-locks.ts`, `src/lib/db-trade-locks.ts`
- `src/lib/memory-decay.ts`, `src/lib/db-memory-lifecycle.ts`, `src/lib/experience-memory.ts`
- `src/lib/overlay-router.ts`, `src/lib/apply-overlays.ts`, `src/lib/db-overlays.ts`
- `src/lib/chat/stage-budget.ts`, `src/lib/chat/turn-registry.ts`, `src/lib/chat/llm.ts`, `src/lib/chat/orchestrator.ts`, `src/lib/chat/types.ts`
- `app/api/chat/route.ts`, `app/api/chat/cancel/route.ts`, `app/console/assistant/chat.tsx`
- `src/lib/db.ts`, `src/lib/types.ts`, `src/lib/policy.ts`, `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`, `src/lib/events.ts`, `src/lib/performance.ts`
- `app/console/guardrails/field-defs.ts`, `app/console/settings/page.tsx`
- Tests listed below
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- Overlay UI CRUD panel deferred — table + router + prompt wiring land first (same as the original sketch's "panel later" option).  Create/list/delete are available via `db-overlays.ts`.
- Memory hard-delete stays off.  Soft archive + retrieval bump only.
- Symbol locks never halt the account.  `close_only` only blocks new entries in that symbol and remains overridable.
- Did not flip `VECTOR_ASOF_STRICT` or provision Reddit/X keys.

## 4. Verification State

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit
npx vitest run test/trade-locks.test.ts test/memory-decay.test.ts test/overlay-router.test.ts \
  test/chat-stage-budget.test.ts test/scorecard-alpha.test.ts test/r5-db-modules.test.ts \
  test/strategy-prompt-safety.test.ts test/persistence-hardening.test.ts
# 51 passed
```

`scripts/land.sh` re-runs lint / tsc / full test / build before the PR opens.

## 5. Next Steps & Blockers

- 2026-08-15: #2721/#2691 `verify-hosted` failed after midnight UTC on `test/web-sources.test.ts` (`overlay.NVDA?.congress?.buyCount` undefined).  The live-flow stub used hardcoded `06/16/2026` disclosedAt; the 60-day window cutoff is exactly 2026-08-15T00:00Z.  Fixture dates are now relative to `Date.now()`.
- #2689 (r4 leftover) is superseded by this stack once #2721 merges — do not race it.
- After this PR merges: owner can opt into overlays (`tuning.strategyOverlaysEnabled`) and symbol locks via Guardrails.
- Overlay console CRUD panel and weekly memory-decay scheduler job remain follow-ups.
- Parked owner decisions unchanged: Reddit/X keys; `VECTOR_ASOF_STRICT` flip after a fresh coverage receipt.

## 6. Zero-Code Findings

Ingestion directive from the original chat is already done (hotfix deployed as `caffa2fd`, worker on, first-sync watch closed).  No further ingest knob work in this pickup.
