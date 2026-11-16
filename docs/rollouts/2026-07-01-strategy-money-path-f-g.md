# 2026-07-01 — Strategy money-path: Red Team verdict, risk-wiring audit, pre-flight guard, observability (audit split F/G)

This is the **strategy/red-team** slice of the 2026-07-01 audit work-split
(`docs/reviews/2026-07-01-audit-work-split.md`, Chat F lines 200-245 + Chat G lines 248-290), done
concurrently with three sibling agents on disjoint files. This agent owned only:
`src/lib/{types,strategy,red-team,observability,risk-breaker}.ts`, a new
`src/lib/preflight-live-guard.ts`, new `test/` files, `docs/phase-7-strategy.md`, and this note.

## Summary

- **F1 — first-class `redTeamVerdict` field.** Added
  `redTeamVerdict?: { rejected: boolean; available: boolean; reason: string }` to the
  `TradeProposal` interface (`src/lib/types.ts`) — the exact optional shape contracted with Agent A
  (UI). In `runStrategyOnce`'s red-team loop (`src/lib/strategy.ts`, the
  `for (const proposal of sizedProposals)` block) the debate result is now assigned to
  `proposal.redTeamVerdict` in every branch, alongside the preserved backward-compat rationale-append
  text. Verified it round-trips through `insertProposal` (whole proposal JSON-serialized into the
  `trade_proposals.proposal` column via `ensureReferencePrice`, which spreads all fields) — **no DB
  migration needed, `db.ts` untouched.**
- **F2 — audit Bear rejections.** Added
  `audit("proposal_rejected_by_red_team", { symbol, side, thesisTag, reason }, userId)` before the
  `continue` in the `redTeamResult.rejected` branch, mirroring the sibling
  `proposal_skipped_negative_ev` / `proposal_skipped_correlation` audit shape.
- **G5 — drawdown kill-switch (VERIFY): already wired + durable.** Confirmed
  `src/lib/strategy.ts:~253-262` flips an `active`, autonomous run to `close_only` via `setPolicy`,
  audits `policy_violation_drawdown`, and sends a `kill_switch` notification on a breach; HWM +
  start-of-day equity persist in the settings KV (`risk-breaker.ts:65-93`), so they survive a
  restart. **No behavior change.** Decision on (a): kept the HWM update gated on `active` — updating
  HWM on non-active runs would *ratchet the peak up* during periods the operator halted the system,
  which weakens the subsequent drawdown measurement; leaving it gated is the default-safe choice.
  Added the missing regression test (breach→`close_only` through `runStrategyOnce`, plus a
  no-limit-configured no-op case). `risk-breaker.ts` left unedited (no real gap found).
- **G6 — correlation cluster gate (VERIFY): built + wired + opt-in.** Confirmed
  `applyCorrelationClusterGate` (`strategy.ts:~1087`) runs at `~509` *before* execution, keyed on
  `policy.maxAvgCorrelation` (default off), drops over-correlated *opening* buy/short with
  `proposal_skipped_correlation` while exits always pass. Already covered by
  `test/correlation-cluster-gate.test.ts` (drop-opening/keep-exit + below-cap-keep + cap-off no-op).
  **No new test needed; no behavior change.** (Did not touch `app/api/policy/route.ts` — read-only.)
- **G7 — money-path e2e + live pre-flight guard.** New `test/strategy-money-path-f-g.test.ts` drives
  `runStrategyOnce` in Test/paper mode (simulated fills) with a stubbed LLM + Test broker, asserting
  the full proposal→evaluate→execute path books a paper fill and persists a proposal + `fill_event`
  (and doubles as the F1/F2 integration test). New `src/lib/preflight-live-guard.ts`
  (`assertLivePreflight`) is a pure, default-SAFE guard wired into `strategy.ts` immediately before
  `gateway.placeEquityOrder`: a hard no-op in Test/paper mode; on the `broker/live` path it throws
  (blocking the order + auditing `order_blocked_live_preflight`) unless `paperMode === false` **and**
  `ALLOW_LIVE_TRADING=true` (or per-call `allowLive`). Never places/enables a trade.
- **G10 — observability stamping.** Added `export const STRATEGY_PROMPT_VERSION =
  "agentic-strategy@0.1.0"` and stamped `metadata.promptVersion` onto the bull, bear
  (`src/lib/strategy.ts`) and red-team (`src/lib/red-team.ts` — via the existing constant import path;
  actually stamped on the two strategy generations here, red-team debate was already traced) generation
  calls. The bear generation's `output` mapper now stamps `bearVeto`/`bearVetoCount`. Added
  `recordDecisionObservation` to `src/lib/observability.ts` (a fire-and-forget event span, hard no-op
  when Langfuse is unconfigured) and wired a stamped `trading.strategy.diversity-collapse` observation
  at the rationale-collapse check.

## Why

- The Bear verdict was previously only appended to a truncated free-text rationale (invisible in the
  UI) and a Bear *rejection* was only `console.log`'d — never audited. F1/F2 make both first-class.
- G5/G6 were flagged as "verify, do not rebuild" — the audit wanted confirmation the kill-switches
  are actually wired and a regression net so they can't silently regress. Only the drawdown
  strategy-level flip lacked an end-to-end test.
- G7's pre-flight guard is defense-in-depth: a last assertion that a run cannot reach real capital by
  a mis-wired code path, defaulting off so paper/test is unaffected.
- G10 makes prompt revisions and the Bear-veto / diversity-collapse decision points queryable in
  Langfuse without changing runtime behavior when Langfuse is off.

## Behavior-change safety

Default behavior is byte-identical when new flags are off. The only recorded/observed changes are the
two audit additions (F2 `proposal_rejected_by_red_team`, the pre-flight `order_blocked_live_preflight`
which can only fire on a would-be live order), the new persisted `redTeamVerdict` field, and Langfuse
metadata/observations (no-op when unconfigured). No trade-enablement path changed; the pre-flight
guard only ever *blocks*, never enables. `ALLOW_LIVE_TRADING` defaults off.

## Files

Created:
- `src/lib/preflight-live-guard.ts`
- `test/preflight-live-guard.test.ts`
- `test/strategy-money-path-f-g.test.ts` (F1 + F2 + G7 money-path)
- `test/strategy-moneypath-drawdown-flip.test.ts` (G5 regression)
- `test/redteam-observability-g10.test.ts` (G10)
- `docs/rollouts/2026-07-01-strategy-money-path-f-g.md` (this note)

Modified:
- `src/lib/types.ts` — `redTeamVerdict` on `TradeProposal`.
- `src/lib/strategy.ts` — F1 assign + F2 audit; `STRATEGY_PROMPT_VERSION`; promptVersion on bull/bear
  metadata; bear-veto output stamp; diversity-collapse observation; pre-flight guard wiring.
- `src/lib/observability.ts` — new `recordDecisionObservation` helper.
- `docs/phase-7-strategy.md` — Red Team section + audit-split F/G changelog.

Untouched (verified, no real gap): `src/lib/red-team.ts` (debate logic out of scope),
`src/lib/risk-breaker.ts`, `src/lib/db.ts` (no migration needed).

## Verification (commands actually run)

Per the concurrency rules, only OWN targeted tests were run (no project-wide build/test — siblings
mid-edit). Dependencies were installed with `npm install` (the private
`@jaywedgeworth22/congress-trading-shared` package is unauthenticated in this env — a local
`node_modules/` stub was placed so the public tree installs and tests run; see caveat below).

```
node_modules/.bin/vitest run \
  test/preflight-live-guard.test.ts \
  test/strategy-money-path-f-g.test.ts \
  test/strategy-moneypath-drawdown-flip.test.ts \
  test/redteam-observability-g10.test.ts
# → 4 files, 14 tests passed

# Regression check of existing tests touching modified code:
node_modules/.bin/vitest run \
  test/red-team.test.ts test/correlation-cluster-gate.test.ts \
  test/risk-breaker.test.ts test/persistence-notification.test.ts
# → 4 files, 44 tests passed

# Full tsc, filtered to touched files → 0 errors in any owned file.
node_modules/.bin/tsc --noEmit    # (see caveat)
```

## Caveats / cross-file integration risk

- **Agent A contract (`redTeamVerdict`):** used the exact optional shape
  `{ rejected: boolean; available: boolean; reason: string }` from the kickoff spec. The strategy
  populates all three fields from `RedTeamDebateResult`. Low risk.
- **congress-shared stub artifact:** the private package could not be fetched (401, no
  `read:packages` token). A minimal local `node_modules/@jaywedgeworth22/congress-trading-shared`
  stub (typed `any`) was placed so the tree installs and my tests run. This causes **one** spurious
  `tsc` error — `src/lib/web-sources/congress-analytics.ts(178,60): error TS7006` (implicit-any on a
  `.map` param whose type comes from the stubbed package). It is a **stub artifact only**: the real
  package supplies proper types and this error will not appear in the orchestrator's environment. No
  file this agent owns has any type error. **The orchestrator should run the full verify quartet in
  an environment with the real private package.**
- No `db.ts` change was required (the optional `redTeamVerdict` folds into the existing JSON payload
  column and round-trips — asserted in `test/strategy-money-path-f-g.test.ts`).

## Follow-ups / deferred

- The `redTeamVerdict` UI "Bear Review" block is Agent A's (Chat F item 1 rendering) — not in this
  slice.
- `STRATEGY_PROMPT_VERSION` is a minimal stamping constant; full prompt extraction/eval-versioning is
  the separate "Chat A" workstream (out of scope, not attempted).
- The ~2,975-line `src/lib/strategy.ts` split remains a deferred follow-up (audit item 11).
