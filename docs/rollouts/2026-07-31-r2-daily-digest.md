# R2 free-tier daily digest (2026-07-31)

## Context & objective

Owner accepted the offer to receive a **daily summary of R2 free-tier
consumption via Pushover** so the 70%-pace trend is visible without opening
the `/admin` dashboard. Extends the R2 usage monitor shipped earlier the same
day (PR #2312, rollout `2026-07-31-r2-usage-monitor-aws-secret-rename.md`).

## Changes made

- `src/lib/r2-usage.ts` — new daily-digest block:
  - `r2UsageDigestEnabled()` — default ON when the monitor is configured;
    `R2_USAGE_DAILY_DIGEST=off` disables.
  - `isR2UsageDigestDue(now)` — separate 24h watermark
    (`r2usage:lastDigestAt`), `R2_USAGE_DIGEST_INTERVAL_HOURS` override.
  - `buildR2UsageDigestMessage(snapshot)` — per-metric MTD % + month-end pace
    with ✓ / ⚠️ flags, free-tier limits, threshold, scope, check time.
  - `runR2UsageDailyDigestIfDue(now)` — watermark-first, runs a FRESH usage
    check (digest is never a stale snapshot), then `notify()`s the summary
    (`kind: "r2-usage-digest"`), audits `r2_usage.digest`, self-guarded.
- `src/lib/scheduler.ts` — new `r2-usage-daily-digest` lane next to
  `r2-usage-check`.
- `.env.example` — documents `R2_USAGE_DAILY_DIGEST` +
  `R2_USAGE_DIGEST_INTERVAL_HOURS`.
- `test/r2-usage.test.ts` — 4 new tests (22 total): message composition,
  due-gating + off flag, fresh-check + notify + watermark behavior, silent
  skip when unconfigured.

## Decisions & trade-offs

- The digest runs its own fresh Cloudflare GraphQL check rather than reusing
  the 6h snapshot — one extra query/day is negligible and the summary is
  never up-to-6h stale.
- Independent watermark from the threshold-check lane so the two cadences
  don't interfere; the threshold lane may also fire its own alert the same
  run if a crossing happens — separate concerns, both useful.
- Digest fires regardless of threshold state (it's a heartbeat, not an
  alert); title carries ⚠️ when any metric is over pace.

## Verification state

- `npx tsc --noEmit` clean; `npx vitest run test/r2-usage.test.ts` 22/22
  green. Full suite + build delegated to the required `verify` CI gate.
- No Infisical/Coolify changes needed — activates on deploy (monitor env
  already present in prod). First digest fires on the first leader tick
  after deploy (no prior watermark), then every 24h.

## Next steps & blockers

- None. Delivery channel = the owner's existing notify prefs (Pushover is
  enabled in prod as of 2026-07-30).
