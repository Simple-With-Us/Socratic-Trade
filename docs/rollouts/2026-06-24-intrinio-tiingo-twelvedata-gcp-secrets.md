# 2026-06-24 — Intrinio, Tiingo, TwelveData providers + GCP Secret Manager runner

## Summary

Wired three new market-data enrichment providers (Intrinio, Tiingo, TwelveData) into the cascading enrichment pipeline and added a GCP Secret Manager runner script mirroring the existing Infisical pattern.

## Why

- Intrinio 14-day free trial provides real-time delayed quotes, company profiles, PE/EPS/dividend_yield, and 52-week range via the v2 API.
- Tiingo free plan covers IEX real-time quotes, company name, and news headlines/sentiment for all scan symbols.
- TwelveData API key unlocks a broad `/quote` endpoint with price, % change, volume, company name, sector, industry, PE, EPS, beta, and 52-week range in a single batched call per scan.
- GCP Secret Manager allows storing API keys centrally so Claude, Codex, and the app itself can pull them at runtime without secrets in `.env.local` or committed to the repo.

## Decisions

- **Cascade ordering**: Intrinio and Tiingo sit in Tier 2 (after Robinhood, before FintechStudios/Finnhub) so their real-time/comprehensive data wins over the delayed FintechStudios tier. TwelveData sits immediately after Finnhub (its batched call covers fundamentals).
- **Key resolution tier**: All three registered as `"shared-operator-infra"` in `API_KEY_TIER` — env fallback applies, and a user's own key overrides and joins the consent pool.
- **GCP runner**: Graceful fallback — if `GCP_PROJECT_ID` is not set, the command runs directly without touching Secret Manager. Supports explicit `GCP_SECRET_NAMES` list or `GCP_SECRETS_PREFIX` filter.
- **Keys stored in `.env.local`** (git-ignored): real keys injected there for local/cloud use; never committed.

## Files touched

- `src/lib/data-providers.ts` — added `IntrinioEnrichmentProvider`, `TiingoEnrichmentProvider`, `TwelveDataEnrichmentProvider` classes; resolver variable declarations; three `providers.push()` calls in `getEnrichmentProvider()`
- `src/lib/db-api-keys.ts` — added `tiingo`/`intrinio`/`twelvedata` entries in `API_KEY_ENV_MAP`, `API_KEY_SERVICE_ALIASES`, `API_KEY_TIER`
- `.env.example` — added `INTRINIO_API_KEY=`, `TIINGO_API_KEY=`, `TWELVEDATA_API_KEY=` under the optional enrichment keys section
- `.env.local` — populated with real keys (git-ignored, not committed)
- `scripts/gcp-secrets-run.mjs` — new script mirroring `infisical-run.mjs`; uses `@google-cloud/secret-manager` with ADC auth; graceful fallback when `GCP_PROJECT_ID` is unset
- `package.json` — added `dev:gcp`, `build:gcp`, `start:gcp` scripts; added `@google-cloud/secret-manager: ^5.6.0` dependency
- `package-lock.json` — updated by `npm install`

## Verification

```
npx tsc --noEmit  # clean (required npm run build first to regenerate .next/types)
npm test          # 935 pass / 1 pre-existing fail (cache-provenance date-sensitive; confirmed pre-exists on clean checkout)
npm run build     # ✓ Compiled successfully
```

## Follow-ups

- Intrinio free trial expires in ~14 days; evaluate whether the data quality justifies the $150/mo plan before then.
- GCP Secret Manager integration requires the user to set `GCP_PROJECT_ID` and configure ADC (service account key or `gcloud auth application-default login`) — not yet tested end-to-end.
- The `cache-provenance` test failure is pre-existing and unrelated to this change.
