# Runbook — Page on `/api/health` JSON flags, not HTTP 200

## Why

`GET /api/health` returns **HTTP 200** whenever the process can serve and the
**critical** dependencies are not hard-stopped.  That is the Coolify / deploy
liveness probe.  A 503 here restarts the container, which re-halts autonomy and
cannot heal a stale scheduler, a silent trading loop, or a wedged Litestream
tier.

A warm process answers this URL from a memory snapshot (default 2 seconds,
`HEALTH_SNAPSHOT_TTL_MS`) and refreshes SQLite, Litestream, and OpenRouter
credits after the response.  Critical hard-stops still update `ok` on that
refresh, so a 503 can lag by about one refresh.  `/api/live` does not open
`app.db`.  Docker and the entrypoint watchdog stay on `/api/live`.  A single
main-thread native call longer than the probe timeout can still delay the
handler from starting; the snapshot stops the probe from adding its own wait.

UptimeRobot (or equivalent) plus Pushover must therefore treat HTTP 200 as
**up**, and page on these JSON fields instead:

| Field | Path | Alert when |
| --- | --- | --- |
| `schedulerStale` | `$.checks.schedulerStale` | `true` |
| `tradingLiveness.degraded` | `$.checks.tradingLiveness.degraded` | number `> 0` |
| `litestreamTiersDegraded` | `$.checks.storage.litestreamTiersDegraded` | `true` |

Companion keyword (always emitted, unique substring):
`$.checks.tradingLivenessDegraded` is `true` exactly when
`tradingLiveness.degraded > 0`.

These three flags **never** flip the HTTP status to 503.

## What still 503s (HTTP monitor)

Keep one **HTTP(s)** monitor on `https://socratictrade.com/api/health` that
alerts on non-200.  That is the process-down / Coolify-unhealthy signal.

Critical hard-stops that **do** 503 (leave them):

- `pinecone`
- `alpaca-broker` (env lane alone does **not** 503 when a Connections user key
  for the same service is healthy)

Do **not** add a 503 for `schedulerStale`, `tradingLiveness.degraded`, or
`litestreamTiersDegraded`.  Do **not** rewrite rag-embed degrade in this
runbook — a separate PR may own that.

## Keyword monitors (UptimeRobot, treat 4xx/5xx as up)

Create **three** Keyword monitors on the same URL
`https://socratictrade.com/api/health`.  Interval 5 minutes.  Alert contact:
Pushover (preferred) or the existing UptimeRobot → Pushover integration.

For each monitor:

1. Type: **Keyword**
2. Alert when keyword **exists**
3. **Allowed HTTP status codes: include 4xx and 5xx as success** so a deploy
   503 cannot pair with these pages (same lesson as the OpenRouter credits
   keyword monitor, id `803542990`).
4. Keywords (compact JSON; `ok` / the flag is the first serialized key of that
   object where noted):

| Monitor name | Keyword substring |
| --- | --- |
| ST scheduler stale | `"schedulerStale":true` |
| ST trading liveness degraded | `"tradingLivenessDegraded":true` |
| ST Litestream tiers degraded | `"litestreamTiersDegraded":true` |

JSON-path monitors (if the plan supports them) can use the table at the top
instead of the keyword.  Either way, **do not** point the site-down HTTP
monitor at these flags.

Existing HTTP monitor `socratictrade.com` (id `803542994`) stays an HTTP-200
liveness check.  Do not convert it into a keyword monitor.

## Field accuracy

- `schedulerStale` is always a boolean.  `true` when `scheduler:lastTick` is
  older than 5 minutes, or when there is no tick after the process has been up
  longer than 5 minutes.  `lastTick` is stamped when a leader tick *finishes*
  (not when it starts), so a hung await goes stale.  An in-process watchdog
  (15s poll, 2-minute budget in `src/lib/scheduler.ts`) clears a wedged
  `__tickInFlight` bit so the next interval can run without a container restart.
  A fully blocked event loop still cannot run that watchdog:  keep the HTTP
  timeout monitor and this JSON flag.
- `tradingLiveness` is always present.  `degraded` is a **count** of
  active-autonomy accounts that are stale (market open) or over the consecutive
  failure cap.  Halted accounts do not count.  `degraded: 0` is healthy.
  `maxConsecutiveFailedRuns` is the worst post-re-arm streak: after the owner
  sets the account active again, only runs whose `started_at` is after that
  re-arm count.  A run that was already in flight does not keep the public
  streak at the old halt-time number.  `stale_last_completed_run` is unchanged.
- `storage.litestreamTiersDegraded` is always a boolean.  `true` when a
  compaction level is wedged or empty-wedged (see `assessLitestreamTierFreshness`).

## OPS_DIAGNOSTIC_TOKEN

`GET /api/ops/snapshot` and the operator projection on `/api/health` accept
**only** `OPS_DIAGNOSTIC_TOKEN` (`x-ops-token`, `x-admin-token` header name, or
`Authorization: Bearer`).  `ADMIN_REINDEX_TOKEN` is a different admin gate and
is **not** a fallback.

Production must have `OPS_DIAGNOSTIC_TOKEN` set in Infisical and the same value
in Cursor Cloud Secrets.  Do not mint or rotate a second token unless the two
envs already hold the **same** value (then keep using that one value under the
`OPS_DIAGNOSTIC_TOKEN` name).

Probe (never print the token):

```bash
bash scripts/fetch-prod-ops-snapshot.sh
```

## R2 weekly retain

Weekly retain is **already verified at 1**.  Code default is
`R2_COLD_SNAPSHOT_DEFAULT_RETAIN = 1` and `R2_COLD_SNAPSHOT_RETAIN` is unset.
The historic bucket's `cold-snapshots/` prefix has exactly one object
(`app-2026-08-16.db`).  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused leftover
(empty `weekly/` prefix) and does not drive weekly retain.  Do not delete
live R2 objects.  `R2_COLD_SNAPSHOT_RETAIN` values above 1 stay ignored.

## Owner dashboard steps (UptimeRobot)

1. Confirm the HTTP monitor still targets `/api/health` and alerts on non-200
   only.
2. Add the three keyword monitors above.  Alert contact = Pushover.
3. On each keyword monitor, allow 4xx/5xx so deploys do not page.
4. Do not add a keyword for `"ok":false` on this URL — that is the HTTP
   monitor's job and it already 503s for pinecone / alpaca-broker.

## Related

- OpenRouter credits keyword: `"openrouterCredits":{"ok":false` — already live;
  also allow 4xx/5xx.
- `docs/rollouts/2026-07-18-openrouter-credit-health-signal.md`
- `docs/rollouts/2026-08-13-fleet-alert-triage.md`
