# 2026-06-24 — Safety fixes A–E (Codex-review findings, re-verified against main)

## Summary

Acting on the three deep-review agents run against Codex's recent work. The reviews
were done against an OLD base branch; main had since advanced (#109/#110/#113), so
every finding was **re-verified against current `main`** before fixing. Net result:

- **A (HIGH) — FIXED.** OOS walk-forward gate now validates the ACTUAL proposed
  scoring weights, not the data-derived IC weights.
- **B (MED) — ALREADY FIXED on main** by #109 (`policy.ts:190` already guards the
  daily-order-count cap on `isOpening`, so protective exits are never capacity-blocked).
  No change needed; verified.
- **C (MED) — FIXED.** Synthetic trailing-stop monitor no longer double-covers a
  symbol that already has a live broker-held bracket stop.
- **D (MED) — FIXED.** `upsertConnectedAccount` can no longer be used to overwrite
  another user's account row via a guessable/deterministic id.
- **E (LOW) — FIXED (comment) + VERIFIED (Grok).** Stale `execution-cost.ts`
  "DEFAULT OFF" comment corrected to "DEFAULT ON". The "Grok may need `max_tokens`"
  concern was a **false alarm**: xAI's API reference confirms `max_completion_tokens`
  is the current/supported param and `max_tokens` is deprecated — our code already
  sends `max_completion_tokens`, which is correct. The `ALLOWED_EMAILS` item is a
  deploy-runbook note (set it for the family deployment), not code.

## What changed

### A — OOS gate validates the proposed weights (`src/lib/backtest.ts`, `src/lib/strategy-tuning.ts`)
- `OOSRunOptions` gains `candidateWeights?` and `baselineWeights?`.
- `runWalkForwardOOS` computes `oosICCandidate` / `oosICBaseline` (composite IC of
  those weight vectors on the SAME held-out test fold), added to `OOSResult`.
- `applyOosGate` now: builds the candidate vector = proposed weights merged over the
  current policy weights (mirrors how db-profiles applies a weight patch), passes
  candidate + baseline (= current policy weights) into the OOS run, and gates on
  `oosICCandidate > oosICBaseline` — i.e. "does what's proposed beat what's running
  today on held-out data?". Falls back to the legacy `oosIC`/`oosICDefault`
  comparison only when those fields are absent (back-compat). Caution wording fixed
  (no longer claims "OOS-validated" for weights it never evaluated).

### C — synthetic vs broker-held stops (`src/lib/synthetic-stops.ts`)
- Before auto-registering a trailing stop, the monitor fetches `getEquityOrders` and
  skips symbols that already have a LIVE broker stop order (`isLiveBrokerStop`: type
  matches `/stop/i` AND state ∈ LIVE_ORDER_STATES). Keyed off ACTUAL resting orders,
  not policy inference, so a position is never left unprotected: on list-orders error
  or a terminal/canceled broker stop, the synthetic still registers (protection over
  dedup). `/stop/i` tolerates Alpaca's raw `"stop"` type string.

### D — cross-tenant account-write guard (`src/lib/db-api-keys.ts`)
- Added `WHERE connected_accounts.user_id = excluded.user_id` to the
  `ON CONFLICT(id) DO UPDATE`, making the UPDATE a no-op when the existing row belongs
  to a different user. Create-with-fresh-id and legitimate same-user edits unaffected.

### E — comment (`src/lib/execution-cost.ts`)
- Header comment corrected: cost model is DEFAULT ON (opt out via
  `PAPER_EXECUTION_COST_MODEL=off`).

## Tests
- `test/strategy-tuning.test.ts` — both OOS-gate tests updated to exercise the NEW
  path (assert `candidateWeights`/`baselineWeights` passed to `runWalkForwardOOS`, and
  that gating uses candidate-vs-baseline, with `oosIC`/`oosICDefault` set to the
  opposite verdict to prove the old comparison is no longer used).
- `test/synthetic-stops.test.ts` — added `getEquityOrders` to the mock gateway; new
  tests for "skip synthetic when a live broker stop rests" and "still fire when the
  broker stop is canceled".
- `test/connected-account-tenant-guard.test.ts` — new: attacker cannot overwrite a
  victim's row via a shared id; owner can still update their own.

## Multi-agent review
Three deep-review agents (the original audit) + a per-fix adversarial pass (Haiku on
D/E, Sonnet on A and C). C review confirmed no position-unprotected path was
introduced. (A review verdict folded in at commit time.)

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1008/1009 pass; the 1 failure is the pre-existing date-sensitive
  `cache-provenance.test.ts` (unrelated).
- `npm run build` — succeeds.

## Follow-ups (next staged PRs, per owner)
- Per-account state isolation (policy/profile/runs/scheduler keyed by account).
- Shared nameable saved-strategy library + copy-to-account transfer.
- Sell-to-fund-buy as a 3-way user setting (Automated / Propose / Suggest-only,
  defaulting to the account's current mode).
- Pre-existing (not fixed here): Alpaca `o.type as OrderType` cast hides raw `"stop"`;
  `getEquityOrders` uses `status:"all"` with no pagination; `evaluatorCadenceHours` is
  a dangling policy field (no reader); RAG decision-path lacks prompt-injection fencing
  and has no manual reindex endpoint.
