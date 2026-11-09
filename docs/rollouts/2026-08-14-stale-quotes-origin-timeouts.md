# 2026-08-14 — Stale ~1200s quotes + origin timeouts (Alpaca socket death)

## Context & Objective

Owner asked to investigate and fix all recent app errors from the past 1-2 days,
including stale quotes around 1200s old.  Production was paging UptimeRobot
every ~15-20 minutes and Autopilot was converting openings off a Yahoo delayed
tape.

## Changes Made

Alpaca keep-alive sockets from Hetzner to `api.alpaca.markets` were being closed
server-side (`UND_ERR_SOCKET` / "other side closed").  One `fetch failed` then:

1. skipped the live quote path, so the cascade fell through to Yahoo
   `regularMarketTime` (~15-20 minutes = ~900-1200s);
2. auto-halted Autopilot on a single connectivity blip;
3. stacked with an 8s OpenRouter credits fetch on `/api/health`, which is the
   same URL the "OpenRouter credits low" keyword monitor hits — so every origin
   stall also opened a false credits incident.

Fixes:

- Retry one dead-socket transport in `fetchWithRetry` and in the Alpaca SDK
  `trackHealth` wrapper.  Caller AbortSignals are not retried.
- Require **3 consecutive** transient connectivity failures before auto-halt.
  A real OMS / order-path outage still halts immediately.
- Treat AbortController / budget timeouts as **soft** health so nasdaq-calendar
  aborted by GET `/api/quote`'s 6s cascade cannot mint
  `SOCRATIC-TRADE-25`.
- Bound the public health credits check to 1.5s and serve the last good
  balance if the refresh is aborted.
- Dedup "Pinecone write unit budget reached" Sentry to once per 6h (270 events
  in 24h).
- Stale-quote **notifications** only fire during the regular session.  After
  the close the last print is supposed to be minutes old; we still audit and
  convert to a limit.

### Files

- `src/lib/network-errors.ts` (new)
- `src/lib/data-providers.ts`
- `src/lib/alpaca.ts`
- `src/lib/broker-health.ts`
- `src/lib/db-health.ts`
- `src/lib/openrouter-credits.ts`
- `src/lib/vector-db.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-execution.ts`
- `app/api/health/route.ts`
- `test/transient-network-resilience.test.ts` (new)
- `test/openrouter-credits.test.ts`
- `test/health-alert-noise-gate.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`

## Decisions & Trade-offs

- Did **not** mint or rotate the filingapi key (401 since early August).  Owner
  supplies keys via `~/.secrets/`.  Tracked as residual.
- Did **not** repair the Litestream L2/L3 empty wedge.  That is an owner
  deploy-strategy + one-time B2 delete; #2709 already made it visible.
- Did **not** change `busy_timeout = 60000`.  WAL readers should proceed during
  writers; the origin stalls lined up with Alpaca socket death + health's 8s
  credits fetch more tightly than with a 60s SQLite wait.
- Congress.trade latency probes (13h, other app) are out of scope.

## Verification State

```bash
npx vitest run test/transient-network-resilience.test.ts \
  test/openrouter-credits.test.ts test/broker-health-auto-pause.test.ts \
  test/health-alert-noise-gate.test.ts
# 4 files / 30 passed

npx vitest run test/account-mutation-pr2-strategy-loop.test.ts
# 1/1 passed in 17s isolated; full-suite run previously timed out at 30s
# so the case timeout is now 60s (two full runStrategyOnce passes).
```

Full `lint` / `tsc` / `npm test` / `npm run build` run via `scripts/land.sh`.

## Next Steps & Blockers

- Owner: check the `filingapi` env key (401).  Do not mint a new key.
- Owner: Litestream L2 fencing / B2 delete (already documented on #2709).
- After this lands: resolve Sentry SOCRATIC-TRADE-25 (nasdaq-calendar abort)
  and drop the WU-budget issue frequency on SOCRATIC-TRADE-1T.
- Pinecone "dispatch lease was lost" during multi-query is residual — it
  tracks long ticks / lease TTL, not a missing retry.

## Zero-Code Findings

- 1200s is Yahoo `regularMarketTime` (~15-20 min delayed, or ~20 min after
  the 16:00 ET close).  It is the cascade **fallback**, not a 20-minute cache.
- UptimeRobot 803542990 (`OpenRouter credits low`) is a keyword monitor on
  `https://socratictrade.com/api/health`.  Every origin timeout still pairs
  with that incident even after the 2026-08-13 4xx/5xx-as-success tweak,
  because a Connection Timeout is not an HTTP status.
- Coolify app uuid is `<ST_COOLIFY_APP_UUID>` (name `socratic-app`).
- Live sha at investigation: `f218f7e3`, process started 2026-08-14T09:15:15Z.
