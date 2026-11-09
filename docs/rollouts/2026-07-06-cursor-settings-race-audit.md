# CURSOR session: Settings-table RMW race audit + providerTier per-user fix

2026-07-06 — Cursor (DeepSeek v4 Pro), main integration worktree.

## Summary

Swept every `getInternalSetting`/`setInternalSetting` pair in `src/lib/` for the
cross-user shared-row RMW pattern that checkRegimeFlip had (a single key shared across all
users, read→long-compute→write, where the write depends on the read). Found and fixed the
`providerTier` keys; classified all other shared keys as safe or intentionally shared.

## Why

The P0 checkRegimeFlip race (fixed in PR #844, squash `ebcf6a23`) was found by inspection
not by a systematic pass. The same pattern could exist on other keys. Multi-user correctness
is a stated priority.

## Classification of every settings key

### Fixed: providerTier keys (HIGH — classic RMW with data loss risk)

**`providerTier:status`** was a single shared JSON blob written by `runProviderTierCheck`.
Two concurrent tier checks (e.g. two scheduler processes both thinking they're leader)
would interleave on the 2–8 second HTTP probes and one would silently overwrite the other's
merged status, dropping provider-tier entries.

**Fix:**
- `providerTier:status` → `providerTier:status:${userId}` (via `providerTierStatusKey(userId)`)
- `providerTier:lastCheckAt` → `providerTier:lastCheckAt:${userId}` (via `lastCheckKey(userId)`)
- `getProviderTierStatus()` now takes `userId` (default `"local"`)
- `isProviderTierCheckDue()` now takes `userId` (default `"local"`)
- `runProviderTierCheckIfDue()` scopes the write to `"local"` since it uses env-level API keys
- `massiveDetectedFree()` reads `"providerTier:status:local"` first, falls back to legacy
  `"providerTier:status"` for backward compat with existing data

### Already per-user (12 keys — SAFE, confirmed correct)

- `regime:current:${userId}` — regime-watch.ts (fixed in PR #844)
- `reflection_signature:${userId}` — post-mortem.ts
- `last_macro_sent:${userId}` — strategy.ts
- `usage:alert_cooldown:${userId}:*` — usage-limit-alerts.ts
- `mcp:oauth:state:${userId}:*`, `mcp:oauth:token:${userId}` — mcp-oauth.ts
- `congress_score:${userId}` — congress-score-gate.ts
- `auto_tune:last_cadence:${userId}` — auto-tune-scheduler.ts
- `risk:hwm:${userId}:*`, `risk:sod:${userId}:*` — risk-breaker.ts
- `recoverable_issue:${userId}:*` — recoverable-issue.ts
- `stale_limit_order:${userId}:*` — stale-limit-orders.ts
- `health_alert_cooldown:*:user:${userId}` — db-health.ts (user lanes)
- `rag_connection_alert:*:${source}:${targetUserId}` — vector-db.ts

### Single-writer (1 key — SAFE)

- `scheduler:lastTick` — Only the scheduler process writes; ops-snapshot only reads.

### Intentionally shared (3 keys — SAFE by design)

- `health_alert_cooldown:*:env` / `:*:none` — db-health.ts explicitly documents why these
  are NOT per-user: "In a multi-user outage each tenant's failure hits the SAME global
  dependency, so a userId-scoped cooldown key would let every tenant mint its own cooldown
  row and re-alert the admin every 6h for the one shared outage."
- `storage_alert_cooldown:*` — Single physical disk resource; one alert is sufficient.
- `congress-share:lastDailyRunDate` — Intentionally shared; the daily push collects ALL
  users' symbols and pushes one batch. Single-leader scheduler guards against concurrent
  ticks. The push is idempotent.

### Legacy (1 key — already handled)

- `regime:current` (LEGACY_REGIME_KEY) — Read-only now; only used for one-time migration
  to per-user keys. Fixed in PR #844.

### Benign RMW — cached datasets (11 keys — shared but idempotent)

These are web-scraped dataset caches (`webSource:*:dataset`, `webSource:*:lastAttempt`,
`webSource:sec:cikMap`, `webSource:sec:tickerCikMap`, `webSource:technical:watchlist`).
The RMW pattern (read→scrape→write) exists but:
- The scraped data is the same regardless of which user triggered the scrape
- The operation is idempotent (re-scraping produces the same data)
- The worst case is an unnecessary duplicate scrape, not data corruption
- Single-leader scheduler further mitigates concurrent access

Also: `vectorStore:lastIngest` — ingest is idempotent by SEC accession number.

## Files changed

- `src/lib/provider-tier.ts` — per-user scoped keys, functions instead of constants;
  `getProviderTierStatus()` reads a local-only legacy fallback (see review follow-up below)
- `src/lib/market-signals/massive.ts` — legacy fallback read in `massiveDetectedFree`
- `test/provider-tier.test.ts` — updated test key strings

## Verification

Verified green via the PR #997 `verify` CI check (runs tsc → test → build):

```bash
npx tsc --noEmit     # clean
npm run lint         # clean
npm test             # pass (provider-tier: 17/17)
npm run build        # clean
```

## Review follow-up (Copilot, PR #997)

`getProviderTierStatus()` originally read only the new per-user key
(`providerTier:status:local`), which is empty right after deploy until the next scheduled tier
check (up to 24h) re-populates it. That would make `/api/health` (and any other reader) regress
to `{}` even when a degraded/free tier was previously detected on the legacy shared key. Fixed by
having `getProviderTierStatus()` fall back to the legacy `providerTier:status` key **only for the
`"local"` scope** (the scope the old shared blob mapped to), so existing persisted status keeps
surfacing immediately after deploy. Mirrors the fallback already present in `massiveDetectedFree`.

## Follow-ups

- None. All shared keys classified. Only the providerTier RMW needed fixing.
- The ~45 CURSOR itemized rows from the "2026-07-05 full itemization" section are not
  individually listed in `docs/EFFORT-LOG.md` — they exist only as an aggregate
  "(CURSOR ~45, mechanical fixes, ops verifications, observability)". Individual
  enumeration is a separate task.
