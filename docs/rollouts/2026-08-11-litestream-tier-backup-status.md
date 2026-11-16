# 2026-08-11 - litestream per-tier backup status (health check + admin panel)

> [!CAUTION]
> **SUPERSEDED 2026-08-12 — the implementation described below had ZERO coverage in
> production.** It graded every compaction level from local `ltx/<level>/` mtimes, but
> litestream 0.5.12 keeps only level 0 on local disk, and the shared scan's 256-entry bound
> blinded even that one (`ltx/0` holds 1,000+ files). All five tiers reported `"unknown"` on
> every health check. The design rationale below (why per-tier detection is needed at all, and
> the threshold reasoning) still stands; the local-file mechanism does not.
> See `docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md` for the evidence and the
> replacement.

## Context & Objective

Tonight's incident response found litestream's B2 backup replication had a stuck level-1
compaction anchor, silently broken for 27+ hours (root cause, timeline, and evidence:
`docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`, "Root cause CONFIRMED"
section). The existing health check (`src/lib/runtime-health.ts`, exposed via
`checks.storage.litestream*` on `/api/health`) only observes level 0 (continuous sync, every
~60s per `litestream.coolify.yml`) via litestream's IPC `/list` control socket. It would not
have caught this bug: level 0 kept succeeding the entire time while level 1 (periodic
compaction) was wedged, and level 9 (daily full snapshot) is a third, separately-cadenced
tier with no monitoring at all. This work closes that gap: a new per-tier freshness check, a
public health-route field, and a dedicated admin panel that makes backup health legible to a
human at a glance instead of raw JSON.

## Changes Made

- **`src/lib/runtime-health.ts`** — new `assessLitestreamTierFreshness(statePath, options)`.
  For each of litestream's three compaction levels this app's config actually exercises (`0`
  continuous sync, `1` compaction, `9` daily snapshot), it finds the newest file mtime under
  `<statePath>/ltx/<level>/` (reusing the existing bounded `newestFileMtimeMs` scanner that
  `fileFallback()` already uses) and reports an age + a `degraded` flag against a per-tier
  threshold. A missing state directory, an empty/never-populated tier subdirectory, or a scan
  that hits the same entry/depth bounds as the existing file-fallback scanner all report
  `state: "unknown"` rather than throwing or guessing — safe to call in any environment
  (tests, local dev, other apps) where litestream isn't configured this way. New exports:
  `LitestreamCompactionTier`, `LITESTREAM_TIER_LABELS` (plain-English names for the UI —
  "Continuous Sync" / "Compaction" / "Daily Snapshot"), `LITESTREAM_TIER_STALE_AFTER_SECONDS`
  (default thresholds, with reasoning inline: level 0 = 10 min, level 1 = 4 h, level 9 = 30 h),
  `LitestreamTierFreshness`, `LitestreamTierFreshnessReport`.
- **`app/api/health/route.ts`** — wires the new check into the existing public
  `checks.storage` object as an additive `litestreamTiers` field (array of per-tier results;
  every existing `litestream*` field is untouched). The state path is now computed once and
  reused for both the existing IPC/file-fallback call and the new tier scan. If any known tier
  is degraded, `storageDegraded` flips true (same as the existing litestream/disk/WAL
  reasons) and a per-tier `alertStorageWarning("litestream_tier_<n>_stale", ...)` fires
  (subject to the existing cooldown). This never affects `ok`/503 — same philosophy as every
  other storage signal on this route: degrade and alert, never restart-loop.
- **`app/api/admin/backup-status/route.ts`** (new) — admin-gated (`requireAdmin`) read-only
  view combining the overall IPC/file signal and the new per-tier report, reshaped for the UI
  so it doesn't have to reverse-engineer the public health-probe response.
- **`app/admin/backups/page.tsx`** + **`app/admin/backups/backup-status-client.tsx`** (new) —
  admin sub-page (precedent: `app/admin/server/`) with a dedicated "Backup Status" nav entry.
  Shows the overall replication-daemon signal, then three cards (Continuous Sync / Compaction
  / Daily Snapshot) each with a healthy/stale/unknown dot, last-activity time, age, and
  threshold, plus inline copy explaining why the per-tier breakdown exists and citing the
  incident. Defensive JSON parsing follows the `server-metrics-client.tsx` precedent
  (`asRecord`/`readText` from `@/lib/server-metrics-shapes`; malformed/incompatible payloads
  degrade to "no data" rather than rendering a guess).
- **`app/admin/layout.tsx`** — new "Backup Status" nav item (`/admin/backups`, `DatabaseBackup`
  icon) alongside the existing "Server Stats" entry.
- **Tests** — `test/runtime-health.test.ts` (unit coverage for
  `assessLitestreamTierFreshness`: missing dir, missing statePath, empty tier dir, healthy vs.
  degraded per tier, the exact incident shape — fresh level 0 + wedged level 1 + fresh level 9
  — custom threshold overrides, and the bounded-scan-limit case), `test/connection-health-
  routing.test.ts` (integration test against the real `/api/health` route proving the new
  `litestreamTiers` field catches a stuck level-1 compactor in a scenario where the
  pre-existing `litestream*` fields stay non-degraded), and `test/backup-status-route.test.ts`
  (new file: admin-auth denial/allow + payload shape for the new route).

## Decisions & Trade-offs

- **Directory layout assumption.** The per-tier scan reads
  `<statePath>/ltx/<level>/` where `<statePath>` is litestream's local state directory
  (`defaultLitestreamStatePath()`, i.e. `<dbdir>/.<dbname>-litestream`). This matches the
  incident brief's description of the on-disk layout observed in the production container.
  This app's Next.js process and litestream share the same container/volume, so this is a
  same-host `fs.stat`/`fs.readdir` read — no SSH, no S3/B2 API calls.
- **Thresholds are judgment calls, documented inline** (`LITESTREAM_TIER_STALE_AFTER_SECONDS`
  in `runtime-health.ts`): level 0 = 10 min (~10x the 60s sync cadence), level 1 = 4 h
  (compaction is periodic, not continuous, so there's no fixed interval to anchor a tighter
  number to — 4 h catches a stuck compactor in hours rather than the 27+ hours it actually
  took), level 9 = 30 h (`snapshot.interval: 24h` + 6h buffer for one delayed/retried run).
  These are exposed as an `options.thresholdsSeconds` override for callers/tests, but there is
  no env-var override wired in yet — if these prove too tight/loose in production, the next
  step is promoting them to env-configurable knobs rather than re-editing constants.
- **Never gates liveness (`ok`/503).** Matches every other storage signal on this route
  deliberately: a spurious 503 here would restart the container, which cannot fix a remote B2
  compaction anchor and would just restart-loop (the exact class of problem the "production
  exit-code contract" section of `AGENTS.md` warns about). Only `storageDegraded` + an alert.
- **Not gated on `DB_BOOTSTRAP=live`.** The existing IPC/file-fallback signal restricts file
  metadata to non-live mode because it doesn't *prove* an R2/B2 upload succeeded. The new
  per-tier scan has no other signal to fall back to in any mode — a local LTX file existing IS
  the only evidence of tier activity — so it always runs. This is diagnostic, not proof of a
  successful remote upload, and the UI/alert copy says so.
- **`litestreamTiers` is public** (not gated behind the ops token), consistent with the
  existing `litestreamAgeSeconds`/`litestreamState`/etc. fields already on this public route —
  it carries no byte counts, no dollar figures, no secrets, just per-tier ages and a label.
- **Did not attempt to fix the actual stuck B2 compaction anchor** — that is the ops-side fix
  tracked in `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`'s next-steps
  section (inspect/reset the B2 generation at txid `2324d`). This change is purely the
  monitoring gap that let it run undetected for 27+ hours.

## Verification State

Run from this worktree with `/opt/homebrew/opt/node@24/bin` prefixed on `PATH` (repo default
Homebrew `node` here resolves to v26, which mass-fails `better-sqlite3`-backed tests per
`AGENTS.md`'s "Mac node26 ABI trap" note):

```bash
npx tsc --noEmit                                             # clean
npx eslint <touched files>                                   # 0 errors (pre-existing grandfathered warnings only)
npm run lint                                                 # 0 errors, 729 warnings (pre-existing backlog, unchanged in kind)
npx vitest run test/runtime-health.test.ts test/connection-health-routing.test.ts \
  test/backup-status-route.test.ts test/health-route-exposure.test.ts   # 57 passed
npm test                                                      # full suite — see below
npm run build                                                 # see below
```

State at time of writing: `tsc`, targeted vitest run, and `npm run lint` all verified clean.
Full `npm test` and `npm run build` were run and verified before commit (see the commit
message / final agent report for the exact pass counts — update this note if either
uncovered something that changed the design above).

## Next Steps & Blockers

- The stuck B2 compaction anchor itself (txid `2324d` per the event-loop-stall rollout note)
  is still not fixed — this change only makes it (and any future recurrence) visible fast
  instead of taking 27+ hours to notice. Daylight ops work to reset/clear the anchor remains
  open in that note's next-steps section.
- Consider env-configurable per-tier thresholds if the hardcoded defaults above prove wrong
  in practice (too noisy or too slow to catch a real incident).
- No restore-drill coverage added here — `docs/litestream.md`'s existing "Restore verification
  status" gap (backups have never been proven restorable end-to-end) is unrelated and still
  open.

## Zero-Code Findings

None beyond what's captured above — this was a code change, not a research-only session.

## Follow-up (2026-08-12 ~2:15am CT) — coverage extended to levels 2 and 3

Disproven within a day: the original monitor's assumption that "levels 2-8 are unused here."
Litestream's boot log starts compaction monitors for levels 1 (30s), 2 (5m), 3 (1h), and 9
(24h), and the 2026-08-12 production wedge sat at LEVEL 2 (byte-identical "non-contiguous
transaction ids" retry every 5 minutes) — structurally invisible to the 0/1/9 monitor shipped
the day before.  `LitestreamCompactionTier` now covers `0|1|2|3|9` (thresholds: L2 2h, L3 6h —
generous versus their monitor intervals because output only appears when enough lower-level
input has accumulated), the admin panel renders all five tiers, and the tier-count/threshold
assertions in `test/runtime-health.test.ts` + `test/backup-status-route.test.ts` are updated
(51 tests green).  Never-produced tier directories still report "unknown", not degraded, so a
fresh post-reset volume does not false-alarm.
