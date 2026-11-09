# 2026-06-21 Cache Provenance — User-Keyed Data Scoping

## Summary

Extended the `history.ts` shared/private cache-provenance pattern to the three
remaining process-global provider caches that were previously missing it:

- **`src/lib/macro.ts`** — the primary macro-data cache (24h TTL, FRED key).
  This was the highest-priority bug: the first caller's user-stored FRED key
  would silently populate the single global cache and be served to ALL users
  for 24h, effectively redistributing a user's licensed FRED data to everyone.
- **`src/lib/macro-history.ts`** — the sparkline history cache (12h TTL, same
  FRED key).  Same cross-user leak risk as macro.ts.
- **`src/lib/market.ts`** — the Nasdaq screener cache.  This is a public,
  unauthenticated endpoint; no change to logic was needed, but a comment was
  added confirming the single shared cache is intentional and safe.
- **`src/lib/data-providers.ts`** — already had the full provenance pattern
  implemented (CacheScope, cacheScopeForKeySource, readEnrichmentCache,
  writeEnrichmentCache); no code change required.

## Why

A user who stores their own FRED API key in the per-user API key store was
inadvertently subsidising all other users with their private, licensed data.
The shared-or-private decision must be made at cache-write time based on
`resolveApiKeyWithSource`, not assumed to be "always share".

## Design

Mirrors `history.ts` exactly:

1. Call `resolveApiKeyWithSource("fred", userId)` to get `{ source }`.
2. `source === "env"` → data came from an operator/env key → write to a **shared**
   cache entry (all users may read it).
3. `source === "user"` → data came from the calling user's own stored key → write
   to a **private** per-user entry, keyed `user:<userId>`.  A second opt-in env
   flag (`MARKET_DATA_SHARE_USER_KEYED_MACRO` / `MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY`,
   default OFF) allows the owner to promote user-keyed results to shared (same
   convention as `MARKET_DATA_SHARE_USER_KEYED_HISTORY` in history.ts).
4. `source === "none"` (no key) → returns `DEFAULT_MACRO` with `asOf="unavailable"`;
   this carries no licensed data and is written to the shared cache.
5. **Safe default**: unknown/ambiguous provenance is always treated as private.

The per-provider **sharing allowlist** is intentionally narrow:
- Only `source === "env"` (operator-stored keys) is auto-shared.
- User-keyed providers are NEVER auto-shared; they require the explicit opt-in flag.
- The owner can extend the allowlist by setting the opt-in flags; do NOT add
  user-keyed providers to the auto-share default.

## Files Touched

- `src/lib/macro.ts` — replaced single `cache` object with `sharedMacroCache` +
  `privateMacroCache` Map; added `macroCacheScopeForKeySource`, `shareUserKeyedMacro`,
  `readMacroCache`, `writeMacroCache`, `clearMacroCacheForTests`; updated import from
  `resolveApiKey` → `resolveApiKeyWithSource`.
- `src/lib/macro-history.ts` — same pattern: `sharedMacroHistoryCache` +
  `privateMacroHistoryCache` Map; parallel helper functions; `clearMacroHistoryCacheForTests`.
- `src/lib/market.ts` — added clarifying comment on the Nasdaq screener cache
  (no logic change).
- `test/cache-provenance.test.ts` — new test file: 7 tests covering both macro
  and macro-history for (1) env-key → shared + reused across userIds,
  (2) user-key → private + not leaked to another userId,
  (3) opt-in flag → promotes user-keyed to shared.

## Verification

```
cd /Users/jay/apps/wt-cache
npx tsc --noEmit          # clean — 0 errors
npm test                  # 70 test files, 564 tests — all pass
```

Full test run timing: ~2.2s wall-clock. No regressions.

## Follow-ups / Owner Note

**The per-provider sharing allowlist is owner-extensible and currently defaults
to env/free sources only.**  If the deployment scenario changes (e.g., a single
operator FRED key should be treated as user-level rather than shared), the owner
can set `MARKET_DATA_SHARE_USER_KEYED_MACRO=true` to opt in.  Do NOT widen the
default — maintaining safe-by-default is the invariant this change exists to
establish.

The data-pool consent tier (pool scope) is NOT applied to macro/history because
FRED macro data is not symbol-specific market data; extending the three-tier
(private/pool/shared) model there is deferred and noted as a future option.
