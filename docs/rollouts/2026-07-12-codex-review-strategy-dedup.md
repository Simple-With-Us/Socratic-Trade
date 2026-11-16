# Codex Review: strategy dedup enrichment wiring fixes

## Summary

Two rounds of Codex autofix on PR #1482 (`agent/ag-dedup-types`):

### Round 1 (commit 52d4d75e)
Addressed two P2 Codex review findings:

1. **Evidence age anomaly dedup ordering** (`src/lib/strategy.ts`): The LRU dedup cache was running AFTER `collectEvidenceAgeAnomalies`'s 12-item cap, so stale cached items could fill all 12 slots and suppress fresh anomalies. Moved the dedup to filter `evidenceAgeInputs` BEFORE the cap, so already-audited items never consume receipt slots and fresh items beyond the stale 12 still reach the audit.

2. **Missing enrichment path for new quote metrics** (`src/lib/data-providers.ts`, `src/lib/market.ts`, `src/lib/types.ts`): The PR added 10 new optional fields to `MarketQuote`/`MarketQuoteSummary` (`returnOnEquity`, `returnOnAssets`, `revenueGrowth`, `freeCashFlowYield`, `grossProfitMargin`, `congressTradesQuiver`, `insiderTradesQuiver`, `govContractsQuiver`, `lobbyingQuiver`, `patentsQuiver`) but did not wire them through the per-field enrichment cascade. Added:
   - Field declarations to `SymbolEnrichment` interface
   - Literal entries to `EnrichmentSourcedField` union
   - `takeScalar(...)` calls in `CascadingEnrichmentProvider.enrich`
   - Entries in `EMPTY_SOURCED` marker map
   - `??` overrides in `applyEnrichment`
   - Mappings in `quotesBySymbol`
   - Field names in `EnrichmentSources` type

### Round 2 (this commit)
Addressed four P2 Codex review findings from the second review pass:

3. **Mark only emitted age anomalies as deduped** (`src/lib/strategy.ts:1016`): When more than 12 inputs pass the cache filter, `collectEvidenceAgeAnomalies` caps at 12 items but the old code cached ALL passing items. Items 13+ were suppressed on the next run too. Fixed by moving the cache write AFTER the cap — only actually-emitted anomalies are cached.

4. **Keep prompt receipts independent of audit dedup** (`src/lib/strategy.ts:1010`): The dedup cache was filtering inputs before `collectEvidenceAgeAnomalies`, so recently-audited items were excluded from the per-decision safety receipt too. Fixed by collecting ALL anomalies first for the prompt receipt, then applying the cache filter only for the audit emission.

5. **Map freeCashFlowYield into the existing FCF field** (`src/lib/market.ts:898`): The new `freeCashFlowYield` field was wired to `MarketQuote` but downstream consumers (`qualityScore`, bear veto, strategy prompt, dashboard) all read `fcfYield`. Fixed by cascading `freeCashFlowYield` into `fcfYield` in both `applyEnrichment` and `quotesBySymbol`.

6. Resolved enrichment wiring thread (handled in round 1).

## Why

Codex autofix pass: all findings are P2 correctness issues that would cause silent data loss or misattribution (missed anomaly audits, prompt receipts suppressed by cache, downstream FCF consumers blind to the new field).

## Files

- `src/lib/strategy.ts` — dedup cache scoped to emitted anomalies; prompt receipt uses all inputs
- `src/lib/market.ts` — `freeCashFlowYield` cascades into `fcfYield` in `applyEnrichment` and `quotesBySymbol`
- `STATUS.md` — updated
- `docs/rollouts/2026-07-12-codex-review-strategy-dedup.md` — this note

## Verification

```bash
npm run lint       # 0 errors (427 warnings — grandfathered)
npx tsc --noEmit   # pre-existing only (process reference errors in unrelated files)
npm test           # 349 files, 3896 tests passed
npm run build      # clean production build
```

## Follow-ups

- Ensure auto-merge is enabled on PR #1482.
- Resolve Codex review threads that were addressed.
