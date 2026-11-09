# 2026-06-16 - tax-mitigation

## Summary

US tax-mitigation features for frequent trading (branch `ui-redesign`). All
estimates are clearly labeled "not tax advice." Five capabilities:

1. **Wash-sale lockout guardrail (IRC §1091).** The policy engine now blocks the
   agent from rebuying a symbol it closed at a **loss within the last 30 days**
   (which would disallow the loss). Configurable via `policy.taxSettings.washSaleGuard`
   (default on). Wired into both the autonomous run and the manual approval path.
2. **Tax panel** (new "Tax" workspace tab): YTD **short-term vs long-term**
   realized gains, a rough **estimated liability** at configurable ST/LT rates,
   **disallowed wash-sale losses**, the current **wash-sale lockout** symbols +
   detected wash sales, **tax-loss-harvest candidates**, and a **holding-period**
   table (days held / days-to-long-term with a progress bar per open lot).
3. **Days-to-long-term** awareness, so marginal winners can be held past the
   1-year line (long-term rate ≪ short-term ordinary rate).
4. **After-tax agent context.** `proposeTrades` now sends the agent a `taxContext`
   (YTD ST realized, estimated liability, wash-sale-locked symbols, positions
   near long-term, harvestable losses) with prompt guidance: never buy a locked
   symbol, prefer holding near-long-term winners, harvest losers when ST gains
   are large.
5. **Tax-loss-harvest suggestions** — open long lots marked below cost, surfaced
   on the Tax tab and to the agent.

## How it works

- New `src/lib/tax.ts`:
  - `getWashSaleLockedSymbols(account, source, now)` — symbols with a long-side
    loss-closing sale within the last 30 days (the guardrail set).
  - `getTaxSummary(account, source, currentPrices, settings, now)` — the full
    `TaxSummary` (ST/LT realized for the current tax year with disallowed
    wash-sale losses excluded, estimate, wash sales, locked symbols, open-lot
    holding periods, harvest candidates).
  - `detectWashSales(...)` — a loss-closing long sale with a *separate* buy of the
    same symbol within ±30 days (excludes the lot's own opening buy).
- `src/lib/performance.ts` now exposes `openLots` on `PnlResult` and a
  `getOpenLots()` accessor (entry date + side per unclosed lot).
- `src/lib/policy.ts` `PolicyContext` gains `washSaleLockedSymbols?: Set<string>`;
  a buy of a locked symbol is blocked when `taxSettings.washSaleGuard` (default
  on).
- `TaxSettings` added to `types.ts` (optional on `TradingPolicy`) +
  `DEFAULT_TAX_SETTINGS` (washSaleGuard on, 24% ST, 15% LT). The policy PUT route
  merges + validates the rates.
- `src/lib/dashboard.ts` adds `tax` to the snapshot; UI Tax tab + Settings → Tax
  section (guard toggle + rate inputs).

## Caveats (intentional simplifications)

- "Substantially identical" wash sales (e.g. two S&P 500 ETFs) are **not**
  detected — only same-symbol. Cross-account / IRA wash sales aren't modeled.
- The liability **estimate** ignores ST/LT cross-netting, the $3,000 ordinary
  offset cap, NIIT, and state tax. It is a directional signal, not a filing
  figure. Labeled as such throughout.

## Files

- New: `src/lib/tax.ts`, `test/tax.test.ts`.
- Edited: `src/lib/types.ts`, `src/lib/defaults.ts`, `src/lib/performance.ts`,
  `src/lib/policy.ts`, `src/lib/strategy.ts`, `src/lib/dashboard.ts`,
  `app/api/policy/route.ts`, `app/dashboard-types.ts`, `app/dashboard-client.tsx`,
  `test/policy.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 92 passed (+6: 4 tax, 2 wash-sale guardrail)
npm run build      # succeeds
```

Tax engine tests cover: 30-day lockout window (in vs out), wash-sale detection +
loss disallowance, short-term vs long-term classification at the 1-year boundary,
long-term rate estimate, and harvest candidates. Policy tests confirm a locked
symbol's buy is blocked (guard on) and allowed (guard off). Tax tab verified
in-browser (dark): all panels render.

## Follow-ups

- Optionally model "substantially identical" lockouts for known ETF pairs.
- A "trade in a tax-advantaged account" hint, and §475(f) MTM info, are
  informational follow-ups.
