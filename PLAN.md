# Improvement Plan - Socratic Trade

Eight-phase roadmap to make the dashboard genuinely autonomous, more accurate,
measurable, customizable, and easier to operate. The current codebase is treated
as partially complete; implementation should preserve working controls while
filling the missing pieces.

> 2026-07-03 (`claude/washsale-advisory-defaults`, Claude): **Wash-sale gate defaults flipped to
> non-blocking** — owner decision: `taxSettings.washSaleHandling` default `"block"` → `"auto"`,
> `taxSettings.iraWashSaleHandling` default `"block"` → `"disregard"`. Mid-task correction: "auto"
> no longer vetoes on a deterministic edge-vs-tax-cost threshold at all (that math re-arithmetized
> the LLM's own confidence/target outputs); it always proceeds, with the priced tax cost surfaced
> as receipt telemetry + strategist-prompt context instead. `block`/`ask` remain valid opt-ins; all
> receipt/annotation/audit machinery unchanged. No roadmap scope change — a guardrail-philosophy
> correction, part of "nothing is hard except the account" (see
> `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md` on branch
> `claude/correct-drawdown-decision`). Landing deferred until the holiday-date test fix merges. See
> `docs/rollouts/2026-07-03-washsale-advisory-defaults.md`.
> 2026-07-03 (`claude/console-small-fixes`, Claude): **Console small fixes (t7/t18/t22/t39)** —
> four small verified-open items, no roadmap scope change: extracted the "0."-collapse raw-while-
> focused/commit-on-blur numeric-input pattern into a reusable `RawNumInput` (applied at the
> scoring-weight, tax-rate, and market-scan-shape inputs); exported `MARKET_REGIME_LABELS` from
> `src/lib/macro.ts` as an explicit persisted contract with dedicated exact-string test coverage;
> the account-deletion scope preview now warns when pending learned-context items would be
> discarded; and a `notify.bridge.error` ops-feed formatter humanizes notification-delivery
> failures. Pushed but landing deferred until the holiday-time-dependence test fix merges. See
> `docs/rollouts/2026-07-03-console-small-fixes.md`.
> **2026-07-03 — SUPERSEDING DIRECTIVE (owner): real trading, no fake modes.** This is a real
> trading app; the owner accepts 100% risk. **`policy.paperMode` and the local "Test mode" simulator
> (`test/local`, `usesLocalSimulation`, `getPaperPortfolioProjection`) have been removed** (rules in
> `AGENTS.md`; code removal landed — see `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`
> Step 2). An account is an account — its `environment` decides paper vs live; no connected account
> means the app can't place orders (no local-sim fallback). **Any older paper/Test-default language
> below this line is STALE** and does not describe target behavior —
> do not follow it. See `docs/EFFORT-LOG.md` +
> `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`.

> **2026-07-04 - Codex console/UI swimlane.** Branch `codex/console-ui-swimlane` executes the sync-21
> console assignment without using the sovereign review branch: approval receipt provenance
> (served model/failover, red-team trigger, sizing inputs, R:R geometry, linked citations), mobile
> LIVE phrase-gate parity, Sheet focus trap, read-only `/console/decisions/[id]` trace inspector with
> coach notes/framework `ownerResponse`, high-signal ticker drawer affordances, and Strategy custom
> model select parity. No roadmap scope change; this hardens the existing Autonomy Desk/console
> parity track. See `docs/rollouts/2026-07-04-console-ui-swimlane.md`.

> **2026-07-03 - Socratic admin/RAG/settings parity pass (Codex).** The
> branch `codex/live-thesis-portfolio-framing` is the current broad follow-up
> for owner feedback after the Socratic UI launch: Pinecone index default
> `socratic-trade`, RAG ingest brakes, admin RAG/connection-health visibility,
> user/admin LLM usage split, `/old`, Auth.js legacy-host canonicalization for
> Google/GitHub redirects, right-side ticker drawer coverage, market-thesis
> framing on Home, Coach-page reframing, provider-specific model
> reasoning/thinking controls, lock/unlock authority language, and the first
> absolute-vs-percent mode switches. The remaining parity/open-item list is now
> tracked at `docs/reviews/2026-07-03-console-parity-open-items.md`. See
> `docs/rollouts/2026-07-03-socratic-admin-rag-settings-parity.md`.

> **2026-07-03 - AI Review inheritance, model catalog, and text-box fonts (Codex).**
> Account review does not have a separate account-level model. In Strategy -> AI Review,
> leaving the reviewer model blank now inherits Red Team when configured, otherwise Green Team.
> The UI no longer uses the old account-fallback label, and `/api/strategy/tune` trims empty
> model overrides before `proposeStrategyTuning` resolves the actual team model. The console
> now defaults editable text boxes to the site font, adds browser-local Site/System/Serif/Mono
> text-box font choices under Settings -> Appearance, refreshes current Gemini/Mistral/xAI/
> DeepSeek curated model choices, and wires DeepSeek V4 Thinking Mode. See
> `docs/rollouts/2026-07-03-ai-review-model-inheritance.md`.

> **2026-07-04 - RAG Sentry visibility + Pinecone hosted-model review (Codex).**
> The active branch `codex/rag-sentry-visibility` follows PR #351 and adds Sentry incident visibility
> for RAG provider failures, missing keys, Pinecone metric checks, ingest/WU budget trips, malformed
> embeddings, retrieval degradations, and unexpected RAG catch-block failures. It also documents why
> Pinecone-hosted `llama-text-embed-v2` / `multilingual-e5-large` should be benchmarked before any
> production migration.

> **2026-07-04 - Test Account + usage-limit email alerts (Codex).**
> Branch `codex/restore-test-account-option` restores an explicit local mock paper account option
> labeled `Test Account - Local Mock Paper Account`. It is addable for simulation/learning trades but
> is never default-created or default-selected. The same branch adds a shared usage-limit alert path:
> Pinecone daily Write Unit fuse trips, RAG ingest text caps, provider rate/quota/billing failures,
> and API Usage Monitor provider budget warnings now produce `budget_alert` notifications and try
> email-capable delivery. Treat the 50k/day Pinecone WU fuse as a runaway-write guard: normal
> incremental single-trader use should not hit it; if it does, inspect deduping/chunking/cadence
> before raising the cap.

> **2026-07-04 - RAG filing ingest smoke + deterministic vector ids (Codex).**
> Branch `codex/rag-filing-ingest-smoke-fix` verified production writes/searches the new
> `socratic-trade` Pinecone index by ingesting one MSFT 10-Q. The successful state is 95 vectors,
> 95 local `document_chunks`, and accession `0001193125-26-191507` recorded in
> `ingested_accessions`. The smoke surfaced a retry-safety bug: SEC filings without deterministic
> `doc_id` values generated UUID-based vector ids, so a timed-out partial ingest could leave duplicate
> vectors on retry. SEC filing ingestion now passes `ticker:accession:docType` as `doc_id`; preserve
> that invariant before any larger RAG backfill.

> **2026-07-04 - RAG quick-wins Wave-1 lane: wire dormant stages (Claude).**
> Branch `claude/w1-rag-quickwins` (one of four Wave-1 quick-win lanes off the 2026-07-04 composite
> expert review, section C). Wired `retrieveContextDetailed`'s already-built-but-never-called
> `minRelevanceScore`/`dedupeSimilarity` into both real call sites (`strategy.ts`,
> `chat/orchestrator.ts`); added `formatChunkWithProvenance()` so `strategy.ts` prefixes each
> retrieved chunk with a `[doc_type · section · symbol · date · rel N.NN]` header before joining
> into the prompt (chunk ids were already stable/real, left unchanged); confirmed
> `VECTOR_STORECONTEXTS_DEDUP` was already default-on from an earlier commit (the source review's
> "default OFF" was stale) and widened `hashContent` from 64-bit to 128-bit; stamped
> `embed_model`/`embed_rev` on every new vector in `cleanMetadata`; raised the rerank-path
> over-fetch cap to an env-tunable 150 (`VECTOR_RERANK_OVERFETCH_K`), non-rerank paths unchanged.
> All five items are env-tunable/opt-in-consistent, no hard gates. Verify green: lint 0 errors, tsc
> clean, 2388/2388 tests, build green. See `docs/rollouts/2026-07-04-rag-quickwins-wiring.md`.

> **2026-07-03 - Console polish + RAG quota/usage safeguards (Codex).**
> Branch `codex/console-actions-evidence-live` merged as PR #351. It extended the Socratic console polish pass and
> adds RAG quota protections before fresh Pinecone keys are connected: app-recorded RAG usage is labeled
> separately from provider totals, Pinecone query rows record Read Units when available, upsert rows
> record estimated Write Units, `storeContexts` enforces a daily Pinecone WU fuse before Voyage
> embedding, and docs now capture the recommended Voyage/Pinecone stack plus the earnings-report
> ingestion/summarization design. See `docs/reviews/2026-07-03-rag-stack-options.md` and
> `docs/design/earnings-rag.md`.

> **2026-07-03 — Socratic Trade autonomy UI/runtime implementation (Codex).** The branch
> `codex/socratic-trade-autonomy-mockup` reframes the product as an Autonomy Desk:
> live thesis, delegated actions, evidence/RAG contribution, dissent, outcome learning,
> coaching, and agent-authored framework-improvement proposals. Backing persistence now
> exists for Socratic decision cases and framework proposals; the strategy loop records
> proposed/placed/blocked/refused decisions, captures RAG attribution, accepts owner
> coaching notes, indexes each strategy-recorded decision as private institutional-memory
> RAG, and applies explicit Socratic override semantics for owner preference gates while
> preserving hard broker/account/integrity/tax refusals. Public `/welcome`, `/how-it-works`,
> and the coded `/design/socratic-trade` product overview now route by default and advertise
> `socratictrade.com` in sitemap/robots metadata. See
> `docs/rollouts/2026-07-03-socratic-autonomy-ui.md`.

> **2026-07-03 — Run-state UX correction (Codex).** The console header no
> longer hides Start/Resume behind a red STOP affordance. `RunStateButton`
> renders Start when halted, Resume when close-only, and STOP only when the
> strategy is active or winding down. The control sheet now leads with
> Start/Resume in paused states, keeps STOP/Wind down red, and uses primary/green
> tones for starting flows; the legacy autonomous-execution confirm was also
> changed from danger to primary. See
> `docs/rollouts/2026-07-03-run-state-ux.md`.

> **2026-07-03 - IRA wash-sale UI correction (Codex).** The settings and
> guardrails UI now make the IRA distinction explicit: same-account IRA wash
> sales are ignored/not applicable, so Roth/traditional IRA accounts no longer
> surface the taxable-account Block / Ask / Auto selector as the relevant
> control. The only IRA wash-sale choice shown is the existing cross-account
> taxable-loss replacement-buy setting (`taxSettings.iraWashSaleHandling`):
> block by default, or explicitly ignore/disregard with the audit annotation.
> Search/glossary copy now routes "Roth wash sale ignore" language to that IRA
> control. See `docs/rollouts/2026-07-03-ira-washsale-ui.md`.

> **2026-07-03 - Console universe index exclusivity fix (Codex).** The
> `/console/guardrails` Base indices checkboxes now call the same
> `toggleIncludedIndex` helper used by the original app and API normalizer, so
> mutually-exclusive full-overlap families replace their peer immediately:
> S&P 100 <-> S&P 500 and Nasdaq 100 <-> Nasdaq Composite. See
> `docs/rollouts/2026-07-03-universe-index-exclusivity.md`.

> **2026-07-03 - Sell to Fund Buys title-case copy fix (Codex).** The
> Guardrails Sell to Fund Buys selector and legacy dashboard Key Parameters
> selector now render the field label, option labels, and save-review summary
> in app-style Title Case while preserving the stored lowercase enum values.
> See `docs/rollouts/2026-07-03-sell-to-fund-title-case.md`.

> 2026-07-02 (`claude/strategy-attribution-macro-honesty`, Claude): **Per-proposal model
> attribution + macro placeholder honesty** — proposals now persist the failover-aware served
> model (`TradeProposal.proposedByModel` + `redTeamVerdict.model`; approval card reads
> persisted-first), and the no-FRED macro fallbacks blank every FRED field to "" instead of
> DEFAULT_MACRO placeholder constants (`pruneMacro` drops blanks from the prompt; the fabricated
> inverted curve no longer distorts `determineMarketRegime`). No roadmap scope change — two
> money-path-adjacent hardening follow-ups. See
> `docs/rollouts/2026-07-02-attribution-macro-honesty.md`.
> 2026-07-02 (`claude/console-data-followups`, Claude): **Console data follow-ups** —
> four small verified-open items, no scope change: broker order mappers now carry
> limit/stop/TIF into `EquityOrder` and `/console/orders` renders them (with a
> limit-vs-scan-price gap); the snapshot's congress cap keeps the most-recently
> DISCLOSED trades; `MarketQuoteSummary` carries the five factor fields so drilldown
> factor bars work beyond topCandidates; and Turbopack `next dev` is unbroken via
> `@source not "../docs";`. See `docs/rollouts/2026-07-02-console-data-followups.md`.
> 2026-07-02 (`claude/chat-idempotency`, Claude): **Chat retry idempotency** —
> `POST /api/chat` accepts an optional per-send `clientTurnId` (<=64 chars); the
> orchestrator dedupes the user-turn append on it (but still answers), so a client
> Retry no longer duplicates the prompt in the saved transcript. `chat_turns` gains a
> nullable `client_turn_id` (migration v10); both chat clients send a UUID per message
> and `/console/assistant` reuses it on Retry (its "history will show this twice"
> probe/toast is deleted). No roadmap scope change — hardening of the existing chat
> rail. See `docs/rollouts/2026-07-02-chat-idempotency.md`.
> 2026-07-02 (`claude/console-macro`, Claude): **Console parity port, Wave 2 —
> `/console/macro`** — the macro / market-regime board destination is built (new files
> only: `app/console/macro/{page.tsx,indicators.ts,trends.tsx}`), completing one of the
> four Wave-2 routes the foundation nav scaffolded. Legacy `app/ui/macro-panel.tsx`
> parity plus: hero regime card (meaning, classifier inputs, per-regime realized
> scorecard, how-the-strategist-uses-it), per-indicator plain-language explanations
> with dynamic banded readings, honest blanking of unsourced FRED placeholders, and
> the tooltips-everywhere/row-hover UX standard. Remaining Wave-2 routes
> (`/console/scan`, `/console/orders`, `/console/assistant`) are owned by parallel
> agents. See `docs/rollouts/2026-07-02-console-macro.md`.
> 2026-07-02 (`claude/ira-washsale-disregard`, Claude): **IRA wash-sale disregard setting** —
> owner-requested: the Rev. Rul. 2008-5 IRA hard block is now the DEFAULT of per-account
> `taxSettings.iraWashSaleHandling` ("block" default / "disregard" = proceed annotated with the
> verbatim "Wash Sale (Technically, but IRA purchase unreported to IRS)" note, audited via
> `wash_sale_ira_disregarded`, rendered on the approvals card + Activity). block->disregard is
> LOOSER (typed word on LIVE). Extends the tax-guardrail track; taxable-buyer machinery
> untouched. See `docs/rollouts/2026-07-02-ira-washsale-disregard.md`.
> 2026-07-02 (`claude/console-scan`, Claude): **Console parity-port Wave 2 — Scan
> destination** — `/console/scan` now exists (the Wave-1 nav link is live): a sortable
> Market Scan table over the latest scan's candidates with tooltips + per-field
> provenance from `EnrichmentSources`, the P/E `n/a`-vs-`—` convention, a sticky symbol
> column for mobile, an honest freshness model (newest of page-refreshed `GET /api/scan`
> vs the last strategy run's captured scan), and a Smart Money tab (congress + insider
> feeds with source metadata). New files only, all under `app/console/scan/`. No roadmap
> scope change — one of the four Wave-2 destinations delivered (macro/orders/assistant
> owned by parallel agents). See `docs/rollouts/2026-07-02-console-scan.md`.
> 2026-07-02 (`claude/console-assistant`, Claude): **/console Assistant destination** —
> ported the legacy AI Assistant chat into the console as `/console/assistant`
> (new files only under `app/console/assistant/`; parallel console-port lane).
> Chat + persisted transcript, grouped model picker with per-provider key gating,
> and an improved draft→approval handoff: drafts auto-run the policy dry-run
> preview and stage into the existing Approvals rail instead of an in-chat
> approve/reject. No roadmap scope change — part of the console feature-parity
> track. See `docs/rollouts/2026-07-02-console-assistant.md`.
> 2026-07-02 (`claude/washsale-modes-escalation`, Claude): **Wash-sale handling modes +
> Decide-mode escalation** — owner-locked spec. Account-scoped
> `taxSettings.washSaleHandling` (block default / ask = priced pending-approval card in
> both authorities / auto = deterministic edge >= 3x tax-cost guard, logged, never
> silent); IRA-replacement rebuys hard-blocked in every mode (Rev. Rul. 2008-5); narrow
> escalation framework routing ask-mode wash sales + time-context gate failures
> (daily/hourly notional, order cap, quote staleness; Decide only) to pending cards that
> RE-RUN the full gate at approval via a server-stored override token (wash-sale gate
> only — no client-settable bypass). Guardrails Tax rules select (LOOSER classification
> on block->ask/auto). No roadmap scope change — extends the tax-guardrail track. See
> `docs/rollouts/2026-07-02-washsale-modes-escalation.md`.
> 2026-07-02 (`claude/console-drilldown-plus`, Claude): **Console symbol drilldown,
> Wave 2** — the console company drawer is now a strict superset of the legacy
> `app/ui/symbol-drilldown.tsx` drawer: full parity (11 derived-metric tiles reusing
> `src/lib/derived-metrics`, 7-factor breakdown, legacy-threshold signal summary,
> evidence/headlines, per-field provenance) PLUS account exposure (position P&L,
> pending proposals → Approvals, recent orders), analyst rating distribution +
> price-target range bar, signal/earnings-proximity chips, and a collapsible deep-
> fundamentals table — tooltips on everything, light+dark, honest empty states, and
> unchanged `SymbolButton`/`SymbolDrilldownSheet` APIs for the parallel Wave-2 agents
> (extended with one OPTIONAL `quote?: MarketQuote` override so screens rendering
> freshly fetched /api/scan rows — the Scan lane, per the Codex finding on #327 — can
> make the drilldown match the row instead of the snapshot's last run).
> No roadmap scope change — a Wave-2 deliverable of the Console parity-port track.
> See `docs/rollouts/2026-07-02-console-drilldown-plus.md`.
> 2026-07-02 (`claude/console-learned-context`, Claude): **Learned-context approval
> inbox ported to /console** — the legacy "Pending Learned Changes" queue now lives on
> `/console/approvals` as a Learned context section (own data source; approve/reject
> with optimistic UI, confirm sheet showing the exact AI-LEARNED block with the honest
> approval-date stamp, full provenance + tooltips + row hover per the owner's new UX
> standard). Console feature-parity track only — no roadmap scope change. Follow-ups:
> sharing prefs in Settings, nav/needs-attention count. See
> `docs/rollouts/2026-07-02-console-learned-context.md`.
> 2026-07-02 (`claude/console-parity-tail`, Claude): **Console parity tail** — the
> closing lane of the parallel legacy→console port: Run-once blocked-reason routing
> (why + one-click route to the fix), chrome sign-out with signed-in identity,
> allocation bars on Home (position/sector lenses), a new `/console/watchlist`
> destination with price alerts (existing /api/watchlist + /api/alerts), the blocking
> shared-data-pool consent gate ported un-weakened into the console shell, a Data
> sharing settings card (pool consent + learned-context include/contribute flags),
> a DANGER account-deletion flow mirroring the server's gates, admin-only OPERATOR
> links in Settings, and pending learned-context items folded into the single red
> Approvals badge. Owner-skipped: ⌘K palette, Strategy Flow visualizer. Console track
> only — no roadmap scope change. See `docs/rollouts/2026-07-02-console-parity-tail.md`.
> 2026-07-02 (`claude/console-orders`, Claude): **Console Wave 2 — Orders destination**
> — `/console/orders` implemented (one of the parallel Wave-2 lanes on the #321
> foundation): open working orders for the active account with stale-limit detection
> mirroring the server's `listStaleLimitOrders` rule, a replace-at-market flow against
> `POST /api/orders/replace-market` (LIVE typed-confirmation ritual preserved), a NEW
> cancel flow over the pre-existing `POST /api/orders/cancel` (legacy had no cancel UI),
> and a finished-orders history table. New files confined to `app/console/orders/**`.
> Deferred: surfacing `limitPrice`/`timeInForce` on `EquityOrder` (src/lib owner) so the
> limit-vs-market gap can be shown. See `docs/rollouts/2026-07-02-console-orders.md`.
> 2026-07-02 (`claude/console-settings-expansions`, Claude): **/console/settings
> expansions** — the settings lane of the parallel legacy→console port. Adds broker
> connect/manage (Robinhood OAuth + Alpaca key-pair, disconnect with explicit confirm),
> API-key CRUD (/api/keys; write-only, source-attributed), LLM model pickers
> (llmModel/redTeamLlmModel via native grouped selects, provider availability from
> /api/chat/providers, saved through PUT /api/policy), full delivery-channels editor
> (/api/notifications port), and a searchable help/glossary — all as new
> `app/console/settings/*` modules; plus the owner's cross-cutting UX standard
> (hover tooltips on virtually everything, row hover highlights). Console track only —
> no roadmap scope change. See `docs/rollouts/2026-07-02-console-settings-expansions.md`.
> 2026-07-02 (`claude/console-port-foundation`, Claude): **Console parity-port
> foundation (Wave 1)** — the legacy-dashboard feature parity port into `/console` is
> now an explicit multi-agent track: Wave 1 (this branch) ships the shared primitives
> (`app/console/ui/ticker-logo.tsx`, `provider-logo.tsx` (+`ModelBadge`),
> `symbol-drilldown.tsx`, `app/console/lib/models.ts`), nav scaffolding for four
> upcoming routes (`/console/scan`, `/console/macro`, `/console/orders`,
> `/console/assistant` — pages land in Wave 2 via parallel agents), the owner-requested
> model-attribution approval-card redesign (green-team proposer block with the vendor
> logo + LARGE confidence number; red-team reviewer block), positions logos+drilldown,
> and a console-wide tooltips-everywhere + row-hover UX standard in `console.css`.
> Fast-follow on the roadmap: persist `proposedByModel` per proposal (needs the
> src/lib/strategy.ts owner). See `docs/rollouts/2026-07-02-console-port-foundation.md`.
> 2026-07-02 (`claude/console-qa-fixes`, Claude): **12 owner QA fixes on /console** —
> policy saves no longer rejected by a stale stored gpt-5.5/high config; SPY benchmark
> is deposit/withdrawal-aware (inferred flows + time-weighted return, honestly labeled);
> Results shows the selected account's bucket with an explicit compare toggle; new
> account-scoped `taxSettings.washSaleMinLossUsd` lockout floor; danger red reserved for
> reality/STOP/destructive confirms (LIVE word chip on primaries); unsaved-changes
> guards; Activity run-event consolidation + account scoping + humanized ops events in a
> System bucket; AI strategy review panel ported to the console. No roadmap scope
> change — a QA/hardening pass on the Console track. See
> `docs/rollouts/2026-07-02-console-qa-fixes.md`.
> 2026-07-02 (`claude/console-ground-up-ui`): **Ground-up "Console" UI** — a complete,
> parallel greenfield interface at `/console` (new `app/console/` route group, new files
> only; the legacy dashboard is untouched and remains the default UI). Synthesized from
> three blind design studies (novice/operator/explainability-first — see
> `app/console/README.md`); wired to the real dashboard snapshot + mutation endpoints;
> light+dark theming required and implemented. This adds a candidate replacement UI
> track without changing any existing phase's scope. See
> `docs/rollouts/2026-07-02-console-ground-up-ui.md`.
> 2026-07-02 (`claude/sentry-monitoring`, Claude): **Sentry monitoring completed** —
> added the env-gated Sentry Crons scheduler heartbeat (`scheduler-tick` monitor,
> `SENTRY_DSN` + `SENTRY_CRONS_ENABLED=1`, try/catch-wrapped, after the single-leader
> gate) closing the dead-scheduler-but-health-200 gap, plus `test/sentry-inert.test.ts`
> pinning the whole integration as a no-op with zero Sentry env. Inert until the owner
> creates the Sentry project + sets env vars. No roadmap change; see
> `docs/rollouts/2026-07-02-sentry-monitoring.md`.

> 2026-07-01 (`chat-a-llm-money-path`): Audit Chat A — LLM & prompting (money-path),
> all 8 items. Hardened the autonomous strategy path: inline Bear red-team now fails
> CLOSED (un-critiqued Bull proposals route to human in decide mode, not auto-executed);
> Bull/Bear prompts extracted to a versioned `strategy-prompts.ts` + deterministic
> offline eval (`npm run eval:strategy-offline`) + `trade_proposals.prompt_version`
> stamp; Anthropic prompt caching; default-off ordered cross-provider failover
> (`policy.llmFallbackModels`); truncation-aware Bull cap; strict red-team `json_schema`;
> default-off rationale-collapse gate; removed a dead Anthropic endpoint branch. All but
> the fail-closed safety fix are default-off flags. Verified tsc/lint/test(1692)/build +
> eval green. See `docs/rollouts/2026-07-01-strategy-llm-money-path.md`.

> 2026-07-01 (`claude/wonderful-bell-32958a`): **Design spec — single-adversary ("Red Team")
> consolidation.** `docs/single-adversary-consolidation.md` proposes collapsing today's two
> adversarial LLM passes (in-flow Bear + standalone `debateProposal`) into one hardened Red
> Team: reviews the finalized trade, fails closed + visible when unavailable, never blocks a
> risk-reducing exit, provably independent of the proposer. Design-only (not implemented);
> decisions O1–O4 resolved (spec §9); Codex review refinements folded in as §12 R1–R20. Owning
> phase doc: `docs/phase-7-strategy.md` §F. See
> `docs/rollouts/2026-07-01-single-adversary-consolidation-spec.md`.

> 2026-07-01 (`claude/audit-work-split-f-g-o67jj2`): **Follow-up Codex review on the durable budget** —
> three findings were **fixed in code with tests** (not deferred): (a) an EXPLICIT per-user policy budget
> of `0` now opts OUT of an operator env default (`0` = no limit, not "block everything") — `resolveLimit`
> only inherits the env default on `undefined`/blank; (b) RAG (Voyage/Pinecone) spend from the
> `rag_usage` ledger now counts toward the same ceiling as `llm_usage`, so RAG-only spend can trip the
> cap (previously it could not); (c) the retrieval RAG meters (`meterEmbed`/`meterPineconeQuery`/
> `meterRerank` in `retrieveContextDetailed`) now book under the requesting `userId` instead of defaulting
> to `"local"` — otherwise a non-`local` user's retrieval spend was never counted against *their* ceiling,
> silently defeating (b) for the multi-user case. Covered by `test/llm-budget-enforcement.test.ts` and
> `test/rag-metering.test.ts`. A later pass added three more **fixed-in-code** items: (d) over-budget
> `generateReflectionSummary` no longer skips the non-LLM excursion enrichment (budget suppresses only
> the LLM reflection now); (e) a run that crosses the budget mid-run (revalidation/RAG spend) re-reads
> the budget before `proposeTrades` and gracefully skips instead of surfacing as a FAILED run; (f)
> `embedQueryCached` only caches VALID embeddings, so a transient malformed Voyage response no longer
> poisons the query LRU. Covered by `test/post-mortem.test.ts` and `test/query-embedding-cache.test.ts`.
>
> **Future considerations (deferred, not blocking PR #293)** — the durable per-user LLM budget now
> enforces at the spend primitives and is user-editable in Settings; known limitations left for a
> follow-up:
> 1. ~~**Concurrent-run budget reservation.**~~ **DONE (2026-07-01).** A per-USER LLM budget
>    **reservation** now closes this: `reserveLlmBudget`/`reserveLlmRunBudget`/`releaseLlmReservation` in
>    `src/lib/llm-budget.ts`, CAS'd in the `settings` KV row like `acquireStrategyLock` (no migration,
>    5-min TTL, fail-closed → skip LLM, default-OFF). `runStrategyOnce` reserves its worst-case estimate
>    at the budget gate and releases in the `finally`, so a concurrent same-user run sees the hold and
>    skips LLM instead of both overshooting. See `docs/rollouts/2026-07-01-llm-budget-reservation-toctou.md`.
> 2. **Chat-path spend coverage.** `/api/chat` LLM spend does not route through `withLlmGeneration`, so
>    it is outside the budget gate. If a *total* per-user/day ceiling (strategy + chat) is desired,
>    wire the chat LLM path through the same `assertWithinLlmBudget(userId)` guard.
> 3. **Multi-account budget target.** The ceiling is keyed by `userId`, so it is a per-*user* daily cap
>    that spans all of that user's accounts, not a per-*account* cap. If a user runs several accounts and
>    the intent is an independent budget per account, the gate would need to key on the account id (and
>    the ledger read filter + the Settings UI would need a per-account budget field). Today it is
>    deliberately per-user so one runaway account can't drain a shared daily allowance unnoticed.
> 4. **(Earlier-noted) `strategy.ts` god-module split** (~3k lines) remains a separate large refactor.
> See `docs/rollouts/2026-07-01-llm-budget-durable-enforcement.md` and
> `docs/rollouts/2026-07-01-fg-codex-review-fixes.md`.
> 2026-07-01 (`claude/audit-work-split-f-g-o67jj2`): audit workstreams **F**
> (UX/IA/aesthetics) and **G** (security/risk/testing/ops) implemented together via
> 4 parallel agents on disjoint files. F: first-class `redTeamVerdict` + "Bear
> Review" block, Bear-veto audit, visible ⌘K, Macro/Tax tab overflow, tap-to-expand
> rationale, EmptyState/skeleton + elevation/blur/icon token scales, `docs/design/
> visual-system.md`, phase-8 IA fix. G: chat/scan rate limits, OAuth-token at-rest
> encryption, constant-time admin compare + CSP/security headers (default-off),
> drawdown/correlation-gate verification, an e2e money-path test + default-safe
> live-order pre-flight guard, a default-off per-user/day token-budget ceiling +
> query-embedding LRU, an **account-deletion coverage fix** (4 user-scoped tables
> were escaping deletion), and Langfuse prompt-version/veto stamping. All new
> behavior is default-off; paper/Test mode unchanged. Deferred (noted): the
> `strategy.ts` god-module split and interval-scheduler budget wiring. Verify quartet
> green locally (1720 tests); see `docs/rollouts/2026-07-01-{ux-ia-aesthetics,
> security-hardening,strategy-money-path-f-g,cost-ops-controls}.md`.
> 2026-07-01 (`claude/trading-audit-d-e-dpw0h7`, follow-on): closed issue #306's
> non-mechanical follow-ups from Chats D+E. **Scope correction:** the "FMP as a second
> short-interest source with a ≥5pp disagreement bulletin" item below was removed as
> non-deliverable — FMP publishes no short-interest data (no `/short_interest` endpoint;
> verified against FMP's API docs + official MCP surface). Yahoo `shortPercentOfFloat` is the
> single real source; a real second source would need Massive/Finnhub. **UPDATE 2026-07-01 (PR
> #309): the real second source is now DELIVERED via Massive REST** — `MassiveEnrichmentProvider`
> computes short % of float from Massive's FINRA short interest / free float and emits the ≥5pp
> disagreement bulletin, gated on `MASSIVE_API_KEY` (default-inert without it). See
> `docs/rollouts/2026-07-01-massive-short-interest-second-source.md`. Also: scoped the
> default-off enrichment circuit breaker to trip per **credential lane** (a dead env lane no
> longer disables a healthy user lane), and locked in `extractUnderlyingPrice`'s
> `{ quotes: [...] }` envelope parsing with a regression test. See
> `docs/rollouts/2026-07-01-followon-fmp-breaker-quotes.md`.
> 2026-07-01 (`claude/trading-audit-d-e-dpw0h7`): audit work-split Chats D+E
> (data-source breadth + request-path/bundle performance), two parallel agents +
> orchestrator integration. **D (data sources):** `daysToEarnings` and
> `institutionOwnershipPct` from the existing Yahoo `quoteSummary` call (zero added
> cost); synthetic Yahoo bid/ask now provenance-tagged `yahoo-finance-synthetic` so
> `hasAskData`/marketable-limit math no longer treats it as a real quoted ask
> (correctness fix); a default-off Robinhood options/IV enrichment tier
> (`RobinhoodOptionsEnrichmentProvider`); a default-off active per-provider circuit
> breaker; FMP as a second short-interest source with a ≥5pp disagreement bulletin;
> and a default-off Finnhub `stock/recommendation`-drop lever (5→4 calls/symbol).
> **E (performance):** collapse ~9 redundant `listFillEvents` replays to one live +
> one paper per dashboard request; batch proposal lookups (`getProposalsByIds`); cap
> the unified feed at 60; `next/dynamic` code-split of `StrategyFlow`/`SymbolDrilldown`
> (verified `@xyflow/react` out of the dashboard first-load JS); sqlite
> `cache_size`/`mmap_size` pragmas; Playwright-CI `.next/cache` restore. All new
> behavior behind default-off env flags; E is a pure refactor (identical outputs). The
> monolithic-snapshot re-render refactor is tracked as a deferred follow-up. No roadmap
> change; see `docs/rollouts/2026-07-01-data-sources-breadth.md` and
> `docs/rollouts/2026-07-01-performance-efficiency.md`.
> 2026-07-01 (`claude/affectionate-franklin-a52935`): Alpaca account-editor
> "Custom Endpoint" checkbox fix - a live Alpaca account (`environment: "live"`)
> ended up with `base_url` stuck on Alpaca's paper endpoint, causing a
> production 401 on the readiness check. Root cause: checking "Use a Custom
> Alpaca Endpoint" in `dashboard-client.tsx`'s account editor copied the
> current (possibly-stale-default) `baseUrl` into the custom field with
> nothing typed, and also disabled the auto-derivation that keeps `baseUrl` in
> sync with the inferred paper/live environment as the account
> number/API key are filled in. Fixed to start the custom field empty on
> check. No roadmap change; see
> `docs/rollouts/2026-07-01-alpaca-custom-endpoint-checkbox-fix.md`.
> 2026-07-01 (`agent/claude-backlog-b-learning-b`): **Learning-loop BROADER BACKLOG (P1 + P2).**
> Backend/API/tests-only pass on `docs/reviews/2026-07-01-learning-loop-expansion.md`, building ON
> #300's ledger / tuning-invariants / `pairedICDiffStats` (no duplication). P1: (P1-1) read-only
> `dryRunAutonomousWeightTuning` + shared side-effect-free evaluator + `GET /api/admin/tuning-dry-run`;
> (P1-2) opt-in purged-&-embargoed walk-forward split (`policy.tuning.oosPurgeEmbargo`, default-off
> byte-identical); (P1-3) shadow / forward-A-B ledger (`shadowWeightLedger`) reusing #300's
> `learning_mutations` with a distinct `auto_weight_shadow` trigger; (P1-4) HARD look-ahead unit test
> (`isPointInTimeForwardExit`) + SOFT survivorship proxy (`certifyForwardResolution`). P2: (P2-1/2)
> missed-opportunity HIT-RATE over winners+losers, shrunk to base rate, benchmark-parity both legs
> (`missedOpportunityRequireHitRate`); (P2-3) signed top-bucket congress gate
> (`congressRequireTopBucketPositive`); (P2-4) IC-weight shrinkage λ (`icWeightShrinkage`); (P2-5)
> drawdown guard (`autoApplyDrawdownGuard`, candidate/baseline OOS drawdown curves); (P2-6) OOS
> starvation floor (`minOosTestDates`); (P2-7) `tuning_apply_provenance` audit per apply; (P2-8)
> `refreshCongressScoreVerdict` cadence refresher + fixtured test. Also the composed paired-t gate E2E
> #300 deferred. D-1 (multiplicity) deferred with docs; P1-5 verified already-shipped in #296 (skip);
> admin ledger UI skipped (redesign thread owns UI). Every knob default off/no-op with a per-flag
> byte-identical proof; red-team/inline-Bear + `app/` UI untouched. Verify quartet green (tsc / lint
> 0-err / 195 files 1977 tests / build). See `docs/rollouts/2026-07-01-learning-loop-backlog.md` +
> `docs/phase-7-strategy.md` §3.E.8–E.15.
>
> 2026-07-01 (`claude/settings-navigation-redesign-a3k1yv`): **settings & navigation IA
> redesign proposal** (docs-only, no code). Large-team workflow (`wf_000ecc50-7eb`, 48
> agents) using the owner-requested two-track method (one informed team + two blind
> greenfield teams that never saw the current UI + one pattern-led team → adjudication →
> red-team → artifacts). Canonical target: account = primary object; 7+4 tabs collapse to
> 6 verb destinations + off-rail Settings + Assistant overlay; Strategy consolidates to one
> editable home; money-reality vs authority split into two dials; settings split by scope
> first; copy-on-bind presets; server-side write-time scope validation. Deliverable
> `docs/settings-navigation-redesign.md` (+ appendix corpus). Complements — does not replace
> — the settings-and-universe-overhaul field-completeness program. No roadmap phase changed.
> **Owner approved the design + answered all 7 open questions (later 2026-07-01); a second workflow
> (`wf_598c6d71-77d`, 16 agents) built the full implementation-ready spec under
> `docs/settings-navigation-redesign/spec/`** (11 sections + grounding + reconciliation; start at
> `spec/00-README.md`). Still docs-only. Next: clickable prototype, then delivery-plan PR #1 (relabels +
> scope-surfacing). See `docs/rollouts/2026-07-01-settings-navigation-redesign.md`.
> **PR #1 landed (2026-07-01, `claude/settings-navigation-redesign-a3k1yv-mce45j`):** first app code —
> vocabulary relabels (`Stop`→`STOP` w/ never-sells tooltip, handler unchanged; `Notifications`→`Alert
> history`/`Alert delivery`; `Display`→`Appearance`; `Data`→`Data & Privacy`) + settings-header
> `THIS ACCOUNT`/`ALL ACCOUNTS` scope tags. No flag, no data path. New `app/settings-scope.ts` (shared
> scope-tag SSOT) + `test/scope-tag-render.test.ts`. tsc/lint/test/build green. Next: PR #2 (`DestinationTab`
> mapping + localStorage shim behind `NAV_V2`). See `docs/rollouts/2026-07-01-nav-v2-pr1-relabels-scope-surfacing.md`.
> **PRs #2–#6 landed (2026-07-01, PR #305, same branch restarted from main):** DestinationTab mapping +
> localStorage shim (`app/nav-destinations.ts`); settings field catalog + search index + Essentials + scope
> (`app/settings-search.ts`); Settings Glossary old→new table + relocation map; `/strategy`→`/how-it-works`
> gated redirect; TuningCard de-dup behind `STRATEGY_CONSOLIDATION`. All behind `NAV_V2`/sub-flags or safe
> structural changes — flags off ⇒ prod byte-identical. The physical settings/Strategy modal teardown is
> staged to the shell (PR #9). Stopped before PR #7 (real-money execution gate) pending go-ahead.
> tsc/lint/test(2020)/build green. See `docs/rollouts/2026-07-01-nav-v2-pr2-6-batch.md`.
> **PR #7 built (2026-07-01, own PR after #305): the ⛔ real-money gate — view/execution decouple.** Subagent
> map found most of it already existed (autonomy-reset-on-boot, per-account scheduler fan-out, view-only
> pointer incl. mobile, copy-preset preserves state, API auth ignores body). Remaining coupling closed in
> `db-profiles.ts`: fail-closed fresh-seed (no auto-arm, view-pointer independent), ambient mirror made
> config-only (`copyPolicyConfigToActiveAccount` preserves run-state), explicit
> `assertConnectedAccountOwnedByUser` write guard. Not flag-gated; real-money — preview-QA before merge.
> tsc/lint/test(2032)/build green. See `docs/rollouts/2026-07-01-nav-v2-pr7-execution-gate.md`.
> **PR #8 built (2026-07-01, stacked on #7 in PR #310): wash-sale provenance + Test-account filter.**
> `tax.ts` adds per-symbol provenance (`WashSaleLock {account, clearDate}`) and excludes Test/sim accounts
> from contribution (a simulated loss can no longer lock a real taxable account). Chose the parallel-accessor
> option: Set-returning helpers are projections of the provenance map, so the authoritative enforcement gate
> (`policy.ts` `.has`) stays byte-identical. Tests: washsale-test-account-excluded, washsale-provenance;
> chat-draft updated. Real-money tax safety. tsc/lint/test(2090)/build green. See
> `docs/rollouts/2026-07-01-nav-v2-pr8-washsale-provenance.md`.
> 2026-07-01 (`agent/claude-followon-b-learning`): **Learning-loop follow-on guardrails.**
> Focused pass on `docs/reviews/2026-07-01-learning-loop-expansion.md` on top of Workstream B
> (#296): (P0-4) a UNIFIED append-only learning-mutation ledger (`learning_mutations` table +
> `db-learning-ledger.ts` CRUD + `learning-ledger.ts` record/revert) that GENERALIZES #296's
> tuning-specific audited revert into one ledger + one `requireAdmin` revert route
> (`/api/admin/learning-ledger`); (P0-2) effect-size + PAIRED-t significance on the autonomous
> OOS gate (pure `pairedICDiffStats` on the shared-fold per-date IC-difference series;
> `policy.tuning.minOosICImprovement` + `minOosPairedTStat`, both default no-op); (P0-3) a
> FAIL-CLOSED tuning-config invariant guard (`tuning-invariants.ts`) that skips (never throws)
> the autonomous apply on a bad config and warns (never blocks) the manual tune route. Ledger
> RECORDING is passive/always-on (audit trail only); every behavior-changing knob defaults
> off/no-op. Red-team/inline-Bear untouched. Verify quartet green (tsc / lint 0-err / 1793
> tests / build). See `docs/rollouts/2026-07-01-learning-loop-followon.md` +
> `docs/phase-7-strategy.md` §3.E.5–E.7.
>
> 2026-07-01 (`claude/competent-elion-c82938`): Workstream C2 — API Usage Monitor
> integration. Wired App B's usage ledgers (`recordLlmUsage`/`recordRagUsage`) +
> market-data/broker call paths to push real usage/cost to `usage.jays.services`
> via a new fire-and-forget forwarder (the shared push client had zero callers —
> audit §6.9 / top-10 #9); added the audit's cost-aware feedback loop (monitor
> `GET /api/budget-status` + App B budget client: alerts by default, model-downgrade/
> cycle-skip behind default-off `USAGE_BUDGET_ENFORCE`). All default-off,
> fire-and-forget, fail-open — App B runs standalone without the monitor. Hand-rolled
> the push (App B's pinned shared pkg 1.0.0 lacks the `usageTelemetry` export; publish
> + pin-bump deferred). No roadmap-phase change. See
> `docs/usage-monitor-integration.md` +
> `docs/rollouts/2026-07-01-usage-monitor-integration.md`.

> 2026-07-01 (`agent/claude-backlog-c-rag`): RAG expansion backlog, broader pass - implemented
> all remaining P1/P2 items from `docs/reviews/2026-07-01-rag-knowledge-expansion.md`: **R5**
> consolidated per-retrieval telemetry (`recordRetrievalQuality()`, hashed query, default off);
> **R6** shared `envFlagOn` parser (fixes `RAG_EMBED_DISCLOSURES` to accept `true/1/yes`); **R7**
> index-metric assertion at bootstrap (warn+audit only, never throws); **R9** query-embedding LRU
> (vector-only, never Pinecone results, default off); **R10** `content_hash` dedup for
> `storeContexts` (opt-in `dedupKeyPrefix`, wired into 8-K summary + disclosure ingesters);
> **R11** faithfulness/citation-grounding eval (`scripts/eval/faithfulness.ts`, deterministic +
> optional off-by-default LLM judge); **R12** centralized default cosine floor
> (`applyDefaultFloors`); **R13** provenance-complete citations (additive `doc_type`/`section`) +
> optional advisory `isStale` label, backend/payload only; **R14** near-duplicate suppression
> (Jaccard-shingle, opt-in); **R15** offline corpus coverage & freshness report
> (`scripts/eval/corpus-coverage.ts`); **R16** per-run RAG budget ceiling (degrades rerank/hybrid
> only, never core recall); **R17** fixed train/serve text skew (`VECTOR_EMBED_CLEAN_TEXT`,
> embeds clean text, stored/cited text unchanged). R3/R8 already shipped (#297/#299), verified not
> re-implemented. Every item default-off/opt-in, proven byte-identical when unset. Read/
> retrieval-only, no UI touched. See `docs/rollouts/2026-07-01-rag-backlog.md`.
> 2026-07-01 (`agent/claude-followon-c-rag`): RAG follow-on, focused pass on the two items
> Workstream C's own rollout note deferred - **R4** (retrieval regression net: a pure
> `rankPool` helper extracted from `retrieveContextDetailed`'s post-recall pipeline, exercised
> by 19 network-free tests pinning the as-of/rerank/hybrid fail-safes) and **R1 part 2**
> (`VECTOR_ASOF_STRICT`, default off - drops undated chunks under an active `asOf` instead of
> the lenient default, with a drop-count audit; golden as-of tuple proven end-to-end). Both
> byte-identical to current behavior unless explicitly opted in. See
> `docs/rollouts/2026-07-01-rag-followon.md`.
> 2026-07-01 (`agent/claude-workstream-c-rag-v2`): RAG/embedding Workstream C - closed the 3
> highest-leverage gaps the 2026-06-30 audit found in the RAG pipeline (no retrieval-quality
> eval, reranker discarding its own relevance score, char-cap/doc_type/salience hygiene
> issues): a new recall@k/MRR eval harness (28-case golden fixture, no live network calls)
> gates future retrieval-pipeline changes; rerank relevance scores are now captured +
> surfaced with an opt-in post-rerank floor; char-cap alignment + write-time doc_type
> lowercasing landed; the salience extractor's first-match-only ticker-binding bug was fixed
> and a default-off structured-output LLM extractor with real ticker validation was added.
> Hybrid BM25/RRF was evaluated (measured delta table) and stays off by default - reranking
> alone already reaches the eval ceiling on the golden fixture. All behavior changes are
> default-off/opt-in; no order/execution-path code touched. A parallel 16-agent expert
> design review (`docs/reviews/2026-07-01-rag-knowledge-expansion.md`) landed corrections
> mid-implementation, folded in per the rollout note. See
> `docs/rollouts/2026-07-01-rag-eval-and-rerank.md` for full item-by-item status and explicit
> follow-ups (R1 strict as-of mode, R3/R4/R5/R6/R7/R9/R10/R11, R12-R17 P2 backlog).
> 2026-07-01 (`agent/claude-workstream-b-learning-v2`): **Workstream B — learning
> loop / auto-tuning.** Wired the audit's "built-but-unwired" learning loops into the
> money path behind default-off `policy.tuning.*` flags, with the 16-expert-panel
> corrections folded in (B1–B8): opt-in autonomous factor-weight apply (stricter OOS
> gate + write-scope safety + scheduler-hosted cadence + audited revert); congress
> go/no-go gating with a three-way verdict (no data-poverty kill-switch); missed-
> opportunity per-factor scan nudge; ≥5 + SPY-relative recurringFactor; factor
> attribution stamped at entry (no momentum default); confidence-calibration→sizing
> (isotonic, reduce-only); per-regime IC report (application off — samples too thin);
> and a REAL fix — paper/test protective EXITS now pay execution cost. Verify quartet
> green (tsc/lint/1710 tests/build). See
> `docs/rollouts/2026-07-01-learning-loop-autotuning.md` + `docs/phase-7-strategy.md` §3.E.
>
> 2026-07-01 (`claude/affectionate-franklin-a52935`): broker capability fan-out -
> 4 parallel Opus agents (Workflow tool, isolated worktrees) implemented
> independent items from `docs/broker-capability-plan.md`'s cheap/high-value
> list: broker-gateway health logging (`alpaca-broker`/`robinhood-broker`
> services), Alpaca portfolio-history/calendar/clock/account-activities
> (`alpaca-account-insights.ts`), a Robinhood-realized-P&L cross-check
> (`robinhood-pnl-crosscheck.ts`), and 3 new read-only chat-assistant tools
> (earnings calendar, option chain, instrument search) backed by Robinhood MCP
> data. Merged all 4 branches with zero conflicts, merged current
> `origin/main` through the mobile API/PWA work, addressed review fixes, and
> re-verified as one change (172 files / 1671 tests). Robinhood options-trading support and
> eToro/Public.com/IBKR integration deliberately excluded — real feature work
> and Codex-coordination-sensitive, respectively, not "cheap." No roadmap
> change; see `docs/rollouts/2026-07-01-broker-capability-fanout.md`.
> 2026-07-01 (`claude/elastic-rosalind-a2a48a`): Workstream C1 — Congress.Trade
> integration repair (App B side). Adopted App A's subscription-model SSE
> (`/api/stream?subscription=` — the old consumer never connected), made the
> inbound import receiver explicitly acknowledge non-persisted datasets (the
> "drops 4 of 7" is correct-by-design, not a bug), exact-pinned the shared pkg to
> 1.0.0 with a real peer-divergence CI check, applied the shared `resolveTickerAlias`
> on outbound rows, and made outbound payload validation drop-invalid-rows. App A
> exact-pin + local-alias-retirement ship in a separate Congress.Trade PR. No
> shared-pkg source/publish change needed. See
> `docs/rollouts/2026-07-01-congress-integration-repair.md`.
> 2026-07-01 (`docs/improvement-audit-2026-06-30`): comprehensive audit
> re-baseline - historical auth IDOR is no longer the active P0; near-term
> priorities shift to money-path correctness (Bear red-team fail-closed,
> synthetic quote avoidance, end-to-end proposal execution tests), built-but-
> unwired learning guardrails (factor tuning, congress go/no-go, rationale
> collapse), RAG evaluation/corpus depth, usage-telemetry push integration, and
> dashboard decomposition. See `docs/reviews/2026-06-30-improvement-audit.md`.
> 2026-07-01 (`agent/claude-congress-webhook-parity` / PR #283, [codex-autofix]):
> Congress bare-tx ingest fix - the "envelope itself is one trade" last-resort
> branch in `applyCongressEvent` was pushing the whole envelope into
> `coerceCongressTrade`, so a bare App A transaction over SSE (whose `type` was
> stamped with the SSE event name by `applySseMessage`) had its trade side
> shadowed and was dropped as `no-trades`. Now strips envelope keys
> (`type`/`event`/`id`/`data`) before coercing, with a regression test. No
> roadmap change; see `docs/rollouts/2026-06-30-congress-webhook-sse-parity.md`.

> 2026-07-01 (`claude/stock-data-pricing-comparison-2wzg8u`): market-data
> freshness decision + plan (docs-only). Recorded that the engine is
> broker/strategy-neutral and already runs "delayed bulk + real-time hot-set on
> demand"; real-time only matters at the 60s exit layer and the order-submission
> instant. New deferred workstream: enable/tune the already-built but default-OFF
> gates (`maxQuoteAgeSec`, `maxEntryDriftPct`, `marketableLimitEntries`), add a
> hot-set quote-source router (broker → FMP real-time → stamped-stale DB
> fallback), and an optional poll→push trailing-stop stream. No new data feed
> required. See `docs/market-data-freshness-decision.md` +
> `docs/market-data-freshness-implementation-plan.md`.

> 2026-06-30 (`claude/affectionate-franklin-a52935`): broker reliability +
> capability audit - broker-agnostic order-placement confirmation
> (`isRejectedOrCanceledState` in `broker-side.ts`; a non-throwing but
> broker-declined order no longer records proposal status "placed"), a
> Robinhood order-id fabrication fix, the share-class symbol fix extended into
> `data-providers.ts`'s Alpaca enrichment providers and the news stream (same
> bug, independent code path), a production-data-confirmed root cause for the
> "Alpaca news never worked" report (a credential issue that self-resolved
> 2026-06-30 ~10:01 UTC — not a code bug), and `docs/broker-capability-plan.md`
> - a 5-broker (Alpaca/Robinhood/eToro/Public.com/IBKR) capability audit +
> MCP evaluation + prioritized roadmap, including a live enumeration of the
> Robinhood MCP surface (43 tools, 34 unused). No roadmap change; the plan
> doc's own roadmap (options trading, new-broker integration, enabling
> disabled streams) is future work, not started. See
> `docs/rollouts/2026-06-30-broker-reliability-and-capability-audit.md`.
> 2026-06-30 (`claude/affectionate-franklin-a52935`): Alpaca share-class symbol
> mapping fix - live orders for tickers like `BRK-B` failed with HTTP 422
> "asset not found" because our canonical hyphenated symbol format (Robinhood
> convention) was passed to Alpaca unconverted; Alpaca requires dot notation
> (`BRK.B`). Added `toAlpacaSymbol`/`fromAlpacaSymbol` conversions at every
> Alpaca boundary (order placement, quotes, order/position mappers). No
> roadmap change; see
> `docs/rollouts/2026-06-30-alpaca-share-class-symbol-mapping.md`.
> 2026-07-01 (`ci/hosted-runner-and-concurrency`): CI runner-bottleneck fix -
> added cancel-in-progress concurrency groups to `ci.yml`/`security.yml`/
> `e2e.yml` and moved `verify`/`gitleaks`/`smoke` to `ubuntu-latest`, since
> the single self-hosted `trading-live-mac` runner was serializing all CI
> and queueing PRs behind unrelated branches. `deploy.yml`/
> `sync-previews.yml` stay self-hosted (they touch the production box
> directly). No roadmap change; see
> `docs/rollouts/2026-07-01-ci-hosted-runner-migration.md`.
> 2026-07-01 (`chore/shared-package-drift-fixes`, PR #280): cross-app
> dependency hygiene - `congress-trade-client.ts` now imports the shared
> `MAX_REFS_BATCH` constant instead of a hardcoded `500`; removed the unused,
> shape-conflicting `congress-shared-aliases.ts`; added a weekly
> `shared-package-pin-check.yml` workflow that warns if our git-pinned
> `congress-trading-shared` commit falls behind that repo's `main`. No
> roadmap change; see
> `docs/rollouts/2026-07-01-congress-trading-shared-drift-fixes.md`.
> 2026-07-01 (`codex/mobile-command-api-rebase-20260701`): rebased the stale
> mobile/PWA command API worktree onto current main as an additive mobile
> control surface. The backend remains source of truth via `mobile_commands`,
> `/api/mobile/*`, and SSE; account deletion reuses the audited M7 deletion
> lifecycle instead of the older short-lived settings deletion request. This
> advances Phase 11 with a new M8 foundation note; see
> `docs/rollouts/2026-06-23-mobile-pwa-command-api.md`.
> 2026-06-30 (`codex/prod-build-hotfix-20260630`): production build/start hotfix -
> after PR #270, the live box needed a manual repair because the default Next 16
> Turbopack build did not emit the production files consumed by the existing
> `next start` PM2 runtime. With the route export repair now landed in PR #275,
> this branch keeps deploys repeatable by using `next build --webpack` and
> webpack-compatible server-only crypto imports. No roadmap change; see
> `docs/rollouts/2026-06-30-prod-build-hotfix.md`.
> 2026-06-30 (`codex/strategy-timeout-sizing-guardrails-20260630`): strategy
> timeout and sizing guardrails - keep the interactive LLM call cap at 60s,
> reject `gpt-5.5` + high reasoning in Settings, runtime-clamp stale
> `gpt-5.5`/high configs to medium, add a 5% preferred opening-order headroom
> under the hard policy max, and stop chat draft promotion from staging
> already blocked policy decisions. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-timeout-sizing-guardrails.md`.
>
> 2026-06-30 (`codex/fix-policy-route-export`): production build fix - moved
> `stripNullsDeep` out of `app/api/policy/route.ts` because Next 16 rejects
> non-route exports from app route modules. Antigravity strategy-review/test
> quote fallback work has since landed on `origin/main` as PR #274 and is
> included via the merged base, not this fix diff. No roadmap change; see
> `docs/rollouts/2026-06-30-policy-route-export-fix.md`.
>
> 2026-06-30 (`codex/prod-merge-sweep-20260630`): production merge sweep -
> integrates the pending Settings scope/help overhaul, Settings review-action
> polish, Market Scan source-label cleanup, and the now-landed Alpaca
> broker-held/order-lifecycle work into one deployment path. The sweep fixes two
> review blockers before PR: broker-filled
> orders with only pending local reconciliation remain Working instead of
> dereferencing a nonexistent filled event, and legacy Strategy Studio model
> choices are migrated into every connected account before global user policy is
> reduced to true user-level fields. No roadmap change; see
> `docs/rollouts/2026-06-30-prod-merge-sweep.md`.
> 2026-06-30 (`codex/robinhood-public-oauth-20260630`): Robinhood MCP reconnect -
> live diagnostics showed public `/api/auth/robinhood/start` returns a valid
> Robinhood authorize URL, while stale state rows indicate the logged-in
> Robinhood leg is not returning to the public callback. Added an explicit
> same-machine loopback callback opt-in so reconnect can start from
> `socratictrade.com` without requiring app login on localhost. No roadmap
> change; see `docs/rollouts/2026-06-30-robinhood-public-oauth-loopback.md`.
> 2026-06-30 (`codex/market-scan-source-labels`): Latest Decisions and Market
> Scan source subtitles now share alias-aware source-list formatting, so
> `congress`, `congress.trade`, and repeated Congress.Trade segments display
> once as `Congress.Trade`, and `yahoo-finance-delayed-quotes` displays as
> `Yahoo Finance`. No roadmap change; see
> `docs/rollouts/2026-06-30-market-scan-source-labels.md`.
> 2026-06-30 (`codex/merge-antigravity-20260630`): strategy review persistence
> & test quote fallback — incorporates `agent/antigravity-strategy-review-decisions`,
> saving Strategy Studio LLM review proposals in local storage so they survive
> page refresh/modal closure, adding a discard button, and making test broker
> quote fetching fall back to a simulated Test-mode price instead of crashing
> when Yahoo Finance is rate-limited. No roadmap change; see
> `docs/rollouts/2026-06-30-antigravity-strategy-review-localstorage.md`.
>
> 2026-06-30 (`codex/strategy-llm-timeout-diagnostics`): strategy LLM timeout
> diagnostics - production run `64016e66-bb6d-4efc-bb23-2d11b7d054c5` failed
> during the Green Team `gpt-5.5` high-reasoning request before any Red Team,
> proposal, broker, or notification work. Runs now audit LLM step start/failure
> rows, preserve failed step context in the final strategy audit, and surface
> provider/model-specific timeout guidance. Red Team transport failures fallback
> to Bull proposals with an auditable reason. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-llm-timeout-diagnostics.md`.
>
> 2026-06-30 (`codex/settings-help-overhaul`): Settings scope/help overhaul —
> Strategy Studio now lives under Account Settings -> Strategy, Settings opens
> the correct scope tier for requested account/user sections, Green/Red model
> choices plus reasoning effort are account-scoped strategy fields with a legacy
> user-level seed, and compact field help plus a System Help Settings Glossary
> explain advanced knobs like "Min lots for weight shift" without long tab
> footers. No roadmap change; see
> footers. Follow-up refresh centralizes the Strategy/Assistant model catalog,
> adds Claude to the strategy-review picker, removes old curated OpenAI
> `gpt-4o`/`o1`/`o3` options, and switches DeepSeek curated choices to
> `deepseek-v4-flash` / `deepseek-v4-pro`. No roadmap change; see
> `docs/rollouts/2026-06-30-settings-scope-help-overhaul.md`.

> 2026-06-30 (`codex/alpaca-held-order-guard`): Alpaca broker-held exit guard -
> production KO sell approval failed because an existing Alpaca bracket sell leg
> already reserved all 29 KO shares. Strategy now subtracts active broker-held
> sell/cover orders from available exit quantity before autonomous placement or
> manual approval, blocking duplicate exits before broker submission. The same
> branch also clarifies broker order lifecycle display (`Submitted`/`Working`
> until filled), reconciles broker-paper pending fills on the scheduler, excludes
> pending broker-paper fills from paper P&L/projections, and adds a configurable
> stale limit-order alert (`staleLimitOrderMinutes`, default 15). Stale working
> limit orders can now be intentionally replaced from Activity by canceling,
> re-checking broker state, and submitting the remaining quantity as a market
> order; live Brokerage replacement requires typed confirmation. No roadmap
> change; see `docs/rollouts/2026-06-30-alpaca-held-order-guard.md`.
> 2026-06-30 (`codex/settings-review-polish`): Settings/Strategy Studio polish
> moved LLM Strategy Review controls into an advisory panel instead of a
> header/corner action, unified the strategy-review model picker across review
> surfaces, and tightened Settings scope/account-selector spacing. No roadmap
> change; see `docs/rollouts/2026-06-30-settings-review-polish.md`.
>
> 2026-06-30 (`codex/test-account-readiness`): Test/local readiness no longer
> blocks Start on dashboard portfolio display read errors. Broker-backed
> Paper/Brokerage modes still require account and portfolio reads. No roadmap
> change; see `docs/rollouts/2026-06-30-test-account-readiness.md`.
>
> 2026-06-30 (`codex/strategy-review-diff`): Strategy Studio review proposals
> now render before/after diffs for prompt replacements, scoring weights, and
> risk/automation settings. The LLM tuning prompt also asks models to describe
> below-gate scoring weights as "no scoring-weight changes" instead of exposing
> JSON-null schema language. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-review-diff.md`.
>
> 2026-06-30 (`fix/merge-pr-205` / PR #237): Alpaca shared market-data fallback —
> review-thread follow-up now lets shared/background scans use the operator's
> connected Alpaca account when a tenant has no complete Alpaca market-data
> credential, keeps REST market data off `alpaca-mcp` execution rows, prefers
> current connected operator key-only credentials before stale stored/env keys,
> preserves tenant key-only credentials before operator key-only fallbacks, and
> preserves FMP health logging for non-403 optional endpoint failures. Also
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
> 2026-06-30 (`codex/audit-log-strategy-ui`): Robinhood MCP quote params,
> LLM-audited strategy steps, account-filtered Activity/Audit feeds, and Settings
> split polish. The 01:33 test-account run failed to get Robinhood quotes because
> `get_equity_quotes` was called with unsupported `account_number`; the call now
> sends only `symbols`, with a regression test. Generic audit rows preserve JSON
> fallback details when no compact summary field exists. No roadmap change; see
> `docs/rollouts/2026-06-30-audit-log-strategy-ui.md`.

> 2026-06-30 (`codex/blocked-proposal-decision-persistence`): blocked proposals
> now persist the policy/tradability decision reasons when they move to
> `blocked`, with a Latest Decisions fallback for older blocked rows. This is the
> safe replacement for stale PR #256's unique persistence behavior; no roadmap
> change. See `docs/rollouts/2026-06-30-blocked-proposal-decision-persistence.md`.

>
> 2026-06-30 (`cursor/trim-openai-strategy-options-f06c` / PR #253):
> custom model selector review fix — trimmed OpenAI options remain reachable via
> Custom because the selector now seeds an out-of-list model id, and
> `next-env.d.ts` is kept on the build-generated route-types path. No roadmap
> change; see `docs/rollouts/2026-06-29-claude-green-red-team.md`.
>
> 2026-06-30 (`feat/tiered-settings` / PR #252): tiered settings review fix —
> stale user-level policy fields in legacy account rows are stripped before the
> user-level overlay, so cleared fields like `redTeamLlmModel` cannot reappear
> from inactive account state. No roadmap change; see
> `docs/rollouts/2026-06-29-tiered-settings.md`.

> 2026-06-30 (`codex/provider-degraded-checkbox`): Provider Degraded
> notification setting - Settings now saves the `provider_degraded` event because
> policy API validation uses the shared notification-event runtime list instead
> of a stale local allowlist. No roadmap change; see
> `docs/rollouts/2026-06-30-provider-degraded-notification-setting.md`.

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
> 2026-06-30 (`codex/agentic-shared-registry-semver-20260630` / PR #279): switched the
> shared dependency from the git+deploy-key pin to the private **GitHub Packages**
> registry (semver range). Install helper now authenticates with `NODE_AUTH_TOKEN`
> (fallback `GITHUB_TOKEN`); CI/e2e/deploy/preview-sync jobs carry `packages: read`.
> Supersedes the deploy-key model in the entry above. No roadmap change; see
> `docs/rollouts/2026-06-30-shared-dep-github-packages.md`.
>
> 2026-06-30 (`codex/browser-title`): browser tab title correction —
> root and welcome metadata now emit the document title `Socratic Trade`
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

Hosting topology: production remains `socratictrade.com` on the
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
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K bulletins with item-label enrichment, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, technical signals, keyed OHLC cascade, batched Voyage/Pinecone RAG scaffold with paced/capped 8-K ingestion, 2026-06-20 tenant-safe RAG metadata/filter/backoff hardening with raw-user credential lookup preservation, symbol drilldown with 0-100 signal thresholds, price chart with VWAP overlay, Market Scan `vs VWAP`, first-pass prompt compaction, factor-bucket scorecards, current-scan skipped counterfactual summaries, durable/mature-horizon skipped-name counterfactual rows, configurable red-team conviction threshold, and an optional de-risk-in-crisis opening-exposure cap are live. Remaining: broader adaptive prompt compaction/cache layout, production-grade filing/news digests, analyst/earnings revisions, SEC XBRL facts, post-mortem/tuning use of missed-opportunity rows, full learning-matrix UI, and broader scoring-threshold settings. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, route Alpaca through the active connected account, sync Robinhood through MCP OAuth/status instead of manual keys, support Alpaca MCP client connections alongside REST, keep account connection buttons persistent in UI for multi-broker setups, derive Alpaca paper vs brokerage environment dynamically via the account number PA prefix, state the Alpaca Paper/Brokerage default endpoints before asking for custom endpoints, enforce required account numbers for Alpaca, derive execution state as Test vs Paper vs Brokerage, present supported account connect buttons in Accounts, keep Paper accounts optional and user-selected, expose a hardened Robinhood MCP HTTP/SSE transport plus `/api/broker/mcp/health`, use that health check silently behind the Robinhood connect action instead of a persistent disconnected status card, ship Settings → Connections for provider keys and connection status, let users choose separate Green Team and Red Team OpenAI/xAI models in Strategy Studio with Green fallback, route major provider/LLM calls through `resolveApiKey(service,userId)`, scope strategy locks, paper projections, learning scorecards, tax reads, notifications, reflections, dashboard callbacks, and prompt cache keys by user, route high-impact API handlers through verified middleware identity via `resolveRequestUser`, explicitly share public/env-key market data while keeping user-keyed history private by default, track pending public OHLC misses so later shared fills can refresh prior requesters without spending another user's key, and add Infisical wrappers, local Gitleaks scanning, Sentry runtime hooks, redacted Langfuse LLM traces, npm Dependabot, Litestream scripts, and Playwright smoke tests. GitHub CI/e2e/security workflows are deferred until push credentials include `workflow` scope. M3 complete (2026-06-21): per-user policy/profiles/prompt/tuning fully scoped; global settings seeds removed; one-time migration to copy legacy global rows to 'local' user; DELETE /api/profiles/[id] route added; two-user isolation verified by test/per-user-policy-isolation.test.ts. M6 real identity/auth is implemented with Cloudflare Access/Auth.js fail-closed middleware, request-scoped SSR snapshots, `/login`, `/logout`, and visible signed-in/Sign out UI. M7 mobile foundation adds `/api/mobile/*`, a durable audited mobile command queue, `/mobile` PWA, SwiftUI starter client, SSE status updates, and a multi-step account deletion/reset flow for Google/Apple-authenticated users. Remaining: complete data isolation audit for any newer fills/snapshots/proposals/learning tables and broaden mobile e2e coverage. |
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
- Mobile/PWA/native clients use the shared backend command queue and status model;
  phones never store provider secrets, broker credentials, or MCP tokens.
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
- Error/LLM observability stays opt-in and redacted by default for account, prompt, and credential data.
- The local SQLite database has a documented Litestream replicate/restore path before production reliance.
- Production and beta hosting stay separated: production on `socratictrade.com`
  / port `4000`; integration beta on `trading-beta.jays.services` / port `4001`;
  no duplicate dev/beta hostname.
- Agent branch landing requires a clean worktree and refuses stale semantic overlap
  when the branch and `origin/main` both changed the same files since divergence.
- Root-level manual probe artifacts such as screenshots, one-off UI scripts, and
  accidental shell-output files stay ignored so the integration worktree remains
  reserved for review and merges.
