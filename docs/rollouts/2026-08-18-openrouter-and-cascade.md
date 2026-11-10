# 2026-08-18 — OpenRouter calls + data cascade

## Context & Objective

Owner: the data cascade is failing and OpenRouter calls are failing.  This is the live money-path follow-up to the 19:50Z triage.

## Changes Made

Live receipts (sha `12e8dcd`, #2812):

- Green/OpenRouter chat: Paper 19:33Z `gpt-5.6-terra` HTTP 400, then "Failover chain exhausted (3 endpoints)" after one stored call.  Same class all afternoon (luna 400, gemini/mistral 404 classified as account miss until #2829).
- OpenRouter embed: 32-text DeepInfra batch summing to 8193 tokens on `baai/bge-m3` (8192 window) → 400 + integrity reject 32/375.  Cursor **#2840** owns the pack-under-8192 fix.  Not taken here.
- Data cascade: `fetchNasdaqScreener` still uses stub `Mozilla/5.0` + 8s abort.  Scan has returned 0 quotes since 2026-08-13, so CascadingEnrichmentProvider never gets a universe (`enrichmentCoverage` is empty).

This branch now includes:

- Green HTTP 400 is failover-eligible; exhausted suffix counts stored calls; terra is not first pick when Flash/Medium seats remain.
- Nasdaq screener uses `BROWSER_UA` + Origin/Referer + `fetchWithRetry` + 15s/retry; Yahoo prices the allowed set if Nasdaq still returns 0.

Touched (on top of the Alpaca cache already on this PR):

- `src/lib/llm-request.ts`, `src/lib/model-rotation.ts`, `src/lib/strategy.ts`
- `src/lib/nasdaq-screener-fetch.ts`, `src/lib/market.ts`, `src/lib/yahoo-finance.ts`, `src/lib/scan-singleflight.ts`, `app/api/scan/route.ts`
- matching tests

## Decisions & Trade-offs

- Took Cursor #2831/#2830 product files because their PR-attached `verify` stayed cancelled (workflow_dispatch green does not satisfy the ruleset).  Their PRs stay open; this is the land path.
- Did not take #2840.  Embed 8192 pack is a different OpenRouter failure and Cursor has verify in flight.
- Did not rewrite their docs rows.

## Verification State

Focused vitest + `tsc --noEmit` on this commit.  Full gate via `verify` on #2834.

## Next Steps & Blockers

- Merge #2834.  Close or supersede #2831/#2830 after.
- Confirm #2840 lands for embed 400s.
- Next RTH: Paper Green should failover; Scan should return names; cascade coverage should populate.
