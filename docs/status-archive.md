# STATUS.md archive — entries through 2026-08-01

`STATUS.md` is defined by AGENTS.md as a *snapshot* ("current state, blockers, next
action"). In practice it had become an append-only changelog duplicating
`docs/rollouts/` (932 notes) and `docs/EFFORT-LOG.md`. On 2026-08-01 the changelog
entries were moved here and STATUS.md was restored to a snapshot.

Two artifacts below are preserved as-found rather than silently rewritten, because
they are the clearest evidence of a live problem — `.gitattributes` sets
`merge=union` on STATUS.md, PLAN.md and docs/EFFORT-LOG.md, and union-merge
interleaves both sides of a concurrent edit instead of conflicting:

1. The `2026-07-30 — Pushover Notification Channel Support (ANTIGRAVITY)` heading has
   NO body, and the numbered Pushover implementation notes appear instead under the
   later `2026-07-30 — Coolify token split + Infisical guardrails (GROK)` heading.
   Those notes describe Pushover, not the Coolify/Infisical work — two agents' entries
   were spliced together by the union driver.
2. The near-identical "All 5000+ tests, the TypeScript compiler, and the linter pass"
   lines that follow are the same collision.

Union-merge is deliberate (it stopped auto-merge-armed PRs rotting into CONFLICTING on
every board edit); the tradeoff is that these files can silently corrupt. See the
2026-08-01 rollout note.

---

## 2026-08-01 — Time-Bounded (PIT) Proposal Evidence for the Auto-Tuner (KIMI) — PR #2327

Definitive fix for the §6 slice-3 finding (PR #2305): the auto-tuner's candidate weights were proposed from ALL-history realized outcomes spanning the held-out OOS fold. Now `computeOosEvidenceCutoff` (IO-lite, audit-only, no OHLC) replicates the fold arithmetic on matured signal_snapshot dates, and `proposeStrategyTuning` cuts its realized-outcome evidence (performance summary, fills, factor + source-value scorecards, skipped-candidate counterfactuals) off at the fold start — default ON via `policy.tuning.pitEvidenceCutoff`, no-op when no fold exists. The OOS readout discloses the cutoff INSTEAD of the partially-in-sample caveat (weight path is now genuinely OOS); autonomous ledger/provenance evidence carries it too. Aggregate learning state intentionally not cut (§6 slice-2 territory). 5 new tests. Gates: tsc clean, lint 0 errors, 154 targeted, full suite 5538/5538 (3 shards); local build blocked by a foreign session's staged r2-usage WIP (unrelated) — build gate via verify CI. Branch `kimi/pit-evidence`. Rollout: `docs/rollouts/2026-08-01-pit-evidence-cutoff.md`.

## 2026-08-01 — App Icon White Background & Light-Mode Candlesticks (ANTIGRAVITY)

Updated app icon background in `public/icon.svg` to pure white (`#ffffff`) and regenerated PWA/iOS PNG icons (`icon-512.png`, `icon-192.png`, `apple-touch-icon-180.png`). Optimized candlestick green and red color palettes in `public/icon.svg`, `candle-ticker.ts`, `intro-canvas.tsx`, and `candlewordmarkhorizontal.svg` for high contrast against light backgrounds.

All tests, lint, tsc, and Next.js build pass cleanly. Rollout: `docs/rollouts/2026-08-01-app-icon-white-bg-candlesticks.md`.

## 2026-07-31 — Fix admin.socratictrade.com DNS 525 Error & Host Routing (ANTIGRAVITY)

Fixed Cloudflare Error 525 (SSL Handshake Failed) on `admin.socratictrade.com` by adding `admin.socratictrade.com` and `*.socratictrade.com` to `/etc/usage-monitor/Caddyfile` on Oracle Cloud (`<ORACLE_IP_RETIRED>`) and reloading Caddy. Also added middleware host routing in `middleware.ts` so `admin.socratictrade.com/` redirects directly to `/admin` and shorthand paths redirect to `/admin/<subpath>`.

All 4,893 tests, lint, tsc, and Next.js build pass cleanly. Rollout: `docs/rollouts/2026-07-31-admin-dns-routing-fix.md`.
## 2026-07-31 — Litestream IPC socket writable path (GROK) — branch `agent/grok-litestream-socket`

Production R2 replication was healthy after the AWS_* cutover, but `/api/health` stayed
`storageDegraded` with `litestreamDegradedReasons: ["unavailable"]` because the control
socket at `/var/run/litestream.sock` could not bind as the non-root `node` user. Moved the
socket to `/app/data/litestream.sock` (DB volume) in `litestream.coolify.yml` and made
`defaultLitestreamSocketPath(dbPath)` the health-probe default. Rollout:
`docs/rollouts/2026-07-31-litestream-socket-writable-path.md`.
## 2026-07-31 — Hetzner servers deleted: formal in-repo retirement (KIMI) — branch `kimi/retire-hetzner-servers`

Owner deleted both Hetzner boxes 2026-07-31 (ci-cpx32 build server `77.42.35.209` + old prod `<HETZNER_OLD_IP_RETIRED>`). Deleted `scripts/monitor-coolify-runners.sh` + `scripts/ops/fleet-site-watchdog.sh` (dead-box tooling; grep-verified no references), repointed `scripts/sync-provider-knobs.sh` defaults to the Oracle host with a Coolify-DB rework note (no `/data/coolify` tree there; env lives encrypted in Coolify Postgres), added an AGENTS.md retirement stanza, staged the `sentry-ci-report.yml` stale-comment refresh under `ci-pending/` (push token still lacks `workflow` scope). GitHub-side verified clean: zero runner registrations from the deleted boxes (fleet `oracle-*-ci` runners belong to the other repos), DNS proxied/current, AG***-S**C.md/README untouched. Rollout: `docs/rollouts/2026-07-31-hetzner-servers-deleted.md`.

## 2026-07-31 — Token-Gated Market-Data Read Routes for congress.trade (KIMI) — branch `agent/kimi-market-read-routes`

App A (congress.trade) can now PULL EOD price history from App B (cache-aside primary price source): `GET /api/market/prices/{symbol}?from=&to=` → shared-package `PriceSeries` envelope (closes DESCENDING, closes[0] = latest, `currentPrice`/`currentPriceDate` range-independent) and `GET /api/market/spx?from=&to=` → `{ closes }` from SPY daily bars. Unknown symbol / empty range → 200 with empty closes (non-200 = fallback trigger only). Auth reuses the exact `APP_B_INGEST_TOKEN` bearer mechanism of `POST /api/admin/securities/import` (`verifySecuritiesImportToken`); middleware gains a narrowly-scoped bearer pass-through for the two paths (`/api/market/flatfile` stays session-gated). Bars come from the canonical `fetchDailyOHLC` cascade (Massive keyed first, ~30min in-process cache) — `data/history-5y/` confirmed dev-only (not in git/image/prod volume), no new pipeline. New `src/lib/market-read.ts` (injectable fetcher) + 22 tests. Gates: targeted 22/22, tsc clean, lint 0 errors, full suite + build green (all under Node 24 per `.nvmrc`). Built in dedicated worktree `~/apps/trading-kimi-market-read` (lane was in active concurrent use). Rollout: `docs/rollouts/2026-07-31-market-read-routes.md`.
## 2026-07-31 — Notification-error root-cause fixes (KIMI) — branch `agent/kimi-lane`

Owner reported the recurring notification-feed errors of 2026-07-28..30. Four code fixes: (1) Red Team now fails over to `redTeamFallbackModels` on empty/ambiguous/unparseable/malformed-shape HTTP-200 content (previously only HTTP errors/timeouts failed over → the "Red Team unavailable" storm); (2) the Bull step fails over on an empty LLM body with `strategy_llm_failover{reason:"empty_response"}` (previously the whole run died — "Empty response returned from LLM API."); (3) usage telemetry no longer embeds the volatile deploy `gitSha` in event metadata, and the replay lane self-heals monitor 409 idempotency collisions by skipping exactly the monitor-named row (audited `usage_monitor_replay_collision_skip`) instead of wedging the watermark; (4) repeat `block`/`pending_approval` notifications are suppressed for 6h (env `NOTIFICATION_REPEAT_DEDUP_MS`) by a digit-normalized situation fingerprint — the underlying blocks remain persisted as run proposals. 18 new tests. Gates: tsc clean, lint 0 errors, full suite 5472/5472, build green, targeted 110/110 after merging origin/main (#2310). Rollout + owner action items (Massive/Polygon plan lapsed, FMP 403, litestream socket unreadable on prod, stuck sell orders): `docs/rollouts/2026-07-31-notification-error-root-causes.md`. NOTE: the market-read-routes code below is stashed uncommitted (labeled stash on `agent/kimi-market-read-routes`) — restore with `git stash pop` there.

## 2026-07-31 — Token-Gated Market-Data Read Routes for congress.trade (KIMI) — branch `agent/kimi-market-read-routes`

App A (congress.trade) can now PULL EOD price history from App B (cache-aside primary price source): `GET /api/market/prices/{symbol}?from=&to=` → shared-package `PriceSeries` envelope (closes DESCENDING, closes[0] = latest, `currentPrice`/`currentPriceDate` range-independent) and `GET /api/market/spx?from=&to=` → `{ closes }` from SPY daily bars. Unknown symbol / empty range → 200 with empty closes (non-200 = fallback trigger only). Auth reuses the exact `APP_B_INGEST_TOKEN` bearer mechanism of `POST /api/admin/securities/import` (`verifySecuritiesImportToken`); middleware gains a narrowly-scoped bearer pass-through for the two paths (`/api/market/flatfile` stays session-gated). Bars come from the canonical `fetchDailyOHLC` cascade (Massive keyed first, ~30min in-process cache) — `data/history-5y/` confirmed dev-only (not in git/image/prod volume), no new pipeline. New `src/lib/market-read.ts` (injectable fetcher) + 22 tests. Gates: targeted 22/22, tsc clean, lint 0 errors, full suite + build green (all under Node 24 per `.nvmrc`). Rollout: `docs/rollouts/2026-07-31-market-read-routes.md`.

## 2026-07-30 — qlib Walk-Forward Window Report + In-Sample Disclosure (KIMI) — PR #2305

OSS-lessons §6 slice 3 of 3. Audit finding: the walk-forward SPLIT was already sound (chronological, always-on embargo, opt-in purge); the residual leak is that the tuner's candidate weights are proposed from ALL-history evidence that includes the recent held-out OOS test fold — partially in-sample. Implemented the qlib report: `splitWalkForward` returns exact fold-boundary indices; `OOSResult` gains a required `window` (train/test first+last dates, embargo/purge counts) + pure `formatOosWindow`; the manual `applyOosGate` readout names the held-out window and carries the partially-in-sample disclosure in both caution branches; the autonomous `oosReadout` (ledger + provenance evidence) gains the window + caveat. Definitive fix (time-bounded proposal evidence) filed as a follow-up board row. 8 new/updated tests + 3 fixtures. All gates green: tsc exit 0, lint 0 errors (7 pre-existing warnings), 89/89 affected, full suite 5450/5450 (3 shards), build exit 0. Branch `kimi/walk-forward-window`. Rollout: `docs/rollouts/2026-07-30-walk-forward-window.md`.

## 2026-07-30 — Rule Significance Testing (Jesse label-permutation baseline) (KIMI) — PR #2294

OSS-lessons §6 slice 1 of 3. Track-record facts ingested into learned context now carry an honest significance sentence: does the thesis bucket's mean realized return beat a random same-size bucket of the pooled tagged closed-lot history (label-permutation null, 1000 permutations, +1 correction)? Confidence scales — 0.7 when the edge is unlikely to be luck, 0.45 when luck isn't ruled out (fact still written; annotation not hard-gate). New pure `src/lib/significance.ts` (injectable rng, pool-size floor) + `poolClosedLotReturnsByThesis` wiring in `post-mortem.ts`. Sentence digits are bare p-value + permutation count only — test-verified `classifyRiskTier` keeps it a fact. 15 new tests. All gates green: tsc exit 0, lint 0 errors (3 pre-existing warnings, down from 4), 22/22 targeted, full suite 5446/5446 (3 shards), build exit 0. Branch `kimi/rule-significance`. Rollout: `docs/rollouts/2026-07-30-rule-significance.md`. Slices 2-3 (TraderHarness PIT masking, qlib walk-forward) remain planned/unassigned.

## 2026-07-30 — Pushover Notification Channel Support (ANTIGRAVITY, branch `agent/antigravity-pushover`)
## 2026-07-29 — Adjusted Day P&L for Cash Flows (ANTIGRAVITY, branch `agent/ag-day-pnl`)

Updated `deriveDayPnl` to correctly handle intraday cash deposits and withdrawals by reusing the `inferExternalCashFlows` helper from the benchmark engine. The dashboard will now compute P&L correctly by netting out any cash flows, preventing the UI from misattributing cash deposits as profit.

Tests and build are green. Rollout: `docs/rollouts/2026-07-29-day-pnl-cash-flow-adjusted.md`.

## 2026-07-29 — Expose Portfolio Errors in UI (ANTIGRAVITY, branch `agent/ag-portfolio-error`)

Exposed `getPortfolio` failure errors directly in the UI instead of silently swallowing them and showing the default $1,000 policy limit. The exact error (e.g. Robinhood agentic MCP failure) will now render as a warning chip so the user can diagnose connections issues quickly.

All 5431 tests and the Next.js build passed cleanly. Rollout: `docs/rollouts/2026-07-29-portfolio-error-ui.md`.

## 2026-07-30 — Coolify token split + Infisical guardrails (GROK)

Added Pushover as a standalone notification channel inside `notification_prefs`:
1. Updated types `NotifyPrefs` and `NotifyChannelId` in `src/lib/types.ts`.
2. Created a new SQLite migration `063-notification-prefs-pushover.sql` and appended versioned migration 63 to `src/lib/db.ts` to add the `pushover_target` column. Also hardened the migration to support isolated partial test schemas.
3. Updated `app/console/settings/delivery.tsx` and `lib.ts` to allow configuring the Pushover User Key.
4. Separated out Pushover from the legacy ntfy Push system in `src/lib/notify.ts` to construct its own dedicated REST POST payload to `api.pushover.net`.
5. Updated `src/lib/db-api-keys.ts` to save and extract the target appropriately.

All 5000+ tests, the TypeScript compiler, and the linter pass. Changes are currently landing via `scripts/land.sh`.
All 5000+ tests, the TypeScript compiler, and the linter pass. Changes pushed and merged via `scripts/land.sh`.

## Blockers
- None for this worktree, but `land.sh` is currently running and merging into `main`. Wait for it to finish.

## Next Action
- **For Kimi (Next Agent):**
  1. Wait for `land.sh` to finish merging in the `trading-antigravity` lane.
  2. Sync your `~/apps/trading-kimi` worktree with `origin/main` to pick up migration 63 and the Pushover UI before starting new work.
- Wait for user instructions or close ticket.
