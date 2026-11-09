# Failure-Mode Review — Agentic Trading

- **Date:** 2026-06-20 (brainstorm) · 2026-06-21 (Top-5 verification + first quick-win fixes)
- **Method:** 12 specialist agents fanned out over distinct failure dimensions
  (money path, real-money safety, risk controls, LLM loop, persistence, market
  data, concurrency, security, architecture, error handling, testing,
  operational) → 114 raw findings → synthesized to ~70 distinct risks. The Top 5
  were then re-checked by 5 adversarial verifiers reading the actual code (see
  the Addendum).
- **How to read the citations:** `file:line` references are agent-generated. The
  Top 5 are verified against code; the rest are *leads to confirm before
  fixing*, with a few tagged `(unverified)`.
- **Key verification correction:** the adversarial pass downgraded two of the
  Top 10. Most importantly, original finding **#2 (synthetic stops as an ungated
  real-trade cannon) was substantially overstated (crit → low)** — the
  simulation guard *is* the gateway abstraction, so in the default Test posture
  no real order is placed. See the Addendum for the corrected severities.

> Point-in-time brainstorm + targeted verification, not a standing task list.
> The "Quick Wins vs. Deep Fixes" section reflects the recommended split; items
> already actioned are tracked in the rollout note for 2026-06-21.

---

# Agentic Trading — Failure-Mode Review Brief

**Scope:** 114 raw findings from 12 specialists, merged to ~70 distinct risks. Citations preserved to the strongest file:line. Tags: "(unverified)" = inferred from one agent without corroboration.

---

## Top 10 Most Dangerous

Ranked by severity x likelihood, real-money / data-loss weighted highest.

| # | Risk | Sev | Like | Where | Why it's the worst |
|---|------|-----|------|-------|--------------------|
| 1 | **Every mutating API route is unauthenticated; caller picks its own `userId`** | crit | high | `src/lib/request-user.ts:9-16`; `app/api/proposals/[id]/approve/route.ts` | Anyone who can reach the tunnel can approve/cancel real orders, rewrite risk policy, and read/overwrite broker creds. No `middleware.ts` exists; 23 mutating routes ungated. |
| 2 | **Synthetic trailing-stop monitor places real broker orders with NO risk/policy gate** | crit | med | `src/lib/synthetic-stops.ts:144-184`; sched `scheduler.ts:80` | Auto-registers a stop per open position; one quote glitch past the bad-tick filter or a mis-set trail % can market-dump the live book. Bypasses `evaluateTradeProposal`, caps, tradability, and the sim/live guard entirely. |
| 3 | **Autonomous scheduler auto-starts on every boot, gated only by a value inside the (copyable) DB** | crit | med | `instrumentation.ts:29-30`; `scheduler.ts:30-39` | No deploy-time autonomy switch. A restart/crash-loop/DB-restore resumes live order placement unattended. Compounded by #16 (cadence state lost on restart → immediate run). |
| 4 | **`executeProposal` double-execution: status guard is a non-atomic read, broker call before the write** | crit | med | `src/lib/strategy.ts:481-483` (guard) → `:598-600` (place+update) | Two concurrent approvals (double-click, two tabs, from-draft race) both pass the `status==='proposed'` check, both call `placeEquityOrder`. Doubles a real position. `updateProposalStatus` has no `WHERE status=...` CAS. |
| 5 | **Synthetic-stop monitor runs every tick with no re-entrancy guard / no lock → double-fires same exit** | crit | med | `src/lib/synthetic-stops.ts:67-191`; fire-and-forget at `scheduler.ts:80` | Slow broker call (>60s, exactly during volatility) lets the next tick's monitor run concurrently; both place the exit, status flip is post-order and not a CAS. Over-sells a long into a short. |
| 6 | **Order placed at broker before any local record exists → crash window orphans a real order** | crit | med | `src/lib/strategy.ts:264-290` (auto), `:598-612` (approve) | refId is in-memory, not persisted pre-call. Kill/lock/restart between broker ACK and insert = live order with zero local trace, invisible to P&L, caps, and stops. No orphan reconciliation exists (`reconcilePendingFills` only matches known rows, strategy.ts:1373-1436). |
| 7 | **No global circuit breaker / max-drawdown / daily-loss kill switch** | crit | high | `src/lib/scheduler.ts:70-108`; `RiskRules` has no `maxDailyLossPct` (`types.ts:89-99`) | `SystemState` is manual only. The `"Kill switch is active."` branch (strategy.ts:389) is dead wiring — nothing ever trips it. In a drawdown the agent keeps opening every tick until per-order caps bite. |
| 8 | **No CI active + `executeProposal` (the place-real-order fn) has zero direct test coverage** | crit | high | `ci-pending/*.yml` never moved to `.github/workflows/`; no test calls `executeProposal` | 3+ agents merge to `main` with only a manual "run the trio" instruction. The single `usesLocalSimulation` guard separating paper from real money is completely unverified. A regression ships straight to the money path. |
| 9 | **Synthetic-stop live exits booked `"filled"` at the quote price, never reconciled** | high | high | `src/lib/synthetic-stops.ts:157-184` | Stop fires (worst slippage moment), books full qty at the last tick price as final. `reconcilePendingFills` skips it (not `pending_reconciliation`). Systematically understates realized losses → corrupts the learning loop on real money. |
| 10 | **Allowed-universe / blocklist gate blocks risk-reducing exits** | high | high | `src/lib/policy.ts:29-31`; `index-universes.ts:158-170` | Side-blind: blocklisting a name to stop buying it traps the existing position — auto stop-loss exits get rejected with "not in the allowed universe." The exit you most need is the one blocked. |

Runners-up that nearly made the cut: ENCRYPTION_KEY ephemeral-random fallback silently wiping all stored broker creds on restart (`db.ts:1628-1658`); no `busy_timeout` PRAGMA with WAL → SQLITE_BUSY mid-write (`db.ts:41-49`); setup script fanning out live `.env.local` secrets to 3 dev previews (`setup-agent-previews.sh:39-41`); LLM calls with no timeout holding the strategy lock 5 min (`strategy.ts:1003,1169`).

---

## By Theme

### Money path & financial correctness
- **Synthetic-stop live fill booked `"filled"` at quote price** → fictitious favorable exit, learning-loop corruption → write as `pending_reconciliation` with `exec.orderId`. (`synthetic-stops.ts:169-181`) *[= Top 9; also surfaces under Error handling]*
- **Daily/hourly notional caps count full *estimated* notional, never reconciled to actual fill** → over-counts (strangles throughput) and, with the $100 fallback below, under-counts real capital at risk → derive caps from `fill_events.notional` or reconcile `estimated_notional` down. (`db.ts:979-1028`)
- **`reviewEquityOrder` fabricates a $100 price when no quote** → a market buy of a $900 stock counts as $10k not $90k, persisted, so the whole day under-counts → reject or treat notional as Infinity when no quote. (`alpaca.ts:146-148`, `robinhood.ts:506`) *[high; feeds Risk controls]*
- **Two cost-basis engines with different sign conventions** (`calculatePnl` FIFO unsigned-magnitude vs `getPaperPortfolioProjection` signed) → realized vs unrealized drift for any account that shorted → pick one convention + a buy→short-flip→cover cross-check test. (`performance.ts:287-343`)
- **Paper projection lets shorts inflate buying power; cash allowed arbitrarily negative** → trains strategies a real broker would margin-reject → model short collateral, reject opening fills over buying power. (`performance.ts:225,256-259`)
- **All money math is binary float; flat 1e-6 zero-epsilon** → dust lots or silently-erased residuals on fractional shares → apply `roundCents` per accumulation, make epsilon relative to share precision. (`performance.ts:215-351`, `money.ts:9-11`)
- **Wash-sale lock re-derives FillSource from current account flags, not the source the lots were booked under** → guard fails open, disallowed loss, real tax cost → scan stored fill source for the account. (`tax.ts:108-115`)
- **`recordFillFromProposal` writes a live fill with a placeholder price; if reconcile never fires it's stuck forever** (non-Alpaca brokers have no reconcile path) → add a stuck-pending watchdog. (`performance.ts:108-146`)
- Orphaned/out-of-order closing fills silently `break`-dropped, never recorded → audit them instead. (`performance.ts:856-864`) *(low)*

### Real-money safety & execution-mode guards
- **Synthetic-stop monitor = largest ungated real-trade surface** → route through `evaluateTradeProposal` + `usesLocalSimulation`. (`synthetic-stops.ts:159-168`) *[= Top 2]*
- **Robinhood gateway ignores `ROBINHOOD_ADAPTER` flag** → flipping the "master switch" off does NOT stop order placement (a stored OAuth token still works); only health card + read helpers gate on it → assert `ROBINHOOD_ADAPTER==='mcp'` on the order path. (`robinhood.ts:198-218`) *(high)*
- **Proposal executes on currently-active account but records fill against proposal-time account** → switching active account between propose and approve can fire a real order on a Test-reviewed proposal; ledger mis-attributed → hard-fail if `row.accountNumber !== policy.accountNumber`. (`strategy.ts:486/599/603`) *(high)*
- **No server-side confirmation gate on live approve** → one click = real order, no idempotency key, no mode echo (the only ConfirmModal is the dead paperMode switch) → require confirmation flag + expected mode + idempotency key server-side. (`approve/route.ts:7-14`) *(high)*
- **`paperMode` is purely derived from `activeBroker==='test'` (`db.ts:626-628`)** — the client "Switch to Brokerage?" danger dialog changes nothing server-side → remove dead toggle or wire real control. *(medium; misleading safety affordance)*
- **`executionState` (simulate?) and gateway (which broker) derived independently** → invariant only holds because `getPolicy` sets both in lockstep; any partial `setPolicy`/fixture can write a "paper" fill while a real gateway is selected → derive both from one `ExecutionState` + assert. (`strategy.ts:84-90/475-486`)
- **Alpaca paper/live hinges on a key-prefix heuristic + free-form `environment` body field** → verify via `getAccount()` after connect and persist the verified type. (`alpaca.ts:32,46-58`)
- Synthetic-stop fills mislabeled `'live'` for broker-hosted *paper* accounts → broker-paper pollutes the live scorecard → derive FillSource from full ExecutionState. (`synthetic-stops.ts:73`)
- `test/alpaca-ping.ts` is a runnable real-network broker script in `test/` with no paper guard → move to `scripts/`, gate behind env opt-in. *(low)*

### Risk controls & policy enforcement
- **No circuit breaker / drawdown / daily-loss halt; dead kill-switch wiring** → add a portfolio guard each tick. (`scheduler.ts`, `types.ts:89-99`) *[= Top 7]*
- **Allowed-universe gate blocks exits** → skip universe/blocklist for sell/cover. (`policy.ts:29-31`) *[= Top 10]*
- **Dollar-amount sell/cover bypasses the over-sell/over-cover guard** (`quantity===undefined` → check returns false) → can flip position direction → convert dollarAmount to implied shares vs holdings. (`policy.ts:86-88,187-201`) *(high)*
- **`cover` side counts as 0 notional in both cap functions** (`isBuy = buy||short`) → cover spend evades the rolling-hour breach/auto-revert once shorting is enabled → exhaustive 4-side switch + test fixture. (`db.ts:993,1021`) *(high)*
- **Per-order notional cap absent by default** (only `maxOrderPctOfNav:5`); validation skipped when `maxOrderNotional` undefined → a single order can exceed the whole daily budget → ship a concrete default + validate %-of-NAV against daily. (`defaults.ts:31-57`)
- **`maxProposalsPerRun` is a soft LLM hint, not a server clamp**; proactive exits stack on top → enforce as a hard cap on opening proposals in the run loop. (`strategy.ts:170-173`)
- Synthetic-stop exits have no per-tick throttle and are invisible to cap accounting → add a max-exits-per-tick cap + audit. (`synthetic-stops.ts:157-184`)
- Gross/net/short exposure caps divide by `totalMarketValue`, which short proceeds inflate → self-defeating in the short regime → use a stable equity basis (cash + long MV − short MV). (`policy.ts:103-153`)
- Crisis-regime cap keys off an LLM-supplied `entryMarketRegime` substring match → bypassable by a mislabeled/empty string → evaluate against system-computed regime, enum not substring. (`policy.ts:203-225`)
- Sector cap silently no-ops when sector unknown → fail closed or bucket as "Unknown." (`policy.ts:155-158`)
- Notional caps under-represent open-short tail risk (anchored to entry, loss unbounded) → size short caps on current mark-to-market liability. (`policy.ts:43-110`) *(low)*

### LLM agentic loop & proposal generation
- **Bull and bear `JSON.parse` are unguarded** → a truncated/malformed model response (likeliest when output is long) throws and fails the *whole* autonomous run, discarding already-valid bull proposals → try/catch + reuse `fallbackToBull`/`fallbackProposal`. (`strategy.ts:1023,1190`) *(high)*
- **No spend/call-count cap anywhere** (only per-call output tokens); red-team fan-out scales with proposal count; no 429 backoff → uncapped bill + uneven degradation under throttling → per-run/per-day budget + bounded retry + bounded fan-out. (`strategy.ts`, `red-team.ts`, `llm-request.ts`) *(high)*
- **Bear/red-team layer fails OPEN**: every bear failure → un-critiqued bull proposals; every debate failure → `rejected:false`. Plus `bearSystemPrompt` joined with literal `'\\n'` (run-together prompt) → decide fail-open vs closed, tag skipped-critique proposals, fix the `\n` bug + test. (`strategy.ts:1044,1178-1196`, `red-team.ts:117-152`)
- **LLM `confidenceScore` never range-validated** (schema has no min/max, `sanitizeProposals` ignores it) → feeds sizing (÷100) and the calibration scorecard; only saved by a downstream clamp → clamp to [1,100] in sanitize + schema bounds. (`strategy.ts:939,431`)
- **Raw user "memory" interpolated into the system prompt unescaped** — a user message can mint a `[HARD]` line the prompt is told to "honor absolutely"; `</user_memory>` not escaped → strip `[HARD]`/delimiters/newlines, render as quoted data. (`chat/prompt.ts:30-35`, `memory/salience.ts:71`) *(security)*
- **Tool results `JSON.stringify`'d back to the model with no size/shape cap**; kb chunks from ingested filings/news re-enter unbounded → injection + cost vector → truncate, wrap in data delimiters, add an adversarial-injection eval. (`chat/llm.ts:217`)
- chat→proposal promotion doesn't bound LLM qty/notional before staging; relies entirely on downstream caps that may be unset → add an absolute sanity ceiling in `chatDraftToProposal`. (`promote-draft.ts:18-19`)
- Deterministic intent router (Mock-mode default) mis-classifies "buy 5 minutes" as an order and treats CEO/ETF/USA as tickers → tighten regex, validate symbols vs universe. (`chat/llm.ts:25-69`)

### Persistence & data integrity (SQLite)
- **`executeProposal` non-atomic claim** → duplicate real orders. (`strategy.ts:483/600`) *[= Top 4]*
- **No `busy_timeout` PRAGMA with WAL** → overlapping writers throw `SQLITE_BUSY` immediately (500s, or mid-sequence aborts leaving fill-without-snapshot) → `db.pragma('busy_timeout=5000')` + `synchronous=NORMAL`. (`db.ts:41-49`) *(high)*
- **Fill + snapshot writes not transactional, no idempotency key on (proposal_id, source)** → crash mid-sequence desyncs P&L; retry double-books → wrap in `db.transaction()` + UNIQUE/INSERT OR IGNORE. (`strategy.ts:559-612`, `db.ts:1304`) *(high)*
- **No migration framework — additive ALTER-only, no version stamp** → documented `taxation_type NOT NULL` break across worktrees; existing DBs can't converge a tightened column → `PRAGMA user_version` + ordered migrations. (`db.ts:51-366`) *(high)* *[also Architecture, Operational]*
- **Daily cap window uses server-local midnight (`setHours`), not ET/market day** → on a UTC prod box the cap resets ~7-8pm ET, splitting/merging a session, allowing up to 2x intended daily notional → anchor to America/New_York + test under a non-local TZ. (`db.ts:980-981`) *(reported as both medium present-bug and design-risk; merged)*
- **ENCRYPTION_KEY falls back to per-process `randomBytes(32)`** → every restart makes all stored broker/API secrets undecryptable; `decryptValue` returns `''` silently → fail fast if key missing while ciphertext exists; never auto-generate. (`db.ts:1628-1658`) *(merged across Persistence/Security/Operational; appears 3x)*
- FKs never enforced (no `foreign_keys` pragma, no FK declarations); `deleteConnectedAccount` orphans fills/snapshots that still feed P&L → enable pragma or add explicit cleanup. (`db.ts:1898`)
- `getDb()` singleton pins DB to first-seen `DATABASE_URL` → import-order can make a test write the dev `data/app.db` → export `resetDb()`. (`db.ts:33-49`) *(low)*
- `market_data_demand` fulfill + counterfactual maturation use read-then-write without a transaction → duplicate dashboard events (non-money) → fold into `db.transaction()`. (`db.ts:569-872`) *(low)*

### Market data providers & enrichment cascade
- **NASDAQ screener prices are always `stale:true` but the flag is read nowhere** → last-close prices mark the paper portfolio and feed the LLM as if current → thread staleness to UI/prompt, gate sizing on a real freshness check. (`market.ts:422`, `strategy.ts:1219-1226`) *(high)*
- **Enrichment cache is process-global keyed `provider:symbol` with no userId** → in multi-tenant, user A's keyed-provider data (and quota) serves user B; source attribution wrong → add a key/user discriminator to the cache key. (`data-providers.ts:125`) *(high, security)*
- **Dead "mock" fundamentals tier still shipped & exported** (`MOCK_METRICS`, `getFallbackMetrics`, `mockEnrichmentProvider`) — fabricated P/E + fake headlines, one `providers.push()` from going live, contradicting the documented "no mock tier" invariant → delete or move to test fixtures. (`data-providers.ts:127-249`) *(reported twice; merged)*
- Source-attribution type drift: cascade stamps pbRatio/beta/52wk/shortFloat sources the public `EnrichmentSources` union can't carry → provenance silently lost → unify the two unions. (`data-providers.ts:58-82` vs `types.ts:241-246`)
- Cross-provider unit inconsistency for dividend yield / D/E (Yahoo ×100, Finnhub raw, Webull guess) → first-wins can mix percent and ratio scales → 100x-wrong displayed yield → normalize at provider boundary + plausibility clamp. (`data-providers.ts:766,912-913,420-423`)
- Partial provider failures collapse to `{}` → "outage" indistinguishable from "genuinely no data," neutral-50 defaults feed scoring → track per-provider status, surface "enrichment degraded." (`data-providers.ts:272` + per-provider catches)
- Module-global screener cache + YF creds, no single-flight → thundering-herd scraping of unofficial endpoints can get the deployment IP-blocked (removes the keyless floor) → coalesce concurrent cold-cache fetches + jittered backoff. (`market.ts:39-45`, `data-providers.ts:662`)
- Missing intraday change parses to `0%` → treated as "flat," skews breadth/momentum → parse to `undefined`. (`market.ts:76-79`)
- AlphaVantage sentiment override matched by hardcoded provider-name string, fires on stale cached values → drive off a confidence field. (`data-providers.ts:335-343`)
- Webull provider uses `eval('require')` + `execFile` of env-controlled python paths in the web server; no plausibility bound on returned price → allowlist script path, clamp price. (`data-providers.ts:466-513`) *(low; off by default)*

### Concurrency, scheduling & race conditions
- Stop-monitor double-fire (Top 5); `executeProposal` race (Top 4) — *see above.*
- **Interval lane + event-trigger lane share no run-coordination in `TRIGGER_MODE=both`** → roughly double the intended run frequency (and LLM cost, and orders); lock prevents simultaneity, not back-to-back → unify on one persisted last-run timestamp both lanes read. (`scheduler.ts:84-108`, `triggers.ts:119-145`) *(high)*
- **Scheduler cadence state in-memory only + immediate tick on boot** → every restart/HMR/build fires a fresh run regardless of cadence → rehydrate `lastRunAt` from `strategy_runs`. (`scheduler.ts:19-35`) *(high)* *[= Top 3 amplifier]*
- `scheduler.ts` `timer` and `web-sources` `refreshInFlight` are plain module `let`s, NOT `globalThis`-pinned like `events.ts`/`triggers.ts` already are → Next module-instance duplication / HMR defeats the single-start guard → two `setInterval` loops, doubled background work. (`scheduler.ts:18`, `web-sources/index.ts:90`) *(team has hit this exact class before — see `events.ts:33-34`)*
- `checkRegimeFlip` non-atomic read-modify-write on a shared KV + only ever runs for user `'local'` → duplicate regime-flip broadcasts can trigger duplicate runs for all users → make the flip a single transaction. (`regime-watch.ts:25-42`)
- Trigger `fire()` has no in-flight guard → forced + timer fire can overlap, double-incrementing cooldown counters → add a per-user `firing` boolean. (`triggers.ts:99-145`) *(low)*
- Webhook/event dedup is in-memory, lost on restart → TradingView replay after restart re-ingests → persist dedup keys with TTL. (`webhooks/tradingview/route.ts:60`) *(low; can't place orders directly today)*

### Security: secrets, auth, SSRF, webhooks
- **Unauthenticated mutating routes + attacker-chosen userId** → place/cancel real orders, change policy, read/write any user's keys. (`request-user.ts`) *[= Top 1]*
- **Admin routes fully open when `NODE_ENV !== 'production'`** (the dev previews) — `robinhood-probe` dumps raw brokerage data; token compare is non-constant-time → require token unconditionally + `timingSafeEqual`. (`app/api/admin/*/route.ts:9-15`) *(high)*
- **Telemetry secret-masking regex misses Alpaca AK/secret, Apify, generic keys** → live brokerage creds in inline error text/URLs ship to Langfuse in cleartext → redact by entropy/length, not a prefix enum; add tests. (`telemetry-sanitize.ts:2-3,129-132`) *(high)*
- **`setup-agent-previews.sh` copies live `.env.local` (broker keys, ENCRYPTION_KEY) into all 3 previews** → 3x credential blast radius, each preview auto-starts the scheduler/streams → minimal Test-mode-only env per preview, or Infisical per-worktree. (`setup-agent-previews.sh:39-41`) *(high)*
- **`GET /api/keys` leaks which services are configured to any unauthenticated caller; POST/DELETE write/delete any user's keys** → enumeration + plant-attacker-keys → gate behind real auth, scope to principal. (`app/api/keys/route.ts:99-186`)
- OAuth client secret + tokens stored via `setInternalSetting` in **plaintext** (not run through `encryptValue`); expired-token-without-refresh returns the stale token → encrypt at rest, fail loud on unrefreshable. (`mcp-oauth.ts:98-183`)
- TradingView webhook secret travels in the JSON body (not HMAC), replayable, no nonce; attacker-controlled `symbol` written to audit unsanitized → HMAC + timestamp/replay window. (`webhooks/tradingview/route.ts:35-57`)
- `politeFetch` follows absolute URLs parsed from SEC data with no host allowlist, no private/metadata-IP block, `redirect:'follow'` → SSRF-via-data defense-in-depth gap → pin to sec.gov, block private ranges. (`web-sources/sec8k.ts:151-194`, `http.ts:36-60`) *(low likelihood; trusted sources today)*

### Architecture / structural debt
*(See dedicated callouts below — listed here for completeness.)*
- **god files**: `db.ts` (2330 lines, 91 exports, all 20 schemas + risk-accounting + persistence), `dashboard-client.tsx` (2978 lines, 42 `useState`, 14 endpoints), `strategy.ts` (`proposeTrades` ~524 lines, `runStrategyOnce` ~333) — all three are multi-agent merge-conflict magnets on the highest-risk code → decompose.
- **committed iCloud "* 2.*" conflict files** — type-checked AND run as tests, some diverged from canonical siblings → delete + exclude in configs.
- **TradeProposal construction trap** — 24 construction sites, required fields + 4 OrderSide branches enforced only by prose → `makeTradeProposal()` factory + exhaustive `switch(side)` with `never` default.
- from-draft promotion: check-then-insert with no UNIQUE on `run_id` → race duplicates approvable proposals → UNIQUE index on (user_id, run_id) or wrap in a transaction. (`from-draft/route.ts:90-110`)
- `getBrokerGateway` **defaults unknown/undefined `activeBroker` to the live Robinhood gateway** — wrong failure direction for an optional field present in legacy policies → default to Test; untested. (`broker.ts:5-15`)

### Error handling, observability & failure recovery
- Order-before-record orphan (Top 6) + no orphan reconciliation — *see above.*
- **LLM fetches have no timeout/AbortController** → a half-open OpenAI connection hangs `runStrategyOnce`, holding the per-user lock up to 5 min, starving the tick (MAX_CONCURRENCY=3); no alert because nothing errors → `AbortSignal.timeout(30-60s)`. (`strategy.ts:1003,1169`, `red-team.ts:108`, etc.) *(high)*
- **Robinhood MCP order placement: no timeout, no idempotency on ref_id** → ambiguous hang + retry can double-submit a live order → timeout + query-by-ref_id before any resubmit. (`robinhood.ts:291-318`) *(high)*
- **Manual approve bypasses the strategy lock** → a scheduled run + a human Approve both read pre-trade notional and both execute, breaching caps → acquire the same lock in `executeProposal`. (`strategy.ts:470-633`) *(high; overlaps Top 4)*
- **Alpaca trade-updates stream loses fills on disconnect — no resync on reconnect**; Robinhood has no stream, reconciles only on an active strategy run → pending live fills sit unbooked while halted/paused → call `reconcilePendingFills` on reconnect + a scheduler reconcile that runs even when not active. (`streams/alpaca-trade-updates-stream.ts:59-118`) *(high)*
- All alert/notification delivery fails silently to the audit table — `kill_switch`/`run_failed` go through the same best-effort path → operator never told the kill switch fired → bounded retry + "all channels failed" alarm + startup verification. (`notify.ts:206-237`, `strategy.ts:389-393`)
- `checkPriceAlerts` empty-catches quote failures and returns `[]` → a persistent outage disables all alerts invisibly (same pattern in `synthetic-stops.ts:78,124`) → log/audit + consecutive-failure tracking. (`alerts.ts:74-79`)
- Observability no-ops silently when unconfigured (the default); `warnOnce` suppresses all repeat tracing failures for process life → log the unconfigured state, rate-limit instead of once-ever. (`observability.ts:44-156`)

### Testing & QA
- **No CI active** (`ci-pending/` never moved); no git hooks → only gate is manual, run by 3+ parallel agents → `git mv` into `.github/workflows/`, make `verify` a required check. *[= Top 8]*
- **`executeProposal` untested**; `getBrokerGateway` untested; the new **from-draft route guards** (halted→409, universe→400, dryRun, idempotency) untested (uncommitted, merging soon) → add the executeProposal sim-vs-live tests + route/integration tests.
- No negative test that a *blocked* policy decision actually prevents the broker call at execution time (the two halves are tested in isolation). (`strategy.ts:557` vs `:599`)
- Playwright e2e excluded from `npm test`, `@playwright/test` not in `devDependencies` (import would fail on clean install), smoke test asserts only static text → add the dep, run in CI, exercise a real propose→approve→fill round trip.
- Stale "* 2.test.ts" duplicates — two diverged, all silently uncollected → delete. (matches structural-debt callout)
- `history.test.ts` / `web-sources-technical.test.ts` hit live Yahoo/stooq (no fetch mock) → flaky on CI → `vi.stubGlobal` or move to `*.integration.test.ts`.
- CLAUDE.md note about the `alternative-data.test.ts` tsc error is now **stale** — it was silenced with `url: any` (line 185), which also disables type-checking of the mock signature → type it properly + update the note.
- `alpaca-ping.ts` / `scratch.ts` ad-hoc live-broker probes live in `test/` → move to `scripts/`.

### Operational & multi-agent dev process
- Autonomy auto-starts on boot off DB state (Top 3); ENCRYPTION_KEY ephemeral-random (merged into Persistence) — *see above.*
- **Production carries forward DB-resident `systemState` with no enforced "land in halted/Test" gate** — "prod on Test, autonomy halted" is a manual habit (STATUS.md), not code; a restart resumes whatever the DB last said → env-flag autonomy gate + post-deploy health check asserting mode. *(high)*
- **Litestream replicates a WAL DB while the app keeps WAL journaling; `restore -if-db-not-exists` silently no-ops on an existing-but-corrupt DB** → backup may not be there when needed, failure is silent → Litestream owns the prod DB, add `PRAGMA integrity_check` + periodic test-restore + last-snapshot-age alert. *(high)*
- `.env.local` (53 lines) drifts from `.env.example` (152); ~70 documented vars absent; no boot validation; previews frozen at a one-time copy → add a zod env schema at startup, re-seed from one source. *(high reported; mostly cost/behavior drift)*
- Relative `DATABASE_URL`/`LITESTREAM_DB_PATH` resolve against cwd + auto-create-on-missing → a wrong-cwd launch silently fabricates a blank ledger / backs up the wrong file → absolute paths + log resolved path + assert prefix.
- Hand-rolled ALTER-if-missing migrations, no version stamp, `dry_run→paper` UPDATE on every boot → high collision risk across parallel agent branches → `user_version` + ordered append-only list. *(= the migration callout)*
- "A running port is not a work lock" + no merge lock → concurrent agent merges can interleave migrations and money-path edits into a `main` that compiles but combines two half-finished changes → money-path files land only via human-reviewed PRs + full trio on the *merged* result.
- Litestream/Infisical/gitleaks are optional host CLIs with ENOENT-only guards; `LITESTREAM_REPLICA_URL` absent from `.env.local` → backup can be "shipped" yet never running → in-repo supervisor unit + liveness check.
- `npm run build` wiping `.next` under a live PM2 dev server → misleading stale/ENOENT previews → build detects running dev server / builds to a separate dir. *(low; dev-only, recoverable)*

---

## Structural Debt Callouts (change-amplifiers)

**God files** (all merge-conflict hotspots on the riskiest code; 3 agents edit them in parallel):
- `src/lib/db.ts` — 2330 lines, 91 exports, 20 schemas, ad-hoc migrations **and** the daily/hourly notional risk-accounting all in one file. Split: `schema/migrate`, `proposals`, `settings`, `api-keys`, `risk-accounting`, `memory/rag`.
- `app/dashboard-client.tsx` — 2978-line single client component, 42 `useState`, 14 endpoints, the human's only real-money control surface. Extract hooks + per-panel components; isolate approve/reject/start/stop handlers into a tested module.
- `src/lib/strategy.ts` — `proposeTrades` ~524 lines, `runStrategyOnce` ~333, the LLM→order pipeline. Decompose into `buildPrompt / callLlm / parseProposals / applySizing / sanitize / fallback`.

**Committed iCloud "* 2.*" conflict files — CONFIRMED present (27 on disk):**
- gitignored (`.gitignore:36`) so they won't commit, **but** `tsconfig.json` (`include: **/*.ts`) type-checks them and `vitest.config.ts` (no explicit `include`) **runs** `test/vector-db.test 2.ts`, `web-sources.test 2.ts`, `web-sources-sec.test 2.ts`, `web-sources-finra.test 2.ts`.
- `vector-db.test 2.ts` and `web-sources.test 2.ts` (and `macro-history 2.ts`, `massive 2.ts`) have **diverged** from their canonical siblings — an agent reading the " 2" copy would re-introduce already-fixed bugs (e.g. caching empty FRED results). *(Note: one testing agent found 4 "* 2.test.ts" silently uncollected because vitest's glob doesn't match a space-before-2 filename; the structural agent found 27 "* 2.*" and reports 4 of them DO run. The two reports disagree on whether the duplicate tests execute — verify with `npx vitest list | grep ' 2'` before relying on either.)* (unverified — collection behavior)
- Fix: `find . -name '* 2.*' -not -path './node_modules/*' -delete` (after confirming none are tracked) + add `**/* 2.*` exclude to both `vitest.config.ts` and `tsconfig.json`.

**Cross-file consistency traps (CLAUDE.md-documented, enforced only by tribal knowledge):**
- `TradeProposal` requires `tradeThesisTag` + `entryMarketRegime`; 24 construction sites (15 in tests). → `makeTradeProposal()` factory.
- `OrderSide` = buy/sell/short/cover; `db.ts:993,1021` already drops `cover` from notional accounting (confirmed bug above). → exhaustive `switch(side)` + `never` default everywhere risk/P&L/persistence touch side.
- Per-field enrichment sourcing must thread through 5 places; the pbRatio/beta/52wk/shortFloat union drift (above) is a live instance. → single shared sourced-field type.
- "Never label real data mock/fallback" — the still-exported `mockEnrichmentProvider` is a loaded gun against this invariant.

---

## Quick Wins vs. Deep Fixes

**Same-day (config / one-liner / localized):**
- `git mv ci-pending/*.yml .github/workflows/` and make `verify` a required check. *(highest ROI)*
- `db.pragma('busy_timeout=5000')` (+ `synchronous=NORMAL`). One line, kills intermittent SQLITE_BUSY 500s.
- Delete all `* 2.*` files + add `**/* 2.*` excludes to vitest/tsconfig.
- Fail fast at startup if `ENCRYPTION_KEY` is missing while ciphertext exists (stop the silent-credential-wipe).
- Wrap bull/bear `JSON.parse` in try/catch reusing existing fallbacks.
- Clamp `confidenceScore` to [1,100] in `sanitizeProposals` + schema bounds.
- Fix `bearSystemPrompt` `'\\n'` → `'\n'`.
- `AbortSignal.timeout()` on every LLM and Robinhood-MCP fetch (the pattern already exists in `notify.ts`).
- Skip the allowed-universe/blocklist check for sell/cover sides.
- Add `cover` to the notional-cap branches.
- Delete `MOCK_METRICS`/`mockEnrichmentProvider` (or move to test fixtures).
- Strip live broker keys from the preview `.env.local` copy in `setup-agent-previews.sh`.
- Constant-time admin-token compare + drop the `NODE_ENV` bypass.

**Deep / needs design work:**
- **Authentication layer** (`middleware.ts` + principal-derived userId) — gates nearly the whole Security theme; prerequisite for multi-user.
- **Atomic execution claim + transactional fill/snapshot + persist-refId-before-broker-call + orphan reconciliation** — the duplicate-order / orphan-order cluster (Top 4/5/6) is one coherent redesign of the execution critical section, ideally one execution lock shared by run-loop and approve.
- **Portfolio circuit breaker** (drawdown/daily-loss → close_only/halt) + wiring the dead kill-switch — new RiskRules fields + per-tick evaluation (Top 7).
- **Route synthetic stops through the full risk/sim gate** + re-entrancy guard + CAS trigger + reconciled fills (Top 2/5/9) — touches the protective-exit path end to end.
- **Deploy-time autonomy switch** independent of DB state (Top 3) + post-deploy mode health check + Litestream integrity/test-restore.
- **Versioned migration framework** (`user_version`, ordered, transactional) — unblocks safe multi-agent schema evolution.
- **Unify run-coordination** (single persisted last-run clock across interval + trigger lanes; rehydrate cadence from `strategy_runs`; `globalThis`-pin scheduler timer).
- **One ExecutionState as source of truth** for simulate-flag + gateway + FillSource (+ verified Alpaca account-type lookup), replacing the two-valued `paperMode`.
- **God-file decomposition** of `db.ts` / `dashboard-client.tsx` / `strategy.ts` — reduces the merge surface that lets money-path regressions slip through.
- **Treat injected text (user memory + tool/kb results) as untrusted data** — escaping + delimiters + adversarial evals.
---

## Addendum — Top-5 Adversarial Verification (2026-06-21)

Five independent skeptics each tried to *refute* one of the Top-5 by reading the
real code. Four confirmed, one was substantially overstated, and two severities
were corrected downward.

| # | Finding | Verdict | Severity (orig → corrected) | Likelihood |
|---|---------|---------|------------------------------|------------|
| 1 | Unauthenticated mutating routes / caller-chosen `userId` | **Confirmed** | crit → **high** | high |
| 2 | Synthetic stops place real orders with no risk gate | **Partly — overstated** | crit → **low** | low |
| 3 | Scheduler auto-starts on boot off a copyable DB value | **Confirmed** | crit → **medium** | low |
| 4 | `executeProposal` double-execution (non-atomic claim) | **Confirmed** | **high** | medium |
| 5 | Synthetic-stop monitor re-entrancy → double-fire | **Confirmed** | **high** | medium |

### #1 — Auth (confirmed, high)
No `middleware.ts`, no session/token/header auth anywhere; `userId` is fully
caller-controlled (`x-user-id` header → `userId` query → body → default
`"local"`). ~28 mutating handlers ungated, plus IDOR across all per-user data.
**Corrections:** `GET /api/keys` *masks* values (no raw cred exfiltration), and
cross-user *real-money* trading requires the victim to already have a live broker
connected **and** `paperMode` flipped to false. Universally-reachable harm =
policy tampering (`PUT /api/policy` spreads arbitrary body keys), IDOR, and key
overwrite/delete (DoS). **Fix:** real auth layer (middleware deriving a trusted
principal); until then don't expose over the tunnel without an upstream auth
proxy.

### #2 — Synthetic stops "ungated" (overstated, low)
The sim guard *is* the gateway abstraction: `getBrokerGateway` routes on
`policy.activeBroker`, and in the paper-default Test posture that returns the
fully-simulated `TestBrokerGateway` — **no real order is placed by default.**
Exits also only fire after an explicit Start (`systemState === "active"`), caps
gate *opening* orders (not exits), and the exit *is* persisted + audited. The
genuine residual gap is narrow: a **live-mode** protective close skips a fresh
tradability/halt re-check at fire time. **Fix:** re-check halt/`close_only` +
`getEquityTradability` just before the `placeEquityOrder` in
`runSyntheticStopMonitor`.

### #3 — Boot auto-start (confirmed, medium / low likelihood)
The scheduler does auto-start on every boot (`instrumentation.ts`) with no
env/deploy switch, gated only on DB values. **Corrections:** a *real* order on
resume also needs `systemState=active` **and** `strategyAuthority=decide`
(default `propose`) **and** a non-test active account with decryptable creds +
`agentic_allowed`. `systemState` defaults to `halted`, so this is a
resume-of-armed-state risk, not fresh-install. **Fix:** boot-time interlock —
require an explicit `AUTONOMY_RESUME_ON_BOOT` env opt-in (or a per-boot armed
token) before any non-simulated order; otherwise force-revert `active`→`halted`
on boot and audit.

### #4 — `executeProposal` double-execution (confirmed, high)
Every load-bearing claim accurate: the `status==='proposed'` guard is a
non-atomic read, the broker `placeEquityOrder` runs before `updateProposalStatus`
(no status-based CAS), and the per-user strategy lock does **not** cover the
manual approve path — with ~5 `await` points between guard and broker call, the
race window is large. The client `busy` flag blunts one-tab double-clicks only;
two tabs / curl / from-draft all race with zero server protection.
**Fix:** atomic CAS claim before the broker call —
`UPDATE trade_proposals SET status='executing' WHERE id=? AND status='proposed'`,
proceed only if `changes === 1`.

### #5 — Synthetic-stop re-entrancy (confirmed, high)
The monitor is scheduled fire-and-forget every 60s tick with no in-flight guard;
the active-stop read and the post-order status flip are not atomic, so a slow
broker call lets the next tick re-place the same exit. **Corrections:** needs
broker latency approaching the tick interval, and Test mode returns no positions
so it only bites Paper/Live; the per-call random `refId` actively defeats
Alpaca's `client_order_id` dedupe. **Fix:** per-user in-flight guard in the
scheduler + a CAS stop claim (`UPDATE … SET status='triggered' WHERE id=? AND
status='active'`) before placing, and a deterministic `refId` per stop+trigger.

---

## Actioned (2026-06-21)

First quick-win batch landed via PR on branch `chore/safety-quick-wins`
(see `docs/rollouts/2026-06-21-safety-quick-wins.md`):
`busy_timeout`/`synchronous` PRAGMAs, bull/bear `JSON.parse` guards, the
`bearSystemPrompt` `\n` join fix, `confidenceScore` clamp + schema bounds, and CI
workflow activation. The deep fixes (auth layer, execution-section CAS/atomicity,
portfolio circuit breaker, boot interlock) remain open.
