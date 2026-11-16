# 2026-08-05 — Source × data-point capability matrix + ROIC transcript scheduler

## Context & Objective

Owner needs every data type (scan scalars, calendars, history, macro, **earnings
transcripts**, congressional, news) to have an explicit list of **all** sources
that can supply it, with strategic notes (delay, quality, quota conservation) so
agents and humans can choose sources intelligently — not a single “best vendor”
ranking.

Also root-caused empty earnings-transcript corpus: ROIC helpers existed but were
never scheduled.

## Changes Made

- New **canonical catalog**: `docs/source-capability-matrix.md`
- New **code registry**: `src/lib/source-capability-matrix.ts`
  - `sourcesFor(dataPoint)`, `listDataPoints()`, `dataPointsForSource()`,
    `isStAllowedSource()`, `describeSourcesFor()`
  - ST policy: FMP / Quiver / UW marked `stAllowed: false`
- Tests: `test/source-capability-matrix.test.ts`
- **ROIC transcript producer scheduled**: `refreshRoicTranscriptsIfDue` +
  `isRoicTranscriptRefreshDue` in `web-sources/roic-transcripts.ts`; wired in
  `scheduler.ts` (holdings → watchlist, last N fiscal quarters, run cap,
  kill-switch `ROIC_TRANSCRIPTS_DISABLED`)

## Decisions & Trade-offs

- Preference ranks are **per data point** and quota-aware (free/keyless first,
  scarce RapidAPI last, preserve ROIC for unique depth/transcripts).
- Calendar fiscal periods for ROIC are calendar approximations, not company
  fiscal calendars — acceptable for holdings-first backfill; 404s are skipped.
- FMP remains in the catalog with `stAllowed: false` for archaeology / CT notes.

## Verification State

```bash
npx vitest run test/source-capability-matrix.test.ts test/roic-transcripts.test.ts
# 2 files, 9 tests passed
```

## Next Steps & Blockers

- Continue data-sources overhaul: admin OFF grey for FMP, strip Quiver UI/keys,
  fix STOPPED non-FMP lanes, settings tier dropdowns, CT FMP latency OFF grey,
  provenance completeness pass.
- Confirm prod has ROIC key + RAG spend headroom so the new scheduler pass can
  ingest.
- EarningsCalls may still be preview-blocked on free tier — check admin
  entitlement state separately.

## Zero-Code Findings

- Yellow dots on Connections = **DEGRADED** (soft health), not source quality.
- Red STOPPED = 5 consecutive failures (hard).
- FMP still listed as STOPPED in health logs despite product retirement —
  needs intentional OFF state in UI.
