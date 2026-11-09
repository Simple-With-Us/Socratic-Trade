# 2026-06-30 — Robinhood fractional/small-dollar orders route as MARKET, not LIMIT

## Summary

`toMcpOrder` (`src/lib/robinhood.ts`) now coerces **opening buy** dollar-routed /
fractional equity orders into **regular-hours GFD market** orders and drops the
limit/stop price modifiers. Whole-share limit orders and explicit limit exits are
preserved unchanged, so marketable-limit entries and take-profit/trim semantics still
work.

## Why

Small-dollar buys (e.g. `$1` GOOG/AMAT on a ~$20 Robinhood account — intentional, given
the balance) showed as broker `Placed` in the UI but the account stayed cash-only: the
orders never filled. Root cause, confirmed in code: a dollar-routed order could reach
Robinhood's MCP `place_equity_order` as a **limit** order (and/or in extended hours) —
`toMcpOrder` forwarded `type`, `dollar_amount`, and `limit_price` together. Robinhood only
fills fractional/notional orders as **regular-hours market** orders; a fractional limit is
accepted by the API but sits working forever (shows "Placed", never spends cash). This is
exactly the symptom observed.

An earlier orphaned rollout note (`docs/rollouts/2026-06-30-robinhood-small-dollar-routing.md`,
left untracked in the integration worktree) reached the same diagnosis but its code was
never committed and its verification was blocked. This PR implements and verifies the fix
at the broker boundary, where it holds regardless of how upstream shaped the order.

## What changed

- `src/lib/robinhood.ts` — `toMcpOrder`: compute opening fractional/notional buys; when true →
  `type: "market"`, `limit_price`/`stop_price` omitted, `market_hours: "regular_hours"`,
  and `time_in_force: "gfd"`. Explicit sell exits preserve limit semantics; short/cover still throw.
- `test/robinhood-mcp.test.ts` — 4 regression tests: dollar-routed limit→market (buy, from
  extended hours), dollar-routed sell→market, whole-share limit preserved, whole-share market
  unchanged.

## Files

- `src/lib/robinhood.ts`
- `test/robinhood-mcp.test.ts`
- `docs/rollouts/2026-06-30-robinhood-fractional-market-fix.md`

(STATUS for this session is recorded in PR #281's `STATUS.md` entry; this PR is a scoped
code fix and adds only its rollout note to avoid a duplicate STATUS insert conflicting with #281.)

## Round 2 (Codex re-review)

- **P1 — don't coerce dollar-sized STOPS.** The first pass coerced *any* fractional/dollar order to
  market and stripped `stop_price`, which would turn a dollar-sized `stop_market`/`stop_limit`
  protective/trailing exit into an immediate market sell. The coercion now excludes stop order types
  (`isStop`): a fractional stop is left intact (Robinhood can't place a notional stop, so it must be
  caught upstream by policy, not silently reshaped).
- **P2 — cover fractional quantity-only orders.** A sub-whole-share `quantity` (e.g. `0.5` sh) with no
  `dollarAmount` is also fractional and market-only on Robinhood; the guard now treats
  `!wholeShare && (dollarAmount>0 || quantity>0)` as fractional, so a fractional-quantity limit is
  coerced too.
- **P2 — market-order-disabled interaction (acknowledged):** if a user disables `market` in
  `permittedOrderTypes` but keeps `limit`, a fractional limit is still coerced to market here, which
  bypasses that setting. `toMcpOrder` is the broker-payload layer and has no policy context; a
  fractional order is unsatisfiable as a limit on Robinhood regardless, so honoring
  `permittedOrderTypes` for that inherently-conflicting case belongs in upstream proposal
  normalization/policy (follow-up). The coercion serves the user's explicit small-dollar intent.

## Round 3 (Codex re-review)

- **Entry drift before fractional market routing:** `evaluateTradeProposal` now treats fractional
  opening limits as drift-guarded because Robinhood will route them as market orders.
- **Exit semantics preserved:** fractional/dollar sell limits are no longer coerced into immediate
  market sells; they keep their limit semantics and must be blocked upstream if unsupported.
- **Market TIF fixed:** fractional opening limit coercion now forces `time_in_force: "gfd"`.

## Round 4 (Codex re-review)

- **Broker-scoped fractional drift:** fractional opening limits are drift-guarded only when
  `policy.activeBroker === "robinhood"`. Brokers that preserve fractional limit orders keep the
  broker-side limit-price cap and do not need the Robinhood market-routing guard.

## Verification

- `npx vitest run test/robinhood-mcp.test.ts` — 15 tests pass (6 new + 9 existing).
- `npx tsc --noEmit` — clean.
- Round 4: `npx vitest run test/robinhood-mcp.test.ts test/strategy-hardening.test.ts` —
  54 tests pass; `npx tsc --noEmit` — clean.
- Full `verify` + `smoke` + `gitleaks` CI gates the merge.

## Follow-ups

- Any Robinhood orders already accepted as stale fractional-limit probes may need manual
  cancel/replace (or the existing `limit_order_stale` alert flow); this change affects newly
  submitted approvals/runs only.
- Owner may delete the now-superseded orphaned note
  `docs/rollouts/2026-06-30-robinhood-small-dollar-routing.md` in the integration worktree.
