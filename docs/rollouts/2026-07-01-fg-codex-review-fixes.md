# 2026-07-01 — F/G PR #293 Codex-review fixes

Follow-up commit on `claude/audit-work-split-f-g-o67jj2` (PR #293) addressing 5 automated Codex
review findings (2×P1, 3×P2). Each was verified against the actual code before fixing.

## Summary / Why

1. **P1 — reindex routes lost the production token gate.** Migrating `reindex-10k`/`reindex-8k` to the
   shared `requireAdmin` regressed a defense-in-depth property: when app auth is unconfigured,
   `middleware.ts` injects the primary-operator email for **every** request, which satisfied
   `checkAdmin`'s email path and let an unauthenticated caller trigger a paid Voyage backfill in a
   prod misconfiguration (the old local `authorized()` still required the token in production).
   **Fix:** new `requireTokenInProd` option on `checkAdmin` — in production a verified admin *email*
   alone is insufficient; the `x-admin-token` must match. Both reindex routes pass it. Keeps the
   shared-gate migration + timing-safe compare; non-prod dev/ops open path preserved.

2. **P1 — live pre-flight guard missing on the approval path.** `assertLivePreflight` protected only
   the autonomous run loop; `approveProposal` reaches its own `gateway.placeEquityOrder` for
   human-approved proposals. **Fix:** wire the same default-safe guard before the approval-path
   placement (no-op in paper/test; blocks `broker/live` unless `paperMode:false` AND
   `ALLOW_LIVE_TRADING=true`). Records a `blocked` status + `order_blocked_live_preflight` audit
   (`path: "approval"`). Never places/enables a trade.

3. **P2 — cached query embeds metered as real calls.** `retrieveContextDetailed` called
   `meterEmbed([query])` unconditionally after `embedQueryCached`, so cache hits inserted phantom
   `rag_usage` rows + estimated Voyage cost — corrupting the very dashboards the cache reduces.
   **Fix:** `embedQueryCached` now returns `{ response, cached }`; meter only when `!cached`.

4. **P2 — daily LLM budget ceiling bypassed on interval runs.** The ceiling was checked only in the
   event-trigger `fire()` path; the fixed scheduler (`scheduler.ts`) calls `runStrategyOnce` directly
   in interval/both mode, spending past a configured cap. **Fix:** call `checkLlmDailyBudget` in the
   scheduler's run loop too (audit `trigger_suppressed_budget`, `path:"scheduler"`). Still default-off.

5. **P2 — OAuth-token encryption bricked the memory-only fallback.** Encrypting with db-api-keys'
   *ephemeral* key (when `ENCRYPTION_KEY` is unset) gave no real at-rest protection and, after a
   restart, decrypted to empty — and `getStoredMcpOAuthTokens` returned a dead empty token, so
   `migrateLocalRobinhoodToken()` skipped reseeding from the still-present env token. **Fix:** only
   encrypt when a stable `ENCRYPTION_KEY` is configured (else store plaintext, as before — a strict
   upgrade, never a regression); and treat an empty-decrypted `accessToken` as **missing** so env
   reseed / re-auth runs.

## Files

- `src/lib/auth/admin.ts` — `requireTokenInProd` option + gate logic.
- `app/api/admin/reindex-10k/route.ts`, `app/api/admin/reindex-8k/route.ts` — pass `requireTokenInProd: true`.
- `src/lib/strategy.ts` — `assertLivePreflight` on the `approveProposal` placement path.
- `src/lib/vector-db.ts` — `embedQueryCached` returns hit/miss; meter only on miss.
- `src/lib/scheduler.ts` — daily-budget check on the interval-run lane.
- `src/lib/mcp-oauth.ts` — gate encryption on `ENCRYPTION_KEY`; empty-decrypt → missing.
- Tests: extended `test/security-admin-timing-safe.test.ts`, `test/query-embedding-cache.test.ts`,
  `test/security-oauth-token-encryption.test.ts` (+6 cases).

## Round 2 (commit after 69ee75f) — 4 more Codex P2 findings on the fix commit

6. **Rate-limit `/api/chat` before body parsing.** The limiter ran after `await request.json()`, so an
   over-limit caller could still force server-side JSON parse/alloc. `resolveRequestUserId` uses the
   trusted header (ignores the body), so identity + rate-limit now run first, then the body is parsed.
   (`app/api/chat/route.ts`)
7. **Persist live-preflight blocks as REJECTED decisions.** Both preflight-block sites (autonomous +
   approval) stored `status: "blocked"` but kept the earlier `approved` `decision`, corrupting the
   decision/audit ledger. Now persist `{ ...decision, approved: false, reasons: [...reasons, message] }`.
   (`src/lib/strategy.ts`)
8. **Extend the `ENCRYPTION_KEY` boot guard to OAuth tokens.** `hasEncryptedCredentials` (`db.ts`) only
   checked `connected_accounts`; a Robinhood-only deploy that lost its key would boot instead of failing
   fast. It now also detects AES-GCM ciphertext in `robinhood_mcp_oauth_token:*` settings rows (matching
   the secret fields against the `iv:tag:ct` hex envelope, since the JSON itself contains colons).
9. **Fixed-position the workspace "More" menu.** The Macro/Tax overflow dropdown sat inside the tab
   row's `overflow-x-auto` scroll container, which clips vertical overflow — the menu could be cut off
   on the narrow layouts the overflow exists for. It now positions with `fixed` coords from the
   trigger's rect (closes on scroll/resize). (`app/dashboard-client.tsx`)

Tests: +2 boot-guard cases in `test/security-oauth-token-encryption.test.ts` (findings 7/9 are
data-integrity/UI changes covered by tsc + the existing guard/money-path suites).

## Round 3 (commit after 61172fa) — 2 more Codex findings (1 P1, 1 P2), both to CHOKE POINTS

10. **P1 — guard EVERY broker/live order path, not just strategy.** `synthetic-stops.ts`,
    `broker-protective-stops.ts`, and `order-replacement.ts` reach `placeEquityOrder` without the
    guard. Rather than sprinkle asserts, `getBrokerGateway` (`broker.ts`) now returns the gateway
    wrapped in a Proxy whose `placeEquityOrder` runs `assertLivePreflight` first (execution state
    derived lazily from policy + active account; async so a block is a rejected promise). Every current
    and future real-order caller is covered by one shared wrapper. No-op in Test/paper.
11. **P2 — enforce the LLM budget at the run entry.** The ceiling was only on the trigger/scheduler
    lanes; `app/api/strategy/run/route.ts` and `mobile-api.ts` call `runStrategyOnce` directly, so
    "Run once" / mobile could spend past a hard ceiling. Extracted `checkLlmDailyBudget` to a new
    `src/lib/llm-budget.ts` (avoids a strategy↔triggers import cycle; `triggers.ts` re-exports it) and
    added the check at the TOP of `runStrategyOnce` (before the lock), so every entry is gated. The
    trigger/scheduler early-checks remain as cheap short-circuits. Manual runs are now gated too — a
    hard daily ceiling is hard for all entries. Default OFF.

Tests: new `test/run-budget-and-live-guard.test.ts` (over-budget `runStrategyOnce` is a hard no-op +
audit; `getBrokerGateway` blocks a broker/live order when `ALLOW_LIVE_TRADING` is unset).

## Round 4 (commit after 36e539b) — 1 P1 fixed, 1 P2 documented

12. **P1 — guard the CANCEL too (cancel-then-place side effects).** The gateway wrapper only guarded
    `placeEquityOrder`; but `replaceStaleLimitOrderWithMarket` and `broker-protective-stops` cancel
    the existing order FIRST. In broker/live without `ALLOW_LIVE_TRADING`, the live cancel would run
    and then the place would throw — leaving the order cancelled with no replacement / an unprotected
    position. Fix: the `getBrokerGateway` Proxy now also guards `cancelEquityOrder`, so cancel-then-
    place flows fail BEFORE the cancel — no side effects. (`src/lib/broker.ts`; test asserts the live
    cancel is blocked.)
13. **P2 — budget reservation across concurrent same-user runs (~~DOCUMENTED, not built~~ → NOW BUILT,
    2026-07-01).** The daily ceiling was a read-of-the-ledger admission check at run entry, not a
    reservation. When one user has multiple accounts due, the scheduler can launch their runs
    concurrently; two runs just under the limit could both pass and then both spend, overshooting by up
    to the in-flight runs' spend (bounded by the scheduler's concurrency cap of 3). **Resolved:** added a
    per-USER LLM budget **reservation** (`reserveLlmBudget`/`reserveLlmRunBudget`/`releaseLlmReservation`/
    `reservedLlmSpend` in `src/lib/llm-budget.ts`), CAS'd in the `settings` KV row exactly like
    `acquireStrategyLock` (no migration). Each run reserves its worst-case estimate at the budget gate in
    `runStrategyOnce` and releases it in the `finally`; a concurrent same-user run's reserve sees the hold
    and skips LLM instead of double-committing. Fail-closed (DB error → skip LLM, never a failed run),
    TTL-reclaimed (a crashed run's hold frees after 5 min), default-OFF (no ceiling → no reservation).
    See `docs/rollouts/2026-07-01-llm-budget-reservation-toctou.md`.

## Round 5 (commit after 8e895d3) — 2 findings, both CORRECTING earlier rounds

14. **P1 — don't block risk-reducing live cancels (corrects item 12).** Item 12's blanket gateway
    `cancelEquityOrder` guard over-corrected: it blocked ALL live cancels, including the manual
    `/api/orders/cancel` route and cancel-on-close cleanup — so an operator who disables live trading
    in an emergency could no longer cancel outstanding live orders / stale stops. Reverted the gateway
    cancel guard (place-only again) and instead guard the cancel-THEN-place WORKFLOWS before their own
    cancel phase: `replaceStaleLimitOrderWithMarket` runs `assertLivePreflight` before its cancel
    (throws → no orphan); `broker-protective-stops` skips its mismatch-cancel when a live re-place
    would be blocked (via new non-throwing `livePreflightBlocks`), keeping the existing stop. Standalone
    risk-reducing cancels now always work. (`broker.ts`, `preflight-live-guard.ts`, `order-replacement.ts`,
    `broker-protective-stops.ts`.)
15. **P2 — budget gate must not disable non-LLM safety (corrects item 11 placement).** Item 11 put the
    budget check at the TOP of `runStrategyOnce`, so an over-budget run returned before the account
    drawdown/volatility breakers + pending-fill reconciliation — a cost cap silently disabled risk
    maintenance. Moved the gate to just BEFORE LLM proposal generation (`proposeTrades`), AFTER those
    non-LLM safety steps: it now skips only the LLM part (like the score-threshold skip) and the run
    still completes, so breakers/reconciliation always run. Still the single choke point for all
    entries; still default-OFF. (`src/lib/strategy.ts`.)

Tests: `strategy-money-path-f-g.test.ts` gains a budget-skip case (LLM skipped + `strategy_run_suppressed_budget`
audit, run still completes, no OpenAI call); `run-budget-and-live-guard.test.ts` now asserts a standalone
live cancel is NOT blocked (and the place still is). The concurrent-run reservation (item 13) remains a
documented, deferred follow-up.

## Round 6 (commit after cd5d584) — 3 P2, CONSOLIDATING the budget/guard choke points

16. **Gate revalidation on the budget too.** `revalidatePendingProposals` is an LLM call that ran
    BEFORE the round-5 budget gate, so an over-budget run still spent tokens on it. Moved the budget
    check to right after the non-LLM safety work (reconcile + breakers) and BEFORE both LLM sites
    (revalidation + generation); revalidation is now skipped on budget while deterministic expiry
    still runs. (`src/lib/strategy.ts`.)
17. **Removed the outer budget suppressions.** `triggers.fire()` and the scheduler still `return`/
    `continue`d before entering `runStrategyOnce` when over budget — which also skipped the drawdown/
    volatility breakers + reconciliation inside the run. Removed both outer gates so the run is always
    entered (safety runs) and only the LLM work is skipped by the internal gate. (`triggers.ts`,
    `scheduler.ts`; token-budget test updated to assert the run IS entered + no `trigger_suppressed_budget`.)
18. **Protective-stop pending-cancel retry.** The `pending_cancel` retry ran before the round-5
    `liveReplaceBlocked` check, so it could cancel a still-open position's only stop when the replace
    is blocked. Moved `liveLongs` + `liveReplaceBlocked` up front and made the retry skip still-open
    positions when replacement is blocked (closed-position cancels stay risk-reducing). (`broker-protective-stops.ts`.)

## Verification

`npx tsc --noEmit` 0 errors · `npm run lint` 0 errors · `npm test` **1730/1730** · `npm run build` ok.
(Private `@jaywedgeworth22/congress-trading-shared` dep stubbed locally as before; CI `verify` uses the
real package.)

## Follow-ups

- Deferred: the `strategy.ts` god-module split. The LLM budget ceiling covers ALL run entries
  (trigger, scheduler, manual API, mobile) via the `runStrategyOnce` choke point (gated after the
  non-LLM risk breakers); the live pre-flight guard covers ALL real-order PLACEMENTS via the
  `getBrokerGateway` wrapper, with cancel-then-place workflows guarded before their own cancel phase.
- ~~Deferred: a per-user LLM-budget **reservation / run serialization**~~ **DONE (2026-07-01).** The
  per-user reservation now closes the concurrent-multi-account overshoot (item 13 above); the ceiling is
  hard under concurrent scheduling within the estimate granularity. See
  `docs/rollouts/2026-07-01-llm-budget-reservation-toctou.md`.
