# 2026-07-25 — Fix vs-SPY benchmark accuracy (cash-flow-aware)

## Context & Objective

Home showed misleading **vs SPY** figures (e.g. all-cash paper +31.1% with $0 P&L; live −77.7%
with sparse observations). The scoreboard must answer: *what would the same dollars have done
tracking SPY as money was added or removed?* Reading guide: if vs SPY is +5% and SPY rose +8%,
the account's time-weighted return was +13%.

## Changes Made

Root causes confirmed against the owner's screenshots:

1. **All-cash equity jumps** (paper resets / deposits) were counted as account return when flow
   inference required cash+fills only — raw growth ~+31% became "alpha".
2. **Cash→positions without a fill receipt** looked like a full withdrawal (cash to $0), and a
   zero TWR denominator fell through to raw equity ratio.
3. **`listPortfolioSnapshots` used `ORDER BY ASC LIMIT`**, keeping the *oldest* slice once history
   exceeded the cap.
4. **Benchmark ignored the live portfolio tip**, so quiet accounts compared stale mid-history.
5. **Synthetic paper curves** (`$100 + realized`) were eligible for SPY comparison despite a fake base.

Fixes:

- All-cash → all-cash gaps: equity delta is the external transfer.
- Missing-fill guards: cash vs positions moves opposite → trade, not ACH.
- TWR rebase when flow wipes prior equity (`denominator <= 0`).
- Newest-N snapshot query; tip curve with current portfolio; refuse synthetic curves.
- Home / Coach / Results copy shows **You X% · SPY Y%** so excess is auditable.

### Files

- `src/lib/benchmark.ts` — flow inference + TWR rebase + synthetic refusal
- `src/lib/types.ts` — `EquityCurvePoint.positionsValue`; benchmark docs
- `src/lib/performance.ts` — pass `positionsValue` on equity curves
- `src/lib/db-fills.ts` — newest-N chronological snapshot read
- `src/lib/dashboard.ts` — tip equity curve with live portfolio for SPY
- `app/console/results/page.tsx` — clearer vs-SPY copy
- `ios/SocraticTrade/HomeView.swift` — You / SPY breakdown under excess
- `ios/SocraticTrade/CoachView.swift` — same decomposition in coach insight
- `test/benchmark.test.ts` — +31% paper, missing-fill buy, −77.7% MtM, denom rebase
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- Kept **additive** excess (`accountTWR − calendar SPY`), matching the owner's reading guide.
  Cash-flow-matched SPY *TWR* equals calendar SPY buy-and-hold once flows are neutralized on the
  account side — no separate shadow wealth ratio.
- Live accounts that truly lost mark-to-market value still show large negative excess; that is
  correct. Fill-based Realized/Unrealized tiles remaining at $0 while broker equity fell is a
  separate ledger gap (incomplete fills), not a reason to zero the equity-curve scoreboard.
- Synthetic paper curves no longer produce a vs-SPY tile (honest empty) until real snapshots exist.

## Verification State

```bash
npx vitest run test/benchmark.test.ts   # 16/16 pass
# full gate before PR:
npm run lint && npx tsc --noEmit && npm test && npm run build
```

## Next Steps & Blockers

- After merge/auto-deploy, refresh Home on paper (all cash) — expect vs SPY ≈ −(SPY window return),
  with "You ~0% · SPY +X%" visible.
- If live still shows a large negative with true $0 trading P&L, investigate missing fill receipts
  / broker sync for that account (equity curve may be right; P&L tiles wrong).
- Optional: wire `computeSpyBenchmark` into `/api/connected-accounts/[id]/performance` so Results
  compare accounts get the same tipped curve (active account already uses dashboard path).
