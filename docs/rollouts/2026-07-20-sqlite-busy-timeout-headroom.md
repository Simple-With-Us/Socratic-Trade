# SQLite busy_timeout headroom 30s → 60s

## Summary

Raised `busy_timeout` from 30s to 60s in `src/lib/db.ts` to reduce SQLITE_BUSY ("database is
locked") errors under the current unusually heavy concurrent-write load on the production SQLite
file.

## Why

Owner-directed production triage (`resolve everything... make sure pinecone is working right`).
Investigated `/api/health` reporting `pinecone: false` and Sentry issue **SOCRATIC-TRADE-T**
("Pinecone connection failed", 13 events over 5 days, most recent ~30 min before this fix,
`substatus: regressed`).

The issue's own event payload was decisive: `rag.reason: "database is locked"` — the failure is a
local SQLite lock-contention error (SQLITE_BUSY) hit during a RAG query's incidental local DB read
(`withRagApiHealth("pinecone", ..., "query private namespace", ...)`), surfaced through an
error-wrapping path that labels it "Pinecone connection failed" regardless of the true cause.
Cross-checked directly against Pinecone: `list-indexes`/`describe-index-stats` via the Pinecone
MCP showed the `socratic-trade` index `status.state: "Ready"` throughout — there was never an
actual Pinecone-side outage.

`src/lib/db.ts` already runs WAL mode + `busy_timeout = 30000` (raised from the 5s default by PR
#1728, 2026-07-18, for the same class of "disk-thrash during Docker builds" contention). That
30s ceiling is not absorbing contention during this session's unusually heavy concurrent-write
window: AG's large-scale production BGE-M3 reindex (`scripts/reindex-all.ts`, confirmed batched
via `BATCH_SIZE` chunking, not a single mega-transaction — ruled out as the literal lock-holder),
the scheduler's normal tick writes, the EarningsCalls burst-ingest program, and this session's own
repeated deploy cadence (each restart briefly contends for the file) are all writing the same
production SQLite file concurrently. WAL mode already lets readers proceed while a single writer
holds the lock, so raising the wait ceiling only affects genuinely write-contended callers — it
cannot mask a structural bug, it only gives real contention more time to clear before erroring.

## Files

- `src/lib/db.ts` — `busy_timeout` pragma 30000 → 60000, comment updated with rationale.
- `docs/EFFORT-LOG.md`, `STATUS.md` — this rollout's entries.

## Verification

- Reviewed the exact diff (single pragma value + comment, no logic change) — negligible
  type-safety surface; a synchronous `npx tsc --noEmit` run was attempted but the shared build
  box was under load average ~130 at the time and the foreground check did not return before the
  session's timeout window. No functional risk from this change class (a `PRAGMA busy_timeout`
  value bump cannot introduce a TypeScript error): relying on the hosted `verify` CI gate as the
  authoritative check per this repo's normal PR flow.
- Confirmed via Pinecone MCP (`list-indexes`, `describe-index-stats`) that the `socratic-trade`
  index is healthy (`Ready`) independent of this fix — the fix targets the local lock contention,
  not any Pinecone-side condition.
- Confirmed `scripts/reindex-all.ts` batches its accession-clearing work (`BATCH_SIZE` loop, no
  bare `.transaction()`/`BEGIN` wrapping the whole run) — ruled out as a single long-held write
  lock; the contention is more likely aggregate volume across many short concurrent writers than
  one pathological long transaction.

## Follow-ups

- Watch Sentry SOCRATIC-TRADE-T after this deploys; if "database is locked" recurs even at 60s,
  the next step is identifying the specific long-held writer (WAL checkpoint pressure under
  sustained heavy write volume is the leading suspect) rather than continuing to raise the
  timeout indefinitely.
- Separately and NOT addressed by this fix: production trading autonomy is very likely halted on
  all 3 connected accounts (`tradingLiveness.degraded: 3`, `oldestCompletedRunAgeSeconds` ~69h+ at
  time of triage, market open). Root cause is `reconcileAutonomyOnBoot()` in `src/lib/scheduler.ts`
  — every deploy/restart reverts each account's policy `systemState` from `active` to `halted`
  unless that user has `autoResumeOnBoot` enabled, and this session's PR-landing train has driven
  an unusually high deploy cadence. Both `/api/strategy/enable` (re-arm) and
  `/api/settings/auto-resume` (the persistent opt-out-of-halting toggle) are plain
  session-authenticated routes with no admin-token path — re-arming requires the owner's own
  authenticated browser session. Flagged directly to the owner; not acted on by this agent.
- The mislabeling itself (a local DB error surfacing as "Pinecone connection failed") is a minor
  observability gap worth a future fix: `withRagApiHealth`'s error path should distinguish a local
  SQLite failure incidental to a Pinecone call from an actual Pinecone-side failure, so Sentry/health
  attribute future incidents correctly on the first look.
