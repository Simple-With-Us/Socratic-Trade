# 2026-07-01 — Massive REST as a REAL second short-interest source (PR #309)

Branch `fix/fmp-short-interest-gate` (PR #309). Repurposes the stalled "gate the dead FMP short-interest
call" PR into "wire a real second short-interest source," per the owner's direction on the conflict.

## Summary

`main` had already resolved the underlying issue (FMP has no `/v4/short_interest` endpoint) by DELETING
the second-source machinery entirely and leaving a NOTE pointing at Massive/Finnhub. #309's original
approach (keep the FMP scaffold wired-but-off as `FUTURE_SOURCE_SHORT_INTEREST_ENABLED`) was therefore
superseded. Rather than close it or ship inert scaffold, the owner asked to **add a real second source
using Massive/Finnhub**. This delivers that with **Massive's REST API**.

- Merged `origin/main` into the branch, resolving all short-interest conflicts to main's clean removal
  (the branch is now even with main for that code — the original FMP commits are superseded by the merge).
- Added `MassiveEnrichmentProvider` (`src/lib/data-providers.ts`): per-symbol, fetches Massive's FINRA
  **short interest** (`/stocks/v1/short-interest`, shares short) + **free float** (`/stocks/vX/float`,
  shares) and computes short % of float = `short_interest / free_float * 100` — apples-to-apples with
  Yahoo's `shortPercentOfFloat`. Auth `Authorization: Bearer <MASSIVE_API_KEY>` against
  `https://api.massive.com` (base + auth verified against Massive's official REST docs AND its official
  MCP server source, not guessed). Populates ONLY the carrier field `shortPercentOfFloatSecondary`.
- Re-added the source-agnostic cross-check machinery in the cascade: carry the secondary read (not
  first-wins), and when the primary (Yahoo-first) and Massive reads differ by more than
  `SHORT_INTEREST_DISAGREEMENT_PCT_PT` (default 5pp), set `shortInterestDisagreement`; then delete the
  carrier so it never leaves the cascade. Re-added the `market.ts` `applyEnrichment` plumbing that
  surfaces the note into `evidenceBulletins` (both had been removed by main).
- Registered the provider in `getEnrichmentProvider`, gated on `massive.key` (env `MASSIVE_API_KEY`,
  already in the key registry) AND `massiveShortInterestEnabled()` (default ON) — **inert with no calls
  in the default keyless setup**, so no behavior change until an operator sets a Massive key.

## Why Massive, not Finnhub

Finnhub's short interest is premium-gated and not in the `/stock/metric` payload the app already fetches;
verifying it wasn't possible. Massive's REST short-interest + float endpoints were verified live (real
FINRA data, e.g. AAPL 144.2M shares short ÷ 13.5B float ≈ 1.07%). Yahoo remains the primary/floor; this
is a corroboration source that only ever adds a disagreement bulletin, never overrides the primary value.

## Config (all optional; feature dormant unless `MASSIVE_API_KEY` is set)

- `MASSIVE_API_KEY` — REST key (same Massive account as the flat-file S3 access).
- `MASSIVE_REST_BASE_URL` — default `https://api.massive.com`.
- `MASSIVE_SHORT_INTEREST_ENABLED` — OFF-switch for the 2 calls/symbol; default ON when a key is set.
- `MASSIVE_SHORT_INTEREST_TTL_MS` — cache TTL; default 12h (FINRA reports ~biweekly).
- `SHORT_INTEREST_DISAGREEMENT_PCT_PT` — disagreement threshold; default 5.

## Files

- `src/lib/data-providers.ts` — `MassiveEnrichmentProvider`, `massiveFirstResult` helper, cascade carry +
  disagreement + carrier delete, `shortInterestDisagreementThresholdPct` / `massiveShortInterestEnabled` /
  `massiveShortInterestTtlMs` / `massiveRestBaseUrl` helpers, `SymbolEnrichment` fields, provider registration.
- `src/lib/market.ts` — `applyEnrichment` surfaces `shortInterestDisagreement` into `evidenceBulletins`.
- `test/data-providers.test.ts` — 7 new tests (disagreement flag/within-threshold/single-source/threshold
  override; provider computation + Bearer auth, zero-float no-fabrication, 404 tolerance).
- `.env.example` — new "Massive REST API" section documenting the 5 env vars.

## Verification (in `~/apps/trading-conflict-fix`)

- `npx tsc --noEmit` — exit 0 (after build regenerated `.next/types`).
- `npm test` — **2173 passed** / 224 files.
- `npm run build` — exit 0.
- `npm run lint` — 0 errors (279 grandfathered warnings, none in touched files).
- Massive endpoints verified live via the Massive MCP: `/stocks/v1/short-interest` + `/stocks/vX/float`
  return real FINRA short interest + free float; base URL + Bearer auth confirmed from the official
  `massive-com/mcp_massive` server source (`server.py`: `_base_url="https://api.massive.com"`,
  `Authorization: Bearer`).

## Follow-ups

- Uses two REST calls/symbol; cached 12h. If a future Massive endpoint returns a ready-made
  short-%-of-float, collapse to one call.
- Finnhub remains a possible additional source if a premium short-interest plan is added later.
