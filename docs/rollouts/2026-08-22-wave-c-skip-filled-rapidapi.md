# 2026-08-22 Wave C skip filled RapidAPI / FilingAPI

## Context & Objective

Stop last-resort RapidAPI / FilingAPI spend when Yahoo (and other free waves) already filled the scan core, and make remaining Wave C cheaper (modules-only, no quote-only burns).

## Changes Made

- Wave B paid gate now uses `WAVE_B_GAP_FIELDS` (scan-useful).  `COVERAGE_GAP_FIELDS` stays the report list and still includes bid/ask/vwap/asOf.
- SteadyAPI `enrichOne` skips the quote call when `coveredFields` already has `price`; modules still run for missing sector/industry.  No quote reservation is taken on the skip path.
- `yh-finance-apidojo` and `seeking-alpha-rapidapi` register only when `YH_FINANCE_APIDOJO_ENABLED=1` / `SEEKING_ALPHA_RAPIDAPI_ENABLED=1` (RapidAPI listing 403 / API not found).
- FilingAPI 401 rejection persists in `durable_state` namespace `filingapi` key `rejected-fingerprint`.  `shouldUseFilingApiKey` re-reads it after restart; in-memory set remains the hot cache.
- Alpaca news registers exactly once.
- Wave C skips a scarce provider when its narrow useful subset is already filled (price-family + profile for SteadyAPI/YH15; core fund + news for AV RapidAPI; FilingAPI no longer double-gates on `insiderSentiment`).
- AV RapidAPI `needOverview` looks at core fund fields only, not `epsGrowth` / `analystBySource` alone.

Touched:

- `src/lib/enrichment-coverage.ts`
- `src/lib/data-providers.ts`
- `src/lib/filingapi-auth.ts`
- `test/enrichment-coverage.test.ts`
- `test/enrichment-scarce-tier-gate.test.ts`
- `test/filingapi-auth.test.ts`
- `test/rapidapi-providers.test.ts`

## Decisions & Trade-offs

- Bid/ask/vwap/asOf still appear in coverage reports; they just cannot force Wave B.
- FilingAPI Wave C useful fields omit `insiderSentiment` so Insiders RapidAPI owns that gap.  FilingAPI can still fill it if Wave C called it for sector/industry.
- YH ApiDojo / Seeking Alpha stay in-tree as opt-in failover; default is off.

## Verification State

Focused vitest on the files above (no `npm run build`, no `land.sh`).

## Next Steps & Blockers

Parent owns STATUS.md / PLAN.md / effort-board closeout and landing.  Keepout: Claude gather-budget `06df80cf`; sibling owns `history.ts` and `app/api/quote`.
