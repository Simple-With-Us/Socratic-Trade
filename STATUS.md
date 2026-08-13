## Current (2026-08-12 ~9:20pm CT MONET - console false load-failure, phone-correct load graphic, iOS candlestick splash, Lato everywhere)

Owner-reported four-parter, all landed on `monet/loading-fonts`.  The headline is a real bug: the
console showed "Couldn't load the autonomy desk" on essentially every load while the iOS app on the
same account loaded fine.  Both clients call the SAME `getDashboardSnapshot`, so this was never a
server split - the console's 15s first-load watchdog SET `error`, and the shell rendered its
full-screen failure card on `error` alone, so any first load in the routine 15-24s band (the
server's own sequential broker-chain worst case) showed a failure screen while the request was
still in flight and about to succeed.  iOS has no such timer and simply waited.  Fixed via a new
pure `console-load-state.ts` ("an error while a fetch is still in flight is not a failure") with the
15s timer demoted to a reassurance line under the load screen; 7 regression tests - the rule was
untestable inside the React hook (node-only vitest, no jsdom), which is why it shipped.  Server-side
slowness itself is UNTOUCHED and remains the real follow-up: parallelising the sequential
accounts -> portfolio/positions/orders -> quotes chain.

Also: the intro canvas now measures the fixed overlay instead of `window.innerHeight` (they
disagree by 60-90px on iOS Safari, which pushed the chart down and clipped its low wicks on every
iPhone), DPR 3 on phones, iOS URL-bar resize absorption, safe-area-aware landing box.  iOS
`LaunchStateView` (icon + spinner + "Socratic.Trade") is now the candlestick SOCRATIC TRADE wordmark
at the top that slides away, sized by the web `MobileBrandRow` formula, plus a `LaunchBackground`
colorset that kills the white cold-launch flash.  Found and fixed a shipped bug along the way:
`CandleWordmarkView` rendered the wordmark VERTICALLY MIRRORED (S as 2, R as K, A as Y) from a
double row-flip in `alphaAt` - visible on the login screen in the current build.  Lato is now
self-hosted (deliberately NOT `next/font/google`: a build-time fetch would freeze auto-deploy) as
the site-wide default plus a named picker option, and bundled on iOS with Dynamic-Type-preserving
`.app*` twins across all 120 call sites.  Worth knowing: `--font-sans` named "Inter" but never
loaded it anywhere - no @font-face, no next/font, nothing in public/ - so the site had been
rendering in the device system font all along; Lato is the first real webfont it has ever resolved.

Gates: tsc clean, lint 0 errors, 6449 tests green, build clean, xcodebuild 40 iOS tests green.
Verified live, not just green: iOS simulator screenshots of the real launch sequence (that is how
the mirrored wordmark was caught), the built .app bundle inspected for font placement, and the
console load screen at 375x812 with Lato confirmed resolving at runtime.
Rollout: `docs/rollouts/2026-08-12-load-screens-and-lato.md`.  Blockers: none.

## Current (2026-08-12 ~7:45pm CT CLAUDE — round 3 landed: scorecard, lookahead audit, PIT chain, Polymarket)

Four backlog features land in this PR (details in the four r3 rollout notes): the unified
ProposalScorecard (deterministic receipts: MA alignment, sniper points, gate checklist, signal
attribution summing to 100, decision chain with a persistence-time validator), the
truncated-replay lookahead audit (weekly lane; momentum/liquidity + RAG evidence replayed with
history cut at decision time; honest unverifiable labels; 90-day windowed verdict), the PIT
fundamentals revision chain (restatements never rewrite history; as-of reads with a strict
knob), and keyless Polymarket prediction-market context in the strategist prompt.  All slices
adversarially verified; 13 integration fixes applied; full suite 6423 green + build clean before
push.  This deploy also activates the owner-directed ingestion re-enable (SEC worker on, filing
cap 25) — first sync stretch is being watched for the 2026-08-10 event-loop-pinning recurrence.
Blockers: none.

## Current (2026-08-12 ~3:05pm CT CLAUDE — r3: keyless Polymarket prediction-market context)

Round 3 slice (implementable subset of the social-sentiment lesson: real-money crowd odds as LLM
context; Reddit/X stay OUT of scope, blocked on owner API keys).  New `src/lib/polymarket-provider.ts`
— keyless (no credential ever created/held), hits `gamma-api.polymarket.com/public-search`
(live-verified shape in the file header), matches markets to a symbol via the existing
`scoreHeadlineRelevance` rubric (`news-relevance.ts`, incl. the ambiguous-company-name
corroboration gate), keeps up to 3 currently-active company-relevant markets per symbol
(question/implied probability/volume), 10-minute in-process cache, bounded per-run symbol count,
fails open to no-data on any error.  Wired into `strategy.ts`'s `proposeTrades` at the same seam
`prompt-headlines.ts` and `getUpcomingEconomicEventsForPrompt` use — prompt-time only (candidates
entering the LLM call), never the scan-wide enrichment cascade, so it never fires on a
budget/threshold-skipped run.  New `MarketQuote.polymarketLines`; new catalog knobs
`POLYMARKET_CONTEXT` (default true) / `POLYMARKET_MIN_RELEVANCE` (default 0.5).  Dependency-health
and evidence-pack-family both investigated and found to need ZERO new registration (health map is
derived dynamically from logged calls; the new prompt field nests inside the existing "market"
family evidence ref) — see the rollout note.  Gates: tsc clean; 18 new tests
(`test/polymarket-provider.test.ts`) + 29 adjacent-seam tests green; lint 0 errors on touched
files.  Rollout: docs/rollouts/2026-08-12-r3-polymarket-context.md.  Local slice commit on
`agent/claude`; lands via the round-3 integration lane.  Blockers: none.

## Current (2026-08-12 ~2:10pm CT CLAUDE — r3: truncated-replay lookahead audit)

Round 3 slice (freqtrade lookahead-analysis port, scoped per the gap analysis to the two
genuinely reconstructable subsystems).  New `src/lib/lookahead-audit.ts` (pure/IO split mirroring
backtest.ts) + `db-lookahead-audit.ts` (migration 75, `lookahead_audit_findings`, deletion-covered):
a weekly durable per-user due-job samples matured `signal_snapshot` decisions past a watermark,
recomputes the momentum/liquidity factor sub-scores from daily OHLC truncated to each decision
date (through the existing pure `scoreFactors`, mirroring decision-time field availability via
per-field `sources` provenance), and replays RAG evidence by rebuilding the deterministic filings
query (now shared via `deterministicFilingsRetrievalQuery`; queryHash-guarded so builder drift
degrades to honest 'unverifiable') with asOf pinned + strictAsOf, diffing chunk ids against the
persisted candidate-pool `used:true` rows — Jaccard threshold for benign reranker drift, ANY
post-asOf chunk a hard mismatch.  value/quality/volatility/sentiment/positioning/diversification
are ALWAYS 'unverifiable' with stored backtestSafety receipts (the coverage gap is visible, never
silently implied clean); below 20 qualifying observations the aggregate verdict is an honest
'insufficient_sample'.  Advisory `lookahead_leak` notification fires on mismatch classifications
only; compact con-* receipts panel on Results.  `LOOKAHEAD_AUDIT_*` knobs (default ON, documented
kill switch in .env.example).  Gates: tsc clean; test/lookahead-audit.test.ts 17/17;
persistence-hardening + account-deletion-coverage updated for v75 (25/25); adjacent suites 99/99.
Rollout: docs/rollouts/2026-08-12-r3-lookahead-audit.md.  Local slice commit on `agent/claude`;
lands via the round-3 integration lane.  Blockers: none.

## Current (2026-08-12 ~1:15pm CT CLAUDE — r3: unified ProposalScorecard)

Round 3 slice (dsa Dashboard-contract lesson): one typed, deterministic `ProposalScorecard`
unifying the decision receipts already on `TradeProposal` — core conclusion (derived from the
existing rationale, no new LLM call), MA/volume data perspective (recycled from the ATR
precompute's bars, honestly omitted when absent), sniper price levels (referencePrice + bracket
legs; secondary entry ONLY via the new `secondaryBuyPullbackPct` owner knob), an action checklist
that RENDERS already-computed gate state (entry-drift, wash-sale, daily-cap, red-team,
dataAdjustments — never a new authority), four-bucket signal attribution summing to exactly 100,
and an append-only decision chain stamped at the existing override/human-approval sites with a
persistence-time validator that receipts (never drops) malformed chains.  Outcome engine now
grades sniper stop/take levels against the daily closes it already fetches
(`outcome.sniperAccuracy`, close-basis disclosed).  Rendered collapsible on the approval card and
read-only in the decision trace.  Gates: tsc clean; targeted suites 182/182 (23 new).  Rollout:
docs/rollouts/2026-08-12-r3-proposal-scorecard.md.  Local slice commit on `agent/claude`; lands
via the round-3 integration lane.  Blockers: none.
## Current (2026-08-12 GROK — broker cascade + Webull/eToro/Public + CopyTrader intel)

**Branch `grok/broker-webull-etoro-public`:** connected brokers (Tradier / Alpaca / Robinhood)
now sit in front of paid history providers; Public + eToro gateways + Webull connect stub;
CopyTrader observe/allowlist framework (official eToro API only).  Owner must mint keys.
Rollout: `docs/rollouts/2026-08-12-broker-cascade-and-copy-intel.md`.

## Current (2026-08-12 CLAUDE - connection-health alert noise, root-caused)

Branch `claude/health-alert-noise` (worktree `/private/tmp/fx-st-health`).  Sentry carried ~28
distinct `"<name> connection failed"` issues, almost none of which were real outages.  Seven
verified causes fixed together, kept individually reviewable in the diff:

1. **Streak gate** - the alert gated on `lane.stoppedWorking`, which is ALSO set by two soft
   heuristics that a low-frequency lane's FIRST failure satisfies.  Now requires the hard
   `HEALTH_REASON_CONSECUTIVE_FAILURES` streak.
2. **Fingerprints** - pinned to stable lane ids so display-name drift stops fragmenting one lane
   into six issues.
3. **429 asymmetry** - RAG 429s now skip Sentry the way db-health always did; `alertUsageLimitHit`
   escalation intact.
4. **Re-probe loop** - all synthetic probe failures log soft, breaking alert -> 6h cooldown ->
   re-probe forever.
5. **Retired vendors** - FMP / Quiver / UW excluded from the alert path.
6. **Timeouts** - usage-monitor budget + knobs reads 2500ms -> 8000ms and soft-logged (both are
   fail-open).
7. **Local-fault mislabel** - `storeContexts` receipt/finalize SQLite faults attributed via a new
   cause-chain-walking `localDbFaultReason` instead of "RAG vector store failed".

congress.trade 502s (SOCRATIC-TRADE-B/8/1P) and the filingapi 401 (SOCRATIC-TRADE-1G) confirmed
still alerting, with explicit regression guards.  Rollout:
`docs/rollouts/2026-08-12-health-alert-noise.md`.
## Current (2026-08-12 CLAUDE — CI scripts: Sentry `app` tag + branchless fingerprint, effort-sync transport retry)

Two python-only CI-support fixes on branch `claude/ci-report-app-tag`
(worktree `/private/tmp/fx-st-ci`):

1. `scripts/sentry-ci-report.py` had no app identifier, so ST's events in the
   SHARED `fleet-infra` Sentry project deduped into Congress.Trade's
   identically-named workflow issues ("CI", "Security", "Effort Issues Sync").
   Adds `APP = "socratic-trade"` to the message, tags, and fingerprint.
   Fingerprint is now `[ci-failure, app, workflow]` — branch is a tag only,
   because merge-queue refs are unique per attempt and were minting a throwaway
   Sentry issue per queued run.
2. `scripts/sync-effort-issues.py` `http_request` caught only `HTTPError`, so
   today's `SSL: CERTIFICATE_VERIFY_FAILED` reaching api.github.com killed the
   whole run.  Adds bounded exponential-backoff transport retry for idempotent
   methods only — a `POST` is never replayed, since a truncated create response
   means the issue already exists and a retry would duplicate it.

Crons `monitor_slug` deliberately left un-namespaced: renaming orphans live
Sentry monitors, and there is no collision to fix.  Gates and a 15-check
behavioral harness recorded in the rollout note.

Rollout: `docs/rollouts/2026-08-12-ci-report-app-tag.md`.

## Current (2026-08-12 GROK — iOS watchlist wrap + account switch + admin + P&L)

Owner Assets screenshot + follow-up.  Four bugs on one branch
`grok/ios-watchlist-chip-wrap` (worktree `~/apps/trading-grok-watchlist-chips`):

1. Watchlist chips wrap mid-ticker — content-sized `WrappingHStack` (#2657).
2. Use-account looks dead, then snaps — keep Switching pill until snapshot.
3. Tradier Sandbox `$0` P&L — unrealized from positions; realized "—" without fills.
4. Admin Portal stuck — loading UI, cookie timeout, same-host subframe allow.
5. Alpaca Paper "won't switch" — activate now invalidates the dashboard snapshot cache.

Rollout: `docs/rollouts/2026-08-12-ios-watchlist-chip-wrap.md`.

## Current (2026-08-12 ~7:30am CT CLAUDE — external-repo lessons round 2: alpha grading, signal health, cancel-dust)

Round 2 of the owner's external-repo lessons request (broad sweep: TradingAgents, ai-hedge-fund,
freqtrade, qlib, RD-Agent, FinMem).  Three definitive wins land in this PR, each built by a
dedicated agent, adversarially verified, and integration-fixed:

1. **Opt-in benchmark-alpha outcome grading** (`policy.outcomeGradingMode`, default raw,
   byte-identical): alpha mode grades decisions against SPY over the same window, cites alpha in
   the post-mortem prompt, writes divergence receipts (raw won / alpha lost = beta-not-skill),
   and keeps an :alpha stat ledger in retrieval-usefulness weighting.
2. **Live signal-health monitor**: daily lane computing rank IC of the LLM's own confidence vs
   matured outcomes (90-day window), quantile buckets, top-K churn, gross-vs-net; edge-triggered
   drift alarms via notify(); optional auto-throttle knob (default OFF); Signal Health card on
   Results (migration 74 — first migration shipping under the new BEGIN IMMEDIATE boot path).
3. **Cancel-dust advisory** (advisory ONLY, never blocks): partial-fill cancels that would
   strand a below-broker-minimum fragment warn in the cancel sheet + audit; pre-fetch is
   time-bounded so the emergency cancel lever can never wait on a hung broker read.

Gates: tsc clean, targeted suites 82/82; full lint/test/build via land.sh at push.  Rollout:
docs/rollouts/2026-08-12-external-lessons-round2.md.  Blockers: none.
## Current (2026-08-12 ~6:40am CT CLAUDE — HOTFIX: boot migrations vs rolling deploys)

PR #2652's auto-deploy failed (deployment pyqxv16i): the incoming container crash-looped on
SQLITE_BUSY loading the instrumentation hook and Coolify rolled back (prod stayed up on the old
build).  Root cause: runMigrations used better-sqlite3's default DEFERRED transaction — under a
rolling deploy the outgoing container commits continuously, and the WAL snapshot upgrade throws
an instant SQLITE_BUSY that busy_timeout does not cover.  Fix: apply migrations via BEGIN
IMMEDIATE (apply.immediate()) so the 60s busy_timeout works; new child-process contention
regression test.  This PR's own deploy applying migration 72 is the live proof.  Blockers: none.

## Current (2026-08-12 ~6:20am CT CLAUDE — symbol drawer everywhere + iOS fills redesign)

Owner requests: ticker/logo clicks open the Market Scan company drawer on every surface
("all aspects of the site anywhere really"), and the iOS Activity fill cards get bolder/larger
text + a denser layout (screenshot critique).  Branch `claude/ui-symbol-drawer-fills`.

Web: closed every remaining un-wired symbol render (order cancel/replace sheets, live-approve
sheets, decisions rows via a stretched-link restructure, admin data-catalog + rag-coverage with
SymbolDrawerProvider newly mounted in the admin layout).  Fixed a real crash the sweep exposed:
SymbolDrilldownSheet's unconditional useConsoleData() throw outside the console shell — new
useConsoleDataOptional(), with an honest "not available here" exposure state.  Mobile PWA
deferred honestly (drawer depends on con-* tokens the PWA does not load).

iOS: FillActivityRow/CommandActivityRow typography bumped (ticker title3 bold, notional title3
semibold, date footnote) with tighter AppCard padding; new SymbolInfoSheet (same /api/quote
cascade as the web drawer) tappable from fills, positions, orders, watchlist, flow chips,
alerts, and proposals; 44pt remove target restored; derived marketCap removed (no fabrication).

Verified: tsc/lint/targeted vitest green; xcodebuild green (incl. post-merge with #2647 tabs +
parity wave); browser check — AAPL click opens the "AAPL details" con-drawer with live data;
admin routes 200.  Rollout: docs/rollouts/2026-08-12-ui-symbol-drawer-fills.md.  Blockers: none.

## Current (2026-08-12 ~5:40am CT CLAUDE — dsa-lessons round 1: digest, relevance, receipts)

Owner asked for lessons from ZhuLinsen/daily_stock_analysis (62k-star LLM stock-analysis repo),
then broadened to a moderately broad GitHub sweep.  Research ran as two 15-agent workflows
(readers -> synthesis -> per-lesson gap analysts); full verdicts + sketches in
`docs/reviews/2026-08-12-dsa-lessons-gap-analysis.md`.  This lane (branch `agent/claude`) lands
round 1 — three implemented lessons, each built + adversarially verified + integration-fixed:

1. **Opt-in daily watchlist digest** (default OFF; Settings -> Delivery): typed report context
   (latest persisted scan quote + proposal trajectory per symbol) -> full/medium/brief renderers ->
   notify() `bodyTiers` picking the largest tier per channel via new `CHANNEL_CAPABILITIES`
   (also retires the latent pushover/ntfy truncation gap).  New `trade_proposals.symbol` column
   + index (migration + backfill).  Fires once per CT day at/after 15:15 CT via a watermark lane.
2. **News entity-relevance gating** (default ON, real off-switch via `NEWS_RELEVANCE_*` knobs):
   AV `relevance_score` and Marketaux `match_score` were documented-but-discarded — now parsed and
   gated (match_score normalized /100 — it was ~12-82, making the 0-1 knob inert until the
   integration fix); leaf rubric `news-relevance.ts` with ambiguous-company-name corroboration;
   stream path drops only zero-evidence associations on multi-symbol articles.
3. **Proposal repair-ladder receipts** (money-path, surgical): `TradeProposal.dataAdjustments`
   kind-prefixed receipts; deterministic session-vs-phrasing guard (never blocks/rewrites);
   `confidenceCapDataDegraded` tuning knob; existing bracket-fallback disclosures now also write
   receipts; approval card renders them.

Gates: lint 0 errors; tsc clean; targeted suites 76/76; full test+build via land.sh at push.
Next: round-2 implementation (benchmark-alpha grading, signal-health monitor, cancel-dust
advisory) on this lane after merge; UI lane (`claude/ui-symbol-drawer-fills`) lands separately.
Blockers: none.

## Current (2026-08-12 MONET — iOS parity wave 1: decision-critical fields, protective controls, swipe actions, admin portal)

**Branch `monet/ios-parity-wave1`** (stacked on `monet/ios-customizable-tabs`, PR #2647): First
wave of the iOS parity roadmap — all zero-backend, rendering already-decoded snapshot data and
dispatching existing command types.  (1) Proposal cards now show price drift (reference → current
price with signed %), last revalidation time, and the Red Team failure kind when the verdict is
unavailable (console `describeRedTeamFailureKind` wording).  (2) Home gains Close Only + Wind Down
protective controls beside Stop (`strategy.close_only` / `strategy.liquidating`, same
CommandButton/store.submit pattern, no added ceremony).  (3) `policy.runDuringExtendedHours` is now
decoded and a pure `deriveRunStateWord` mirrors the console's `deriveStateInfo` vocabulary — the
app can no longer say "Running" while the console says "Paused · market closed" (7 new XCTests).
(4) Swipe-to-reject on proposal cards (reject ONLY, never approve) and swipe-to-delete on alert
rows via a new ScrollView-compatible `swipeRevealAction`; watchlist swipe skipped (chip grid, not
rows — one-tap remove already exists).  (5) Triggered alerts show `triggeredAt`/`triggeredPrice`.
(6) Account sheet rows show capabilities + draining state.  (7) New `AdminPortalView` (admin-only
row) hosts /admin in a navigation-fenced WKWebView with native-session cookie handoff.  28/28
tests pass.  Rollout: `docs/rollouts/2026-08-12-ios-parity-wave1.md`.

## Current (2026-08-12 MONET — iOS customizable tab bar + xcodegen version-regression root cause)

**Branch `monet/ios-customizable-tabs`:** The iOS app's tab bar is now owner-customizable with
the exact web mobile-tabs semantics (`app/console/lib/mobile-tabs.ts` parity: pin/unpin, min 2 /
max 4, canonical-order bar, always-present More surface keeping every screen reachable), using
the native system `TabView` so the Liquid Glass appearance is preserved.  Programmatic tab jumps
to unpinned screens reroute into the More stack.  8 new XCTests pin the contract.  Along the
way, found and killed the ROOT CAUSE of the 2026-08-11 version regression: `xcodegen generate`
was rewriting Info.plist's version keys to literal `1.0`/`1` because `project.yml` never
declared them — now declared as `$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)` so any
future regen preserves substitution.  A parallel expert-panel workflow is reviewing web↔iOS
parity and reports separately.  Rollout: `docs/rollouts/2026-08-12-ios-customizable-tabs.md`.

## Current (2026-08-11 MONET — litestream per-tier backup status: health check + admin panel)

**Branch `monet/backup-status-panel` (committed locally, not pushed — see rollout note for why).**
Tonight's litestream incident (stuck level-1 B2 compaction anchor, silently wedged 27+ hours —
see the escalation trail above and `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`)
exposed a real gap: `checks.storage.litestream*` on `/api/health` only ever observes level 0
(continuous sync) via the IPC socket, so it would NOT have caught this. Added: (1)
`assessLitestreamTierFreshness()` in `src/lib/runtime-health.ts` — per-compaction-level (0/1/9)
freshness via local `ltx/<level>/` file mtimes, with documented thresholds (10min/4h/30h) and a
graceful "unknown" state everywhere litestream isn't configured this way; (2) wired additively
into `checks.storage.litestreamTiers` on `/api/health` (existing fields untouched) + folds into
`storageDegraded` + per-tier `alertStorageWarning`; (3) new admin panel `app/admin/backups/` (nav
entry "Backup Status") showing Continuous Sync / Compaction / Daily Snapshot per-tier health,
backed by new admin route `app/api/admin/backup-status/route.ts`; (4) tests in
`test/runtime-health.test.ts` (unit), `test/connection-health-routing.test.ts` (integration,
reproduces the exact incident shape against the real route), `test/backup-status-route.test.ts`
(new, admin route). `npx tsc --noEmit` clean, `npm run lint` 0 errors, targeted vitest run (57
tests across the 4 touched/related files) green. Full `npm test`/`npm run build` run before
commit — see the rollout note for final counts. Does NOT fix the underlying stuck B2 anchor
itself (that's separate ops work, still open). Rollout:
`docs/rollouts/2026-08-11-litestream-tier-backup-status.md`.
## Current (2026-08-11 ANTIGRAVITY — Desktop Web & Mobile PWA UX Enhancements)

**Branch `ag/desktop-mobile-ux-enhancements`:**
1. **Desktop Web UX**:
   - `command-palette.tsx`: Added global hotkeys (`Cmd+K`/`Ctrl+K` command palette toggle, `A` Proposals jump, `R` strategy run-once dispatch, `1-6` tab navigation). Added `<kbd>` badges and `action:run-once` command item.
   - `approval-card-skeleton.tsx` & `portfolio-overview-skeleton.tsx`: Created animated pulse skeleton loading components matching approval cards and portfolio overview metrics.
   - `console.css`: Synchronized `.dark` design token values with `app/globals.css`.
2. **Mobile Web PWA UX**:
   - Refactored `mobile-pwa-client.tsx` into modular components under `app/mobile/components/` (`MobileHeader.tsx`, `MobileNavBar.tsx`, `MobileHomeTab.tsx`, `MobileProposalsTab.tsx`).
   - Implemented `usePreventScrollChaining` hook for WebKit boundary top check (`scrollTop === 0` set to `1`) and CSS `overscroll-behavior-y: contain` to prevent iOS Safari body scroll chaining.
3. **Verification**: `npx tsc --noEmit` clean, `npm run lint` clean (0 errors), `npm test` (83 files / 739 tests passed), `npm run build` clean.

## Current (2026-08-12 ~12:20am CT MONET — new app icon: dollar-sign candlesticks)

Owner supplied a reference image (3D-rendered candlesticks arranged as a "$", green/pink
palette, light gray grid background) and asked for it as the app icon with a lightened
background. Replaced `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
(previously a "ST" wordmark built from candlesticks) with a processed version of the owner's
image: background lightened via a saturation-based blend (candlestick colors untouched, smooth
ramp rather than a hard threshold to avoid speckling in the soft-shadow areas), resized to the
required 1024x1024, confirmed opaque RGB (no alpha — required for App Store icons). Single-file
change, no other icon sizes to update (this appiconset uses Xcode's unified single-size format).
## Current (2026-08-12 ~12:08am CT MONET — litestream reset executed; leak appears resolved, monitoring continues)

Escalation trigger from the previous entry fired (kill gap compressed to 5m35s). Owner approved
proceeding. Executed the previously-planned fix: `docker stop` (clean, 30s), cleared the local
litestream LTX metadata directly on the host volume path (`litestream reset`'s documented effect
— never touches the DB file or B2), Coolify `start` (image reused, no rebuild). ~6 min outage.
Post-restart: litestream started with zero errors (previously every fresh start hit a checksum
mismatch within 2-3 min, without exception), memory at 374MiB ~4 min in (previous fresh starts
were multi-GB by this point). Strong early signal, NOT yet confirmed as fixed — several hours of
clean operation spanning a level-9 snapshot cycle is the real bar. Full detail + what to check if
it recurs: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` ("Fix executed" section,
bottom).

## Current (2026-08-11 MONET — iOS version regression fix)

PR #2637 accidentally hardcoded `ios/SocraticTrade/Info.plist`'s `CFBundleShortVersionString`
to the literal `"1.0"` and `CFBundleVersion` to `"1"`, replacing what used to be
`$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)` build-variable substitution. This silently
broke the owner's version regimen (App Store "Version" goes 1.0.0 -> 1.0.1 -> 1.0.2 per release,
separate from the internal build number): bumping `MARKETING_VERSION` in the Xcode project would
no longer have actually changed what ships. Restored both fields to variable-substitution form
and set `MARKETING_VERSION`=1.0.1 / `CURRENT_PROJECT_VERSION`=2 in both `project.pbxproj`
(Debug+Release) and `project.yml` — this is the first build after 1.0.0/1.0 already shipped to
TestFlight. `preferredProjectObjectVersion`/`TARGETED_DEVICE_FAMILY` from #2637 left untouched
(legitimate fixes, not part of this regression). Rollout:
`docs/rollouts/2026-08-11-ios-version-regimen-fix.md`.

## Current (2026-08-11 ANTIGRAVITY — System Audit & iOS Resiliency Rollout)

**Branch `agent/antigravity-review`:** Top-to-bottom audit across Desktop Web, Mobile Web (PWA), iOS App (SwiftUI), Backend Pipelines (SEC EDGAR ingest, RAG vector engine), Database Concurrency, Latency Monitoring, and Competitor Benchmarking. Artifact `implementation_plan.md` created; review note `[ST, Antigravity] Comprehensive System Audit & Improvements` created and pinned in Apple Notes (folder `Coding`). Native iOS client updated with exponential backoff retry loop (`MobileAPIClient.swift`) and raw JSON disk caching (`MobileStore.swift`) for instant `<50ms` offline startup. All gates verified green (Xcode build, tsc, lint, vitest). Rollout: `docs/rollouts/2026-08-11-system-audit-and-ios-resiliency.md`.

## Current (2026-08-11 ~9:40am CT MONET — litestream kill cadence ACCELERATING: 51→78→49→20→19 min gaps)

Since the root-cause deploy below, 6 more OOM kills logged (all `exitCode=137`, all auto-recovered
in ~1s, site health unaffected each time). The gap between kills has compressed from ~50-80 min
down to ~19-20 min over the last 3 cycles — consistent with the confirmed root cause (the stuck B2
compaction anchor persists in the replica's own state across restarts, so un-compacted WAL keeps
growing across the whole incident, not per-container). **Escalation trigger set:** if the gap
compresses under ~10 minutes, stop deferring to "daylight" and actively clear the stuck B2
generation now (see next steps in the rollout note) regardless of local time. Full timeline +
reasoning: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` (escalation section,
bottom).

## Current (2026-08-11 ~4:30am CT MONET — litestream leak root cause CONFIRMED, not yet fixed)

The all-night litestream OOM-leak (open since 2026-08-09) has a confirmed root cause now, not
just a hypothesis: litestream's B2 replica is stuck compacting from txid `2324d` — every retry's
multipart upload fails with `file checksum mismatch` on close (~every 100s), the anchor never
advances, so each retry re-uploads a larger accumulated range, which is why memory climbs and why
peak-per-kill severity keeps growing (2.05→4.82GB across 9 kills so far). No existing kill-switch
applies (the only one is R2-specific and explicitly no-ops on B2). Site serving health remains
unaffected throughout (Docker `restart: unless-stopped` recovers every crash in seconds) — this
is not an outage, but the leak itself remains open. Full evidence + next steps for daylight fix:
`docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` (root-cause section, bottom).

## Current (2026-08-10 GROK — default light theme)

Branch `grok/default-light-theme`: light is product default (web + iOS). Dark only via explicit choice. Rollout: `docs/rollouts/2026-08-10-default-light-theme.md`.

## Prior

## Current (2026-08-10 GROK — iOS invalid SF Symbol)
## Current (2026-08-11 MONET — server-metrics panel repair + canonical Oracle→Hetzner doc correction)

**No branch (config + docs, direct on `main` — repo-side changes on `monet/*`, see below):**
ST's admin server-stats panel was fully broken (`degraded: true, stale: true`, Coolify 401 +
Hetzner 404×2) because `AGENTS.md`/`CLAUDE.md` — and therefore this session's own initial
answer to the owner — had never caught up with the 2026-08-07 emergency cutover off Oracle Cloud
(Oracle suspended the account without reason, `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`)
to a brand-new Hetzner box (`docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`). Three stale
values found and corrected: `HETZNER_SERVER_ID` (wrong box) and `COOLIFY_SERVER_UUID` (wrong
UUID) in ST's Infisical, plus a dead 401 `COOLIFY_SERVER_STATS` token in BOTH ST's Infisical and
the `~/.secrets/global-api-keys.env` handoff file (fixed from the box's own dedicated, working,
read-only-scoped token at `/root/.coolify-api-token-stats` — deliberately did NOT substitute the
broader `COOLIFY_AGENTS` token, preserving the read-only/admin scope separation). Panel verified
fully live post-fix: `degraded: false, stale: false, cacheAgeSeconds: 0`, real resources
(`socratic-app`, `congress-trade`, `usage-monitor`). `AGENTS.md`'s hosting section rewritten to
lead with the real current host: `167.233.254.55` / `fleet-hetzner-nbg1` / Hetzner `cx43` (8 vCPU
AMD EPYC-Rome, 16 GB RAM, 160 GB NVMe) / Coolify server UUID `jxzqcs3h6g1wiipnnblhismp` / Hetzner
hardware serial `159792099`. UM's own panel not independently re-verified (no admin credential
available this session) — UM's hardcoded fallback defaults already match the correct live
values, so it should work unless UM's own Infisical has a stale explicit override. Rollout:
`docs/rollouts/2026-08-11-server-metrics-panel-hetzner-config-repair.md`.

## Prior (2026-08-10 GROK — iOS invalid SF Symbol)

**Branch `grok/ios-bell-badge-symbol`:** Assets toolbar used nonexistent SF Symbol
`bell.badge.plus` (console: `No symbol named 'bell.badge.plus' found in system
symbol set` — blank create-alert icon). Replaced with valid `bell.badge`. Rest of
the owner’s console dump (QUIC / `nw_connection_*` / PointerUI / “cannot add
handler”) is system noise. Rollout:
`docs/rollouts/2026-08-10-ios-invalid-sf-symbol-bell-badge.md`.

## Prior (2026-08-10 ~2:00am CT GROK — unstick open PR #2597)

**Only open PR after #2603 merged:** #2597 `grok/always-auto-merge-prs` — fleet policy always-auto-merge for non-draft same-repo PRs + `do-not-automerge` hold. Blockers fixed this pass: real `AGENTS.md` conflict (kept main's Apple Notes close-out), `sentry-ci-report.yml` missing the new workflow name (failed `test/sentry-ci-report-workflows.test.ts`), Codex P1s (disable auto on hold label; `GH_PAT`/`SHEPHERD_TOKEN` preferred so post-merge workflows fire; squash-only; fail when arming fails). Next: green `verify` → auto-merge → Coolify auto-deploy. Rollout: `docs/rollouts/2026-08-10-always-auto-merge-prs.md`.

## Prior (2026-08-09 ~11:45pm CT MONET — event-loop stall instrumentation)

**Branch `monet/sec-worker-edgar-403` (stacked):** Uptime Robot incidents on socratictrade.com — next-server pins 100%+ CPU 11-85s during filing ingests (event loop held by synchronous extract/chunk/score segments chained by the trial knobs). Shipped warn-only timeSync wrappers (extractFilingText / tradeHighlightChunksFromText / chunkDocument) + yieldEventLoop between filings/tasks. Prod names the hot spot in [slow-sync] logs; targeted fix follows. OpenRouter credits $55.50/$165 left (decision traffic, not embeds). Rollout: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`.

## Prior (2026-08-09 MONET — EDGAR 403 worker hardening)
## Current (2026-08-09 MONET — EDGAR 403 worker hardening)

**Branch `monet/sec-worker-edgar-403`:** minutes after the trial knobs + full-universe seed went
live, every SEC ingest worker fetch 403'd (`www.sec.gov/Archives`), dead-lettering ~50 tasks.
Root causes: worker fetched with NO User-Agent (SEC hard-403s undeclared tools; the refresh lane
passes UA explicitly and kept working), prod lacked `SEC_EDGAR_USER_AGENT` (now set in Infisical),
secLimiter only reacted to 429 (SEC signals blocks with 403), and the worker burned stage attempts
into an IP-level block. Fixes: UA auto-injection for `.sec.gov` in `politeFetch`; `report403()`
global cooldown (`SEC_403_COOLDOWN_SECONDS`, default 600s) + `pausedUntilIso()`; worker defers
(attempt refunded, `edgar_403_deferred`) instead of failing; `requeueSecIngestDeadLetters` + admin
`{action:"requeue-dead-letter"}`. 35 tests green incl. 2 new; tsc clean. Post-deploy: requeue
dead letters, watch checkpoints advance. Rollout:
`docs/rollouts/2026-08-09-edgar-403-worker-hardening.md`.

## Prior (2026-08-09 MONET — trial knobs LIVE in prod + EDGAR shard-field fix)
## Current (2026-08-09 MONET — trial knobs LIVE in prod + EDGAR shard-field fix)

**Branch `monet/sec-shard-field-fix`:** the trial knob set from the throughput audit is now
APPLIED in prod (Infisical + Coolify restart; all 7 values verified in the serving process env):
delay 0ms, batch 32, texts/day 250k, WU/day 2.5M, SEC per-run 200, TTL 6h, ingest worker ON.
`data/rag-universe-manifest.json` copied onto the prod data volume (the `/app/data` volume mount
shadows the image's `data/`, so the seeder 500'd ENOENT). First full-universe seed then exposed a
real bug: `SubmissionsJson.filings.files[]` used invented field names `filingStart/filingEnd`;
real EDGAR shards carry `filingFrom/filingTo`, so the shard-pagination sort threw
`undefined.localeCompare` and aborted the seed (test fixture had the same wrong names — suite
green, prod broken). Fixed with real names + `?? ""` guard. Re-seed after this deploys. Rollout:
`docs/rollouts/2026-08-09-trial-knobs-applied-and-edgar-shard-fix.md`. Next: re-run seed, watch
`GET /api/admin/sec-ingest` receipts + `rag_usage` daily volume (expect ~4k → 100k+ records/day).

## Prior (2026-08-09 MONET — Pinecone trial throughput audit + monthly WU pace guard)

**Branch `monet/pinecone-trial-maximize` (commit-only; landing operator lands):** owner wants the
Pinecone Standard trial used close to full extent, then a drop to free/$20 without a repeat of the
hourly-429 mess. (A) Throughput audit — every ingest limiter inventoried with TRIAL vs AFTER values
for the owner to apply in Infisical (no secrets read/written). Headline: `VECTOR_EMBED_BATCH_DELAY_MS`
(default 21s, a Voyage-3-RPM artifact) is applied unconditionally between embed batches and pins
ingest at ~1,371 chunks/h even on OpenRouter bge-m3 — the single biggest lever. OpenRouter embed
spend is NOT the constraint (~$0.0013 per 1k chunks); post-trial Pinecone STORAGE is. (B) New
`src/lib/pinecone-monthly-pace.ts` — persisted calendar-month WU counter (fed from
`meterPineconeUpsert`, resets on month roll), linear month-end projection with a 0.2 elapsed floor
(mirrors `r2-usage.ts`), `PINECONE_MONTHLY_WU_BUDGET` default 0 = OFF. When projected pace exceeds
the budget the SEC ingest **backfill queue** stops claiming new tasks; incremental filing ingest and
all retrieval are structurally un-gated. ONE advisory + audit per calendar month. Number exposed at
`/api/admin/rag-coverage` → `providerUsage.pinecone.monthlyWriteUnitPace` even when off. Gates: tsc
clean; 12 test files / 162 tests green (new `test/pinecone-monthly-pace.test.ts` 10/10); lint 0
errors. Rollout: `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md`.
## Current (2026-08-09 MONET — "Pinecone connection failed / database is locked" mislabel)

**Branch `monet/pinecone-lock-mislabel` (commit-only; landing operator lands):** the hourly
owner-visible push titled "Pinecone connection failed" with body `inventory fetch: database is
locked` was OUR SQLite, not Pinecone. Root cause: `settleProviderDispatch`
(`src/lib/db-provider-dispatch.ts`) opened a DEFERRED transaction that SELECTs before it UPDATEs,
so promoting the WAL read snapshot to a write returns `SQLITE_BUSY_SNAPSHOT` ("database is
locked") instantly WITHOUT consulting `busy_timeout` — which is why the 60s ceiling never absorbed
it; every ledger transaction now opens `BEGIN IMMEDIATE` (repro receipts in the rollout note).
Second fix: new `src/lib/local-db-fault.ts` classifies local-SQLite failure signatures, and
`withRagApiHealth` no longer writes a provider failure row or a `provider_degraded` push for them —
it records a `local_db_contention` audit row and, past 5 occurrences in 6h, ONE advisory titled
"Storage Warning: local database contention" (never a vendor name); `alertConnectionFailure` gets
the same guard for non-RAG lanes. Real Pinecone HTTP/network errors behave exactly as before.
Gates: tsc clean; 22 test files / 236 tests green (new `test/local-db-fault-classification.test.ts`
7/7, both new assertions verified to fail without the fix); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-pinecone-lock-mislabel.md`.

## Current (2026-08-09 MONET — durable embed stage: embed-once guarantee)

**Branch `monet/embed-stage` (stacked on `monet/pinecone-wu-breaker` / PR #2596; commit-only —
landing operator lands):** owner directive — a paid OpenRouter document embedding must never be
paid for twice. New SQLite `embed_stage` table (durable L2 under the process-local L1 cache):
`storeContextsImpl` persists each paid vector (Float32 BLOB, keyed
content_hash-of-embed-input + model + embed-rev) AFTER provider validation and BEFORE the
Pinecone upsert; upsert success deletes the rows (managed commits defer to after
markCommitted); upsert failure keeps them and every retry path replays them with ZERO provider
calls — durable across restarts. WU-breaker gate still blocks everything (incl. stage-consume)
until it lifts; stage replays on resume. Retention: 35d orphan sweep + 2 GiB oldest-first cap in
the daily audit-prune lane. Receipts: `embed_stage_replay` audit (embeds avoided per store call),
`embedsFromStage` on results + lastIngest. Gates: tsc clean; 33 test files / 376 tests green
(incl. new `test/embed-stage.test.ts` 11/11); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-embed-stage.md`.

## Current (2026-08-09 MONET — Pinecone monthly WU exhaustion breaker)

**Branch `monet/pinecone-wu-breaker` (commit-only; landing operator lands):** prod Pinecone
upserts 429 hourly on the exhausted 2M/month write-unit quota (10-K backfill), re-embedding
the same docs through paid OpenRouter every cycle. New breaker: detection in
`withRagApiHealth` trips a marker (`pinecone:wuExhaustedUntil` = 1st of next month UTC,
ONE storage_warning + audit, health row soft `[expected-limit]`), early gate in
`storeContexts`/`storeDocument` refuses writes BEFORE any embed spend
(`wuExhausted` typed skip, ≤1 audit/day), sec_ingest tasks park cleanly via new
`deferSecIngestTask` (retry_wait at marker expiry, stage attempt refunded — no retry storm
or dead-letter), sec-filings bulk loop stops at the first gated filing. Auto-clears on
expiry AND on any successful Pinecone write (plan upgrade); Connections pinecone lane shows
yellow `LIMIT` "monthly write units exhausted · resumes <date>" instead of red STOPPED.
Gates: tsc clean; 16 test files / 201 tests green (incl. new
`test/pinecone-wu-breaker.test.ts`, 9 tests); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-pinecone-wu-breaker.md`.

## Current (2026-08-07 GROK — Litestream → Backblaze B2)

**Active SQLite backup target is Backblaze B2** (`jays-socratic-trade-eu`, eu-central-003).
Infisical ST prod `AWS_*` repointed to scoped key `fleet-socratic-backup`; prior R2
credentials preserved as `AWS_R2_HISTORIC_*` (R2 objects left in place — historic).
Code: `litestream.coolify.yml` (force-path-style, 7d retention, 60s sync); R2 free-tier
kill-switch no longer pauses litestream when endpoint is B2. Host spare forensic
`app.db.*` copies pruned after integrity_check=ok. Branch `grok/litestream-b2-backup`.
Rollout: `docs/rollouts/2026-08-07-litestream-b2-backup.md`.
# Status

## Current (2026-08-08 MONET — review-fix wave E: owner mobile punch list)

**Branch `monet/review-fixes-e` (isolated worktree, commit-only — landing operator lands):**
owner iPhone-Safari punch list. New owner-wide `SENTENCE_GAP` (NBSP+space) sentence separator
applied to this wave's copy; Proposals empty state merged to one paragraph naming the ⚡
lightning Run-once button; Orders header de-chipped (env + account chips duplicated the top
banner) with Refresh on the h1 row and a merged intro; mobile tab bar restored to
`bottom:0` + env(safe-area-inset-bottom) only (the 2026-08-05 chrome-gap shift itself hid the
labels under Safari's URL chrome and its ≥48px underlay was the grey buffer — reverted);
Positions weight is now the UNSIGNED share of gross exposure (kills "-0.0%" short artifacts;
fmtPct never renders negative zero); Orders LAST PRICE gains a durable `symbol_field_latest`
final fallback (`orderPriceFallbacks` on the snapshot, age-tagged "· 23h old") and the mobile
card label is one-line "Last". Gates: tsc clean; 12 test files / 161 tests green; lint 0
errors. Rollout: `docs/rollouts/2026-08-08-review-fixes-e-mobile-punchlist.md`.

## Current (2026-08-08 MONET — review-fixes wave D: mobile #2559 #2551)

**PWA Market metric now renders the real session** (type drift `{label,isOpen}` → raw
`"closed"|"regular"|"pre"|"post"` token, capitalized like iOS), **iOS stream indicator
turns green on `: ping` heartbeats** (`events(onConnect:onEvent:)`), and **PWA proposal
cards get the console Wave-A2 collapsed receipt** (2–3 line thesis with [Sizing]/[Risk]/
[Stale quote] blocks stripped; "Show full reasoning" expands to full text; approve/reject
untouched). Branch `monet/review-fixes-d` (IN PR — landing operator runs full gate).
Rollout: `docs/rollouts/2026-08-08-mobile-review-fixes-d.md`.
## Current (2026-08-08 MONET — review-fix wave C: feed/alerts/critic)

**#2553/#2555/#2552 (branch `monet/review-fixes-c`):** ingest/embed audit kinds fold into the
activity feed's System collapse; duplicate "BUY X"/"TRADE X" sibling rows merged at derive time
(pre-insert proposalId orphans); no-op disclosure-embed audits roll up to at most one daily row;
alert center gains a single expandable "N provider lanes degraded" rollup + reversible per-condition
24h mutes ("muted N" count); critic-failure chips name the cause (model + kind, not_configured
distinct) and Results shows a critic failure rate (30d) stat. Gates: tsc clean, focused vitest
14 files / 143 tests green, lint 0 errors. Rollout:
`docs/rollouts/2026-08-08-review-fixes-c-feed-alerts-critic.md`.
## Current (2026-08-08 MONET — data-integrity fixes #2557 #2548)

**Results math stops trusting unverifiable inputs (display/aggregation only):** inferred
transfers must reconcile against their own sub-period's equity delta (else "inferred —
unverified" chip, excluded from TWR/day-P&L; kills the phantom $36.5k-withdrawal +56% TWR);
dead/stale SPY series renders a first-class "benchmark unavailable" state + advisory audit
instead of fake 0.00%; open lots are reconciled against live broker positions ("ledger
mismatch" chip; mismatched symbols excluded from wash-sale/early-exit/harvest figures with a
footnote). Branch `monet/review-fixes-b`; landing operator runs full gate + `land.sh`.
Rollout: `docs/rollouts/2026-08-08-data-integrity-flow-sanity-ledger.md`.
## Current (2026-08-08 MONET — review fixes wave A)

**Review-fixes wave A (#2547 #2549 #2554 #2556 #2562):** real `/console/decisions` index
(Home "All Decisions" no longer 404s); one shared run-state vocabulary (`StateInfo.word`)
across console chrome / Guardrails / PWA header (+ `runDuringExtendedHours` on the mobile
snapshot); unmanaged-shorts advisory banner (Home positions + Guardrails Short selling);
#2547 verified NOT a drift (v2.5.1 annotated tag == locked commit `b454ccb8`, lock-only
install zero-diff); #2562 copy/polish batch (a–n: intro-canvas theme colors + content
shield, "Deployed today" chip, feed state dedup, ••last4 mask, full-symbol logo fallback,
`--con-shadow-up` token, fs-2xs tokens, etc.). Branch `monet/review-fixes-a` (isolated
worktree; landing operator runs full gates). Rollout:
`docs/rollouts/2026-08-08-review-fixes-a.md`.

## Current (2026-08-08 MONET — weekly R2 cold snapshot)

**Weekly cold DB snapshot to the idle R2 bucket (second-provider DR):** durable due-job
(Sunday ~03:17 UTC) runs better-sqlite3 `backup()` → 100 MB-part multipart upload to
`cold-snapshots/app-<date>.db` in the `AWS_R2_HISTORIC_*` bucket, prunes to newest 4,
Class A ≥50% budget guard, silent no-op without creds. Branch `monet/r2-cold-snapshot`.
Rollout: `docs/rollouts/2026-08-08-r2-cold-snapshot.md`.

## Current (2026-08-08 GROK — settings ntfy label)

**Settings → Delivery:** first channel renamed **ntfy.sh** (was "Phone push"); removed "recommended · free" badge. Branch `grok/settings-ntfy-label`.

## Current (2026-08-07) — docs / GitHub surface refresh

**README + `docs/deployment.md` + strategic-framework + GitHub About** brought in line with
supported brokers (**Alpaca**, **Tradier**, **Robinhood**), Hetzner Coolify host, app uuid
`socratic-app`, dockerfile + auto-deploy on main, no Test-mode/local sim, fleet UI copy pointer.
Branch `grok/docs-github-refresh`.

---

## Current (2026-08-06 MONET representation-weighted model rotation)

**"__rotate__" now samples representation-weighted instead of round-robin** (owner request:
underrepresented models 2x as likely as overrepresented, which can still be picked). Weights come
from the rotation's own committed `model_rotation_pick` audits (30d window, per user/account/seat;
below-median or zero-usage = weight 2, else 1); commit-late + same-model guarantee + fail-closed
behavior unchanged; injectable RNG for deterministic tests. Branch `monet/rotation-weighted`
(committed, NOT yet pushed — landing operator runs the full gate + `land.sh`). Rollout:
`docs/rollouts/2026-08-06-rotation-representation-weighted.md`.

## Current (2026-08-06 MONET full-product review + deploy-freeze repair)
## Current (2026-08-07 GROK — iOS login brand parity)

**iOS login restyled to match website** (`app/login/page.tsx`): candlestick "SOCRATIC TRADE" wordmark (`CandleWordmarkView`, port of `candle-ticker.ts`), accent-dot value bullets, plain `--bg` surface, Google/GitHub/Apple button order and styles. PR [#2574](https://github.com/jaywedgeworth22/Socratic.Trade/pull/2574) (branch `grok/ios-login-brand`, auto-merge armed). `xcodebuild` BUILD SUCCEEDED. Rollout: `docs/rollouts/2026-08-07-ios-login-brand.md`.

## Prior (2026-08-06 MONET full-product review + deploy-freeze repair)


## Production host (2026-08-07)

**Hetzner** `167.233.254.55` (Coolify + all apps). ST live with L9 repaired DB. CT/UM live on fresh schema. See `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`.

**MONET (this seat; posts earlier today were tagged CLAUDE before the owner re-ruled the seat) ran the owner-requested full-product review** (live signed-in prod session +
12-agent workflow): findings in `docs/reviews/2026-08-06-claude-full-product-review.md`,
handoff in `docs/rollouts/2026-08-06-claude-full-product-review.md`, issues labeled
`product-review-2026-08-06`. Highest-urgency discoveries:

- **Deploy freeze (P0): all five 2026-08-06 deploys failed** — Coolify's SSH exec stream
  dies mid-build (exit 255, "disconnected by user"), correlated with CT OCR load on the
  shared box; prod sat on `6b47a886` while main advanced 4 merges. Zombie helper
  `onlrw5mgf4s2pw9he4udt2kg` (13.5h) removed; webhook redelivered; retry on a quiet box
  progressed past every earlier failure point (see rollout note for final status).
- **Litestream→R2 was PAUSED (P0)** since Aug 4 (free-tier kill-switch). **Superseded
  2026-08-07 GROK:** active replica → **Backblaze B2** (see Current header); R2 left
  historic. Cross-app R2 free-tier noise may still alert but must not stop B2 backups.
- **Results page shows +56.47% vs SPY on a flat account (P1)** — phantom inferred
  $36.5k withdrawal + SPY series silently 0.00% everywhere; and the tax open-lots ledger
  contradicts live positions (T long 91 sh vs actual short −1.881). Overlaps GROK's
  `grok/fix-account-return-pct`.
- **Two unmanaged shorts (P1)**: PG/T shorts sit unprotected because every enforcement
  layer skips shorts while `shortSellingEnabled` is off (`app/console/lib/derive.ts`).
- **Shared-package drift (P1)**: manifest pins `congress-trading-shared#v2.5.1`, lockfile
  ships 2.5.0 — the filingDate member-skill dependency is not actually deployed.

## Current (2026-08-06 GROK user source settings)
## Current (2026-08-06 GROK — iOS login 522 / Oracle host down)

**iOS Sign-In failures (Apple 522 banner; Google/GitHub CF interstitial) are a production origin outage, not OAuth wiring.** UptimeRobot + curl confirm Cloudflare **522** on socratictrade.com / congress.trade / usage.jays.services / host.jays.services; Tailscale `usage-monitor-oracle` offline; public IP no ping; OCI API keys 401 so agents cannot SOFTRESET. **Owner action: OCI Console reboot in us-phoenix-1.** Branch `grok/ios-login-522-and-anchor`: iOS 26 `ASPresentationAnchor` deprecation fix + clearer 521–523 error copy. Rollout: `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`.

## Prior (2026-08-06 GROK user source settings)

**Per-user source knobs + FMP toggles restored; plan tiers for all market-data sources (branch `grok/plan-tiers-all-sources`).** Rollouts: `docs/rollouts/2026-08-06-user-source-settings-ui.md`, `docs/rollouts/2026-08-06-plan-tiers-all-data-sources.md`.

## 2026-08-05 GROK — multi-period TWR

## 2026-07-06 — Learned-context copy fix + browse/delete archive (CLAUDE, `agent/claude`)
Owner flagged awkward empty-state copy on the Learned Context approval queue and asked why the AI
doesn't auto-learn and let the user review/delete afterward. Answer: it mostly already does — the
`fact` tier is silent passthrough, never queued; only `risk`/`strategy-directive` (numeric limits,
sizing, leverage, authority) confirms first, and that's deliberate (ingested-document/inference
safety, not paternalism — see `docs/chat-multiuser-learning-design.md`). What was genuinely
missing: the "browse + delete what was silently learned" surface the design doc promised but never
built. Shipped both: reworded the empty-state copy; added `deleteLearnedContext` (ownership-scoped,
also the shared-contribution erasure path) in `src/lib/db-learning.ts`, new `GET
/api/learned-context` + `DELETE /api/learned-context/[id]` routes, client helpers, and a new
collapsed-by-default `LearnedFactsArchive` browse/delete component in
`app/console/approvals/learned-context.tsx` wired into the approvals page. New
`test/learned-context-delete.test.ts` (7 tests: ownership isolation, foreign-user 404, shared-row
erasure, audit trail, superseded-row exclusion). 8-angle adversarial review found no
correctness/security bugs (two correctness-adjacent candidates investigated and refuted with
concrete evidence — see rollout note). Branch had drifted far behind `origin/main`
(Coolify/Hetzner migration, mobile fixes, RAG/sizing/prompt-safety work); merged by hand after
reviewing every flagged overlap, re-verified full quartet on the merged tree: tsc clean, lint 0
errors, 283 files / 2843 tests green, build clean. **Merged as PR #998** (`1c0c20d3`).
**Deployed to production** 2026-07-06 21:30:29Z via `~/apps/trading-publish.sh` — verified
`/api/health` 200, `pm2 trading` stable (0 unstable restarts post-deploy), and the new
`/api/learned-context` route live (401 unauthenticated, not 404/500, confirming it shipped). See
`docs/rollouts/2026-07-06-learned-context-archive.md`.

erasure, audit trail, superseded-row exclusion). Full suite 258 files / 2518 tests green, tsc
clean, lint 0 errors. Owner asked for production release this pass — see PR/deploy details below
once landed. See `docs/rollouts/2026-07-06-learned-context-archive.md`.
## 2026-07-06 — Mobile console width overflow fix (PR open)
- **2026-08-05 — GROK — IN PROGRESS — Multi-period TWR: split at each deposit/withdrawal, chain account+SPY sub-period returns (branch `grok/twr-subperiod-spy-chain`).** Owner: $100 for 10d then $10 for 100d must be separate regimes geometrically linked.

## Active (GROK 2026-08-06)

- **Plan-tier research** (`grok/plan-tier-research`): correcting Connections quota maps from live vendor docs (ROIC 5/min free, Twelve Grow floor 55, Marketstack monthly, AV premium ladder). Rollout: `docs/rollouts/2026-08-06-plan-tier-research.md`. Owner: do not invent limits — re-verify on site.

## 2026-08-05 GROK — account return % fix

- **2026-08-05 — GROK — IN PROGRESS — Fix inflated account % return (synthetic paper curve + live tip TWR; isAllCash cash-first; capital-weighted closed-lot return).** Branch `grok/fix-account-return-pct`. Owner: Sandbox/Alpaca Paper/etc showed ~+50% despite ~$100k start and slight drawdown.

## Current (2026-08-06 GROK provider-neutral data sources + ROIC)

**Settings Data sources card (no FMP-special toggles); ROIC key+tier+fixed transcript API (branch `grok/roic-provider-tiers`).**
Connections: plan tiers for market data; ROIC free/starter/individual/professional quotas; env-key plan tier without re-paste; v3 earnings-calls fetch. Rollout: `docs/rollouts/2026-08-06-provider-neutral-data-sources-ui.md`.

## Current (2026-08-05 GROK multi-source RAG)

**Earnings transcripts + SEC full bodies + trade highlights in RAG (branch `grok/rag-multi-source-ingest`).**
Full 8-K/10-K/10-Q/earnings-transcript stay native; extractive `document-summary` /
`earnings-summary` abstracts for LLM proposal use; routing + coverage expanded; Infisical
8-K full-body + EarningsCalls daily knobs on. Rollout: `docs/rollouts/2026-08-05-rag-multi-source-ingest.md`.
## Current (2026-08-05 GROK API key plan tiers)

**Plan-tier dropdowns on Connections API keys (branch `grok/data-sources-overhaul`).** Optional market-data keys declare free/power/starter/…; persist `user_api_keys.plan_tier` (v70); `provider-tier-plan.ts` → `resolveProviderQuota` when env knobs unset; FMP marked Retired · CT-only. Rollout: `docs/rollouts/2026-08-05-api-key-plan-tiers.md`.

## Current (2026-08-05 GROK FMP/Quiver health OFF)

**FMP/Quiver intentional OFF on admin Connections + FMP policy defaults false (branch `grok/data-sources-overhaul`).** Retired vendors show muted OFF chip (not red STOPPED), excluded from stopped/degraded counts; DEFAULT_POLICY fmp* toggles false; Settings FMP card retired→Congress.Trade; keys POST rejects FMP. Rollout: `docs/rollouts/2026-08-05-fmp-quiver-health-off.md`.

## Current (2026-08-05 GROK provenance stamps)

**Provenance completeness on scan/cache/history (branch `grok/data-sources-overhaul`).** Cascade stamps sharesOutstanding+headlines; mergeQuoteData/bar fieldObservations; OHLC + history_cache_eod.source (v71); macro fieldSources; calendar observations. Rollout: `docs/rollouts/2026-08-05-provenance-stamps-completeness.md`.


**2026-08-05 — GROK team: data sources overhaul (IN PR).** Capability matrix + ROIC transcript scheduler; FMP/Quiver health OFF; soft expected-limit health; plan-tier key dropdowns; provenance stamps; CT FMP latency family OFF grey (Congress.Trade #1417). Branch `grok/data-sources-overhaul`. Rollouts under `docs/rollouts/2026-08-05-*-*.md` + umbrella `data-sources-overhaul`.

## Current (2026-08-05 GROK You're set card center)

**Collapsed readiness card vertical center (branch `grok/youre-set-card-vertical-center`).** Closed collapsible cards get balanced header padding + min-height so "YOU'RE SET" sits centered. Rollout: `docs/rollouts/2026-08-05-youre-set-card-vertical-center.md`.
## Current (2026-08-05 GROK mobile tab bar chrome gap)

**Mobile tab bar: close 80% of Safari chrome gap + continuous surface (branch `grok/mobile-tabbar-gap-and-chrome-bg`).** Measure gap above floating URL chrome; shift `.con-tabbar` down 80%; solid surface underlay for remaining gap + under translucent chrome so colder `--con-bg` no longer flashes around the address bar. Rollout: `docs/rollouts/2026-08-05-mobile-tabbar-chrome-gap.md`.

## Current (2026-08-05 GROK symbol-field-store)

**Durable shared `symbol_field_latest` (branch `grok/symbol-field-store`).** Per-field `as_of` + `fetched_at` for every market field on every symbol ever seen; cascade and scan write; interactive scan seeds from store so strategy_run audit bounding no longer blanks PE/EPS/div. Rollout: `docs/rollouts/2026-08-05-symbol-field-latest-store.md`.

## 2026-08-05 GROK — issues/effort sweep
- Open PRs armed: #2489 (P2.7/P2.8), #2445 (iOS SSE), #2443 (Tradier quotes).
- Residual branch `grok/issues-activity-audit-residual`: B4 Settings TOC + congress-share IfDue single-flight + evidence_age (id,timestamp) dedup + board hygiene.
- Confirmed already on main: #2459 batch, Coach→Insights, safeTopCandidates, most activity-audit P2/P3.

## 2026-08-05 GROK — P0 security residual tranche

- **P0-5** decryptValue rejects plaintext; OAuth legacy path gated by isEncryptedValue.
- **P0-4** audit hash chain schema v67 + verifyAuditChain.
- Confirmed already on main: P0-1/2/3, P1-1..7 mechanical.
- Branch `grok/p0-security-p1-mechanical`.

**2026-08-04 — GROK: Tradier Sandbox venue-aligned quotes (branch `grok/tradier-sandbox-venue-quotes`).**
Paper Tradier keeps ~15m delayed sandbox quotes as execution-authoritative (no fresher Alpaca/Yahoo
overlay); staleness ages `fetchedAt` not trade-time delay. Alpaca paper stays real-time cascade.
Rollout: `docs/rollouts/2026-08-04-tradier-sandbox-venue-quotes.md`.

## Current (2026-08-05 GROK closeout)

- Merged #2488 #2459 #2489 #2445 #2443. Closed issues #838 #837 #1319 #1320 #1321 #1322.
## Current (2026-08-05 GROK)

**2026-08-05 — GROK: issue batch #838/#837/#1319 (branch `grok/issues-batch-prompt-evidence`).**
Prompt fencing on outcome post-mortem + reflection LLM; headline first-seen v66 for
evidence-age receipts; approval-path HTTP 4xx → rejected_by_broker. Also unstuck PRs
#2443/#2444/#2445. Rollout: `docs/rollouts/2026-08-05-issues-prompt-safety-headline-placement.md`.

**2026-08-04 — GROK: auto-pause strategy when broker cannot place orders (branch `grok/auto-pause-unplaceable-broker`).** If order path is down (Tradier OMS 500s, Alpaca trading_blocked, infra place failures, unfunded), flip `systemState` to `halted` with auto-resume marker so cadence stops burning LLM on unplaceable proposals; recover when probe healthy. Rollout: `docs/rollouts/2026-08-04-auto-pause-unplaceable-broker.md`.
**2026-08-04 — GROK: expert panel UX — Run once single primary (PR-A6).** Branch `grok/ux-expert-review-dup-run-once`. Owner: two Run once within ~1 inch. Four-expert review of web+iOS; chrome/home owns one primary; removed cadence/readiness/Guardrails/Insights duplicates; Zap icon; Approve live always labeled; iOS LIVE/PAPER + tappable attention. Review: `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md`. Rollout: `docs/rollouts/2026-08-04-ux-run-once-single-primary.md`.

**2026-08-04 — GROK: iOS Sign-In constraint + SSE events (-1017).** Branch `grok/ios-constraint-and-sse-fix`. Cap Apple Sign-In button at 375pt; dedicated SSE request (`Accept: text/event-stream`, 120s idle timeout); quiet reconnect when snapshot already loaded. AG's 2026-08-03 constraint fix never reached main — lands here. Rollout: `docs/rollouts/2026-08-04-ios-signin-constraint-and-sse-events.md`.


## Current (2026-08-05 GROK activity-audit)

- P2.7/P2.8: multi-poll cancel settle + `protective_exit_failing` notification (branch `grok/activity-audit-p2-7-8`, issues #1320/#1321). Rollout: `docs/rollouts/2026-08-05-activity-audit-p2-7-8.md`.
- Unstuck phantom-conflict open PRs #2459 #2445 #2443 (merge main + re-arm auto-merge; CI re-running).
## Current (2026-08-05 GROK)

- Framework proposals: all 3 prod rows set to **rejected** after agent review (PG/T hard accounting gates; BAC unfilled red-team override). UI reopen/change-of-mind on branch `grok/framework-proposal-review`. Rollout: `docs/rollouts/2026-08-05-framework-proposal-review-reopen.md`.
## Current (2026-08-04 GROK)

- iOS TestFlight agent ship: `bash scripts/ios-ship-testflight.sh` (fleet README `/Users/jay/apps/ios-fleet/README.md`).

**2026-08-04 — GROK: UX Wave B IA (B1/B2/B4) — PR #2425.** Branch `grok/ux-wave-b-ia`.
Plain nav labels Home/Scan/Activity/Results/Macro via `DESTINATIONS` + `destinationLabel`;
Guardrails Autonomy panel (`#autonomy`) with run state/authority/cadence/readiness + chrome Run
controls; Settings sticky TOC. B3 via #2426 on main; no policy defaults; A4 `defaultOpen={false}`
preserved. Supersedes #2413/#2419. Rollout: `docs/rollouts/2026-08-04-ux-wave-b-ia.md`.
**2026-08-04 — UX PR-A2 approval density (GROK, branch `grok/ux-a2-approval-density`).** Approval cards default collapsed (side/symbol/size, Live/Paper, AI-critic chip, 2–3 line thesis); "Show full reasoning" restores full receipt; sticky mobile Approve/Reject above tab bar. No approve-API changes. Rollout: `docs/rollouts/2026-08-04-ux-a2-approval-density.md`.
**2026-08-04 — GROK: UX PR-B1 plain nav labels (branch `grok/ux-b1-plain-nav`).** Owner D2:
Thesis→Home, Evidence→Scan, Journal→Activity, Outcomes→Results, Regime→Macro. `desc`
tooltips keep metaphor; home CTAs use `destinationLabel`; mobile pins already by href.
Rollout: `docs/rollouts/2026-08-04-ux-b1-plain-nav-labels.md`.
**2026-08-04 — GROK: retire direct FMP / QuiverQuant / Unusual Whales.** Owner:
Socratic.Trade must not call those vendors. Congressional disclosures/analytics from
Congress.Trade (default ON); **fundamentals from multi-source cascade** (Yahoo/Finnhub/
ROIC/SEC/… — App A fundamentals default OFF). Hard ban at registration + request choke
points. Branch `grok/no-direct-fmp-quiver-uw` (PR #2398).
Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.

**2026-08-04 — Final Verification of Model Slugs (AG).** Branch `agent/antigravity/openrouter-classifiers`. Replaced all legacy `-latest` model slugs with Provider Native Slugs (`gpt-5.6-sol`, `gpt-4o`, etc.) across the codebase. Cleaned up duplicate properties in model configuration files. Fixed test regressions in history tests by adding DB isolation to `historyTestDb` shared per-file. Fixed `isGpt56Model` regex. Gates verified: tsc clean, lint clean, full test suite passes. Landed cleanly via `land.sh`.
Rollout: `docs/rollouts/2026-08-04-model-slug-test-fixes.md`.

**2026-08-04 — GROK: UX PR-A4 + PR-A5 (guardrails Advanced collapsed + PWA Proposals noun).**
PR #2411, branch `grok/ux-a4-a5-quick`, auto-merge armed. Advanced rulebook `defaultOpen={false}`; Essentials open; PWA
heading Approvals → Proposals. Display-only. lint+tsc clean. Rollout:
`docs/rollouts/2026-08-04-ux-a4-a5-guardrails-nouns.md`.


# STATUS — current repo snapshot

**2026-08-04 — GROK: Congress filing-date member skill → ST.** Prefer CT `filingDate`
copy-trade skill (shared package v2.5.0 dual performance); restore `memberSkill` weight
0.2; persist raw avgExcess/winRate/scoredCount on quotes + signal_snapshot. Branch
`grok/congress-filing-skill`. Rollout:
`docs/rollouts/2026-08-04-congress-filing-member-skill.md`.
**2026-08-04 — GROK: quote cascade freshness + never block on stale.** Cascade accept = maxQuoteAgeSec (120s) so ~15m delayed feeds no longer stop the cascade; if still stale, convert opening to limit at proposal.referencePrice (never block/escalate). Branch `grok/fix-quote-freshness`.

**2026-08-04 — GROK: UX B3+E2+E3 polish (branch `grok/ux-b3-e-polish`).** Strategy page collapsible sections (Models + Instructions open; Scoring weights collapsed; Presets open). Login page three value bullets matching iOS. Command palette trigger always visible on mobile chrome (icon-only below sm). Healthy mobile freshness collapses to one line. No policy changes. Rollout: `docs/rollouts/2026-08-04-ux-b3-e-polish.md`.


**2026-08-04 — GROK: retire direct FMP/Quiver/UW; fundamentals multi-source.** Hard ban
on direct FMP/Quiver/UW. Congress.Trade for disclosures/analytics (default ON);
fundamentals from the multi-provider cascade (App A fundamentals default OFF). PR #2398.
**2026-08-05 — iOS Light App Icon Sync (ANTIGRAVITY, branch `agent/antigravity`).** Replaced the canvas-drawn `icon.svg` with the iOS App Icon (PNG) across `public/icon.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, and `public/icons/apple-touch-icon-180.png`. Updated `app/manifest.ts` and `app/layout.tsx` to serve the static PNGs instead of the SVG to fix visual glitches/inconsistencies. Rollout: `docs/rollouts/2026-08-05-ios-light-app-icon-sync.md`.

Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.
**2026-08-04 — Full-Bleed Pure White App Icon Assets (ANTIGRAVITY, branch `agent/antigravity`).** Updated `public/icon.svg` canvas to 100% full-bleed white background (`#ffffff` without transparent corners), updated `app/manifest.ts` PWA `background_color`/`theme_color` to `#ffffff`, and regenerated all PNG icons (`apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png`, and iOS Xcode `AppIcon-1024.png`). Verified `tsc` clean and asset rendering. Rollout: `docs/rollouts/2026-08-04-full-bleed-white-app-icon.md`.

**2026-08-04 — GROK: PR drain complete; prod deploy unblocked via slim Dockerfile.** Merged open PRs #2367-#2371, #2375, #2381. Prod stuck on 6ad913d5 because Coolify timed out on multi-GB `COPY --chown`. Fix: `.dockerignore` + prune + chown-in-RUN (`grok/docker-slim-deploy`). Rollout: `docs/rollouts/2026-08-04-docker-slim-deploy.md`.

**2026-08-04 — GROK: paper-account learning parity (Learning Review).** Owner: paper
trades are first-class for model/task comparison unless a definite paper-exclusive
cause applies. Prompt rule + portfolio-scoped decision lessons + environment on review
items. Branch `grok/paper-learning-parity`. Rollout:
`docs/rollouts/2026-08-04-paper-learning-parity.md`.

**2026-08-04 — GROK: deploy 178 failed (missing better-sqlite3 .node); fixing native rebuild.**
PRs drained; slim image builds (1.45GB) but healthcheck 500: `better_sqlite3.node` missing after
`npm rebuild` no-op post-prune. Branch `grok/docker-sqlite-native`: prune --ignore-scripts,
global node-gyp, clean rebuild, assert load. Prod still on 6ad913d5 (healthy). Rollout:
`docs/rollouts/2026-08-04-docker-sqlite-native.md`.

2026-08-01 were moved to `docs/status-archive.md`.

Last updated: 2026-08-05 (GROK: UX program Waves A–E complete).
Last updated: 2026-08-04 (GROK: UX Wave C speed C1–C4).
Last updated: 2026-08-04 (GROK: UX Wave B IA landing).
Last updated: 2026-08-04 (GROK: UX PR-A3 first-run readiness checklist — PR #2417).
Last updated: 2026-08-04 (GROK: UX Wave D mobile/iOS/PWA).

**2026-08-04 — GROK: UX Wave D mobile/iOS/PWA parity (branch `grok/ux-wave-d-mobile`).**
D1 brand teal `#12616f` / dark `#58c7d3`; D2 Home readiness checklist + ready hero with
Review→Proposals tab switch; D3 per-proposal command feedback (iOS MobileStore + ProposalsView,
PWA card strip); D4 humanized command labels, Ask-first/Autopilot, Proposals section title,
control-remote framing. Rollout: `docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX Wave C speed (2026-08-04, GROK)

**IN PR** branch `grok/ux-wave-c-speed`. C1 snapshot TTL cache (userId×accountNumber, 10s,
invalidate on policy/approve/reject); C2 FIFO `calculatePnl` once + PrefetchedPnl to
scorecards/tax; C3 scan `TableVirtuoso`; C4 `React.memo` leaves + home `useMemo` derives.
Rollout: `docs/rollouts/2026-08-04-ux-wave-c-speed.md`. Program:
`docs/design/ux-improvement-program.md` §Wave C.

## UX improvement program (2026-08-04, GROK)

Sequenced PR plan: `docs/design/ux-improvement-program.md`.
**PR-A1 honest skip statuses** — IN PR #2418 (`grok/ux-a1-honest-skips`): granular
`skipped_budget` / `skipped_market_closed` / `skipped_broker_unhealthy`; Thesis/Activity
chips; liveness/auto-tune honesty. Rollout: `docs/rollouts/2026-08-04-ux-a1-honest-skips.md`.
PR-0: `docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan: `docs/design/ux-improvement-program.md`. **Wave B IA** (B1 plain labels,
B2 Autonomy panel, B4 Settings TOC) on branch `grok/ux-wave-b-ia` — rollout
`docs/rollouts/2026-08-04-ux-wave-b-ia.md`. Wave A slices remain claimable. Program rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan for web console + PWA + iOS after a full-product review:
`docs/design/ux-improvement-program.md`. Wave A/B/C/D slices claimed by implementer
fleet — coordinate via effort board. Rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
`docs/design/ux-improvement-program.md`. **PR-A3 first-run checklist IN PR**
(`grok/ux-a3-checklist` / #2417 — `deriveReadinessChecklist` + Thesis hero).
Program rollout: `docs/rollouts/2026-08-04-ux-improvement-program.md`. A3 rollout:
`docs/rollouts/2026-08-04-ux-a3-first-run-checklist.md`.
`docs/design/ux-improvement-program.md`. Wave D (mobile/iOS/PWA) implemented on
`grok/ux-wave-d-mobile`. Remaining A/B/C slices stay Planned/UNASSIGNED until claimed.
Rollouts: `docs/rollouts/2026-08-04-ux-improvement-program.md`,
`docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX program complete (2026-08-05, GROK)

All sequenced UX waves A–E from `docs/design/ux-improvement-program.md` are **merged to main** (auto-deploy). Key PRs: #2411 A4+A5, #2413 B1, #2414 A2, #2417 A3, #2418 A1, #2423 C, #2424/#2431 D, #2425 B2/B4, #2426 B3+E. Rollout: `docs/rollouts/2026-08-05-ux-program-complete.md`. Deferred: E1 empty-state system, unauth apex→welcome.

## Where things stand

**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Implemented a 5-level redundant quote cascade resolving active broker gateway → Alpaca snapshots → Yahoo batch → Yahoo single → ROIC.ai profile. Converted the quote staleness policy check into a non-blocking gate that mutates opening orders to limit orders to defend the price (buy capped at min(limit, ref), short capped at max(limit, ref)), appends warning text to rationale, writes a `quote_staleness_warn` audit trail, and alerts the user via `provider_degraded` push. Full tests and builds check out clean. Rollouts: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`, `docs/rollouts/2026-08-04-non-blocking-quote-staleness-gate.md`.
**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Added a redundant multi-source quote cascade in `src/lib/quotes-cascade.ts` checking broker quotes, Alpaca snapshots, Yahoo batch, and Yahoo single quote APIs in series. Integrated it across the strategy run loop, proposal approvals, and chat draft promotion. Added a unit test suite to verify the cascade level routing. Full type check and lints pass. Rollout: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`.

**2026-08-04 — EOD Quote History Cache SQLite Migration (ANTIGRAVITY).** Migrated the legacy flat-file JSON EOD quote caching (`data/history-5y/`, etc.) in `src/lib/history.ts` to a fully SQLite-backed table `history_cache_eod` to resolve test failures and ensure robust silent-caching. Replaced `fetchLocalFlatFileHistory` with `fetchHistoryCacheEod`. Updated the `test/history.test.ts` suite to seed the SQLite DB directly. Full tests pass. Rollout: `docs/rollouts/2026-08-04-history-cache-eod-migration.md`.

**2026-08-03 — Subdomain Host Routing & EOD Quote Caching Upgrade (ANTIGRAVITY, branch `agent/antigravity`).** Added `mobile.socratictrade.com` $\rightarrow$ `/mobile` and `console.socratictrade.com` $\rightarrow$ `/console` host-level routing in `middleware.ts`. Upgraded EOD price history in `src/lib/history.ts`: added `isBarSeriesFresh` staleness detection, `mergeOHLCBars` merging for stale flat files, auto-persistence of fresh provider bars into SQLite `imported_price_eod` and disk, and `eod_cache_stale` audit logging. All gates green (`tsc`, `lint`, vitest 27/27, Next.js `build`). Rollout: `docs/rollouts/2026-08-03-eod-quote-caching-and-subdomain-routing.md`.

**2026-08-03 — iOS/mobile account switch hangs (MONET, branch `monet/ios-account-switch-fix`).**
Owner screenshots: Roth IRA spinner stuck, Sandbox still Active, Home stale + 2 queued · 1
running. Root cause: `account.activate` waited on the global sequential mobile worker behind
`strategy.run_once`, and clients also blocked switch when the snapshot was stale. Fix: run
`account.activate` immediately (same path as stop), allow switch on stale snapshot (iOS + PWA),
clear iOS busy spinner from the terminal POST before snapshot reload. Focused mobile tests
16/16; full gates via land.sh. Rollout:
`docs/rollouts/2026-08-03-ios-account-switch-immediate.md`.
**2026-08-03 — Console RAG Evidence Card Deduplication (ANTIGRAVITY, branch `agent/antigravity/mobile-pwa-feedback`).** Fixed duplicate RAG evidence rendering (`sec-edgar` and `Retrieved 10 K` cards showing identical document receipt & score) in proposal drawer by deduplicating RAG attributions against `decision.evidence` in `deriveEvidenceRows` (`app/console/page.tsx`). Rollout: `docs/rollouts/2026-08-03-dedupe-evidence-cards.md`.

**2026-08-03 — Console dashboard `topCandidates.slice` white-screen (GROK, branch
`agent/grok-fix-dashboard-topcandidates`).** Owner report: main `/console` showed
`Dashboard error` / `undefined is not an object (evaluating 'r.topCandidates.slice')`.
Root cause: `deriveEvidenceRows` assumed every truthy `latestScan` had array
`topCandidates`. Fix: `safeTopCandidates` + snapshot normalization in `dashboard.ts`.
Rollout: `docs/rollouts/2026-08-03-console-topcandidates-slice-crash.md`.

**2026-08-03 — Xcode App Settings & Apple Sign-In Layout Constraint Fix (ANTIGRAVITY).** Configured Xcode App Category (`public.app-category.finance`), Display Name (`Socratic.Trade`), Marketing Version (`1.0.0`), and Build Version (`1`) across `Info.plist` and `project.pbxproj`. Fixed `ASAuthorizationAppleIDButton` layout constraint collision warning (`width == 392` vs `width <= 375`) in `LoginView.swift` by capping `SignInWithAppleButton` width to 375pt. `xcodebuild` succeeded clean. Rollout: `docs/rollouts/2026-08-03-xcode-app-settings-and-apple-signin-constraint-fix.md`.

**2026-08-02 — Exit-0 outage root-caused + exit-code hardening (MONET, branch
`monet/exit0-outage-audit`).** The 15:29Z "clean exit 0, stayed down" outage was an
**unpaired docker-API stop**, with the 0 fabricated by a pid-1 signal-re-raise bug in the
infisical wrappers plus in-container npm swallowing SIGTERM (sandbox-reproduced in the
real image; every deploy had been hard-killing next-server). Fixed: wrappers exit 128+N,
boot script now supervises the app (spontaneous clean exit → 40, every exit logged,
`node_modules/.bin/next start` direct — npm banned from the exec chain), new
production-gated `src/lib/exit-guard.ts` re-tags spontaneous in-app exit(0) → 43 with
call-site receipts. Restart policy is already `unless-stopped` — evaluated, **no flip**
(it restarts any spontaneous exit; the outage class is API stops, now covered by rule +
honest codes). `docker events` forensics verified broken (~256-event ring ≈ minutes on
this box) — journalctl is the durable source. Contract + traps codified in AGENTS.md
("Production exit-code contract"). Rollout:
`docs/rollouts/2026-08-02-exit0-outage-audit.md`. Next prod stop/deploy should log
`app exited with code 143 after forwarded SIGTERM` as live confirmation.

**2026-08-02 — 5-Year Local Flat-File Price History Priority (ANTIGRAVITY).** Added `fetchLocalFlatFileHistory(symbol)` as the #1 primary tier in `src/lib/history.ts` (`fetchDailyOHLC`) and `fetchGroupedBarsLocal(date)` in `src/lib/market-signals/massive.ts`. Any pre-hoarded 5-year Massive flat files (`data/history-5y/`, `data/massive-history/`) are read directly from disk without hitting external REST APIs, providing instant zero-cost history for backtests and Congress.Trade EOD price feeds (`/api/market/prices/[symbol]`, `/api/market/spx`). Rollout: `docs/rollouts/2026-08-02-local-flatfile-history-priority.md`.

**2026-08-02 — Mobile PWA owner-feedback round (Monet, cloud session).** Branch
`agent/antigravity/mobile-pwa-feedback` (applying patch from Monet): PWA gets
an Accounts section (switch broker account via `account.activate`, sign-out link to switch Google/Apple
login), per-proposal realtime approve/reject feedback (tapped button spins; card follows its queued
command through queued/running/succeeded/failed instead of failures hiding in the Command Log), and the
delete-account panel is collapsed behind a neutral link so it stops mimicking error banners. tsc clean,
mobile test file 10/10, lint 0 errors. Landed as #2351 (`44069368`).
Rollout: `docs/rollouts/2026-08-02-mobile-pwa-owner-feedback.md`.

**2026-08-02 — Data-provider hardening, Round 1 (MONET, `monet/data-cascade-freshness`,
merged as #2353).** Implemented the free-tier research doc's own recommendations: Tiingo
now ALSO an OHLC-history source in `history.ts` (was enrichment-only — a configured key
delivered none of the promised adjusted-history value until this landed), dead Stooq tier
removed (confirmed PoW-bot-walled), keyless Treasury.gov yield-curve fallback (3M/2Y/10Y +
curves, no FRED key needed), Cboe VIX9D, SEC-XBRL `revenueGrowth`. Full gates green.
Rollout: `docs/rollouts/2026-08-02-data-provider-hardening.md`.

**2026-08-02 — Data-provider hardening, Round 2/3 (MONET, `monet/data-cascade-providers-round2`).**
Closes out the rest of the same research doc: 3 new key-gated fundamentals/news providers
(Wisesheets, SimFin, Marketaux — all dormant until their env key is set), 2 new keyless
sources (BLS macro fallback wired into the Macro board, Nasdaq earnings-calendar backfill),
an S&P 500 constituents mirror (built, not yet wired to replace the static universe list —
see the rollout note), Yahoo 429 hardening, and Alpha Vantage/Finnhub earnings-calendar
fallbacks. USAspending.gov investigated and correctly NOT implemented (no free
recipient→ticker crosswalk exists). Full gates green: lint 0 errors, tsc clean, 5891/5891
tests, build clean. Rollout: `docs/rollouts/2026-08-02-data-provider-round2.md`.

| | |
|---|---|
| `main` | `44069368` — Codex remediation (#2341), npm `allowScripts` fixes (#2345, #2349), mobile PWA feedback round (#2351) |
| In flight (MONET) | `monet/exit0-outage-audit` — exit-0 outage RCA + exit-code hardening (PR pending). `monet/broker-mutation-mutex-pr2` LANDED as #2361 (§7 slice 3 COMPLETE; corrected in place — was listed in flight); its deploy is also the freshness-lane re-enable live test. Landed today: #2350, #2352, #2354, #2360, #2361. Rollout: `docs/rollouts/2026-08-02-account-mutation-lease-pr2.md` |
| Production (`socratictrade.com`) | `c117afb9` verified live ~05:35Z — SECOND organic cutover since the repair; `b7d88e42` builds next (serialized) |
| Deploy mechanism | auto-deploy on push to `main` — **repaired 2026-08-02** (webhook HMAC secret was mismatched; see blocker 1) |
| Core trading health | DB ok, scheduler ticking, 3 active accounts / 0 degraded. ~~litestream replicating~~ **CORRECTED 2026-08-06 (MONET): litestream→R2 is PAUSED (kill-switch since Aug 4) — no continuous DB backup; owner decision to resume** |
| Data providers | `dataProvidersDegraded=true` — Massive capped to ~2y history (owner decision pending); filingapi STOPPED 6d. ~~FMP plan probe 403~~ (stale: FMP retired on ST 2026-08-04, health lanes show OFF by design) |

## Blockers

1. **RESOLVED 2026-08-02 — auto-deploy was broken by a webhook HMAC mismatch.** Every push
   to `refs/heads/main` was answered by Coolify with
   `[{"status":"failed","message":"Invalid signature."}]` (visible only in the GitHub hook
   delivery RESPONSE BODY — the hook page showed green 200s throughout), so no deployment
   was ever created; the queue sat empty and the single 2026-08-01 deploy was the owner's
   manual click. Repair: synced the GitHub hook secret to the Coolify app's
   `manual_webhook_secret_github`, deleted the exact-duplicate second hook, redelivered the
   newest main push -> a real deployment was created immediately, and
   `scripts/verify-deploy-sha.sh 19dfd51b` reported **PASS** (~04:47Z). Merge==live is
   trustworthy again. Also fixed: AGENTS.md's stale Coolify uuid (the app is `socratic-app`
   now). Full receipts + recurrence warning:
   `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`.

2. **RESOLVED — npm `EALLOWSCRIPTS` on the shared git dep (and the earlier explanation
   here was wrong).** A clean-shell reproduction with the repo's exact files PASSES: the
   repo as committed installs fine, and a stale `allowScripts` tag was NOT the trigger.
   The real triggers (npm 11.16.0+, upstream bug npm/cli#9783, open, unfixed through npm
   12.0.2): an `allow-scripts=...` line in ANY `.npmrc` layer, or an inherited
   `npm_config_allow_scripts` env var — npm forwards it into its git-dep preparation
   subprocess, which rejects it as a flag. This Mac had live `npx`-launched processes
   exporting `npm_config_allow_scripts=@wasp.sh/wasp-cli`; any shell descending from that
   lineage fails every `npm ci` instantly. If EALLOWSCRIPTS appears: check
   `env | grep npm_config_allow_scripts` and relaunch the contaminated parent — and NEVER
   add `allow-scripts` to `.npmrc`, even though npm's own error message suggests it.
   Also fixed forward: `allowScripts` git-dep keys in tag form (`#vX.Y.Z`) can never match
   (npm compares against the resolved 40-char SHA), which npm 12 escalates from a warning
   to a hard block on the dep's `prepare` — the key is now committish-free
   (`"github:jaywedgeworth22/congress-trading-shared": true`, verified: coverage warning
   gone). #2345's lockfile regen also fixed a real silent bug: the old lockfile pinned the
   v2.3.0 commit while package.json said v2.4.x, so `npm ci` was silently shipping the old
   shared package. Verified 2026-08-02: plain `npm ci` = exit 0, 575 packages, clean shell.
   (An earlier copy of this blocker blamed a stale `allowScripts` tag — corrected above;
   the union merge briefly duplicated both versions here, de-spliced 2026-08-02.)

3. **Two provider lanes are degraded and need an owner decision, not an agent fix.**
   FMP's plan probe returns 403 (subscription state) and Massive is history-capped to the
   free tier. Agents must not provision replacement keys. Several optional/telemetry lanes
   (Usage Monitor, VIX-Yahoo, Nasdaq Quote, some RapidAPI lanes) are also down; those are
   fallback tiers and the cascade still serves real data.

## Next action

- Watch that `c117afb9` (and subsequent merges) deploy organically via the repaired
  webhook — `bash scripts/verify-deploy-sha.sh` after merging.
- (Retracted: the `schedulerLease.owner` "residual" flagged earlier does not exist — the
  landed code already strips the pid for unauthenticated callers; prod serves the bare
  instance uuid. Observation was made against the pre-deploy payload.)
- Owner decisions pending: FMP subscription, Massive plan tier; and whether hook-secret
  re-sync should be added to the Coolify app-recreate recipe (see the 2026-08-02 rollout
  note — if recreation regenerated the secret, this failure recurs on the next recreate).

## Conventions that bite (do not re-derive these)

- **Board files are `merge=union`.** `.gitattributes` union-merges `STATUS.md`,
  `PLAN.md`, and `docs/EFFORT-LOG.md` so concurrent PRs do not conflict on them. The cost
  is that union **interleaves** both sides instead of conflicting, which silently produces
  duplicated rows and entries spliced under the wrong heading. `docs/EFFORT-LOG.md` had 13
  exact-duplicate blocks from this (deduped 2026-08-01) and `STATUS.md` had one agent's
  notes filed under another's heading (preserved as evidence in `docs/status-archive.md`).
  Keep entries to a single line where you can, and re-read your own row after a merge.
- **Node 24 is required.** The Mac's default `node` is v26 and mass-fails the suite on a
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

**2026-08-04 — Model slug migration tests and UI mapping fixes (Antigravity).**
Fixed `gpt-5.4-mini` regex inclusion in reasoning model capabilities which was causing test suite failures under Node 24. Also cleaned up `MODEL_DISPLAY_NAME` in `app/console/lib/models.ts` to strictly follow user-provided slugs, completely removing any legacy `-latest` suffixes. Verified tests locally.

**2026-08-04 — Revert accidental marketScan in from-draft preview (Antigravity).**
Fixed `test/chat-draft-policy.test.ts` test regression. A previous commit accidentally added a `fetchFreshQuotesCascade` call to the preview evaluation in `app/api/proposals/from-draft/route.ts`. Since the mock test broker returns real time quotes, this caused the "scan-less" preview to actually fetch a fresh quote and skip the expected `staleness_gate` block in tests. Reverted the addition so the preview returns to its scan-less state. All 10/10 tests pass, `land.sh` executed.
## Current (2026-08-07 GROK)

- **Fix paper vs-SPY +50%**: deposit+invest sparse snapshots without fills no longer count as alpha (`grok/fix-paper-spy-return-again`).

