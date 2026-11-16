# Fleet Review — 2026-07-28 (Kimi Work, 6-agent parallel review)

**Context & Objective:** Owner-requested full-app review by a team of agents across six lanes:
trading intelligence, web/mobile-web UX, iOS parity, interoperability, engineering & LLM
efficiency, and ops/reliability/security. Read-only; no code changed. Reviewed on branch
`agent/antigravity/fix-mock-tests` @ merge `6cfab913` (~61 commits behind `origin/main` —
the 2026-07-26/27 free-first enrichment cascade and PR #2182/#2230 landed after this branch
point; core strategy/risk/scheduler files were unaffected per their rollout notes).

**Method:** 6 read-only explore agents, each with a defined lane, all findings required
file:line evidence. This document synthesizes their reports; effort key: S ≈ hours–1 day,
M ≈ days, L ≈ week+.

---

## Executive summary

The architecture is genuinely strong: deterministic protective exits before LLM judgment,
fail-closed Red Team review, gated autonomous weight tuning, balanced counterfactual
learning, real point-in-time discipline in the backtester, a reference-grade congress.trade
integration, disciplined LLM budget enforcement, and deep health/auth/SSRF hardening.

**The systemic weakness is enablement and measurement, not construction.** Nearly every
protective and adaptive feature is built, tested, and off by default — and nothing in CI
measures whether the strategy's edge is improving or decaying. The same pattern repeats in
UX (a built-but-unwired settings search, an orphaned needs-attention inbox, an
undiscoverable `/mobile` PWA) and interop (strong internal sync engine, no consumer
credentials on the outer surface).

### The five highest-leverage moves (cross-lane consensus)

1. **Wire the eval harness into CI** (`eval:offline` / `eval:strategy-offline` /
   `eval:congress-score` exist, exit non-zero on gate failure, but no workflow runs them).
   Every scoring/prompt/learning change currently merges on type-checks alone. S–M.
2. **Close the deploy-stop-protection gap**: every auto-deploy re-halts autonomy and the
   synthetic trailing-stop monitor does not run while `halted` unless `protectWhileHalted`
   is set (no default). Positions relying on app-side stops are unprotected from deploy to
   manual re-enable. Either default `protectWhileHalted: true` or run the monitor during
   post-boot halt. S. (`scheduler.ts:281-336, 708-720`)
3. **Enable the proven capital-protection guards** (currently opt-in/off): correlation-
   cluster gate, portfolio heat, vol-target taper, quote/fundamentals staleness gate,
   regime-flip-triggered run, drawdown-breaker enforcement. Staged via the existing
   dormant-features board. S per flag. (`strategy-risk.ts:449-499`, `correlation.ts`,
   `policy.ts:384-398`, `docs/event-driven-llm-triggering.md`)
4. **Per-user API tokens** (hashed, scoped, revocable — patterns already exist in
   `db-api-keys.ts`): unlocks external dashboards, signed SSE, export, and half of an MCP
   server. The single highest-leverage interop gap. M.
5. **Trace the tagged-veto path (R4) before any further auto-trading expansion**:
   deterministic bear-filter vetoes are now tag-not-drop with an owner-ratification flag
   pending; unverified whether every tagged veto forces the human-review queue on
   auto-trading accounts. Verification only. (`strategy.ts:154-165`)

---

## Lane 1 — Trading intelligence

How it works today (evidence in agent report): 60s leader-elected tick; non-LLM safety
maintenance every tick (synthetic stops, stale exits, fill reconcile); strategy runs =
scan (8 hand-weighted factors, ~30 candidates) → deterministic protective exits → learning
context → LLM proposals → deterministic sizing → Red Team → placement; learning is
assembled into prompts but advisory-only; outcome engine matures decision cases at
15m/1h/1d/1w; autonomous tuning is heavily gated (step clamp, OOS IC ≥0.005, ICIR ≥0.2,
≥4 test dates, revert ledger).

**Prioritized opportunities:**

| # | Item | Effort |
|---|---|---|
| 1 | Eval harness into CI (nightly or PR-triggered IC/OOS regression gate) | S–M |
| 2 | Flip proven guards to default-on (staleness gate + heat + correlation first) | S/flag |
| 3 | De-bias momentum away from the 15-min-delayed screener (decay intraday leg by quote age; `market.ts:63-104`) | S–M |
| 4 | Replace binary diversification factor (`positionMarketValue > 0 ? 45 : 80`) with real book correlation from existing `correlation.ts` machinery | M |
| 5 | Trigger a close-only review run on regime flip (plumbing exists, deferred) | S |
| 6 | Include per-holding entry thesis in exit prompts (`activeProtection` lacks it; `strategy.ts:4564-4668`) | S |
| 7 | Side-aware quotes for sell triggers — stops/TPs evaluate a 0.6-ask composite but sells realize the bid; systematic few-bp-per-exit leak (`market.ts:48`) | S |
| 8 | Make learning net-of-cost everywhere (live scorecards and counterfactuals are gross; fee columns unpopulated in `decision_cases`) | S–M |
| 9 | Reconcile congress-score weights code-vs-doc (memberSkill weight 0 in code, 20 in doc) and fix the 14-day fail-open gate cache (`congress-score-gate.ts:25-37`) | S |
| 10 | Short-side last mile before any live shorts: tick-level TP, broker-held buy-stop lane, margin/PDT modeling (`synthetic-stops.ts:112-115`, `broker-protective-stops.ts:634`) | M |
| 11 | Apply per-regime factor weights through the existing OOS tuning gates (highest-alpha item; do after #1) | M–L |
| 12 | Hard-certify walk-forward universe resolution against survivorship (currently soft advisory, `backtest.ts:266-273`) | M |

**Money-loss red flags:** drawdown breaker advisory by default + vol brake only inside
runs (R1); shorts structurally under-protected (R2 — keep paper-only); ask-biased sell
triggers (R3); tag-not-drop vetoes untraced (R4); budget enforcement fails open (R5);
proposal revalidation reaffirms on ambiguity (R6); margin/leverage/PDT unmodeled on live
path (R7); congress gate silently stops gating after 14 days stale (R8); positions that
fall out of the 30-name scan set — stop coverage fallback untraced (R9, verify).

---

## Lane 2 — Web & mobile-web UX

Surface map: `/` redirects to `/console` (the real app, 14 destinations); `/admin`
operator diagnostics; `/mobile` a full 1,031-line PWA control surface **linked from
nowhere**; marketing pages flag-gated. Desktop console is polished; approve flow is tight
(2–3 clicks).

**Prioritized improvements:**

| # | Item | Effort |
|---|---|---|
| 1 | Reinstate `NeedsAttention` inbox on console home — fully built, imported by zero pages, flagged P0 in the 2026-07-04 composite review, README still claims it's on Home | S |
| 2 | Wire `settings-search.ts` (390-line index with synonyms + old→new glossary) into the Settings page header and/or command palette — currently referenced only by tests | S/M |
| 3 | Resolve `/mobile` strategy: link it or retire it for the responsive console | S |
| 4 | First-run setup checklist (connect broker → universe → guardrails → arm); readiness data already exists | M |
| 5 | Upgrade `Empty` primitive with icon + CTA to the fixing destination (~20 call sites) | S |
| 6 | 44px touch targets: chrome triggers, 28px watch stars, 16px bulk checkboxes | S |
| 7 | Watchlist mobile card layout (only surface still using horizontal-scroll table) | S/M |
| 8 | Sort control for mobile scan cards (fixed-order today) | S |
| 9 | Touch-accessible explanations — the entire explanatory layer is hover-tooltips, invisible on phones | M |
| 10 | Mobile quick-jump (⌘K palette is desktop-only) | S/M |
| 11 | Mobile home ordering: pending approvals/attention above the fold | S |
| 12 | Fold `SETTINGS_GLOSSARY` into the Help glossary card | S |

---

## Lane 3 — iOS ↔ web parity

The iOS app (`ios/SocraticTrade/`, 13 Swift files, ~3,774 LOC) is a five-tab thin client
over 7 `/api/mobile/*` endpoints. **Key finding: parity is mostly not an API problem** —
every read endpoint the console uses (`/api/scan`, `/api/chat` — plain JSON, no SSE
needed, `/api/notifications`, `/api/orders/cancel`, `/api/quote`, performance, llm-usage)
is already session-compatible with the iOS cookie.

**Parity gaps, ordered by impact:**

| # | Gap | Effort |
|---|---|---|
| G1 | Cannot cancel/replace a resting order from the phone (real money) — add `orders.cancel`/`orders.replace_market` to the audited mobile command gateway | M |
| G2 | No market scan/Evidence surface — `/api/scan` exists; new tab + decode + 429 handling | L (M compact) |
| G3 | Coach has no chat — `/api/chat` returns plain JSON; replace static cards with real conversation | M |
| G4 | No notifications feed and no push — feed is S–M (endpoints exist); APNs push is L and the single biggest parity lever for an alerts-driven app | S–M / L |
| G5 | Options positions invisible — pure plumbing (snapshot route omits `options`) | S |
| G6 | Macro/regime board — backend already computes it; forward + Swift Charts sparklines | S–M |
| G7 | Equity curve + performance depth — `/api/connected-accounts/[id]/performance` exists | M |
| G8 | Close-only/liquidating buttons (commands exist, protective-classified) = S; policy numeric-caps editor = M | S / M |
| G9 | Journal / strategy-run history | M |
| G10 | Symbol drilldown with live quote (`/api/quote`) | S–M |

**iOS architecture concerns:** monolithic single-snapshot state (move secondary surfaces
to on-demand per-tab endpoints; `/api/mobile/bootstrap` exists but is never called); no
offline persistence (cache last snapshot, label stale); SSE has no backoff/jitter or
Last-Event-ID; thin error taxonomy (429/412 would render opaque); minimal test coverage
(one test file, no simulator in CI) — land store-level tests before new money-path
surfaces.

---

## Lane 4 — Interoperability

Current surface is strong internally: ~105 API routes behind a rigorous middleware auth
model, 2 inbound webhooks (TradingView, congress HMAC), 2 tenant-filtered SSE streams, a
production-grade resumable SSE consumer, the congress-trading-shared Zod-contract package,
an excellent chunked/idempotent share engine, SSRF-hardened outbound notifications, and a
unified `BrokerGateway` with a single guarded choke point.

**What's missing (outer surface):**

| # | Item | Effort |
|---|---|---|
| 1 | Per-user API tokens (hashed, scoped, rate-limited, revocable) — unlocks #2/#4/#5 below | M |
| 2 | Structured, HMAC-signed outbound webhooks on domain events (fill, proposal.pending, run.complete) with delivery log + subscription filters | M |
| 3 | MCP server exposure, read-only first (`get_portfolio`, `list_proposals`…); write verbs must route through the approval path + `withLivePreflight`, never direct to broker | M–L |
| 4 | Token-authenticated SSE for external subscribers | S–M |
| 5 | Data export endpoints (trades/proposals/audit CSV+JSON) — also fixes deletion-without-export asymmetry | S–M |
| 6 | Generalize congress-share into a reusable peer-sync module | M |
| 7 | Publish congress-trading-shared properly (GitHub Packages + semver) | S |
| 8 | OpenAPI spec for `/api/mobile/*` + generated clients | S–M |
| 9 | Extend `Idempotency-Key` to approve/bulk-approve/cancel endpoints | S |
| 10 | Generalized signed inbound signal endpoint (per-source HMAC + registry) | S–M |
| 11 | Publish `BrokerGateway` as a plug-in contract | M |

Security rules for opening up: tokens scoped so a leaked read token can never approve
trades; HMAC + timestamp + event-id on outbound webhooks; egress guard stays on every
send path; rate-limit the new public/auth-adjacent surface (none exists today on
webhooks/ops routes).

---

## Lane 5 — Engineering & LLM efficiency

Measured scale: `src/lib/` = 220 files / ~100K lines; 460 test files / ~5.4–7.8K cases
(AGENTS.md's "723 tests / 81 files" is badly stale).

**Engineering quick wins:** delete 4 zero-import deps (`@xyflow/react`, `react-virtuoso`,
`lightweight-charts`, `react-resizable-panels`); drop drizzle-orm (exists for 3 trivial
KV tables vs 109 raw-SQL CREATE TABLEs); delete/relocate root strays (`_ragproof.ts`,
`fix_quotas.ts`, `protection.json`, unignored `build/`); add an eslint `--max-warnings`
ratchet; rename `fmp-alpha/beta/gamma/delta` by responsibility; shard vitest as the suite
grows.

**Structural debt:** god modules hold ~30% of `src/lib` lines — `vector-db.ts` (7,193),
`strategy.ts` (6,391), `data-providers.ts` (6,378), `db.ts` (3,877 with 109 inline
migrations → move to `db/migrations/`, the known merge-conflict trap), `types.ts` (2,601).
God components: `console/strategy/page.tsx` (1,496 lines, 26 hooks), `console/page.tsx`
(1,200), `chrome.tsx` (1,043), `mobile-pwa-client.tsx` (1,031). Duplicated ~120-line LLM
tool loops in `chat/llm.ts` (Anthropic/OpenAI/Mock). Scheduler polls broker health every
60s per account regardless of cadence — cadence-gate non-money-path polls.

**LLM efficiency (cost/latency/quality):**

| # | Item | Effort |
|---|---|---|
| 1 | Use the already-computed deterministic intent router to answer 5 read-only chat intents with zero LLM calls (majority of casual chat spend + seconds→~100ms) | S–M |
| 2 | Static Red Team system prompt (move side/symbol to user message) — restores Anthropic prompt-cache hits across proposals 2..N | S |
| 3 | Route mechanical classification (semantic gate, salience, coach extraction) to nano-class models — currently the user's frontier chat model; worst cost-to-value ratio in the app | S |
| 4 | Unify the two parallel LLM stacks (chat hand-rolled vs strategy-grade `llm-call.ts` retries/cooldowns/structured output) | M–L |
| 5 | Cap chat tool loop (`MAX_STEPS` 5→3; truncate history after a tool fires) | S |
| 6 | RAG: skip Voyage rerank for the per-symbol `limit=1` scout pass; extend query-embed cache TTL (5 min) past the 60-min run cadence | S |
| 7 | Evals into the merge gate (MockLLM mode = zero cost) + grow the ~16-case chat dataset; prompts are already versioned for this | M |
| 8 | Batch Red Team verdicts when proposals > 1 (send shared context once) | M |
| 9 | Scheduled model-economics report joining `llm_usage` cost with per-model proposal win rates — right-size Green/Red seats on evidence | M |
| 10 | One combined "analyze this message" call for coach/salience/gate (~5 calls → 1) | S–M |

LLM discipline already present (keep): no default models anywhere, budget ceilings
enforced at spend primitives, structured outputs, per-user/day cost ledger with ~70-model
pricing table, Langfuse opt-in tracing, provider cooldown lanes.

---

## Lane 6 — Ops, reliability, security, testing

**Red flags (ranked):**

1. **HIGH (money)** — deploy drops synthetic stop protection (see executive summary #2).
2. **MEDIUM (ops)** — litestream 0.5.12 socket leak to R2 is throttled (10s sync) not
   fixed; previously wedged all deploys via `tcp_mem` exhaustion; nothing tracks re-upgrade.
3. **MEDIUM (silent outage)** — degraded-by-design `/api/health` never 503s on scheduler
   death / trading staleness / OpenRouter credit exhaustion; if the external monitor only
   checks status codes and Sentry Crons isn't enabled in prod, a wedged autonomy loop
   looks green. Verify `SENTRY_CRONS_ENABLED=1` in prod.
4. **MEDIUM-LOW (security)** — public `/api/health` leaks release sha, OpenRouter credit
   USD balance, DB internals, litestream state. Fold behind the ops token; public =
   booleans only.
5. **MEDIUM-LOW (data)** — `audit_events` has no retention/prune; unbounded growth in the
   single replicated SQLite file.
6. **LOW (process)** — Playwright smoke no longer gates PRs; UI breaks surface after
   auto-deploy.

**Other actions:** run + automate the litestream restore drill (admitted never closed
out); coverage tooling + floor for money-path modules (no coverage script exists); hunt
remaining network-touching tests (sec.gov flake pattern); finish `IMPROVEMENTS-2026-07-07.md`
items #1/#2 and commit the doc into `docs/`; rate-limit mobile auth exchange + Apple
sign-in; update stale numbers in AGENTS.md; verify `SENTRY_AUTH_TOKEN` in the Coolify
build env.

---

## Suggested sequencing

**Week 1 (cheap, protective):** exec-summary #2 (deploy stop gap), #5 (trace tagged
vetoes), staleness/heat/correlation guard enablement, side-aware sell triggers,
`NeedsAttention` reinstatement, dead-dep/drizzle cleanup, Red Team cache fix, nano-model
classification, `/api/health` trim, restore drill.

**Month 1:** eval harness in CI (unblocks safe alpha work), regime-flip trigger, momentum
de-biasing, entry-thesis-in-exit-prompt, API tokens + export, settings search wiring,
iOS G1 (order cancel) + G5/G6/G8 plumbing wins, audit retention, RAG rerank/embed wins,
chat intent routing.

**Quarter:** per-regime factor weights via OOS gates, short-side last mile (gate on live
shorts), iOS G2 scan + G3 chat + G4 push, MCP server (read-only), LLM stack unification,
god-module splits, correlation-based diversification scoring.

**Verification commands run:** none (read-only review; no code changed).
**Next step:** owner picks a sequencing lane; each item above is scoped to land via
`scripts/land.sh` with the standard gates.
