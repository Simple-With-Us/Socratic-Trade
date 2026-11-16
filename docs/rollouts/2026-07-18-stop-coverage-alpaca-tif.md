# 2026-07-18 — Fixed/ATR tick-cadence stop backstop + Alpaca GTC tif normalization

Branch: `claude/stop-coverage-alpaca-tif` (worktree `.claude/worktrees/agent-acf59a9fecaed9c26`).
Two money-path fixes from the Codex audit backlog (items 7 and 10). No push yet; PR to follow.

## Summary

**Item 7 — fixed/ATR stop plans get tick-cadence protection when no broker order covers them.**
Previously a position whose per-position stop plan was `fixed` or `atr` was *excluded* from the
synthetic-stop tick monitor entirely (purged + never registered), so its only enforcement was
(a) whatever entry bracket survived to the broker and (b) the hourly-cadence
`generateProactiveRiskProposals` check in `strategy.ts`. A fractional, bracket-disabled,
bracket-stripped (e.g. Tradier market entry), or unsupported-order-type position could cross its
stop with nothing watching for up to a full strategy-run interval. Now the monitor registers a
**static-trigger row** (`kind: "fixed"` on `synthetic_trailing_stops`) for fixed/atr-plan positions
— but **only when no live broker-held/other exit order already covers the position** (quantity-aware
`liveExitOrderCoverage`, same-tick placement staleness guards, halted-registration skip — all
identical to the trailing lane's existing guards). The row reuses the existing evaluation/fire
machinery verbatim (CAS claim, fire-generation/refId dedup, coverage-aware partial fires, bad-tick
confirmation, protective-exit routing); the only mechanical difference is that a `fixed`-kind row's
`extremePrice` is re-pinned to `entryPrice` every tick (never persisted from the ratchet), so the
same `evaluateStop` math yields a fixed distance from entry instead of a trail. Trailing behavior is
untouched.

Distance resolution mirrors `generateProactiveRiskProposals`' `effectiveStopPct` precedence:
`fixed` → account `stopLossPct` (or `STOP_PLAN_FALLBACK_STOP_PCT` = 8 when unset); `atr` → the tick
monitor has no bars to compute a live ATR %, so it uses the SAME base-%/fallback branch the
proactive layer itself falls back to when its ATR precompute lacks the symbol — the identical
fallback, not a divergent approximation. The hourly proactive check still applies the real
ATR-derived distance when it has bars (unchanged, remains the run-cadence backstop).

**Item 10 — Alpaca adapter normalizes GTC → day for fractional/notional orders.** Alpaca rejects
`time_in_force=gtc` on any order carrying a fractional share quantity or a notional (dollar) amount
(fractional trading is day-only — docs.alpaca.markets). Previously `alpaca.ts` passed a caller's
`gtc` straight through, guaranteeing a broker 422 on e.g. a GTC fractional exit or a dollar-routed
GTC entry. New exported `resolveAlpacaTimeInForce()` resolves the tif once per placement against the
quantity/notional ACTUALLY being submitted (post bracket-dollar→qty floor), is called from all three
placement paths (REST, MCP args, native trailing-stop), and emits an
`alpaca_tif_normalized_to_day` audit receipt carrying the original intent
(`requestedTimeInForce`, `reason: fractional_quantity | notional`, qty/notional) whenever it
overrides a caller's `gtc`. Whole-share GTC orders are untouched; brackets keep their pre-existing
forced-"day" (native OCO) behavior and are deliberately NOT flagged as this item's normalization.

## Why

Both are correctness holes on the money path: item 7 leaves real positions unprotected between
strategy runs; item 10 turns valid protective/entry intents into guaranteed broker rejections.
Neither adds blocking ceremony — item 7 only adds protection where the owner's chosen plan already
promised it, and item 10 submits the order the broker can actually accept while honestly recording
the changed field.

## Files

- `src/lib/db.ts` — additive guarded migration: `synthetic_trailing_stops.kind TEXT NOT NULL
  DEFAULT 'trailing'`.
- `src/lib/db-api-keys.ts` — `SyntheticTrailingStop.kind?: "trailing" | "fixed"`;
  `mapSyntheticStop` + `upsertSyntheticStop` read/write the column (legacy rows default `trailing`).
- `src/lib/synthetic-stops.ts` — plan-purge pass now kind-aware (a `fixed`-kind row survives while
  its plan stays fixed/atr; purged on plan change away; `none` purges everything); new static-trigger
  registration pass for fixed/atr plans (coverage-gated, halted-gated, short-selling-gated); fire
  loop pins `extremePrice` to `entryPrice` for `fixed`-kind rows pre-eval and on persist; receipts
  (`synthetic_stop_registered_fixed`, `kind` on `synthetic_stop_triggered`, kind-aware rationale).
- `src/lib/alpaca.ts` — `resolveAlpacaTimeInForce()` (exported, pure); wired into the trailing,
  REST, and MCP placement paths; `effectiveQty`/`effectiveNotional` single-source refactor of the
  qty/notional branching (REST and MCP now provably submit the same values);
  `alpaca_tif_normalized_to_day` audit receipts.
- `test/synthetic-stops.test.ts` — updated the "'fixed'/'atr' plan does not touch this trailing
  lane" test to the new expectation (fixed plan now gets a static-trigger row that fires at the fixed
  level); new "item 7" describe block: atr fallback registration + receipt, no-double-enforcement
  when a live broker stop covers, no-ratchet three-tick sequence (rally→pullback above fixed
  level→break), plan-change purge, halted registration skip.
- `test/alpaca-tif-normalization.test.ts` — NEW: 6 pure-matrix tests for
  `resolveAlpacaTimeInForce` + 7 end-to-end placement tests (fractional GTC→day+audit, notional
  GTC→day+audit, whole-share GTC unchanged+no audit, fractional native-trailing GTC→day, whole-share
  native-trailing GTC unchanged, bracket dollar entry stays day/qty-floored/not-double-flagged,
  gfd never flagged as normalized).
- `docs/rollouts/2026-07-18-stop-coverage-alpaca-tif.md` — this note.

Deliberately untouched per the task brief: `STATUS.md`, `docs/EFFORT-LOG.md` (coordinator-owned this
lane), `scheduler.ts` halted-authority and `strategy.ts` Tradier-bracket hunks (owned by PR #1738).

## Overlap notes

- **PR #1738** (`claude/money-path-followups-1701`, open): owns `synthetic-stops.ts`'s
  `reconcileBrokerProtectiveStops` call-site hunk (`haltedProtectOnly`) and `strategy.ts`'s
  `enrichOpeningProposal` Tradier-bracket-strip/marketable-limit hunks. This branch touches
  NEITHER hunk: our `synthetic-stops.ts` edits are in the purge/registration/fire sections
  (lines well below the reconcile call), and we don't touch `strategy.ts` at all. Halted semantics
  were left exactly as on main (`policy.systemState !== "halted"` gates registration; the scheduler
  decides whether the monitor runs at all) — #1738's authority split is not re-implemented. The two
  branches share no overlapping diff hunks; a later merge of both is textually clean in
  `synthetic-stops.ts` (different regions) and trivially clean elsewhere.
- **Exit-strategy roadmap** (`docs/design/exit-strategy-intelligence.md`): this is the minimal
  version of **Rec 2** ("static-trigger rows in the existing synthetic framework"), implemented as
  the doc's own sketch suggests (kind discriminator, registration instead of `continue`, purge made
  kind-aware, proactive layer kept as run-cadence backstop). NOT included (still tracked, on
  purpose): Rec 1's trailing bad-tick gap-deadlock fix (fixed-kind rows inherit the current
  confirmation-based filter as-is), Rec 3's persisted Exit Contract (`resolved_stop_pct` — until it
  lands, the atr-plan tick row uses the documented fallback distance), halted-skips-monitor (Rec 1
  scope, and #1738's territory), and broker-held lanes for ATR/shorts (Recs 3/4).

## Verification (commands actually run)

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx tsc --noEmit                                            # clean (exit 0)
npx vitest run test/synthetic-stops.test.ts                 # 57 passed (52 pre-existing incl. 1 updated, 5 new)
npx vitest run test/alpaca-tif-normalization.test.ts        # 13 passed (all new)
npx vitest run test/alpaca-brackets.test.ts --hookTimeout=180000   # 18 passed
npx vitest run test/alpaca-order-mapping.test.ts test/alpaca-limit-stop-price-guard.test.ts \
  test/alpaca-mcp.test.ts test/alpaca-account-type.test.ts test/alpaca-account-insights.test.ts \
  test/alpaca-quote-fallback.test.ts test/alpaca-price-events.test.ts   # all passed (batch: 65 passed)
npx vitest run test/deep-safety-fixes.test.ts test/account-delete-cleanup.test.ts  # 20 passed
npx vitest run test/strategy-active-protection-wiring.test.ts --testTimeout=180000 # 2 passed
npx eslint <changed files>                                  # 0 errors, 30 warnings (all pre-existing
                                                            # grandfathered patterns; `MarketHours`
                                                            # unused-import predates this branch)
```

Notable non-failures: `alpaca-brackets` and `strategy-active-protection-wiring` each needed a raised
hook/test timeout on this machine — cold `vi.resetModules()` re-imports of the strategy/alpaca
module graph exceed 60s under load; both suites pass fully with the raised timeout and the same
timeouts were slow before this change (no code-path regression; not modified by this branch).
`npm run build` deliberately not run (task brief: no full build).

## Adversarial-verification follow-up (second commit on this branch)

The lane's adversarial verifier found one MUST-FIX in `003dd33e` (everything else confirmed safe):
the item-7 registration pass resolved a SHORT position's fixed/atr distance as
`shortStopLossPct > 0 ? shortStopLossPct : 8%`, skipping the `stopLossPct` middle tier the
proactive layer uses (`generateProactiveRiskProposals`: `shortStopLossPct > 0 ? shortStopLossPct :
stopLossPct`, with 8% only when BOTH are unset). Proven consequence: `stopLossPct=15`,
`shortStopLossPct` unset, short position — the backstop armed at 8% and fired a real cover at a
distance the owner never configured. Fixed to the identical three-tier chain
(`src/lib/synthetic-stops.ts`, one shared resolution line — the atr no-bars fallback resolves
through the same expression, so both plan styles are covered). Two regression tests folded into
`test/synthetic-stops.test.ts`'s item-7 block (15%-not-8% no-fire scenario; both-unset ⇒ 8% fires);
the verifier's standalone template (`test/adversarial-short-fixed-fallback.test.ts`) was absorbed
and deleted per its own "not for commit" header.

**Note for the landing operator:** main's `strategy.ts` Tradier market-entry bracket-strip
rationale string — "(and fixed/atr plans have no synthetic-stop monitor fallback)" (line ~5739 on
this branch's base, ~5804 on current main; inside `enrichOpeningProposal`, PR #1738's hunk
territory, deliberately untouched here) — becomes FALSE once this branch lands: fixed/atr plans DO
get a synthetic-monitor backstop now. Update that string during the merge.

## Follow-ups / risks

- The atr-plan tick row uses the flat-%/fallback distance (no bars at tick cadence). Honest and
  documented, but the real fix is roadmap Rec 3 (persist the resolved distance at fill and read it
  here). When that lands, the registration pass should read the persisted `resolved_stop_pct`.
- A `fixed`-kind row's quantity refreshes on registration only via the existing upsert-on-register
  path; per-tick fires already size from live position + coverage, so drift is bounded (same
  behavior as the trailing lane).
- `resolveAlpacaTimeInForce` treats `quantity != Number.isInteger` as fractional; a whole-share
  float like `10.0` is integer-true and stays GTC (correct).
- If PR #1738 lands first, re-run the synthetic-stops suite after merging — no textual conflict is
  expected, but both branches touch the same file.
