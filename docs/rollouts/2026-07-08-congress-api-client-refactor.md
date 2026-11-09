# 2026-07-08 — Centralized Congress API client factory (AG)

## Summary
Refactored the Congress Trade API interactions by replacing the standalone `congress-trade-client.ts` with a centralized factory at `src/lib/api-clients/congress.ts` to ensure consistent health logging and gating.

## Why
The application was calling the Congress Trade API via direct `fetch` calls and a dedicated module that lacked consistent health monitoring and redundant flag checking. By migrating to a unified factory (`getCongressTradeClient`), all interactions now pass through standard health logging (`CongressAPI`) and we ensure that analytics features don't inadvertently fetch when `CONGRESS_ANALYTICS_ENABLED` is false.

## Files Touched
- `src/lib/api-clients/congress.ts` (NEW)
- `src/lib/congress-trade-client.ts` (DELETED)
- `src/lib/history.ts`
- `src/lib/data-providers.ts`
- `src/lib/web-sources/congress-analytics.ts`
- `src/lib/web-sources/congress.ts`
- `test/congress-trade-client.test.ts` (DELETED)
- `test/api-clients-congress.test.ts` (NEW)

## Verification
- `npm run lint` — ran as part of CI gate
- `npx tsc --noEmit` — passes with no errors
- `npm test` — passed all 2970 tests
- `npm run build` — completed successfully

## Follow-ups
None at this time.

## 2026-07-09 — Codex review autofix (PR #1104)
Addressed two `chatgpt-codex-connector` findings on this PR:
- **Docs flag-name mismatch (P2).** The rollout/STATUS/EFFORT-LOG text named a
  non-existent `CONGRESS_TRADE_ANALYTICS_ENABLED`; the implementation
  (`congressAnalyticsEnabled()` in `src/lib/api-clients/congress.ts`) reads
  `process.env.CONGRESS_ANALYTICS_ENABLED`. Ops following the docs would have set
  the wrong var and left the analytics overlay silently disabled. Corrected all
  three docs to name `CONGRESS_ANALYTICS_ENABLED`.
- **Double-counted enrichment health failures (P2).** `CongressTradeEnrichmentProvider.enrich`
  in `src/lib/data-providers.ts` logged an extra synthetic `logApiHealth({ service:
  "congress.trade", ok: false })` per symbol on transport error, on top of the
  per-HTTP-call failure already recorded by the shared `getCongressTradeClient()`
  fetch wrapper. On a small scan where both fundamentals and analyst reads fail,
  these synthetic entries inflated the last-N health window and could trip the
  `congress.trade` enrichment circuit breaker earlier than the real upstream
  request count warrants, skipping later App A enrichment during the backoff.
  Removed the synthetic log; the `transportError` flag is retained solely to gate
  negative-caching (unchanged).

Files touched this round: `src/lib/data-providers.ts`, `STATUS.md`,
`docs/EFFORT-LOG.md`, this note.
