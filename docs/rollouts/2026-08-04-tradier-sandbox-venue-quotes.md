# 2026-08-04 — Venue-aligned quotes for Tradier Sandbox

## Context & Objective

Tradier **sandbox/paper** only has ~15-minute delayed market data, and the paper OMS
fills against that delayed tape. The multi-source quote cascade was treating those
delayed broker quotes as "stale" and replacing them with fresher Alpaca/Yahoo prices —
so sizing, limits, and policy ran on prices the sandbox cannot fill at. Owner
directive: for that account, use the delayed venue quote as authoritative.

## Changes Made

- **Venue quote mode** (`resolveVenueQuoteMode`): Tradier + `environment: "paper"` →
  `venue_delayed`; everything else (including Alpaca paper and Tradier production) →
  `realtime`.
- **Cascade** (`fetchFreshQuotesCascade`):
  - On `venue_delayed`, accept priced broker quotes immediately, stamp
    `venuePriceAuthoritative` + `fetchedAt`, and **do not** continue to Alpaca/Yahoo
    for those symbols.
  - On `realtime`, keep existing 120s trade-time freshness behavior (Alpaca paper still
    prefers live-ish quotes).
- **Staleness age** (`quoteAgeSecForStalenessGate`): venue-authoritative quotes age by
  `fetchedAt` (snapshot freshness), not trade-time `asOf` (expected ~15m delay).
- **Policy** uses that age helper so delayed sandbox tape no longer trips "stale quote
  backup" limit conversion on every opening.
- **mergeQuoteData** + `BrokerQuote` / `MarketQuote` / `MarketQuoteSummary` carry the new
  fields through the scan.
- Call sites pass `connectedAccountId` so multi-account runs resolve the correct venue.

### Touched files

- `src/lib/types.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/policy.ts`
- `src/lib/market.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-execution.ts`
- `test/quotes-cascade.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-04-tradier-sandbox-venue-quotes.md`

## Decisions & Trade-offs

- Only **Tradier paper** is venue-delayed. Alpaca paper is a real-time simulation and
  keeps the fresher-cascade path.
- Symbols the sandbox broker cannot price may still fall through to external last-resort
  marks (no price is worse than a non-venue mark); those are **not** stamped
  `venuePriceAuthoritative`.
- Does not change Tradier production (live) behavior.

## Verification State

```bash
npx vitest run test/quotes-cascade.test.ts
npx tsc --noEmit
```

## Next Steps & Blockers

- Land via `scripts/land.sh` from the feature worktree.
- After deploy, confirm Sandbox Autopilot openings no longer soft-hold solely for
  `quote is ~9XXs old (max 120s)` when the quote is venue-delayed Tradier.
