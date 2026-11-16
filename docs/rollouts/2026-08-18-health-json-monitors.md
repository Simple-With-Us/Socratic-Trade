# 2026-08-18 — Health JSON monitors, OPS token, R2 retain=1

## Context & Objective

UptimeRobot was paging on HTTP 200/503 of `/api/health`.  Scheduler silence,
silent trading-loop failure, and Litestream tier wedges must page on JSON
flags instead, without 503ing the Coolify liveness probe.  Also lock
`OPS_DIAGNOSTIC_TOKEN` as the only ops secret and keep weekly R2 on the free
tier (retain 1).

## Changes Made

- `/api/health` always emits `checks.schedulerStale` (boolean),
  `checks.tradingLiveness.degraded` (count) plus `tradingLivenessDegraded`
  (boolean), and `checks.storage.litestreamTiersDegraded` (boolean).  Those
  flags never flip HTTP status.  pinecone / alpaca-broker stay critical.
  rag-embed degrade was not rewritten.
- `opsDiagnosticSecrets()` accepts only `OPS_DIAGNOSTIC_TOKEN`.
  `ADMIN_REINDEX_TOKEN` is not a fallback.  Fetch script matches.
  This environment already has a working prod OPS token (64-char, snapshot
  HTTP 200).  Did not mint or rotate a second token.
- Weekly R2 retain is already **verified at 1**: code default
  `R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`, `R2_COLD_SNAPSHOT_RETAIN` unset, and
  `cold-snapshots/` has exactly one object (`app-2026-08-16.db`).
  `R2_COLD_SNAPSHOT_RETAIN` values above 1 stay ignored.  A mid-pass
  wrongly treated unused leftover `R2_ARCHIVE_KEEP_GENERATIONS=2` as the
  weekly driver — that name is not consulted (empty `weekly/` prefix).
  That coupling was removed.  Did not delete live R2 objects.  No
  Coolify/Infisical edits.
- Runbook: `docs/runbooks/uptime-health-json-monitors.md`.

Touched files:

- `app/api/health/route.ts`
- `app/api/ops/snapshot/route.ts`
- `src/lib/trading-liveness.ts`
- `src/lib/ops-auth.ts`
- `src/lib/r2-cold-snapshot.ts`
- `scripts/fetch-prod-ops-snapshot.sh`
- `test/health-json-monitors.test.ts`
- `test/health-route-exposure.test.ts`
- `test/ops-snapshot.test.ts`
- `test/r2-cold-snapshot.test.ts`
- `test/trading-liveness.test.ts`
- `docs/runbooks/uptime-health-json-monitors.md`
- `docs/rollouts/2026-08-18-health-json-monitors.md`
- `.env.example`
- `.cursor/rules/ops-diagnostics.mdc`
- `AGENTS.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-6-customization-risk-notifications.md`

## Decisions & Trade-offs

- Kept `tradingLiveness.degraded` as a **count** (existing public contract).
  Added always-on `tradingLivenessDegraded` boolean so keyword monitors have a
  unique substring, matching the OpenRouter `"ok":false` pattern.
- Did not steal #2792 / #2798 / #2800 / #2794 (FilingAPI, alert-noise, Pinecone
  WU deadlock, iOS readiness).
- Did not change rag-embed criticality.
- Did not treat unused leftover `R2_ARCHIVE_KEEP_GENERATIONS=2` as a weekly
  retain bug after host proof showed it only applies to empty `weekly/`.

## Verification State

```bash
npx vitest run test/health-json-monitors.test.ts test/ops-snapshot.test.ts \
  test/r2-cold-snapshot.test.ts test/health-route-exposure.test.ts \
  test/trading-liveness.test.ts
# 5 files / 54 passed after decoupling unused R2_ARCHIVE_KEEP_GENERATIONS

npm run lint          # 0 errors (767 grandfathered warnings)
npx tsc --noEmit      # exit 0
npm run build         # Next.js 16.3.1 webpack, exit 0 after decoupling
```

Focused health/ops/R2 tests are green.  A full `npm test` in this VM hit
unrelated env flakes (live SEC/Finnhub 404s, leftover `PUSHOVER_*` /
`siliconflow` keys in the shell).  Those files were not changed.  CI `verify`
is the authoritative full-suite gate.

## Next Steps & Blockers

Rebased onto `origin/main` 2026-08-18 (`522b2454`) so #2816 mergeable is
CLEAN.  Did not merge.  Owner: create the three UptimeRobot keyword monitors
from the runbook and point them at Pushover.  Allow 4xx/5xx on those keyword
monitors.  Leave the HTTP 200 monitor as process-down only.  Do not delete
`cold-snapshots/app-2026-08-16.db` from an agent.  Do not flip unused
`R2_ARCHIVE_KEEP_GENERATIONS=2`.

## Zero-Code Findings

Live `https://socratictrade.com/api/health` was already HTTP 200.  Before this
PR, `schedulerStale` was omitted when healthy, `tradingLivenessDegraded` was
omitted when not degraded, and `litestreamTiersDegraded` was already present
as `false`.  Prod `/api/ops/snapshot` already accepted the cloud
`OPS_DIAGNOSTIC_TOKEN` (ADMIN unset in this environment).  Host-corrected:
weekly retain=1 is already verified (`R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`,
`R2_COLD_SNAPSHOT_RETAIN` unset, exactly one `cold-snapshots/app-2026-08-16.db`).
`R2_ARCHIVE_KEEP_GENERATIONS=2` is unused leftover (`weekly/` empty) and does
not drive weekly retain — not treated as a bug.
