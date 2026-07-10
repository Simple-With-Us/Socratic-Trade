# Trading Effort Log - canonical live cross-agent board

This is the branch-neutral live coordination board for Socratic Trade work across
Claude Code, Codex, Antigravity/Gemini, Cursor, web/cloud sessions, and manual
operator edits.

Canonical location:

`/Users/jay/apps/TRADING-EFFORT-LOG.md`

Tracked mirror in the repo:

`docs/EFFORT-LOG.md`

Rules:
- Every non-trivial effort must be logged here as Planned before substantial work begins.
- Move active work to In Progress before substantial edits.
- Move to Completed only after merge to `main`.
- Move to Deployed only after production at `socratictrade.com` is actually released and verified.
- Never delete another agent's row. Correct in place and note the correction.
- **Never assign an effort to an agent unless that agent is actively working on it.**
  An agent tag (CLAUDE/CODEX/AG/MONET/CURSOR) on a row means that agent CURRENTLY OWNS
  the work and is actively building it. Do not pre-assign the backlog — unassigned rows
  are claimed by the first agent that starts them. If an agent stops working on an effort,
  remove the tag (or move it back to unassigned). Assignment is a live claim, not a
  reservation.
- When committing, also update the repo-tracked mirror at `docs/EFFORT-LOG.md`.

State definitions:
- Planned: agreed or reserved, not started. Agent tags on Planned rows are only valid if
  that agent has actually claimed the work and plans to start it imminently. Otherwise
  leave the row unassigned (no agent tag) — first agent to pick it up claims it.
- In Progress: actively being built; include owner/worktree/branch and one-line status.
- Completed: merged to `main`; beta/integration only unless separately deployed.

_(Correction 2026-07-08, MONET: lines 17/25 above had "In Progress" wrongly replaced by
"Completed" — apparently a global find-replace slip; restored to match the repo mirror's
rules text. No effort rows were changed.)_
- Deployed: released to production (`socratictrade.com`) and verified.

As of 2026-07-08 (assignment-rule update).

---

## Deployed
- **PROD RELEASE 2026-07-09 (MONET, roth-gemini/runonce session): Coolify deploy gy3sbqag
  FINISHED + health-verified — production = `main@f9a37611` exactly (container healthy,
  /api/health ok, scheduler ticking; disk held 9.6G free).** Shipped PR #1190 (Roth IRA
  Gemini-400 TRUE root cause = maxItems x schema-complexity overflow -> toGeminiJsonSchema
  strips maxItems; async Run-once = 8s window then 202 started; console HTML-error shield vs
  raw CF 524) + #1191 single-adversary consolidation (rode along; that lane's payload). Deploy
  RECOVERY note: first attempt (p11b55w1) WEDGED at 100% disk (67MB free) — reclaimed ~14G of
  unused Docker images + build cache (volumes/running-app untouched; documented 4GB-box
  hazard), cancelled the stall, re-triggered clean. Gemini fix confirmed present in the running
  image; Robinhood sub-$1 min-guard fired once in prod (my alert-triage fix working). Roth's
  live proof pends the 13:30Z regular open (Roth runDuringExtendedHours=false — correctly gated,
  NOT a bug); 08:41 CDT auto-confirm scheduled. Rollout:
  docs/rollouts/2026-07-09-roth-gemini-400-runonce-async.md.
- **PROD RELEASE 2026-07-09 (FIRST announce-then-deploy run, MONET ui-sweep session):
  Coolify deploy FINISHED + health-verified — `/api/health` ok:true, db ok, scheduler
  ticking (15s age); production = `main` HEAD as of trigger (>= `f849c342`).** Shipped the
  undeployed batch: CODEX #1181 (Home evidence SymbolButton drawer parity) + #1184
  (guardrails tooltip titles) + docs close-outs #1183/#1185/#1186 (+ docs-only #1188
  AGENTS.md ANNOUNCE-THEN-DEPLOY reconcile if it merged in-window). First release under the
  2026-07-09 owner ruling: single claim line + 10-min no-objection window + deployer owns
  verify/boards — no double-trigger (contrast the 8bc0967f release below). Disk-cleanup lane
  ran in parallel; build did not wedge.
- **PROD RELEASE 2026-07-09 (owner-directed in-session, MONET prod-release): Coolify
  deploy `krk1db6x` FINISHED + verified — production = `main@8bc0967f` EXACTLY.**
  Ships Codex PR #1175 (Red Team efficacy Results card) and PR #1174 (LIVE bulk
  typed-confirm approval flow) on top of prior production `6a59a7eb`. Verified by
  MONET via Coolify/container health plus `/api/health` ok and scheduler ticking; Codex
  independently checked `/api/health` 200 during the deploy watch.
- **Wire the getRedTeamEfficacy scorecard into the console (CODEX, M) — DEPLOYED
  2026-07-09 via PR #1175 (`9cc99963`) and Coolify deploy `krk1db6x`
  (`main@8bc0967f`).** Results now surfaces veto-efficacy snapshot data, sample
  gating, override splits, and `unattributed` reviewer history in production.
- **Batch typed-confirm flow for LIVE proposals in approvals triage (CODEX, M) —
  DEPLOYED 2026-07-09 via PR #1174 (`8bc0967f`) and Coolify deploy `krk1db6x`
  (`main@8bc0967f`).** LIVE bulk approve now uses the server-side batch route,
  server-derived live membership, 20-row cap, row-honest partial outcomes, and one
  aggregate typed phrase when the owner setting requires it.
- **PROD RELEASE 2026-07-08 (owner-directed in-session, MONET intro-anim session): Coolify
  deploy `nitgo442` FINISHED + verified — production = `main@6a59a7eb` EXACTLY.** Ships #1170
  (intro landing fixes) + #1171 (shared-dep cleanup) + #1173 (mobile chrome bar) + #873
  (motion bump) + #1178 (mobile nav/drawer wave). Verified: deployment-record commit
  6a59a7eb, app running:healthy, edge 307->/login 200, /api/health ok:true scheduler
  ticking. All merged work is in production as of this stanza. (Lane owners: flip your own
  Completed rows for #1178/#1171 to Deployed.)
- **Intro->logo handoff polish + mobile brand row (MONET) — DEPLOYED 2026-07-08 (merged as
  PR #1112 = `7209f0f3`; in production via the SSE-fix Coolify RESTART `y8ie6lgx`, whose
  deployment record shows commit 7209f0f3 exactly — a Coolify "restart" on this git-sourced
  app REBUILDS from main, i.e. it is a deploy, not an env-only bounce; prod-lane take note).** Owner: (1) the persistent
  header logo must stay invisible until the intro candles assemble it (today it's visible
  from first paint and the candles fly onto it); (2) on mobile (<lg, where the bar logo is
  display:none and the intro lands on a phantom box) show a big full-width "SOCRATIC TRADE"
  row ABOVE the controls bar (~2x-tall chrome) as the landing target, hold ~3s after
  landing, then slide up/away to reclaim space. New `app/console/ui/intro-bus.ts` phase
  channel; edits `intro-canvas.tsx` (phase writes + first-VISIBLE [data-brand-logo]
  measurement), `shell.tsx` (BrandReveal + MobileBrandRow). No overlap with ui-audit-sweep
  or activity-lane filesets (announced).
- **PROD RELEASE 2026-07-08 (owner-directed in-session, MONET intro-anim session): Coolify
  deploy `rjskkyzx` of `socratic-trade-prod` FINISHED + verified — production now runs
  `main@4af98aaa` EXACTLY.** Ships #1095 (inline-Bear bare-array recovery — closes the
  silent-full-veto gap #1091 missed) + #1097 (sweep docs close-out). Verified: deployment
  record commit = 4af98aaa, app running:healthy, https://socratictrade.com 307->/login 200.
  As of this release EVERY effort marked Completed on this board is in production —
  Completed rows below this line that predate this stanza no longer imply "not yet
  deployed." (Prev deploy n1v296 = ea779bbf, earlier today.)
- **PR #1095 inline-Bear bare-array recovery + #1097 docs close-out (MONET,
  single-adversary-addendum session) — DEPLOYED 2026-07-08 via deploy `rjskkyzx`.** New
  exported `parseBearSurvivors` (strategy.ts): proposal-shaped bare arrays recovered;
  explicit `{proposals:[]}` stays a real veto; all malformed -> fallbackToBull, never a
  silent full veto. 7 tests. _(Row added at release close-out by the intro-anim MONET
  session — the fixing session announced on #agent-sync but hadn't boarded it here.)_
- **Intro animation: skip centered-wordmark middle act (MONET) — DEPLOYED 2026-07-08.**
  Merged as PR #1089 (merge commit ea779bbf); shipped to socratictrade.com in prod deploy
  n1v296 (deployed commit = ea779bbf exactly, health-verified per sync-4). Candles fly
  chart -> top-left header logo directly (~6.1s, was ~9.3s); centered SOCRATIC / TRADE act
  preserved behind `CENTER_WORDMARK_STEP: boolean = false` in
  `app/console/components/intro-canvas.tsx` (flip to true to restore). Rollout note
  `docs/rollouts/2026-07-08-intro-skip-center-wordmark.md`.

- **ALL preview servers retired (OWNER decision via MONET) - DONE 2026-07-08 ~00:50 CDT.** Owner: never used them, some behind CF Access agents cannot pass. End state = production only. Coolify preview app DELETED, preview DNS incl. *.jays.services wildcard DELETED, Mac PM2 previews (trading-main/claude/codex) STOPPED, Mac trading+litestream pm2 apps DELETED (accidental double-starts x2 tonight; rollback = pm2 start ~/apps/trading.config.cjs). Coolify PR-previews considered + NOT enabled (4GB box). AGENTS.md carries the definitive do-not-recreate stanza. Rollout: docs/rollouts/2026-07-08-previews-retired.md. NOTE: CLAUDE PR #1038 (integration-only teardown docs) is superseded - needs update/close.
- 2026-07-08 00:19 CDT - **Post-cutover incident RESOLVED: double-run of Mac prod (MONET).** A parallel MONET session ran the deprecated `trading-publish.sh` ~1h after cutover -> Mac pm2 `trading` restarted -> ~5min double-scheduler vs the box. Re-stopped 05:19Z; damage scan clean (0 proposals/fills; 9x MU synthetic-stop 422 client_order_id-unique rejections = deterministic-id dedupe held; litestream untouched; markets closed). Hardening: `trading-publish.sh` now refuses to run without `FORCE_MAC_PROD_ROLLBACK=1`. Fleet corrected on #agent-sync; owner push-notified. NOTE for the parallel session's rows below/above: its "Prod re-deployed clean @ 2d113054" claim refers to the RETIRED Mac lane — actual production (Coolify) still runs main-tip from cutover; trigger a Coolify deploy to ship 2d113054.
- 2026-07-07 ~23:15 CDT - **PRODUCTION socratictrade.com MIGRATED to the Coolify box (MONET, owner-directed) — DEPLOYED + VERIFIED.** `socratictrade.com` now = Coolify app `socratic-trade-prod` (uuid `m1os7ijf31bg3fanil152e4b`, main @ `e73c66a4`+#1039, nixpacks, auto-deploy OFF) on `91.98.44.8`; Mac pm2 `trading`+`litestream` STOPPED (saved stopped = rollback standby; do NOT restart while box runs `DB_BOOTSTRAP=live` — double-scheduler). DB moved via litestream 0.5.14 restore from the R2 replica; litestream now replicates in-container to the same path (PITR continuity). Secrets stay in Infisical (in-container CLI, `REQUIRE_SECRETS_MANAGER` enforced). Verified: edge 200/307, `/api/health` ok + scheduler ticking, restored-DB markers (provider-tier cache from 07-07, autoResumeOnBoot resumed), container stable. **Release process changed: prod deploy = trigger Coolify deploy of `socratic-trade-prod`; `~/apps/trading-publish.sh` DEPRECATED.** Also fixed pre-existing `trading.jays.services` edge 503 (http:// FQDN vs CF SSL=full; https:// FQDN is the required scheme). PR #1039 (boot script + litestream config) + docs PR. Rollout: `docs/rollouts/2026-07-07-prod-coolify-migration.md`.
- 2026-07-07 - `trading-live` published at `790b5f52` on `socratictrade.com` (MONET, owner-directed, `~/apps/trading-publish.sh`). "Move everything on main into production": full `origin/main` HEAD `790b5f52` pinned into the live build (node@24, `npm ci` from lockfile, `next build`, `pm2 restart trading`). This carries the latest `main` including the MONET risk lanes not yet in the prior prod cut — #881 regime-severity, #883 vol-targeting + portfolio-heat, #945 fractional-Kelly, #879 correlation/blackout/stress (all advisory/owner-overridable, default-off) — plus everything else merged since `7b5450fe`. Verified: `/api/health` `ok:true` / `db: ok` / scheduler ticking (~9s age), live HEAD == `origin/main`, pm2 `trading` online with `unstable_restarts: 0` (the 2026-07-06 EALLOWSCRIPTS/better-sqlite3 crash-loop did NOT recur — only a benign `npm warn allow-scripts`).
- 2026-07-06 - `trading-live` published at `3910ede2` on `socratictrade.com` (AG, PR #1014). Refactored API client and stream parser to use `@jaywedgeworth22/congress-trading-shared`. Removed duplicated logic from App A and pinned exact version match with App B.

- 2026-07-06 - `trading-live` published at `1c0c20d3` on `socratictrade.com` (CLAUDE, owner-run
  `~/apps/trading-publish.sh`, PR #998). Learned-context UX: reworded the awkward/over-scoped
  empty-state copy on the Learned Context approval queue, and shipped the "browse + delete what
  was silently learned" archive the design doc promised but never built — new
  `deleteLearnedContext` (ownership-scoped, also the shared-contribution erasure path),
  `GET /api/learned-context` + `DELETE /api/learned-context/[id]`, and a collapsed-by-default
  `LearnedFactsArchive` component. 8-angle adversarial review found no correctness/security bugs.
  Verify: 283 files / 2843 tests green, tsc clean, lint 0 errors, build clean (re-run post-merge —
  branch had drifted far behind main). Prod verified: `/api/health` 200, `pm2 trading` stable (0
  unstable restarts), new route live (401 unauthenticated, not 404/500). See
  `docs/rollouts/2026-07-06-learned-context-archive.md`.

- 2026-07-06 - `trading-live` published at `7b5450fe` on `socratictrade.com` (CLAUDE, owner-run
  `~/apps/trading-publish.sh`). Ships the full CLAUDE backlog train (#816 prompt-safety, #819
  usage-budget advisory, #820 due-jobs, #822 hyde-multiquery) plus everything merged to `main`
  since (incl. #875 Red-Team policy-aware routing). Verified: local `:4000` + public
  `socratictrade.com` `/api/health` 200, `db: ok`, scheduler ticking, pm2 `trading` online with
  `unstable_restarts: 0`, live HEAD == `origin/main`. **Incident recovered during this deploy
  (host-side, not code):** prod was 500 crash-looping on a missing `better-sqlite3` native binary
  because (1) `~/.npmrc` had a stray `allow-scripts=happy` line that npm 11 rejects as
  `EALLOWSCRIPTS`, aborting `npm ci` on the `congress-trading-shared` git dependency (and `npm ci`
  wipes `node_modules` first → full outage), and (2) `brew` had bumped the default `node` 24→26
  (npm 10→11) though the repo pins node 24 (`.nvmrc`). Fixes: emptied `~/.npmrc`
  (backup `~/.npmrc.bak-20260706-deploy`), `brew link node@24` as default, hardened
  `~/apps/trading-publish.sh` to force `node@24` on PATH so future brew drift can't rebreak deploys.
- 2026-07-04 - `trading-live` published docs-only PR #446 at `497d06c9` on
  `socratictrade.com`; production health 200; repo mirror now records Codex PR
  #442 and PR #444 as deployed. This is the current production HEAD and contains
  the prior deployed code commit `1e1a15bc`.
- 2026-07-04 - `trading-live` published at `1e1a15bc` (PR #444) on
  `socratictrade.com`; production health 200; tokenless public HTTPS
  `congress-trading-shared` dependency path is live in the deployed build.
- 2026-07-04 - `trading-live` contains `94669873` (PR #442); production health
  200; Codex console/UI swimlane is live, including approval provenance/citations,
  mobile LIVE phrase parity, Sheet focus trap, read-only decision trace, ticker
  drawer parity, and Strategy custom-model select parity. Verified Deploy
  workflow success, PM2 `trading` online, `/api/health` 200, and built
  route/page artifacts present under `.next/server/app`.
- 2026-07-04 - Documentation update: added durable naming notes to `AGENTS.md`,
  `/Users/jay/apps/README.md`, and `docs/EFFORT-LOG.md` that
  `Socratic.Trade` is canonical and `Socratic.Trading` is a typo/mistake; also
  corrected the remaining stale `git -C ~/Code/Agentic\ Trading ...` worktree
  command in `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops correction: renamed the main Code-folder worktree from the
  mistaken intermediate `/Users/jay/Code/Socratic.Trading` to the intended
  `/Users/jay/Code/Socratic.Trade`, repaired Git linked-worktree metadata,
  recreated and saved PM2 `trading-main` from the corrected path, verified
  local 4001 and production health, and updated active coordination path
  references in `AGENTS.md` and `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops cleanup: deleted the stray `robinhood-agentic` Pinecone
  index from the new Pinecone account; verified Infisical still exports
  `PINECONE_INDEX_NAME=socratic-trade` and Pinecone now lists only
  `socratic-trade` with 95 vectors. Renamed the main Code-folder project
  worktree from `/Users/jay/Code/Agentic Trading` to
  `/Users/jay/Code/Socratic.Trade`, repaired Git linked-worktree metadata
  including nested `.claude/worktrees`, recreated `trading-main` from the new
  path via `scripts/infisical-run.mjs`, saved PM2, and verified local 4001
  health plus production `socratictrade.com` health. Updated the active
  coordination path references in `AGENTS.md` and `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops mitigation: investigated stray `robinhood-agentic`
  Pinecone index in the new account. It contains 16 SEC 8-K vectors, not
  Robinhood trade/account data, and was consistent with a stale worktree using
  the old `robinhood-agentic` fallback while pointed at the new Pinecone key.
  Added Infisical prod `PINECONE_INDEX_NAME=socratic-trade`, restarted
  `trading`, `trading-main`, and `trading-codex`, verified main/Codex preview
  envs are pinned, production health is 200, and Pinecone counts at the time
  were `robinhood-agentic=16`, `socratic-trade=95` before the later cleanup.
- 2026-07-04 - Ops rotation: `ADMIN_REINDEX_TOKEN` added to the
  Socratic.Trade Infisical prod app project (`socratic-trade`), production
  `trading` PM2 process restarted, and `/api/admin/reindex-10k` verified as
  gated: no identity -> 401, identity without token -> 403, identity plus token
  -> 200 against Pinecone index `socratic-trade` with 95 vectors. Token value
  was not committed or logged.
- 2026-07-04 - `trading-live` published at `d39e1193` (PR #353) on
  `socratictrade.com`; production health 200; explicit local mock Test Account
  can be added without becoming the default account, and Pinecone/Voyage/provider
  cap trips now route through `budget_alert` with email-capable fallback.
- 2026-07-04 - `trading-live` published at `a017624a` (PR #354) on
  `socratictrade.com`; production health 200; new Pinecone `socratic-trade`
  index verified at 95 MSFT 10-Q vectors with matching local chunk ledger, and
  SEC filing ingest now uses deterministic vector ids for retry safety.
- 2026-07-03 - Ops rotation: Pinecone key replaced in Infisical prod and local
  preview env files (`trading-claude`, `trading-codex`, `trading-antigravity`);
  explicit RAG/Pinecone write fuses set in Infisical and preview envs; production,
  Codex, and Claude PM2 processes restarted; new Pinecone account has empty
  `socratic-trade` cosine/1024 serverless index (`vectors:0`). Key value was not
  committed or logged. `trading-main` PM2 env also refreshed through Infisical
  without touching tracked files in the dirty integration checkout.
- 2026-07-03 - `trading-live` published at `afbe1c87` (PR #352) on
  `socratictrade.com`; production health 200; RAG provider/quota failures now
  emit Sentry events when `SENTRY_DSN` is set, Pinecone-hosted NVIDIA/MSFT
  embeddings are documented as benchmark candidates, and Infisical current
  project naming is `Socratic.Trade` / `socratic-trade`. Fresh Pinecone key was
  not committed or logged.
- 2026-07-03 - `trading-live` published at `0941b4d2` (PR #349) on
  `socratictrade.com`; production health 200, Google/GitHub OAuth redirect URIs
  verified on the Socratic domain, and Codex preview synced back to main.
- 2026-07-03 - `trading-live` published at `481e9dcc` (PR #347) on
  `socratictrade.com`; production health 200 and S&P/Nasdaq mutual-exclusion UI
  behavior verified.
- 2026-07-03 - `trading-live` published at `7b803bff` (PR #346) on
  `socratictrade.com`; production health 200 and live Roth IRA Settings page verified.

## Completed
- **Infinite loading fix for SSE events aborting fetchDashboard (AG) — ✅ COMPLETED 2026-07-09.** Owner reported the app getting stuck on the loading screen. Root cause: frequent server-sent events (`market-data`) triggering `queueRefresh` were constantly aborting `fetchDashboard` requests before they could complete. Modified `useConsoleData` to mark interval and SSE refreshes as `background: true`, preventing them from aborting requests that are already in flight.
- **Reviewed-by-model proposal stamp (AG, branch `agent/antigravity-reviewed-by-model`) — ✅ COMPLETED 2026-07-10.** Resumed and verified the `reviewedByModel` proposal stamp task. Stamped `reviewedByModel` on trade proposals during the Red Team review loop, persisted it in closed lots, propagated it to the model stats API, and aggregated realized performance symmetrically for the Reviewer role. Gate green: tsc clean, lint 0 errors, 3168 tests passed, Next.js build clean. PR opened via `land.sh`. See [2026-07-10-reviewed-by-model-proposal-stamp.md](file:///Users/jay/Code/Socratic.Trade/docs/rollouts/2026-07-10-reviewed-by-model-proposal-stamp.md).
- **MONET usage-cap pickup (CLAUDE, owner-directed, worktree
  `.claude/worktrees/monet-usage-cap-work-0038cf`) — ✅ COMPLETED 2026-07-09 evening.** MONET
  capped ~17:05 CDT mid-merge-shepherding; CLAUDE picked up everything in flight. (a) All 6
  blocked MONET PRs landed: #1229/#1222/#1221/#1215/#1193 MERGED, #1228 armed post round-2 +
  conflict resolution. 38 codex findings across two review rounds triaged with adversarial
  verification — every real one fixed with regression tests, money-path diffs independently
  diff-reviewed pre-push; late fixes ride follow-ups #1265 (MERGED) /#1266/#1267/#1269 (armed).
  (b) Un-landed lanes recovered: vitest tmpdir-leak #1268 MERGED, settings-UX #1270 MERGED
  (incl. real policy-diff looser/tighter bug), enrichment-starvation #1272 armed. (c) Verified
  merged pre-cap: #1224, #1227, #1209 (+LoadingBrand), #1217. (d) Deferred: activity audit
  (MONET's to resume), broker-min bump-to-floor (unstarted), PR #1083 close (owner call, dup of
  #1082). NO deploys (migration hold honored) — next release also activates TwelveData fix +
  6 AV keys. Rollout: `docs/rollouts/2026-07-09-monet-usage-cap-pickup.md`. _(An earlier
  In-Progress row for this pickup was clobbered by the 18:22 board union-merge job — live-only
  rows don't survive it; worth a job fix.)_
- **Short stop-loss default (8%) + surface short settings in main Essentials (MONET, branch
  `monet/short-stop-default-and-surface`) — ✅ COMPLETED 2026-07-09: PR #1221 squash-merged to
  `main` (codex threads fixed+resolved by the CLAUDE usage-cap pickup; spec-copy follow-up
  #1265 also merged).**
  Owner-directed fix: enabling short selling with
  otherwise-default settings rejected every short proposal because the mandatory short-stop gate
  (`policy.ts:433`) had nothing to pass by default. `DEFAULT_RISK_RULES` (`src/lib/defaults.ts`)
  now sets `shortStopLossPct: 8` — a real default (not a `?? stopLossPct` gate fallback, per
  owner's explicit instruction) that flows through `mergePolicy`'s `riskRules` deep-merge to every
  policy without an override. Gate logic itself unchanged. Also moved the four `SHORTS` fields
  (`app/console/guardrails/page.tsx`) from a collapsed "Short selling" `AdvancedGroup` in the
  Advanced rulebook card to the bottom of the main Essentials card, and updated the
  `shortStopLossPct` hint copy (`field-defs.ts`) to reflect the new default. Sanity-checked:
  `evaluateTradeProposal` against a default policy with `shortSellingEnabled: true` (no explicit
  stop override) now approves a well-sized short. Gate green: tsc clean, lint 0 errors, 3168
  tests, build clean. See `docs/rollouts/2026-07-09-short-stop-default-and-surface.md`.
- **Model Stats drawer widened on desktop (MONET, branch `monet/model-stats-drawer-wide`) — COMPLETED
  2026-07-09, merged to `main` via PR #1213 (auto-merge armed).** Owner-directed console-UI fix: the Model Stats drawer's 4-column
  table (Model / Cost / Latency / Realized performance) was cramped inside the shared `Sheet`
  dialog's fixed 560px desktop width. Added an opt-in `wide?: boolean` prop on `Sheet`
  (`app/console/ui/sheet.tsx`) driving a new `.con-sheet-wide` class (`app/console/console.css`,
  `min(920px, calc(100vw - 32px))` on desktop; explicitly re-pinned to `width: 100%` inside the
  existing mobile `@media (max-width: 767px)` block so the bottom-sheet is unaffected). Only
  `ModelStatsButton` (`app/console/components/model-stats-drawer.tsx`) opts in — the other ~12
  `Sheet` call-sites (broker connect, policy review, order cancel/replace, approvals, account-scope
  sheet, etc.) are untouched. Gate green: tsc clean, lint 0 errors, 3168 tests, build clean. See
  `docs/rollouts/2026-07-09-model-stats-drawer-wide.md`.
- **Intro size-jump + loading-text fix (MONET) — COMPLETED 2026-07-09, merged to `main` as PR #1209.** Owner (prod, both viewports):
  wordmark still has a sudden SIZE change ~1s after the candles assemble; also remove the
  "Socratic Trade / Loading the autonomy desk..." text during load. Diagnosis: (a) the real
  HeaderLogo's canvas starts at width=height*13.8 (magic estimate) then JUMPS to
  height*wm.ar when its own effect runs -> width-only size change; the `13.8` estimate is
  used in header-logo.tsx initial width + shell MobileBrandRow, drifting from the real
  sampler AR; (b) intro-canvas `curHeader` is a per-effect local so a loading->loaded remount
  snaps the box. Fix: export single-source WORDMARK_AR from candle-ticker, use everywhere;
  persist curHeader; drop loading text. Fileset: app/console/ui/candle-ticker.ts,
  app/console/ui/header-logo.tsx, app/console/components/shell.tsx, app/console/components/intro-canvas.tsx.
- **Scoring-factor weight tooltips (MONET, S, branch `monet/scoring-factor-tooltips`) — COMPLETED
  2026-07-09.** Owner-directed display-only pass: added a hover tooltip (existing `Tooltip`
  primitive, `app/console/ui/primitives.tsx`) to each of the 8 "Scoring-factor weights" controls on
  the Strategy console page explaining what the factor measures and which direction more weight
  pushes candidate ranking, plus one sentence in the card intro clarifying the weights are relative
  (ratios matter, not absolute numbers). No scoring-math changes. Gate green: tsc clean, lint 0
  errors, 3168 tests, build clean. PR #1205 (auto-merge armed). See
  `docs/rollouts/2026-07-09-scoring-factor-tooltips.md`.
- **Drizzle ORM Migration (AG, branch `ag/drizzle-orm-migration`) — ✅ COMPLETED 2026-07-09 (PR via land.sh).** Refactored the app's database layer to use Drizzle ORM instead of the custom SQLite wrapper. Created schema definition in `src/lib/db/schema.ts` (tables: `settings`, `user_settings`, `market_data_demands` with constraints). Updated `src/lib/db-settings.ts` to fully use Drizzle queries. Verified: linting clean, types pass (`tsc --noEmit`), tests pass (`2970/2970`), and build succeeds. See `docs/rollouts/2026-07-09-drizzle-orm-migration.md`.
- **Picker copy: "Proposer"/"Reviewer" + AI-review panel "Strategist" (MONET, branch
  `monet/picker-copy-strategist`) — ✅ COMPLETED via PR #1202 (auto-merge armed).** Owner-directed pure display-copy
  follow-up to PR #1109 (`monet/model-picker-copy2`, which added "Model" to the picker labels):
  drops "Model" from both picker labels ("Proposer Model"→"Proposer", "Reviewer Model"→"Reviewer")
  in `app/console/settings/models.tsx` and `app/console/strategy/page.tsx`. This collided with the
  separate AI-review (strategy-tuning) panel's own "Reviewer model" field and its "Same As Red
  Team"/"Same As Green Team" default, so that panel's field is renamed "Strategist" (intro sentence
  now "A strategist model reads...", inherited-label ternary now renders "Reviewer"/"Proposer"). No
  functional/variable-name changes; all other Red Team/Green Team concept names untouched. Gate
  green: tsc clean, lint 0 errors, 3168 tests, build clean. See
  `docs/rollouts/2026-07-09-picker-copy-strategist.md`.
- Settings affordance and tooltip pass - add clearer option descriptions/tooltips,
  replace confusing loose/tight wording with lock/unlock-style affordances, and
  turn absolute-vs-percent constraint pairs into polished mode switches where
  they represent alternative ways to express one setting.
  2026-07-09 CODEX: COMPLETED via PR #1184 (`8b468260`). Scope was the smallest
  remaining tooltip-only slice: added missing native titles to bare Guardrails controls in
  `app/console/guardrails/page.tsx`. Keepout honored: MONET-owned model-picker/catalog
  files were not touched. Full local gate and GitHub `verify`/smoke were green before
  auto-merge. Not yet production-deployed after `8b468260`; MONET confirmed it rides the
  next natural release.
- Universal ticker detail drawer parity - restore old-site discoverability by
  making ticker symbols open a shared right-side drilldown drawer consistently
  across scan, home, evidence cards, proposals, orders, activity, outcomes,
  approvals, and watchlist.
  2026-07-09 CODEX: COMPLETED via PR #1181 (`70c0698e`). Re-claimed on branch `codex/console-parity-next`
  (`/Users/jay/.codex/worktrees/socratic-codex-console-parity`) after read-only audit of
  `origin/main`. Scope was the smallest remaining gap only: add the existing `SymbolButton`
  affordance to Home evidence cards in `app/console/page.tsx`. Keepout honored: model-picker
  files and drawer host/API files remain MONET-owned/adjacent. Full local gate and GitHub
  `verify`/smoke were green before auto-merge. Not yet production-deployed after `70c0698e`.
- **Mobile chrome bar fixes, 6 owner-reported items (MONET) — DEPLOYED 2026-07-08 via
  `nitgo442` (merged as PR #1173).** Owner (prod phone
  screenshots): (1) account dropdown wider on mobile; (2) Running/Autopilot indicator
  unboxed + stacked two-line small on mobile (looked like a second dropdown); (3) profile
  button 44px tap target on mobile; (4) theme toggle moves INTO the profile menu (off the
  bar); (5) profile menu becomes a slide-DOWN dropdown under the header (old bottom Sheet
  was covered by the mobile tab bar -> sign-out unreachable); (6) profile button shows the
  Google/GitHub avatar (snapshot.currentUser.imageUrl already wired, never rendered); plus
  STOP button squeeze fix (shrink-0 + centered content). Fileset:
  app/console/components/chrome.tsx, app/console/components/shell.tsx (ChromeBar),
  app/console/console.css.
- **Intro landing fixes: viewport-true fallback box + eased retarget + fade gated on real
  logo (MONET) — DEPLOYED 2026-07-08 via `nitgo442` (merged as PR #1170).** Owner-reported on prod: mobile wordmark assembled a few sizes too small then
  popped larger; desktop logo vanished ~1s between overlay fade and full page load. Root
  cause: intro can finish against the loading shell and lands on a stale hard-coded fallback
  box; reveal then has no mounted logo. Fix in `intro-canvas.tsx` only: fallback box now
  matches the real logo geometry per viewport (<lg = MobileBrandRow formula, >=lg = bar
  logo), landing box eases to the measured target instead of snapping, natural fade waits
  for a settled measured target (8s timeout safety; skip stays immediate).
- **Shared-dep proper-usage cleanup refresh (CODEX, S) — completed 2026-07-08 via PR #1171.**
  Replaced dirty Cursor PR #1105 without editing the Cursor branch. Merged to `main`
  as `54b6d722`; #1105 closed as superseded and stale PR #856 closed as obsolete. Cleanup uses
  shared `CONGRESS_EVENT_TYPES` for event-type checks, derives outbound payload typing from shared
  `SharePayload`, and drops unused `API_PATHS`/`MAX_REFS_BATCH` imports. Verified locally and in CI:
  lint 0 errors, tsc clean, 3101 tests, build, smoke, verify, gitleaks, Cursor Approval all green;
  zero active unresolved review threads.
- **Centralize Congress API Client Factory (AG) — COMPLETED 2026-07-08.** Refactored Congress Trade API interaction into a central factory `src/lib/api-clients/congress.ts`. Replaced `src/lib/congress-trade-client.ts`. Updated features to reliably check `CONGRESS_TRADE_READS_ENABLED` and `CONGRESS_TRADE_ANALYTICS_ENABLED` gating flags. Verified: tests pass 2970/2970, build green. PR via land.sh.
- **Consolidate usage telemetry clients in consumer apps (AG) — ✅ COMPLETED 2026-07-06 (PR #1005).** Replaced `postBatch` telemetry sending logic with `@jaywedgeworth22/congress-trading-shared` in Socratic.Trade.

- **Strategy exec/stops/LLM troubleshooting fixes (MONET) — COMPLETED 2026-07-07: PR #1036 squash-merged to `main` @ `e73c66a4` (verify green, auto-merge).** Owner-directed after prod forensics on Alpaca-paper `PA33IDTHMFK9`; all four money-path workstreams delivered + adversarially reviewed (1 HIGH cross-tick double-sell finding fixed+tested pre-merge): (1) DeepSeek effort transparency (no silent medium→high; thinking opt-in; UI shows true effort sent) + reasoning-aware env-tunable timeout (150s thinking) + `llmFetchCapturing` latency/late-reply capture (`llm_call_latency` + `llm_late_response` audits — a paid slow reply is recorded, never severed); (2) protective Risk-Exits route as MARKET (`coerceProtectiveExitToMarket`) + `autoRemediateStaleExitOrders` cancel-replaces stale EXIT limits at the 15m tick (exits only; live+typed-confirm defers to human; in-flight guard + 5-min per-order cooldown against double-sells; `policy.autoRemediateStaleExits` default on); (3) per-trade stops — `atrStops`/`betaScaledStops` default ON, Bull/Bear schemas expose `bracketStopLoss`/`bracketTakeProfit` + prompt guidance, `enrichOpeningProposal` validates + per-symbol fallback (ATR>beta>flat); (4) `ALLOW_LIVE_TRADING` flipped to opt-OUT escape hatch + notification retry on transient failures. Verify: tsc 0 / lint 0 / 2888 tests / build. **OWNER NOTE at next prod deploy: the Robinhood live acct trades on its environment unless `ALLOW_LIVE_TRADING=false`.** Deferred: per-symbol synthetic *trailing* stop (needs beta/ATR in the scheduler-tick monitor). Rollout note `docs/rollouts/2026-07-07-strategy-exec-stops-llm-fixes.md`. _(Correction 2026-07-08, intro-anim MONET session: this is now DEPLOYED — in production since deploy n1v296/rjskkyzx; the OWNER NOTE above is therefore LIVE and was re-surfaced to the owner at the rjskkyzx release. Mirror row flip rides the release-close-out docs PR.)_
- **Run the as-of epoch Pinecone backfill (ops, MONET) — COMPLETED 2026-07-07 (ops run done; docs PR #1033 squash-merged to `main`).** The deferred operational follow-up from CLAUDE's #1019 (server-asof-filter): executed `scripts/backfill-asof-epoch.ts` against the shared default Pinecone index, operator ("local") key — dry-run → real run → idempotency re-run. Counts: 341 scanned / **309 updated** / 32 already epoch'd (post-#1019 ingests) / **0 undated / 0 errors**; re-run = 341/341 skippedHasEpoch, 0 updated. Corpus fully epoch-stamped: `VECTOR_ASOF_SERVER_FILTER=on` now safe AND effective; `VECTOR_ASOF_STRICT=on` would currently drop nothing (no undated vectors exist). Rollout note `docs/rollouts/2026-07-07-asof-epoch-backfill-run.md`. **UPDATE 2026-07-08 (owner-directed): `VECTOR_ASOF_SERVER_FILTER=on` is now LIVE in prod** — set in Infisical prod (authoritative) + Coolify app env (redundant copy, pending cleanup), container restarted on the Coolify box (deployment `umphe8pw`, finished, health green: db ok / scheduler 7s / pinecone ok). Confirmed prod `PINECONE_INDEX_NAME=socratic-trade` == code default, so the backfilled index IS the one prod queries. `VECTOR_ASOF_STRICT` remains OFF (backtest-lane choice). The flip fight also surfaced: box disk-full incident (owner freed, 15GB now), a zombie-deployment queue jam, and a Coolify cancel-API bug (500 but works) — details on #agent-sync 2026-07-08. **CLOSED 2026-07-08 with the env-split cleanup:** ADMIN_HOST + AUTH_COOKIE_DOMAIN moved into Infisical prod, redundant Coolify copies (incl. the flag) deleted — Coolify app envs are now bootstrap-only and Infisical prod is the single source of truth for app runtime config. Parity restart verified in the app process via box SSH (`/proc/<pid>/environ`): all 3 keys correct, litestream→R2 replicating (health's litestreamState=unknown is a blind metric — fix task chip spawned), health green.
- **PRs #1019 / #1021 - CLAUDE RAG: server-side as-of Pinecone filter + persist-pool v2 (2 owner-approved
  deferred items).** Both merged to `main` 2026-07-06 (verify/smoke/gitleaks green, auto-merge).
  Owner approved the design (fail-open + strict escalation). **#1019 server-side as-of filter:** writes a
  numeric `as_of_epoch_ms` at ingest (cleanMetadata) and pushes the point-in-time constraint INTO the
  Pinecone query (`$or:[{$lte},{$exists:false}]` fail-OPEN by default; the post-fetch `isWithinAsOf` guard
  stays the unconditional leakage backstop) so topK fills with ELIGIBLE chunks instead of being decimated
  post-fetch (fixes backtest "empty small pools"). `VECTOR_ASOF_STRICT` escalates to fail-CLOSED for
  certified backtests; `VECTOR_ASOF_SERVER_FILTER` operator gate (default OFF); idempotent non-destructive
  metadata backfill (`scripts/backfill-asof-epoch.ts`, dry-run-able) — run it before enabling. Review
  confirmed Pinecone v8 `update` MERGES metadata (backfill can't corrupt the corpus) and the `$and`/scope-`$or`
  composition doesn't widen scope. **#1021 persist-pool v2:** captures the PRE-`rankPool` `matches` pool with
  per-stage drop dispositions (minScore/asOf/dedupe/dedupe_truncate/rerank-floor/rerank-truncate/not-used/used)
  via an optional `rankPool` hook — closes v1's post-rankPool-only limitation. `RAG_PERSIST_CANDIDATE_POOL_FULL`
  (default OFF, byte-identical when off). Review caught + fixed: `dropped_dedupe` mislabeling limit-cap
  truncation (new `dropped_dedupe_truncate`), an id-less-rerank-survivor mislabel, and hardened BOTH v1+v2
  captures so a capture bug can never empty a retrieval. All advisory/observability-only; flags default-off; no
  MONET/CODEX/AG lane files touched. Rollout notes: docs/rollouts/2026-07-06-server-asof-filter.md,
  -persist-pool-v2.md. (These close the two follow-ups deferred from the 2026-07-06 next-wave RAG cluster.)
- **Accessible tooltip/popover primitive everywhere (AG, S)** — ✅ COMPLETED 2026-07-06. Added a reusable `Tooltip` primitive to `app/console/ui/primitives.tsx` supporting accessible hover/focus. Performed a console-native title replacement pass upgrading `Chip`, `Stat`, `Ago`, `TickerLogo`, and `ProviderLogo` to use the Tooltip component instead of native `title` attributes.

- **Retire duplicate API client in Socratic.Trade (CURSOR, M)** — ✅ COMPLETED 2026-07-06. Branch `cursor/retire-client-dups`. Replaced local `SseParser` class and `createSubscription`/`streamUrl` in `congress-stream.ts` with shared `@jaywedgeworth22/congress-trading-shared` imports (`SseParser`, `CongressTradeClient`). Updated shared-dep to v1.4.1. Bumped `congress-trade-client.ts` to use `CongressTradeClient` for all endpoints (bundle/ref/refs/prices/spx/fundamentals/analyst/transactions/analytics) with preserved feature gates, health logging, and timeout logic. All 62 congress tests pass, tsc clean.

- **PRs #970 / #973 / #974 / #977 / #979 - CLAUDE next-wave RAG retrieval-quality + corpus-integrity
  cluster (CLAUDE).** All merged to `main` 2026-07-06 (verify/smoke/gitleaks green, auto-merge).
  Triage-first (9 rows: 3 already-done, 1 deferred for owner design, 5 built) → adversarial review
  (caught a real corpus-coverage daily-false-positive BLOCKER + a cross-lane held-scope/typed-status
  fallback bug + nits, all fixed pre-merge) → sequential land under strict branch protection
  (Copilot threads resolved per PR). #970 typed retrieval-status receipt; #973 episodic golden-eval +
  #822 single-vs-multi-query coverage; #974 held positions in RAG/learned-context/episodic scope;
  #977 corpus-coverage receipt (both-conditions on 10-k/10-q, low-noise); #979 flag-gated candidate-
  pool persistence (honest post-rankPool scope). Advisory/observability-only throughout; flags
  default-OFF; no MONET/CODEX/AG lane files touched. Rollout notes: docs/rollouts/2026-07-06-*.
  Deferred (owner decision): server-side numeric as-of Pinecone filter; persist-pool v2 pre-rankPool
  drop capture. Repo-mirror rows + session rollout note closed out via a follow-up docs PR.
- **Congress Score Eval UI Wiring (AG) — ✅ COMPLETED 2026-07-06.** Wired `congressScoreVerdict` into the `MarketScanTab` on the console dashboard. The signal verdict, stats, and gating status are now explicitly surfaced in the UI. Lint, tsc, and Next.js build all pass.

- **PR #844 - `claude/pr805-remediation`: P0 checkRegimeFlip RMW fix + P1 backlog + AG connection-health
  slice, merged as one honest PR (CURSOR + AG + CLAUDE remediation) — ✅ COMPLETED, merged 2026-07-05
  (squash `ebcf6a23`).**
  _2026-07-05 (CLAUDE audit-c3): Origin-verified CRITICAL correction — the cycle-2 rows across this
  board asserting the P0 multi-user regime RMW race and security headers are NOT on `main`, and that
  CONFLICTING PR #805 is "the only vehicle," are now FALSE. #844 landed: per-user
  `regime:current:${userId}` keys + legacy-row migration in `src/lib/regime-watch.ts` (confirmed
  present); HSTS/X-Content-Type-Options/Permissions-Policy response headers in `middleware.ts` +
  `test/security-headers.test.ts` (confirmed present); `LLM_SPEND_CEILING`; and the effort-orphan
  report. #844 merged BOTH the Cursor P0/P1 commit (`0ce39474`) and the AG connection-health slice
  (`b88981c4`) cleanly onto `main`, plus fixed all 16 Codex review comments from #805 (each thread
  replied + resolved). PR #805 (`cursor/session-2026-07-05`) is CLOSED as superseded — no action
  needed on it. This supersedes and closes out: the "PR #808" row (previously Completed, moved
  here), the "Admin connection health and backend-failure notification pass (AG)" row (previously In
  Progress, moved here), and the cycle-2 "Disentangle PR #805" / "Migrate legacy regime:current row"
  Planned rows (retired as moot, see the strikethrough notes on those rows). Gate green via land.sh:
  lint 0, tsc clean, 2644 tests, build ok. Full prior resolution history (phantom-PR discovery,
  CONFLICTING diagnosis, RESOLVED note naming #844 as the real vehicle) is preserved on the two
  relocated placeholder rows in Completed rather than deleted._
  Scope landed: **P0 fix** — removed `"local"` default from `checkRegimeFlip`, per-user regime keys
  (`regime:current:${userId}`), per-user scheduler iteration, eliminating the multi-user RMW race on
  a single `regime:current` settings row, plus first-tick migration of the legacy shared row. **P1
  backlog** — security response headers (HSTS, X-Content-Type-Options, Permissions-Policy),
  unpriced-model default cost fallback, synthetic bid/ask boolean provenance, scheduler health
  threshold, operator monthly LLM spend ceiling (`LLM_SPEND_CEILING`), effort-mirror orphan report
  script, Litestream PITR retention. Global symbol omnibox remained blocked by Codex console/UI
  keepout (not in this PR). **AG connection-health slice** — every backend dependency surfaced in
  `/api/health` and `ops-snapshot` (Database, Pinecone, Voyage, FMP, Massive, etc.); health check
  fails (503) on critical global outages (5 consecutive failures on Database/Pinecone/Voyage); global
  connection failures routed to admin (Sentry, audit log, `PRIMARY_USER_EMAIL` via Resend) while
  user-key failures stay on user in-app notifications; disk headroom, DB+WAL size, and Litestream
  last-sync age monitoring integrated with cooldown-controlled degradation alerts.
  Rollout doc: `docs/rollouts/2026-07-05-cursor-session.md` (describes intended scope; now
  confirmed-merged via #844).

- **Harden HMAC Security & Persistent Idempotency for webhooks (AG, M) — ✅ COMPLETED via PR #854 (2026-07-05).** Updated `congress-webhook-auth.ts` to validate `X-Signature` header via HMAC SHA256. Created `processed_webhooks` db table and integrated persistent DB check in `markSeen` alongside in-memory cache to ensure persistent idempotency across server restarts. Lint and tests green.
  _2026-07-05 (CLAUDE audit-c3): CORRECTION — this row is mis-filed. Per protocol "Completed" = merged
  to `main`; `gh pr view 854` shows state **OPEN**, mergeStateStatus **BLOCKED** (all CI green —
  verify/smoke/gitleaks/autofix/classify SUCCESS — reviewDecision empty, no auto-merge armed). Blocked
  by the main-protection ruleset requiring review/thread-resolution, not by code. Moved to Completed
  below pending actual merge; do not let the issues-sync mirror close its tracking issue off this
  stale Completed text. action=land-it._
- **Push account status metrics to Usage Monitor (AG, M) — ✅ COMPLETED 2026-07-05.** Send telemetry events with `metricType: "balance"` or `"limit"` to the API Usage Monitor to track tech account caps and credits. Telemetry wired into Alpaca and Robinhood `getPortfolio` calls. Lint, tsc, and tests green.
- **Eliminate redundant fill-history fetch/replay (AG, M) — ✅ COMPLETED via PR #850 (merged 2026-07-05).** Fills fetched once in `runStrategyOnce` and passed down through all scorecard and sizing calls, eliminating up to 8 duplicate DB queries per run. Unified unit test added to `test/performance.test.ts` to assert that prefetched fills are used and DB query counts are bypassed. Lint 0, tsc clean, Next.js build green.
- **PRs #816 / #819 / #820 / #822 - CLAUDE planned-backlog train: prompt-safety fencing, usage-budget
  advisory wiring, durable due-jobs substrate, HyDE+multi-query retrieval (CLAUDE). → DEPLOYED to
  production 2026-07-06 as part of the `7b5450fe` publish (see Deployed section top).** All merged to
  `main` 2026-07-05 (verify/smoke/gitleaks green, auto-merge; squashes `041b73b2`/`f28322fe`/
  `e90db1a8`/`d97b7c71`). Every lane: triage-first (6-agent pass found 3 of 7 claimed rows already
  done — RAG eval harness + prereqs = PRs #297/#299, prompt eval + PROMPT_VERSION = 2026-07-01
  landing, per-user/day LLM ceiling = PR #316), then build (Sonnet lanes, frontier for money-path
  prompts), then independent adversarial review (3 blockers caught pre-merge: budget downgrade
  persistence leak via cap-breach setPolicy, due-jobs stale-merge lost-update vs worker rows,
  HyDE fail-closed fan-out), review-fix commits, sequential land.sh gates (suite grew
  2577→2587→2619). #816: Bull/Bear untrusted blocks fenced w/ data-not-command clauses,
  deterministic injection-attempt + evidence-age receipts (advisory, never blocks),
  reflection_summary out of SYSTEM, learned-fact provenance inline, STRATEGY_PROMPT_VERSION 1.5.0.
  #819: usage_budget_status receipt + budgetAdvisory prompt line every configured run;
  USAGE_BUDGET_ENFORCE opt-in downgrade/skip w/ receipts, run-scoped only (never persisted);
  downgrade reaches Bear + reflection. #820: due_jobs table (migration v11) + db-jobs.ts
  lease/reclaim queue + scheduler-tick worker guaranteeing 15m/1h outcome samples survive downtime;
  due_jobs in account-deletion scope. #822: RAG_MULTIQUERY/RAG_HYDE (default OFF, byte-identical
  off-path) evidence-derived variants + HyDE passages RRF-fused into filings retrieval, budget-gated,
  fail-open per-variant w/ single-query fallback. Rollout notes: 2026-07-05-prompt-safety-fencing /
  -usage-budget-advisory-wiring / -durable-due-jobs / -hyde-multiquery-retrieval.md.

- **PR #811 - Console live-data build-out (CODEX, L).** Merged to `main` 2026-07-05T07:37:48Z
  (verify/smoke/gitleaks green, auto-merge). _2026-07-05 (CLAUDE next-wave): CORRECTION — this row
  was previously logged under Completed as "PR #811 open, squash auto-merge enabled"; #811 has
  since merged (verification quartet was green pre-merge). Moved to Completed._ Worktree
  `/Users/jay/.codex/worktrees/socratic-console-live-data`, branch `codex/console-live-data`.
  Consumes `/api/events/stream` in the console data layer, surfaces live connection/freshness
  state, and upgrades overview mark-to-market / risk utilization / open positions blotter /
  intraday equity view using existing components first. Verification pre-merge: `npm run lint
  -- --quiet`, focused live-data vitest (`4`), full `npm test` (`257` files / `2510` tests),
  `npm run build`, `npx tsc --noEmit` (after build regenerated `.next/types`). Keepout: settings,
  approvals, Monet risk, Claude memory/RAG, unrelated tooltip sweeps respected.
- **PR #810 - Coach chat -> framework primitives (CODEX, M).** Merged to `main`
  2026-07-05T17:40:38Z (verify/smoke/gitleaks green, auto-merge). Decision-trace coach-note POST
  can optionally promote into lesson/framework primitives, framework review carries explicit
  rewrite/ownerResponse semantics, and the trace renders linked run metadata when available.
  Verification pre-merge: focused `test/socratic-db.test.ts` (3 tests), TypeScript, quiet lint,
  full `npm test` (256 files / 2507 tests), and `npm run build`.
- **PR #806 - Scan table column customization parity (CODEX, M).** Merged to `main`
  2026-07-05T15:01:24Z (verify/smoke/gitleaks green, auto-merge after review threads resolved).
  `/console/scan` now supports browser-local column visibility, ordering, reset, and saved state;
  review fixes pin `symbol` as the first/sticky column and defer saved `localStorage` state until
  after mount to avoid hydration mismatch. Verification included focused scan-column tests, lint,
  TypeScript, full suite, build, and review-fix reruns.

- **Pre-policy vetoes advisory-overridable (CLAUDE, #799 follow-up) — merged PR #814 (verify+smoke green).**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — this row's text already said COMPLETED/merged but it
  was physically still sitting under the Completed heading; relocated to Completed (issues mirror
  keys off section classification, so a correct-text row in the wrong section was still showing as
  open)._ Branch `claude/veto-advisory-overridable`, isolated worktree. Deterministic bear filter
  (Rules 3/4) + approval-time Red Team veto now TAG candidates with `preVetoReasons` instead of
  dropping → folded into the sized PolicyDecision → #799's `resolveSocraticOverride` (openings,
  socraticOverrideMode + cap). Rule 1 stays hard; Rule 4 overridable-but-flagged for owner
  ratification. FIX #1 (no counterfactual on override path — protects getRedTeamEfficacy) / #2b
  (durable deterministic_bear_veto audit) / #3 (propose-mode pre-route before sell-to-fund).
  Independent 3-lens adversarial verify caught + fixed 2 money-path bugs the green suite missed
  (severe phantom-funding-sell via `preVetoTaggedOpeningWillPlace`; free-text hard-gate
  misclassification via `isHardGateReason` prefix short-circuit), both regression-tested. Gate:
  tsc/lint-0/258 files-2540 tests/build. OVERLAP: unlanded `claude/redteam-policy-aware-routing`
  touches the same strategy.ts Red-Team branch — coordinated in-channel, rebase at land. See
  `docs/rollouts/2026-07-05-pre-policy-veto-advisory.md`.

- **Full-suite test determinism: de-flake order-confirmation-status + chat-orchestrator-search-knowledge (CLAUDE, S) — merged PR #812.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — same class of issue as the row above: text said
  COMPLETED/merged but the row was still under Completed; relocated to Completed._ Worktree
  `~/apps/trading-claude`, branch `agent/claude`. Root causes measured: (1) `executeProposal` tests
  ran a REAL market scan (Nasdaq screener + Yahoo, 6-8s abort timeouts + 429 backoff) — ~12-13s/test
  solo, past 30s under 4-worker load; (2) chat-orchestrator's first test paid the ~15s orchestrator
  module-graph import inside its own 20s testTimeout. Fix: partial-mock `scanMarket` at the
  market.ts boundary (importOriginal keeps the rest real) in order-confirmation-status +
  approval-lock (same class — its 2026-06-21 fix only padded timeouts); hoist the orchestrator
  import into `beforeAll(…, 120_000)`. After: reject/accept tests 12.9s/11.9s → 0.5s/0.02s;
  orchestrator first test 15.5s → 1ms; full suite 256 files / 2506 tests green in 20.77s wall. No
  src/ changes. See `docs/rollouts/2026-07-05-full-suite-test-determinism.md`.

- **Guardrails → overridable preferences (denylist) (MONET risk lane) — merged PR #799.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — same class of issue: text said COMPLETED/merged but
  the row was still under Completed; relocated to Completed._ Worktree `~/apps/trading-monet`,
  branch `monet/guardrail-overridable-denylist`. Owner directive: the ONLY hard rules are the
  account boundary + physical/broker/regulatory/accounting impossibilities; every other policy
  block is a light preference the agent may self-override with a logged `autonomyOverride` thesis.
  Inverted the Socratic override classifier from an allowlist to a DENYLIST: new
  `HARD_GATE_REASON_PATTERNS` + `isHardGateReason` source-of-truth in `policy.ts` (risk engine);
  `socratic-runtime.ts` `overrideableReason` = `!isHardGateReason`. Reclassified short-stop-required
  / bracket-required / policy-level short-disabled from hard→overridable; unlisted/new gates now
  default overridable instead of silently hard. Advisory-only (nothing auto-overrides;
  broker/account/regulatory hard gates untouched). New `test/hard-gate-classification.test.ts` pins
  the full matrix. Cross-lane touch to `socratic-runtime.ts` (CLAUDE's file) coordinated
  in-channel. Follow-ups: extend override to exits; make pre-policy vetoes (bear filter, Red Team)
  advisory. See `docs/rollouts/2026-07-05-guardrail-denylist-overridable-preferences.md`.

- **PR #807 - Approvals triage upgrades + alert center (CODEX, M).** Merged to `main`
  2026-07-05 (verify/smoke/gitleaks green, auto-merge). Adds pending-approval
  sort/filter, safe bulk non-LIVE actions via existing proposal endpoints, and a console
  alert center over existing notifications/activity data. Production deployment remains
  separate.
- **PR #694 - Effort-issues sync secondary-rate-limit hardening (CLAUDE, S).** Merged to `main`
  2026-07-05 (verify/smoke/gitleaks green, auto-merge). `scripts/sync-effort-issues.py` now
  survives GitHub secondary rate limits: 2.5s creation throttle, Retry-After/exponential-backoff
  retries under a bounded 300s per-run budget, and exit-0 "PARTIAL SYNC - resume on next run"
  summary on budget exhaustion (sync is idempotent). Propagated verbatim to
  congress-trading-shared (PR #27), api-usage-monitor (PR #38), and Congress.Trade (PR #162)
  - all merged 2026-07-05. Codex-review refinements (issue listing inside partial handling,
  server Retry-After honored uncapped, 1s update throttle) merged back via Socratic PR #796 and
  re-propagated (congress-trading-shared #29+#30, api-usage-monitor #40+#41, Congress.Trade in
  #162). All four repos' effort-sync workflows verified green post-merge.
- **PR #449 - Regime-enum adoption inside the risk gates (MONET risk lane).** Merged to `main`
  2026-07-04 (verify + smoke green, auto-merge). The three deterministic risk gates now classify the
  persisted regime label through the shared typed `MarketRegime` source of truth (`market-regime.ts`)
  instead of three independent substring/`startsWith` rules: crisis/inverted cap (`policy.ts`),
  bear-filter risk-off veto (`strategy.ts` `deterministicBearFilter` — the in-code comment that
  reserved this site "for the risk lane (Monet)" is now resolved), and the escalation gate
  (`regime-watch.ts` `isEscalationRegime`, also feeding the dissent trigger). The "one-line adoption"
  w1-regime-data (#368) exported the typed predicates + pinned `test/market-regime.test.ts` for.
  Correctness hardening only — canonical-label behavior byte-identical (incl. the Cautious-Inverted
  asymmetry); non-canonical free-text labels now read non-escalating instead of accidentally
  substring-matching. Imports `./market-regime` (not `./macro`) to survive the whole-module macro mock
  in `test/regime-watch.test.ts`. New gate-level regression `test/regime-gate-adoption.test.ts` + a
  `policy.test.ts` hardening case. Gate green: tsc/lint-0/2465 tests/build. KEEPOUT respected: no
  mem/RAG (CLAUDE) or console/UI (CODEX) files touched. See
  `docs/rollouts/2026-07-04-regime-enum-risk-gate-adoption.md`.

- **PR #374 - GitHub Issues mirror of the effort board (Claude, sonnet lane), cross-app.**
  Merged 2026-07-04. Additive, read-only owner-visibility layer over docs/EFFORT-LOG.md: boards
  stay the single source of truth, agents never write issues — a new workflow reconciles them.
  scripts/sync-effort-issues.py (python3 stdlib, no deps) parses the board (keyword-classified
  sections tolerant of heading/emoji drift, top-level bullets as items, SHA1-of-first-line
  identity marker for idempotent re-runs); Planned/Completed -> issue open
  (effort-board + state:planned|state:in-progress, assigned jaywedgeworth22 for mobile
  notifications), Completed/Deployed -> issue closed. New .github/workflows/effort-issues-sync.yml
  (push to main touching the board file, daily off-minute cron, workflow_dispatch). Rolled out
  identically to congress-trading-shared (PR #4) and API-usage-monitor (PR #9); protocol doc
  (/Users/jay/apps/EFFORT-LOG-PROTOCOL.md) gained an "Issues mirror (standard)" subsection +
  bootstrap-checklist update. Verified: parser tested against all three repos' real boards before
  rollout; a genuine duplicate board row (this repo's own "Wave-1 quick wins..." logged twice
  under Completed) was caught by a live dry-run and fixed with in-run dedup; full quartet green;
  post-merge first sync created 58 Socratic.Trade issues (32 completed/6 deployed closed, 9
  in-progress/11 planned open), 2 open issues in congress-trading-shared, 3 open issues in
  API-usage-monitor — all confirmed via the Issues API. See
  docs/rollouts/2026-07-04-effort-issues-mirror.md.
- **PR #371 - Fleet-wide Sentry observability (Claude, sonnet lane).** Merged 2026-07-04
  (`120968725f7e58f383917aafe5c63ec8cfcd10d0`), CI `verify` green. Sentry project `fleet-infra`
  (org jays-services). (a) `/Users/jay/apps/fleet-sentry-monitor/monitor.py` registered under pm2
  (`fleet-sentry-monitor`, `pm2 save`d, machine-side, not in this repo) — pm2 crash-loop (restart
  delta >= 5/interval, hourly-deduped fingerprints) + down detection (error for
  `trading`/`trading-main`, warning otherwise), disk free (<20GB warn/<8GB error) + known SQLite
  WAL >512MB warning, Claude.app presence/RSS (context only), `gh api rate_limit` <300 remaining
  warning, self-hosted runner status (context only), self check-in to Sentry Crons monitor
  `fleet-host-monitor` (interval 2min, margin 5, max_runtime 2, America/Chicago). Verified: two
  live pm2-driven passes completed check-ins ("ok"), a synthetic restart-delta test correctly
  fired the crash-loop error, and the real `gh` rate-limit warning fired live (fleet burned
  graphql to 0 during testing). Note: another agent has since continued iterating on
  `monitor.py` in place (adding per-app agent/app tags, Codex session breadcrumbs) — see the
  Codex coordination row above; this is expected concurrent enhancement of the same singleton,
  not a regression of this PR's scope. (b) `.github/workflows/sentry-ci-report.yml` +
  `scripts/sentry-ci-report.py`, ADDITIVE ONLY (zero edits to any pre-existing workflow): on
  `workflow_run: types:[completed]` across all 7 workflows that existed at authoring time (CI,
  Codex Autofix, Deploy, Sync Preview Lanes, Shared package pin check, Playwright Smoke,
  Security) — failure conclusion -> raw-envelope Sentry error event {workflow, branch, actor}
  fingerprinted [workflow, branch]; schedule-triggered runs -> Sentry Crons check-in mirroring
  that workflow's own cron (slugs `ci-security`, `ci-playwright-smoke`,
  `ci-shared-package-pin-check`). Repo secret `SENTRY_FLEET_DSN` set via `gh secret set` (value
  never echoed). Locally dry-ran the reporter script against the real DSN before pushing — both
  envelope POSTs returned HTTP 200. Landed via `scripts/land.sh` (merged `origin/main`'s
  concurrently-merged PR #370 cleanly first) + `gh pr merge --squash --auto`. See
  `docs/rollouts/2026-07-04-fleet-sentry-observability.md`.
- PR #370 - CI Actions efficiency: docs-only fast path on required `verify` (fail-closed gate-job pattern incl. --no-renames + !cancelled() Codex-review fixes), .next/cache restore/save split (PR restore-only, main-push save), cleanup-caches.yml (PR-close delete + daily prune backstop). Merged 2026-07-04; hybrid runner-routing follow-up continues as claude/ci-hybrid-runner-verify (PR #372).
- PR #350 - AI Review inheritance, model catalog, and text-box font controls.
- PR #349 - Socratic admin/RAG/Pinecone/settings parity implementation.
- PR #348 - Sell to Fund Buys title-case copy fix.
- PR #347 - Console universe index exclusivity fix.
- PR #346 - IRA wash-sale UI correction.
- PR #345 - Run-state UX fix.
- PR #344 - Socratic Trade Autonomy Desk implementation.
- PR #340 - Socratic Trade rebrand.

## Completed
- **Consolidate usage telemetry clients in consumer apps (AG) — ✅ COMPLETED 2026-07-06 (PR #1005).** Replaced `postBatch` telemetry sending logic with `@jaywedgeworth22/congress-trading-shared` in Socratic.Trade.
- **Fix mobile "Settings" crash inside Sheet (AG, S)** — Fixed "Maximum call stack size exceeded" bug caused by a focus trap race condition when navigating to settings from the More sheet menu on mobile. PR pending.

- **CLAUDE next-wave: RAG retrieval-quality + corpus-integrity cluster (CLAUDE) — COMPLETED 2026-07-06: ALL 5 lanes MERGED to main.** Follows the merged+deployed CLAUDE train (#816/#819/#820/#822 → prod `7b5450fe`). Triage-first (9-row read-only pass found 3 already-done: as-of-strict, train/serve embed skew, verify-reindex; 1 deferred: server-side numeric as-of Pinecone filter — needs an ingest-epoch backfill + fail-mode owner decision), then 5 lanes built → adversarial-reviewed → fixed → sequentially landed:
  **#970** typed-retrieval-status (typed ok/no_memory/lookup_failed/budget_skipped/degraded receipt, advisory, byte-identical for existing callers); **#973** rag-golden-eval-episodic (episodic/analog + hard-negative eval cases + single-vs-multi-query #822 comparison, test-only); **#974** held-position-retrieval-scope (held/open-position symbols now get filings-RAG + learned-context + episodic retrieval, incl. the sketch); **#977** corpus-coverage-receipt (advisory receipt when a producible filings doc type has zero corpus, both-conditions on 10-k/10-q where the ingest ledger is complete; 8-k/earnings-transcript excluded to avoid daily noise); **#979** persist-candidate-pool (flag-gated default-OFF persistence of the post-rankPool candidate pool incl. unused, honest about not capturing upstream drops — v2 pre-rankPool follow-up noted). Adversarial review caught 1 real BLOCKER (corpus-coverage would have false-fired 8-k daily) + a cross-lane bug (held-scope symbols omitted from #970's catch-block fallback) + several nits, all fixed before merge. KEEPOUT respected (no MONET risk-gate / CODEX console / AG data-provider files). Per-lane rollout notes under docs/rollouts/2026-07-06-*. Deferred/owner-decision: server-side as-of Pinecone filter; persist-pool v2 (pre-rankPool drop capture).
- **Codex autofix storm guard (CODEX, workflow/fleet-infra) — DONE-local 2026-07-05; awaiting push/PR.**
  Scope: reduce `codex-autofix.yml` storm odds/frequency by running the autofix loop once per
  Codex submitted review plus manual `workflow_dispatch`, not on every Codex inline/issue
  comment. Touch workflow callers only in clean Codex worktrees; preserve manual dispatch and
  round-cap behavior.

- **Harden HMAC Security & Persistent Idempotency for webhooks (AG, M) — moved back from Completed
  2026-07-05 (CLAUDE audit-c3).** PR #854 (`antigravity/socratic-webhooks`) is OPEN,
  mergeStateStatus BLOCKED, all CI green, reviewDecision empty, no auto-merge armed. Blocked by the
  main-protection ruleset needing review/thread-resolution — not a code issue. action=land-it; see
  the new "Resolve main-protection ruleset review gate" Planned row below for the structural fix.

- **Congress.Trade Improvements (AG, M)** — Comprehensive improvements across UI, data sharing, and scraping. Worktree `~/apps/trading-antigravity`, branch `agent/antigravity`.
  1. [x] **UI/UX Mobile Refactor**: Implement responsive cards/scroll for data tables in `dashboardHtml.ts`.
  2. [ ] **Shared Ticker Aliases**: Move ticker alias resolution logic into `congress-trading-shared`.
  3. [ ] **Typed API Client SDK**: Build and export a strongly-typed `CongressTradeClient` in the shared repo.
  4. [ ] **Senate Scraper Handshake**: Implement Cloudflare KV session caching for the Senate eFD agreement gate.
- **MONET 5 risk lanes — SUPERSEDED / ALREADY COMPLETED 2026-07-05 (CORRECTION).** All five lanes were already implemented + merged by CONCURRENT sessions while a MONET session was mid-build: **#875** redteam policy-aware routing (`7b5450fe`, prod-deployed 2026-07-06), **#881** multi-signal regime severity scorer, **#883** vol-targeting + portfolio-heat, **#945** fractional-Kelly, **#879** correlation + blackout + stress — all on `main`. This reclaim was too late; the MONET session's lane-1 (regime-severity) rebuild was a byte-different DUPLICATE of #881 and was ABANDONED unpushed (land.sh stale-overlap guard caught it before any push). No further action — MONET risk-lane work is DONE. Original (now moot) reclaim text follows. The five risk rows handed back to MONET (board "MONET risk-row handback"): `monet/multi-signal-regime-scorer` (credit spreads + VIX term structure + breadth → severity), `monet/vol-targeting-portfolio-heat` (continuous vol-target exposure taper + portfolio-heat budget), `monet/correlation-event-stress-gates` (EWMA/downside correlation gate + earnings/macro blackouts + pre-trade stress), `monet/fractional-kelly-sizing` (downside-dispersion fractional Kelly), `monet/redteam-policy-aware-routing` (Red-Team unavailable → policy-aware routing timeout/429/malformed; builds on merged #814). All advisory/owner-overridable (never a cage), new-module-first (minimal policy.ts/strategy.ts diffs), built off current `main` on `monet/*` branches (the old empty `.claude/worktrees/monet-*` `claude/*` branches are NOT reused). Running a 5-lane design team, then implementing lane-by-lane with builder + adversarial verify, one PR per lane via `land.sh`. The old CLAUDE-pickup "Risk-lane implementation train" row below is superseded by this handback reclaim.

- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX, shared fleet-infra) —
  DONE-local 2026-07-05; awaiting owner approval to push/open PRs.** Scope: audit/standardize Codex Cloud repo-visible setup so remote
  Codex sessions can read `docs/EFFORT-LOG.md` and use #agent-sync with the configured
  `SLACK_AGENT_NAME`, `SLACK_CHANNEL_ID`, `SLACK_PROJECT`, and runtime token/env settings. Keep
  work out of dirty Cursor/Monet worktrees; reuse/adapt the closed PR #367 Slack helper rather than
  creating a competing Slack Socket Mode client. Cross-app rows mirrored in the other live boards.
- ~~**PR #808 - Cursor session: P0 checkRegimeFlip RMW fix + P1 backlog exhaustiveness (CURSOR)**~~
  _2026-07-05 (CLAUDE audit-c3): MOVED TO COMPLETED — origin-verified #844 (squash `ebcf6a23`) is
  merged to `main`, confirmed containing the P0 per-user regime keys, security headers, and
  LLM_SPEND_CEILING. Full history relocated to the Completed section under "PR #844 -
  pr805-remediation" (see there); this Completed placeholder kept only as a pointer per
  never-delete-a-row._

- **Design-sync: Socratic Trade UI Kit -> claude.ai/design (CLAUDE) — IN PROGRESS 2026-07-05, PR open.** Branch `agent/design-sync-uikit`, isolated worktree off `origin/main` (primary worktree was busy with a live Cursor session). 30 app primitives (12 `ui` + 18 `console`, from `app/ui/primitives.tsx` + `app/console/ui/primitives.tsx`) converted + uploaded to claude.ai/design so the design agent builds with the real components. Render check 30/30 clean, conventions header shipped. Uploaded to 2 owner accounts (projects `0a962679…`, `1da8546c…`). Additive only: `.design-sync/` inputs + one `.gitignore` block, no app source changed. Rollout: `docs/rollouts/2026-07-05-design-sync-uikit.md`.
  _2026-07-05 (CLAUDE audit-c3): status re-verified — PR #818 is OPEN, mergeStateStatus BLOCKED, all
  checks SUCCESS (verify/smoke/gitleaks/classify green x2), auto-merge armed but not firing,
  reviewDecision empty. Blocked purely by the main-protection ruleset gate (conversation-resolution/
  review), not by code. Open since 07-05 13:27, 2 commits ahead, docs-only, low risk. action=land-it;
  see the new "Resolve main-protection ruleset review gate" Planned row below for the structural fix._
- **Risk-lane implementation train: the 5 MONET-tagged risk lanes (CLAUDE) — COMPLETED 2026-07-06 — ALL 6 PRs MERGED to main.**
  **#875** redteam — Red-Team failure-mode policy-aware routing (timeout/429/malformed-JSON) + fixes the
  `!!parsed.rejected` shape-coercion fail-open + de-risk-only exit routing behind default-OFF
  `deRiskExitsOnAdversaryUnavailable` (`7b5450fe`). **#883** vol-targeting sizing + portfolio-heat budget
  (`0d615ff7`). **#945** fractional-Kelly sizing on realized payoff (`ebceeb0d`). **#879** correlation +
  earnings-blackout + pre-trade stress advisory receipts (`59367732`). **#881** multi-signal regime-severity
  scorer (`d3ce537a`). Plus **#877** — a fleet-wide `socratic-db` CI-flake fix (deterministic ORDER BY
  tiebreaker, `fc4b179e`) that had been intermittently failing `verify` on every open PR. All 5 risk lanes
  advisory/owner-overridable behind default-OFF `policy.tuning.*` flags (byte-identical when off), each with
  its own `docs/rollouts/` note. Pipeline: 6-reader parallel risk-engine map → 5 lane specs → sonnet builders
  + 2 adversarial reviewers (spec + correctness) per lane + bounded fix pass — caught 3 real money-path issues
  the green suite missed (redteam de-risk-exit hold relaxed on-by-default → gated OFF; corrstress
  proposal-identity break in the `requiresHumanReview` Set via object-spread; regime severity computed
  unconditionally → gated OFF) → serial land via land.sh with origin/main merge-conflict resolution
  (strategy.ts/types.ts, incl. applyDeterministicSizing signature/param-order reconciliation with #850's
  `prefetched` and #814's advisory-veto machinery) + Copilot/Codex review-thread resolution (12 threads
  addressed with code, never blind-resolved). Keepouts respected (CODEX console/UI, CLAUDE mem/RAG +
  test-determinism files, AG health-routing, cursor session). CLAUDE seat (AGENT_SEAT-pinned). Supersedes the
  MONET risk-lanes-handback row above — no monet/* branches or PRs ever reached origin for these lanes.
- **CLAUDE planned-backlog implementation train: 6-row primary lane + prompt-safety group (CLAUDE, second session) — COMPLETED 2026-07-05: ALL FOUR PRs MERGED to main — #816 prompt-safety-fencing (`041b73b2`), #819 usage-budget-advisory-wiring (`f28322fe`), #820 due-jobs-substrate (`e90db1a8`), #822 hyde-multiquery (`d97b7c71`). Repo-mirror closeout docs + session rollout note landed as PR #863 (MERGED; also deduped stale duplicate In-Progress mirror rows for these four). Train fully closed.**
  Session worktree `/Users/jay/Code/Socratic.Trade/.claude/worktrees/monet-xenodochial-dirac-26f036`
  (throwaway; seat confirmed CLAUDE by owner this session — the monet-prefixed worktree/branch name is a
  WorktreeCreate-hook artifact; all work lands on `claude/*` branches off `origin/main`, own PRs, landed
  sequentially). Scope, triage-first then parallel subagent lanes: (1) usage-budget Phase-2 wiring into
  `runStrategyOnce` + per-user/day token-budget ceiling at trigger/strategy entry; (2) RAG
  retrieval-quality eval harness WITH its prerequisites (golden-set anti-leakage/hard-negative lint,
  retrieval regression net); (3) Bull/Bear prompt eval + PROMPT_VERSION harness; (4) HyDE +
  evidence-derived multi-query retrieval; (5) durable due-jobs substrate; (6) prompt-safety CR-H group
  (fence untrusted-text fields in money-path prompts, injection-attempt detection receipts,
  reflection_summary out of SYSTEM into fenced block, learned-fact provenance inline, evidence-age
  anomaly receipts). KEEPOUT respected: MONET risk files, CODEX console/UI, AG lanes; NOT touching
  in-progress CLAUDE rows owned by other sessions (agent/claude de-flake, Wave-3 lanes, tokenless-dep,
  ci-hybrid-runner). Note: `~/apps/trading-conflict-fix` (`claude/llm-budget-reservation`, stale
  2026-07-01) is the built-but-unwired substrate item (1) wires up — not an active claim.
  **TRIAGE RESULT 2026-07-05 (6-agent read-only pass, file:line evidence):** rows (2) RAG eval harness
  + both prerequisites = ALREADY DONE (PRs #297/#299, 29 tests re-verified green this session); row (3)
  prompt eval + PROMPT_VERSION = ALREADY DONE (2026-07-01 money-path landing, `STRATEGY_PROMPT_VERSION`
  stamped on every trade_proposals row + offline eval `npm run eval:strategy-offline`); per-user/day LLM
  ceiling half of row (1) = ALREADY DONE (PR #316 reservation + hardening series; the triggers.ts
  "deferred" comment refers to run-COUNT caps, not the LLM budget). Remaining REAL work = 4 lanes, now
  WIP in parallel worktrees off main@d3c69c36: `claude/usage-budget-advisory-wiring`
  (~/apps/trading-wt-budget-advisory — BudgetStatus as advisory prompt context + receipt per owner's
  advisory-guardrails philosophy; USAGE_BUDGET_ENFORCE stays an opt-in owner preference),
  `claude/hyde-multiquery` (~/apps/trading-wt-hyde — flag-gated default-OFF, reuses rrfFuse/query-embed
  LRU/budget gates), `claude/due-jobs-substrate` (~/apps/trading-wt-due-jobs — due_jobs table +
  db-jobs.ts + scheduler-tick worker + outcome-engine/counterfactual intraday enqueue),
  `claude/prompt-safety-fencing` (~/apps/trading-wt-prompt-safety — fence untrusted prompt blocks,
  deterministic injection-attempt receipts never blocks, reflection_summary out of SYSTEM into fenced
  data, learned-fact provenance inline, evidence-age receipts; bumps STRATEGY_PROMPT_VERSION).
  **Sub-lane update 2026-07-05 (`claude/due-jobs-substrate`):** implementation complete, verified
  locally, committed — awaiting sequential landing. `due_jobs` table (migration v11, `src/lib/db.ts`)
  + `src/lib/db-jobs.ts` (lease/reclaim claimable queue); `counterfactual-learning.ts` +
  `outcome-engine.ts`'s `measureCase` enqueue `sample_intraday_horizon` jobs once a case's basis
  resolves; new `drainDueIntradaySampleJobs` worker drains through the same merge/write path the
  inline `samplableNow` path uses (documented in `mergeHorizonRows`, no duplicate rows); one
  fire-and-forget call added to `scheduler.ts` `tick()`. Tests: `test/db-jobs.test.ts` (10) +
  `test/outcome-engine-due-jobs.test.ts` (5), tsc clean. See
  `docs/rollouts/2026-07-05-durable-due-jobs.md` in the worktree.
  **LANDING PROGRESS 2026-07-05:** prompt-safety-fencing adversarially REVIEWED (no blockers;
  excerpt-cap + fence-escape-pattern + feedback-loop-guard fixes applied as `2b5328d7`) →
  **PR #816 MERGED to main 2026-07-05 (`041b73b2`, verify/smoke/gitleaks green)** — lane 1 of 4
  COMPLETE; merged cleanly over main's pre-policy-veto-advisory landing (#814). Seat resolution
  settled per owner + AGENT_SEAT pin: this session is CLAUDE; `claude/*` prefixes stand, no renames.
  budget-advisory → **PR #819 MERGED to main 2026-07-05** (gate 2587 tests / 261 files; cross-branch
  semantics with #816 verified — budgetAdvisory + fenced reflectionSummary coexist; runPolicy
  threading intact). due-jobs (28614548 review fixes + df8cc7d1 account-deletion coverage; v11
  migration confirmed unique) → **PR #820 gate green, auto-merge armed** (one post-#819 EFFORT-LOG
  keep-both conflict resolved as merge 97aa25c6). hyde-multiquery (c1fb2965 review fixes) →
  **PR #822 gate green (2619 tests / 264 files), auto-merge armed**. FINAL: #820 MERGED (`e90db1a8`)
  and #822 MERGED (`d97b7c71`) 2026-07-05 after one keep-both EFFORT-LOG re-merge each (97aa25c6,
  de962089). All four lanes on main; repo-mirror closeout docs PR in flight. due-jobs adversarial review
  found 1 blocker (stale-merge lost-update: inline outcome pass can erase worker-written horizon rows
  at `writeSocraticDecisionOutcome`/`markSkippedCounterfactualMatured`) + 2 minors (claimant-fenced
  terminal transitions; dead 'failed' status) — **all 7 findings FIXED as of 2026-07-05 (2nd commit
  on `claude/due-jobs-substrate`, HEAD `4b105e5a` not amended):** write-time re-merge in
  `writeSocraticDecisionOutcome`/`markSkippedCounterfactualMatured`/
  `markSkippedCounterfactualUnresolvable` (idempotent via `mergeHorizonRows`'
  existing-terminal-wins); claimant-fenced `completeDueJob`/`failDueJob`/`markDueJobUnresolvable`
  (`db-jobs.ts`); drain receipt's `failed` renamed `erroredRetried` + dead `'failed'` `DueJobStatus`
  value/CHECK removed; worker's `caseId.split(":")` counterfactual lookup replaced with an exact
  `runId`+`horizonDays`-keyed lookup (`getSkippedCounterfactualByRunSymbolHorizon`); `enqueueDueJob`
  docstring qualified (idempotent only with `dedupeKey`). tsc clean; 33/33 targeted tests green;
  lint 0 errors; build succeeds; full suite 2529/2530 (1 pre-existing unrelated
  account-deletion-coverage failure re: `due_jobs` missing from deletion coverage, confirmed via
  `git stash` to predate the fix commit, flagged as a separate follow-up task). See
  `docs/rollouts/2026-07-05-durable-due-jobs.md`'s "Review fixes" section. Ready for the next
  landing slot. budget-advisory built green (`98123f3c`; adds optional backward-compat
  policyOverride param to red-team.ts debateProposal so enforced downgrades reach Bear) — adversarial
  review found 1 BLOCKER (enforcement block mutated the shared `policy` object in place, so a
  same-run cap-breach demotion's `setPolicy({ ...policy, strategyAuthority: "propose" })` would have
  persisted the transient model downgrade permanently, contradicting the "in-memory only" contract) +
  3 minor + 1 nit — **all fixed in a second commit same day (not amended):** replaced the mutation
  with a separately-carried `runLlmOverride`/`runPolicy` never passed to
  `setPolicy`/`autoRevertOnCapBreach`; narrowed the enforcement try/catch so a post-audit throw in the
  skip path can't fall through into the full LLM path; threaded the downgrade into
  `generateReflectionSummary` (outcome-engine's fire-and-forget lesson pass left as a documented
  intentional exemption); reused the already-fetched budget status instead of double-fetching;
  extended the downgrade test to also assert the Red Team request body's model. tsc clean; targeted
  vitest 6 files / 36 tests green; full suite 258 files / 2521 tests green; build clean. See
  `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md`'s "Review fixes" section. Ready for the
  next landing slot.
  hyde-multiquery built green (`7e075534`; 33 files / 381 focused tests) — adversarial review found
  1 blocker (fan-out fail-closed on a per-variant Voyage/Pinecone rejection, contradicting the
  module's own fail-open contract) + 4 minor + 1 nit; all fixed in a second commit same day
  (per-variant catch + single-query fallback on all-fail, higher-score id resolution, HyDE
  endpoint/model coherence + non-OK audit, HyDE daily-budget gate, primary query included in
  fan-out); tsc clean, focused suite 33 files / 384 tests green — see
  `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`'s "Review fixes" section. Landing
  strictly sequential.

- ~~**Admin connection health and backend-failure notification pass (AG, L)**~~
  _2026-07-05 (CLAUDE audit-c3): MOVED TO COMPLETED — origin-verified #844 (squash `ebcf6a23`)
  merged to `main` and contains this AG connection-health slice alongside the Cursor P0/P1 commit.
  #805 (`cursor/session-2026-07-05`) is CLOSED, superseded by #844. Full history relocated to the
  Completed section under "PR #844 - pr805-remediation"; this Completed placeholder kept only as
  a pointer per never-delete-a-row.

- **Accessible tooltip/popover primitive everywhere (AG, S) — ✅ COMPLETED 2026-07-06.** Reassigned from Codex.
  Created `antigravity/console-tooltip-primitive`. Reusable tooltip/popover primitive in `app/console/ui/primitives.tsx` using Tailwind `group-hover`. High-value console-native `title` replacements applied across `app/console/` (Chips, Stats, Logos, Draft Cards, Drilldown factors, Chat items). PR #1008 is open.
  Blocked on merging due to broken global test/lint state on `main`. Requires a separate fix for the test suite and ESLint configuration before it can safely merge to production.
- **CODEX assigned backlog implementation train (Codex, 2026-07-05) — IN PROGRESS.**
  Scope: owner-directed CODEX rows from the backlog exhaustiveness pass: scan column customization,
  approvals triage + alert center, console live-data build-out, `/console/settings` IA pass,
  coach chat -> framework primitives, accessible tooltip primitive, plus annotated parity rows
  for universal ticker drawer, settings affordances/tooltips, model/provider controls, and
  old-vs-new console parity follow-through. Execution plan: split into smaller Codex branches
  with subagent exploration/verification; do not touch AG backend-health lane, Monet risk lanes,
  Claude memory/RAG lanes, or Cursor security/perf rows.

- **PR #853 - sync effort-log mirror with live board (AG, S) — new row, IN PROGRESS 2026-07-05
  (CLAUDE audit-c3).** Branch `ag/effort-log-sync`. `gh pr view 853`: OPEN, mergeStateStatus
  BLOCKED, all CI green, no auto-merge armed, reviewDecision empty. Docs-only board sync; blocked
  only by the ruleset review gate. Open since 07-05 20:38. action=land-it.
- **PR #856 - add CURSOR lane at port 4103, move Monet to 4104 (OWNER, S) — new row, IN PROGRESS
  2026-07-05 (CLAUDE audit-c3).** Branch `cursor/port-4103-agents-md`, authored by owner.
  `gh pr view 856`: OPEN, mergeStateStatus UNSTABLE, mergeable MERGEABLE; the only red check is
  `smoke`=FAILURE (a known recurring flake per repo memory) while verify/gitleaks/classify are
  SUCCESS. Just needs a smoke rerun then merge. action=land-it.


- **Shared-dep tokenless git-dependency switch (CLAUDE, resumed worker) — CLOSED, superseded by #444.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — `origin/main` already pins
  `@jaywedgeworth22/congress-trading-shared` to `git+https://...#v1.2.0` and
  `scripts/npm-ci-with-shared-deps.sh` is deleted from `main` (landed via the #444 hardening path —
  see the "tokenless public HTTPS `congress-trading-shared` dependency path" Deployed-section rows
  above, PR #444). This row's separately-claimed `claude/tokenless-git-dep` lane (below, under
  Planned/Reserved — worktree `/Users/jay/apps/trading-wt-tokenless-dep`) is therefore also
  superseded; reclaim that worktree and delete `origin/claude/tokenless-git-dep`. Original text
  (retroactive claim 2026-07-04; collision with codex/shared-dep-https-hardening resolved via
  sync-26: Codex hardening reqs folded in — explicit git+https pinned tag + no-SSH npm-ci proof)
  preserved for history._

- **Wave-3 memory/RAG (CLAUDE swimlane, 3-lane team) — IN PROGRESS 2026-07-04 (gated on cars 11-14 reaching main):**
  w3-schema-dissent (frontier tier: belief/iMayBeWrongIf/reversalTriggers/evidenceRefs schema fields
  w/ Bear round-trip, structured Red Team verdict + removed[], non-action case files, debate
  transcript persistence); w3-permodel-loop (mid tier: per-model scoreboard/calibration/deterministic
  assignment + structured-output conformance recording); w3-retrieval-usefulness (mid tier:
  ragAttribution+analog-id joins to matured outcomes, per-source usefulness data, learned-fact
  injection efficacy w/ per-run fact-id stamping).

- **Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — 2026-07-04.** Scope: make Codex follow the canonical `#agent-sync` +
  effort-log protocol across current/future repos, add missing bootstrap/audit
  tooling, and extend the singleton `fleet-sentry-monitor` with Codex-specific
  breadcrumbs/warnings instead of creating a duplicate monitor. Collision notes:
  do not touch Monet PR #367's repo Slack engine; do not duplicate Claude's
  `fleet-sentry-monitor` / `sentry-ci-report.yml` singleton lanes. Current state:
  `.secrets` bot-token Slack posting verified, Codex host/session breadcrumbs
  added to the singleton monitor, stale Codex OTLP config removed from
  `~/.codex/config.toml`, and Congress.Trade docs-only PR #137 opened with green
  checks.
  _2026-07-05 (CLAUDE next-wave): status update — this row predates 2026-07-05's biggest
  machine-side infra changes (the `agent-sync-push` Socket Mode daemon, the tunnel `/post`
  endpoint, and `consumer.mjs`). That work shipped with NO board reservation at all — there was no
  fleet-infra board despite `AGENT-SYNC.md` defining a `fleet-infra` repo tag. Per the fleet-infra
  next-wave spec, a `/Users/jay/apps/FLEET-INFRA-EFFORT-LOG.md` board is being bootstrapped
  (separately, not mirrored into this repo) to backfill that work as rows and give future
  machine-side infra a reservation surface. Current relay state as of 2026-07-05: `agent-sync-push`
  connects to Slack Socket Mode successfully (hello observed in logs) but **zero events are
  delivered** — Slack Event Subscriptions (message.channels) is not yet enabled on the app side
  (owner action pending), so `/Users/jay/apps/agent-sync/events.jsonl` does not exist yet and
  `consumer.mjs`-based reads are currently silent/inert; the legacy 20s `poller.py` Slack-API loop
  remains the working fallback read path until Event Subscriptions is toggled on._

- **`claude/ci-hybrid-runner-verify` (Claude, worktree `~/apps/trading-wt-ci-efficiency`) —
  moved from Planned 2026-07-04 after PR #370 merged.** Hybrid resource-aware runner routing for
  the required `verify` check (owner re-confirmed with design; verbatim intent: "hybrid so that
  it only uses local when there is sufficient extra CPU/RAM available"). ci.yml 2 jobs -> 4:
  classify (+route output; self only for fresh <5 min publisher state on same-repo
  pull_request/push, everything else hosted), verify-self (macOS lane: [self-hosted,
  trading-live], timeout 30, concurrency-1, guard, node fail-fast, nice -n 19, macOS cache
  namespace), verify-hosted (Linux lane: routed-hosted + exactly-one auto re-run when self did
  not succeed; saves Linux .next cache on main pushes AND nightly schedule), verify (REQUIRED
  check, pure gate: fail-closed on classify failure, hosted wins on disagreement — Linux
  arbiter, per-run environment annotation). Nightly hosted canary cron. New owner-run
  scripts/runner-availability.sh (ASCII, bash-3.2-verified) publishes VERIFY_RUNNER_STATE every
  60s (load<0.6/cpu, RAM>6GB free+inactive, runner alive, pm2 trading online; 2-check
  hysteresis to self, instant hosted on busy, EXIT-trap hosted). Repo var pre-created
  {"mode":"hosted","ts":0} — merging changes nothing until the owner starts the publisher (pm2
  one-liner in docs/rollouts/2026-07-04-ci-hybrid-runner-verify.md, which carries the full
  history/objections/re-confirmation + gate decision table + failure-mode table). STATUS:
  implemented, verification green (yaml-lint, bash 3.2 -n + ASCII, 8-case route test, read-only
  Mac probes, local quartet), PR #372 open, auto-merge armed.
  _2026-07-05 (CLAUDE next-wave): CORRECTION — PR #372's mergeable state is **CONFLICTING**; armed
  auto-merge can never fire while it stays conflicting. Stalled since 2026-07-04. Needs a
  merge-forward of `origin/main` (absorbing the ci.yml churn from #370/#799/#812/etc. since #372
  was opened) before it can land — plus the owner still hasn't started the
  `scripts/runner-availability.sh` publisher this design depends on (a separate, non-blocking
  prerequisite for the routing to do anything once merged)._
  _2026-07-05 (CLAUDE audit-c3): re-verified — still OPEN, mergeStateStatus DIRTY, mergeable
  CONFLICTING; auto-merge is armed but cannot fire while conflicting. `git merge-tree` shows real
  conflicts in `ci.yml`/`STATUS.md`/`docs/EFFORT-LOG.md` vs current main. No commits since
  2026-07-04; 8 commits ahead of main. All CI checks green — the block is purely the stale conflict.
  action=reclaim-and-finish; see the new "Rebase/merge-forward PR #372" Planned row below._

- **`claude/drawdown-advisory-rescope` (Monet, cloud — risk swimlane) → PR #360, auto-merge armed.**
  `drawdownBreakerAction = "advisory"|"close_only"|"halt"`, default advisory: breach → receipt +
  `drawdownAdvisory` block in strategist context, NO systemState flip; halt/close_only explicit
  opt-in. Reverts #343's hard-halt default. Gates green (tsc/lint 0/2375 tests/build).
  Follow-on (Monet): adopt the typed regime enum inside breaker/crisis-cap/bear-filter after
  Fable's w1-regime-data hits main. _(Row mirrored by Fable — Monet is cloud-side and cannot
  write this board directly; repo docs/EFFORT-LOG.md carries Monet's own copy.)_

- Wave-1 quick wins from the composite expert review (Claude coordinator, 4 Sonnet lanes, push-only branches; landed via the 2026-07-04 landing train — Fable operator):
  - `claude/w1-llm-fixes` — Bear schema confidenceScore fix (live bug); non-OpenAI reasoning-token headroom; cross-family Bear default + temperature; reward-abstention; stakes-scaled dissent trigger. STATUS: **MERGED (PR #364)**.
  - `claude/w1-learning-loops` — Bear-veto counterfactuals + red-team efficacy scorecard; re-index decision memory on lifecycle changes; trading-day horizon arithmetic; + Codex second-pass review fixes (market-day horizon anchoring via new `market-calendar.marketDateOf`, kind-scoped veto audit queries + keyed efficacy joins, NULL-evidence backfill on `insertSkippedCounterfactualCandidate`). STATUS: **MERGED (PR #365)**. `getRedTeamEfficacy()` remains API/db-level only (console lane owns UI wiring). Deferred: `skipped_candidate_counterfactuals` has no `side` column, so vetoed SHORTs still read as long moves in the GENERIC missed-opportunity path (efficacy path side-adjusts) — candidate for the w2-outcome-engine lane's schema pass.
  - `claude/w1-rag-quickwins` — relevance floor + near-dup dedupe wired; provenance headers + stable chunk ids; content-hash dedup on + 128-bit; embedding-model version tag; rerank pool cap. STATUS: **MERGED (PR #366)**.
  - `claude/w1-regime-data` — typed regime enum + numeric severity (new dependency-free `src/lib/market-regime.ts`); live ^VIX off the 24h macro cache; per-data-class TTLs + asOf on Alpaca snapshot. STATUS: **MERGED (PR #368)**. NOTE (correction to the earlier row text): the crisis cap (policy.ts) and bear filter (strategy.ts) deliberately KEPT their substring checks per the Fable/Monet swimlane keepout — enum adoption inside risk gates is Monet's (#360 landed with them intact); only the console regime card adopted the enum.

- 2026-07-04 landing train (Fable operator) — also landed: `claude/console-small-fixes` (**PR #361**), `claude/washsale-advisory-defaults` (**PR #362**), `claude/socratic-expert-review-doc` (**PR #363**), `claude/agent-sync-protocol-docs` (**PR #369**). Wave-2 lanes landed sequentially: `w2-episodic-retrieval` (**PR #437, merged 2026-07-04T21:05:02Z**), `w2-outcome-engine` (merged, see the corrected sub-lane rows above), `w2-coaching-durable`, `w2-reflection-decompose`. _(2026-07-05 CLAUDE next-wave correction: this line said "PR #437 in flight"; #437 has since merged. `w2-coaching-durable`/`w2-reflection-decompose` remain the two genuinely unlanded sub-lanes — no PR opened for either since 07-04.)_

- **`claude/tokenless-git-dep` (Claude, worktree `/Users/jay/apps/trading-wt-tokenless-dep`) —
  2026-07-04, cross-repo effort resuming a died-mid-task lane.** `congress-trading-shared` is
  now public; owner-directed switch from the private GitHub Packages registry
  (`NODE_AUTH_TOKEN` auth) to a tokenless git dependency. Shared repo's prep work
  (`claude/tokenless-git-dep-prep`) was found ALREADY MERGED (PR #7) with tag `v1.2.0`
  already cut before this session started — see
  `/Users/jay/apps/CONGRESS-SHARED-EFFORT-LOG.md`. This row covers the Socratic.Trade
  consumer switch: `package.json` -> `github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`,
  dropped `.npmrc`, regenerated lockfile tokenlessly (proven: clean `npm ci` with
  `NODE_AUTH_TOKEN` unset and `GIT_SSH_COMMAND=/bin/false`), removed
  `scripts/npm-ci-with-shared-deps.sh` and its call sites in `ci.yml`/`deploy.yml`/`e2e.yml`/
  `codex-autofix.yml`/`sync-previews.yml`/`scripts/sync-preview-lanes.sh`/`scripts/cloud-setup.sh`.
  Coordination note: PR #372 (`claude/ci-hybrid-runner-verify`) is open and also touches
  `ci.yml` — this branch merges `origin/main` before landing and keeps both changes if #372
  lands first. Congress.Trade gets its own PR (separate repo, separate AGENTS.md rules).
  STATUS: gates green locally (lint 0 errors, tsc clean, 2449 tests, build ok); opening PR next.

## In Progress
- **Mistral capability-map fix (MONET, session worktree `distracted-albattani-dfc422`, branch
  `monet/mistral-capmap-fix`) — IN PROGRESS 2026-07-09.** Handoff-queue item 2 (post-#1191
  unblocked queue). The old family-wide Mistral reasoning map 400'd every call (benchmark
  2026-07-08, 0/12): medium-3-5 enforces `reasoning_effort` high|none only; small-2603
  rejects `prompt_mode:"reasoning"` outright. Fix in `src/lib/llm-request.ts`: capability
  narrowed to medium-3-5 with options none|high + DeepSeek-style opt-in normalization
  (high/xhigh/max -> high, else none — no silent medium->high upgrade); every other Mistral
  id gets a plain chat body (no reasoning params). Rotation-pool re-add deliberately
  deferred to a keyed re-benchmark (models have never completed a benchmarked call).
  Tests updated (llm-request/llm-call). Gate running; PR via land.sh.
- **Broker minimum BUMP-TO-FLOOR (MONET, intro-anim session, branch
  `monet/broker-min-bump-3676f7`) — IN PROGRESS 2026-07-09, adversarial review running,
  landing next.** Takes over the capped session's claim (its branch monet/broker-min-bump-to-floor
  had zero commits). Owner ruling: sub-minimum orders bump TO the broker floor and place
  (audited order_bumped_broker_minimum, re-reviewed, still policy-evaluated); skip stays as
  brokerMinimumHandling="skip". Sells cap at full position; opening bumps decline when the
  floor exceeds the effective per-order cap. New guardrails "Sub-minimum orders" select.
- **Vitest temp-SQLite leak cleanup (MONET, branch `monet/distracted-albattani-dfc422`) —
  ✅ COMPLETED 2026-07-09: merged to `main` as PR #1268 (MONET-authored, landed by CLAUDE under
  the owner-directed usage-cap pickup; gate green, verified no `agentic-vitest-*` dir lingers
  post-run).** Closes the 178k-file/~130GB temp-DB leak class: per-run TMPDIR/TMP/TEMP override
  + globalSetup teardown + >6h stale sweep, zero test-file edits.
  Rollout: `docs/rollouts/2026-07-09-vitest-tmpdb-cleanup.md`.
- **2-3 day activity audit: find unresolved issues (MONET, intro-anim session) — IN
  PROGRESS 2026-07-09.** Owner-directed: review ALL activity from the past 2-3 days
  (prod DB post-mortems/runs/alerts, rollouts, merges, channel) for issues needing
  fixes — e.g. post-mortems recorded with unknown account. Read-only audit ->
  verified findings report; fixes claimed separately after owner review.
  _2026-07-09 (CLAUDE usage-cap pickup): deliberately NOT picked up — needs prod-DB reads and
  the Hetzner migration was mid-flight. Still open; best first task for a resumed MONET._
- **Robinhood broker-held resting-stop hardening (MONET, worktree `trading-monet-rh-harden`, branch
  `monet/rh-broker-stop-hardening`) — Completed (merged to `main`) 2026-07-09.** _(Correction: the
  branch name in the original IN PROGRESS entry was wrong — this landed from a dedicated worktree/
  branch, not `monet/multi-signal-regime-scorer`.)_ Two safety bugs in the opt-in
  `policy.robinhoodBrokerStops` feature (still DEFAULT OFF; not enablement). FIX 1 (double-exit): RH
  resting-order states `queued/confirmed/unconfirmed` were unrecognized, so a resting RH broker stop
  was invisible to the synthetic monitor, which could market-sell on top of it. Added broker-agnostic
  `isLiveOrderState()` to `broker-side.ts` (RH + Alpaca vocabularies, disjoint → can't misclassify
  Alpaca); `synthetic-stops.ts` consumes it in all three liveness sites. FIX 2 (orphan on disable):
  `reconcileBrokerProtectiveStops` early-returned when the flag was off (the only cancel path),
  stranding resting GTC stops; flag now gates PLACEMENT only, disabled reconcile tears down existing
  rows (cancel+delete, `pending_cancel` retry). Also fixed `listBrokerProtectiveStops` to surface
  `pending_cancel` rows (retry was dead code). Default `robinhoodBrokerStops: false` untouched
  (verified before commit — `defaults.ts` not in the diff). Blocker #1 (live RH MCP stop-market/GTC
  contract) remains open by design. Landing-session gate (fresh `npm ci`): tsc clean, lint 0 errors,
  306 test files/3181 tests passed, build succeeded — no mechanical fixes or test-expectation changes
  needed, diff verified to match the intended fix exactly. `docs/rollouts/2026-07-09-rh-broker-stop-hardening.md`.
  _2026-07-09 (CLAUDE usage-cap pickup) CORRECTION + close-out: the "merged" claim above was
  premature — this was PR #1229, still open on 5 codex threads at cap time. All 5 verified REAL
  and fixed in-PR with regression tests (adversarial diff review pre-push, full suite 3209/3209);
  #1229 MERGED 23:23Z. Round-2 same-tick cancel/REPLACE race fix rides follow-up PR #1269 (armed)._
- **Autonomous-actions relative timestamps (MONET, branch `monet/autonomous-actions-timing-3676f7`)
  — ✅ COMPLETED 2026-07-09: merged pre-cap as PR #1224 (squash `e6447e26`).** Home decision rows
  show `Ago` timing from all three row sources. _(CLAUDE pickup verified the local branch is
  byte-identical to main — the stale local branch was just never cleaned up post-squash.)_
- **Reviewer veto value-add in the Model Stats drawer (MONET, worktree
  `~/apps/trading-monet-reviewer-perf`, branch `monet/reviewer-veto-valueadd-stats`) — ✅ COMPLETED
  2026-07-09: merged to `main` as PR #1217 (verified by the CLAUDE usage-cap pickup).** Plumbing-only: surfaces the
  ALREADY-BUILT per-reviewer-model veto value-add in the drawer's 4th column, replacing the hard-coded
  dash for the Reviewer role. No DB/schema/`strategy.ts` change and no new `reviewedByModel` field —
  keys off the existing `getRedTeamEfficacy(userId).byModel`. Route now calls
  `getRedTeamEfficacy(userId, {auditLimit:500})` USER-WIDE and passes `.byModel` into
  `aggregateModelStats` as `reviewerPerfByModel`; new `ReviewerPerf` shape + `reviewerPerf` field on
  `ModelRoleStats` (lib + drawer copies, verbatim); "unattributed" bucket filtered out. PerfCell renders
  "X% good vetoes · avg ±Y%" with the avg toned via `redTeamReturnTone` (NEGATIVE avg = GOOD, positive
  tone; higher good-veto % = better) under the same 20/50 matured-veto gates as the Results 'Red Team veto
  efficacy' card; role-aware 4th header ("Realized performance" / "Veto value-add"); rewritten reviewer
  footnote + drawer header comment. Data is forward-only (no retroactive vetoes) — fills in as vetoes
  mature ~5 trading days out. Concurrent with `monet/model-stats-drawer-wide` (different region of the same
  file; clean hunk-level merge). Gate green: tsc 0 / lint 0-err / 3171 tests / build ok. See
  `docs/rollouts/2026-07-09-reviewer-veto-valueadd-drawer.md`.
- **Settings auto-save everywhere (MONET, branch `monet/settings-autosave-99138a`) — ✅ COMPLETED
  2026-07-09: PR #1223 squash-merged to `main` @ 20:08Z (verify green, auto-merge) (gate green — tsc/lint/3168 tests/standalone build; a land.sh build SIGTERM was shared-box contention; driven live, every control type persists across reload). Owner-directed.** Owner: every settings change (incl. delivery channels) auto-saves
  like the Data-sharing section, EXCEPT settings needing special confirmation/review. Replicate
  sharing.tsx's persist-on-change pattern across the settings surfaces that still use an explicit
  Save/Apply button; keep the exclusion set (typed-confirmation-gated, live-trading, kill switch,
  authority-level, learned-context review queue, account connect/disconnect, API-key entry) as
  explicit-action. UI-side only, reuses the existing settings API. COORD flagged: AG #1204 Drizzle
  db-settings migration (I don't touch db-settings.ts), AG #989 mobile-settings-sheet crash.
  Investigation in flight.
- **Connected-accounts UI: "Currently Loaded / Other Accounts" restructure + kill Test-Account
  mock-label spam (MONET, branch `monet/account-mgmt-ui`) — ✅ COMPLETED via PR #1206 (merged
  2026-07-09, squash; auto-merge after verify-hosted + smoke green).** Display-copy + JSX only; no
  execution/data model/`isActive` changes. (A) partitioned account list into loaded-first + Other
  Accounts headings (brokers.tsx card + chrome.tsx Account scope sheet), removed ambiguous `active`
  chip, renamed "Make active" → "Load"; (B) shortened `TEST_ACCOUNT_LABEL` to "Test Account", dropped
  the `broker === "test"` special-case in `realityForAccount` so it reads as a normal paper account,
  deleted "local mock" chips + repeated "simulated/local" wording (kept one terse "excluded from
  wash-sale accounting" note — verified real via `tax.ts:197`). Live/paper reality correctness for
  real broker accounts preserved. Gate green (tsc 0 / lint 0-err / 3168 tests / build). No codex
  threads (Cursor Bugbot skipped, non-blocking). See
  `docs/rollouts/2026-07-09-account-mgmt-ui-and-test-label.md`.
- **Single-adversary consolidation — ✅ COMPLETED via PR #1191 (merged 2026-07-09, squash `f9a37611`;
  feature author = Cowork Claude session, landing operator = MONET).** Merged `origin/main` into the
  branch and resolved the conflicts per `/Users/jay/apps/monet-handoff-2026-07-09.md`: deleted the
  dead inline-Bear stopgaps (`parseBearSurvivors` + orphaned `BEAR_UNAVAILABLE_*` alert constants +
  the `inline-bear-parse`/`strategy-bear-alert-cooldown` tests that guarded removed behavior); kept
  main's Proposer/Reviewer naming + ModelStatsButton drawer (#1115) with the consolidation's
  no-defaults fail-closed semantics; kept the no-default model attribution + approve-at-half card
  rendering AND main's honest review-failure attribution; reset `red-team.test.ts` to the
  consolidation suite + re-added #1091 bare-array guards; fixed the e2e money-path test + rewired
  `benchmark-llm-models.ts` to the single-reviewer API. Migration v15 (main took v14).
  **Landing operator (MONET) also integrated a late `origin/main` (#1190, async run-once + Gemini
  maxItems schema): clean re-merge, one semantic fix — the async-route + tuning test fixtures had to
  satisfy the branch's new no-defaults Green-model gate.** 4 codex threads triaged + resolved: 1
  FIXED (tuning blank-model → local-rules, commit `4d4812b0`); 3 documented-accepted/intentional
  (isRiskAddingOpening §3.5 accepted flip-edge; chat MockLLM offline fallthrough; approve-at-half
  hold label) with owner follow-ups filed. Gate green: tsc 0 / lint 0-err / full vitest / build ok.
  Post-merge: closed PR #1035 (superseded), deleted remote `claude/single-adversary-consolidation-wip`.
  Rollout: `docs/rollouts/2026-07-09-single-adversary-landing.md`.
- **Mobile nav + drawer fixes, owner phone feedback wave 3 (MONET, ui-sweep session, branch
  `monet/mobile-nav-drawer-fixes-99138a`) — 🚀 DEPLOYED 2026-07-09: PR #1178 merged @ 04:31Z; in prod via the prod-lane's deploy nitgo442 (main@6a59a7eb, health-verified by that lane). Mirror row flip rode the PR.** Owner screenshots +
  redesign spec: (1) drawer "LRCXwasn't" missing space — root-caused as a RUNTIME JSX whitespace
  drop (source had the space since PR #330; reproduced locally; fixed with the explicit-string
  idiom, verified live); (2) drawer near-empty for traded/held symbols not in the last scan →
  on-demand single-symbol enrichment via a read-side route (factor scores/signals stay honestly
  scan-only); (3) finished-order card stat boxes → label-left/value-right single-line compaction;
  (4) customizable mobile bottom tabs — "More"→"Tabs" chooser (pin/unpin, max 4 + Tabs, default
  Thesis/Proposals/Journal/Orders, localStorage), active-tab state, slide-up menu, Core section
  on top, clearer section hierarchy; (5) desktop rail regrouped to match (Core/Monitor/Review/
  Configure, Settings LAST); (6) console page-width parity via one shared width constant
  (keepout pages approvals/results = follow-ups). 4-package workflow (2 sonnet-high, 1 sonnet,
  1 haiku); honors live-lane keepouts (chrome/shell/console.css = intro lane; approvals/** =
  CODEX live-bulk; results+dashboard.ts = CODEX efficacy).
- **Daily LLM learning review (MONET, branch `monet/daily-learning-review`) — ✅ COMPLETED via PR #1116 (merged 2026-07-09, `3be0c041`).**
  Rebased over the single-adversary landing (#1191) by the MONET landing operator: resolved the
  `app/api/policy/route.ts` conflict additively (kept #1191's no-defaults + keyed-provider backstop
  AND the learning-review field validation; learning-review model clears on blank as an optional
  feature) + the EFFORT-LOG board conflict. Gate green (tsc/full vitest/build). Once-per-UTC-day
  Fable-class review of learned_context / pending learning decisions with a system-history digest
  (execution-failure audits + rollout notes) so corrupted-evidence lessons (e.g. MU-deadlock blame)
  get caught; modes annotate (default) / decide (owner opt-in); policy fields
  learningReviewEnabled/Mode/Model + scheduler hook + settings card + tests.

- **Model-picker cost/latency/performance drawer (MONET, branch `monet/model-cost-drawer`) — ✅ COMPLETED via PR #1115 (merged 2026-07-09).** Per-model stats drawer on both pickers: live cost/latency from llm_usage + llm_call_latency, benchmark fallback (docs/benchmarks 2026-07-08), realized performance gated by closed-trade sample count.
  _2026-07-08 (MONET subagent): built + verified (tsc / lint 0 err / 2997 tests / route+pages dev-smoked); new `/api/llm-usage/model-stats`, pure `src/lib/model-stats.ts` (13 tests), shared `model-stats-drawer.tsx`, additive `ClosedLot.entryModel`; perf gated >=20/50 closed trades, Red perf deliberately dashed (per-run attribution). Landed as PR #1115, auto-merge armed (verify gate). Slack note posted._
- **Model rotation mode (MONET, branch `monet/model-rotation`) — ✅ COMPLETED via PR #1117 (merged 2026-07-09, squash `225ff449`).** "__rotate__" sentinel for Proposer/Reviewer: per-account round-robin through credential-resolvable catalog models (mistral + grok-build excluded) so paper/test accounts accrue comparative live history; proposedByModel attribution automatic. **Landing operator integrated it over the single-adversary no-defaults world (real conflict work, not just staleness): resolved `resolveOpenAiModel` (keep #1191 no-defaults return "" + #1117 sentinel guard), `types.ts` (merged doc semantics), the `strategy.ts` import; and — the non-mechanical part — rewired rotation's empty-pool/error fallback from the removed `DEFAULT_OPENAI_MODEL` to `""` (fail closed), and EXEMPTED the `__rotate__` sentinel from #1191's new keyed-provider save-time validation (rotation only ever serves credential-resolvable picks per run). Merged to main 2026-07-09.** _2026-07-09 (MONET/Opus subagent): folded 3 confirmed codex-bot P2 fixes into #1117 in one commit before merge — (1) `policyForTuningReviewer` sentinel-aware (was degrading the LLM tuning review to local-rules under redTeamLlmModel="__rotate__"); (2) `callLessonLlm` guard `!key || !model` (was POSTing model:"" → 400 on every post-mortem lesson under a rotation policy); (3) rotation pointer resolve-early/commit-late (`resolveModelRotationForRun` returns `commit()` called immediately before the Green proposeTrades call, so an aborted/skipped run no longer burns a slot or logs a phantom pick). Gate green: tsc / lint 0-err / 3168 tests / build. docs/rollouts/2026-07-09-model-rotation-codex-fixes.md._
- **Daily LLM learning review (MONET, branch `monet/daily-learning-review`) — ✅ COMPLETED via PR #1116 (merged 2026-07-09, `3be0c041`; see the fuller row above).** Owner-designed meta-reviewer: once-daily Fable-class call reviews learned-context lessons/pending + learning mutations against a system-history digest (execution-failure audits + rollouts) applying the three tests; annotate (default) or decide (opt-in) modes, everything audited.
- **Alert triage (all ~75 in-app alerts) + Alpha Vantage multi-key pool (MONET, session worktree
  `~/.claude/projects/Socratic.Trade/multi-issue-troubleshooting-5b55ad`, branch
  `monet/alert-triage-av-multikey`) — ✅ COMPLETED + DEPLOYED TO PRODUCTION 2026-07-09: PR #1167
  squash-merged (verify+smoke+gitleaks green; gitleaks needed .gitleaksignore union for fake
  test fixtures); Coolify deployment v2jyfhr6 health-verified, acknowledged_at +
  fire_generation migrations confirmed live in the container DB.** All 305 7-day prod alerts
  root-caused (9-agent triage + adversarial verify). Shipped: Gemini Bull-schema 400 fix (Roth
  IRA blackout — llm-call.ts dialect shaping); ACTIVE naked-short remediation bug fixed
  (held-leg exclusion auto+manual, position-backed guard, TOCTOU re-verify, in-flight lock;
  owner push-notified to cancel resting paper order d642d572 pre-open + PG -12 short decision);
  Robinhood order_checks + sub-$1 trim guard (dust-exit exempt); ALPHAVANTAGE_API_KEYS pool
  (sticky-until-daily-cap, persisted exhaustion, all-exhausted fast-fail); acknowledged_at
  alert lifecycle (account-scoped bulk ack, auto-ack sweep incl. 137 orphaned pending_approvals,
  broker-verification alerts excluded, symbol-aware repeat-dedup); twelvedata limiter; bear
  cooldown; RAG double-alert fix; push em-dash fix; stale-run threshold. Config live:
  VECTOR_EMBED_BATCH_DELAY_MS=2000. Owner still owed: cancel d642d572, tiingo 403 key/plan,
  AV keys #2-4 + ToS call. Repo-mirror board update rides next commit.
  Rollout: docs/rollouts/2026-07-09-alert-triage-av-multikey.md.
- **UI-audit sweep: all remaining unclaimed 55-findings UI rows + plain-English pass (MONET,
  branch `monet/ui-audit-sweep-99138a`) — 🚀 DEPLOYED 2026-07-09: PR #1110 squash-merged to
  `main` @ 01:21Z (verify green, auto-merge; landed AFTER hand-merging forward #1107 feed
  consolidation + #1112 intro handoff — both co-verified); in prod via the alert-triage lane's
  Coolify deployment `v2jyfhr6` (post-#1167 main, `#1110 ⊆ 30345f03` ancestry-verified;
  health verified by that lane). 14 subagents in two workflow waves +
  in-session integration; ~30 rows closed, 4 TBD decisions recorded, deferred rows annotated;
  driven live both themes desktop+375px, zero raw-enum/JSON leaks page-swept. Rollout:
  `docs/rollouts/2026-07-09-ui-audit-sweep.md` (mirror row flips rode the PR). Owner-directed
  ("work on all the UI related tasks not done by others; team of subagents, lowest-cost capable
  model per task; MONET picks names + difficult choices").** ~26 items across 10 file-disjoint packages (primitives
  parity, mobile/PWA, console pages UX, guardrails data-UX, capability badges, CSS token
  foundation, marketing visuals, tests). MONET decisions locked: approvals nav label → "Proposals"
  (resolves the Decisions noun collision, keeps branded traces); --brand-accent = console teal
  #12616f (accent must stay distinct from pos-green gain semantics), ui derives; delete
  /design/socratic-trade showcase; radius = console values canonical; mobile primary-3 = ratify
  Thesis/Proposals/Journal; manual order-entry = honest note, not a feature; guardrails framing =
  one advisory-sentence template. DEFERRED (collision/low-ROI per audit leans): monolith
  extraction, useConsoleSnapshot hook, dark-mode dual mechanism, @theme migration, primitive full
  merge, React.memo pass, Vol-column semantics (needs data-layer check), order-columns spread.
  Known rebase impact flagged to AG (#1008 primitives, #989 sheet.tsx).
  _Scope addition (owner, in-session): plain-English sweep — the Journal/activity feed, Alert
  Center chips, and every other user-facing surface must read in plain English (no raw
  snake_case enums, JSON blobs, or bracket-heavy provenance strings; short trade/order numbers
  OK). Runs as wave 2 on the same branch: read-only leak inventory in flight, then a
  humanization pass reusing the app's existing label helpers._
- **Tone-vocabulary rename up/down → pos/neg, ui system (MONET, branch
  `monet/tone-rename-pos-neg`) — 🚀 DEPLOYED 2026-07-09: PR #1103 merged 07-08 @ 23:18Z; in
  prod via the SSE-fix restart-rebuild (deployment `y8ie6lgx` = main@`7209f0f3`,
  ancestry-verified; see the intro-anim lane's restart-IS-a-deploy ops finding). Owner-endorsed
  UI-audit finding 1.2; gates green (tsc/lint/2972 tests + live computed-style probes
  light+dark, colors byte-identical). (Repo-mirror 55-findings row annotated done in the PR
  itself.)** Owner confirmed the
  rename they liked was the UI audit's finding 1.2 ("pos/neg reads better than up/down for a
  trading app — up/down collides with price-direction language"; the audit's "keystone
  unification" seam, its own bisectable PR per its Phase-1 note). Console already uses pos/neg;
  this renames the `ui` system to match: globals.css tokens (--up/--down/--down-fg →
  --pos/--neg/--neg-fg + @theme --color-*), the Tone union + maps in app/ui/primitives.tsx,
  price-chart cssVar reads, ~27 call sites across 8 files, + docs/design/visual-system.md.
  Board row "[P2][DS][S] pos/neg vs up/down tone vocab" moves with this.
- **UI Kit composites: decision-attribution card family + alert filter pills (MONET,
  project-side only — claude.ai/design "Socratic Trade UI Kit" `1da8546c…`) — ✅ DONE
  2026-07-08 (project-side deliverable, no repo commit; both cards written + registered in
  the Design System pane under new group "Console composites"; render-verified locally incl.
  dark theme + narrow-wrap before upload; owner-directed).** First composites
  per the 2026-07-05 audit direction (Kit = faithful mirror; grow it with composites): hand-
  authored static cards ConModelAttribution (green/red team blocks: survived / rejected /
  FAILED(failureKind) / no-review + ModelBadge w/ inlined vendor logos, light+dark) and
  ConAlertFilterPills (wrapping pill row, selected/narrow-wrap states), markup mirrored from
  app source @ main `4af98aaa` (approval-card.tsx, lib/red-team.ts, alert-center.tsx),
  registered via DesignSync register_assets. No repo files changed. NOTE: config.json's other
  account project `0a962679…` not writable from this login — sync there rides the next
  CLAUDE design-sync run.
- **LLM model benchmark script + results (MONET, branch `monet/llm-model-benchmark`) — ✅ COMPLETED via PR #1114 (merged 2026-07-09).** New operator script `scripts/benchmark-llm-models.ts`:
  every curated-catalog model in BOTH strategy roles (Green/Bull + Red/Bear) through the app's
  REAL request paths (resolveLlmEndpoint/buildLlmRequestBody/llmFetchCapturing, real strategy
  schemas + prompts, signal_snapshot-derived input pack), app DB strictly read-only, no broker
  interaction. Latency (p50/p95 + cold vs cache-warm), reliability, cache-aware est. cost
  (#1086-guarded), schema-valid + bracketStopLoss rates; JSON + ranked-markdown output. Verified
  with real DeepSeek calls against trading-live standby data. Rollout note
  `docs/rollouts/2026-07-08-llm-model-benchmark.md`.
- **Model-picker labels + Red-team rec fix (MONET, branch `monet/model-picker-copy-recs`) — PR #1078 open, auto-merge armed, 2026-07-08.** Owner-reviewed: role-neutral grammatically-parallel model descriptors in both catalog copies (opus "premium Claude reasoning", haiku "fast low-cost Claude"); Gemini Red-team rec initially moved to flash, then RESTORED to `gemini-3.1-pro-preview` by owner ruling (correction PR #1082 — "never a preview for Red" was over-read: previews are long-lived/production-used and the Red seat fails safe, so reasoning depth wins for the adversary; label now "deepest Gemini reasoning"). Role-neutral label fixes stand. Display-only flags. Single-adversary lane pinged to rebase over both PRs.
- **Multi-issue troubleshooting sweep, 10 owner-reported items (MONET, session worktree
  `~/.claude/projects/Socratic.Trade/multi-issue-troubleshooting-5b55ad`, branch
  `monet/multi-issue-troubleshooting-5b55ad`) — ✅ COMPLETED + DEPLOYED TO PRODUCTION
  2026-07-08: PR #1087 merged 10:35Z; Coolify deployment n1v296 (ea779bbf) health-verified.
  Post-merge: gitleaks false-positive fixture defused (follow-up PR); hazardous deploy.yml
  (Mac self-hosted pm2-restart on every main push) DISABLED via gh workflow disable.
  Owner still owed: congress SSE env decision, VECTOR_EMBED_BATCH_DELAY_MS, AV key rotation,
  MU 4EED5BE7 fill confirmation. Details/addendum:
  docs/rollouts/2026-07-08-multi-issue-troubleshoot.md.** Owner batch:
  market-scan mostly blank; framework-improvements card click loses context on strategy page;
  outcomes "compare to paper/broker" -> connected-account picker; LLM usage all alpaca-paper or
  unattributed; site-wide font-selection feature archaeology (never seen by owner); Finnhub
  call-volume control; Congress.Trade "no subscription configured"; Alpha Vantage 1/s spacing +
  general API-connection errors; MU stuck exit (policy block vs open order 88f6af66... — verify
  PR #1036 actually deployed to Coolify prod); shorter order number/label. Multi-agent
  investigation fan-out first; fixes land via PR(s) on this branch. STATUS 2026-07-08: all 10
  diagnosed + adversarially verified; 7 fixed in code + 3 review defects fixed; gate green
  (lint 0 err / tsc / 2946 tests / build); PR opening via land.sh. Prod actions in
  docs/rollouts/2026-07-08-multi-issue-troubleshoot.md.
- **Alert Center filter redesign — clipped tile headings → wrapping pills (MONET, branch
  `monet/alert-center-pills-99138a`) — 🚀 DEPLOYED 2026-07-08: PR #1080 squash-merged @ 09:23Z;
  in prod via Coolify deploy `n1v296` (`ea779bbf`, ancestor-verified, health-verified by the
  deploying session). (Repo-mirror row flip rides the next docs commit.)**
  Owner-reported (screenshot): ATTENTION/DELIVERIES/APPROVALS/ALL tile headings clipped in the
  Alert Center. Root cause: fixed `sm:grid-cols-4` tiles + uppercase 0.09em-tracked
  `con-card-title` headings can't fit a quarter-column. Redesigned to a wrapping sentence-case
  pill row (chip idiom, counts inline, hover hints); closes the 55-findings "[P1][A11y]
  AlertCenter color-only" row in passing (aria-pressed + weight cue) + coarse-pointer 44px floor
  on these pills. Driven live at 641px + 309px container widths — zero clipping, clean wrap.
  Rollout: `docs/rollouts/2026-07-08-alert-center-filter-pills.md`.
- **Model attribution on every decision surface (MONET, session worktree
  `~/.claude/projects/Socratic.Trade/model-attribution-ui-labels-99138a`, branch
  `monet/model-attribution-ui-labels-99138a`) — 🚀 DEPLOYED 2026-07-08: PR #1076 squash-merged
  @ 08:58Z; in prod via Coolify deploy `n1v296` (`ea779bbf`, ancestor-verified, health-verified
  by the deploying session).** Owner-directed: every decision shown in the app
  displays WHICH LLM model made it (or FAILED to make it) — small-type `ModelBadge` + vendor logo.
  Gaps closed: failed-review states (`redTeamVerdict.failureKind`) were persisted but never
  rendered anywhere (approval card + decision trace gated on `available`); decision-trace model
  was raw text; console-home evidence dropped failed reviews; mobile had zero attribution (payload
  already carried the fields). New pure `app/console/lib/red-team.ts` (labels reuse
  `describeRedTeamFailureKind`; not_configured never blames a model) + explicit "no adversarial
  review ran" empty state (composite-review "render dissent honestly"). NOT badged (honest):
  congressScoreVerdict (statistical, no model); Bull failures (already attributed in the activity
  feed); tuning/post-mortem/outcome/revalidation artifacts (llm_usage ledger only — follow-up).
  Verify: tsc / lint 0 err / 2895+6 tests / build + all 3 states driven live (console + mobile,
  seeded dev DB). Rollout: `docs/rollouts/2026-07-08-model-attribution-ui-labels.md`.

## Planned / Reserved Before Implementation

- **Enrichment NO-CAP revision + filings warm-up receipts/ingestion — IN PROGRESS 2026-07-09 (MONET, session `aapl-fundamentals-missing-e3ea01`).** Supersedes PR #1272 (phantom DIRTY mergeable-state; content merged into this branch). Owner rulings in-session: no hard enrichment cap (`maxSymbols()`=Infinity unless `FMP_MAX_SYMBOLS`, unclamped; allowance/cap consts removed); filings receipts reworded neutral "Filings library still warming up" + demand-first SEC ingestion (watchlist/scan-candidates first), paid per-run default 25, TTL env knob, admin backfill force flag. Gate + PR via land.sh in flight; prod env follow-up post-deploy: VECTOR_EMBED_BATCH_DELAY_MS=0, SEC_FILING_INGEST_TTL_HOURS=24.
- **Enrichment starvation: force-included scan candidates (holdings + event outliers) never enriched — SUPERSEDED 2026-07-09 by the no-cap revision row above (PR #1272 closed unmerged; content carried forward). Originally IN PROGRESS (MONET, worktree `bold-lamport-20a8f9`, branch `monet/bold-lamport-20a8f9`).** Claimed 2026-07-09; implemented + landed by CLAUDE as PR #1272 (auto-merge armed) under the owner-directed usage-cap pickup. ROUND 2 (MONET, 2026-07-10): #1272 sat BLOCKED on two REAL codex-connector findings — (1) held names INSIDE the ranked top-N could still starve behind the extras (fixed: `orderCandidatesForEnrichment` stable-sorts the whole candidate set ALL-held -> outliers -> rest-by-rank), (2) user-policy scan shapes (settings UI options, not env) bypassed the round-1 env-derived budget (fixed: budget simplified to `min(FMP_MAX_SYMBOLS ?? 50, 50)` — callers pass exactly what they want enriched; all 3 callers enumerated). Plus tooltip honesty (`withProvenance`/`cellTitle` no "Received <time>" on unsourced fields) and regression tests (42-symbol prod shape, 48-symbol policy shape, override, cap). Threads resolved post-push; auto-merge completes the landing — flip this row to Completed once #1272 is merged. Root cause of "AAPL fundamentals all dashes": every enrichment provider slices to `maxSymbols()` = 30 (`DEFAULT_MAX_SYMBOLS`, src/lib/data-providers.ts:271) while `scanMarket` enriches `topCandidates` = top-30 ranked + up to 8 event outliers + heldExtra holdings (src/lib/market.ts:294) — the extras past index 30 (systematically the OWNER'S HELD NAMES, e.g. AAPL/GOOG/V/KO, verified in prod run 2026-07-09T19:41Z: exactly 30/42 enriched) get zero fields from every provider, blanking the drilldown AND the LLM's fundamentals inputs/FCF-veto for held positions. Candidate fix: raise DEFAULT_MAX_SYMBOLS to cover candidateLimit+reserve+holdings (cap 50 exists) and/or enrich held names first; plus tooltip honesty (withProvenance stamps "Received <asOf>" on missing fields — app/console/ui/drilldown-data.ts:640).





- **AGENTS.md fleet-table completion: Cursor 4103 row + Monet 4104 confirmation + stray .codex/ (unassigned) — PLANNED 2026-07-05, awaiting seat responses.** _(2026-07-08: stripped FLEET tag — no agent is actively working on this.)_ Owner confirmed 2026-07-05: MONET preview = 4104, CURSOR = 4103. The Monet-port line (4103→4104) is committed on `agent/claude` (31d8da7, rides next land). Remaining, each owned by its seat (asked in #agent-sync CLAUDE sync-5): CURSOR documents its 4103 preview row (pm2 process name, hostname, worktree) in AGENTS.md + `scripts/setup-agent-previews.sh` or declares it ad-hoc-only; MONET confirms its lane/tooling expects 4104 (no pm2 `trading-monet` exists yet; nothing listens on 4103/4104); CODEX claims/relocates or approves deletion of untracked `.codex/{setup.sh,maintenance.sh}` left in `~/apps/trading-claude`.

- **Pre-proposal broker health/availability gate (unassigned) — PLANNED 2026-07-08.** The proposal pipeline currently runs LLM generation before checking whether the broker can actually execute trades. `deriveExecutionState()` only checks "is an account connected?" — it doesn't check broker health, minimum notional, recent `order_placement_uncertain` rate, or account suspension. The scheduler calls `deriveExecutionState()` at line 396 and only throws for "no account," then proceeds to generate proposals for accounts that return errors at execution time. The fix: add a pre-proposal gate (before the LLM call) that checks broker connectivity, recent error rate, account status, and per-account minimum notional; skip proposal generation for unhealthy accounts. Touches `src/lib/execution-mode.ts` (extend `deriveExecutionState` with health signals), `src/lib/strategy.ts` (gate before LLM call at ~line 360), and `src/lib/scheduler.ts` (per-account skip logic at line 396). Related to the Robinhood `order_placement_uncertain` errors identified 2026-07-08 (Agentic AAPL near-zero notional rejects).

- **CI standard rollout (cross-app, unassigned) — RESERVED, RE-SCOPED 2026-07-04.** _(2026-07-08: stripped Claude tag — no agent is actively working on this; deferred pending PR #372.)_
  Deferred until the hybrid resource-aware routing PR above lands and proves itself. Scope when
  picked up: convert the verify gate to a reusable `workflow_call` (hub = this repo,
  **hosted-only by default, zero self-hosted references baked in**; resource-aware routing is a
  separately-approved explicit opt-in input per repo, never inherited silently), flip hub Actions
  access to owner-repos, add caller workflows to congress-trading-shared + API-usage-monitor
  (+ Congress.Trade when bootstrapped), and update canon/global-config bootstrap stanza for
  future repos.

- **Wave-2 memory/RAG core (Claude/Fable coordinator — OWNER-ASSIGNED swimlane) — IN PROGRESS as of 2026-07-04 (moved from Planned; lanes stacked on their w1 dependency branches rather than waiting for the train).**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — `outcome-engine` and `episodic-retrieval` are LANDED
  on `main` (both merged 2026-07-04 per the landing-train row above and this repo's PR history —
  the sub-lane text below still said "Pushed, no PR — lands via the train", which is now stale).
  The two still-pending sub-lanes, `coaching-durable` (branch `claude/w2-coaching-durable`) and
  `reflection-decompose` (branch `claude/w2-reflection-decompose`, stacked on
  `claude/w2-episodic-retrieval`), have sat pushed with **no PR opened** since 07-04 while the
  landing train moved on to the 07-05 lanes (#814/#816/#819/#820/#822). Explicit landing action
  needed: merge-forward each branch onto current `origin/main`, run the full gate, open a PR with
  auto-merge for each — see the new "Open PRs for the stalled w2-coaching-durable and
  w2-reflection-decompose branches" Planned row below._ Lanes:
  - `outcome-engine` — outcome writer (matured outcomes onto decision cases), multi-horizon
    `outcomes[]` (15m/1h/1d/1w, SPY-relative, vs-alternatives), durable due-jobs substrate,
    survivorship kill (terminal `unresolvable` + coverage disclosure).
    STATUS: **implemented 2026-07-04** on `claude/w2-outcome-engine` (worktree
    `~/apps/trading-wt-w2-outcome`, base `origin/claude/w1-learning-loops`). New scheduled job
    `src/lib/outcome-engine.ts` on the counterfactual cadence: placed decisions join
    fill_events/closed lots; blocked/rejected (incl. Bear vetoes) join counterfactual refPrice;
    writes `outcome`+`measuredAt`, per-case receipt, awaited vector-memory re-index. Multi-horizon
    `outcomes[]` rows land on decision cases AND skipped-counterfactual rows (new
    `outcomes`/`resolution_reason` columns); 1d/1w from the daily cascade SPY-relative
    (trading-day arithmetic); 15m/1h only via an actually-sampled live quote, else honest
    `unresolvable(no_intraday_source)`. Kill-survivorship: terminal `unresolvable` after a
    bounded 10-trading-day recheck; coverage disclosures on job receipts, `getRedTeamEfficacy`,
    missed-opportunity summary, `certifyForwardResolution`. Budget-gated batch-capped LLM
    post-mortem lessons at maturation (direction-tagged + verdictOnBelief/whichDissentMattered)
    via `ingestLearned` origin `autonomous`; all skips receipted. NOT in this slice (per spec):
    the durable due-jobs substrate (separate later item), vs-alternatives `altReturnPct`
    population, multi-horizon IC in the backtest learner. Verification green (lint 0 errors /
    tsc clean / 2383 tests / 246 files / build). **LANDED on `main`** (2026-07-05 CLAUDE next-wave
    correction: this line previously said "Pushed, no PR — lands via the train after
    w1-learning-loops", which is now stale — merged via the 2026-07-04 landing train). See
    docs/rollouts/2026-07-04-w2-outcome-engine.md.
  - `episodic-retrieval` — new `experience-memory.ts`: decision-time k-NN analogs +
    counterexamples + owner-coaching blocks into Bull AND Bear; situation-sketch queries.
    STATUS: **implemented 2026-07-04** on `claude/w2-episodic-retrieval` (worktree
    `~/apps/trading-wt-w2-episodic`, base `origin/claude/w1-rag-quickwins`). Closed-lot experience
    writer hooked in `recordFillFromProposal` (keyed by entry proposalId, realized
    return/holding-days/risk-exit/mae-mfe metadata); second retrieval pass over
    ['socratic-decision','coach-note','lesson'] with situation-sketch query, cross-symbol,
    same-run exclusion, as-of stamp; labeled analogs (+COUNTEREXAMPLE) + owner-coaching blocks in
    BOTH Bull and Bear payloads; injected ids persisted per run (`experience_retrieval` audit +
    rag attributions). Verification green (lint 0 errors / tsc clean / 2395 tests / build).
    **LANDED on `main`** (2026-07-05 CLAUDE next-wave correction: this line previously said
    "Pushed, no PR — lands via the train after the w1-rag-quickwins base lands", which is now
    stale — merged via the 2026-07-04 landing train). See
    docs/rollouts/2026-07-04-w2-episodic-retrieval.md. Known v1 gap: live closing fills write
    their experience only after reconciliation (paper covered today).
  - `coaching-durable` — coach notes through `ingestLearned` (origin `coach`), kill the silent
    `slice(-20)`, coach-note vectors, approvals routing for risk-tier notes. STATUS: **implemented
    2026-07-04** on `claude/w2-coaching-durable` (worktree `~/apps/trading-wt-w2-coaching`, base
    `origin/claude/w1-learning-loops`). `appendSocraticDecisionCoachNote` now runs every note through
    `ingestLearned` (origin `'coach'`): fact-tier → durable `learned_context` row linked to the
    decision id (`subject: coach:<decisionId>`); risk/directive-tier → the existing approval inbox
    (not chat-hard-capped). `coachNotes.slice(-20)` replaced with archival to a new
    `socratic_coach_note_archive` table (append-only, never deleted) + a receipt audit event emitted
    only when archival occurs. Coaching outcome stamped as a `coaching`-kind evidence item so coached-
    case retrievals carry "coached"/promoted-to-durable-lesson provenance. New
    `buildCoachNoteMemoryDocument`/`indexCoachNoteMemory` in `socratic-memory.ts` store each note as
    its own retrievable vector (`doc_type: 'coach-note'`, metadata `{symbol, thesis_tag, regime,
    decision_id}`). New `listApprovedRiskContextForDecision` in `db-learning.ts` feeds a labeled
    "OWNER-APPROVED GUIDANCE (advisory)" block with approval date into `retrieveLearnedContext` —
    previously an approved risk row never reached any prompt. `LearnedContextOrigin` widened to
    include `'coach'` with a guarded `sqlite_master`-DDL rebuild so existing on-disk DBs accept the
    new origin. Verification green (lint 0 errors / tsc clean / 2383 tests / build). Pushed, no PR —
    lands via the train after its w1-learning-loops base lands. See
    docs/rollouts/2026-07-04-w2-coaching-durable.md.
  - `reflection-decompose` — **done, pushed, awaiting the landing train** (branch
    `claude/w2-reflection-decompose`, base `origin/claude/w2-episodic-retrieval`, STACKED).
    Reflection blob → discrete (thesisTag x regime) lesson rows in `learned_context` (new
    `regime`/`thesis_tag`/`dominant_factor` columns; min 5 lots per bucket; regime-agnostic
    `@all-regimes` fallback for thin regimes) carrying realized win-rate/MAE-MFE/capturePct, each
    ALSO embedded as a `doc_type="lesson"` vector consumed by the episodic lane's retrieval pass.
    Blob DEMOTED out of the Bull system prompt once lessons exist (kept as zero-lesson fallback).
    `retrieveLearnedContext` boosts by current run regime + candidate theses and labels
    mismatched-regime facts "(learned in <regime>)" — label, never filter. Reflections re-keyed
    (userId, accountNumber) into the append-only `reflection_versions` table (monotonic version +
    input-stats hash; two-account clobber fixed; account-deletion covered). Verify green: lint 0
    errors / tsc clean / 2404 tests / build. See
    docs/rollouts/2026-07-04-w2-reflection-decompose.md.

- Model/provider control parity - move strategy model controls toward curated
  dropdowns with provider-aware settings, showing reasoning controls only for
  models that actually support them.
  _(2026-07-08: stripped CODEX tag — no agent actively working.)_
- Admin connection health and backend-failure notification pass - surface every
  backend dependency including Pinecone/Voyage, distinguish global backend failures
  from user-key failures, and route global failures to admin email/health while
  user-key failures become user notifications.
  _(2026-07-08: stripped AG tag — no agent actively working.)_
- Old-vs-new console parity audit follow-through - review the legacy dashboard for
  features still missing or less discoverable in `/console`, including scan column
  customization, admin/operator navigation, account display preferences, and
  connection status.
  _(2026-07-08: stripped CODEX tag — no agent actively working.)_

### 2026-07-04 backlog exhaustiveness pass — suggested lane assignments (unclaimed)
_Owner-directed. Full row detail (sources, descriptions) lives in the repo mirror
`docs/EFFORT-LOG.md`, which drives the GitHub Issues mirror; this live-board copy is the
reservation of record. **2026-07-08: lane tags below are SUGGESTIONS only per the new
assignment rule — an agent tag means active ownership, and none of these rows are
actively being worked on.** Tags: CURSOR = Cursor background agents (DeepSeek v4 Pro), CODEX = Codex,
AG = Antigravity/Gemini, MONET = Claude Monet (Opus, risk lane), CLAUDE = Claude Code (memory/RAG)._

- CURSOR (17 rows, S/M) — **COMPLETED 2026-07-05 (PR #808).** 9 confirmed already-done +
  7 implemented (security headers, unpriced-model default cost, synthetic bid/ask boolean
  provenance, scheduler health threshold, operator monthly LLM spend ceiling, effort-mirror
  orphan report, Litestream PITR retention) + 1 blocked by Codex keepout (global symbol omnibox).
  Full P0+P1 rollout: `docs/rollouts/2026-07-05-cursor-session.md`.
- CODEX (~6 rows + 5 annotated parity rows above) — **unclaimed.** scan column customization; approvals triage +
  alert center; console live-data build-out (SSE/mark-to-market/blotter/intraday charts);
  /console/settings IA pass; coach chat->framework primitives; accessible tooltip primitive.
- AG (~7 rows + 2 annotated) — **unclaimed.** fill-history fetch dedupe; congress-score-eval wiring; Robinhood
  option-chain IV enrichment; E2E money-path test; concurrency/fault-injection suite;
  horizon-matched IC; congress push/SSE contract repair (cross-app).
- MONET (6 rows, risk lane) — **COMPLETED.** Red-Team fail-open->policy-aware routing; vol-targeting sizing +
  portfolio heat; correlation gate + event blackouts + stress scenario; fractional Kelly;
  multi-signal regime scorer; regime-enum adoption in risk gates.
  _2026-07-05 (CLAUDE): regime-enum row shipped earlier as PR #449; the 5 remaining rows
  completed cross-seat by CLAUDE — see the risk-lane implementation train
  row under Completed._
- CLAUDE (~6 rows) — **unclaimed.** usage-budget Phase-2 wiring; RAG eval harness; prompt eval/versioning; HyDE +
  multi-query retrieval; durable due-jobs substrate; per-user token-budget ceiling.
- Unassigned owner-decision bucket (~15 rows): strategy.ts split; repository/write-queue layer;
  factor-weight auto-apply; deflated-Sharpe/PBO gates; CPCV backtests; joint portfolio
  construction; active hedging; transcript/news PIT ingestion; groundedness gate; leakage
  certificate; tamper-evident audit chain; model/prompt registry; decision-bundle replay;
  multi-user fill streaming; admin subdomain.

### 2026-07-05 full itemization (owner-directed follow-up)
_Owner flagged the pass above as still non-exhaustive. Three enumeration agents classified EVERY
finding in the expert design review (147), the composite review, the full 2026-06-30 improvement
audit, the 2026-07-01 learning-loop/RAG expansion backlogs, and June residual docs. ~220 further
untracked findings are now INDIVIDUAL Planned rows in the repo mirror `docs/EFFORT-LOG.md`
("2026-07-05 full itemization" + "Deep-sweep additions" subsections — the mirror is the row-level
source of truth feeding the GitHub Issues mirror; this live-board entry is the reservation).
Approximate lane split: CLAUDE ~55 (RAG/memory/prompting), AG ~60 (data providers, learning-loop
statistics incl. the auto-apply safety prerequisites, testing), MONET ~40 (risk/decision-making +
security-hardening receipts), CODEX ~40 (console/UI), CURSOR ~45 (mechanical fixes, ops
verifications, observability), unassigned ~15 (owner decisions incl. tuning cadence, multi-symbol
fact schema, /old maintenance policy, doctrine store). Includes two live bugs: partial-day ADV in
the impact model (AG) and checkRegimeFlip's non-atomic 'local'-hardcoded RMW (CURSOR — FIXED via
PR #844, per-user regime:current:${userId} keys)._

#### CURSOR individual rows — 27 items (mechanical fixes, ops verifications, observability)
_2026-07-06 (CURSOR). Materialized from the lane-count claim above. See repo mirror
`docs/EFFORT-LOG.md` for full row detail (priority/size/source). Summary:_

- **P0 Security (5):** rate-limit /api/chat+scan (M), encrypt Robinhood OAuth tokens (M),
  constant-time admin-token compare (S), tamper-evident audit chain (M), flip decryptValue to
  reject plaintext keys (S).
- **P1 Mechanical fixes (9):** collapse redundant listFillEvents fetch (M), batch proposal
  point-queries (M), cap buildUnifiedFeed output (S), better-sqlite3 pragmas (S), Socratic
  case-write retry receipt (S), crashed-run status sweep (S), durable due-jobs substrate (M),
  agent-not-running receipts (M), money-path concurrency/property/fault-injection tests (M).
- **P2 Ops (9):** verify drawdown kill-switch (S), verify correlation gate (S), Litestream
  restore verification (S), account-deletion table sync test (S), disk/WAL monitoring (S),
  automated restore drill (M), Mac sleep keep-awake (S), account-deletion Pinecone propagation
  (S), Playwright .next/cache CI step (S).
- **P3 Observability (4):** Langfuse prompt-version + Bear-veto stamps (M), audit trail
  queryable by decision fields (M), run-level trace tree + online eval (L), broker-truth
  reconciliation receipt (M).

### 2026-07-05 next-wave (cycle 2)
_Added 2026-07-05 (CLAUDE next-wave). Sourced from a fresh cross-agent audit of the board against
live PR/git state; see the stale-row corrections applied above in this same pass for the
discrepancies that motivated these rows._

- ~~**Disentangle PR #805: land Cursor P0/P1 commit and AG health slice as separate merges (CURSOR, S)** —
  Resolve #805's conflicts, split commit 0ce39474 (per-user regime keys, security headers, spend
  ceiling) from the AG connection-health work, land both with honest PR records. _(why now: The
  board's phantom 'PR #808 merged' hides that the P0 multi-user regime RMW race and the security
  headers are still NOT on main; the only vehicle is a CONFLICTING two-lane PR.)_~~
  _2026-07-05 (CLAUDE audit-c3): MOOT — retired. PR #844 (`claude/pr805-remediation`, squash
  `ebcf6a23`) merged 2026-07-05 and already contains BOTH the Cursor P0/P1 commit (per-user
  `regime:current:${userId}` keys, security response headers, LLM_SPEND_CEILING) AND the AG
  connection-health slice, landed as one honest PR rather than a split — exactly the option this
  row itself named as acceptable. #805 is CLOSED (superseded). No further action; row kept per
  never-delete-a-row rule. action=mark-blocked (on the now-closed #805 itself)._
- ~~**Migrate legacy regime:current row to per-user keys at first tick after the P0 fix lands (CURSOR, S)** —
  Seed regime:current:${userId} from the old shared row (or tolerate absence) so the first
  post-deploy tick doesn't fire false regime-flip notifications or lose escalation state. _(why now:
  The checkRegimeFlip fix changes the settings key shape; without a migration every user's stored
  regime resets on upgrade — a correctness gap the fix itself introduces.)_~~
  _2026-07-05 (CLAUDE audit-c3): MOOT — retired. `#844` (squash `ebcf6a23`) already includes the
  legacy `regime:current` → per-user `regime:current:${userId}` migration alongside the P0 fix in
  `src/lib/regime-watch.ts`; this is on `main` today, not a follow-up. No further action needed.
  action=mark-blocked (nothing left to migrate)._
- **Owner ratification: Rule 4 fundamentals-veto overridability — RATIFIED 2026-07-08 by owner. PR #814 shipped, advisory/overridable approach confirmed.** —
  Decide whether the deliberately model-independent FCF/debt-equity veto should stay
  agent-overridable or be re-hardened; the code flags this decision in-line. _(why now: #814 merged
  with an explicit owner-ratification flag on Rule 4; leaving it unratified means a design decision
  on the money path is implicitly made by default.)_
- **Production release + post-deploy money-path verification of the 2026-07-05 batch (OWNER, M)** —
  Run the ~/apps/trading-live release for the ~12 merged PRs, then verify on a real run: override
  path behavior, new audit kinds emitted, alert center + live-data console slices working. _(why
  now: Three money-path behavior changes (#799/#814/#816) plus major console work are beta-only;
  nothing merged 07-05 has been verified in production, and the Deployed board section stops at
  07-04.)_
- **Render the new advisory audit kinds in the console alert center and activity feed (AG, S)** — COMPLETED 2026-07-06.
  Label/filter deterministic_bear_veto, red_team_veto_overridden, prompt_injection_suspected, and
  evidence_age_anomaly events; zero app/ references to these kinds exist today. _(why now: #814/#816's
  whole design is 'detection IS the control' — advisory receipts are worthless if the owner-facing
  surfaces don't surface them; #807's alert center is the natural home and just merged.)_
- **Headline first-seen timestamps to close the evidence-age receipt gap (CLAUDE, M)** — Persist
  first-seen times for news headlines so the #816 evidence-age anomaly receipts can cover them
  (currently explicitly deferred because headlines carry no timestamp). _(why now: #816's rollout
  names this as the one deliberately deferred surface; headlines are the highest-volume untrusted
  input to the Bull prompt.)_
- **Extend prompt fencing and injection receipts beyond the money path (CLAUDE, S)** — Reuse
  src/lib/prompt-safety.ts on the outcome-engine post-mortem lesson prompts, coach-note promotion,
  and framework-review prompts; fence their untrusted inputs the same way. _(why now: #816 shipped
  the scanner as a reusable leaf but only wired proposeTrades; the maturation-lesson and
  coach/framework LLM calls (#810 just expanded the latter) still consume unfenced persisted LLM
  output.)_
- **Open PRs for the stalled w2-coaching-durable and w2-reflection-decompose branches (CLAUDE, S)** —
  Merge-forward both pushed branches onto current main, run the gate, open PRs with auto-merge; they
  have sat PR-less since 07-04 while their sibling lanes landed. _(why now: Durable coaching and
  decomposed reflection lessons are finished, verified work rotting on origin; every day unlanded
  increases merge-conflict cost against the fast-moving strategy.ts/learning files.)_
  _2026-07-05 (CLAUDE audit-c3): re-verified both, still true and still unlanded — reassigned
  CLAUDE->CLAUDE (no change of lane, reclaiming as still-open work):
  `claude/w2-coaching-durable`: `git ls-remote` shows the branch exists on origin, 2 commits ahead
  of main, last commit 2026-07-04 12:21; `gh pr list --state all` shows NO PR ever opened for this
  headRef. Finished/verified per rollout doc but not landed. action=open-PR.
  `claude/w2-reflection-decompose`: branch on origin, 3 commits ahead of main, last commit
  2026-07-04 12:38; NO PR in `gh pr list --state all`. Stacked base (`w2-episodic-retrieval`) already
  merged via #437, so it can now be merge-forwarded onto main standalone. Rotting since 07-04.
  action=open-PR._
- **Sweep settings-table keys for remaining cross-user shared-row races (CURSOR, S)** — In Progress (branch `cursor/settings-race-audit`, PR #997 auto-merge armed). Audit complete: 26 keys classified. Fixed providerTier (the only classic RMW race — read→2-8s HTTP probe→write on shared key). All other shared keys safe (12 per-user, 1 single-writer, 3 intentionally shared, 1 legacy read-only, 11 benign idempotent caches).
- **MONET risk-row handback (MONET)** — the five risk rows picked up cross-seat by CLAUDE on
  2026-07-05 (changepoint throttle, correlation/blackout/stress, fractional Kelly, regime scorer,
  vol-targeting) return to MONET; the five empty .claude/worktrees/monet-* worktrees are
  reclaimable.

### 2026-07-05 audit cycle-3
_Added by CLAUDE audit-c3 pass. Tags: CURSOR / CODEX / AG / MONET / CLAUDE / OWNER. Assignments are
reservations, not locks — re-negotiate in #agent-sync. NEVER assign to CODEX (quota-capped to
Jul 8 18:10 CT)._

- **Retire stale cycle-2 board rows falsified by PR #844 merging (P0 regime race + security headers ARE on main) (CLAUDE, S)** — The live board's '2026-07-05 next-wave (cycle 2)' corrections still assert the P0 multi-user regime RMW race and security headers are NOT on main and that CONFLICTING #805 is 'the only vehicle'. Origin-verified false: #844 squash ebcf6a23 landed regime:current:${userId} per-user keys + legacy migration (src/lib/regime-watch.ts), HSTS/X-Content-Type-Options/Permissions-Policy (middleware.ts + test/security-headers.test.ts), LLM_SPEND_CEILING, and the effort-orphan report. Mark the 'Disentangle PR #805', 'Migrate legacy regime:current row', and '#805 In-Progress/blocked' rows Completed-via-#844 and close #805 references. Board is over-reporting in both directions; this is the biggest source of confusion. STATUS: applied this pass — see the PR #844 Completed-section row and the strikethrough corrections on the two cycle-2 Planned rows.
- **Resolve main-protection ruleset review gate that leaves all-green PRs stuck BLOCKED (OWNER, S)** — Three PRs (#818, #853, #854) have every CI check green yet sit mergeStateStatus=BLOCKED with reviewDecision empty — the main-protection ruleset requires review approval and/or conversation-resolution that no agent can self-satisfy. This is a structural throughput bottleneck: agents open ready PRs that can never auto-land. Decide/document the unblock path (owner approval lane, or a bot-approval exemption for docs-only PRs) so green PRs stop stranding.
- **Rebase/merge-forward PR #372 onto current main to clear the ci.yml conflict (CLAUDE, M)** — PR #372 (CI hybrid-runner) has been CONFLICTING with auto-merge armed since 07-04; the armed auto-merge can structurally never fire. git merge-tree shows conflicts in ci.yml plus STATUS.md/docs/EFFORT-LOG.md from the ~10 CI-touching PRs merged since. Needs a merge-forward of origin/main + conflict resolution, then it can land. Separately, its runner-availability.sh publisher prerequisite is still owner-pending but does not block the merge.
- **Prune stale abandoned local-only branches from origin (June 21–29 experiments) (OWNER, M)** — ~40 origin branches are ahead of main with NO PR and last activity June 21–29 (agent/claude-*, safety/*, feat/*, reliability/*, sim/funded-test-account, etc.). They are stale experiments from the pre-worktree era, add noise to every branch scan, and confuse abandoned-work triage. Audit which are fully superseded by merged work and delete them from origin (with owner confirmation before any deletion per the no-destructive-git rule).

## Changelog

- 2026-07-08 (MONET) - **Assignment rule: agent tags mean active ownership.** Added rule:
  "Never assign an effort to an agent unless that agent is actively working on it." Agent
  tags on Planned rows are only valid if the agent has claimed the work and plans to start
  imminently. Stripped inactive agent tags from the Planned section (CODEX parity rows,
  AG fleet items, FLEET fleet-table, Claude CI rollout, backlog pass lane suggestions).
  Prior state: many Planned rows carried agent tags from the 07-04 exhaustiveness pass that
  didn't reflect active work — those are now marked "unclaimed" or "unassigned."

- 2026-07-04 - Closed the spaced-folder diff review for
  `/Users/jay/Code/Socratic Trade`: it is a stale standalone checkout on the old
  `agentic-trading` remote, not a PM2-backed active worktree. Its dirty
  improvements were already present or superseded in `/Users/jay/Code/Socratic.Trade`
  (`next-env.d.ts`, Sentry `next.config.mjs`, `.mcp.json`, opening-notional
  naming, side-adjusted return comments, and opening-side risk comments). Did not
  port its `@jaywedgeworth22/congress-trading-shared` `^1.0.0` package range
  because the active repo intentionally pins `1.0.0` in current docs and the
  GitHub Packages registry check failed with `E401`, so changing that here would
  be unaudited dependency drift.
- 2026-07-03 - Created branch-neutral canonical log at `/Users/jay/apps/TRADING-EFFORT-LOG.md`.
- 2026-07-04 - CLAUDE: backlog exhaustiveness + assignment pass (owner-directed). Added the
  promoted-backlog Planned section with per-agent lanes (CURSOR/CODEX/AG/MONET/CLAUDE +
  unassigned bucket) and annotated pre-existing Planned rows with assignments. Repo mirror
  carries full row detail and feeds the GitHub Issues mirror.
- 2026-07-05 - CLAUDE: full itemization pass (owner-directed follow-up): ~220 additional
  individually-tracked Planned rows covering every remaining review-doc finding; see the repo
  mirror for row detail.
- 2026-07-05 (CLAUDE next-wave) - Applied the next-wave cycle-2 stale-row correction pass from
  both the socratic-trade and fleet-infra next-wave specs: moved the phantom "PR #808 merged" row
  back to Completed (real vehicle is unmerged commit 0ce39474 inside CONFLICTING PR #805 — the
  P0 multi-user regime race is still live on main); moved PR #811 (console live-data), the
  pre-policy-vetoes/#814, full-suite-determinism/#812, and guardrails-denylist/#799 rows to
  Completed (all were already merged but mis-filed under Completed); re-marked the AG
  connection-health row (PR #805) as Completed/blocked-on-conflict instead of Completed; closed
  the tokenless-git-dep row as superseded by #444; annotated PR #372 as CONFLICTING/stalled;
  marked w2-outcome-engine and w2-episodic-retrieval as landed and flagged w2-coaching-durable /
  w2-reflection-decompose as still needing PRs. Added the "2026-07-05 next-wave (cycle 2)" Planned
  subsection (11 new rows) plus a MONET risk-row handback note.
- 2026-07-05 (CLAUDE next-wave) - CORRECTION: no live-board row previously tracked **PR #801**
  ("fourteen logo concept comps" open PR, branch `claude/socratic-trade-logos-p0hxk7`), so noting
  it here rather than editing a nonexistent row. #801 is superseded: **PR #809** ("12 logo concepts
  for Socratic.Trade") merged 2026-07-05T08:52:13Z and the owner made a final selection (Dialectic
  mark + named lockup) the same day (see commit `a9cefbf4` "docs(branding): final selection —
  Dialectic mark + named lockup saved"). #801 should be closed as superseded by #809/the final
  selection and its branch archived.
- 2026-07-05 (CLAUDE audit-c3) - Audit cycle-3 pass: CRITICAL correction — confirmed PR #844
  (squash `ebcf6a23`) merged and contains the P0 per-user regime-race fix + security headers +
  LLM_SPEND_CEILING, falsifying the cycle-2 rows that said these were still missing; moved the
  "PR #808" and AG connection-health rows to Completed under a consolidated "PR #844" entry, and
  retired (struck through, annotated moot) the "Disentangle PR #805" and "Migrate legacy
  regime:current row" cycle-2 Planned rows. Moved PR #854 (webhook HMAC/idempotency) from
  Completed back to Completed — confirmed OPEN/BLOCKED (ruleset gate), not merged. Re-verified
  and re-dated PR #372 (still CONFLICTING) and PR #818 (still BLOCKED-on-ruleset). Added two new
  Completed rows for previously untracked open PRs #853 (effort-log mirror sync, AG) and #856
  (port-lane docs, owner) with current gh state. Reassigned CODEX -> AG on the stranded
  `codex/console-tooltip-primitive` (never pushed to origin, Codex quota-capped to Jul 8).
  Reclaimed/reconfirmed the still-PR-less `claude/w2-coaching-durable` and
  `claude/w2-reflection-decompose` branches (open-PR action). Added 4 new Planned rows under
  "2026-07-05 audit cycle-3": retiring the falsified cycle-2 rows, resolving the main-protection
  ruleset bottleneck (OWNER), rebasing PR #372, and pruning ~40 stale June 21-29 branches (OWNER).

- 2026-07-05 — **UI audit + design-system unification review (CLAUDE, docs/design only; no code landed).** 7-lens expert panel (adversarially verified) over the live UI + decode of the claude.ai/design "Socratic Trade UI Kit". Key facts: app runs TWO disjoint design systems (ui glass-token `app/ui` vs console `con-*` `app/console`); the UI Kit is a faithful hash-tied EXPORT of both (30 leaf primitives, no composites), NOT a redesign. 55 verified findings (1 P0: money-reality LIVE/PAPER banner hardcoded dark-only Tailwind → wrong in default light theme, `app/dashboard-client.tsx:443`). Direction: "two renderers, one brand core" — unify token values + tone vocab (`pos/neg`), keep both render methodologies, defer the L-effort primitive merge; grow the Kit with `con-table` + modal/sheet family first. Deliverables: `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md` + interactive artifact `https://claude.ai/code/artifact/792a356c-79df-4bb1-b413-5979dd67a909`. State: **Completed (analysis/plan deliverable)**; implementation **Planned** — owner to sequence (Phase 0 P0 first). Not deployed (no code).

- 2026-07-06 - **Console de-alarm + optional confirmation + legacy /old removal + Cmd-K + admin hub (CLAUDE).** One PR on `claude/vigorous-lederberg-5b6d55`: removed the real-money banner + "START LIVE" typed ritual; added `policy.requireTypedConfirmation` (Settings -> Advanced action confirmation, default ON; OFF = one-click approve/replace/loosen, enforced server+console+mobile); deleted the legacy `/old` dashboard (~14 exclusive files + 2 dead tests; Strategy Flow dropped, legacy palette replaced); added a console-native Cmd-K command palette; added an operator admin hub (/admin) + env-gated admin.socratictrade.com scaffold (ADMIN_HOST + AUTH_COOKIE_DOMAIN); fixed a pre-existing flaky socratic-db ordering test (rowid tiebreakers). Verified: tsc clean, npm test 2642/2642, build green. Rollout: docs/rollouts/2026-07-06-console-de-alarm-confirmation-toggle-legacy-removal-cmdk-admin.md. State: **Completed (in PR, pending merge)**; owner follow-up: admin subdomain DNS/env, and optionally default requireTypedConfirmation OFF.

## 2026-07-06 - UI expert-panel backlog: all 55 findings (CLAUDE)

Source: `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md` (7-lens panel, adversarially
verified). Per owner: EVERY finding is logged. Findings where CLAUDE has no strong opinion on the best fix
are marked **TBD (owner/design decision)** rather than given a fabricated confident action. Severity in
brackets; effort S/M/L.

### Resolved by PR #1018 (no further action)
- [P0][Visual] Money-reality banner hardcoded dark-only -> DONE: banner removed entirely (real money = normal, no banner).
- [P1][UX] Command palette never wired into console -> DONE: native Cmd+K palette added.
- [P3][FE] app/old second dashboard -> DONE: deleted (redirects to /console).
- [P2][A11y] ConfirmationModal typed-gate aria-live -> MOOT: ConfirmationModal deleted with the legacy dashboard.
- [P2][A11y] Framer overlays ignore prefers-reduced-motion -> MOSTLY MOOT: those app/ui overlays deleted; the new console Cmd+K palette uses reduced-motion-safe CSS.
- [P2][DS] Duplicated symbol-drilldown/ticker-logo drifted forks -> RESOLVED: app/ui copies deleted; only console/ui versions remain.
- [P3][FE] ticker-logo monogram duplication -> RESOLVED (same deletion).
- [P2][Visual] dashboard-client type-scale bracket drift -> MOOT: dashboard-client.tsx deleted.
- [P2][Visual] dashboard-client backdrop-blur vs elev-* -> MOOT: dashboard-client.tsx deleted (apply elev-* discipline to remaining app/ui data surfaces if any).

### Action - clear recommendation (Planned)
- [P1][A11y][S] AlertCenter filter buttons color-only -> add aria-pressed to the 4 filter buttons.
- [P1][A11y][S] Console has no 44px touch-target floor -> min-h/min-w 44px on @media(pointer:coarse) for .con-btn + compact chrome triggers.
- [P1][Mobile][S] PWA traps users on /mobile -> add "Open full console" link in the /mobile header.
- [P1][Mobile][S] Table row actions ~26px -> mobile-only ~40px min-height on Cancel/Replace row buttons.
- [P1][UX][S] Decision-trace back always returns to /console -> router.back() guarded, fallback to Journal.
- [P1][UX][S] Scan has no add-to-watchlist -> per-row Watch button -> POST /api/watchlist (or ?add=SYMBOL prefill).
- [P1][Visual][S] Capability badges 9-hue rainbow -> collapse to --info chips (+icons), --warn only for OAuth-needed.
- [P2][DS][S] pos/neg vs up/down tone vocab -> standardize on pos/neg across both systems (keystone unification).
- [P2][DS][S] Console lacks Segmented primitive -> port a console Segmented; refactor policy-form to use it.
- [P2][DS][S] Radius scales unmapped -> agree one card-corner + one control-corner value both systems reference.
- [P2][DS][M] Primitive parity gaps -> build a parity matrix; port IconButton + RawNumInput both ways.
- [P2][A11y][S] Console Sheet has no accessible name -> useId heading id + aria-labelledby.
- [P2][Mobile][M] Wide tables no mobile layout -> lg:hidden card-list per row for Scan/Orders/Positions.
- [P2][Mobile][S] apple-touch-icon SVG-only -> add 180x180 + 192/512 PNG icons.
- [P2][Mobile][S] FreshnessStrip behind tab bar -> surface daily-spend + data-as-of in sticky top chrome on mobile.
- [P2][Mobile][S] Mobile "More" flat list -> group into Monitor/Configure/Review clusters.
- [P2][Data][S] Equity chart exaggerates flat moves -> minimum +/-0.5% Y-span.
- [P2][Data][M] Guardrails caps show no utilization -> inline deriveRiskUtilization meter/sub-label per row.
- [P2][Data][S] Meter caps at 100%, hides breach -> hatched breach fill + "+$X over" when value>max.
- [P2][Data][S] Orders last-price staleness only on hover -> persistent "scan Nm ago" age suffix.
- [P2][UX][S] Bulk-reject no confirm -> one-click inline confirm (NO typed phrase; philosophy-aligned).
- [P2][UX][S] Nav noun collision Decisions vs /decisions/[id] -> rename to resolve the clash, keep branded names.
- [P2][FE][M] page.tsx/strategy monoliths -> extract pure derive* into lib/derive.ts + presentational sub-components.
- [P2][FE][S] Repeated !snapshot guards -> narrowed useConsoleSnapshot() hook for top-level pages.
- [P2][Visual][M] Marketing pages text-only -> add a console decision-trace mock (welcome) + loop diagram (how-it-works).
- [P3][DS][S] ui Switch lacks disabled -> add disabled to Switch.
- [P3][FE][S] Console 3 tone->token maps -> one exported TONE_VAR map.
- [P3][UX][S] Approvals header vs nav badge disagree -> show learned-context count in the header + jump anchor.
- [P3][UX][M] Guardrails framing inconsistent -> give equally-consequential settings the same one-sentence note.
- [P3][Mobile][S] Mobile no offline handling -> navigator.onLine offline banner.
- [P3][Data][S] No short-P&L sign test -> add the unit test.
- [P3][Data][S] Allocation no concentration cue -> warn/neg tint on segments over maxSymbolExposurePct.
- [P3][UX][S] Scan tab switcher no ARIA -> role=tablist/tab/tabpanel + aria-selected.
- [P3][Visual][S] Login border-border undefined class -> border-line; Apple button -> bg-fg text-bg tokens.
- [P3][Visual][S] Thesis-hero gradient wash -> drop it / reduce to a 3px accent left-rule (flat surface for reasoning text).

### TBD - no strong CLAUDE opinion; owner/design decision
- [P1][DS][S] Brand accent green vs teal: the MECHANISM is clear (both derive from one --brand-accent), but the HUE is an owner brand call. TBD (lean: green, the documented brand color).
- [P1][Visual][M] Fourth palette at /design/socratic-trade: delete vs rebuild-on-tokens. TBD (is that showcase route wanted? lean: delete).
- [P2][DS][M] Dark-mode dual mechanism (.dark vs data-theme) can desync: consistency nicety, unclear ROI (each renders fine alone). TBD.
- [P2][DS][L] console.css -> @theme migration (full token/utility unification): large epic; design direction recommends DEFER. TBD (scope as its own project or drop).
- [P2][FE][L] app/ui vs console/ui full primitive merge: out of scope per console's own charter. TBD (share a headless pos/neg Tone vocab; defer the merge).
- [P2][Mobile][S] Mobile primary-3 tabs chosen by array index: which 3 to prioritize is a usage/product judgment. TBD (owner: which 3?).
- [P2][Data][M] Scan "Vol" column blended semantics: fix depends on whether the enrichment layer carries a per-row semantic flag (unverified). TBD (needs data-layer check first).
- [P2][UX][S] No manual/discretionary order-entry path: is manual trading in scope? TBD (owner). If not, add a note that orders originate from approved proposals only.
- [P3][FE][M] Zero React.memo/useMemo perf: "low priority given small data volumes" per the finding. TBD (defer unless refresh-flicker appears).
- [P3][FE][S] useConsoleData unconditional abort of in-flight refresh: TBD (defer unless refresh-storm symptoms appear).
- [P3][Data][S] Partial/stale/status spread across 3 order columns: optional; row already highlights when stale. TBD (low value).
| 2026-07-09 | Socratic.Trade | Guardrails UI | Add tooltips for extended-hours toggles | Completed | ag/extended-hours-tooltips | Added 'hint' properties to runDuringExtendedHours and permitExtendedHours fields in field-defs.ts. |
- **Verify Lint and Tests (AG)** — COMPLETED 2026-07-09. Ran `npm run lint` and `npm run test` across `trading-antigravity`. 0 errors and 0 failing tests found. No fixes required.
| 2026-07-09 | Socratic.Trade | Next.js Server | Fix SSE deadlock exhaustively locking HTTP connection pool in useConsoleData | Completed | ag/sse-deadlock-fix | Added visibility state check to properly close EventSource for background tabs. |
| 2026-07-09 | Socratic.Trade | UI | Turn static LoadingBrand into a fast, pulsing candlestick animation | Completed | ag/loading-animation | Exposed speedMs on HeaderLogo and applied animate-pulse to LoadingBrand. |

- 2026-07-08 - **UI wave 4: scope-selector dropdown + floating mobile Tabs sheet + badge spacing (CLAUDE, 3-agent team).** ScopeSelector rebuilt Sheet->real anchored dropdown (accounts + reality/run chips + "Configure accounts" -> settings#brokers; Esc/focus-return/aria; .con-menu-drop slide-down; desktop min-w 190px); mobile TabsSheet floats above the still-visible tab bar (live-measured bar height, all destinations visible on iPhone, real-time pin feedback, scrim stops at bar); tab-bar badge clearance +~5px. AUDIT of the 55-findings backlog vs current main (post #1103/#1110/#1173/#1178): 37 DONE, 2 PARTIAL (primitive parity mostly ported; monolith extraction has derive.ts, pages still large), 7 OPEN = 6 owner TBDs + useConsoleSnapshot() refactor (deferred). No conflicts with past decisions. Rollout: docs/rollouts/2026-07-08-ui-wave4-scope-dropdown-tabs-sheet.md. State: **In Progress (PR pending)**.

