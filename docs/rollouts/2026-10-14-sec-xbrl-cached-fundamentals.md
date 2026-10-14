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
- **Sweep** uses demand-first symbol ordering and 300ms inter-symbol delay; failure backoff 1h per batch error.

## Verification State

```
npm run lint
npx tsc --noEmit
npm test
npm run build
```

(Paste results at commit time.)

## Next Steps & Blockers

- None for merge; production picks up sweep on next deploy after merge to `main`.

## Zero-Code Findings

- Historical rollout `docs/rollouts/2026-06-25-sec-xbrl-enrichment.md` still describes default-OFF and 8s scan budget; superseded by this note for operator behavior.
