# Rollout: Sell-to-fund-buy 3-way setting (PR 3 of 3)

## Summary
Adds an opt-in `sellToFundBuy` policy setting: when a strategy run's intended BUYs exceed available
buying power, optionally raise cash by trimming existing holdings. 3-way (plus off):
`off | suggest | propose | automated`. **Default `off` — no behavior change until explicitly enabled.**

## Why
Today a BUY that exceeds buying power is simply blocked (`policy.ts` buying-power gate) and the idea
is lost. This lets the user opt into raising cash to act on it, with graduated control over how much
autonomy that gets.

## Behavior per mode
- **off** (default): no funding sells. Identical to today.
- **suggest**: compute a funding plan and record it (audit `sell_to_fund_plan` + run-summary note).
  Places no orders.
- **propose**: emit the funding sells as **proposed** (human approval) — even under "decide"
  authority, since raising cash by selling is the user's call.
- **automated**: emit the funding sells into the normal pipeline so they execute under the account's
  existing authority (auto-placed only when the account is already in "decide" mode; proposed under
  "propose"; simulated in Test).

## Safety / design
- **Default off** → the whole integration short-circuits; production unchanged until opt-in.
- Decision logic is a **pure, fully-unit-tested** function (`src/lib/sell-to-fund.ts`
  `planFundingSells`): trims the **largest unrealized losers first**, only sells **long** positions,
  **never** sells the run's buy targets or already-proposed exits, and sizes shares to cover the
  shortfall (capped at position size; best-effort when holdings can't fully cover).
- Funding sells flow through the **same tradability + policy gates** as every other proposal.
- **No same-run sell→fill→buy sequencing** (deliberately): buys are evaluated against the start-of-run
  buying-power snapshot, so in "automated" mode a run raises cash and the buys fit on the next cadence
  once sells settle. This avoids shipping unverified intra-run fill-await logic.
- The tuner LLM cannot toggle this (intentionally omitted from `StrategyTuningPatch`) — auto-liquidation
  stays a human setting.

## Files
- `src/lib/sell-to-fund.ts` (new — pure planner)
- `src/lib/types.ts` (`SellToFundBuyMode` + `TradingPolicy.sellToFundBuy`)
- `src/lib/defaults.ts` (`sellToFundBuy: "off"`)
- `src/lib/strategy.ts` (run-loop integration + propose-mode branch + summary note)
- `app/api/policy/route.ts` (enum validation)
- `app/dashboard-client.tsx` ("Sell to fund buys" select in Key Parameters)
- `test/sell-to-fund.test.ts` (new)
- `docs/...`, `STATUS.md`

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1089/1090 (sole failure = pre-existing `cache-provenance` env flake, unrelated).
- `npm run build` — green.
- New tests: off is a no-op; no shortfall → empty; largest-loser-first + share sizing; buy targets
  excluded; longs only + best-effort summary when holdings can't cover.

## Recommendation
Because this is the only one of the three PRs that *generates sell orders*, validate it in **Test/paper
mode** before enabling "automated" on a live account. Default-off means merging/deploying changes nothing.
