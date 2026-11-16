# 2026-08-05 — Soft expected-limit health + Nasdaq UA fix (STOPPED sources)

## Context & Objective

Admin connections health showed many non-FMP / non-Quiver lanes as red **STOPPED** (5 consecutive failures): alpha-vantage, nasdaq-*, RapidAPI products, vix-yahoo, usage-monitor, etc. Goal: restore functional behavior and stop free-tier rate limits / daily caps from painting lanes as permanently broken.

## Changes Made

1. **Soft expected-limit health rows** (`db-health.ts`)
   - `logApiHealth({ soft: true })` stamps `[expected-limit] ` on `error_text`.
   - `isSoftHealthFailure()` also matches free-text 429 / rate-limit / daily-cap shapes (incl. legacy rows).
   - Hard consecutive-failure STOPPED requires last 5 rows to all be **non-soft** failures.
   - Soft-only history may still show yellow DEGRADED (`no-success-this-hour` / `no-success-ever`).
   - Pure soft failures do not auto-page; AV daily-cap still pages once via `quotaResetAt`.

2. **Transport circuit breaker** (`api-circuit-breaker.ts`)
   - Trips only on `HEALTH_REASON_CONSECUTIVE_FAILURES` (hard), matching enrichment `applyCircuitBreaker`. Soft yellow alone no longer blacks out secondary sources.

3. **`fetchWithRetry`**
   - Intermediate 429 retries no longer write health rows.
   - Final 429 always soft; optional `softHealthStatuses` (RapidAPI 403 = unsubscribed/not entitled).

4. **Nasdaq UA fix** (real bug)
   - Live-verified: bot UA `compatible; SocraticTrade/1.0` hangs/times out on `api.nasdaq.com`; Chrome `BROWSER_UA` returns 200 for quote + calendar.
   - `nasdaq-quote` + `nasdaq-calendar` now use `BROWSER_UA`.

5. **Alpha Vantage**
   - Pool/budget exhaustion and daily-cap body errors log as soft (+ `quotaResetAt` for the known reset).
   - Already skips network when pool/budget exhausted; soft log prevents red STOPPED forever until reset.

6. **VIX / usage-monitor / RapidAPI**
   - VIX final 429 soft; intermediate 429s silent.
   - usage-monitor 429/503/timeout soft.
   - RapidAPI helpers soft-mark 403.

### Files

- `src/lib/db-health.ts`
- `src/lib/api-circuit-breaker.ts`
- `src/lib/data-providers.ts`
- `src/lib/nasdaq-calendar-provider.ts`
- `src/lib/macro.ts`
- `src/lib/usage-monitor-push.ts`
- `test/soft-health-failures.test.ts` (new)
- `test/macro-live-vix.test.ts`
- `docs/EFFORT-LOG.md` + live board

## Decisions & Trade-offs

- Soft failures remain `ok=0` (honest forensics) rather than fake successes.
- No schema migration: soft marker lives in `error_text` prefix.
- Soft yellow can still show DEGRADED; only red STOPPED / hard circuit need 5 hard fails.
- Seeking Alpha hub may still be delisted (403 soft) — not re-enabled as primary; FMP/Quiver untouched.

## Verification State

```bash
npx vitest run test/soft-health-failures.test.ts test/api-circuit-breaker.test.ts \
  test/alpha-vantage-quota-alert-cooldown.test.ts test/nasdaq-calendar-provider.test.ts \
  test/health-lane-cap.test.ts test/macro-live-vix.test.ts \
  test/connection-health-routing.test.ts test/data-sources-breadth.test.ts \
  test/rapidapi-providers.test.ts test/usage-monitor-push.test.ts
```

Focused suite green after VIX breaker test update (hard consecutive only).

Live probe (dev machine, 2026-08-05):

- Nasdaq quote/calendar with bot UA → hang/timeout
- Same with Chrome UA → HTTP 200

## Next Steps & Blockers

- **Prod** still needs a deploy of this branch for UA + soft semantics to clear live STOPPED rows (existing hard rows age out; soft classifier also treats free-text `HTTP 429` in old rows).
- **usage-monitor**: if still red after soft classification, check `USAGE_MONITOR_BASE_URL` / token / receiver health (auth failures stay hard).
- **RapidAPI products**: 401 = bad key (hard); 403 soft-degraded if unsubscribed; quotas via `rapidapi-quota.ts`.
- Other agents: FMP/Quiver OFF UI, settings tiers, provenance matrix — do not re-enable FMP/Quiver.

## Zero-Code Findings

- Nasdaq public API filters non-browser User-Agents (confirmed).
- Alpha Vantage 25/day and Yahoo 429 are expected limits, not integration death.
- Cboe-first VIX cascade already preferred; Yahoo secondary must not hard-STOP the board.
