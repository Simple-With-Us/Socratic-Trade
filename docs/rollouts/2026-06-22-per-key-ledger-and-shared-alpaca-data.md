# 2026-06-22 - per-key-ledger-and-shared-alpaca-data

## Summary

Two owner-directed refinements on top of the multi-user key model (PR #65):

1. **Per-attached-key LLM usage ledger.** The `llm_usage` ledger now records a non-secret
   `key_ref` — `keyFingerprint(key)` = `sha256(key)` truncated — so usage/cost is measured **per
   distinct attached key** (user-provided or operator), not just per `keySource`. `resolveLlmCredential`
   returns `keyRef`; it's threaded through every LLM call site (chat + strategy/red-team/post-mortem/
   tuning/revalidation) and surfaced in `getLlmUsageSummary` (now grouped by `userId, provider,
   keySource, key_ref`) at `GET /api/admin/llm-usage`. The secret is never stored — only its fingerprint.

2. **Alpaca paper key as the SHARED market-data source.** New `resolveAlpacaMarketData(userId)`:
   a user with their own Alpaca key gets their **individual** data (source `user`, private/pooled);
   otherwise the operator's paper key (`local` store → env) serves as the **shared** market-data
   source (source `env` → shared cache) — for background refreshes (no userId) and tenants without
   their own key. The Alpaca enrichment providers (snapshot + news) now use this, so the real-time
   Alpaca tier seats for everyone again (it had degraded to delayed/public providers for no-userId
   scans when the Alpaca key went per-user-only in PR #65).

   **Trading is unaffected and stays per-user:** `alpaca.ts` resolves Alpaca strictly via
   `resolveApiKey` (per-user-only tier), so no tenant ever TRADES on the operator's account. This
   helper exposes the operator's key only to read-only market-data endpoints. Alpaca market data is
   identical for paper and live accounts (it depends on the data subscription, not the account type),
   so the operator's paper key is a sound shared source.

## Why

Owner direction:
- "want LLM usage ledger regardless if it is user provided key or not, should measure amount of
  usage per key attached ideally" → the per-`key_ref` ledger.
- "use my paper api key for the background scans … only use that for the global data unless in my
  account and using the paper account which would use the individual data" → `resolveAlpacaMarketData`
  (own key → individual; operator key → shared/background). This also answers the "no-userId
  background scan" question: those are the timed shared-data refreshes (computed technicals,
  web-sources), which have no single user.

Robinhood-as-global-data was considered and declined: RH MCP data has no edge over the existing
providers, its rate limits are undocumented + account-scoped, and routing all users through one
personal brokerage token is fragile/ToS-questionable. RH stays per-user (its data can join the
consent pool for users who connect it).

## Files

- `src/lib/db-api-keys.ts` — `keyFingerprint`; `resolveLlmCredential` returns `keyRef`; new `resolveAlpacaMarketData`.
- `src/lib/llm-usage.ts` — `LlmUsageEntry.keyRef`, `LlmUsageRow.keyRef`, insert + group-by `key_ref`; re-exports `keyFingerprint`.
- `src/lib/db.ts` — `llm_usage.key_ref` column (CREATE + `ALTER TABLE` migration for DBs from PR #65) + index.
- LLM call sites pass `keyRef`: `strategy.ts`, `red-team.ts`, `post-mortem.ts`, `strategy-tuning.ts`, `proposal-revalidation.ts`, `chat/llm.ts` (+`LlmUsageOpts.keyRef`), `app/api/chat/route.ts`.
- `src/lib/data-providers.ts` — `getEnrichmentProvider` uses `resolveAlpacaMarketData` for the Alpaca snapshot/news providers.
- `test/key-resolution-tiering.test.ts` (+per-key + Alpaca-data tests), `test/data-providers.test.ts` (cascade tests back to the no-userId shared path).

## Verification

In `~/apps/trading-keys2` (branch `feat/alpaca-shared-data-per-key-ledger`, base `origin/main` @ PR #65):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — **766 passed** across 84 files (+3).
- `npm run build` — clean (exit 0).

## Follow-ups

- The `llm_usage` ledger has no key→label map (only the fingerprint). A future UI could map a
  fingerprint to a friendly label (e.g. last-4 of the key) when the key is still in the store.
- Per-user Alpaca fill/news *streams* remain operator-`local` background workers (unchanged).

## Blockers

- None.
