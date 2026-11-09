# Rollout: Market-Data Staleness Gate (improvement-program item #5)

**Date:** 2026-06-26
**Branch:** `agent/claude-staleness-gate`
**Status:** Ready for land — `npx tsc --noEmit` clean, `npx vitest run test/staleness-gate.test.ts` 9/9 pass.

---

## Summary

Adds a per-data-class market-data staleness gate to the proposal evaluation path.
Today data freshness is only a label — the strategy can act on stale-but-cached market data.
This change makes staleness enforcement real and fail-safe.

Two new optional fields on `TradingPolicy` (`maxQuoteAgeSec`, `maxFundamentalsAgeSec`) gate
opening proposals whose backing market data is older than the threshold.
The gate is **DEFAULT OFF** — fields absent from `DEFAULT_POLICY` — so zero behavior change unless explicitly enabled.

---

## Why

Improvement program item #5: data freshness enforcement. Without this, a proposal built on an
hours-old scan snapshot could still execute with no warning. The fix is additive and fail-safe
(stale → block, never the reverse).

---

## Files Touched

- `src/lib/types.ts` — added `maxQuoteAgeSec?: number` and `maxFundamentalsAgeSec?: number` to `TradingPolicy`.
- `src/lib/policy.ts` — added STALENESS GATE block inside `evaluateTradeProposal`, after the entry-drift block, scoped to `isOpening`.
- `app/api/policy/route.ts` — added 2 validation lines for the new fields (non-negative number check).
- `test/staleness-gate.test.ts` — NEW, 9 tests covering all required cases.
- `STATUS.md` — updated.
- `docs/rollouts/2026-06-26-staleness-gate.md` — this file.

**Unchanged by design:**
- `src/lib/defaults.ts` — gate-off = fields absent. Adding them to DEFAULT_POLICY would break the additive/default-off guarantee. The absence IS the off state.
- `src/lib/market.ts` — `MarketQuote.asOf`, `MarketQuoteSummary.asOf`, and `MarketScan.generatedAt` already carry real provider/scan timestamps. The gate reuses them; nothing to add.
- `src/lib/strategy.ts` — both `evaluateTradeProposal` call sites at lines ~486 and ~1341 already pass `marketScan` in the `PolicyContext`. The backing data timestamp is already visible to policy.ts; no threading needed.

---

## Design decisions

- **Fields on `TradingPolicy`, not `RiskRules`.** The `riskRules` validation loop at `app/api/policy/route.ts:164` treats every `riskRules` entry as a "must be non-negative number." The existing pattern for data-quality gates (`maxEntryDriftPct`, `maxOrderPctOfAdv`) is top-level on `TradingPolicy`. Followed that pattern.
- **Gate reads `quotesBySymbol[sym].asOf`, falling back to `topCandidates[].asOf`, then `generatedAt` for fundamentals.** This is exactly the timestamp data that flows from the market scan — no fabrication.
- **Boundary: `ageSec > max` (strictly greater).** Exactly at-threshold is ALLOWED. Test #3 verifies this.
- **Exits never gated.** The gate is inside `if (isOpening)`. Sell/cover orders are never blocked regardless of data age.
- **Missing or unparseable `asOf`** → `Number.isNaN(asOfMs)` → treated as stale/blocked when gate on. Fail-safe.
- **`context.now` used for time injection** (already in `PolicyContext`), enabling deterministic testing without `Date.now()` calls.

---

## Verification

```bash
cd /Users/jay/Code/agentic-trading-stops
npx tsc --noEmit      # clean — no output
npx vitest run test/staleness-gate.test.ts
# Test Files  1 passed (1)
#       Tests  9 passed (9)
```

Full tsc/test/build trio run by orchestrator at land time.

---

## Follow-ups

- Consider adding a UI toggle for the staleness gate in the policy settings page (currently setting is API-only).
- Consider per-symbol fundamentals timestamps if a future data provider surfaces them (currently `generatedAt` is the only scan-level proxy).
- The route validation accepts `0` (treated as gate-off by the `> 0` check) — this is consistent with `maxEntryDriftPct` semantics and intentional.
