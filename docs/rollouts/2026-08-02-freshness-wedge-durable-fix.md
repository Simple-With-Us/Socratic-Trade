# 2026-08-02 — Durable fix for the market-scan-freshness prod wedge

**Agent:** MONET · branch `monet/freshness-wedge-fix` (off `origin/main`)
**Incident:** prod outage 12:01–12:14Z + repeated 2-min dips (13:20, 13:38…) after #2353's
deploy. Stopgap in force: `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS=0` staged on the Coolify app
by the incident lane (applies at next container create). This PR makes the lane safe to
re-enable.

## 1. Context & Objective

Root cause (code-traced by a dedicated investigation agent, premise-corrected with the
incident lane): `scheduler.ts` runs a full tick at boot+ε; #2353's new
`market-scan-freshness` lane fires on it; the 20h staleness gate is open all weekend; and
the lane then holds the single synchronous better-sqlite3 connection for minutes — four
un-indexed `latestAuditByKind` probes dragging multi-MB `market_scan`/`strategy_run`
payloads through the SQLite sorter against a 718 MB `audit_events` table (this part ran on
EVERY 60s tick), then a cold full-universe `scanMarket` on the event loop. The freshness
stamp writes only after completion, so the healthcheck kill created a boot-loop. Amplifier:
`usage-monitor-knobs` never negative-cached a failed monitor fetch, re-entering a fetch +
sync `logApiHealth` DB transaction per provider admission.

## 2. Changes Made

- **`src/lib/db.ts`** — covering index `idx_audit_events_kind_user_created
  (kind, user_id, created_at DESC)`: turns every `latestAuditByKind` (all callers, not just
  this lane) from a sorter pass / backward walk into an index seek.
- **`src/lib/db-learning.ts`** — `latestAuditStampByKind`: id+created_at only, payload
  never read.
- **`src/lib/market-scan-freshness.ts`** —
  - FAST GATE: staleness decided from stamps; usability (the "skipped strategy_run must
    not mask an older usable scan" rule) verified only when the newest row CHANGES, cached
    by row id. Steady state per tick: two index seeks, zero payload parses.
  - Boot grace (`FRESHNESS_BOOT_GRACE_SECONDS = 300`, enforced via the scheduler call site
    passing `process.uptime()` — unit callers exempt): a cold container serves HTTP before
    this lane may grind.
  - `AbortSignal.timeout(10min)` deadline on the freshness `scanMarket` call.
- **`src/lib/scheduler.ts`** — passes `process.uptime()` to the lane.
- **`src/lib/usage-monitor-knobs.ts`** — failed refreshes stamp a failure marker;
  `KNOBS_FAILURE_BACKOFF_MS = 5min` suppresses re-attempts (was: one fetch + one sync DB
  transaction per provider call while the monitor was down — and the monitor was known-down
  at deploy time).

## 3. Decisions & Trade-offs

- The fresh-stamp + cached-usability gate can, in one corner (newest row is a fresh
  skipped run AND the cache is cold), still do one full payload resolution — once per
  newest-row change, not per tick. Full masking semantics preserved (pinned by the
  pre-existing test).
- Boot grace is parameterized rather than read inside the lane so the 18 pre-existing unit
  tests (and their call shape) stay valid; production enforcement is at the scheduler.
- **Review posture (deliberate):** no multi-agent adversarial pass on this PR — prod was
  actively flapping and each hour of delay is more outage windows. The regression harness
  is the 18 pre-existing lane tests passing UNCHANGED plus 8 new tests (boot grace both
  sides, skip-run fall-through, cached-usability short-circuit, stamp fn, abort deadline,
  knob backoff both sides). The follow-up review can ride the next audit wave.

## 4. Verification State

- `npx tsc --noEmit` clean; eslint clean on all touched files (Node 24 prefix).
- `test/market-scan-freshness.test.ts` 24/24 (18 pre-existing unchanged + 6 new);
  `test/usage-monitor-knobs-backoff.test.ts` 2/2.
- Full `npm test` + `npm run build` via `scripts/land.sh` at landing.

## 5. Next Steps & Blockers

- After merge + deploy verification: owner/incident lane can REMOVE the
  `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS=0` stopgap to re-enable the lane on the fixed code.
- Longer-term (unclaimed): stop persisting full `quotesBySymbol` in `market_scan` audit
  payloads, or move that kind to the 14-day observability retention tier — the 718 MB
  audit table is the underlying mass.
- §7 slice 3 PR-2 (strategy/approval mutation-lease windows) remains parked on
  `monet/broker-mutation-mutex-pr2` with its full spec in
  `docs/rollouts/2026-08-02-account-mutation-lease-pr1.md`.
