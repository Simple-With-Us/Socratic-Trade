# R2 `trading-live/**` dead history — prune plan + dry-run tooling

## Context & Objective

Board `242c350e07ac45808eaf5eeeebdca255` (GB-HOUSEKEEPER).  ST R2 bucket `socratic-trade-bucket` is
near the Cloudflare free-tier storage cap (~9 GiB, 2026-10-05 owner report) largely due to **dead**
pre-B2-cutover Litestream objects under `trading-live/**`.  Live replication is Backblaze B2 — **do
not touch B2**.  This effort delivers a safe human-operated prune **plan** and read-only inventory
scripts only; **no live deletes**.

## Changes Made

- Added operator runbook `docs/runbooks/r2-trading-live-dead-history-prune.md` (endpoint/bucket
  verification, scope, phased inventory, deferred delete section).
- Added `scripts/ops/r2-trading-live-dead-history-inventory.mjs` — lists `trading-live/**` on historic
  R2 only; refuses wrong bucket or non-R2 endpoint; optional `--i-understand-r2-dead-history` for full
  key listing; **no delete path**.
- Added `test/r2-trading-live-dead-history-inventory.test.ts`.
- Clarified `docs/litestream.md` inventory caveat + link to runbook.

**Source references (unchanged, cited in runbook):** `litestream.coolify.yml` (B2 live, R2 dead,
  footgun), `scripts/ops/r2-cold-snapshot-inventory.mjs`.

## Decisions & Trade-offs

- Reused `AWS_R2_HISTORIC_*` env names from the cold-snapshot inventory script — same R2 read token
  boundary, keeps prod Infisical `AWS_*` (B2) out of the path.
- Hard-coded expected bucket `socratic-trade-bucket` and R2 host suffix check to fail closed before
  listing (misconfigured B2 endpoint exits 1).
- Did **not** add any `--delete` or lifecycle automation; owner approval + separate rollout required
  for Phase 1 deletes.
- Did not re-run live R2 inventory in cloud VM (no `AWS_R2_HISTORIC_*` in this seat).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/r2-trading-live-dead-history-inventory.test.ts test/r2-cold-snapshot-inventory.test.ts
```

Record results below after commands complete.

## Next Steps & Blockers

1. Owner: confirm `AWS_R2_HISTORIC_*` scoped to `socratic-trade-bucket` R2 read (write optional only
   for a future delete run).
2. Operator: run Phase 0 inventory from runbook; save stdout; compare `trading-live/` GiB to dashboard.
3. Future PR (owner-approved): execute Phase 1 delete or lifecycle on R2 only; post-prune inventory.

## Zero-Code Findings

- `litestream.coolify.yml` already documents R2 as prunable dead history and B2 as live (lines 6–25).
- Sept 2026 read-only inventory in `docs/litestream.md` reported `trading-live/` empty; owner 2026-10-05
  reports ~9 GiB bucket with dead `trading-live/**` — **re-inventory required** before any delete.
