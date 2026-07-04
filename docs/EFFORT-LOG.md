# Effort Log — cross-agent board

**Canonical live board:** `/Users/jay/apps/TRADING-EFFORT-LOG.md`

This repo file is the tracked mirror for commits/PRs. Update the canonical live board first so
agents in other worktrees can see reservations before code lands, then mirror relevant state here
before committing.

The owner's at-a-glance ledger of every effort and its state. **Every agent on every platform
(Claude Code, Codex, Antigravity/Gemini, Cursor, web/cloud sessions) MUST keep this current** as
part of the Pre-Commit / Handoff Protocol in `AGENTS.md`. Move each row between the four states as
it changes; add new efforts as they are conceived; never delete another agent's row — correct it
in place and note the correction.

**State definitions**
- **Planned** — agreed/queued, not started. Include blockers (esp. "needs owner decision").
- **In Progress** — actively being built; carry a one-line status + the owning agent/branch.
- **Completed** — merged to `main`. This auto-deploys to **beta/integration only**
  (`trading-beta.jays.services`), NOT production.
- **Deployed to production** — the separate **owner-run** release step (`~/apps/trading-live`,
  pm2 `trading`, release branch). Cloud/agent sessions cannot perform or verify this — only move a
  row here when the owner (or a release runner) confirms the production deploy actually happened.

_As of 2026-07-04. PR numbers are GitHub `jaywedgeworth22/agentic-trading`._

---

## 🚀 Deployed to production

_Owner-managed release; not verifiable from cloud/agent sessions. When the owner promotes `main`
to `socratictrade.com`, record the release commit + date here._

- **2026-07-02 (evening)** — `trading-live` observed at `eae514be` (post-#338) on the
  deploy machine. **Incident:** the deploy boot-crashed on the pre-existing prod DB
  (`no such column: client_turn_id`, Sentry `a595484d…`, release `8e2b1181` = #333);
  `/api/health` 500 with pm2 crash-looping. **Recovered 2026-07-03 ~01:50 CDT** by
  backing up the DB and applying the migration's own additive `ALTER`, then restart —
  health 200. Root cause + regression test in the P0 hotfix row below; full detail in
  `docs/rollouts/2026-07-03-clientturnid-migration-hotfix.md`.
- **2026-07-03** — `trading-live` published at `7b803bff` (PR #346) on
  `socratictrade.com`. Includes #345 run-state UX and #346 IRA wash-sale UI correction;
  production health 200 and live Roth IRA Settings page verified.
- **2026-07-03** — `trading-live` published at `481e9dcc` (PR #347) on
  `socratictrade.com`. Includes the Guardrails Universe index exclusivity fix;
  production health 200 and live S&P/Nasdaq mutual-exclusion UI behavior verified.
- **2026-07-03** — `trading-live` published at `0941b4d2` (PR #349) on
  `socratictrade.com`. Includes Socratic admin/RAG/Pinecone/settings parity,
  provider-specific model reasoning controls, OAuth host canonicalization,
  `/old`, ticker drawer coverage, and user/admin LLM usage visibility. Production
  health 200 and Google/GitHub OAuth redirect URIs verified on the Socratic domain.
- **2026-07-03** — `trading-live` published at `afbe1c87` (PR #352) on
  `socratictrade.com`. Includes RAG provider/quota Sentry visibility, Pinecone-hosted
  embedding-model documentation, Infisical Socratic.Trade slug documentation, and
  production health 200 after deployment.
- **2026-07-04** — `trading-live` published at `d39e1193` (PR #353) on
  `socratictrade.com`. Includes explicit `Test Account - Local Mock Paper Account`
  restore and Pinecone/Voyage/provider cap email alerts; production health 200 after
  deployment.

---

## ✅ Completed (merged to `main`, on beta/integration)

### Console parity port — legacy `app/ui/*` rebuilt as `/console` (2026-07-02)
- **#321** — parity-port foundation: logo/model/drilldown primitives, nav scaffolding, model-attribution approval card.
- **#322** — Settings expansions: brokers, API keys, LLM model picker, delivery channels, glossary.
- **#324** — Learned-context approval inbox on `/console/approvals`.
- **#325** — AI Assistant chat destination (`/console/assistant`) → staged proposals. _(incl. coordinator round-2 fixes: ref-during-render lint, image-exfil block, preview-race generation guard, frozen staged scope.)_
- **#326** — Macro & market-regime board (`/console/macro`) + honest no-FRED handling (`fredSourced`).
- **#327** — Scan destination: Market Scan table + Smart Money.
- **#328** — Orders destination: open orders, stale-limit detection, replace-at-market, cancel.
- **#329** — Parity tail: run-blocked routing, sign-out, allocation, watchlist+alerts, consent gate, sharing prefs, account deletion, admin links, badge fold-in.
- **#330** — Symbol drilldown superset of the legacy company drawer.

### Real-money / tax gate (2026-07-02)
- **#323** — Wash-sale handling modes (`block`/`ask`/`auto`) + Decide-mode escalation framework. _(incl. coordinator round-2: account tax-type precedence, in-run cap demotion, `transitionProposalIfPending` CAS.)_
- **#331** — IRA wash-sale disregard setting (`taxSettings.iraWashSaleHandling`), owner-requested. Default `block` (unchanged); `disregard` proceeds annotated ("Wash Sale (Technically, but IRA purchase unreported to IRS)") + audited. _(incl. coordinator Codex round-1: prompt threading via `isIraTaxRegime`, deferred disregard audit to execution, `decision.approved` gate.)_

### Backend follow-ups (2026-07-02, landed by parallel sessions)
- **#332** — `@sentry/nextjs` bump to ^10.63.0 + short/cover risk-path semantics clarification.
- **#333** — Chat idempotency: `clientTurnId` retry dedupe on `POST /api/chat` (migration v10).
- **#334** — Persist failover-aware `proposedByModel` per proposal; blank (never fabricate) no-FRED macro (`DEFAULT_MACRO`→`BLANK_MACRO`, `pruneMacro` drops `""`).
- **#335** — `EquityOrder` limit/stop/TIF through Alpaca+Robinhood mappers + `/console/orders` columns; disclosure-ordered congress cap; `MarketQuoteSummary` factor/headlines/volume fields; Turbopack dev fix.
- **#336** — `sources.price` provenance in `mergeQuoteData` (merged broker/Yahoo price now attributed to the merge provider, not the stale screener) + this cross-agent effort log.
- **#337** — Owner decisions record + `docs/manager-model-options.md` (cross-provider model comparison for the strategist role).

### P0 hotfix (2026-07-03)
- **#341** (`claude/fix-baseddl-index-migration`) — boot crash on every pre-existing DB: #333's baseline-DDL
  `idx_chat_turns_user_client` ran before the versioned ALTER (`no such column` on old DBs; fresh-DB CI
  stayed green). Baseline reverted to frozen `SCHEMA_BASELINE`; versioned migration is the single source;
  regression test boots `getDb()` against a simulated pre-#333 DB. Prod/preview DBs already hand-patched
  (see Deployed section).

### Rebrand (2026-07-03)
- **#340** — Rebrand Agentic Trading → **Socratic Trade** / socratictrade.com (`claude/rebrand-socratic-trade`).
  Owner set up prod infra as "Socratic Trade" (Sentry project, Cloudflare DNS, GitHub OAuth callbacks,
  Google authorized domains — owner-side). Code aligned: display brand → "Socratic Trade" (no-space
  "Socratic.Trade"); legacy production host fallback → `socratictrade.com` (env-first);
  Sentry slug → `socratic-trade`; active telemetry/notify/MCP/FINRA/account-deletion fallback identifiers
  now use Socratic Trade naming. Deliberately NOT touched: `mail@jays.services` login email, the Robinhood
  "Agentic" account nickname, internal jays.services preview subdomains.

### De-paternalization + CI hardening (2026-07-03)
- **#339** — De-paternalize Step 1: deleted the paper-default / `paperMode:false` Don't-rule + the
  "defaults to Test mode" framing from `AGENTS.md`; added the "Product philosophy — real trading,
  owner's risk" section (an account is an account; no Test-mode/local-sim; harden CORRECTNESS +
  multi-user safety, NOT obedience). Also fixed the July-4 CI holiday flake (`isTradingDay` VITEST-gated
  test seam, so `verify` stops going red on market-closed days) and purged the contradicting Cursor
  rule (`.cursor/rules/handoff.mdc`). _(incl. coordinator Codex round: VITEST gate on the seam so a
  stray flag can't defeat the real market-closed guard; Cursor-rule rewrite; EFFORT-LOG stale-bullet
  supersede.)_
- **#342** — De-paternalize Step 2: removed `policy.paperMode`/`paperStartingCash` and the `test/local`
  local-simulator execution path entirely (`usesLocalSimulation`, `getPaperPortfolioProjection`, local
  paper-fill/portfolio branches). `deriveExecutionState` (`execution-mode.ts`) is the sole hub — mode is
  purely `broker/paper`/`broker/live` from the active account's `environment`; no account ⇒ honest
  "No account" state (`submitsBrokerOrders: false`), never a fake-fill fallback. `TestBrokerGateway`/
  `broker:"test"` kept as test infrastructure only (~36 test files migrated to a connected test-broker
  account). Fixed a real bug: broker-paper fills were mislabeled "Test" in the Activity feed. 83 files,
  +854/−1208.

### Socratic autonomy UI/runtime (2026-07-03)
- **#344** — Socratic Trade Autonomy Desk implementation (`codex/socratic-trade-autonomy-mockup`):
  persisted Socratic decisions/framework proposals, `/api/socratic/*`, RAG attribution, coach notes,
  framework proposal review, strategy-loop decision recording, private institutional-memory indexing,
  Socratic override semantics for owner-preference gates, public `/welcome` and `/how-it-works`,
  coded `/design/socratic-trade`, and exact production-domain references changed to
  `socratictrade.com`.
- **#345** — Run-state UX fix (`codex/run-state-ux-fix`): Start/Resume are no longer hidden behind a
  red STOP affordance. Paused states show Start or Resume as the primary header action; STOP/Wind down
  remain red, and start/autonomy confirm flows use primary styling.
- **#346** — IRA wash-sale UI correction (`codex/ira-washsale-ui-fix`): Roth/traditional IRA accounts
  show same-account IRA wash sales as ignored/not applicable, hide the taxable Block / Ask / Auto
  selector, and expose only the cross-account IRA taxable-loss rebuy setting.
- **#347** — Console universe index exclusivity fix (`codex/universe-exclusive-indexes`):
  `/console/guardrails` now uses the shared `toggleIncludedIndex` helper for Base indices, so
  S&P 100/S&P 500 and Nasdaq 100/Nasdaq Composite replace each other immediately in the draft.
- **#348** — Sell to Fund Buys title-case copy fix (`codex/sell-to-fund-title-case`):
  Guardrails and legacy dashboard Sell to Fund Buys labels/options now use Title Case, and the
  Guardrails save-review diff shows Title Case instead of raw lowercase enum values.
- **#349** — Socratic admin/RAG/Pinecone/settings parity implementation
  (`codex/live-thesis-portfolio-framing`): default RAG index `socratic-trade`, Pinecone/Voyage
  health visibility, RAG ingestion brakes, provider-specific model reasoning controls, `/old`,
  OAuth host canonicalization, ticker drawer coverage, and user/admin LLM usage visibility.
- **#350** — AI Review inheritance, model catalog, and text-box font controls
  (`codex/ai-review-model-inheritance`): removed the misleading account-review model fallback,
  made blank AI Review inherit Red Team then Green Team, refreshed current curated provider model
  options, added DeepSeek V4 thinking controls, and made console text boxes use consistent readable
  fonts with user-selectable examples.
- **#351** — Console actions/evidence/live-account polish + RAG quota safeguards
  (`codex/console-actions-evidence-live`): action history/blocker copy, stopped cadence display,
  raw-vs-benchmark return tooltips, reduced live-account warning copy, broker roadmap, RAG usage
  labeling, Pinecone estimated Write Unit fuse, and earnings/RAG design docs.
- **#352** — RAG Sentry visibility + Pinecone hosted-model review
  (`codex/rag-sentry-visibility`): Sentry warning/error events for RAG provider failures and
  budget trips, Pinecone-hosted NVIDIA/MSFT embedding options documented as benchmark candidates,
  and Infisical project naming recorded as `Socratic.Trade` / `socratic-trade`.
- **#353** — Test Account restore + usage cap email alerts
  (`codex/restore-test-account-option`): explicit addable local mock Test Account that is not
  default-selected, plus Pinecone/Voyage/provider cap trips routed through `budget_alert` with
  email-capable fallback.

### Fleet observability (2026-07-04)
- **#371** — Additive Sentry CI failure reporter (`claude/sentry-ci-observability`), fleet-wide
  observability half (b). New `.github/workflows/sentry-ci-report.yml` +
  `scripts/sentry-ci-report.py`, zero edits to any pre-existing workflow: on
  `workflow_run: types:[completed]` across all 7 workflows that existed at authoring time,
  failure conclusion sends a raw-envelope Sentry error event to the `fleet-infra` Sentry project
  tagged `{workflow, branch, actor}` and fingerprinted `[workflow, branch]`; schedule-triggered
  runs additionally send a Sentry Crons check-in mirroring that workflow's own cron so a
  nightly/weekly job that silently stops running also alerts. Repo secret `SENTRY_FLEET_DSN` set
  via `gh secret set` (value never echoed/logged). Companion host-side monitor
  (`fleet-sentry-monitor` under pm2, machine-side, not in this repo) covers pm2 crash-loop/down
  detection, disk/WAL space, and `gh` rate-limit budget — see
  `docs/rollouts/2026-07-04-fleet-sentry-observability.md` for full detail on both halves.
- **PR #374 — GitHub Issues mirror of the effort board (`claude/effort-issues-mirror`).**
  Additive, read-only owner-visibility layer over `docs/EFFORT-LOG.md`: boards stay the single
  source of truth, agents never write issues — a workflow reconciles them. New
  `scripts/sync-effort-issues.py` (python3 stdlib, no deps) parses the board (keyword-classified
  `##` sections tolerant of heading/emoji drift, top-level bullets as items with continuation
  lines folded in, `<!-- effort-key: sha1(first-line) -->` identity marker for idempotent
  re-runs). Planned/In Progress -> issue open (`effort-board` + `state:planned`/`state:in-progress`,
  assigned `jaywedgeworth22` for mobile notifications); Completed/Deployed -> issue closed
  (`state:completed`/`state:deployed`). Never deletes issues; ignores hand-made issues without the
  marker; creates missing labels on first run. New additive workflow
  `.github/workflows/effort-issues-sync.yml` (push to `main` touching this file, daily off-minute
  cron for drift, `workflow_dispatch`). Rolled out identically to `congress-trading-shared` (PR #4)
  and `API-usage-monitor` (PR #9); canonical protocol doc
  (`/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`) gained an "Issues mirror (standard)" subsection +
  bootstrap-checklist update. Verified: parser tested directly against all three repos' real
  boards before rollout (58/1/2 items respectively, correct bucketing); a genuine duplicate board
  row surfaced by a live dry-run (this repo's own "Wave-1 quick wins..." logged twice under In
  Progress) was caught and fixed with in-run dedup; full local quartet green (lint 0 errors, tsc
  clean, 2436 tests, build ok); post-merge the push-triggered workflow run created all 58 issues
  correctly bucketed (32 completed/6 deployed closed, 9 in-progress/11 planned open), confirmed via
  the Issues API. See `docs/rollouts/2026-07-04-effort-issues-mirror.md`.

---

## 🔨 In Progress

- **CODEX console/UI swimlane (Codex, worktree `/Users/jay/apps/trading-codex-ui-swimlane`,
  branch `codex/console-ui-swimlane`) — claimed 2026-07-04 from sync-21.** Priority:
  approvals surface pack first (approval-card provenance, red-team trigger chip, R:R geometry,
  mobile LIVE phrase-gate parity, Sheet focus-trap), then `/console/decisions/[id]` decision-trace
  inspector over W2 case shapes, coach-on-trace UI, and the reserved ticker/settings/model parity
  trio. KEEPOUT: Claude memory/RAG internals and Monet risk gates. **Status 2026-07-04:** implemented
  and locally verified on branch; PR pending. Delivered approval provenance/citations, mobile LIVE
  phrase parity, Sheet focus trap, read-only decision trace + coach notes/framework `ownerResponse`,
  top ticker drawer gaps, and Strategy custom-model select parity. Verification: lint 0 errors / 308
  warnings, tsc, 253-file/2457-test suite, build.

- **Wave-2 composite-review — Outcome Engine lane** (Claude, branch `claude/w2-outcome-engine`,
  worktree `~/apps/trading-wt-w2-outcome`, based on `claude/w1-learning-loops`) — four §A items:
  (1) THE OUTCOME WRITER: new scheduled job `src/lib/outcome-engine.ts` on the counterfactual
  cadence; placed decisions join fill_events/closed lots, blocked/rejected (incl. Bear vetoes)
  join counterfactual refPrice; writes `outcome`+`measuredAt`, per-case receipt, awaited
  vector-memory re-index. (2) Multi-horizon outcome schema `outcomes[] {15m|1h|1d|1w, returnPct,
  spyExcessPct, priceBasis, resolution ok|unresolvable(reason)}` on decision cases AND
  skipped-counterfactual rows; 1d/1w from the daily cascade SPY-relative (trading-day
  arithmetic); 15m/1h only via an actually-sampled live quote, else honest
  `unresolvable(no_intraday_source)`. (3) Kill-survivorship: terminal `unresolvable` after a
  bounded 10-trading-day recheck; coverage disclosures on job receipts, `getRedTeamEfficacy`,
  missed-opportunity summary, `certifyForwardResolution`. (4) Budget-gated, batch-capped LLM
  post-mortem lessons at maturation (direction-tagged + verdictOnBelief/whichDissentMattered),
  routed through `ingestLearned` origin `autonomous`; all skips receipted. Gate green: lint 0
  errors, tsc clean, 2383 tests / 246 files, build green. **Pushed; NO PR — lands via the
  landing train after the base branch.** See `docs/rollouts/2026-07-04-w2-outcome-engine.md`.


- **`claude/ci-actions-efficiency` (Claude, worktree `~/apps/trading-wt-ci-efficiency`) → PR #370.**
  GitHub Actions minutes efficiency pass — personal Pro-plan quota (3,000 min/mo) was exhausted.
  `.github/workflows/ci.yml`: new cheap `classify` job computes on `pull_request` events whether
  the diff (`git diff --name-only base...head`) touches ONLY documentation-class paths (`*.md`
  anywhere, `docs/**`); the existing `verify` job (unchanged name — confirmed via
  `gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518` that `verify` is the ONLY
  required status check today, not smoke/gitleaks/check-pin as the AGENTS.md fallback list
  assumes) now step-conditionally skips checkout/install/lint/tsc/test/build when
  `docs-only == 'true'` and reports success immediately; any non-PR event or diff ambiguity falls
  back to the full gate.
  **Mid-review addition:** repo hit its 10 GB Actions-cache cap because a plain `actions/cache@v4`
  save (source-hash-keyed) wrote a new ~340 MB `.next` entry on every PR push with no cleanup on
  close, plus unbounded growth on `main`. Fixed via restore/save split
  (`actions/cache/restore@v4` always, `actions/cache/save@v4` gated to `main` pushes only) plus
  new `.github/workflows/cleanup-caches.yml` (PR-close cache delete + daily prune backstop via new
  `scripts/prune-stale-actions-caches.py`; not a required check).
  **Escalated, then re-confirmed during review:** hybrid self-hosted/hosted runner routing for
  `verify` onto the production `trading-live-mac` box was proposed; escalated back with
  objections (reverses the repo's own 2026-07-01 decision to move `verify` OFF that runner; a
  required check should not depend on which of two OS/toolchain environments executed it); the
  owner then re-confirmed AFTER seeing the tradeoff, with a resource-aware design answering each
  objection (availability publisher w/ load+RAM+hysteresis, instant hosted fallback on
  busy/stale, hosted-Linux arbiter on any self failure via exactly-one automatic hosted re-run,
  nightly hosted canary, per-run environment annotation) — to be built as its OWN PR after #370
  lands (see Planned row below). A cross-repo `workflow_call` reusable entry point stays deferred
  until that hybrid PR proves itself; hosted-only default when built. Neither implemented in this
  branch. **Codex review round:** two fail-open holes fixed (`--no-renames` rename-source hole;
  classify-failure skip hole via `!cancelled()` + explicit fail-closed step).
  No other workflow modified besides the two above — full audit table (every push/PR-triggered
  workflow, approx minutes, required-check status, batching candidates) in
  `docs/rollouts/2026-07-04-ci-actions-efficiency.md`, report-only for those other workflows.
  Verification: local quartet green (lint 0 errors, tsc clean, 2436/2436 tests, build ok) +
  `yaml-lint` on all workflow files + live ruleset API check + dry-run of the cache-delete command
  + synthetic-inventory test of the prune script. STATUS: implemented, PR #370 open; CI/Smoke/
  Security observed running live on the PR during review, so Actions quota is not currently
  blocking (contrary to the initial task assumption of exhaustion).

- **Wave-1 quick wins from the composite expert review** (Claude coordinator, 4 Sonnet lanes,
  push-only branches; landing via the active train):
  - `claude/w1-llm-fixes` — Bear schema confidenceScore fix (live bug); non-OpenAI reasoning-token
    headroom; cross-family Bear default + temperature; reward-abstention; stakes-scaled dissent
    trigger. **Merged** (PR #364).
  - `claude/w1-learning-loops` — Bear-veto counterfactuals + red-team efficacy scorecard; re-index
    decision memory on lifecycle changes; trading-day horizon arithmetic. **Merged** (PR #365).
  - `claude/w1-rag-quickwins` — relevance floor + near-dup dedupe wired; provenance headers + stable
    chunk ids; content-hash dedup on + 128-bit; embedding-model version tag; rerank pool cap.
    **Merged** (PR #366).
  - `claude/w1-regime-data` — landing now that gate is green. Typed `MarketRegime` enum + numeric
    severity in new dependency-free `src/lib/market-regime.ts` (re-exported from `macro.ts`;
    `determineMarketRegime` now a thin label-projection, byte-identical persisted strings).
    **Swimlane keepout:** the crisis cap (`policy.ts`) and bear filter (`strategy.ts`) deliberately
    KEEP their original substring/`startsWith` checks — per the owner-assigned Fable/Monet swimlane
    split (`#claude-monet-sync` sync·2), enum adoption inside risk-gate call sites belongs to the
    risk lane (Monet, PR #360); the typed predicates are exported and pinned by
    `test/market-regime.test.ts` for a one-line adoption there. The console regime card
    (`app/console/macro/indicators.ts`) does use the enum (client-safe, zero server-only imports).
    Live ^VIX overlay (`fetchLiveVix`/`fetchMacroDataWithLiveVix`, 10 min TTL, separate from the 24h
    macro cache) now feeds the vol brake and the regime-flip detector instead of the day-cached
    snapshot. `alpacaSnapshotTtlMs()` (~30s) replaces the blanket 6h TTL for the Alpaca snapshot
    enrichment cache, and `parseAlpacaSnapshot` now stamps `asOf` from `latestTrade.t`/`dailyBar.t`
    so the `maxQuoteAgeSec` staleness gate can see true quote age. Verified: lint 0 errors, tsc
    clean, 247 files / 2401 tests green, build green. See
    `docs/rollouts/2026-07-04-regime-enum-live-vix-alpaca-asof.md`.

- **Wash-sale gate — non-blocking defaults** (`claude/washsale-advisory-defaults`, Claude,
  **merged**, PR #362). Owner decision: `taxSettings.washSaleHandling` default
  `"block"` → `"auto"`; `taxSettings.iraWashSaleHandling` default `"block"` → `"disregard"`.
  Mid-task correction: "auto" no longer vetoes on a deterministic edge-vs-tax-cost threshold at
  all (removed as pseudo-math — it re-arithmetized the LLM's own confidence/target outputs); it
  now always proceeds, with the priced tax cost recorded on the receipt and threaded into the
  strategist prompt instead. `block`/`ask` remain valid opt-ins; receipt/annotation/audit
  machinery unchanged. Verified: lint 0 errors, tsc clean, targeted suite 218/218, full suite
  2352 passed / 17 failed (all 17 in the 8 pre-existing holiday-broken files), build green.
  See `docs/rollouts/2026-07-03-washsale-advisory-defaults.md`. **2026-07-04 (Fable):** Added 
  #agent-sync channel & protocol documentation (docs-only, separate branch `claude/agent-sync-protocol-docs`).

- **Console small fixes (t7/t18/t22/t39)** — branch `claude/console-small-fixes`, **merged** (PR #361).
  Scope: reusable `RawNumInput` component (fixes
  the "0."-input-collapse bug) applied at 4 numeric-input sites; `MARKET_REGIME_LABELS` persisted-
  contract const + test coverage for `determineMarketRegime`; account-deletion scope preview now
  warns about discarded pending learned-context items; `notify.bridge.error` ops-feed formatter.
  See `docs/rollouts/2026-07-03-console-small-fixes.md`.

- **Controlled RAG filing ingest smoke test** (Codex,
  `/Users/jay/apps/trading-codex`, branch `codex/rag-filing-ingest-smoke-fix`) — production verified
  against the new `socratic-trade` Pinecone index. One MSFT 10-Q now has 95 vectors and 95 local
  `document_chunks`; the timed-out first-run 56 duplicate vectors were removed. Code fix for
  deterministic SEC filing vector ids is implemented and awaiting PR.

- **Live-execution hardening — drawdown breaker → hard-halt** (coordinator, cloud, branch
  `claude/live-execution-hardening`) — first slice of the hardening build; implements owner decision #1.
  The account-level drawdown/daily-loss breaker now **hard-halts** on breach (`systemState → "halted"`:
  subsequent scheduled runs skip, manual `executeProposal` refuses, until the owner re-arms to
  `"active"`) instead of the softer `close_only`. Built as the owner's **overridable preference**
  `riskRules.drawdownBreakerAction: "halt" | "close_only"` (default `"halt"`), not a hardcoded cage; the
  breaker is still opt-in via the thresholds. Vol-panic brake stays `close_only` (out of scope of the
  drawdown decision). Verified current-run safety (in-run exec uses `placeEquityOrder`, not the
  halted-throwing `executeProposal`; policy gate treats halted==close_only for the current run, so it
  winds down gracefully). Gate green: tsc clean, lint 0 errors, **2351 tests / 239 files**, build green.
  **PR pending.** Remaining hardening half — prompt-expected stop-losses (decision #2) — is a separate
  follow-up. See `docs/rollouts/2026-07-03-drawdown-hard-halt.md`.
  NOTE: built before the decision-record correction landed (decision #1 is ADVISORY, not hard-halt —
  see Owner decisions below). **RE-SCOPED (2026-07-04, Monet):** see the row below.

- **Drawdown breaker → ADVISORY default (re-scope of #343)** (Monet, cloud, branch
  `claude/drawdown-advisory-rescope`) — owner reassigned this lane to Monet (swap: Fable → memory/RAG,
  Monet → risk engine; coordinated on Slack `#claude-monet-sync`). Reverts the mistaken hard-halt default
  to the owner's actual philosophy ("nothing is hard except which account to work in; agent decides, logs
  everything"): `drawdownBreakerAction` now `"advisory" | "close_only" | "halt"`, **default `"advisory"`** —
  on breach it writes a receipt + threads `drawdownAdvisory` into the strategist prompt (agent decides),
  NO `systemState` change; `close_only`/`halt` are explicit opt-ins. tsc/lint/2375 tests/build green.
  **PR pending.** Follow-up: advisory into the Bear context; broader per-gate sweep → owner questions first.

- **Expert design review — 147-finding improvement backlog** (Monet, cloud, branch
  `claude/expert-design-review`) — an 8-expert agent panel (ML/learning, RAG/embeddings, LLM-prompting,
  quant/risk, data-providers, data-ingestion, UI/UX, ML-systems) + synthesis produced
  `docs/reviews/2026-07-04-expert-design-review.md`: 147 prioritized improvements across memory/learning,
  LLM prompting, RAG/ingestion, data providers, decision-making, UI, and systems, each with a concrete
  approach + `[impact/effort]`; cross-cutting-gaps section; quick-wins/big-bets tables; Now/Next/Later
  roadmap. Docs-only. **PR pending.** (Read section E through the ADVISORY-guardrails correction above.)

- **Wave-1 composite-review quick wins — memory & learning-loop lane** (Claude, branch
  `claude/w1-learning-loops`, **merged**) — three items from the composite
  expert review (§A, lines 37-161):
  (1) Bear-veto counterfactuals: a Red Team veto now calls `recordRejectedProposalCounterfactual`
  (same pipeline as policy blocks/human rejections) in `strategy.ts`'s Bear-reject branch, stamped
  with `runId`+`model`; new `getRedTeamEfficacy()` in `performance.ts` joins matured vetoed-candidate
  returns to `proposal_rejected_by_red_team` audit events for rejection rate / veto value-add /
  survivor-risk hit rate / per-model breakdown — API/db-level only, no console/Results UI wiring
  (left for the console lane). (2) Re-index decision memory: `appendSocraticDecisionCoachNote` now
  re-calls `indexSocraticDecisionMemory` after the coach-note append (dynamic import avoids a
  `db-socratic -> socratic-memory -> vector-db -> ./db` cycle); the stable id/dedupKeyPrefix makes it
  an in-place upsert. (Outcome/lesson writers don't exist yet in this codebase — a separate,
  unassigned effort — so only the coach-note lifecycle path was wired.) (3) Trading-day horizon
  arithmetic: new `addTradingDays()` in `market-calendar.ts` (honors `isTradingDay`, walks weekends
  + holidays) replaces the calendar-ms arithmetic in `counterfactual-learning.ts` and `backtest.ts`'s
  `targetBusinessDate`, fixing weekday-dependent horizon noise; historical target dates for
  Thu/Fri-snapshotted candidates shift (one-time discontinuity, snapshot-tested). Verification green:
  lint 0 errors, tsc clean, **2377 tests / 245 files**, build green. See
  `docs/rollouts/2026-07-04-w1-learning-loops.md`.

- **Wave-1 quick wins from the composite expert review** (Claude coordinator, 4 Sonnet lanes,
  push-only branches; landing via the active train):
  - `claude/w1-llm-fixes` — Bear schema `confidenceScore` fix (live bug: strict Bear
    schema previously stripped confidence, zeroing the approval-time debate trigger and degrading
    sizing); per-provider reasoning-token headroom for xAI/Gemini/Mistral/DeepSeek chat-completions
    (previously OpenAI-only); cross-family Bear default (only when a cross-family credential exists)
    + non-zero adversary temperature (0.7) for the Bear/debate roles via `withLlmRequestBounds`;
    reward-abstention line in the Bull system prompt; stakes-scaled Red Team dissent trigger
    (notional %-of-NAV, live opening, escalation regime, or a requested autonomyOverride — not
    confidence alone). `STRATEGY_PROMPT_VERSION` bumped to `agentic-strategy@1.4.0`. Advisory-only,
    no new hard gates. **Merged** (PR #364).
  - `claude/w1-learning-loops` — Bear-veto counterfactuals + red-team efficacy scorecard; re-index
    decision memory on lifecycle changes; trading-day horizon arithmetic; Codex review fixes
    (market-day horizons, kind-scoped veto audits, evidence backfill). **Merged** (PR #365).
  - `claude/w1-rag-quickwins` — dormant relevance-floor + near-dup dedupe wired into
    `strategy.ts`/`chat/orchestrator.ts`; provenance headers (`formatChunkWithProvenance`) prepended
    onto the joined RAG context; widened `hashContent` 16→32 hex chars (64→128-bit); stamped
    `embed_model`/`embed_rev` on every new vector; env-tunable rerank over-fetch cap
    (`VECTOR_RERANK_OVERFETCH_K`, default 150). **Merged** (PR #366).
  - `claude/w1-regime-data` — typed regime enum + numeric severity; live ^VIX off the 24h macro
    cache; per-data-class TTLs + asOf on Alpaca snapshot. **Merged** (PR #368).

- **Wave-2 memory/RAG core** (Claude/Fable coordinator — OWNER-ASSIGNED swimlane; lanes stacked on
  their w1 dependency branches, push-only, landing via the train). Lanes: `outcome-engine`,
  `episodic-retrieval`, `coaching-durable`, `reflection-decompose` (full lane list on the live board
  `/Users/jay/apps/TRADING-EFFORT-LOG.md`).
  - `claude/w2-episodic-retrieval` (this lane) — **done, pushed, awaiting the landing train** (base:
    `origin/claude/w1-rag-quickwins`). Composite review A1 ([Both], the highest-leverage item): new
    `src/lib/experience-memory.ts` — closed-lot experience writer hooked fire-and-forget in
    `performance.recordFillFromProposal` (state vector: 8 factor sub-scores + entryMarketRegime +
    breadth snapshot + thesisTag + sector + entry rationale; realized
    `{return_pct, holding_days, risk_exit, mae?, mfe?}` metadata; `source="experience-memory"`
    namespace keyed by the ENTRY proposalId); decision-time SECOND retrieval pass over
    `['socratic-decision','coach-note','lesson']` with a situation-sketch query (cross-symbol via
    additive `RetrieveOptions.matchAllSymbols`, same-run exclusion, as-of stamped); labeled
    "Closest historical analogs" (+`[COUNTEREXAMPLE]` on opposite-sign priors, top-analog
    similarity shown) + "Owner coaching" blocks injected into BOTH Bull and Bear userContent;
    injected ids persisted per run (`experience_retrieval` audit + rag attributions). Opt-out
    `EXPERIENCE_MEMORY=off`. Verify green: lint 0 errors, tsc clean, **2395/2395 tests**, build
    green. See `docs/rollouts/2026-07-04-w2-episodic-retrieval.md`.

---

## ✅ Owner decisions (2026-07-03) — sovereign-design + housekeeping

1. **Drawdown circuit-breakers → ADVISORY** _(CORRECTED later on 2026-07-03 — the "HARD-HALT" record
   was wrong; the owner didn't understand the question as originally asked)._ Confirmed intent, in the
   owner's words: **"nothing is hard except which account to work in."** A drawdown breach is an
   advisory input the agent weighs with its own judgment; it may proceed, and every deviation surfaces
   as a logged receipt for review and coaching. The same philosophy governs ALL guardrail lines (spend
   caps, sizing, etc.) — the **account boundary is the only absolute**. Confirmed option: "Agent
   decides, logs everything." See `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md`.
   ~~Was recorded as: HARD-HALT — a drawdown breach halts autonomous trading until manually re-armed.~~
2. **Stop-losses → PROMPT-EXPECTED.** The LLM proposes stops and policy validates; NOT schema-forced.
   _(Owner chose the more flexible option over the fail-closed default.)_
3. **Manager model tier → EVALUATE cross-provider, not a single pick.** Owner wants a list of options
   (incl. DeepSeek for cost) and to measure how each performs — see `docs/manager-model-options.md`.
   Recommended path: A/B Sonnet 5 / DeepSeek V4 Pro / GPT-5.5-or-Gemini-3.1-Pro in paper mode and rank
   by realized per-model P&L (now measurable via #334's `proposedByModel`). Budget: $25–200/mo covers a
   single model at ~20 runs/day; ~$300/mo covers a 3-model A/B.
4. **Draft #315 → CLOSED** (superseded by the console port).

---

## 📋 Planned

- **Hybrid resource-aware runner routing for `verify` (Claude, own PR after #370 lands) —
  RESERVED 2026-07-04, owner re-confirmed with design.** Route the required `verify` check to the
  self-hosted Mac runner ONLY when the Mac has spare capacity, hosted otherwise. Design (per
  owner, answering the objections raised when this was first proposed): (1) Mac-side
  `scripts/runner-availability.sh` under pm2 (owner-started; pm2 one-liner + idempotent setup
  note in the PR) — every 60s: available = 1-min loadavg/hw.ncpu < 0.6 AND free+inactive RAM
  > 6 GB AND runner process alive AND pm2 `trading` online; hysteresis 2 consecutive available
  checks before flipping to self, immediate flip to hosted on busy; publishes repo variable
  `VERIFY_RUNNER_STATE` as JSON {"mode","ts"}; self-path gate commands run under `nice -n 19`.
  (2) Router reads `vars.VERIFY_RUNNER_STATE` natively; mode!=self OR ts stale >5 min OR var
  absent -> hosted instantly (self-hosted concurrency-1 stays as a load-shed detail). (3)
  verify-self FAILURE triggers exactly one automatic hosted re-run and the gate takes the hosted
  result on disagreement (Linux arbiter — a Mac flake can never block or fake-fail a merge); a
  self PASS stands; nightly scheduled hosted full-gate canary on main; gate summary annotates
  which environment produced each result. macOS-ARM64 cache namespace; node presence fail-fast;
  smoke/gitleaks/check-pin stay hosted. Rollout doc must include the 2026-07-01 history, the
  objections, the owner's re-confirmation + resource-aware answer, and a failure-mode table.
  `workflow_call`/reusable (cross-repo) remains deferred until this lands and proves itself —
  hosted-only default stands; resource-aware routing stays opt-in per repo.

### Socratic console parity sub-lanes — reserved before implementation
- **Universal ticker detail drawer parity** — restore old-site discoverability by making ticker symbols
  open the shared drilldown/drawer consistently across scan, home, evidence cards, proposals, orders,
  and other console surfaces. Reserved under the broader Codex parity effort so parallel agents do not
  start a duplicate ticker-detail lane. Initial high-signal gaps covered by `codex/console-ui-swimlane`;
  new console surfaces should default to `SymbolButton` for actionable tickers.
- **Settings affordance and tooltip pass** — add clearer option descriptions/tooltips, replace confusing
  loose/tight wording with lock/unlock-style affordances, and turn absolute-vs-percent pairs into a
  polished mode switch where the pair represents alternative ways to express one constraint.
- **Model/provider control parity** — move strategy model controls toward curated dropdowns with
  provider-aware settings, showing reasoning controls only for models that actually support them.
  Initial Strategy custom-model selected-state parity covered by `codex/console-ui-swimlane`.
- **Admin connection health and backend-failure notification pass** — surface every backend dependency
  including Pinecone/Voyage, distinguish global backend failures from user-key failures, and route
  global failures to admin email/health while user-key failures become user notifications.

### Ready to build — decisions in
- **Live-execution hardening (next major build).** Now unblocked by decisions 1–2:
  - **Advisory drawdown awareness (corrected target)** — surface the breach state to the agent
    (prompt context) and to the owner (receipt/notification + coaching trail); NO halting.
    _(Corrected from "hard-halt" — see Owner decisions above.)_
  - **Hard-halt drawdown circuit-breakers** — ✅ built (merged as #343, branch
    `claude/live-execution-hardening`): `riskRules.drawdownBreakerAction` default `"halt"` flips the
    breaker to `systemState → "halted"` on breach until manually re-armed; overridable to `"close_only"`.
    NOTE: built before the decision-record correction landed; re-scope pending owner review.
  - **Prompt-expected stop-losses** — REMAINING: strengthen the strategist prompt + schema to expect a
    stop on opening proposals, with policy validation (NOT a schema hard-requirement, per owner).
  - Build/test against a **connected broker account** (paper or live); the removed local Test mode /
    `paperMode` default is gone (#342). Keep the existing typed-confirm ritual before any live toggle.
- **Manager-model A/B** — wire the shortlisted models via the OpenAI-compatible path (base-URL swap;
  DeepSeek/xAI/Qwen/Gemini) + the existing Anthropic path, run in paper mode, compare per-model Results.
  See `docs/manager-model-options.md`.

### Planned — actionable, not yet started
- **Per-model hit rates on Results** — now that `proposedByModel` persists (#334), surface realized
  win/return grouped by served model. _(Directly enables the Manager-model A/B above.)_
- **Per-field FRED sourcing** — a partially-failing FRED fetch still placeholder-fills individual
  series while the suite is flagged sourced; close with per-series flags (#326/#334 follow-up).
- **SSE for the learned-context inbox** — replace the 60s poll if the console gains an event stream.
- **`MarketQuoteSummary` factor bars for all scanned symbols** — #335 carried factor fields into the
  summary tier; confirm drilldown factor bars now populate for every scanned symbol, not just top candidates.

---

## Changelog of this log
- 2026-07-03 — Created (coordinator). Seeded from the 2026-07-02 landings (#321–#335) + the
  in-progress `sources.price` fix + blocked sovereign-design decisions.
- 2026-07-03 — #336 merged (→ Completed). Recorded the four owner decisions (drawdown=hard-halt,
  stops=prompt-expected, Manager=cross-provider A/B, #315 closed). Live-execution hardening moved
  Blocked → Ready. Added `docs/manager-model-options.md`.
- 2026-07-03 — #337 merged (→ Completed). In Progress now empty; next work is the Ready items
  (live-execution hardening + Manager-model A/B).
- 2026-07-03 — Added the CI holiday-flake fix (In Progress → on #339) after `verify` went red on the
  observed July 4 closure; fixed via a `vitest.config` `test.env` seam in `isTradingDay`, zero test-file
  edits so it won't collide with the paperMode-removal branch.
- 2026-07-03 — **#339 merged** (→ Completed): de-paternalize Step 1 rules + CI holiday-flake fix +
  Cursor-rule purge (incl. Codex round: VITEST-gated seam, Cursor rewrite). In Progress now = Step 2
  paperMode/test-mode runtime removal + the Socratic Trade rebrand.
- 2026-07-03 — Started the **Socratic Trade rebrand** (branch `claude/rebrand-socratic-trade`): brand
  "Agentic Trading" → "Socratic Trade", public host fallback → `socratictrade.com`, Sentry slug →
  `socratic-trade`; login email + internal machine slugs + Robinhood "Agentic" nickname untouched.
- 2026-07-03 — **#340 rebrand merged** (→ Completed) and **#341 DB P0 hotfix merged** (→ Completed).
- 2026-07-03 — De-paternalize **Step 2 code-complete** (branch `claude/remove-paper-test-mode`):
  `policy.paperMode` + the `test/local` local-simulator execution path fully removed across ~35 src +
  36 test files; rebased on `origin/main` (#340 + #341); gate green (tsc/lint/2350 tests/build); PR
  opened, still In Progress until merged.
- 2026-07-03 — **#342 merged** (→ Completed): paperMode/Test-mode runtime removal. Started
  **live-execution hardening slice 1** (branch `claude/live-execution-hardening`): drawdown breaker →
  hard-halt via overridable `riskRules.drawdownBreakerAction` (default `"halt"`); gate green
  (tsc/lint/2351 tests/build); PR pending. Remaining: prompt-expected stop-losses (decision #2).
- 2026-07-03 — **#344 merged** (→ Completed): Socratic Trade autonomy UI/runtime implementation.
  Started the run-state UX fix (`codex/run-state-ux-fix`) so Start/Resume is no longer hidden behind
  a red STOP control and start flows do not use danger-red styling.
- 2026-07-03 — **#345 merged** (→ Completed): run-state UX fix. Started the IRA wash-sale UI
  correction (`codex/ira-washsale-ui-fix`) so Roth/traditional IRA settings do not present taxable
  Block / Ask / Auto as the relevant same-account wash-sale control.
- 2026-07-03 — **#346 merged + deployed** (→ Completed / Deployed): IRA wash-sale UI correction at
  `7b803bff`; production health and Roth IRA Settings UI verified. Started
  `codex/universe-exclusive-indexes` to restore mutually-exclusive full-overlap index selection in the
  console Guardrails universe picker.
- 2026-07-03 — Made `docs/EFFORT-LOG.md` maintenance explicitly binding at start/handoff/commit/PR/
  merge/deploy boundaries in `AGENTS.md`. Started the broader Socratic admin/RAG/Pinecone/settings
  parity implementation in Codex branch `codex/live-thesis-portfolio-framing`.
- 2026-07-03 — Tightened the `AGENTS.md` EFFORT-LOG rule: every non-trivial effort gets a **Planned**
  row before substantial work starts, specifically to stop parallel agents/platforms from duplicating
  the same lane.
- 2026-07-03 — **#347 merged + deployed** (→ Completed / Deployed): console Universe index
  exclusivity fix at `481e9dcc`; production health and live S&P/Nasdaq mutual-exclusion behavior
  verified. Started `codex/sell-to-fund-title-case` to title-case the Sell to Fund Buys selector
  labels/options and save-review summary.
- 2026-07-03 — **#350 merged** (→ Completed): AI Review inheritance/model catalog/text-box font
  controls. Started `codex/console-actions-evidence-live` for the owner-requested console polish
  covering Actions, cadence, returns, IRA wash-sale behavior, Evidence/source labels, LLM settings
  usage affordances, LIVE-warning reduction, broker-option investigation, provider/model naming
  consistency, and repo/folder rename planning.
- 2026-07-03 — **CORRECTION:** "drawdown=hard-halt" was mis-recorded (the owner didn't understand the
  question). Owner confirmed: guardrails are ADVISORY — agent decides, logs everything; the account
  boundary is the only hard rule. Decision 1 + the hardening scope updated accordingly. #343's
  hard-halt breaker was built off the wrong record before this correction landed; re-scope pending
  owner review. See `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md`.
