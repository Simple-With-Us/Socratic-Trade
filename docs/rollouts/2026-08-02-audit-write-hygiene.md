# Data-storage investigation + audit write-hygiene fixes (2026-08-01/02)

## Context & objective

Owner asked for a real investigation of how we store data, what we store, and
where we're storing data we shouldn't, losing data we should keep, or
inefficiently writing/reading (their call: "the most likely type of problem
and the most difficult to identify"). Trigger: the R2 backup stream was
growing ~3 GB/day on a 1.5 GB DB.

## What the data showed (all measured on prod)

**DB composition (1.43 GB total):**

| Table | Rows | Size | Note |
| --- | --- | --- | --- |
| audit_events | 493k | **718 MB (50%)** | no retention at all |
| provider_dispatch_attempts | 304k | 109 MB | 17.5k rows/day, no retention |
| provider_usage_outbox | 261k | 60 MB | 11.7k rows/day, no retention |
| historical_fundamentals | 672k | 61 MB | legitimately large corpus |
| task_journal | 160k | 31 MB | bounded (retention works) |

**Write-volume findings (the "inefficient writing" the owner predicted):**

1. **Steady-state skip spam**: `broker_protective_stop_skipped` fired
   **~14k/day** — the SAME note ("no uncovered whole shares…") for the same
   5 symbols (V, AFL, BAC, CB, GILD), every scheduler tick, for weeks.
   `fill_reconciliation_pending_price` likewise **~4.5k/day** for orders
   parked in the same broker state. 97k+31k rows/week of zero-information
   events.
2. **strategy_run audit payloads**: the full StrategyResult was dumped per
   run — avg 600 KB, p90 **2.8 MB** (the embedded full `marketScan` = 2.7 MB
   of it). 130/141 runs in 7 days >500 KB → ~430 MB/month, while consumers
   (dashboard-feed, ops-snapshot) read only status/summary/llmSteps (~1 KB).
3. **WAL churn ≈ 1.5 GB/day** into litestream from this write volume; plus
   the 1.5 GB daily snapshot → the ~3 GB/day backup growth. DB row growth
   itself (~30-60 MB/day) was NOT the driver — page rewrites were.

**Data-loss risks found:** backups were the weak point, not the app:
UM's replica was silently NotEntitled-broken since Jul 29 (fixed yesterday);
CT had NO continuous backup at all (fixed yesterday). App-side retention was
the inverse problem — nothing pruned audit_events ever.

## Fixes shipped (this PR)

1. **`src/lib/audit-dedupe.ts`** — `auditDeduped(kind, payload, signatureParts, …)`:
   logs the first occurrence of a signature immediately, then ≤1/6h while the
   same condition persists (settings-KV watermark, crash-safe). Applied to
   all 7 `broker_protective_stop_skipped` sites (via a file-local
   `auditStopSkipped` wrapper, signature = symbol+kind+note) and to
   `fill_reconciliation_pending_price` (signature = fillId+brokerState).
2. **`src/lib/audit-bounded-run.ts`** — `auditBoundedStrategyRunResult` swaps
   the embedded full `marketScan` for a bounded summary (source, counts,
   top-15 symbols, `omitted: true` marker). 2.8 MB → ~5 KB per run; the scan
   is reconstructable and decisions live in their own tables.
3. **`src/lib/audit-prune.ts` + scheduler lane `audit-prune` (daily)** —
   retention: observability kinds 14d, everything else 90d;
   provider_dispatch_attempts/provider_usage_outbox 14d; 50k-row batches so
   the first-ever backlog drain can't stall trading. NOTE: deletes free
   pages but the FILE only shrinks after a VACUUM — deliberate operator
   action, not automated (full rewrite = one large WAL burst).

## Expected effect

- audit write volume: ~19k skip events/day → ~tens/day (dedupe)
- strategy_run payload: ~2.8 MB → ~5 KB per run (bounding)
- audit_events growth: unbounded → 14/90d bounded (prune)
- Backup stream: snapshot still 1.5 GB/day until a VACUUM shrinks the DB;
  WAL churn should drop materially with write volume.

## Verification state

- `npx tsc --noEmit` clean; `npx vitest run test/audit-hygiene.test.ts
  test/r2-usage.test.ts` 39/39 green (9 new). Full suite + build delegated
  to required `verify` CI.
- All findings above measured directly on the prod DB (table sizes via
  dbstat, per-kind growth via created_at windows, spam concentration via
  payload extraction).

## Next steps & blockers

- Watch the next daily `audit-prune` lane run (backlog drains over several
  days at 50k/pass; ~900k rows eligible).
- Operator VACUUM once the backlog is drained (reclaims ~700 MB file size;
  schedule in a quiet window — one large WAL burst, ~1.5 GB, hits the backup
  stream once).
- Longer-term: consider moving provider observability off the hot DB to the
  Usage Monitor bridge (it already mirrors usage there).
