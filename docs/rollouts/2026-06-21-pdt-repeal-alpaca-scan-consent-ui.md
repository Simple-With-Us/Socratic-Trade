# 2026-06-21 — PDT-rule repeal, Alpaca scan data, data-pool consent UI

## Summary
Three related changes landed on `agent/claude` (PR #32):

1. **PDT rule retired → margin-minimum gate.** SEC/FINRA retired the Pattern-Day-Trader
   rule (FINRA Notice 26-10): the $25,000 minimum and the 4-day-trades-in-5-business-days
   limit no longer exist. The replacement framework is broker-side real-time intraday-margin
   monitoring plus a **$2,000 minimum equity for margin accounts**. The policy gate that
   previously enforced the repealed rule was replaced accordingly.

2. **Alpaca snapshot data wired into the Market Scan.** A new enrichment provider pulls
   real bid/ask, last price, volume, and intraday change from Alpaca's snapshots endpoint —
   replacing the previously fabricated ±0.1% spreads. Consent-gated like the other keyed
   providers. Verified end-to-end against the linked paper account.

3. **Data-pool consent UI.** The Settings modal now has a "Data" tab that *states* the
   shared-pool deal in plain language and provides a toggle wired to `GET/POST /api/consent`.
   This makes the opt-in both **stated** and **structurally enforced** (the structural half —
   key-source → cache scope — shipped earlier in PR #32).

## Why
- The PDT gate enforced a rule that no longer exists; leaving it would have wrongly blocked
  legitimate live opening orders for sub-$25k accounts. User flagged the repeal with sources
  (FINRA Notice 26-10; Alpaca's intraday-margin-framework announcement).
- The scan showed fabricated bid/ask spreads (financial-panel finding); the linked Alpaca
  paper account exposes real quotes/bars at no extra cost, so the scan should use them.
- The consent model was structurally true but only surfaced in a one-time modal; the user
  asked that Settings also *state* that opting in grants access to the shared pool.

## Files
- `src/lib/policy.ts` — replaced `PDT_EQUITY_THRESHOLD` ($25k) + `PDT_MAX_DAY_TRADES` (3) and
  the count-based PDT block with `MARGIN_MINIMUM_EQUITY` ($2,000) and a margin-minimum gate
  (LIVE + `accountCapabilities.marginEnabled` + equity < $2,000 → block, opening legs only).
  Day-trade counting (`priorDayTradeCount`, `countDayTradesInLastBusinessDays`) is retained
  but is now informational — the gate no longer reads it.
- `test/pdt.test.ts` — rewrote the gate describe block to the margin-minimum behavior
  (blocks LIVE margin < $2k; not at/above $2k; not cash/non-margin; not paper/Test; not on
  closing legs). Kept the `countDayTradesInLastBusinessDays` tests (function unchanged).
- `src/lib/data-providers.ts` — new `AlpacaSnapshotEnrichmentProvider` (+ exported pure
  `parseAlpacaSnapshot`), wired into `getEnrichmentProvider` after the Alpaca news provider;
  needs both `alpaca_paper_api_key` and `alpaca_paper_secret_key`, self-skips otherwise.
  Consent-gated cache (prefix `alpaca-snapshot`). Never fabricates a missing field.
- `test/data-providers.test.ts` — +10 tests (snapshot mapping, cache hit, HTTP-error → {},
  zero quotes not fabricated).
- `app/dashboard-client.tsx` — new Settings "Data" tab: shared-pool statement + Sharing
  toggle bound to `GET/POST /api/consent`; graceful on fetch failure.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — **557 passed** (69 files).
- Live Alpaca pull via the per-user store path (`source = user`): AAPL/MSFT/NVDA returned
  real price/bid/ask/volume/change; MSFT's missing ask was correctly omitted (not fabricated).
  Spreads are wide because the free paper feed is IEX (off-hours), which is expected.

## Follow-ups
- Optional: use Alpaca's SIP feed (paid) for NBBO-tight spreads instead of IEX; the provider
  hardcodes `feed=iex` today.
- Optional: surface the Alpaca-sourced bid/ask in a dedicated scan column (data now flows;
  column visibility is governed by `SCAN_COLUMNS` in `dashboard-client.tsx`).
- The Robinhood enrichment provider remains probe-gated; no change here.
