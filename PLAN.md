# Improvement Plan - Agentic Trading Dashboard

Eight-phase roadmap to make the dashboard genuinely autonomous, more accurate,
measurable, customizable, and easier to operate. The current codebase is treated
as partially complete; implementation should preserve working controls while
filling the missing pieces.

> 2026-06-30 (`fix/merge-pr-205` / PR #237): Alpaca shared market-data fallback —
> review-thread follow-up now lets shared/background scans use the operator's
> connected Alpaca account when a tenant has no complete Alpaca market-data
> credential, keeps REST market data off `alpaca-mcp` execution rows, prefers
> current connected operator key-only credentials before stale stored/env keys,
> and preserves FMP health logging for non-403 optional endpoint failures. Also
> ignores hidden worktree and build directories in ESLint config to prevent local
> linting errors. Trading resolution remains per-user/fail-closed.
> No roadmap change; see `docs/rollouts/2026-06-27-alpaca-key-fallback-fmp-warnings.md`
> and `docs/rollouts/2026-06-30-ci-worktree-eslint-ignores.md`.
> 2026-06-30 (`codex/notification-direct-bridge`): direct notification delivery
> now covers legacy operational events (`fill`, `block`, `pending_approval`,
> `kill_switch`, `run_failed`, `proposal_withdrawn`) through the existing
> `sendNotification(...)` choke point, while preserving the legacy
> `notification_events` feed and avoiding duplicate direct webhook posts when a
> policy webhook is configured. No roadmap change; see
> `docs/rollouts/2026-06-30-notification-direct-bridge.md`.

> 2026-06-30 (`cursor/trim-openai-strategy-options-f06c` / PR #253):
> custom model selector review fix — trimmed OpenAI options remain reachable via
> Custom because the selector now seeds an out-of-list model id, and
> `next-env.d.ts` is kept on the build-generated route-types path. No roadmap
> change; see `docs/rollouts/2026-06-29-claude-green-red-team.md`.
> 2026-06-30 (`feat/tiered-settings` / PR #252): tiered settings review fix —
> stale user-level policy fields in legacy account rows are stripped before the
> user-level overlay, so cleared fields like `redTeamLlmModel` cannot reappear
> from inactive account state. No roadmap change; see
> `docs/rollouts/2026-06-29-tiered-settings.md`.

> 2026-06-29 (`agent/antigravity`): sticky top bar & slide-over offsets —
> made the dashboard top bar sticky and offset the SlideOver components (Activity Log, etc.)
> so they slide in below the top bar instead of overlapping or rendering behind it.
> See `docs/rollouts/2026-06-29-sticky-top-bar-and-slideover-offsets.md`.
>
> 2026-06-30 (`fix/page-title` / PR #251): Congress.Trade shared contract package —
> App A/B wire types, API path constants, and Zod schemas are now imported from
> `@jaywedgeworth22/congress-trading-shared` instead of being duplicated locally.
> The package is pinned to shared commit `220677a`; CI/deploy install steps use a
> shared install helper plus read-only deploy key for npm's private git dependency.
> No roadmap change; see
> `docs/rollouts/2026-06-30-congress-trading-shared.md`.
>
> 2026-06-30 (`codex/browser-title`): browser tab title correction —
> root and welcome metadata now emit the document title `Trading Dashboard`
> exactly. No roadmap change; see
> `docs/rollouts/2026-06-30-browser-title.md`.

> 2026-06-29 (`antigravity/multi-agent-optimizations`): multi-agent optimizations —
> implemented a set of 18 system optimizations and UX improvements spanning DB indexing,
> scheduler lease locks, serial SEC 8-K crawls, cache GC sweeps, faster 10-K parsing, stop
> cancel/drift reconciliation, zero-NAV & sizer boundaries, backtest timeline fixes, WCAG AA contrast,
> responsive mobile tabs, ARIA accessible model pickers, P&L bar charts, and button standardization.
> No roadmap change; see `docs/rollouts/2026-06-29-multi-agent-system-optimizations.md`.
> 2026-06-29 (`cursor/complete-sentry-setup-8bed`, Cursor): **Sentry integration
> completed** — browser-runtime init (`instrumentation-client.ts`),
> `global-error.tsx` → `Sentry.captureException`, and the `withSentryConfig` build
> wrapper (source-map upload gated on `SENTRY_AUTH_TOKEN`) are now enabled,
> finishing the server/edge-only setup. Env-gated, redacted, `sendDefaultPii:false`;
> Session Replay opt-in. No roadmap change; see
> `docs/rollouts/2026-06-29-sentry-browser-and-build-wrapper.md`.
>
> 2026-06-29 (`cursor/claude-green-red-team-f06c`, Cursor): **Claude as a
> first-class Green/Red Team model** — `claude-*` models are now selectable for
> both the Bull proposer and Bear reviewer (not just chat), via a new
> `anthropic-messages` transport in `resolveLlmEndpoint` and a shared request
> builder (`src/lib/llm-call.ts`) that uses Anthropic forced tool-use for
> guaranteed JSON while leaving OpenAI-compatible providers unchanged. No roadmap
> change; see `docs/rollouts/2026-06-29-claude-green-red-team.md`.
>
> 2026-06-29 (`main`, Cursor): **Strategy engine improvements** — Bear debate
> now receives structured market data (technical indicators, factor breakdowns,
> smart-money signals, macro context) to independently fact-check the Bull.
> Market holiday/early-close calendar prevents runs on closed days. "Do nothing"
> threshold (`minProposalScoreThreshold`) skips the LLM when all candidates score
> below the bar. See `docs/rollouts/2026-06-29-strategy-engine-improvements.md`.
>
> 2026-06-29 (`codex/profile-menu`): profile menu and header cleanup —
> Auth.js sessions now retain display identity metadata, the dashboard snapshot
> exposes provider avatar/name/login provider, and the header consolidates
> Activity, System Help, theme toggle, and Sign Out under a profile menu with
> photo-or-initials fallback. No roadmap change; see
> `docs/rollouts/2026-06-29-profile-menu.md`.
>
> 2026-06-29 (`codex/google-auth-infisical-note`): CI runner billing unblock —
> GitHub-hosted `ubuntu-latest` jobs are failing before startup due account
> billing/spending-limit errors, so CI verify, Playwright smoke, and Security now
> target the existing self-hosted `trading-live` runner for same-repo branches/PRs
> only. No roadmap change; see
> `docs/rollouts/2026-06-29-self-hosted-ci-billing-block.md`.
> 2026-06-29 (`cursor/ci-autofix-automation-6dbc`): self-hosted gitleaks cleanup —
> Security now removes stale macOS gitleaks installer temp files before invoking
> the pinned action, preserving scan behavior while avoiding persistent-runner
> temp-file collisions. No roadmap change; see
> `docs/rollouts/2026-06-29-gitleaks-temp-cleanup.md`.
>
> 2026-06-28 (`codex/thin-boot-strip`): first-paint loader selection —
> replaced the Quiet Tiles SSR loading shell with option 4, the thin boot strip:
> a single lightweight animated strip plus one screen-reader status and the
> existing explicit failure alert. No roadmap change; see
> `docs/rollouts/2026-06-28-thin-boot-strip-loading.md`.
>
> 2026-06-28 (`codex/robinhood-mcp-discovery-auth`): Robinhood MCP OAuth discovery —
> reconnect now follows Robinhood's documented Trading MCP link first and discovers OAuth
> endpoints from the MCP auth challenge when the official MCP URL is configured. Manual
> auth/token endpoint env remains a fallback/custom-provider path. No roadmap change; see
> `docs/rollouts/2026-06-28-robinhood-mcp-oauth-discovery.md`.
>
> 2026-06-28 (`codex/proposal-dashboard-ui-fixes`): proposal/dashboard polish —
> proposal reference prices now stay tied to the decision-time market quote rather
> than below-market limit entries, fresh proposal performance chips wait 15
> minutes, approval errors refresh with broker-placement failure copy, the Market
> Scan column chooser supports ordering with `Sector` before `Sec RS` by default,
> Symbol drilldowns use a fixed identity header and keep close-only history, Macro
> header copy is aligned, and Performance Unrealized uses current positions'
> mark-to-cost P&L. No roadmap change; see
> `docs/rollouts/2026-06-28-proposal-dashboard-ui-fixes.md`.
>
> 2026-06-28 (`codex/proposal-age-alpaca-sizing`): proposal age and Alpaca sizing fixes —
> proposal cards now show age for decisions under 24 hours old, the risk settings/API
> clear hidden mutually-exclusive dollar/% caps, and Alpaca bracket orders no longer
> attempt native whole-share brackets for sub-one-share dollar amounts. This addresses
> the recent $50-$70 proposals on a ~$100k account, which were caused by a stale hidden
> `$100` max-order cap binding ahead of the visible `5% NAV` setting. No roadmap change;
> see `docs/rollouts/2026-06-28-proposal-age-alpaca-sizing.md`.
>
> 2026-06-28 (`codex/google-auth-primary`): Google auth primary —
> Cloudflare Tunnel remains supported, but Cloudflare Access headers are no longer
> trusted as app login. `AUTH_SECRET` is the fail-closed auth switch, Google/Auth.js
> sessions are the identity source, `/logout` stays inside the app, and empty
> `ALLOWED_EMAILS` allows only the primary operator/aliases. No roadmap change; see
> `docs/rollouts/2026-06-28-google-auth-primary.md`.
>
> 2026-06-28 (`codex/github-login`): GitHub login added —
> Auth.js now renders GitHub when `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` are set,
> requires a verified GitHub email via `user:email`, and maps Google/GitHub
> sign-ins with the same verified email to the same app account. No roadmap change;
> see `docs/rollouts/2026-06-28-github-login.md`.
>
> 2026-06-28 (`codex/robinhood-mcp-resource-param`): Robinhood MCP OAuth resource indicator —
> production still used the public callback and dynamic client registration, but reconnect
> continued to land on Robinhood `/oauth/error`. OAuth authorization and token requests now
> include `ROBINHOOD_MCP_RESOURCE` (defaulting to `ROBINHOOD_MCP_URL`) so the grant is bound
> to the MCP protected resource. No roadmap change; see
> `docs/rollouts/2026-06-28-robinhood-mcp-resource-indicator.md`.
>
> 2026-06-28 (`codex/quiet-tiles-loading`): first-paint dashboard loader polish —
> replaced the duplicated visible loading labels with quiet skeleton tiles,
> kept one screen-reader status plus an explicit failure alert, and updated
> app-facing metadata/welcome wording to dashboard language. No roadmap change;
> see `docs/rollouts/2026-06-28-quiet-tiles-loading.md`.
>
> 2026-06-28 (`codex/settings-connection-status`): Settings header polish —
> moved the admin-only `Connection Status` link beside `Manage Accounts`, removed
> the old bottom status card in Settings -> Connections, and made OpenAI an
> ordinary `LLM` catalog row instead of a required/special provider. No roadmap
> change; see `docs/rollouts/2026-06-28-settings-connection-status.md`.
>
> 2026-06-28 (`codex/settings-connection-status`): Help/Data Sources cleanup —
> made the Help action visibly labeled, removed temporary app-name and stale
> provider wording from Help, linked Data Sources entries to provider/API-key
> pages, and documented that Help/Data Sources copy must stay aligned with
> provider/source changes. No roadmap change; see
> `docs/rollouts/2026-06-28-help-data-sources-copy.md`.
>
> 2026-06-26 (`claude/portfolio-market-scan-ui-27azkz`): operator-driven mobile-UX + correctness pass —
> Portfolio/Readiness/header, Market Scan (icons + universe: top-N + outliers + holdings), Congress/
> Insider (future-date rejection, Congress.Trade casing, time span), System Help + Settings rework,
> Accounts/Edit-Account, 3-way banner, Hide-Test-account, shared-pool default ON, Alpaca account-mismatch
> hardening. No roadmap change; see `docs/rollouts/2026-06-26-portfolio-market-scan-ui-overhaul.md`.
>
> 2026-06-27 (`codex/account-mismatch-selector`): account-selection polish/fix —
> hidden Test now filters both Settings -> Accounts and the command-bar selector, strategy-run
> audits are scoped by `connectedAccountId` for Latest Decisions/Strategy Tuning, and selected
> Alpaca connected accounts no longer fall back to generic paper keys when stored credentials are
> missing. No roadmap change; see `docs/rollouts/2026-06-27-account-mismatch-selector.md`.
>
> 2026-06-27 (`codex/robinhood-balance-failover-audit`): Robinhood account health/fallback visibility —
> production diagnosis showed active execution on Alpaca Roth IRA while the stored Robinhood Agentic
> row lacked MCP OAuth, so balances could not refresh. Settings -> Accounts now labels that as
> `OAuth Needed` with Reconnect, cash-only Robinhood portfolio payloads parse to nonzero balances,
> and broker/data fallbacks emit throttled `recoverable_issue` Activity events. No roadmap change;
> see `docs/rollouts/2026-06-27-robinhood-balance-failover-audit.md`.
>
> 2026-06-27 (`codex/robinhood-oauth-callback-host`): Robinhood OAuth callback host fix —
> production callbacks no longer use loopback `localhost` redirect URIs when the app is
> hosted behind the Cloudflare tunnel. OAuth start remains authenticated, callback is public
> but state-bound, and callback success returns to the public site origin. No roadmap change;
> see `docs/rollouts/2026-06-27-robinhood-oauth-callback-host.md`.
>
> 2026-06-27 (`codex/readiness-oauth-needed`): account readiness hardening —
> the readiness strip and Start/Run blockers now use a server-derived
> `accountReadiness` result instead of `policy.accountNumber` alone. Broker
> OAuth health, selected-account enumeration, broker `agenticAllowed`, and
> portfolio/balance read failures can all mark Account as
> not ready while preserving stored rows for account management. No roadmap
> change; see `docs/rollouts/2026-06-27-account-readiness-broker-health.md`.
>
> 2026-06-27 (`codex/account-ui-logout-oauth`): account UI/logout OAuth hardening —
> Settings and the command-bar controls now keep the Manage Accounts path visible and
> legible, Robinhood reconnect copy is concise, Cloudflare Access logout uses the
> public app origin instead of localhost, and Robinhood OAuth callback completion
> preserves the initiating public redirect/client. No roadmap change; see
> `docs/rollouts/2026-06-27-account-ui-logout-oauth.md`.
>
> 2026-06-27 (`codex/congress-score-eval-clean`): Congress.Trade score/eval —
> added a confidence-capped, direction-aware Congress composite, strict PIT export
> evaluator, and forward evidence fields. The score remains advisory: weak/proxy-only
> analytics do not promote candidates, and real historical validation still requires
> an App A PIT export. No roadmap change; see
> `docs/rollouts/2026-06-27-congress-score-evaluation.md`.
>
> 2026-06-27 (`codex/congress-pit-readiness-gate`): App A PIT readiness contract —
> App B now fails closed on App A export envelopes with
> `validationReadiness.historicalValidationReady=false` and drops PIT rows marked
> unsafe via `pitValidity`, matching Congress.Trade PR #96. No roadmap change; see
> `docs/rollouts/2026-06-27-congress-pit-readiness-gate.md`.

## Current Status

Hosting topology: production remains `trading.jays.services` on the
`~/apps/trading-live` worktree / pm2 `trading` / port `4000`. The editable
integration checkout uses the single pre-production beta hostname
`trading-beta.jays.services` -> `~/Code/Agentic Trading` / pm2 `trading-main` /
port `4001`. Do not add a second dev/beta hostname in code, docs, Tunnel
ingress, DNS, or Access configuration.

Secrets/config topology (2026-06-25): `.env.local` is git-ignored and is **not** a
secret source (only the secret-free `.env.example` is tracked), and **Infisical is
the authoritative source of truth for secret values** — the app launches through
the Infisical runner (`npm run start:secrets`), which injects them at startup, and
`REQUIRE_SECRETS_MANAGER=1` makes prod refuse to boot off a local `.env.local`. See
`docs/secrets.md` and `docs/deployment.md` → "Configuration & secrets". (The former
GCP runner was removed — Infisical is the single path.) The box authenticates with the machine
identity's **Client ID + Client Secret** (universal auth, long-lived; the runner mints a short-lived
token each launch — a raw `INFISICAL_TOKEN` is only a fallback and the Client Secret is NOT that
token). Production cutover is scripted (`scripts/infisical-prod-cutover.sh`) and `deploy.yml`
auto-picks-up the box bootstrap; shared App-A/B secrets are pulled via an app-wins overlay
(`INFISICAL_SHARED_PROJECT_ID` + its own Client ID/Secret). This documents existing behavior; no phase
scope, timeline, or approach changed.

| # | Phase | Spec | Status |
|---|-------|------|--------|
| 1 | Autonomy loop | `docs/phase-1-autonomy-loop.md` | Mostly implemented; hardening/tests remain |
| 2 | Correctness fixes | `docs/phase-2-correctness.md` | Partially implemented; sector attribution incomplete |
| 3 | Performance tracking | `docs/phase-3-performance.md` | Partially implemented; paper portfolio projection, short/cover P&L branches, broker-backed pending-fill reconciliation, and persisted `executionMode` for proposals/snapshots/fills exist. Remaining: deeper attribution/tax reporting and broader broker-paper/live lifecycle tests |
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; Finnhub/FMP/Alpha Vantage/Yahoo enrichment and VIX macro context are wired. 2026-06-16: `fcfYield`/`debtToEquity`/`epsGrowth` now feed `valueScore`/`qualityScore` and the Market Scan table. 2026-06-16 (web-sources): fixed a real bug where the scan merge dropped those fields + `senateTrades` (extracted exhaustive `applyEnrichment`); congressional + SEC-insider overlays now populate `senateTrades`/`insiderSentiment`. 2026-06-19: optional `webull-unofficial` quote enrichment is available for read-only market fields only, disabled by default and never used for execution/fills. 2026-06-19: quote-source attribution now derives broker providers (`alpaca-quotes`, `robinhood-quotes`), OHLC cache sharing is explicit, shared history fills can fulfill pending misses, and Massive grouped daily VWAP can enrich scan rows when available. 2026-06-23: quote-resolvable custom Additional Watchlist symbols missing from the Nasdaq screener are carried into Market Scan via Yahoo quote-only rows, with concrete warnings when a custom ticker cannot be priced; broad dynamic base universes now include S&P 100/OEF, Russell 2000/IWM, Nasdaq Composite, NYSE Composite, and an FT Wilshire 5000 free-screener proxy, then rank down before enrichment/LLM prompting; the candidate cap and below-cutoff outlier reserve are per-user policy settings instead of env-only defaults. 2026-06-24: MCP/provider evaluation documented; direct APIs remain the production hot path, while MCP is recommended for provider research, field exploration, and trial benchmarking only unless normalized through the cache/provenance layer. |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Partially implemented; dashboard charts, market-scan columns, activity feed, kill-switch confirmation, actionable scan empty states, readable activity summaries, custom ticker validation, and visible runtime/render error surfaces are live |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Partially implemented; profiles, risk controls, webhook settings, multi-channel direct delivery, and legacy-event direct-delivery bridge exist; notification polish remains |
| 7 | AI strategy learning loop | `docs/phase-7-strategy.md` | In progress; trade-thesis metadata, red-team debate hook, and learning-loop scaffolding exist. Outcome-aware thesis/regime/sector scorecards, Bayesian shrinkage, `candidates_considered`, `signal_snapshot`, chosen+skipped EvidenceDigest, signal-efficacy, confidence-calibration, durable skipped-name counterfactual materialization, and a 20-lot tuner gate are live. 2026-06-23: broker-paper scorecards/tuning/post-mortem now read the paper bucket with explicit `executionMode` instead of live/Test heuristics. 2026-06-25 correction: persisted MAE/MFE per closed lot (post-mortem `upsertFillExcursionsByKey`), the tuner's consumption of materialized missed opportunities, and true candidate-vs-baseline OOS validation for proposed scoring weights are all LIVE — the OOS gate now also surfaces a "not out-of-sample validated" caution when it cannot evaluate. Remaining: richer per-document digests and more tests around red-team fallback behavior. |
| 8 | Cockpit UI and Strategy Studio | `docs/phase-8-cockpit-ui.md` | Cockpit shell, tabs, Strategy Studio, and strategy tuning API are live. 2026-06-16: full redesign on branch `ui-redesign` — Tailwind 4 + Recharts + Motion, dark/light themes, command bar + Portfolio rail + tabbed workspace, slide-over feeds, modal settings, learning-loop charts. 2026-06-19/20: first-run setup state, Test/Paper/Brokerage legibility, mobile scroll recovery, compact mobile portfolio summary, grouped Operate universe controls with a one-time S&P 500 default migration, Smart Money ticker drawer fallback, and a persisted ticker-logo display preference are live. 2026-06-23: Strategy Studio owns editable Green/Red Team model choices, Run once works as a stopped-system manual proposal check, workspace/feed tabs persist across browser refresh, Macro/Market Scan hover text and title-case headings were expanded, provider/API errors are translated to plain English, the mode banner can be compacted but not hidden, a readiness strip is visible, live approval requires typed server confirmation, Settings base-index buttons support S&P/Nasdaq mutually-exclusive families plus broad dynamic universe counts, Market Scan exposes a direct gauge shortcut to Settings -> Data for candidate cap/outlier reserve controls, and the Accounts list stacks/actions better on mobile after desktop/tablet/mobile screenshot QA. 2026-06-24: shared ticker buttons now give Macro movers/news tickers the same hover/click drilldown behavior as Market Scan. 2026-06-27: unauthenticated Robinhood MCP rows show `OAuth Needed`/Reconnect rather than plain Connected, recoverable broker fallbacks render as Activity diagnostics, and the Account readiness strip/Start/Run blockers now fail closed when broker OAuth, credentials, selected-account availability, agentic eligibility, or balance/portfolio reads are broken. Remaining: replace browser prompt with a richer in-app confirmation modal and broaden mobile/keyboard e2e coverage |
| 9 | Backend web sources (scraped signals) | `docs/phase-9-web-sources.md` | 2026-06-16/17 (branch `web-sources`): `src/lib/web-sources/` reads no-free-API signals server-side — Senate eFD + Capitol Trades **congressional trades**, **SEC EDGAR Form 4** insider, and **FINRA daily short-volume** — with polite cached fetch, persistent daily refresh, scheduler hook, event candidate union, source attribution, scan/prompt/UI wiring, and a never-fabricate guarantee. Also: fixed the dropped-enrichment-field bug, plumbed technical/risk fields, `signal_snapshot` audit, thesis×regime + signal-efficacy + confidence-calibration learning, 20-lot gate, edge-aware sizing. Follow-ups now tracked in Phase 10 |
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K bulletins with item-label enrichment, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, Congress.Trade confidence-capped composite + PIT export evaluator with App A `validationReadiness` / `pitValidity` fail-closed gates, technical signals, keyed OHLC cascade, batched Voyage/Pinecone RAG scaffold with paced/capped 8-K ingestion, 2026-06-20 tenant-safe RAG metadata/filter/backoff hardening with raw-user credential lookup preservation, symbol drilldown with 0-100 signal thresholds, price chart with VWAP overlay, Market Scan `vs VWAP`, first-pass prompt compaction, factor-bucket scorecards, current-scan skipped counterfactual summaries, durable/mature-horizon skipped-name counterfactual rows, configurable red-team conviction threshold, and an optional de-risk-in-crisis opening-exposure cap are live. Remaining: real App A PIT export validation once App A marks `historicalValidationReady=true`, broader adaptive prompt compaction/cache layout, production-grade filing/news digests, analyst/earnings revisions, SEC XBRL facts, post-mortem/tuning use of missed-opportunity rows, full learning-matrix UI, and broader scoring-threshold settings. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, route Alpaca through the active connected account, sync Robinhood through MCP OAuth/status instead of manual keys, support Alpaca MCP client connections alongside REST, keep account connection buttons persistent in UI for multi-broker setups, derive Alpaca paper vs brokerage environment dynamically via account number `PA...` or API key `PK...`, enforce required account numbers for Alpaca, preserve user-entered Alpaca account labels in the Accounts list while showing Paper/Brokerage as environment metadata, derive execution state as Test vs Paper vs Brokerage, present supported account connect buttons in Accounts, keep Paper accounts optional and user-selected, expose a hardened Robinhood MCP HTTP/SSE transport plus `/api/broker/mcp/health`, use that health check to distinguish stored Robinhood rows from authenticated MCP sessions (`OAuth Needed` + Reconnect), expose server-side `accountReadiness` so broker visibility/backfill cannot masquerade as selected-account usability, ship Settings → Connections for provider keys and connection status, let users choose separate Green Team and Red Team OpenAI/xAI models in Strategy Studio with Green fallback, route major provider/LLM calls through `resolveApiKey(service,userId)`, scope strategy locks, paper projections, learning scorecards, tax reads, notifications, reflections, dashboard callbacks, and prompt cache keys by user, route high-impact API handlers through verified middleware identity via `resolveRequestUser`, explicitly share public/env-key market data while keeping user-keyed history private by default, track pending public OHLC misses so later shared fills can refresh prior requesters without spending another user's key, and add Infisical wrappers, local Gitleaks scanning, Sentry runtime hooks, redacted Langfuse LLM traces, npm Dependabot, Litestream scripts, and Playwright smoke tests. 2026-06-24: direct Alpaca Add Account no longer shows the endpoint explainer, live default endpoint is `https://api.alpaca.markets` while Paper remains `https://paper-api.alpaca.markets/v2`, and Alpaca account-type parsing is best-effort from broker-returned account subtype fields. 2026-06-27: broker/data fallbacks in the account dashboard path now emit throttled `recoverable_issue` audit events. 2026-06-28: site auth now relies on Auth.js Google sessions instead of Cloudflare Access headers; `AUTH_SECRET` arms fail-closed auth, `/logout` redirects to app `/login`, and empty `ALLOWED_EMAILS` allows only primary operator aliases. GitHub CI/e2e/security workflows are deferred until push credentials include `workflow` scope. M3 complete (2026-06-21): per-user policy/profiles/prompt/tuning fully scoped; global settings seeds removed; one-time migration to copy legacy global rows to 'local' user; DELETE /api/profiles/[id] route added; two-user isolation verified by test/per-user-policy-isolation.test.ts. M6 real identity/auth is implemented with Auth.js Google fail-closed middleware, request-scoped SSR snapshots, `/login`, `/logout`, and visible signed-in/Sign out UI. M7 account deletion is implemented with preview/prepare/final-delete API, multi-step Settings -> Data UI, broker/Google/Apple limitations, in-flight trading blockers, per-user OAuth/token cleanup, and hashed deletion audit. Remaining: complete data isolation audit for any newer fills/snapshots/proposals/learning tables and add provider-account-id identity mapping before Apple private-relay identities become first-class. |
| 12 | Architecture Blueprint | docs/architecture-blueprint.md | Completed 2026-06-20: Blueprint R1–R5 requirements (tri-state execution safety, trailing stop-loss engine, IRA taxation policy settings, multi-tenant RAG & rate limits, prompt compaction & reasoning) are fully implemented, tested, and verified. |

## Integrations (outside the phase roadmap)

- **congress.trade data-share — push** (2026-06-22, `docs/congress-trade-share.md`):
  outbound, default-OFF forwarding of this app's company refs + daily closes +
  the `^GSPC` series to `congress.trade` (App A)'s idempotent import endpoint, so
  the *shared* daily FMP quota is spent once. After-scan refs hook + once-per-day
  nightly `prices`/`spx` batch + an admin trigger route. Gated on
  `CONGRESS_TRADE_TOKEN` + `CONGRESS_SHARE_ENABLED`; token is server-only. As of
  2026-06-30, the outbound payload types, API path constants, and runtime schema
  checks come from `@jaywedgeworth22/congress-trading-shared`.
- **congress.trade — receive/consume** (2026-06-22, `docs/congress-trade-consume.md`,
  contract `docs/push-to-app-b.md`): default-OFF cache-aside reads of App A's
  `/api/market/*` (history first tier), App A as the congressional source via
  `/api/transactions` (token-gated), and a push receiver (webhook + SSE) feeding the
  scan's web-signal overlay. Shared transaction/event contracts now come from
  `@jaywedgeworth22/congress-trading-shared`. Inert until App A's read endpoints are live.
  Round 3 (pending App A slots): push `volume`+`insider`+`shortVolume` on the nightly batch.
- **congress.trade — return-path + analytics ownership reply** (2026-06-24,
  `docs/congress-trade-app-b-reply.md`): accepted App A's analytics ownership split
  (they own congressional-trade analytics, App B owns market/price analytics) with a
  **pull/pull** transport (no aggregate pushing either way); specified the inbound
  return-path contract App A is waiting on. Both follow-up PRs are now **BUILT**
  (additive + default-OFF):
  (1) `feat/securities-import-receiver` — `POST /api/admin/securities/import`
  (bearer `APP_B_INGEST_TOKEN`, default-closed) + a local EOD cache
  (`imported_*` tables, `db-securities-import.ts`) wired as an opt-in, density-guarded
  `fetchDailyOHLC` tier, to land App A's price/spx/ref gap-fills — **BUILT 2026-06-25**
  (`docs/rollouts/2026-06-25-app-b-securities-import-fundamentals-price-targets.md`).
  (2) `congress-share.ts` `fundamentals[]`/`analyst[]` push for App A's PR #46 slots —
  built earlier via `marketQuoteToFundamentals`/`marketQuoteToAnalyst` (sourced from the
  scan's `MarketQuote`, gated `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`). Numeric price targets,
  previously null, are now ALSO fillable via the opt-in FMP `price-target-consensus` provider
  (`FMP_PRICE_TARGETS_ENABLED`) — **BUILT 2026-06-25**; they thread through the enrichment
  surface onto the quote and into `marketQuoteToAnalyst`.
  (3) **Fundamentals/analyst read-back tier** — App A now exposes
  `GET /api/market/fundamentals|analyst/:ticker` (the donated tables finally have readers);
  App B reads them via `getAppAFundamentals`/`getAppAAnalyst` + a
  `CongressTradeEnrichmentProvider` seated ahead of the paid fundamentals providers, gated by its OWN
  `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (separate from the price-read `CONGRESS_TRADE_READS_ENABLED`), with a
  `CONGRESS_TRADE_MAX_STALE_DAYS` freshness cap and `NEWS_CACHE_TTL_MS` caching
  — **BUILT 2026-06-25** (`docs/congress-trade-consume.md` §1b,
  `docs/rollouts/2026-06-25-crossapp-consumer-reads.md`). Paid-call elimination is an **opt-in coverage
  hint** (`ENRICHMENT_SHORT_CIRCUIT_ENABLED`): the cascade hands paid providers a per-symbol set of the
  fields App A already covers (+ the analyst source) so they skip only the redundant SUB-calls (e.g. FMP's
  ratios-ttm / grades-consensus / price-target calls) while still fetching their unique fields
  (insider/senate); no whole provider is skipped → no field lost; default OFF. App A reads are merged
  across all fresh rows, freshness-gated by the data `date`, and negative-cached 1h (transport errors are
  NOT cached). A→B push wired (`APP_B_IMPORT_URL`+`APP_B_INGEST_TOKEN` on App A; App B needs the same token
  + `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`).
- **congress.trade — App A handoff: new analytics endpoints + adjusted-close fix** (2026-06-25,
  `docs/rollouts/2026-06-25-app-a-handoff-integration.md`): consumes three new App A endpoints
  now live/merging (App A PRs #77/#79/#80): `GET /api/analytics/conviction` (composite 0–100
  conviction score, gated by `CONGRESS_ANALYTICS_ENABLED`), `GET /api/analytics/ticker/{T}/backtest`
  (per-ticker post-buy return stats, on-demand), and `GET /api/analytics/conflicts` (committee
  conflict-of-interest disclosures). Conviction + conflictCount wired into the daily
  `refreshCongressAnalytics` parallel fetch and the `CongressAnalytics` overlay. Yahoo adjusted-close
  fix: `fetchYahoo` now prefers `indicators.adjclose` (split+dividend-adjusted) over raw close for
  correct multi-year returns pushed to App A. **2026-06-26 update:** conviction + conflict bulletins
  now emitted in `web-sources/index.ts`; `congressAnalyticsScore` gates on `convictionDirection=BUY`
  and adds a `convictionBoost` so conviction-only tickers reach the scan candidate set. **Deferred:**
  ticker-change/delisting map (App A priority #3); bulk-snapshot bootstrap; congress-share bypass
  for adjusted-close when CONGRESS_TRADE_READS_ENABLED tier precedes Yahoo.

## Build Order

1. Phase 1 hardening: scheduler starts once, run lock works, market-hours state is visible.
2. Phase 2 correctness: estimated notional is authoritative and sector attribution covers all scan rows.
3. Phase 3 performance: snapshots, fills, Test vs broker-routed P&L, and run attribution.
4. Phase 4 data/scoring: provider abstraction, quote enrichment, TTL cache, factor scores.
5. Phase 5 dashboard: typed components, charts, visible loading/error states, better universe/watchlist UX.
6. Phase 6 customization: profiles, deterministic risk rules, webhook notifications.
7. Phase 7 strategy loop: persist learning metrics, harden red-team debate fallback, and keep short/cover disabled for Live until broker/accounting behavior is proven.
8. Phase 8 cockpit UX: harden strategy tuning tests, polish pane density, and add persisted tuning history if audit needs justify it.

## Acceptance Checks

- Required handoff verification: `npx tsc --noEmit`, `npm test`, then
  `npm run build`. GitHub Actions CI (`verify` workflow at `.github/workflows/ci.yml`)
  mirrors this sequence and is live — PRs cannot merge until `verify` goes green.
  The security, e2e, and deploy workflows remain in `ci-pending/` (require additional
  credentials / environment setup before they can be promoted to `.github/workflows/`).
- The strategy can run autonomously while enabled, without opening the dashboard.
- `strategy_run` audit events are written inside `runStrategyOnce()` and only once per executed run.
- Daily limits count reviewed `estimated_notional`, including share-quantity market orders.
- Held positions can be attributed to sectors even when they are not top scan candidates.
- Performance summaries separate live and paper results.
- Scan candidates expose provider freshness, factor score breakdowns, and bid/ask data when available.
- Dashboard shows market session, scheduler state, performance charts, active profile, risk settings, and notification status.
- Desktop dashboard fits in one viewport with internal pane scrolling and tabbed workspaces.
- Mobile and tablet layouts use normal page scrolling with the fixed cockpit
  shell reserved for desktop widths.
- Strategy tuning proposals are review-only until the user explicitly applies them.
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
- Error/LLM observability stays opt-in and redacted by default for account, prompt, and credential data.
- The local SQLite database has a documented Litestream replicate/restore path before production reliance.
- Production and beta hosting stay separated: production on `trading.jays.services`
  / port `4000`; integration beta on `trading-beta.jays.services` / port `4001`;
  no duplicate dev/beta hostname.
- Agent branch landing requires a clean worktree and refuses stale semantic overlap
  when the branch and `origin/main` both changed the same files since divergence.
- Root-level manual probe artifacts such as screenshots, one-off UI scripts, and
  accidental shell-output files stay ignored so the integration worktree remains
  reserved for review and merges.
