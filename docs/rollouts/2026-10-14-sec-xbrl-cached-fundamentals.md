# 2026-10-14 — SEC XBRL fundamentals from cached companyfacts (default ON)

## Context & Objective

Fill missing fundamentals (ROE, ROA, gross profit margin, shares outstanding, implied market cap) from the SEC companyfacts JSON we already fetch, without blocking market scans on EDGAR.  Align docs and `source-settings-catalog.ts` on default **ON** and retire the per-scan 8s SEC fetch budget in favor of a nightly SQLite cache sweep.

## Changes Made

- `src/lib/web-sources/sec-facts.ts` — cache full companyfacts JSON under `sec_facts` (`__companyfacts_json__`); `readCompanyFactsCache` / `upsertCompanyFactsCache`; ingest stores cache before structured rows.
- `src/lib/web-sources/sec-companyfacts-sweep.ts` — nightly scheduler sweep with cursor + UTC day watermark (`SEC_COMPANYFACTS_SWEEP_PER_TICK`, default 25).
- `src/lib/data-providers.ts` — `parseCompanyFacts` extended; `SecXbrlEnrichmentProvider` reads cache only; cascade derives `marketCap` from SEC shares × live price.
- `src/lib/scheduler.ts` — `runSecCompanyFactsSweepIfDue` on scheduler tick.
- `src/lib/market.ts`, `src/lib/enrichment-coverage.ts`, `src/lib/source-capability-matrix.ts`, `src/lib/source-settings-catalog.ts` — coverage + matrix + catalog copy.
- `docs/market-data-provider-pricing.md`, `docs/source-capability-matrix.md` — operator docs.
- Tests: `test/sec-xbrl.test.ts`, `test/sec-facts.test.ts`, `test/sec-companyfacts-sweep.test.ts`, `test/data-providers.test.ts`, `test/enrichment-coverage.test.ts`.

## Decisions & Trade-offs

- **marketCap** is computed in the cascade merge (not in `parseCompanyFacts`) because SEC enrichment runs parallel with quote providers; price may arrive from Yahoo in the same wave.
- **Cache row** stores JSON in `sec_facts.segment` (large payloads); structured concept rows unchanged for RAG/evidence cards.
- **Sweep** uses demand-first symbol ordering and 300ms inter-symbol delay; failure backoff 1h per batch error.  A throwing symbol advances the cursor past itself so one bad CIK cannot stall the rest of the universe.  That symbol is retried on the next full sweep after the cursor wraps.
- **Screener market cap wins** over the SEC shares × price fallback.  The cascade cannot see the Nasdaq cap, so `applyEnrichment` refuses a `sec-xbrl` marketCap when the quote already has a positive cap.
- **Evidence cards** exclude the `__companyfacts_json__` cache sentinel so it does not occupy a prompt slot.
- **Companyfacts JSON** is parsed with `CompanyFactsSchema` (passthrough, not strict).  Live filings include `cik`, `entityName`, and taxonomies other than `us-gaap` / `ifrs-full`.  A strict object would reject them.

## Verification State

```
npm run lint       # exit 0.  Warnings only; the grandfathered backlog is unchanged.
npx tsc --noEmit   # exit 0
npx vitest run test/market.test.ts test/data-providers.test.ts test/sec-companyfacts-sweep.test.ts test/sec-facts.test.ts test/sec-xbrl.test.ts
# Those files passed.  The new cases cover screener-cap precedence, sweep cursor advance, the cache sentinel, and a dei taxonomy beside us-gaap.
```

Full `npm test` was started.  One failure seen while it was still running is `test/egress-guard.test.ts` resolving discord.com, which this sandbox cannot reach.  That test is outside this diff.  `npm run build` was not re-run here; `verify` runs it.

## Next Steps & Blockers

- None for merge; production picks up sweep on next deploy after merge to `main`.

## Zero-Code Findings

- Historical rollout `docs/rollouts/2026-06-25-sec-xbrl-enrichment.md` still describes default-OFF and 8s scan budget; superseded by this note for operator behavior.
