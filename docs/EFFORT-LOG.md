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

_As of 2026-07-05. PR numbers are GitHub `jaywedgeworth22/agentic-trading`._

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
- **2026-07-04** — `trading-live` contains `94669873` (PR #442) and current
  production HEAD `1e1a15bc` on `socratictrade.com`. Includes the Codex
  console/UI swimlane: approval provenance/citations, mobile LIVE phrase parity,
  Sheet focus trap, read-only decision trace, ticker drawer parity, and Strategy
  custom-model select parity. Verified Deploy workflow success, PM2 `trading`
  online, `/api/health` 200, and built route/page artifacts present under
  `.next/server/app`.
- **2026-07-04** — `trading-live` published at `1e1a15bc` (PR #444) on
  `socratictrade.com`. Includes the tokenless public HTTPS
  `congress-trading-shared` dependency path; production health 200 after
  deployment.

---

## 🚧 In Progress

- **Design-sync: Socratic Trade UI Kit → claude.ai/design (Claude Code).** 30 primitives
  (12 `ui` + 18 `console`) converted and uploaded to claude.ai/design so the design agent
  builds with the app's real components. Render check 30/30 clean; conventions header shipped.
  Uploaded to two owner accounts (projects `0a962679…` + `1da8546c…`). Additive only —
  `.design-sync/` inputs + one `.gitignore` block, no app source changed. **PR open** on
  branch `agent/design-sync-uikit`. Rollout: `docs/rollouts/2026-07-05-design-sync-uikit.md`.

---

## ✅ Completed (merged to `main`, on beta/integration)

- **PR #816 - Prompt-safety CR-H: fencing + deterministic injection receipts for the money-path
  prompts (CLAUDE).** Merged to `main` 2026-07-05 as squash `041b73b2` (verify/smoke/gitleaks
  green). Advisory ONLY (owner philosophy: receipts, never blocks): fenced
  `<owner_strategy_prompt>` + one data-not-command clause in the Bull system prompt covering every
  untrusted block (headlines/smartMoney/RAG/learned/analogs/coaching/reflection) + Bear equivalent
  (`STRATEGY_PROMPT_VERSION` 1.4.0→1.5.0); `reflection_summary` moved out of the SYSTEM prompt into
  Bull userContent as fenced `<reflection_summary>` DATA; new leaf `src/lib/prompt-safety.ts`
  deterministic injection scanner → `audit('prompt_injection_suspected')` + kind-`safety`
  decision-case evidence (detection only, never blocks/alters); learned-context lines carry inline
  provenance (`[origin= source= asserted= conf=]`); same-day high-relevance RAG chunk / same-day
  fact → aggregated `audit('evidence_age_anomaly')` + `safety` evidence item; post-mortem
  reflection WRITER fenced at source. Review pass added an excerpt cap on persisted findings (a
  ~50KB base64 blob could otherwise persist unbounded text repeatedly via the decision-case
  evidence JSON) and a fence-escape detection pattern (forged closing tags from inside untrusted
  data). Tests: 2577 total in the full local gate, all green (`test/prompt-safety.test.ts` 31,
  `test/strategy-prompt-safety.test.ts` 4, plus focused strategy/chat/socratic/learned-context
  suites). See `docs/rollouts/2026-07-05-prompt-safety-fencing.md`.
- **PR #819 - Wire `usage-budget` Phase 2 (advisory-first, owner-overridable enforcement) into
  `runStrategyOnce` (CLAUDE).** Merged to `main` 2026-07-05 as squash `f28322fe`
  (verify/smoke/gitleaks green). ADVISORY (always on when the monitor is configured):
  `usage_budget_status` audit receipt every run + a `formatBudgetAdvisory` line injected into the
  Bull userContent next to `drawdownAdvisory`. ENFORCEMENT (opt-in via `USAGE_BUDGET_ENFORCE`,
  default off) at the per-user/day LLM budget choke point: skip ends the run before any LLM call
  (audit + `notifyBudgetSkip`); downgrade swaps `policy.llmModel`/`redTeamLlmModel` on the
  in-memory run policy only, never persisted. `debateProposal` gained an optional `policyOverride`
  param so the Bear picks up the same transient downgrade. **Adversarial review caught a BLOCKER
  pre-merge:** the enforcement block was mutating the shared `policy` object in place, so a
  same-run cap-breach demotion's `setPolicy({ ...policy, strategyAuthority: "propose" })` would
  have persisted the downgraded models to the DB permanently, contradicting the "never persisted"
  contract; fixed with a separately-carried `runLlmOverride`/`runPolicy` never passed to
  `setPolicy`/`autoRevertOnCapBreach`, plus a regression test that trips both a downgrade and a
  cap-breach demotion in the same run. Also fixed: scoped the enforcement try/catch so a post-audit
  throw in the skip path can't be swallowed into the full LLM path; threaded the downgrade into
  `generateReflectionSummary` (outcome-engine lesson pass left as a documented intentional
  exemption — fire-and-forget, outlives the run); de-duplicated the budget-status fetch; extended
  the downgrade test to assert the Red Team request body's model too. Full local gate: 2587 tests
  across 261 files, all green; build clean. See
  `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md`.
- **PR #820 - Durable due-jobs substrate for 15m/1h intraday outcome sampling (CLAUDE).** Merged to
  `main` 2026-07-05 as squash `e90db1a8` (verify/smoke/gitleaks green). New `due_jobs` table
  (migration v11) + `src/lib/db-jobs.ts` (lease/reclaim claimable queue — fixes the
  crashed-row-stuck-forever gap the existing `mobile_commands` queue has). `counterfactual-learning.ts`
  + `outcome-engine.ts`'s `measureCase` enqueue `sample_intraday_horizon` jobs once a case's basis
  (fill or ref price) resolves; new `drainDueIntradaySampleJobs` worker drains them through the same
  `mergeHorizonRows`/write path the existing inline `samplableNow` path uses (belt-and-suspenders,
  no duplicate rows); one fire-and-forget call added to `scheduler.ts`'s `tick()`. **Adversarial
  review caught a lost-update-race BLOCKER pre-merge:** `measureCase` held an outcomes snapshot
  across awaits, so its wholesale write could erase a 15m/1h row the due-jobs worker had already
  persisted concurrently; fixed by re-merging against a fresh DB read immediately before every
  terminal/partial write (`writeSocraticDecisionOutcome`, `markSkippedCounterfactualMatured`,
  `markSkippedCounterfactualUnresolvable`). Also fixed: claimant-fenced the three terminal-transition
  functions in `db-jobs.ts` (a stale/lease-expired worker could otherwise resurrect an
  already-completed job); renamed the drain receipt's `failed` counter to `erroredRetried` +
  removed the dead `'failed'` `DueJobStatus` value; replaced the worker's `caseId.split(":")`
  counterfactual lookup with an exact `runId`/`horizonDays`-keyed lookup (the split-based lookup
  could silently match the wrong row when a run/symbol pair had more than one horizon-day config);
  added `due_jobs` to the account-deletion drift guard. Full local gate green (2529+/2530+ full
  suite, build clean). See `docs/rollouts/2026-07-05-durable-due-jobs.md`.
- **PR #822 - HyDE + evidence-derived multi-query retrieval for filings RAG, flag-gated (CLAUDE).**
  Merged to `main` 2026-07-05 as squash `d97b7c71` (verify/smoke/gitleaks green). New
  `src/lib/rag/multi-query.ts`: pure `deriveQueryVariants()` (2-4 facet sub-queries from
  evidence/sector/dominant-factor) + `generateHydePassages()` (one cheap fail-open LLM call, HyDE
  passages). Two flags `RAG_MULTIQUERY`/`RAG_HYDE` (+`RAG_HYDE_MODEL`), both **default OFF** —
  byte-identical retrieval when both are off (pinned by a dedicated regression test); not
  independent, `RAG_HYDE` alone is a no-op without `RAG_MULTIQUERY`. `vector-db.ts`
  `RetrieveOptions.queries?: string[]`: per-query embed+match (including the original query
  alongside variants), RRF-fused into the existing `rankPool` pipeline unchanged. **Adversarial
  review caught a fail-CLOSED BLOCKER pre-merge:** the multi-query fan-out had no per-item catch,
  so one variant's rejected Voyage/Pinecone call discarded every other variant's already-successful
  results via a bare `Promise.all`, returning empty filings context instead of falling back to the
  single-query path; fixed so each fan-out call is caught individually and an all-fail case falls
  back to plain single-query retrieval (flags-off behavior). Also fixed: first-occurrence-wins id
  resolution could keep a lower cosine score (now higher-score wins); HyDE's endpoint/model could
  disagree (could route an OpenAI model id to `api.anthropic.com` under an Anthropic policy,
  silently returning `[]`; now resolved coherently with an audit on non-OK responses); HyDE spend
  wasn't gated on the daily LLM budget (now gated via `isOverLlmBudget`). Full local gate: 2619
  tests across 264 files, all green; build clean. See
  `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`.
- **Push account status metrics to Usage Monitor (AG)** — ✅ COMPLETED 2026-07-05. Pushed metricTypes `balance` and `limit` to API Usage Monitor via `usage-monitor-push.ts` upon portfolio fetch in Alpaca and Robinhood.

- **Harden HMAC Security & Persistent Idempotency for webhooks (AG, M) — ✅ COMPLETED via PR #854 (2026-07-05).** Updated `congress-webhook-auth.ts` to validate `X-Signature` header via HMAC SHA256. Created `processed_webhooks` db table and integrated persistent DB check in `markSeen` alongside in-memory cache to ensure persistent idempotency across server restarts. Lint and tests green.
- **PR #807 - Approvals triage upgrades + alert center (CODEX).** Merged to `main`
  2026-07-05 as squash `0bfa4f1e`. Focused slice for issue #470: `/console/approvals`
  sort/filter, visible-row multi-select, bulk reject, safe non-LIVE bulk approve through existing
  per-item proposal endpoints, and a reusable alert-center surface backed by existing
  notifications/activity data. CI green: classify, smoke, gitleaks, verify. See
  `docs/rollouts/2026-07-04-approvals-alert-center-slice.md`.
- **PR #798 - Slack coordination sync on by default for all sessions/repos (Monet, cloud;
  landing by CLAUDE-CLOUD, owner-directed).** Merged to `main` 2026-07-05 as squash `546c451`
  (verify x2/smoke/gitleaks green; relands #367, whose branch heads never received CI runs from
  cloud-proxy pushes). Ships `scripts/slack-sync.sh` (curl engine: read/thread/post/reply/test/
  hook; 0600 `curl --config` token handling; untrusted-data envelope; silent no-op without
  `SLACK_BOT_TOKEN`; per-session hook dedup), `scripts/setup-slack-sync.sh` (idempotent global
  installer), `cloud-setup.sh` wiring (verified end-to-end in a cloud container: npm ci +
  `.env.local` seed + hook install with valid JSON), `docs/slack-coordination.md`, and a
  `workflow_dispatch` re-kick lever on ci.yml (cloud-proxy pushes were firing no pull_request
  workflow runs, stranding the required `verify` check). Owner state: `SLACK_BOT_TOKEN` set as a
  cloud Runtime Secret; env setup-script field points at `bash scripts/cloud-setup.sh`.
  **Follow-ups (Monet lane): 8 resolved-to-land Codex P2 threads on #798** (no-python3 JSON
  fallback escaping, unrelated-hook preservation, cross-repo hook help path, non-zero exit for
  token-less writes, envelope-delimiter escaping, thread visibility/order/pagination in reads) +
  Mac-side installer run + bot `/invite`. Rollouts:
  `docs/rollouts/2026-07-04-slack-sync-default-setup.md`,
  `docs/rollouts/2026-07-05-slack-sync-pr367-landing.md`.
- **PR #694 - Effort-issues sync secondary-rate-limit hardening (CLAUDE).** Merged to `main`
  2026-07-05 (verify/smoke/gitleaks green, auto-merge). `scripts/sync-effort-issues.py` now
  survives GitHub secondary rate limits: 2.5s creation throttle, Retry-After/exponential-backoff
  retries under a bounded 300s per-run retry budget, and exit-0 "PARTIAL SYNC - resume on next
  run" summary on budget exhaustion instead of a red workflow run (the sync is idempotent, so
  the next run resumes cleanly; non-rate-limit failures still exit 1). Validated live on merge:
  the previously hard-failing bulk run completed green (created=101 updated=305, exit 0).
  Follow-up refinements from Codex PR review (Congress.Trade #162): initial issue listing
  covered by the same partial handling, server-sent Retry-After honored uncapped, 1s update
  throttle for bulk PATCH runs. Propagated verbatim to congress-trading-shared (PR #27),
  api-usage-monitor (PR #38), and Congress.Trade (PR #162). Rollout:
  `docs/rollouts/2026-07-04-effort-sync-rate-limit-hardening.md`.
- **PR #814 - Pre-policy vetoes advisory-overridable (CLAUDE, #799 follow-up).** Merged to `main`
  2026-07-05T10:17:03Z (verify+smoke green). _2026-07-05 (CLAUDE next-wave): CORRECTION — this row
  was previously logged under In Progress as "PR pending"; #814 has since merged. Moved to
  Completed._ Branch `claude/veto-advisory-overridable`, isolated worktree. Deterministic bear
  filter (Rules 3/4) + approval-time Red Team veto now TAG candidates with `preVetoReasons` instead
  of dropping; folded into the single sized PolicyDecision → #799's `resolveSocraticOverride`
  (openings, subject to socraticOverrideMode + cap). Rule 1 stays hard; Rule 4
  overridable-but-flagged for owner ratification. FIX #1 (no counterfactual on override path —
  protects getRedTeamEfficacy), FIX #2b (durable deterministic_bear_veto audit), FIX #3
  (propose-mode pre-route before sell-to-fund). An independent 3-lens adversarial verify caught +
  fixed 2 money-path bugs the green suite missed: severe phantom-funding-sell (new
  `preVetoTaggedOpeningWillPlace` gates the funding notional) + free-text hard-gate
  misclassification (`isHardGateReason` prefix short-circuit); both regression-tested. Gate:
  tsc/lint-0/258 files-2540 tests/build. Overlapped unlanded `claude/redteam-policy-aware-routing`
  (coordinated on #agent-sync; rebase at land). See
  `docs/rollouts/2026-07-05-pre-policy-veto-advisory.md`.
- **PR #812 - Full-suite test determinism: de-flake order-confirmation-status + chat-orchestrator-search-knowledge (CLAUDE, S).**
  Merged to `main` 2026-07-05T08:46:56Z (verify/smoke/gitleaks green). _2026-07-05 (CLAUDE
  next-wave): CORRECTION — this row was previously logged under In Progress with no merge note;
  #812 has since merged. Moved to Completed._ Worktree `~/apps/trading-claude`, branch
  `agent/claude`. Root causes (not timeout-tuning): `executeProposal` tests ran a REAL market scan
  (Nasdaq screener + Yahoo fetches, 6-8s abort timeouts + 429 backoff) — ~12s/test solo, past 30s
  under 4-worker full-suite load; chat-orchestrator's first test paid the ~15s orchestrator
  module-graph import inside its own 20s testTimeout. Fix: partial-mock `scanMarket` at the
  `market.ts` module boundary in `order-confirmation-status` + `approval-lock` (same class); hoist
  the orchestrator import into `beforeAll` with an explicit long hook budget. Full suite 256 files
  / 2506 tests green in 20.77s wall. See `docs/rollouts/2026-07-05-full-suite-test-determinism.md`.
- **PR #799 - Guardrails → overridable preferences (denylist) (MONET risk lane).** Merged to `main`
  2026-07-05T06:02:51Z. _2026-07-05 (CLAUDE next-wave): CORRECTION — this row was previously
  logged under In Progress as "PR open"; #799 has since merged. Moved to Completed._ Worktree
  `~/apps/trading-monet`, branch `monet/guardrail-overridable-denylist`. Owner directive: only the
  account boundary + physical/broker/regulatory/accounting impossibilities stay hard; every other
  policy block is a light preference the agent may self-override with a logged `autonomyOverride`
  thesis. Inverted the Socratic override classifier allowlist → **denylist**: new
  `HARD_GATE_REASON_PATTERNS` + `isHardGateReason` source-of-truth in `policy.ts` (risk engine);
  `socratic-runtime.ts` `overrideableReason` = `!isHardGateReason`. Reclassified short-stop-required
  / bracket-required / policy-level short-disabled from hard → overridable; unlisted/new gates now
  default overridable. Advisory-only (nothing auto-overrides; broker/account/regulatory hard gates
  untouched). New `test/hard-gate-classification.test.ts` pins the matrix. Cross-lane touch to
  `socratic-runtime.ts` (Claude's file) coordinated on `#agent-sync`. Follow-ups: extend override
  to exits; make the pre-policy vetoes (bear filter, Red Team) advisory (done — see #814 above).
  See `docs/rollouts/2026-07-05-guardrail-denylist-overridable-preferences.md`.
- **PR #811 - Console live-data build-out (CODEX, L).** Merged to `main` 2026-07-05T07:37:48Z
  (verify/smoke/gitleaks green, auto-merge). _2026-07-05 (CLAUDE next-wave): CORRECTION — this row
  was previously logged under In Progress ("2026-07-05 status: merged current origin/main..." with
  no merge note of its own); #811 has since merged, verification quartet was green pre-merge. Moved
  to Completed with the merge timestamp._ SSE wiring + mark-to-market, positions blotter streaming,
  live risk-utilization board, intraday charts (existing component slice first; no
  lightweight-charts dependency in this pass). Worktree
  `/Users/jay/.codex/worktrees/socratic-console-live-data`, branch `codex/console-live-data`.
  Console snapshot refresh consumes `/api/events/stream`, surfaces stream/freshness state, and adds
  overview mark-to-market / risk / blotter upgrades with scoped tests. Verification pre-merge:
  `npm run lint -- --quiet`, focused live-data vitest (`4`), full `npm test` (`257` files / `2510`
  tests), `npm run build`, `npx tsc --noEmit` (after build regenerated `.next/types`). Subsumes the
  SSE learned-context-inbox row above. (expert reviews)
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
- **Pre-policy vetoes advisory-overridable (CLAUDE, #799 follow-up)** — branch
  `claude/veto-advisory-overridable`, isolated worktree — **IN PROGRESS 2026-07-05, PR pending.**
  Deterministic bear filter (Rules 3/4) + approval-time Red Team veto now TAG candidates with
  `preVetoReasons` instead of dropping; folded into the single sized PolicyDecision → #799's
  `resolveSocraticOverride` (openings, subject to socraticOverrideMode + cap). Rule 1 stays hard; Rule 4
  overridable-but-flagged for owner ratification. FIX #1 (no counterfactual on override path — protects
  getRedTeamEfficacy), FIX #2b (durable deterministic_bear_veto audit), FIX #3 (propose-mode pre-route
  before sell-to-fund). An independent 3-lens adversarial verify caught + fixed 2 money-path bugs the
  green suite missed: severe phantom-funding-sell (new `preVetoTaggedOpeningWillPlace` gates the funding
  notional) + free-text hard-gate misclassification (`isHardGateReason` prefix short-circuit); both
  regression-tested. Gate: tsc/lint-0/258 files-2540 tests/build. Overlaps unlanded
  `claude/redteam-policy-aware-routing` (coordinated on #agent-sync; rebase at land). See
  `docs/rollouts/2026-07-05-pre-policy-veto-advisory.md`.
- **Full-suite test determinism: de-flake order-confirmation-status + chat-orchestrator-search-knowledge**
  (CLAUDE, worktree `~/apps/trading-claude`, branch `agent/claude`) — **IN PROGRESS 2026-07-05.**
  Root causes (not timeout-tuning): `executeProposal` tests run a REAL market scan (Nasdaq screener +
  Yahoo fetches, 6-8s abort timeouts + 429 backoff) — ~12s/test solo, past 30s under 4-worker
  full-suite load; chat-orchestrator's first test pays the ~15s orchestrator module-graph import
  inside its own 20s testTimeout. Fix: partial-mock `scanMarket` at the `market.ts` module boundary
  in `order-confirmation-status` + `approval-lock` (same class); hoist the orchestrator import into
  `beforeAll` with an explicit long hook budget.
- **Hybrid resource-aware runner routing for `verify` — calibration fixes + activation** (CLAUDE,
  worktree `~/apps/trading-wt-ci-efficiency`, branch `claude/ci-hybrid-runner-verify`, PR #372) —
  **IN PROGRESS 2026-07-05 (owner-directed).** Live audit found the feature 100% inert (PR
  unmerged, publisher never started, metric unsatisfiable on the 16GB swapping Mac). Merged
  33-commits-stale branch forward and applied fixes: router `ts` numeric-coercion (was a latent
  merge-blocker), staleness 300s→180s, availability metric rewritten free+inactive→pressure-based
  (`kern.memorystatus_vm_pressure_level==1` + swap/compressor/page-free-wanted terms), CPU 0.6→0.8,
  `verify-self` drops the cache-wedging `setup-node` for system node + tokenless `npm ci` + RSS cap
  (`NODE_OPTIONS` 3072 + `--maxWorkers=2`). Verified bash-3.2/ASCII + YAML + adversarial reviews.
  Next: land via `land.sh`, then start the pm2 publisher on the production Mac. Rollout:
  `docs/rollouts/2026-07-04-ci-hybrid-runner-verify.md` (2026-07-05 section).

_(2026-07-05 closeout note: the HyDE/multi-query retrieval, durable due-jobs substrate, usage-budget
Phase 2, and prompt-safety fencing lanes previously tracked here as "IN PROGRESS...landing now" have
all merged — PRs #822/#820/#819/#816 respectively. See the **✅ Completed** section above; entries
removed from here to avoid duplication.)_

- **Scan table column customization parity (CODEX, M) — IN PROGRESS 2026-07-04.** Worktree
  `/Users/jay/.codex/worktrees/socratic-scan-column-customization`, branch
  `codex/scan-column-customization`. Scope: bring `/console/scan` to legacy dashboard parity for
  column visibility, ordering, reset, and saved browser-local state; allow only tightly related
  ticker-drawer parity if the scan surface needs it. Keepout: no broad
  settings/approvals/live-data/coach/tooltip conversions in this lane. PR #806 open with
  auto-merge enabled; merge-forward after PR #807 pushed. Codex review follow-up pins `symbol` as
  the first/sticky column during saved-state sanitization and column reordering; second review
  follow-up defers saved `localStorage` column state until after mount to avoid hydration mismatch.
  Verification before review follow-up: focused scan-column test (4), lint 0 errors / 308 existing
  warnings, land.sh tsc clean, full suite 2508 tests / 256 files, build green. Review follow-up
  verification: focused scan-column test (4), TypeScript clean, `git diff --check` clean; hydration
  follow-up verification: focused scan-column test (4), TypeScript clean, lint 0 errors, `git diff --check` clean.

- **Coach chat → framework primitives (CODEX, M) — IN PROGRESS 2026-07-04.** Worktree
  `/Users/jay/.codex/worktrees/socratic-coach-framework-primitives`, branch
  `codex/coach-framework-primitives`. Focused slice for issue #473: decision-trace coach-note POST
  can optionally promote into lesson/framework primitives, framework review now carries explicit
  rewrite/ownerResponse semantics, and the trace renders linked run metadata when available.
  Keepout: live-data/settings/tooltip lanes, Monet risk files, Claude memory/RAG files, workflows,
  AGENTS, and Slack scripts. 2026-07-05 update: merge-forwarded to `origin/main` @ `0bfa4f1e`;
  verification green in the branch worktree — `test/socratic-db.test.ts` (3 tests), `tsc`,
  quiet lint, full `npm test` (256 files / 2507 tests), and `npm run build`. PR #810 is open and
  squash auto-merge is armed pending `verify`.

- **Logo concept exploration (branding, docs-only)** (CLAUDE cloud session, branch
  `claude/socratic-trade-logos-p0hxk7`) — **PR open**. Owner-requested logo ideas for
  Socratic Trade / Socratic.Trade: ten concept comps (five wordmark-led where the name fills the
  logo, five mark-led with a favicon-capable symbol), built on the existing product palette (ink
  `#0f1722`, green `#0e9f6e`, mint `#63e6be`) — new `docs/branding/` (README + `logo-concepts.html`
  board + standalone SVGs). No app code touched; `public/icon.svg` unchanged. Round 2 same-day:
  owner shared four Adobe Firefly comps (candlestick letterforms, owl, red/green) and asked for a
  more professional take — added concepts K–N (candlestick-owl lockup, owl seal, candle-I wordmark,
  three-candle cluster), 14 SVGs total. Round 3: owner saved B/E/H/I + the parallel session's three
  picks (Examined/Dialectic/Stoa from `claude/logo-ideas-c5n61b`) + the four Firefly comps
  (backgrounds removed for light/dark use) into one combined board `docs/branding/shortlist.html`
  with assets in `docs/branding/firefly/`. Next: owner narrows the combined shortlist to a final
  direction, then redraw with outlined letterforms + favicon/app-icon variants. Round 4: upright vector remake of the candle-letters wordmark (F5, `docs/branding/firefly/candle-wordmark-upright.svg`). Round 5: 18s SVG+CSS morph animation - same candles alternate SOCRATIC/TRADE (F6, `docs/branding/firefly/candle-morph.svg`). Round 6: portable exports of the morph - MP4, GIF, and Live-Photo-ready MOV+JPG (`docs/branding/firefly/candle-morph.{mp4,gif}`, `candle-morph-livephoto.{mov,jpg}`). Round 7: transparent video exports (VP9-alpha WebM + animated WebP committed; ProRes 4444 delivered off-repo). Round 8: console-intro animation - chart candles fly up into the header logo (`docs/branding/firefly/console-intro.svg`, shortlist card F7).
  See `docs/rollouts/2026-07-05-logo-concepts.md`.
  _Note: `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board) not reachable from this cloud
  container — owner/next local agent should mirror this row there._

- **Eliminate redundant fill-history fetch/replay (AG, M) — IN PROGRESS 2026-07-05, PR open.** Worktree `~/apps/trading-antigravity`, branch `agent/antigravity/fill-history-dedupe` (PR #850). Fills fetched once in `runStrategyOnce` and passed down through all scorecard and sizing calls, eliminating up to 8 duplicate DB queries per run. Unified unit test added to `test/performance.test.ts` to assert that prefetched fills are used and DB query counts are bypassed. Lint 0, tsc clean, Next.js build green.

- **Regime-enum adoption inside the risk gates** (MONET risk lane, branch
  `claude/regime-enum-risk-gates`) — **merged as PR #449 (`c3553ebb`); moved to Completed on the live board**. The
  three deterministic risk gates now classify the persisted regime label through the shared typed
  `MarketRegime` source of truth (`market-regime.ts`) instead of three independent
  substring/`startsWith` rules: crisis/inverted opening-exposure cap (`policy.ts`
  `isCrisisOrInvertedRegime`), bear-filter risk-off veto (`strategy.ts` `deterministicBearFilter` —
  the site whose in-code comment reserved the conversion for the risk lane), and the escalation gate
  (`regime-watch.ts` `isEscalationRegime`, also feeding `strategy.ts`'s dissent trigger). This is the
  "one-line adoption" the w1-regime-data lane (#368) exported the typed predicates and pinned
  `test/market-regime.test.ts` for. Correctness hardening only — canonical-label behavior is
  byte-identical (a relabel can no longer silently desync one gate from another); the one intended
  change is that a non-canonical free-text label now reads non-escalating rather than accidentally
  substring-matching. Imports from `./market-regime` (not `./macro`) so the whole-module macro mock
  in `test/regime-watch.test.ts` still exercises the real classifier. New gate-level regression
  `test/regime-gate-adoption.test.ts` (+ a `policy.test.ts` hardening case). Gate green: tsc clean,
  lint 0 errors, 254 files/2465 tests, build ok. See
  `docs/rollouts/2026-07-04-regime-enum-risk-gate-adoption.md`.
  _2026-07-04 (CLAUDE): PR #449 merged to `main` (`c3553ebb`) — row ready to move to Completed on
  Monet's next pass; noted here rather than moved, per never-move-another-agent's-row etiquette._

- **Wave-3 memory/RAG (CLAUDE swimlane, 3-lane team) — IN PROGRESS 2026-07-04** _(row previously
  existed only on the live board; mirrored here 2026-07-05 so the issues mirror sees it)_:
  w3-schema-dissent (frontier tier: belief/iMayBeWrongIf/reversalTriggers/evidenceRefs schema
  fields w/ Bear round-trip, structured Red Team verdict + removed[], non-action case files,
  debate transcript persistence); w3-permodel-loop (mid tier: per-model scoreboard/calibration/
  deterministic assignment + structured-output conformance recording); w3-retrieval-usefulness
  (mid tier: ragAttribution+analog-id joins to matured outcomes, per-source usefulness data,
  learned-fact injection efficacy w/ per-run fact-id stamping). Gated on the Wave-2 lanes
  reaching `main`.

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
  errors, tsc clean, 2383 tests / 246 files, build green. **LANDED on `main`** _(2026-07-05 CLAUDE
  next-wave correction: this line previously said "Pushed; NO PR — lands via the landing train
  after the base branch", which is now stale — merged via the 2026-07-04 landing train)_. See
  `docs/rollouts/2026-07-04-w2-outcome-engine.md`.


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

- **PR #360 - Drawdown breaker → ADVISORY default (re-scope of #343)** (Monet, cloud, branch
  `claude/drawdown-advisory-rescope`) — Merged to `main` 2026-07-04T16:15:44Z.
  _2026-07-05 (CLAUDE next-wave): CORRECTION — this row said "PR pending" with auto-merge armed;
  #360 has since merged. Moved to Completed status (row left in place chronologically; its
  follow-on, regime-enum adoption in the risk gates, landed separately as PR #449, see above)._
  Owner reassigned this lane to Monet (swap: Fable → memory/RAG, Monet → risk engine; coordinated
  on Slack `#claude-monet-sync`). Reverts the mistaken hard-halt default to the owner's actual
  philosophy ("nothing is hard except which account to work in; agent decides, logs everything"):
  `drawdownBreakerAction` now `"advisory" | "close_only" | "halt"`, **default `"advisory"`** — on
  breach it writes a receipt + threads `drawdownAdvisory` into the strategist prompt (agent
  decides), NO `systemState` change; `close_only`/`halt` are explicit opt-ins. tsc/lint/2375
  tests/build green. Follow-up: advisory into the Bear context; broader per-gate sweep → owner
  questions first.

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

- **Wave-2 memory/RAG core** (Claude/Fable coordinator — OWNER-ASSIGNED swimlane; lanes stacked on
  their w1 dependency branches, push-only, landing via the train). Lanes: `outcome-engine`,
  `episodic-retrieval`, `coaching-durable`, `reflection-decompose` (full lane list on the live board
  `/Users/jay/apps/TRADING-EFFORT-LOG.md`).
  _2026-07-05 (CLAUDE next-wave): CORRECTION — `outcome-engine` and `episodic-retrieval` are LANDED
  on `main` (both merged 2026-07-04, episodic-retrieval as **PR #437** merged 2026-07-04T21:05:02Z);
  the sub-lane text below still said "done, pushed, awaiting the landing train" / "no PR", which is
  now stale. `coaching-durable` and `reflection-decompose` remain genuinely unlanded — no PR opened
  for either since 2026-07-04 — see the new "Open PRs for the stalled w2-coaching-durable and
  w2-reflection-decompose branches" Planned row on the live board for the explicit landing action._
  - `claude/w2-episodic-retrieval` (this lane) — **LANDED as PR #437 (merged 2026-07-04T21:05:02Z)**
    (base: `origin/claude/w1-rag-quickwins`). Composite review A1 ([Both], the highest-leverage item): new
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

- _(Moved to In Progress 2026-07-05: **Hybrid resource-aware runner routing for `verify`** — see
  the In Progress section. The original availability metric was changed from `free+inactive > 6 GB`
  to a pressure-based gate during calibration; `workflow_call`/reusable cross-repo remains deferred
  until this lands and proves itself, hosted-only default stands.)_

### Socratic console parity sub-lanes — reserved before implementation
- **Universal ticker detail drawer parity** — restore old-site discoverability by making ticker symbols
  open the shared drilldown/drawer consistently across scan, home, evidence cards, proposals, orders,
  and other console surfaces. Reserved under the broader Codex parity effort so parallel agents do not
  start a duplicate ticker-detail lane. Initial high-signal gaps covered by `codex/console-ui-swimlane`;
  new console surfaces should default to `SymbolButton` for actionable tickers.
  _2026-07-04 assignment: CODEX._
- **Settings affordance and tooltip pass** — add clearer option descriptions/tooltips, replace confusing
  loose/tight wording with lock/unlock-style affordances, and turn absolute-vs-percent pairs into a
  polished mode switch where the pair represents alternative ways to express one constraint.
  _2026-07-04 assignment: CODEX._
- **Model/provider control parity** — move strategy model controls toward curated dropdowns with
  provider-aware settings, showing reasoning controls only for models that actually support them.
  Initial Strategy custom-model selected-state parity covered by `codex/console-ui-swimlane`.
  _2026-07-04 assignment: CODEX._
- **Admin connection health and backend-failure notification pass** — surface every backend dependency
  including Pinecone/Voyage, distinguish global backend failures from user-key failures, and route
  global failures to admin email/health while user-key failures become user notifications.
  _2026-07-04 assignment: AG (Antigravity), incl. a per-provider failure-injection test proving global-vs-user-key routing._
  _2026-07-05 (CLAUDE next-wave): status update — implemented on branch `cursor/session-2026-07-05`
  as **open PR #805**, mergeable state **CONFLICTING** (not merged; do not treat as done). #805's
  branch also carries an unrelated Cursor P0/P1 commit (`0ce39474`), so landing it needs either a
  split into two PRs or an honest combined PR description — see the live board's "Admin connection
  health..." In Progress row and the new "Disentangle PR #805" Planned row for detail._

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
    _2026-07-04 assignment: MONET (risk lane)._
  - Build/test against a **connected broker account** (paper or live); the removed local Test mode /
    `paperMode` default is gone (#342). Keep the existing typed-confirm ritual before any live toggle.
- **Manager-model A/B** — wire the shortlisted models via the OpenAI-compatible path (base-URL swap;
  DeepSeek/xAI/Qwen/Gemini) + the existing Anthropic path, run in paper mode, compare per-model Results.
  See `docs/manager-model-options.md`.
  _2026-07-04 assignment: CLAUDE._

### Planned — actionable, not yet started
- **Per-model hit rates on Results** — now that `proposedByModel` persists (#334), surface realized
  win/return grouped by served model. _(Directly enables the Manager-model A/B above.)_
  _2026-07-04 assignment: CODEX (Results UI; joins `proposedByModel` + `getRedTeamEfficacy`)._
- **Per-field FRED sourcing** — a partially-failing FRED fetch still placeholder-fills individual
  series while the suite is flagged sourced; close with per-series flags (#326/#334 follow-up).
  _2026-07-04 assignment: AG (Antigravity)._
- **SSE for the learned-context inbox** — replace the 60s poll if the console gains an event stream.
  _2026-07-04 assignment: CODEX (fold into the console live-data build-out row below)._
- **`MarketQuoteSummary` factor bars for all scanned symbols** — #335 carried factor fields into the
  summary tier; confirm drilldown factor bars now populate for every scanned symbol, not just top candidates.
  _2026-07-04 assignment: CURSOR (DeepSeek)._

### 2026-07-04 backlog exhaustiveness pass — promoted items with assigned lanes
_Owner-directed promotion of every still-open review-doc item into individually tracked rows.
Sources: `docs/reviews/2026-06-30-improvement-audit.md` (11-expert audit), the two 2026-07-04
expert/composite reviews, `docs/reviews/2026-07-03-console-parity-open-items.md`, `PLAN.md`, and a
code sweep. Assignment tags: CURSOR = Cursor background agents (DeepSeek v4 Pro), CODEX = Codex,
AG = Antigravity/Gemini, MONET = Claude Monet (Opus, risk lane), CLAUDE = Claude Code (memory/RAG
lane). Unassigned rows await an owner decision or scheduling. Assignments are reservations, not
locks — re-negotiate in #agent-sync._

#### CURSOR (DeepSeek v4 Pro) lane
- **Rate-limit `/api/chat` and `/api/scan` (CURSOR, S)** — apply the existing rate-limiter to both
  routes; cost-exhaustion vector when operator LLM fallback is enabled. (improvement-audit S-1)
- **Encrypt Robinhood OAuth tokens at rest (CURSOR, S)** — `setMcpOAuthTokens` bypasses the
  `encryptValue` path used for other stored secrets. (improvement-audit S-2)
- **Constant-time admin token comparison (CURSOR, S)** — `src/lib/auth/admin.ts` compares with
  `===`; switch to `timingSafeEqual`. (improvement-audit S-3)
- **Security response headers (CURSOR, S)** — add CSP / X-Frame-Options / Referrer-Policy via
  middleware. (improvement-audit S-5)
- **Delete dead Anthropic branch in `resolveLlmEndpoint` (CURSOR, S)** — unreachable code +
  wrong provider tag in `llm-provider.ts`. (improvement-audit §4)
- **Code-split StrategyFlow and the price chart (CURSOR, M)** — `next/dynamic({ssr:false})` for
  `@xyflow/react` (~3.9MB first-load win). (improvement-audit §3.10)
- **Synthetic bid/ask provenance fix (CURSOR, S)** — drop or tag `yahoo-finance-synthetic` bid/ask
  in `toQuoteOnlyMarketQuote` and exclude it from `hasAskData` so limit-price math never anchors on
  fabricated spreads. (improvement-audit §3.5)
- **`daysToEarnings` enrichment field (CURSOR, S)** — earnings-calendar wiring through the full
  per-field sourcing chain (see the AGENTS.md enrichment trap). (improvement-audit §4)
- **`institutionOwnership` enrichment field (CURSOR, S)** — already-authenticated Yahoo
  quoteSummary module. (improvement-audit §4)
- **Adopt `EmptyState`/skeleton primitives on dashboard empty states (CURSOR, S)** — primitives
  exist but are unused. (improvement-audit §4)
- **Voyage query-embedding LRU cache (CURSOR, S)** — cache repeated query embeddings; est. 50-80%
  query-embed cost cut. (improvement-audit completeness §D)
- **Account-deletion table-list drift guard (CURSOR, S)** — a test that fails when a new `db-*`
  table is missing from the deletion scope. (improvement-audit completeness §F)
- **Global symbol omnibox (CURSOR, S)** — type any ticker anywhere to open the drilldown drawer.
  (expert reviews quick-wins)
- **Scheduler single-leader ON in prod + `/api/health` hard threshold (CURSOR, S)** — currently
  opt-in. (improvement-audit A-5)
- **Global operator LLM spend ceiling + unpriced-model default price (CURSOR, S)** — operator-wide
  ceiling distinct from per-user budgets; unknown model ids get a conservative default price so
  cost never silently undercounts. (expert reviews quick-wins)
- **Effort-mirror orphan report (CURSOR, S)** — periodic report of mirror issues orphaned by
  reworded board rows so they don't accumulate open forever. (issues-mirror rollout follow-up)
- **Litestream restore drill + PITR retention config (CURSOR, S)** — actually exercise a restore;
  make the retention window configurable. (completeness §F + quick-wins)

#### CODEX lane (adds to the annotated parity rows above)
- **Console live-data build-out (CODEX, L)** — SSE wiring + mark-to-market, positions blotter
  streaming, live risk-utilization board, intraday charts (lightweight-charts adoption). Subsumes
  the SSE learned-context-inbox row above. (expert reviews)
- **`/console/settings` second IA pass (CODEX, M)** — account identity/authority/keys/
  notifications/admin-links reorg. (console-parity-open-items)
- **Accessible tooltip/popover primitive everywhere (CODEX, S)** — retire native `title`;
  universal coverage across controls/metrics/cells. (expert reviews + console-parity)

#### AG (Antigravity/Gemini) lane
- **Eliminate redundant fill-history fetch/replay (AG, M)** — fills fetched/replayed 7-9x per
  request; fetch once and thread through. (improvement-audit §3.7)
- **Wire congress-score-eval go/no-go into scan scoring (AG, M)** — the most rigorous evaluator
  currently has no production consumer. (improvement-audit §3.8)
- **Robinhood option-chain IV / put-call enrichment (AG, M)** — wire the connected MCP option
  tools for near-the-money IV + put/call ratio. (improvement-audit §6.7)
- **E2E money-path integration test (AG, M)** — mock LLM+broker through `runStrategyOnce`
  proposal→evaluate→execute→record. (improvement-audit A-2)
- **Concurrency/property/fault-injection test suite (AG, M)** — target the single-writer SQLite
  hazard and crash-mid-write paths. (expert reviews cross-cutting)
- **Horizon-matched multi-horizon IC in the factor tuner (AG, M)** — IC currently fixed at 5-day
  vs multi-week theses. (expert reviews cross-cutting)
- **Congress push/SSE contract repair (AG, M, cross-app)** — App A pushes a shape App B never
  accepts; the push path is dead today. Paired row on the Congress.Trade board. (PLAN
  Integrations + improvement-audit §6.8)

#### MONET (Opus, risk lane)
_(A sixth row — typed regime-enum adoption in the risk gates — was drafted here but Monet already
shipped it as PR #449 while this pass was being written; see its In Progress row above.)_
- **Bear/Red-Team unavailable → policy-aware routing for ALL failure modes (MONET, M)** — complete
  the mode-aware policy (propose→human-approval; autonomous→de-risk-only + "RED TEAM FAILED" flag)
  across timeout/429/malformed-JSON, replacing the remaining fail-open paths. (improvement-audit
  §3.1 + the recorded Red-Team policy decisions)
- **Volatility-targeting sizing + portfolio-heat budget (MONET, L)** — continuous exposure taper
  instead of binary caps; advisory-style and owner-overridable per the guardrail philosophy.
  (expert reviews big-bets)
- **Correlation gate + event blackouts + pre-trade stress scenario (MONET, M)** — EWMA/downside
  correlation, earnings/macro-event blackout windows, scenario stress on proposals — all advisory
  receipts, never cages. (expert reviews)
- **Fractional-Kelly sizing on realized payoff (MONET, M)** — downside-dispersion-aware; aligns
  sizing with realized edge. (expert reviews cross-cutting)
- **Multi-signal regime scorer (MONET, M)** — credit spreads, VIX term structure, breadth →
  severity feeding caps/learning. (expert reviews critical-path)

#### CLAUDE lane (memory/RAG + already-reserved infra)
- **Wire `usage-budget` Phase-2 enforcement into `runStrategyOnce` (CLAUDE, M)** —
  `evaluateBudgetForRun`/`cheaperModel` are built and tested but never called; flagship
  "built-but-unwired" item. (code sweep) **MOVED to In Progress 2026-07-05** — see the
  In Progress section above (branch `claude/usage-budget-advisory-wiring`).
- **RAG retrieval-quality eval harness (CLAUDE, M)** — 25-40 golden query→expected-chunk tuples +
  vitest recall@k/MRR scorer. (improvement-audit §3.4) (triage 2026-07-05: already done — see PRs
  #297/#299)
- **Bull/Bear prompt eval + versioning harness (CLAUDE, L)** — offline eval + PROMPT_VERSION
  discipline for the money-path prompts. (improvement-audit §3.3) (triage 2026-07-05: already
  done — 2026-07-01 money-path landing, STRATEGY_PROMPT_VERSION + `npm run eval:strategy-offline`)
- **HyDE + evidence-derived multi-query retrieval (CLAUDE, M)** — retrieval-quality upgrade.
  (expert reviews) **COMPLETED 2026-07-05** — PR #822, squash `d97b7c71`. See Completed section
  above and `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`.
- **Durable due-jobs substrate (CLAUDE, M)** — sub-day outcome sampling that survives process
  downtime; explicitly deferred from w2-outcome-engine. (expert reviews critical-path)
  **COMPLETED 2026-07-05** — PR #820, squash `e90db1a8`. See Completed section above and
  `docs/rollouts/2026-07-05-durable-due-jobs.md`.
- **Per-user/day token-budget ceiling at trigger/strategy entry (CLAUDE, M)** — enforcement
  deferred in `triggers.ts`; per-user policy caps replace env-only config. (completeness §D)
  (triage 2026-07-05: already done — PR #316 series; `triggers.ts` "deferred" comment refers to
  run-count caps)

#### Unassigned — owner decision or scheduling needed
- **Split `strategy.ts` god-module (unassigned, L)** — 2,902 lines → proposal-generation/
  execution/reconciliation/learning modules (db.ts split precedent). High merge-conflict surface —
  schedule in a quiet window. (improvement-audit A-1)
- **Repository layer + write-queue over SQLite (unassigned, L)** — both expert reviews sequence
  this BEFORE more write-heavy features; Postgres option, per-provider quota buckets,
  SQLite-backed enrichment cache. (cross-cutting)
- **Factor-weight learning auto-apply (unassigned, L, needs owner sign-off)** — scheduled cadence
  → OOS gate → clamp → persist, opt-in flag. (improvement-audit §3.6)
- **Overlap-aware IC SE + Deflated-Sharpe/PBO on auto-apply gates (unassigned, L)** — statistical
  honesty before any learning loop auto-applies. (expert reviews)
- **CPCV multi-fold + point-in-time universe for backtests (unassigned, L)** — survivorship fix.
  (expert reviews big-bets)
- **Joint portfolio construction over the batch (unassigned, L)** — cluster/diversify/allocate as
  a true Manager step. (expert reviews big-bets)
- **Active hedging / net-exposure reduction on vol brake (unassigned, L)** — protect the existing
  book, not just stop entries. (expert reviews big-bets)
- **Earnings-transcript + news point-in-time ingestion (unassigned, L)** — fill the dead doc_types
  retrieval already asks for. (expert reviews)
- **Groundedness/faithfulness advisory gate (unassigned, M)** — flags ungrounded claims into the
  approval inbox (shared strategy+chat). (expert reviews cross-cutting)
- **End-to-end point-in-time leakage certificate (unassigned, M)** — certifies no data class
  leaked hindsight into an auto-apply gate. (expert reviews cross-cutting)
- **Tamper-evident audit chain (unassigned, L)** — make receipts unforgeable. (expert reviews)
- **Model/prompt registry + promotion gate + input-drift monitor (unassigned, L)** — ops maturity
  for model swaps. (expert reviews)
- **Decision-bundle persistence + replay substrate (unassigned, M)** — seeds + run-level Langfuse
  trace tree + online eval sampler. (expert reviews)
- **Multi-user fill streaming (unassigned, M)** — the Alpaca trade-updates stream is
  operator-only today (`alpaca-trade-updates-stream.ts`). (code sweep)
- **`admin.socratictrade.com` dedicated admin host (unassigned, M)** — DNS/routing/middleware
  split. (console-parity-open-items)

### 2026-07-05 full itemization — every remaining review finding, individually tracked
_Owner-directed follow-up to the exhaustiveness pass: two enumeration agents classified EVERY
discrete finding in the 147-finding expert design review (EDR-*), the composite review (CR-*), and
the full 2026-06-30 improvement audit (U-*) against this board; everything not DONE, in an
In Progress lane's stated scope, or already an individual row below is promoted here. Same lane
tags as above. Items covered by the Wave-3 In Progress lanes (belief/dissent schema, structured
Red Team verdict + removed[], debate-transcript persistence, per-model conformance recording) were
deliberately NOT re-promoted. VERIFY-BEFORE-BUILD note: the 07-04 reviews' current-state text says
a RAG golden eval harness, a Voyage query-embed LRU cache, and an `auto-tune-scheduler.ts`
OOS/ledger/shadow path may already exist — assignees of those earlier rows must verify and, if
built, move the row to Completed with evidence instead of re-building._

#### Memory & learning
- **Hierarchical partial-pooling across account scorecards (AG, L)** — empirical-Bayes/James-Stein shrinkage toward a population prior so thin accounts borrow strength. (EDR-A9)
- **Drift/change-point detection + time-decay weighting on scorecards (AG, M)** — ~60-90 trading-day half-life decay + CUSUM/Page-Hinkley on rolling OOS IC/win-rate. (EDR-A10)
- **Exploration budget + inverse-propensity de-biasing of the eval stack (unassigned, L)** — epsilon/Thompson floor + IPS/doubly-robust weighting; the whole measurement stack is self-selected today. (EDR-A11)
- **Symmetric, OOS-gated, SPY-relative missed-opportunity nudge (AG, S)** — also down-weight factors dominating skipped losers; raise the 2-winner trigger; market-adjust; persist through the OOS gate instead of this-run-only. (EDR-A12, U-25, U-27)
- **Promote signal_snapshot to a first-class indexed table (CURSOR, M)** — factor attribution off the 500-row audit ring so long-horizon trades keep context. (EDR-A14)
- **Route MAE/MFE excursions through the OHLC cascade and into stop/TP tuning (AG, M)** — direct Yahoo call bypasses cache/PIT guard; capturePct stats feed nothing. (EDR-A15, U-28)
- **Brier/ECE reliability + default-on continuous confidence calibration incl. shorts (AG, M)** — isotonic/Platt on the continuous fit; make monotone recalibration the sizing default. (EDR-A16, U-30)
- **Weighted multi-factor entry attribution instead of argmax dominantFactor (AG, M)** — proportional credit across factorBreakdown so non-momentum factors aren't starved. (CR-A)
- **Stop defaulting unresolved factor attribution to momentum (CURSOR, S)** — missing entry factors silently corrupt per-factor tuning stats. (U-26)
- **Re-validate and decay qualitative track-record facts each reflection cycle (CLAUDE, M)** — recompute live `track_record:*` subjects; supersede flipped verdicts; require sign-stability. (CR-A)
- **Stamp sample-size/window/shrunk-band metadata on track-record facts (CLAUDE, S)** — a 5-lot fact must not read like an 80-lot fact; adds the missing overfitting guard. (CR-A, U-29)
- **Kind-aware TTLs + regime-shift down-ranking for learned facts (CLAUDE, M)** — `expiresAt` is null at every write site; event 90d / structural 365d defaults; down-rank, never delete. (CR-A)
- **Contradiction detection across differently-keyed learned facts (CLAUDE, M)** — same-symbol embedding+LLM check at write time; link as contested, surface disagreement. (CR-A)
- **Outcome-driven confidence updates on learned_context facts (CLAUDE, M)** — nudge stored confidence with the shrunk win-association from the usefulness join. (CR-A)
- **Account-scoped memory retrieval as a receipted policy choice (CLAUDE, S)** — opt-in `memoryScope` field + label retrieved memories by source account. (CR-A)
- **Exclude mechanical pseudo-regimes from learning buckets (AG, S)** — 'Funding'/'Risk Exit' tags dilute thesis×regime stats; route to a mechanical-exits scorecard. (CR-A)
- **Window-coverage disclosure on every learning aggregate read (CURSOR, S)** — return `{windowRowsScanned, windowOldestAt, totalRowsAvailable}` on capped aggregates. (CR-A)
- **Calibrate the paper execution-cost model against realized live slippage (MONET, M)** — the 1bps+sqrt-impact constants are uncompared guesses; add a calibration report. (CR-A, U-34)
- **Shadow-weight forward report for the tuner's auto-apply on-ramp (AG, M)** — compute would-have-applied vs active so "watch it be right for a month" is possible. (CR-A)
- **Graduate regime-conditioned calibration/missed-opportunity stats to gated application (AG, L)** — add the regime dimension with thin-bucket fallback. (CR-A)
- **Post-apply degradation receipts on autonomous weight changes (AG, L)** — tag closed lots with the weight-vector id; propose an advisory revert on detected degradation. (CR-A)
- **Per-regime factor-weight vectors in the OOS harness and policy (unassigned, L)** — single global IC vector today; gate by per-regime sample size. (U-31)
- **Weekly memory rollup + default-on dedupe for blocked-case noise (CLAUDE, M)** — chatty weeks flood the namespace; add an LLM lesson-rollup journal doc. (CR-A)
- **Attach testable predictions to lessons/coach notes and score them at maturation (CLAUDE, M)** — flag UNTESTED and repeatedly-refuted lessons for retirement. (CR-A)
- **Consolidate the two parallel memory-ingestion pipelines (CLAUDE, M)** — chat memory vs learned-context duplicate extract→score→reconcile + PII regexes. (CR-A)

#### LLM prompting
- **Structured-output repair loop on parse failure (CURSOR, M)** — one "your output failed with <error>" round-trip before fallback/degrade. (EDR-B4)
- **Runtime schema validation of parsed LLM output via ajv/zod (CURSOR, M)** — `sanitizeProposals` only checks symbol/side/type today. (EDR-B5)
- **Restructure prompt caching: static system prompt + multi-breakpoint + cache-token accounting (CLAUDE, M)** — move volatile values to the user message; price cached/cache-write tokens correctly. (EDR-B6)
- **Manager/judge synthesis turn over Bull-vs-Bear disagreement (CLAUDE, M)** — reconciled decision + calibrated size multiplier; deterministic gate stays the backstop. (EDR-B9)
- **Truncation auto-recovery + output-cap scaling (CURSOR, M)** — bounded re-issue at a larger cap/failover model for Bull AND Bear; today a truncated Bull degrades to zero proposals. (EDR-B14, U-22)
- **Bounded agentic evidence tool-loop for the Bull (CLAUDE, L)** — get_filing/rag_search/memory_analogs/price_history, hard-capped ~6 calls. (EDR-B15)
- **Fence + version the debate prompt; consolidate the two adversary paths (CLAUDE, M)** — versioned `strategy-prompts.ts`, force-tool verdict schema, delete the Anthropic-only fork. (EDR-B16, U-24)
- **Bandit-based automatic model selection from per-model realized scorecards (unassigned, L)** — Thompson sampling within an owner allowlist; follow-on to the w3-permodel-loop lane. (EDR-B19)
- **Self-consistency k-sample ensembling with disagreement as measured uncertainty (unassigned, L)** — N=3 sampling for stakes-crossing proposals. (CR-B)
- **Evidence parity for Bear/debate (CLAUDE, M)** — the critic argues from strictly less information than the proposer today. (CR-B)
- **Probabilistic forecast elicitation + Brier scoring (CLAUDE, M)** — `{pPositive1d, pPositive1w, expectedMaxDrawdownPct}` scored against the outcome writer. (CR-B)
- **`strongestCounterRead` self-dissent field on the Bull call (CLAUDE, S)** — state the strongest bearish read of its own evidence and why rejected. (CR-B)
- **Stated hold-through-earnings intent on the dissent block (CLAUDE, M)** — require `earningsIntent` when earnIn ≤ horizon; tag closed lots heldThroughEarnings. (CR-B)
- **Partial-action vocabulary: probe sizes + staged entries (CLAUDE, S)** — doctrine language + persisted completion plan so probes aren't scored as timidity. (CR-B)
- **Session/time-of-day context + entrySession outcome bucketing (CURSOR, S)** — first-30-minutes behavior becomes a learnable bucket. (CR-B)
- **Tax YTD realized-ledger context in the prompt (CURSOR, S)** — `getTaxSummary` totals never reach the agent though Nov-Dec decisions depend on them. (CR-B)
- **Fix the hardcoded "Robinhood brokerage account" fact in the Bull system prompt (CURSOR, S)** — parameterize from the active account. (CR-B)
- **Measure the LLM replay self-flip noise floor before trusting the manager A/B (AG, M)** — persist response fingerprints, send seed, K=3 baseline repeats. (CR-B)
- **Shadow-mode paired manager A/B on identical inputs (AG, M)** — replay the same userContent against challenger models in a paper shadow lane. (CR-B)
- **Gate strategy runs on the rationale-diversity collapse signal (CLAUDE, M)** — `computeRationaleDiversity` computes but only reports today. (U-21)
- **Extend failover parity to Bear, debate, revalidation, and post-mortem calls (CURSOR, M)** — the failover chain is Bull-only; one 429 fails other roles to bearUnavailable/skip. (U-23)

#### RAG, ingestion & embedded memory
- **MMR embedding-space diversity pass replacing lexical-only dedupe (CLAUDE, M)** — semantically-redundant chunks crowd the small chunk budget. (EDR-C9)
- **Preserve HTML heading structure through filing text extraction (CLAUDE, M)** — most 10-K subsections collapse to section='General' today. (EDR-C12)
- **Persist chunk text/date/model/vector-id — SQLite as reconstructable system of record (CLAUDE, M)** — unblocks corpus-wide hybrid, model migration, supersede, rebuild. (EDR-C21)
- **Reconcile amended/superseded SEC filings (CLAUDE, M)** — 10-K/A / 10-Q/A / 8-K/A supersede prior accessions' vectors. (EDR-C24)
- **Event-driven material-filing + Form-4 ingestion off the EDGAR latest-filings feed (AG, M)** — short-interval poll of watched CIKs with immediate targeted ingest; replaces TTL cadence. (EDR-C25, CR-D)
- **Wire the structured-output LLM memory extractor as the primary salience path (CLAUDE, M)** — the regex stand-in matches any 1-5 uppercase token and misses most natural-language constraints. (EDR-C26, U-18)
- **Expand the RAG golden eval with episodic-analog queries and hard negatives (CLAUDE, M)** — the harness is saturated at 1.0 with zero memory-doc-type cases; must land before tuning decay/hybrid/ranking. (CR-C)
- **Recency-decay ranking prior for time-sensitive doc types (CLAUDE, M)** — per-docType exponential decay for 8-K/news/decisions/coach-notes, never fundamentals. (CR-C, U-19)
- **Typed retrieval-status receipt (no-memory vs lookup-failed vs budget-skipped) (CLAUDE, S)** — an empty Memory panel becomes a receipt, not a blank. (CR-C)
- **"Search my decisions" tool for the console assistant (CODEX, S)** — searchDecisions over decision/coach/lesson doc types with SQLite fallback. (CR-C)
- **Relevance-scored retrieval for the chat user_memory store (CLAUDE, M)** — currently 12 most-recent regardless of the conversation. (CR-C)
- **Fix `matchToChunk` omitting published_at from as-of resolution (CURSOR, S)** — use the `resolveAsOfStamp` precedence. (CR-C)
- **Align the 2400-char storeContexts trim with the token-based chunker (CURSOR, S)** — char cap cuts structure-aware chunks and atomic tables. (U-15)
- **Normalize RAG doc_type casing at the ingest boundary (CURSOR, S)** — casing depends on caller; patched only at query time. (U-16)
- **Owner decision: enable full-corpus RAG ingest (paid Voyage, 8-K bodies, disclosures) (unassigned, M)** — corpus size is the binding RAG constraint; cost decision. (U-17)
- **Corpus-wide hybrid sparse retrieval via FTS5 or Pinecone sparse-dense (CLAUDE, L)** — hybrid is off by default with IDF over the ≤50-doc dense pool. (U-20)

#### Data providers & connectivity
- **In-flight request coalescing (single-flight) for concurrent enrichment fetches (AG, M)** — per-(provider,symbol) promise table. (EDR-D3)
- **Generalized negative-caching for no-data symbols (AG, S)** — short negative-TTL on genuine empty results across providers. (EDR-D4)
- **SQLite-backed enrichment cache surviving restarts (AG, M)** — no cold-start provider storm after deploys. (EDR-D5)
- **Per-provider proactive quota token buckets (AG, M)** — Finnhub/AlphaVantage/Tiingo/TwelveData/Intrinio degrade gracefully instead of 429ing. (EDR-D9)
- **Keyless fundamentals redundancy tier (AG, M)** — SEC-XBRL EPS/revenue/shares + Stooq quotes below keyed tiers, above Yahoo. (EDR-D12)
- **Bulk endpoints instead of per-symbol N+1 fan-out (AG, M)** — incl. collapsing Finnhub's 5-call-per-symbol scan pattern behind the 25s timeout. (EDR-D13, U-13)
- **Gate Alpaca IEX first-wins by snapshot freshness/liquidity (AG, M)** — stale thin IEX prints must not beat fresher consolidated quotes. (EDR-D14)
- **Surface FINRA short-interest settlement-date age (AG, S)** — annotate value age in the disagreement bulletin. (EDR-D16)
- **Second short-interest source with disagreement flag (AG, S)** — shortPercentOfFloat is Yahoo-only; add FMP backup. (U-10)
- **Cross-provider plausibility/consensus check on price, P/E, beta, marketCap (AG, M)** — extend the median/MAD disagreement-bulletin pattern beyond short interest. (CR-D)
- **Finance-tuned news sentiment replacing the keyword-bag scorer (AG, M)** — FinBERT/ONNX, batched LLM scoring, or Finnhub news-sentiment. (CR-D)
- **Per-field coverage/fill-rate telemetry with a low-coverage alert (CURSOR, S)** — a field going dark is invisible today. (CR-D)
- **Corporate-action-consistent forward returns for matured outcomes (AG, M)** — mixed adjustment bases can inject phantom split returns; else mark unresolvable. (CR-D)
- **Deep historical OHLC backfill via nightly grouped-daily append (AG, L)** — local daily_bars table for analog search + backtest depth. (CR-D)
- **Fold streamed intraday minute bars into scan-time momentum (AG, M)** — VWAP/slope feature from already-streamed bars. (CR-D)
- **13F institutional holder-delta evidence bulletins (AG, L)** — quarterly top-N manager deltas from free EDGAR filings. (CR-D)
- **RSP-vs-SPY narrow-leadership dislocation signal (AG, S)** — regime tell missed by breadth% alone. (CR-D)
- **Adopt shared resolveTickerAlias in Congress outbound + App A import (AG, S, cross-app)** — neither app applies the shared alias map; pairs with the rename-vs-acquisition split. (U-09)
- **Add App B readers for App A insider/short-volume paths or remove them (AG, S)** — implemented API paths never consumed by the peer app. (U-11)
- **Drop rows failing Congress outbound SharePayload validation (CURSOR, S)** — safeParse result is discarded with a console.warn. (U-12)
- **Provider-health circuit breaker skipping stoppedWorking lanes (AG, M)** — db-health computes stoppedWorking for display only. (U-14)

#### Decision-making & risk (MONET lane unless noted)
- **Changepoint self-throttle on the account's own realized edge (MONET, M)** — CUSUM on rolling win-rate/IC raises dissent threshold and shrinks sizing on a downward break. (EDR-E13)
- **Size on outcome dispersion/skew, not just mean edge (MONET, M)** — per-thesis downside deviation/Sortino penalty. (EDR-E19)
- **Advisory earnings-proximity opening-size gate (MONET, M)** — owner-overridable; skip when the date is unknown. (CR-E)
- **Reversal-trigger / invalidation watcher on open positions (MONET, L)** — structured triggers on every opening + a scheduler tick that escalates "thesis challenged". (CR-E)
- **Cadence-gated held-position thesis review pass (MONET, M)** — daily hold/trim/exit/re-underwrite logged as a non-action case. (CR-E)
- **Escalation-regime decision-depth playbook (MONET, M)** — raise retrieval k, force debate on all openings, include the flip audit trail when Crisis/Risk-Off fires. (CR-E)
- **Per-regime owner-editable doctrine sections (unassigned, L)** — the Belief step cites the active regime's doctrine or explicitly dissents. (CR-E)
- **Novelty/out-of-distribution composite score as decision input + receipt field (unassigned, L)** — structurally novel tapes should not size like a normal day. (CR-E)
- **Sizing-vs-conviction waterfall receipt (MONET, M)** — expose confidence → calibration → caps → Kelly → override chain. (CR-E)
- **SPY-relative excess return on per-trade stats and scorecards (AG, M)** — feed excess, not raw, into the tuner once samples suffice. (CR-E)
- **Generic "agent asks a question" escalation primitive (CODEX, L)** — one escalation object rendered as a conversational card; generalizes wash-sale-ask. (CR-E)
- **Max-pairwise correlation receipt on every candidate (MONET, M)** — inject "corr 0.91 w/ NVDA (18% of book)" into the prompt entry. (CR-E)
- **ATR-multiple trailing stops (MONET, M)** — volatility-blind flat percent corrupts thesis stats with noise-stops. (CR-E)
- **Working-order lifecycle: limit repricing as a logged decision with stated patience (MONET, M)** — optional workingIntent executed by a scheduler pass. (CR-E)
- **Agent-judgment sell-to-fund replacing the biggest-loser sort (MONET, M)** — annotated candidate table (wash-lock, ST/LT, thesis quality); deterministic sort stays fallback. (CR-E)
- **Stated cash-allocation judgment + cash-drag attribution (MONET, M)** — justify cash level; attribute underperformance to undeployed cash. (CR-E)
- **End-of-day/weekend carry receipt with carry-or-trim judgment (MONET, M)** — mark the session boundary before the book goes overnight. (CR-E)
- **Risk-adjusted account statistics beside the SPY comparison (AG, M)** — max drawdown, Sharpe/Sortino, vol on Results. (CR-E)
- **Deterministic evidence-quality score on every receipt (MONET, M)** — quote age, source count, disagreement flags, RAG hits — separate from stated confidence. (CR-E)
- **"Waited" as a scored decision alternative with realized counterfactual (AG, M)** — compute the +1d/+1w waited-entry counterfactual as calibration feedback. (CR-E)
- **Drawdown-halt breach becomes a captured Socratic post-mortem case (MONET, M)** — auto-generate the halt case file instead of a bare state flip. (CR-E)
- **Split Unknown-data-missing from Unclassified-genuinely-novel regime states (CURSOR, S)** — epistemically opposite states are conflated. (CR-E)
- **Aggregate per-run/day Socratic override budget (MONET, S)** — the per-proposal cap lets simultaneous overrides jointly exceed the deviation budget. (CR-E)
- **Deviation scoreboard: override receipts vs matured outcomes vs blocked baseline (MONET, M)** — answers "is the agent's judgment beating my guardrails?". (CR-E)
- **Render dissent honestly as three distinguishable states (CODEX, S)** — stop padding fake "Policy counterargument" entries when no critic ran. (CR-E)
- **Scale the marketable-limit buffer with observed spread (MONET, M)** — flat 15bps under-fills wide names and overpays tight ones. (CR-E)
- **Paper limit-fill touch test (AG, M)** — instant limit-price fills without a touch inflate paper win-rates and poison tuner data. (CR-E)
- **Tighten dailyExecutionStats to placed-only for live accounts (CURSOR, S)** — verify post-#342 semantics first. (U-32)
- **Re-baseline risk-breaker durability: HWM restart, surfacing, close_only proof (MONET, M)** — verify restart behavior and that blocked evidence is real. (U-33)
- **Audit the un-reviewed risk-module family: sell-to-fund, synthetic stops, held orders (MONET, M)** — never assessed by any review; the KO 403 prod bug lived here. (U-35)

#### Console & UI (CODEX lane unless noted)
- **Actions as master pane with Evidence/Dissent as detail (CODEX, M)** — multi-decision runs currently show only primaryDecision's evidence. (CR-F)
- **Non-action/pass cases as first-class Actions rows (CODEX, M)** — render "considered X, declined because Y, would reconsider if Z". (CR-F)
- **Unified owner inbox: trades + learned-context + framework proposals + escalations (CODEX, M)** — the Approvals badge undercounts what awaits the owner. (CR-F)
- **Chat streaming + optimistic coach-note echo + skeletons + optimistic approve/reject (CODEX, M)** — perceived-performance pass. (CR-F)
- **Centralize LLM provider label formatting (CURSOR, S)** — ≥8 inconsistent call sites. (CR-F)
- **Reconcile Socratic nav names with legacy page h1s across 7 screens (CODEX, S)** — Journal/Evidence/Regime vs Activity/Scan/Macro etc. (CR-F)
- **Rewrite Mandates/Guardrails copy to advisory-input framing (CODEX, S)** — the UI's words contradict the decided guardrail philosophy. (CR-F)
- **Link Journal runs/proposals to their Socratic case files (CODEX, S)** — no path from a run row to its evidence/dissent/coach trail. (CR-F)
- **Coach affordance on closed-lot outcomes (CODEX, S)** — the canonical coaching moment has no writer or renderer. (CR-F)
- **Coaching pipeline visibility + split Coach vs Assistant naming (CODEX, M)** — show note → rule → in-prompt lifecycle; "Coach" nav must not point at generic chat. (CR-F)
- **Per-model and post-coaching cohort sections on Results (CODEX, M)** — with honest n labels. (CR-F)
- **One shared confidence-rendering primitive (CODEX, S)** — conviction renders three inconsistent ways. (CR-F)
- **Stop title-casing machine thesis tags into fake prose (CURSOR, S)** — formatting artifact reads as agent-written thesis. (CR-F)
- **Fix the assistant page's two competing h1s (CURSOR, S)** — "Coach Socratic Trade" vs "Assistant". (CR-F)
- **Per-decision LLM cost/latency on the trace (CODEX, M)** — receipts never state what a decision cost. (CR-F)
- **Inline quantitative-signal visualizations (CODEX, S)** — confidence gauge, mini factor bars, macro sparklines. (CR-F)
- **Conditional-GET (ETag/304) on the console poll (CODEX, M)** — plus first-paint skeletons. (CR-F)
- **Operator density toggle + optional multi-pane Desk layout (CODEX, L)** — react-resizable-panels is an unused dependency today. (CR-F)
- **Visible command-palette affordance with ⌘K hint (CODEX, S)** — keyboard-only today; re-scope to /console. (U-01)
- **Update phase-8-cockpit-ui.md to the real console IA or mark superseded (CURSOR, S)** — doc drift. (U-02)
- **Click/tap-to-expand rationale instead of hover-only truncation (CODEX, S)** — unreachable on touch. (U-03)
- **Collapse icon sizing to a 3-step semantic scale (CURSOR, S)** — 11 distinct sizes today. (U-04)
- **Decide Recharts/Motion intent: retire from docs or adopt (CODEX, S)** — design intent eroded. (U-05)
- **Write docs/design/visual-system.md for the real token system (CODEX, S)** — tokens exist, undocumented. (U-06)
- **redTeamVerdict proposal field + rendered Bear Review block (CODEX, M)** — the core differentiator is appended into a clamped rationale string today. (U-07)
- **Named spacing/blur elevation tiers + drift sweep (CURSOR, S)** — p-2…p-6 and backdrop-blur drifted ad-hoc. (U-08)

#### Systems, evaluation, security-hardening & ops
- **Queryable audit trail: generated columns or a typed decision_log table (CURSOR, M)** — payloads are opaque TEXT JSON requiring full-table scans. (EDR-G7)
- **Run-level Langfuse trace tree + online eval-in-prod sampler (CURSOR, M)** — one parent span stitching scan→Bull→Bear→placement. (EDR-G11)
- **Doctrine regression replay harness (unassigned, L)** — "which of my last 60 decisions flip under the proposed doctrine, and did the flips help?". (CR-G)
- **Fidelity-tier contract for validation use-cases (AG, S)** — pin each question type to the cheapest sufficient simulation tier. (CR-G)
- **Factor/beta-adjusted alpha via Fama-French regression (AG, M)** — famafrench.ts is unwired; "beating SPY" can be pure beta. (CR-G)
- **Fence every untrusted-text field entering money-path prompts (CLAUDE, M)** — headlines/bulletins/RAG chunks arrive raw with no data-not-command clause. (CR-H)
- **Injection-attempt detection as a receipt/dissent field (CLAUDE, M)** — deterministic scanner; detection IS the control under advisory philosophy — never a block. (CR-H)
- **Flip the Socratic override lane's shipped default to propose + daily override-budget facts (MONET, M)** — execute/100%-NAV default is a poisoned-headline blast radius. (CR-H)
- **Move reflection_summary out of the SYSTEM prompt into a fenced data block (CLAUDE, M)** — unreviewed persistent SYSTEM-role write laundered from untrusted rationale. (CR-H)
- **Stated-confidence vs realized-calibration anomaly receipt (MONET, M)** — confidenceScore is attacker-influenceable input to gates and sizing. (CR-H)
- **Trust-tier metadata on the RAG corpus + laundered-chunk quarantine (CLAUDE, L)** — filings, LLM summaries, and rationales share one untiered namespace. (CR-H)
- **Trust-tier labels in the Evidence panel (CODEX, M)** — deterministic vs third-party vs LLM-derived vs owner. (CR-H)
- **Evidence-age anomaly receipts (CLAUDE, S)** — flag decisions leaning on sources first seen today (plant-then-pump pattern). (CR-H)
- **Render learned-fact provenance inline in money prompts (CLAUDE, S)** — origin/source/assertedAt/confidence on every retrieved fact line. (CR-H)
- **Sanitize AI-LEARNED doctrine block delimiters (CURSOR, S)** — a value containing the closing delimiter orphans doctrine text permanently. (CR-H)
- **HMAC-SHA256 + timestamp on the congress push webhook (AG, S, cross-app)** — a leaked static bearer allows forged cluster-BUY payloads. (CR-H)
- **Confirmation chip before minting hard constraints from chat text (CODEX, S)** — regexes mint permanent hard:true rows from any paste. (CR-H)
- **SQLite↔Pinecone dirty-flag reconciliation sweep (CLAUDE, M)** — an outage during a run permanently drops decisions from analog retrieval. (CR-H)
- **Durable retry on Socratic case-write failure (CURSOR, S)** — a live order can exist with no case and no receipt today. (CR-H)
- **Wire Socratic case status transitions into the order lifecycle (CURSOR, M)** — cases stay 'proposed' forever after fills. (CR-H)
- **Periodic broker-truth reconciliation of positions/cash/lots (MONET, M)** — crossCheckRealizedPnl has zero production callers; manual trades desync learning silently. (CR-H)
- **In-app receipt when the agent silently stops running (CURSOR, M)** — boot-halt + cadence-aware missed-run detection, Sentry-independent. (CR-H)
- **Propagate account deletion to Pinecone (CURSOR, S)** — embedded artifacts survive deletion today. (CR-H)
- **Admin rebuild-from-SQLite route for the vector corpus (CLAUDE, L)** — the corpus's only copy lives in a third-party index. (CR-H)
- **Documented Mac keep-awake posture + tick-gap detection (CURSOR, S)** — a lid close silently drops synthetic-stop protection. (CR-H)
- **Sweep crashed runs stuck at status='running' (CURSOR, S)** — process kill mid-run leaves a phantom in-progress run forever. (CR-H)
- **Disk headroom + WAL growth in health/ops-snapshot (CURSOR, S)** — a full disk silently breaks order-writes and replication. (CR-H)
- **Reject legacy-plaintext key decrypt + audit LLM endpoint host overrides (CURSOR, S)** — decryptValue accepts plaintext forever; env can silently redirect money-path prompts. (CR-H)
- **Batch proposal-linked point queries in the dashboard feed builders (CURSOR, S)** — per-row SELECTs → one WHERE IN. (U-36)
- **Cap buildUnifiedFeed output at the source (CURSOR, S)** — server builds uncapped, client renders 50. (U-37)
- **Cache .next build output for Playwright e2e CI runs (CURSOR, S)** — e2e.yml pays a cold build every run; #370 covered ci.yml only. (U-38)
- **Tune better-sqlite3 cache_size/mmap_size pragmas (CURSOR, S)** — sequence after the fill-replay fix. (U-39)
- **Default checkAdmin allowNonProd=false for write/admin routes (CURSOR, S)** — /api/admin/* is unauthenticated whenever NODE_ENV!=production. (U-40)
- **Re-scope /api/ops + /strategy public prefixes and split the ops token (CURSOR, S)** — ops snapshot exposes multi-user data behind one fallback-shared token. (U-41)
- **Make the rate limiter multi-process-safe or fail-closed (CURSOR, M)** — tie to the single-leader decision before scale-out. (U-42)
- **Characterization tests for strategy.ts order construction + broker gateways (AG, M)** — pin limit-price math and short/cover sides BEFORE the god-module split. (U-43)
- **Wire the usageTelemetry push client into recordLlmUsage/recordRagUsage (CURSOR, S)** — fully-built shared client + working ingest, zero callers. (U-44)
- **Emit Bear-veto and diversity-collapse events as Langfuse observations (CURSOR, S)** — the Langfuse layer exists; guardrail events never reach it. (U-45)
- **Push-from-app as the primary monitor channel for Anthropic/Voyage/Robinhood (AG, M, cross-app)** — poll adapters are structurally blind to this app's real cost drivers. (U-46)
- **Market-data/broker call-volume telemetry via the push path (AG, M, cross-app)** — closes the shared-rate-limit blind spot. (U-47)
- **Monitor→app cost feedback loop: alerts into the app's notification pipe (unassigned, L, cross-app)** — distinct from the tracked in-app ceilings. (U-48)

#### Deep-sweep additions (2026-07-01 learning-loop/RAG expansion backlogs + June residuals)
_Basket caveats recorded by the sweep: the "Factor-weight learning auto-apply" row must land WITH
its safety prerequisites (now individually tracked below: patch-scope restriction, invariant
guard, mutation ledger, dry-run); the "RAG retrieval-quality eval harness" row's prerequisites
(anti-leakage lint, regression net) are below; "Approvals triage upgrades" includes the
portfolio-impact preview; "Global symbol omnibox" means search-anywhere, not click-a-row._

- **Fail-closed as-of strict mode for undated chunks (CLAUDE, S)** — opt-in `VECTOR_ASOF_STRICT` drops undated chunks under an active asOf, with a drop-count audit. (rag-expansion)
- **Embedding integrity guard before upsert (CURSOR, S)** — assert length===1024 + all-finite; drop-and-audit malformed vectors. (rag-expansion)
- **Pinecone index-metric cosine assertion at bootstrap (CURSOR, S)** — every cosine floor is meaningless if the metric isn't cosine. (rag-expansion)
- **Shared fail-closed env-flag parser for RAG flags (CURSOR, S)** — flags disagree on accepted truthy values today. (rag-expansion)
- **Fix salience first-match-only ticker mis-binding (CURSOR, S)** — `text.match()` binds the first token (`I`, `CEO`); matchAll + validation. (rag-expansion)
- **Golden-set anti-leakage + hard-negative lint (CLAUDE, S)** — prerequisite that must land with/before the eval harness row. (rag-expansion R3) (triage 2026-07-05: already done — see PRs #297/#299)
- **Retrieval regression net for as-of/rerank/hybrid fail-safe paths (CLAUDE, S)** — network-free tests pinning the fail-open/fail-closed behaviors. (rag-expansion R4) (triage 2026-07-05: already done — see PRs #297/#299)
- **Fix train/serve embedding text skew (CLAUDE, M)** — chunks embed with a `[Published: …]` prefix, queries don't; flag-gated since it invalidates vector comparability. (rag-expansion)
- **Per-run corpus-coverage receipt for requested-but-empty doc types (CLAUDE, S)** — `earnings-transcript` is requested with zero producers and nothing says so. (rag-expansion)
- **Persist the full retrieved candidate set including unused chunks (CLAUDE, M)** — the RAG snapshot is triple-lossy; "what I ignored" analysis is impossible. (rag-expansion)
- **Offline corpus coverage & freshness report script (CURSOR, M)** — counts by doc_type, as-of ranges, watchlist symbols with zero coverage. (rag-expansion)
- **Contextual-retrieval situating prefixes for high-value chunks (CLAUDE, L)** — optional ingest-time LLM preamble beyond the static provenance header. (rag-expansion)
- **Server-side numeric as-of epoch filter in Pinecone (CLAUDE, M)** — post-fetch cuts silently empty small pools today. (rag-expansion)
- **FRED ALFRED vintages for point-in-time macro backtests (AG, M)** — revised values leak into historical backtests. (rag-expansion)
- **Ingest-time semantic near-dup gate via MinHash/SimHash (CLAUDE, M)** — exact-hash-only dedup misses boilerplate near-dupes before embedding cost. (rag-expansion)
- **Eval-gated embedding-model/quantization benchmark (CLAUDE, M)** — voyage-finance-2 is frozen with no compared alternative. (rag-expansion)
- **Pinecone namespaces for per-user isolation (CLAUDE, M)** — isolation rides entirely on metadata filters in one namespace today. (rag-expansion)
- **Stale 8-K vector eviction policy in the ingest path (CLAUDE, M)** — June finding never revisited. (2026-06-18)
- **Embed FRED macro narratives as retrievable as-of-dated docs (CLAUDE, M)** — "what was the macro backdrop" analogs are unretrievable today. (rag-expansion)
- **Options-flow/unusual-activity ingestion connector (AG, M)** — skew/OI/unusual-options as an alt-data doc type. (rag-expansion)
- **Coverage-driven ingestion prioritization + just-in-time ingest (CLAUDE, M)** — held > watchlist > top candidates; JIT on demand. (rag-expansion)
- **Owner decision: multi-symbol learned-fact schema — symbol vs symbols[] (unassigned, S)** — R8, explicitly left open 2026-07-01, never resolved. (rag-expansion)
- **Lazy fallback-body construction in the LLM client (CURSOR, S)** — fallback bodies are built eagerly even when the primary succeeds. (composite)
- **Bear visibility into top non-proposed candidates (CLAUDE, S)** — the critic can't say "you picked the wrong name". (composite)
- **Treat parse/schema failure as retryable inside the failover loop (CURSOR, M)** — failover fires only on transport errors today. (composite)
- **Adaptive reasoning-effort/model-tier routing by decision difficulty (unassigned, M)** — escalate only on disagreement/borderline cases. (composite)
- **Input-side token-budget pre-flight guard (CURSOR, M)** — trim lowest-value context to a target budget before sending. (composite)
- **Scout-then-analyst two-stage evidence pre-pass (CLAUDE, L)** — cheap scout gates deep enrichment/retrieval/expensive-Bull; pairs with the agentic tool-loop row. (both reviews)
- **Cross-provider field-demand planner (AG, L)** — stop fetching every field from every provider; paid tiers skip already-satisfied fields. (composite)
- **Timestamped, sourced news objects (AG, M)** — `{publishedAt, source, url, id}` instead of bare headline strings. (composite)
- **Trading-halt/LULD feed + stop-suppression receipts (AG, M)** — receipt whenever a protective stop is suppressed by a halt. (composite)
- **Auto-subscribe held positions on the real-time price stream (CURSOR, S)** — only watched/scanned symbols are subscribed today. (composite)
- **Daily market-state snapshot table for "days like today" analogs (AG, M)** — no persisted daily market-state row exists. (composite)
- **Fix ADV using partial-day cumulative volume (AG, M)** — morning runs mis-size the impact/cap model; use a true trailing 20-day average. (composite — live bug)
- **Intraday-bars module + decision-time snapshot job (AG, L)** — makes 15m/1h multi-horizon outcomes computable instead of unresolvable. (composite)
- **Tradier options/IV enrichment + persisted daily IV series (AG, M)** — the Tradier key is plumbed but unused; distinct from the Robinhood option-chain row. (composite)
- **Keyless intraday credit-stress proxy from HYG/LQD vs IEF quotes (AG, S)** — free high-frequency credit signal from already-fetched ETFs. (composite)
- **Breadth-internals expansion from data already in memory (AG, S)** — net new-highs/lows, up-volume %. (composite)
- **Forward economic-event calendar as advisory prompt context (AG, S)** — FOMC/CPI/NFP; distinct from the reactive blackout gate. (composite)
- **Parse ex-dividend/corporate-action dates from the already-fetched Yahoo payload (CURSOR, S)** — unused fields for tax/timing receipts. (composite)
- **PDT / Reg-T awareness gate (MONET, M)** — advisory, owner-overridable; flagged since 2026-06-21, never built. (June residual)
- **VIX term-structure backwardation as a persistence-gated soft de-risk trigger (MONET, S)** — shown to the LLM today, never a deterministic input. (composite)
- **Factor-exposure aggregation & crowding caps across the book (MONET, L)** — only market beta is aggregated today. (both reviews)
- **Advisory non-null default account circuit breakers (MONET, S)** — drawdown/daily-loss/crisis-cap ship null; give sensible advisory-mode defaults the owner can change. (composite)
- **Overnight/halt gap-risk-aware sizing + stop-limit consideration (MONET, M)** — stops assume trigger-price fills; gap-prone names carry unmodeled risk. (composite)
- **Restrict autonomous tuning applies to scoringWeights only (AG, S)** — `applyOosGate` doesn't gate the rest of the patch; an apply could silently loosen risk caps. SAFETY-CRITICAL prerequisite of the auto-apply row. (learning-expansion P0-1)
- **Fail-closed tuning-config invariant guard (AG, S)** — validate hard safety couplings before any autonomous apply. (learning-expansion P0-3)
- **Unified learning-mutation ledger + one-click revert across ALL learning subsystems (AG, M)** — today's ledger covers scoring_weights only. (learning-expansion P0-4)
- **Deterministic dry-run/replay mode for the autonomous tuning decision (AG, S)** — zero-write `{before, after, wouldApply}`; the operator on-ramp. (learning-expansion P1-1)
- **Purged & embargoed walk-forward split (AG, M)** — the 70/30 chronological split leaks at the boundary. (learning-expansion P1-2)
- **Survivorship certification split: hard CI leakage test + labeled soft diagnostic (AG, M)** — (learning-expansion P1-4)
- **Signed/directional top-bucket gate for the congress signal (AG, S)** — require positive excess return in the top quantile before promotion. (learning-expansion P2-3)
- **Shrink IC-derived weights toward the prior by estimator noise (AG, M)** — a single high-IC factor on a thin fold gets outsized weight. (learning-expansion P2-4)
- **Candidate-vs-baseline turnover/drawdown guardrail equity curves (AG, M)** — only one curve is built today, so the comparison is impossible. (learning-expansion P2-5)
- **OOS test-window starvation guard (AG, M)** — decouple the OOS window from the 500-row audit cap. (learning-expansion P2-6)
- **Reproducibility/provenance snapshot per autonomous apply (AG, S)** — snapshot exact inputs so a past apply's fold can be re-derived. (learning-expansion P2-7)
- **Scheduled re-validation + decay-to-prior + staged canary ramp for applied weights (AG, L)** — re-run OOS on the live vector each cadence. (learning-expansion D-3)
- **Owner decision: autonomous-tuning cadence + scope (unassigned, S)** — daily vs every-N-runs, per-account vs per-user; explicitly open since 2026-07-01. (learning-expansion B1)
- **Verify decision-memory re-index covers outcome/lesson writes (CLAUDE, S)** — #365 wired the coach-note path only; the outcome writer now exists. (verify item)
- **Include held-position symbols in RAG + learned-context retrieval scope (CLAUDE, S)** — sell/hold/trim decisions get zero retrieved memory today. (composite)
- **Statistical-honesty receipts: n, Wilson CI, insufficient-evidence verdicts (AG, M)** — shared `evidenceVerdict()` helper on every surfaced learning number. (composite)
- **Verify calendar-day math fully purged from both learners (CURSOR, S)** — spots beyond what PR #365's trading-day fix touched. (verify item)
- **Exit-side counterfactuals: post-exit regret + size-ladder comparisons (AG, M)** — closed lots are never revisited for "sold too early" or 2x/0.5x-size counterfactuals. (composite)
- **Run-level belief object + richer Live Thesis surface (CODEX, M)** — persist the thesis-of-the-day + revisions; render statement/scope/evidence/invalidation/scorecard instead of a tag-derived headline. (composite + console-parity)
- **Doctrine version ledger stamped onto every decision (CLAUDE, M)** — replay a past decision against the doctrine that produced it. (composite)
- **Framework proposals generated from broader outcome patterns (CLAUDE, L)** — recurring missed-opportunity/calibration-drift/dissent-was-right patterns should propose doctrine changes. (composite)
- **Framework-proposal actuation: accepted → reviewable applied diff (CLAUDE, L)** — acceptance only flips a status enum today. (composite)
- **One structured doctrine store with per-clause provenance (unassigned, L)** — kill the prompt soup: prompt text, reflection blob, learned rows, AI-LEARNED blocks unified. (composite)
- **Unify the five disjoint memory stores behind one Memory surface/API (unassigned, L)** — user_memory, learned_context, reflection, AI-LEARNED, Pinecone. (composite)
- **Memory as a first-class console panel (CODEX, L)** — analogs, counterexamples, what-I-ignored, real provenance. (composite)
- **Deviations receipts page (CODEX, M)** — overrides are a string suffix on a proposal today. (composite)
- **Reversal-trigger live hit/not-hit rendering (CODEX, M)** — UI half of the invalidation watcher (MONET row above). (composite)
- **Fix coach-on-trace beyond decision #1 + dead quick-action chips (CODEX, S)** — reportedly non-functional past the first decision. (composite quick-win, verify vs #443)
- **Verify positions/protection-status/needs-attention components are reachable (CURSOR, S)** — possible orphaned-component P0 regression. (composite)
- **Port appearance/display preferences from the legacy dashboard (CODEX, S)** — console-parity residual. (console-parity)
- **Improve admin/operator link discoverability (CODEX, S)** — console-parity residual. (console-parity)
- **Production-verify `/old` + canonical `/console` routing post-deploy (CURSOR, S)** — local code alone is not proof. (console-parity)
- **Live-device verification of the scan company-info drawer (CURSOR, S)** — desktop + mobile pass post-migration. (console-parity)
- **Observe Pinecone budgets under real scheduler cadence post-index-switch (CURSOR, S)** — ops observation task. (console-parity)
- **LLM pricing-table per-provider coverage audit (CURSOR, S)** — the completeness pass behind the unpriced-default fix. (console-parity)
- **Real SEC EDGAR User-Agent (CURSOR, S)** — placeholder UA flagged 2026-06-21, never fixed. (June residual)
- **Sweep ad-hoc live-broker probe scripts under test/ (CURSOR, S)** — route through the test-broker gateway. (June residual)
- **Verify Robinhood-specific pending-fill reconciliation coverage (CURSOR, S)** — beyond the generic reconciler path. (June residual)
- **Fix checkRegimeFlip non-atomic read-modify-write hardcoded to user 'local' (CURSOR, S)** — confirmed still present in `regime-watch.ts:41`; duplicate-broadcast risk. (June residual — live bug)
- **Owner decision: /old legacy dashboard maintenance policy + residual-fix batch (unassigned, S)** — ~15 deferred legacy-only findings (dual scan fetches, leaked internal labels, policy-write race) tracked as one batch pending the keep-or-freeze call. (June residuals)

### 2026-07-05 next-wave (cycle 2)
_Added 2026-07-05 (CLAUDE next-wave). Sourced from a fresh cross-agent audit of the board against
live PR/git state; see the stale-row corrections applied above in this same pass for the
discrepancies that motivated these rows. Mirrored from the live board
`/Users/jay/apps/TRADING-EFFORT-LOG.md`._

- **Disentangle PR #805: land Cursor P0/P1 commit and AG health slice as separate merges (CURSOR, S)** —
  Resolve #805's conflicts, split commit 0ce39474 (per-user regime keys, security headers, spend
  ceiling) from the AG connection-health work, land both with honest PR records. _(why now: The
  board's phantom 'PR #808 merged' hides that the P0 multi-user regime RMW race and the security
  headers are still NOT on main; the only vehicle is a CONFLICTING two-lane PR.)_
- **Migrate legacy regime:current row to per-user keys at first tick after the P0 fix lands (CURSOR, S)** —
  Seed regime:current:${userId} from the old shared row (or tolerate absence) so the first
  post-deploy tick doesn't fire false regime-flip notifications or lose escalation state. _(why now:
  The checkRegimeFlip fix changes the settings key shape; without a migration every user's stored
  regime resets on upgrade — a correctness gap the fix itself introduces.)_
- **Owner ratification: Rule 4 fundamentals-veto overridability shipped in #814 (OWNER, S)** —
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
- **Render the new advisory audit kinds in the console alert center and activity feed (CODEX, S)** —
  Label/filter deterministic_bear_veto, red_team_veto_overridden, prompt_injection_suspected, and
  evidence_age_anomaly events; zero app/ references to these kinds exist today. _(why now: #814/#816's
  whole design is 'detection IS the control' — advisory receipts are worthless if the owner-facing
  surfaces don't surface them; #807's alert center is the natural home and just merged.)_
- **Wire the getRedTeamEfficacy scorecard into the console (CODEX, M)** — Surface the veto-efficacy
  metrics (API/db-level since the w1-learning-loops landing) on the console, including
  override-vs-non-override splits now that #814 protects the metric. _(why now: The w1 row
  explicitly deferred UI wiring to the console lane and it was never tracked as its own row; #814's
  FIX #1 (no counterfactual on override path) makes the metric trustworthy now.)_
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
- **Batch typed-confirm flow for LIVE proposals in approvals triage (CODEX, M)** — Extend #807's
  bulk actions to LIVE proposals with a single aggregate typed confirmation (per-item provenance
  preserved), instead of forcing one-by-one confirms. _(why now: #807's rollout explicitly scoped
  bulk LIVE out; with the owner running real money and multiple proposals per run, one-by-one typed
  confirms are the exact ceremony the product philosophy says to minimize.)_
- **Sweep settings-table keys for remaining cross-user shared-row races (CURSOR, S)** — Audit every
  hardcoded settings key (scheduler leader, system state, caches) for the same shared-row RMW
  pattern checkRegimeFlip had; per-user-scope or single-writer-guard each hit. _(why now: The P0
  regime race was found by inspection, not by a systematic pass; multi-user correctness is a stated
  priority and the same pattern likely exists on other keys.)_
- **MONET risk-row handback (MONET)** — the five risk rows picked up cross-seat by CLAUDE on
  2026-07-05 (changepoint throttle, correlation/blackout/stress, fractional Kelly, regime scorer,
  vol-targeting) return to MONET; the five empty .claude/worktrees/monet-* worktrees are
  reclaimable.

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
- 2026-07-05 — **Full itemization pass (CLAUDE, owner-directed follow-up).** The owner flagged that
  the exhaustiveness pass promoted only a curated subset. Three enumeration agents classified EVERY
  finding in the 147-finding expert design review, the composite review, the full 2026-06-30
  improvement audit, the 2026-07-01 learning-loop/RAG expansion backlogs, and the June residual
  docs against this board; all ~220 remaining untracked findings are now individual Planned rows
  (see the "2026-07-05 full itemization" + "Deep-sweep additions" subsections), incl. two live
  bugs (partial-day ADV; checkRegimeFlip 'local' RMW) and the safety-critical prerequisites of the
  factor-weight auto-apply lane. Items inside the Wave-3 In Progress lanes were not re-promoted.
- 2026-07-04 — **Backlog exhaustiveness + assignment pass (CLAUDE, owner-directed).** Promoted every
  still-open item from the review docs/PLAN/code-sweep into individually tracked Planned rows with
  assigned lanes (CURSOR/DeepSeek large slate, CODEX + AG medium slates, MONET risk slate, CLAUDE
  memory/RAG slate, unassigned owner-decision bucket); annotated the pre-existing Planned rows with
  assignments (in row bodies, not first lines, to preserve mirror issue identity). Also deduped the
  twice-logged "Wave-1 quick wins" In Progress row (the issues-mirror dry-run had flagged it) — the
  removed copy's detail lives in PRs #364/#365/#366/#368 and their rollout notes. See
  `docs/rollouts/2026-07-04-backlog-exhaustiveness-assignments.md`.
- 2026-07-05 — **Next-wave cycle 2 corrections + new Planned rows (CLAUDE next-wave).** Cross-agent
  audit of this mirror against live PR/git state found several stale rows: `claude/veto-advisory-overridable`
  (#814), the full-suite test-determinism de-flake (#812), and the guardrails-denylist row (#799)
  were relocated from In Progress to Completed (their text already said merged, but they were
  physically mis-filed); the console live-data build-out row was relocated to Completed with #811's
  merge timestamp; the drawdown-advisory-rescope row (#360) and the w2-episodic-retrieval /
  w2-outcome-engine sub-lanes were updated from "PR pending"/"pushed, no PR" to their actual merged
  state (PR #360, PR #437, and the outcome-engine landing train respectively); the AG
  connection-health row was annotated with its real state (open PR #805, mergeable CONFLICTING,
  entangled with an unrelated Cursor commit — not done); the Codex global-coordination row was
  updated with the current Slack relay/consumer.mjs state (Socket Mode connects, but zero events
  deliver pending an owner-side Slack Event Subscriptions toggle). Added the "2026-07-05 next-wave
  (cycle 2)" Planned subsection (11 rows) mirrored from the live board. Full detail and the
  matching live-board corrections: `/Users/jay/apps/TRADING-EFFORT-LOG.md`.
