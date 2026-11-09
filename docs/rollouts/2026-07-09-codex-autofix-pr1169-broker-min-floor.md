# 2026-07-09 — Codex autofix PR #1169: broker-minimum floor skipped zero-rounded sizes

## Summary
Addressed the one open Codex (`chatgpt-codex-connector`) review thread on PR #1169
("feat: enforce broker minimum dollar notional in proposal sizing"). The broker
minimum dollar-notional floor in `applyDeterministicSizing` raised the sized
notional to the broker floor (Robinhood: $1) only when `targetNotional > 0`.
A positive *source* intent — an LLM-advised notional or a fallback size — that
rounded DOWN below the floor (e.g. an advised `$0.22`, or any positive fallback
under `$1`) floors `targetNotional` to `0` earlier in the function, so the raise
was skipped and the proposal was returned with `dollarAmount: 0`. That is exactly
the guaranteed-reject zero-notional path the floor was added to eliminate.

## Why
Codex P2: "Raise zero-dollar proposals to the broker floor." The floor must apply
to positive source sizes that became zero after rounding, when capacity can cover
the minimum — not only to sizes that were already ≥ $1.

## Fix
`src/lib/strategy.ts` — the broker-min block now computes the PRE-rounding source
notional (`advisedNotional` when positive, else `Math.max(0, fallbackBase) *
finalMultiplier`) and raises to the floor when `targetNotional < brokerMinDollar`,
either `targetNotional > 0` OR the raw source was positive, AND
`brokerMinDollar <= effectiveOpeningCap` (capacity covers the minimum). When
capacity cannot cover the minimum, the order is left too small and the policy
review blocks it on per-order-cap grounds (unchanged).

## Files
- `src/lib/strategy.ts` — broker-min floor guards on pre-rounding source intent.
- `test/broker-minimum-sizing.test.ts` — NEW regression suite (4 tests):
  - sub-$1 advised ($0.22) that rounds to $0 → raised to $1 with the sizing note;
  - positive advised $0.9 → raised to $1;
  - Alpaca (no known floor) → no-op, stays $0;
  - capacity below the floor (`maxOrderNotional: 0.5`) → left sub-$1, no raise.
- `STATUS.md` — snapshot entry.

## Verification
- `npx tsc --noEmit` → clean.
- `npx vitest run test/broker-minimum-sizing.test.ts test/conviction-size-cap.test.ts
  test/vol-targeting-sizing.test.ts test/kelly-sizing.test.ts
  test/broker-minimum-guard.test.ts` → 43 passed.
- `npm run build` → exit 0 (next-env.d.ts + tsconfig.json restored from origin/main
  after the build rewrote them; package-lock.json restored after `npm install`).
- Full `npm test` in this CI VM has pre-existing failures in LLM/red-team/episodic
  suites (llm-provider, red-team, p0-safety-fixes, persistence-notification,
  redteam-failure-routing, strategy-bear-fail-closed, strategy-episodic-injection,
  strategy-money-path-f-g, strategy-prompt-safety, usage-budget-strategy-integration,
  e2e-money-path). Confirmed identical failures on the base tree with my change
  stashed — they stem from LLM credentials being present in this VM, not from this
  change. The `verify` CI gate runs without those keys.

## Follow-ups
- None. The bracket-minimum raise directly above (Alpaca whole-share) still guards
  on `targetNotional > 0`; Codex did not flag it and it is a whole-share concern,
  so it was intentionally left untouched to keep scope to the reported finding.
