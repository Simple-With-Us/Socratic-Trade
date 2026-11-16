# Rollout: provider-neutral Data sources Settings + ROIC plan tiers / transcripts

## Context & Objective

Owner feedback: (1) Settings still elevated FMP with dedicated enable toggles after FMP was
retired; (2) paid ROIC should be first-class (key + plan tier + real transcript API); (3)
plan tiers must drive rate limits for every market-data provider we use or may use.

## Changes Made

**Settings UI**
- Replaced `FmpFeaturesCard` (four disabled FMP toggles) with provider-neutral
  `DataSourcesCard`: capability lanes (quotes, fundamentals, history, macro, news,
  transcripts, SEC, congressional) and a link to Connections for keys + plan tiers.
- TOC chip: `FMP (retired)` → `Data sources`. Anchor `#data-sources`; `#fmp-features`
  kept as nested alias for old deep-links.

**Connections / plan tiers**
- ROIC catalog copy emphasizes key + Free/Individual/Professional tier.
- ROIC tiers expanded: free / starter / individual / professional / unknown with
  matching daily quotas (300 → 50k).
- `RATE_QUOTAS.roic` free-safe default **300/day** (was incorrectly 10k).
- Plan-tier-only save for **env-backed** keys: stores non-secret `__ENV_PLAN_TIER__`
  marker so operator can set Individual without re-pasting Infisical key.

**ROIC transcripts (actually use what you pay for)**
- Fixed broken path `/v2/transcript/...` (always 404).
- v3: `/v3.0.0/earnings-calls/{NASDAQ:SYM}?fiscal_year=&fiscal_quarter=`
- v2 fallback: latest only when period matches.
- Parser accepts speaker-turn arrays and plain `content` strings.
- Quarters-per-symbol follow plan tier (`roicTranscriptQuartersForPlan`).
- Strategy coverage / information routing include ROIC when key present.

### Files
- `app/console/settings/page.tsx`
- `app/console/settings/api-keys.tsx`
- `app/api/keys/route.ts`
- `src/lib/provider-tier-plan.ts`
- `src/lib/provider-rate-limit.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/strategy.ts`
- `test/roic-transcripts.test.ts`
- `test/provider-tier-plan.test.ts`

## Decisions & Trade-offs

- Per-provider **capability toggles** (enable fundamentals for ROIC only) not shipped yet —
  Connections key+tier is the control surface; lane card is informational. Full per-provider
  opt-in matrices can follow if owner wants more granular switches.
- Policy fields `fmp*Enabled` remain hard-false in merge; UI no longer pretends they are live.

## Verification

```bash
npx vitest run test/roic-transcripts.test.ts test/provider-tier-plan.test.ts
npx tsc --noEmit
```

## Next Steps

1. On prod Connections: set ROIC plan tier to **Individual** (or Professional) for the server key.
2. Clear `webSource:roicTranscripts:lastAttemptAt` or wait TTL and confirm
   `roic_transcript_ingested` audits fire.
3. Optional later: per-provider enable matrix on Connections if cascade order needs owner overrides.
