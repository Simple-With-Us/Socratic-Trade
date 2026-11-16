# Agentic Trading — Comprehensive Improvement Audit

**Date:** 2026-06-30 · **Method:** 11 specialist reviewers (models matched per task) ran a read-only audit across the 8 owner-requested dimensions + architecture/security + both cross-app integrations, followed by a synthesis pass and an adversarial completeness critic. Evidence is `file:line`-anchored against the live code.

> **Important correction to the synthesis below.** The synthesis (§1–§7) was generated before the architecture/security reviewer finished and from the user's older memory, so it leads with the historical "critical auth IDOR / spoofable userId" as a standing P0. **That is no longer the state of the code.** A dedicated re-run (§11) and the completeness critic (§A) both verified end-to-end that the IDOR is **fixed and defended in depth** — fail-closed edge auth gate (`middleware.ts`), client-identity-header stripping, AES-256-GCM key encryption at rest, and a 16-assertion regression suite (`test/middleware-auth.test.ts`, `test/route-ownership.test.ts`, `test/csrf.test.ts`). Treat §11 + §A as authoritative on security; the residual security items are **High → Low**, not P0.

## How to read this

- **§1–§7** — cross-dimension synthesis: executive summary, maturity scorecard, ranked top-10, quick wins, strategic bets, per-dimension findings tables, and cross-cutting risks (9 dimensions).
- **§11** — the architecture & security dimension (re-run; the original reviewer failed a schema cap).
- **§A–§G** — completeness critic: net-new areas the synthesis under-covered — risk-management module family, a testing dimension, cost *enforcement*, observability (Langfuse), deployment/ops & data durability, and reconciliation with the two existing in-repo audits.

**The recurring meta-theme across every reviewer:** the codebase repeatedly computes the right safeguard or signal and then **fails to wire it into the path it was meant to protect** (factor-weight learning, congress-score go/no-go, rationale-diversity collapse detector, the usage-telemetry push client, the correlation gate). Closing these wiring gaps is higher-leverage and lower-effort than building anything new.

---

# Agentic Trading — Multi-Expert Audit Synthesis

## 1. Executive Summary

This is a genuinely sophisticated codebase that is far more mature than its single-developer origin would suggest — disciplined caching and indexing, a closed-loop position-sizing learner with proper statistical shrinkage, a domain-appropriate RAG stack (voyage-finance-2 + Pinecone + cross-encoder rerank), a well-engineered chat assistant with versioned prompts and an offline eval harness, the broadest data-source cascade of any dimension (13+ attributed providers that degrade to `-` rather than fabricate), and a careful "never fabricate," "Test/Paper default" safety posture. The single most important theme across reviewers is **the gap between machinery that is built and machinery that is actually wired into the money path**: the most rigorous analytics in the repo (congress-score-eval go/no-go, factor-weight OOS gate, rationale-diversity collapse detector, counterfactual learning, the entire usage-telemetry push client) are computed and then discarded, never closing their loops. The second recurring theme is **inconsistent fail-open vs fail-closed behavior on the strategy path**, where the Bear red-team and several prompts can silently pass un-critiqued trades through. The three highest-leverage moves are: (1) **make the strategy money-path as rigorous as the chat path** — version the Bull/Bear prompts, add eval coverage, and fix the Bear fail-open so a critique failure never auto-approves; (2) **surface the Red Team in the UI and audit log** — today the app's stated core differentiator (Green proposes / Red challenges) is invisible to users and Bear vetoes are never recorded; (3) **build the RAG retrieval-quality eval set and close the learning loops** that are already built but only emit manual proposals. Cross-cutting, the highest-priority items are correctness/safety risks on the trading path (Bear fail-open, synthetic bid/ask anchoring real limit prices) rather than aesthetics. Be aware the supplied audit covers 9 dimensions; the promised "architecture" reviewer is not present in the raw JSON, so it is not scored below.

## 2. Maturity Scorecard

| Dimension | Score (1-5) | Justification |
|---|---|---|
| Performance & efficiency | 4 | Strong fundamentals (SSE push, multi-tier caching, correct composite indexes, batched providers); weak spots are redundant per-request fill replays and a monolithic un-split client bundle. |
| Ability to learn | 3 | Sizing loop is genuinely closed and statistically careful; factor-weight/counterfactual/congress-eval loops are rigorous but never auto-apply — they die in manual proposals or dead code. |
| Embedding / RAG quality | 4 | Mature, domain-appropriate pipeline with provenance and lookahead guards; undercut by zero retrieval-quality eval, rerank discarding its own scores, and a thin/flag-gated corpus. |
| LLM use & prompting | 3 | Chat subsystem is excellent (versioned, eval-gated, injection-defended); strategy money-path has no eval, no versioning, fails open on Bear errors, and skips prompt caching. |
| UX / information architecture | 3 | Solid accessible cockpit shell and good decision cards; the core Green/Red architecture is invisible, ⌘K has no affordance, and docs have drifted from the real IA. |
| Aesthetic appeal | 4 | Above-average semantic token system with verified WCAG-AA contrast and themed charts; primitives (EmptyState/skeleton) and motion are underused, scales have drifted ad-hoc. |
| Data-source connectivity | 5 | The standout dimension: disciplined 13+ source cascade, per-field attribution, privacy-scoped caches, broad tests; named gaps are additive (earnings calendar, options/IV, 13F). |
| Cross-app: Congress.Trade | 3 | Careful, symmetric, well-documented integration; the push/SSE half is contract-drifted against the live peer, shared package pins diverge, 4 of 7 datasets silently dropped. |
| Cross-app: API Usage Monitor | 2 | Rich local metering exists, but the shared push client is never called and the monitor's poll adapters are structurally blind to this app's actual cost drivers. |

## 3. Top 10 Highest-Impact Improvements (Ranked)

| # | Improvement | Impact / Effort | Dimension | Notes |
|---|---|---|---|---|
| 1 | Fix Bear red-team **fail-open** — a Bear timeout/429/malformed-JSON currently ships un-critiqued Bull proposals; make it policy-aware (block or route-to-human) and audited | High / M | LLM-prompting | Contradicts red-team.ts's own fail-closed design and the mandatory-policy memo; safety-critical |
| 2 | **Surface Red Team in UI** as its own field + render block, and **audit Bear vetoes** instead of `console.log; continue` | High / S–M | UX (also flagged by LLM, learning) | Two reviewers; the app's stated core differentiator is currently invisible to users |
| 3 | Add **eval coverage + versioning to the strategy Bull/Bear money-path** (mirror the chat eval harness) | High / L | LLM-prompting | The money path has zero eval while chat is fully eval-gated |
| 4 | Build a **RAG retrieval-quality eval set** (recall@k / MRR) so every retrieval lever is measured, not guessed | High / M | RAG | Roadmap explicitly called for it; highest-leverage RAG investment |
| 5 | Fix **synthetic bid/ask anchoring real limit-price math** for quote-only watchlist tickers | High / S | Data-sources | Violates "never fabricate"; feeds strategy.ts limit-price computation directly |
| 6 | **Close the factor-weight learning loop** behind an opt-in policy flag (OOS-gated, clamped, audited, revertible) | High / L | Learning | Sophisticated OOS/IC machinery never auto-applies anything today |
| 7 | Eliminate **redundant fill-history fetch/replay** (7–9× per dashboard request); fetch once and thread through | High / M | Performance | Each call is a 500-row SELECT + JSON.parse + O(n) FIFO replay |
| 8 | **Wire congress-score-eval go/no-go into scan/scoring** so the strongest statistical guardrail stops being dead code | High / M | Learning | Most rigorous evaluator in repo has no production consumer |
| 9 | **Wire the usage-telemetry push client** into recordLlmUsage/recordRagUsage (env-gated fire-and-forget) | High / S | Usage-monitor | Fully-built shared client + working ingest endpoint, zero callers |
| 10 | **Code-split** StrategyFlow (@xyflow/react 3.9MB) and the price chart (lightweight-charts 2.9MB) via next/dynamic | Medium–High / M | Performance | Both libraries ship to every first load regardless of tab opened |

## 4. Quick Wins (High Impact / S–M Effort) — Checklist

- [ ] **Audit Bear vetoes**: add `audit("proposal_rejected_by_red_team", …)` before the `continue` in strategy.ts (~:451) — one line, makes vetoes visible in Activity feed. (S)
- [ ] **Separate Red Team verdict from `rationale`** into a `redTeamVerdict` field and render it as its own block in DecisionView. (S–M)
- [ ] **Add a visible ⌘K affordance** (search/sparkle button + kbd hint) in the command bar — removes the biggest discoverability gap. (S)
- [ ] **Fix synthetic bid/ask**: drop bid/ask from `toQuoteOnlyMarketQuote` or tag provenance `yahoo-finance-synthetic` and exclude from `hasAskData`. (S)
- [ ] **Wire usage-telemetry push** into recordLlmUsage()/recordRagUsage() behind `USAGE_MONITOR_BASE_URL`/`USAGE_INGEST_TOKEN`, fire-and-forget, try/catch. (S)
- [ ] **Capture rerank relevance scores** + add a post-rerank relevance floor; surface real score in citations. (S)
- [ ] **Code-split StrategyFlow + price chart** via `next/dynamic({ ssr: false })`. (M)
- [ ] **Collapse duplicate `getPaperPortfolioProjection` calls** in dashboard.ts (:341/:356) and batch proposal lookups in feed builders. (S–M)
- [ ] **Cap `buildUnifiedFeed` output at source** (~60 groups) — client only renders 50. (S)
- [ ] **Bump shared package pin** so both repos match (App B → a33dfd3) and add a CI check that pins can't diverge. (S)
- [ ] **Add earnings-calendar field** (`daysToEarnings`) via FMP/Yahoo `calendarEvents` — costly blind spot for an equity strategy. (S)
- [ ] **Add `institutionOwnership` / `13F`** to the existing authenticated Yahoo `quoteSummary` call — one-line, zero new cost. (S)
- [ ] **Swap ad-hoc empty states for `<EmptyState>`** and use `.skeleton` for loading placeholders. (S)
- [ ] **Wire `computeRationaleDiversity`** so `collapsed:true` gates the run (flag for review / re-sample) instead of only logging. (M)
- [ ] **Delete dead/unreachable Anthropic branch** in resolveLlmEndpoint (:121–133) and emit a warn for unpriced LLM models. (S)
- [ ] **Apply shared `resolveTickerAlias`** in App B's outbound payload to stop corporate-action row fragmentation. (S)

## 5. Strategic Bets (High Impact / L–XL Effort)

- **Make the strategy money-path first-class** — extract versioned Bull/Bear prompt modules, build an offline eval suite with deterministic scorers (never propose off-universe, shorts always carry a stop, reject buys contradicting structured evidence), and stamp prompt version on every proposal/audit row. (LLM-prompting, L)
- **Close the factor-weight learning loop** end-to-end: scheduled `proposeStrategyTuning` → existing `applyOosGate` → `MAX_WEIGHT_STEP` clamp → persisted weights with audit + revert, behind a default-off `policy.tuning` flag. (Learning, L)
- **Refactor the 6,749-line dashboard client** into per-tab components with memoized/selector-based state so a single SSE fill event doesn't re-render the whole tree. (Performance/UX, L)
- **Per-regime factor weights** — extend the OOS harness and policy to support regime-conditioned weight vectors keyed off `determineMarketRegime`, gated by per-regime sample size. (Learning, L)
- **Cost-aware feedback loop** from the usage monitor back into the strategy loop (start with push-only alerts into the existing notification pipe; later a budget-status read endpoint that forces cheaper models / skips a cycle when budget exceeded). (Usage-monitor, L)
- **Repair the Congress push/SSE contract**: pick one real event contract and make both apps honor it (envelope-emitting SSE mode on App A, or adapt App B to App A's subscription model). (Cross-app Congress, M–L)
- **Provision a paid Voyage key and turn on full-body 8-K + disclosure embedding** for the watched universe — a config/cost decision that unlocks the entire (currently corpus-starved) RAG pipeline. (RAG, M but gated on spend)

## 6. Per-Dimension Detail

### 6.1 Performance & Efficiency
**Current state:** Real performance discipline — Sentry env-gated to a true no-op, SSE push replacing blind polling, multi-tier enrichment caching with a 25s scan timeout, batched Alpaca providers, 24h macro cache, and composite indexes matching actual WHERE clauses. Self-guarded scheduler with lease-based single-leader gating. Weak spots concentrate in the dashboard composition layer (redundant queries), one unbatched provider (Finnhub), and a monolithic un-code-split client.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| getDashboardSnapshot re-fetches/replays fill history 7–9× per request | High | High | M | dashboard.ts:341,356; performance.ts:224–226,259; db-fills.ts:181; dashboard.ts:459 — 9+ `listFillEvents(` call sites per request, each a 500-row SELECT + JSON.parse + FIFO replay | Fetch fills once (live+paper) per request and thread parsed arrays into all consumers; at minimum collapse the two identical `getPaperPortfolioProjection` calls. |
| Per-row point query for every proposal-linked audit/fill/notification event | Med | Med | S | dashboard.ts:402–405,463–466; dashboard-feed.ts:596,317; db-proposals.ts:98 issues a fresh prepared SELECT per call | Batch-collect distinct proposalIds and do one `WHERE id IN (…)` lookup into a Map. |
| Server builds full feed; client renders only 50 | Med | Med | S | dashboard-client.tsx:3805 (`feed.slice(0,50)`) vs uncapped buildUnifiedFeed (:551) / buildAuditFeed (:73) | Cap buildUnifiedFeed output at the source (~60 groups). |
| Finnhub makes 5 unbatched REST calls per symbol | Med | Med | M | data-providers.ts:1568–1580 (Promise.allSettled of 5 endpoints), CONCURRENCY=5 (:237) → up to 250 round trips behind the 25s scan timeout | Reduce sub-call count / demote in cascade / raise concurrency or lower its symbol cap independently. |
| Entire dashboard is one 6,749-line client component, thin code-splitting | Med | Med | M | dashboard-client.tsx; static import of StrategyFlow (:109, 3.9MB). `app/ui/price-chart.tsx` already lazy-loads `lightweight-charts`, so the remaining issue is the dashboard shell/component boundary rather than the chart library itself | Split the dashboard shell and StrategyFlow/symbol drilldown boundaries with `next/dynamic` or smaller tab components; keep the existing chart-library dynamic import. |
| Monolithic `snapshot` state → every SSE event re-renders whole tree | Low | Med | L | dashboard-client.tsx:1040 replaces entire snapshot on every load(); no React.memo, only 31 useMemo | Larger refactor — split into per-tab memoized components / selector-based state; track as follow-up. |
| Playwright CI pays a cold `next build` every run | Low | Low | S | playwright.config.ts:7,33; e2e.yml has no `.next/cache` restore | Add actions/cache keyed on lockfile+source for `.next/cache`; verify self-hosted runner isn't wiping it. |
| No mmap_size/cache_size tuning for better-sqlite3 | Low | Low | S | db.ts:26–30 sets WAL/busy_timeout/synchronous/foreign_keys but not cache_size/mmap_size | Add `cache_size = -20000`; sequence after the redundant-query fix. |

### 6.2 Ability to Learn
**Current state:** Two subsystems at opposite maturity. The thesis/regime → sizing loop is genuinely closed and careful (shrunk win-rate/edge scaling, 20-lot evidence floor, James-Stein shrinkage, negative-EV skip). The factor-weight loop has rigorous IC/OOS/placebo/t-stat machinery that **never auto-applies** — it only emits a manual proposal, and several evaluators (congress-score-eval, rationale diversity) have no production consumer at all.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| Factor-weight learning never closes the loop | High | High | L | strategy-tuning.ts:152 only called by /api/strategy/tune; deriveWeightsFromIC/runWalkForwardOOS only in admin READ-ONLY route; no scheduler caller | Opt-in autonomous tuning: cadence run → applyOosGate → MAX_WEIGHT_STEP clamp → persist w/ audit+revert, behind default-off policy.tuning flag. |
| congress-score-eval (most rigorous evaluator) has no production consumer | High | High | M | congress-score-eval.ts (placebo-IC, t-stat≥2, marginal IC, quantile spread) — no production importer; congress score is used in scanning but never gated by its own validation | Wire goNoGo into scan/scoring: down-weight/disable congress contribution when it fails, surface verdict in dashboard. |
| Counterfactual/missed-opportunity learning only feeds the manual tuner | Med | High | M | counterfactual-learning.ts + performance.ts:729 mature correctly; summarizeMissedOpportunities (strategy-tuning.ts:108) consumed only inside the manual proposal | Feed matured per-factor skipped-winner stats into scan composite / Bull prompt as a small, sample-gated, audited nudge. |
| recurringFactor fires at only 2 missed winners | Med | Med | S | strategy-tuning.ts:134 (`>= 2`); line 109 filters returnPct>0 with no market adjustment | Raise threshold (≥5) and make the winner test benchmark-relative (minus SPY); reuse existing SPY return map. |
| Factor attribution collapses missing factor to "momentum" | Med | Med | S | performance.ts:706–709 falls back to "momentum"; 500-row audit cap (:687) ages out entry snapshots | Drop unresolvable lots instead of defaulting; persist dominant factor at entry or widen the audit window. |
| MAE/MFE + post-mortem depend on best-effort Yahoo, no coverage gating | Med | Med | M | learning-loop.ts:38–75 bare Yahoo URL, null on failure; post-mortem.ts:71 swallows failures; capturePct clamped [0,200] | Record per-thesis excursion coverage and surface it; route through the cascading OHLC provider (history.fetchDailyOHLC). |
| No overfitting guard on the prompt/reflection feedback channel | Med | Med | M | OOS gate protects only scoringWeights; reflection_summary injected verbatim (strategy.ts:1799); track-record facts at just 5 lots (post-mortem.ts:199,211) | Apply sample-size discipline to qualitative channels: raise fact threshold, label facts with n, add time-decay/expiry. |
| Confidence calibration computed but not fed back into sizing | Low | Med | M | getConfidenceCalibration (performance.ts:833) imported but sizing uses raw confidenceScore (strategy.ts:1126–1140) | Remap confidenceScore via the calibration curve before it becomes the sizing multiplier. |
| Single global IC-weight vector — no regime-conditioned weights | Low | Med | L | deriveWeightsFromICs/runWalkForwardOOS compute one global vector (backtest.ts:633–674); policy.scoringWeights is single | Extend OOS harness + policy to per-regime vectors keyed off determineMarketRegime; until then report per-regime IC in admin. |

### 6.3 Embedding / RAG / Knowledge Framework
**Current state:** Unusually mature for a small app — voyage-finance-2 into serverless Pinecone, correct query/document inputType, structure-aware chunking, SHA-256 dedup, per-user cost metering, point-in-time as_of guards, and a sound over-fetch → floor → as-of → hybrid → rerank pipeline with carefully handled multi-tenant scope. Weak spots: thin/flag-gated corpus, rerank discarding its own scores, hybrid off-by-default with corpus-pool IDF, and no retrieval-quality eval despite the roadmap calling for one.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| No retrieval-quality eval harness despite roadmap | High | High | M | mechanics-only tests; `grep recall@|MRR|faithfulness|ndcg` empty; docs/chat-assistant-rag-learning.md §5 lists it | Build ~25–40 golden (query, expected-chunk) tuples + vitest computing recall@k/MRR against a recorded fixture; gate flags by measured delta. |
| Reranker discards its own scores; floor stays cosine-only | High | High | S | vector-db.ts:292–320 pushes original match; matchToChunk:571 reads match.score; minScore applied pre-rerank (:706–707) | Capture `item.relevanceScore`, attach + surface it, add a post-rerank relevance floor. |
| Full-filing/8-K-body ingest flag-gated OFF; corpus is the binding constraint | High | High | M | WEB_SOURCE_SEC8K_FULL_BODY off; RAG_EMBED_DISCLOSURES 'off'; 3-RPM Voyage delay 21000ms; docs I5 "corpus nearly empty" | Provision paid Voyage key, set batch delay 0, enable full-body 8-K + disclosure embedding (config/cost decision). |
| Hybrid BM25/RRF off by default, IDF from ≤50-doc pool | Med | Med | M | hybridRetrievalEnabled() false; rag/hybrid.ts:14–18; exact-term hits outside dense pool never recovered | Move to Pinecone sparse-dense index, or enable hybrid once eval confirms it helps; document the recall ceiling. |
| Per-chunk char trim (2400) can truncate structure-aware chunks | Med | Med | S | chunk.ts maxTokens=480 + header; storeContexts trims at 2400 (vector-db.ts:368) — atomic tables get cut | Raise/remove the char cap for storeDocument chunks or align it with the token-based chunker. |
| Filters for 'earnings-transcript' doc_type no producer ingests | Med | Med | M | strategy.ts:352 includes it; only repo hit is that filter line | Drop the unused value, or (higher value) add an FMP/Quartr transcript ingest path. |
| doc_type casing inconsistent, patched only at query time | Low | Med | S | buildExtraFilters expands lower+upper (vector-db.ts:601–607); casing depends on caller | Normalize to lowercase at the chunk/storeContexts boundary and simplify to exact-match. |
| Salience extractor is a regex stand-in feeding the learning corpus | Low | Med | M | memory/salience.ts:1–4,23–76; TICKER_RE matches any 1–5 uppercase token ("I","A","CEO") | Replace with structured-output LLM extractor (regex as test fallback); validate tickers against known universe. |
| minScore reads only cosine; no per-doc-type/recency-aware floor | Low | Low | M | defaultMinScore() single global 0.30; freshness only binary as_of + text prefix | After eval exists, add a recency-decay term to final ordering using acceptance_datetime. |

### 6.4 LLM Use & Prompting
**Current state:** Two subsystems at very different maturity. The chat assistant is well-engineered — versioned prompt bundle, explicit injection defense, provider-agnostic tool loop, Anthropic prompt caching, deterministic intent router, offline golden-eval. The strategy money-path (Bull/Bear, red-team) is the opposite: large inlined per-call prompts, no versioning, no eval, and unsafe fail-open behavior. The provider abstraction itself is solid; failover is configuration-driven, not automatic.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| Strategy Bull/Bear prompts have zero eval coverage and no versioning | High | High | L | scripts/eval/run-offline.ts targets chat only; strategy.ts:1859,2154 inlined ~60-line arrays; no PROMPT_VERSION | Extract versioned prompt modules + offline eval with deterministic scorers; stamp prompt version on each proposal/audit row. |
| Bear red-team fails OPEN — any Bear error passes Bull proposals through | High | High | M | strategy.ts:2313–2334 fallbackToBull on non-200/empty/unparseable; :2337–2346 catch returns bullProposals — contradicts red-team.ts:108/163/185 fail-closed | Make Bear failure policy-aware: block or route-to-human in autonomous mode, surface available:false, loud audit + notify. |
| Strategy/red-team path doesn't use Anthropic prompt caching | Med | High | M | llm-call.ts:72–90 sends plain string system, no cache_control; pattern exists in chat/llm.ts:367–378; ~3–4k static prefix re-sent per run/user | Split into stable prefix (cache_control ephemeral) + dynamic suffix; add prompt-caching beta header. |
| Bull output capped at 1500 tokens → silent truncation → zero proposals | Med | Med | S | LLM_OUTPUT_TOKEN_CAPS.strategyProposal=1500 (llm-request.ts:42,60); truncation → JSON.parse fail → [] (strategy.ts:2110–2115) | Scale cap with maxProposalsPerRun or bound rationale length; distinguish truncation (finish_reason=length) from genuinely empty. |
| No automatic cross-provider failover | Med | Med | L | resolveLlmEndpoint (:30) resolves one endpoint; Bull throws on non-200 (strategy.ts:2095–2098) | Add ordered fallback list; on 429/5xx/timeout re-issue the same LlmRequestSpec against the next endpoint; record serving provider. |
| Red-team uses bare json_object (no strict schema) for OpenAI-compatible providers | Med | Med | S | red-team.ts:120 openAiJsonObject:true; schema only enforced as Anthropic tool; debateViaAnthropic relies on regex extraction (:258) | Use strict json_schema for OpenAI/Gemini; route debateViaAnthropic through buildLlmRequestBody for forced-tool JSON. |
| Red-team adversariality shallow: single-shot, Bull/Bear default to same model | Med | Med | M | resolveRoleModel (:16–19) defaults Red to same model as Green; both single-pass temp 0; no self-consistency | Default redTeamLlmModel to a different family; consider N-sample self-consistency on high-notional; track Bear rejection rate. |
| Dead/unreachable Anthropic provider branch + wrong provider tag | Low | Low | S | llm-provider.ts:121–133 unreachable (claude caught at :41), sets provider:'openai' against api.anthropic.com | Delete the unreachable branch. |
| Model price table silently null-costs unlisted/newer models | Low | Low | S | llm-usage.ts:36–73 returns undefined for unlisted → cost_usd null | One-time warn / dashboard 'unpriced model' flag + coarse per-provider default tier. |
| Rationale-diversity collapse detector computed but doesn't gate | Low | Med | M | rationale-diversity.ts:95–130 computes collapse signal; feeds reporting only, doesn't block/downsize | Wire collapsed:true to flag-for-review / re-sample / refuse auto-execute. |

### 6.5 Intuitive Layout / Information Architecture (UX)
**Current state:** A mature single-page cockpit — fixed desktop shell with command bar, portfolio rail, tabbed workspace, slide-over feed drawer; tiered Settings modal; accessible Modal/Tabs; toast stack; readiness strip with fix-it buttons; an un-hideable execution-mode banner; genuinely good decision cards; and a plain-language onboarding page. But IA has drifted from its design doc, the core Green/Red architecture is nearly invisible in the decision UI, and the command palette has no visible entry point.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| Red Team verdict buried in a 3-line-clamped rationale string | High | High | M | strategy.ts:459 appends to rationale; dashboard-client.tsx:2162 line-clamp-3 + hover-only title; strategy-flow.tsx:173–178 carries no per-decision data | Add `redTeamVerdict` field to TradeProposal; render as its own 'Bear Review' block in DecisionView. (Also flagged by LLM/learning reviewers — raises priority.) |
| Red Team rejections never written to audit log | High | High | S | strategy.ts:449–453 `console.log; continue` with no audit() (contrast :430 audit("proposal_skipped_negative_ev")) | Add `audit("proposal_rejected_by_red_team", …)` before the continue. |
| ⌘K palette has zero visible affordance | Med | High | S | command-palette.tsx overlay only; listener at dashboard-client.tsx:1023–1028; no search icon/⌘K badge anywhere | Add a persistent command-bar button with a visible ⌘K kbd hint (~10 lines). |
| phase-8-cockpit-ui.md undercounts the actual IA by 3+1 tabs | Med | Med | S | doc lists 4 workspace/3 feed tabs + right inspector; code has 7 workspace (:140) + 4 feed (:154); inspector replaced by Settings modal (:155) | Update Layout Model / User-Facing Tabs sections to the real architecture. |
| Seven workspace tabs strain the single-screen goal | Low | Med | M | dashboard-client.tsx:1635–1641 overflow-x-auto + scroll-fade; Tax/Macro compete with Decision | Demote Tax/Macro to a 'More' overflow or sub-views so the primary row needs no horizontal scroll at 1280px+. |
| Rationale truncation has hover-only, no click-to-expand | Low | Med | S | dashboard-client.tsx:2162 title-only; unreachable on touch (doc designs for mobile) | Replace with tap/click-to-expand toggle. |

### 6.6 Aesthetic Appeal / Visual Design
**Current state:** Above-average foundation — a real semantic token system flipping cleanly light/dark with verified WCAG-AA contrast, a small consistent primitives layer, themed lightweight-charts/@xyflow charts that read CSS variables at runtime, glassmorphism for a premium feel, and careful accessibility (focus rings, reduced-motion, iOS zoom prevention, tabular numerals). Weak point is execution depth: most of this lives in one 6,749-line file where primitives and the original Recharts/Motion intent have eroded.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| EmptyState/skeleton primitives exist but are unused in the dashboard | Med | Med | S | primitives.tsx defines EmptyState; globals.css .skeleton; dashboard-client.tsx uses ad-hoc inline text (:3569,:3886,:6418) | Swap ad-hoc empty strings for `<EmptyState>` and `.skeleton` placeholders. |
| Spacing/blur scales drifted to ad-hoc values | Med | Med | M | padding p-2…p-6 inconsistent across sibling cards; backdrop-blur -md/-lg/-xl seemingly random | Define 2–3 named elevation/blur tiers + a documented spacing scale; convert adjacent siblings. |
| Icon sizing has no enforced scale (11 distinct sizes) | Low | Low | S | sizes 10–28px scattered with no semantic mapping | Collapse to a 3-step scale (14/16/20) and sweep. |
| Original Recharts/Motion intent eroded without an updated doc | Low | Low | S | rollout note cites Recharts+Motion; no recharts dep; motion in only 2 of 17 ui files | Either retire the goal in docs or add motion fade/slide to tab switches and card collapse. |
| No dedicated visual design-system doc | Low | Low | S | docs/design/ has only product docs; tokens/scales undocumented | Add docs/design/visual-system.md documenting tokens, contrast guarantee, scales, and which library owns which surface. |

### 6.7 Data-Source Connectivity & Breadth
**Current state:** The most mature dimension. A disciplined first-wins cascade across 13+ sources with explicit per-field attribution, privacy-scoped caches tied to whose key paid, a followed "never fabricate" policy, OHLC cascade (Massive→Tradier→Marketstack→Yahoo→Stooq), differentiated free macro/positioning signals, congressional/insider/8-K/short-volume web sources, deliberate MCP-vs-API decisions, per-lane provider health tracking, and broad tests. Named gaps are additive: no earnings calendar, no single-name options/IV, no 13F, single-sourced short-interest.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| No earnings-calendar / next-earnings-date signal anywhere | High | High | S | repo-wide grep empty outside prose; strategy.ts mentions "earnings" only in prompt strings (:1902/1904); 8-K Item 2.02 is reactive only | Add `daysToEarnings` via FMP earnings-calendar or Yahoo calendarEvents; thread through the per-field checklist; surface in the prompt. |
| Synthetic bid/ask (±0.1%) attributed as a real quoted spread, anchors limit-price math | High | Med | S | yahoo-finance.ts:33–34 always synthetic (chart endpoint has no bid/ask); market.ts:735,748 tags it yahoo-finance; strategy.ts:2403/2418/2703 uses quote.ask for limit price | Drop bid/ask from toQuoteOnlyMarketQuote or tag `yahoo-finance-synthetic` and exclude from hasAskData. |
| No single-name options/IV/skew despite a connected Robinhood MCP that exposes it | Med | Med | M | grep empty in src/lib; robinhood.ts has no option-chain calls; only macro Cboe SKEW/VVIX | Wire Robinhood's option-chain MCP tools into a low-frequency enrichment tier for near-the-money IV and put/call ratio. |
| No institutional/13F ownership despite free authenticated Yahoo endpoint | Med | Med | S | grep empty; YahooFinanceEnrichmentProvider.fetchSymbol (:1440–1442) already auths quoteSummary | Add `institutionOwnership`/`majorHoldersBreakdown` to the existing modules list; thread through the checklist. |
| Short-interest-of-float single point of failure (Yahoo only) | Low | Low | S | shortPercentOfFloat only from Yahoo (:113,1466); FINRA daily ratio kept distinct but never reconciled | Low priority (FINRA is independent); add FMP /short-interest as a second source if Yahoo auth gets flaky; consider flagging material disagreement. |
| No active per-provider circuit breaker | Low | Low | M | db-health.ts computes stoppedWorking for display only; data-providers.ts never reads it; dead providers retried every scan | Have getEnrichmentProvider consult getServiceHealthSummaries() and skip/no-op a stoppedWorking lane, re-probing on a longer interval. |

### 6.8 Cross-App Integration: Congress.Trade
**Current state:** Unusually well-engineered side-channel — symmetric push/read-back, default-OFF behind ~8 env gates, fully self-guarded, idempotent with a no-echo origin tag, well-documented, with a shared npm package centralizing types/schemas. The market-data and analytics exchanges are real and wired into strategy. But several seams are drifted: the push/SSE path doesn't match what the live peer serves, the shared package pins diverge, the inbound receiver drops 4 of 7 datasets, and neither app uses the shared alias utilities.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| App B's SSE consumer + webhook expect a contract App A doesn't serve (push path dead) | High | High | M | congress-stream.ts expects CONGRESS_EVENT_TYPES envelopes; App A delivery/rest.ts:324 requires ?subscription= and delivery/sse.ts:241 emits `trade.new`; webhook envelope/auth mismatch | Pick one contract: add an envelope-emitting SSE mode on App A (per docs) or adapt App B to App A's subscription model; document the inert state until then. |
| Inbound receiver silently drops insider/shortVolume/fundamentals/analyst (4 of 7) | Med | Med | M | SharePayload carries 7; import route coerces only refs/prices/spx (:48–51); no tables for the other 4 | Either trim outbound to what's persisted, or add imported_fundamentals/imported_analyst tables (closes a real cache gap since B reads these from A). |
| Shared contract package pinned to different commits in the two repos | Med | Med | S | App B pins 220677a3, App A pins a33dfd3 (B one commit behind; content diff empty today) | Pin both to the same commit/tag and add a CI/land check that fails on divergence; bump B to a33dfd3 now. |
| Neither app uses shared ticker-alias map; App B doesn't alias at all | Med | Med | S | shared TICKER_ALIASES/resolveTickerAlias unused; B's normalizeSymbol only trim+upper; A keeps its own copy | Apply resolveTickerAlias in B's outbound mappers and have A import the shared TICKER_ALIASES. |
| App A exposes insider/short-volume reads App B never consumes | Low | Low | S | API_PATHS MARKET_INSIDER/MARKET_SHORT_VOLUME implemented in A; no getAppAInsider/ShortVolume in B | Add thin readers (if A enriches them) or remove the unused paths from the shared contract. |
| Outbound SharePayloadSchema validation is logged-but-ignored | Low | Low | S | congress-share.ts:376–382 safeParse result discarded with a console.warn | Use the shared SecurityRefInput type and treat safeParse failure as drop-the-row, not a warning. |

### 6.9 Cross-App Integration: API Usage Monitor
**Current state:** Rich, production-grade *local* metering — every LLM and RAG call recorded into SQLite keyed by user/provider/model/context/keySource with best-effort cost, surfaced in an admin UI. But it is 100% local: the shared package's fully-built, schema-validated push client and the monitor's working ingest endpoint are never connected. The monitor's only live source is a poll-adapter model that is structurally blind to exactly this app's biggest cost drivers (Anthropic, Voyage, Robinhood). No cost-aware feedback loop exists in either direction.

| Title | Sev | Impact | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| Shared usageTelemetry push client fully built but never called | High | High | S | createUsageTelemetryClient exists + monitor route.ts persists it; grep across this app returns nothing (dependency present, export dead) | Add fire-and-forget emit in recordLlmUsage()/recordRagUsage() behind USAGE_MONITOR_BASE_URL/USAGE_INGEST_TOKEN, batched, try/catch. |
| Monitor's poll model structurally blind to this app's cost drivers | High | High | M | adapters/robinhood.ts always errors; anthropic.ts needs manual orgId; voyage.ts has no usage signal — while this app already computes real Anthropic/OpenAI/Voyage costs | Make push-from-app the primary channel for these providers; keep poll only where it works (Alpaca/FMP/Finnhub); document the split. |
| No market-data/broker call-volume telemetry anywhere | Med | Med | M | data-providers.ts/broker.ts have no call-count instrumentation; monitor adapters see only their own probes | Add a lightweight call-counter emitted via the same push path (confidence: actual); cheapest data to add, closes the shared-rate-limit blind spot. |
| No cost-aware feedback loop from monitor back into decisions | Med | Med | L | strategy.ts/red-team.ts call LLMs unconditionally; no budget check; monitor alerts not exposed back | Start with push-only alerts into this app's notification pipe; later a budget-status read endpoint to force cheaper models / skip a cycle. |
| Per-key/per-run granularity not labeled by environment when pushed | Low | Low | S | schema supports environment/keyRef; keyFingerprint already computed; multi-worktree setup would conflate preview vs prod spend | When wiring push, set environment from DEPLOY_ENV/NODE_ENV and pass keyRef through unchanged. |

## 7. Cross-Cutting Risks

**Security / auth**
- The historical critical auth IDOR is now verified fixed in this tree (edge auth, trusted identity header stripping, route-level ownership, encrypted key storage, and regression coverage). Treat any old "ship-today" IDOR notes as historical unless a fresh route-specific bypass is reproduced.
- **Operator-funded LLM cost is silently under-counted** for any model missing from the price table (llm-usage.ts) — a blind spot in the very ledger meant to track spend, and the basis for any future failover/billing decision.

**Correctness / safety on the money path** (highest-priority cross-cutting theme — multiple reviewers)
- **Bear red-team fails open** (LLM finding): a Bear timeout/429/malformed JSON ships un-critiqued Bull proposals, directly contradicting red-team.ts's fail-closed design and the mandatory-policy memo.
- **Synthetic bid/ask anchors real limit-price math** (data-sources): fabricated `ask = price × 1.001` flows into strategy.ts's buffered-limit computation as if it were a real quote, violating the project-wide "never fabricate" rule.
- **Bull truncation degrades to zero proposals silently** (LLM): the 1500-token cap can drop a whole autonomous tick to `[]` with only a console.warn.
- **Rationale-diversity collapse detector and congress-score go/no-go don't gate** (LLM, learning): two principled guardrails that detect template-collapse and statistically-worthless congress signals are computed and then ignored, so the money path runs unprotected by checks that already exist.

**Data integrity**
- **Factor attribution defaults missing factors to "momentum"** (learning), corrupting the per-factor nudges that feed tuning — silent mislabeling rather than dropping.
- **Ticker-alias fragmentation in the Congress shared store** (cross-app): aliased symbols (FB/ATVI) land under dead tickers because neither app applies the shared alias map, silently splitting rows.
- **RAG doc_type casing inconsistency** (RAG): stored casing depends on the caller and is only papered over at query time, so any non-RAG consumer of the metadata silently misses rows.
- **Bear vetoes leave no audit trail** (UX): rejected ideas vanish via `console.log; continue`, so the decision record is incomplete for both users and any downstream learning that reads the audit log.

**Recurring meta-risk:** the dominant pattern across security, correctness, and data integrity is *built-but-unwired rigor* — the codebase repeatedly computes the right safeguard or signal and then fails to connect it to the path it was meant to protect. Closing these wiring gaps is higher-leverage and lower-effort than building anything new.

---

## 11. Architecture & Security (dimension 10 — re-run after the initial reviewer failed)

**Method:** direct read of auth modules, middleware, ~15 API routes, the execution/scheduler path, and the DB layer, cross-checked against the 1-day-old `docs/audit-2026-06-29.md`.

### Headline

The previously-critical **IDOR is genuinely fixed and defended in depth**, with a regression suite guarding it (`test/middleware-auth.test.ts`, 16 assertions). The codebase is unusually mature for a solo/multi-agent project: ~1,575 tests across 166 files, a fail-closed edge auth gate, encrypted credentials at rest, PKCE OAuth, constant-time webhook auth, and honest design docs. The real risks now are (1) a few unfixed **medium** security items and (2) architectural tech-debt concentrated in three god-modules plus a money-path that is heavily gated but thinly integration-tested.

### A. Architecture & progress

Phase docs and `STATUS.md` track real implementation closely; `architecture-blueprint.md` is explicit that it is a *design plan*. Verified real: tri-state execution model, per-user/per-account isolation, multi-tenant RAG scoping, scheduler lease, learning-loop credit attribution, the required `verify` CI gate (lint → tsc → test → build).

Doc-vs-code gaps (low severity): `phase-7-strategy.md` implies Alpha Vantage NEWS_SENTIMENT / FinBERT sentiment that is actually a TODO (no sentiment model in code) — mark "deferred"; `architecture-blueprint.md` §2 trailing-stop edge cases (corp-action adjust, outlier-quote filter, proximity cadence, stale-row purge) are described as required but untested.

Tech-debt, ranked:

| # | Finding | Sev | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| A-1 | Three god-modules concentrate risk | Med | L | `strategy.ts` 2,902 lines (the money path), `data-providers.ts` 2,900, `dashboard-client.tsx` ~6,400 | Split `strategy.ts` into proposal-generation / execution-engine / reconciliation / learning behind existing public fns (the `db.ts`→`db-*.ts` split is the precedent). |
| A-2 | Money-path well-gated but thinly integration-tested | Med | M | Gates tested in isolation (`policy.test.ts`, `strategy-hardening.test.ts`, `broker-side.test.ts`) but no end-to-end test mocking LLM+broker through `runStrategyOnce` | Add one E2E test through proposal→evaluate→execute in Test mode + a live-mode pre-flight assertion (notional cap + `systemState="halted"`). Highest-leverage test gap for order-placing code. |
| A-3 | Execution-mode derivation correct but fail-safe across 3 sites | Low/Med | M | `deriveExecutionState` (`execution-mode.ts:30,45`) returns Test/local whenever `paperMode` true or no active account; live requires explicit `environment==="live"` | Verified fails safe (prior "could flip to live" concern overstated) but drift-prone; consolidate to a single source of truth. |
| A-4 | Daily-notional filter conflates `placed`+`paper` | Low | S | `dailyExecutionStats` counts `status IN ('placed','paper')` scoped by account+user (`db-execution.ts:57,90`); Test fills live on the separate TEST account | Not a cap bypass, but tighten to `placed` for live accounts or add a clarifying comment. |
| A-5 | Scheduler multi-process correctness is opt-in | Med (only if multi-process) | M | `scheduler-lease.ts:5-10` documents a one-tick TOCTOU window + in-memory-only synthetic-stop guard (`globalThis` Set); latent under single `next start` | Make single-leader the documented default before any horizontal scale-out. |

Done well: per-account run-lock scoping; atomic order placement (persist `placing` before broker call → crash-safe reconciliation); boot-time autonomy interlock (reverts `active`→`halted` on restart unless explicitly resumed); conviction-capped + edge-aware (Kelly) sizing; the `ENCRYPTION_KEY` boot guard (`db.ts:270`) that refuses to boot if the DB holds ciphertext but the key is absent.

### B. Security / auth

**The IDOR is fixed — verified end-to-end.** `middleware.ts` is the edge gate: identity resolves from CF Access header → verified Auth.js JWT → dev fallback only when auth is unconfigured (`isAuthConfigured()` deliberately avoids `NODE_ENV` because Next inlines it at build in the edge runtime — the original fail-open bug). `stripClientIdentityHeaders` removes client-supplied `x-user-id`/`x-authenticated-user-email` on every path; `resolveRequestUserId` reads only the trusted header and ignores body/query `userId`. Current route baseline: 66 `app/api/**/route.ts` files, 52 importing `resolveRequestUser`, and 14 without that import; the exceptions are admin routes, auth/health/logo endpoints, ops snapshot, and token/webhook endpoints that need explicit token/public-route review rather than a blanket "covered" label. DB layer enforces `WHERE user_id = ?`; `upsertConnectedAccount` has an `ON CONFLICT … WHERE user_id` guard against account-id hijack. CSRF same-origin via `Sec-Fetch-Site` (tested). API keys + broker creds AES-256-GCM. All SQL parameterized; `LIKE` uses `ESCAPE`; no injection surface found. Ops and webhook tokens use `timingSafeEqual` and are default-closed; **the legacy admin-token check is the exception — it still uses `===`** (`auth/admin.ts:63`, `admin/reindex-10k/route.ts:13`), tracked as S-3 below.

Open findings, ranked:

| # | Finding | Sev | Effort | Evidence | Recommendation |
|---|---|---|---|---|---|
| S-1 | Chat endpoint unrate-limited (cost-exhaustion vector when operator LLM fallback is enabled) | **High** | S | `app/api/chat/route.ts` has no `enforceRateLimit`. NB `llmOperatorFallbackEnabled()` (`db-api-keys.ts:423`) defaults on only under `NODE_ENV==="test"` — it is **opt-in in production**, so the operator-budget exposure applies only where an operator has enabled fallback; the missing rate limit is worth fixing regardless (an allowlisted non-primary user with no key would then bill the operator's LLM budget unbounded) | Add per-user `enforceRateLimit` to `/api/chat` (and `/api/scan`); the limiter already exists and is used by order routes. |
| S-2 | Robinhood OAuth tokens stored unencrypted at rest | Med | S | `setMcpOAuthTokens` persists access+refresh as plain JSON via `setInternalSetting` (`mcp-oauth.ts`→`db-settings.ts:32`), bypassing the `encryptValue` path used for keys/accounts | Route token persistence through `encryptValue`/`decryptValue`. OAuth flow itself is solid (PKCE S256, tenant-isolated). |
| S-3 | Legacy admin token compared with `===` (timing) | Med | S | `auth/admin.ts:63` and `admin/reindex-10k/route.ts:13` use `===`; `ops-auth.ts` already uses `timingSafeEqual` | Swap to constant-time compare. |
| S-4 | Rate limiter + caches in-process only, fail open | Low (latent) | M | `rate-limit.ts` single-process sliding window, fails open on error | Fine for single `next start`; tie to the scheduler single-leader decision (A-5) before scale-out. |
| S-5 | No CSP / security response headers | Low | S | `middleware.ts` sets no CSP / X-Frame-Options / Referrer-Policy | Add them given the app handles brokerage credentials. |

**Prior-audit "critical" items NOT current code risks:** the "17 plaintext secrets in `.env.local`" is a deployment-machine state issue (`.env.local` is gitignored/absent; Infisical-first path with `REQUIRE_SECRETS_MANAGER=1` fail-closed boot); the "12 stale `* 2.ts` duplicates" are gone; the IDOR is fixed.

**Live-trade safety (positive, with a caveat):** `assertLiveApprovalConfirmation` (`strategy.ts:1342`) requires a typed confirmation matching proposalId + accountNumber + executionMode + exact text + estimated notional (±$0.01). NB this guards the **manual approval** path for queued proposals; an autonomous `broker/live` run with `strategyAuthority: "decide"` can reach `gateway.placeEquityOrder` directly after the policy gates (no typed confirmation), so the typed gate is not a universal pre-order check for autonomous live execution — the policy gates + execution-mode interlocks are what protect that path. Paper is default; the Test account is always the safe default.

**Top security ROI:** (1) rate-limit `/api/chat` [S], (2) encrypt Robinhood OAuth tokens [S], (3) constant-time admin compare [S], (4) one E2E money-path test [M], (5) split `strategy.ts` [L].


---

# Completeness review — gaps & additions

The report is strong on the 8 owner dimensions but its **security/cross-cutting section is built on stale memory, not the current code**, and it **ignores the entire risk-management module family** plus testing, observability, deployment/ops, and cost as first-class areas. It also never reconciled against two existing in-repo audit docs that already cover much of this. Net-new items below.

## A. The IDOR / auth framing is stale — re-baseline before calling it P0
The report's #1 cross-cutting risk ("no auth + spoofable userId exposes keys & trade execution, ship-today") is **no longer the state of the code**. A real edge auth gate now exists.
- `middleware.ts` (164 lines): fail-closed identity resolution (CF Access header → Auth.js v5 JWT → dev fallback only when `!isAuthConfigured()`), CSRF same-origin check on `/api/*`, and `stripClientIdentityHeaders` so a forged `x-authenticated-user-email` can't reach a handler. The doc-comment explicitly explains why it avoids `NODE_ENV` (the original IDOR cause).
- `test/route-ownership.test.ts` + `test/middleware-auth.test.ts` + `test/csrf.test.ts` are explicit cross-tenant regression guards.
- `src/lib/db-api-keys.ts:48-56`: stored broker/provider keys are **aes-256-gcm encrypted at rest**, not plaintext — so "exposes keys" is doubly inaccurate.
- **Recommendation:** Re-verify the IDOR live, then either downgrade it from P0 or re-scope it to the *residual* gaps below. Shipping the report with a stale P0 will misdirect the owner.

**Net-new residual auth findings the report missed:**
1. **Timing-unsafe admin token compare.** `src/lib/auth/admin.ts:63` still uses `request.headers.get("x-admin-token") === token`, while `src/lib/ops-auth.ts` correctly uses `timingSafeEqual`. Prior audit flagged this (audit-2026-06-29 #8); it survives. Fix: route the admin-token check through `timingSafeEqual`.
2. **Admin routes fail OPEN in non-production.** `checkAdmin` defaults `allowNonProd=true`, so all `app/api/admin/*` (reindex-8k/10k, securities import, congress-share, llm-usage) run unauthenticated whenever `NODE_ENV !== "production"` — which the middleware's own comment warns is unreliable under Next's edge build inlining. Confirm the Node runtime reads it correctly and consider defaulting `allowNonProd=false` for write/admin routes.
3. **`/strategy` and `/api/ops` are in `PUBLIC_PREFIXES`.** `/api/ops/snapshot` returns per-user run + audit data behind a single shared token that **falls back to `ADMIN_REINDEX_TOKEN`** (`ops-auth.ts` `opsDiagnosticSecrets`), so one token leak exposes multi-user operational data. The public `/strategy` page prefix is also worth re-confirming exposes nothing user-scoped.
4. **Chat endpoint still has no rate limit.** `app/api/chat/route.ts` does not call `rateLimit()` (prior audit #9 open) — with operator-funded LLM failover on, this is a direct cost-exhaustion vector. The limiter exists (`rate-limit.ts`) and is already applied to orders/OAuth; wire it into chat.

## B. Entire risk-management module family ignored (correctness/safety — high)
The report's "correctness/safety on the money path" theme covered only Bear fail-open and synthetic bid/ask. It **never mentions the dedicated risk modules**, several of which are the real account-level safety net:
- `src/lib/risk-breaker.ts` — account-level trailing-drawdown + daily-loss **kill-switch** that flips `systemState` to `close_only`. This is wired into `runStrategyOnce` and covered by `test/risk-breaker.test.ts` / `test/p0-safety-fixes.test.ts`; the remaining audit target is operational durability: high-water-mark restart behavior, dashboard/alert surfacing, and live evidence that `close_only` blocks fresh entries.
- `src/lib/correlation.ts` — opt-in correlation-cluster gate (`policy.maxAvgCorrelation`, default off) catching concentrated-drawdown risk the per-symbol/sector/beta caps miss. Like the factor-weight loop, it's built-but-off — same "unwired rigor" theme the report champions, but omitted.
- `src/lib/execution-cost.ts` — net-of-cost model for simulated fills (default ON). This is a **learning-integrity** safeguard: without it the win-rate/edge that drives sizing certifies a cost-free edge. The Learning dimension (6.2) should have flagged its existence and verified it isn't bypassed.
- `src/lib/sell-to-fund.ts` (auto-liquidation when buying power short), `src/lib/regime-watch.ts` (regime-flip detector), `src/lib/stale-limit-orders.ts`, `src/lib/synthetic-stops.ts`, `src/lib/broker-protective-stops.ts` / `broker-held-orders.ts` — none mentioned, yet STATUS.md shows the most recent production bug (KO 403 held-order over-reservation) lives exactly here.
- **Recommendation:** Add a "Risk controls & money-path safety" sub-section; at minimum re-baseline risk-breaker restart-durability/live observability and confirm execution-cost isn't disabled in the path that feeds the learner.

## C. Testing is not assessed as a dimension (the report only touched eval harnesses)
165 test files exist with real auth/ownership coverage, but the report says little about test coverage of the **money path**. NB the prior `docs/audit-2026-06-29.md` "zero tests" framing is now stale: the tree already exercises these modules — e.g. `test/persistence-notification.test.ts` drives `runStrategyOnce`, `test/robinhood-mcp.test.ts`, `test/alpaca-order-mapping.test.ts`, and `test/securities-import.test.ts` (a `db-*` module). The real gap is **end-to-end** money-path coverage: no single test mocks the LLM + broker and drives proposal → evaluate → execute through the full cycle (see §11 A-2).
- **Recommendation:** Add a Testing dimension. Highest-leverage: characterization tests around `strategy.ts` order construction (limit-price math, short/cover sides, the Bear fail-open path) and broker gateways before further refactors.

## D. Cost is under-scoped to the usage-monitor integration only
The report frames cost almost entirely as "wire the usage-telemetry push client." It misses the **enforcement** gap: there is no `$`/token budget ceiling anywhere. `src/lib/triggers.ts` explicitly defers it ("the $/token budget ceiling are deferred"), and `strategy.ts`/`red-team.ts` call LLMs unconditionally. The prior audit also flags the **embedding cache** (no LRU on Voyage query embeddings, audit #7, ~50–80% savings) and the **21s free-tier Voyage batch delay** (#12) as concrete cost items the report's RAG section only references obliquely.
- **Recommendation:** Add (1) a hard per-user/per-day token-budget ceiling enforced in the trigger/strategy entry, and (2) the query-embedding LRU cache. Both are cheap and directly cap operator spend.

## E. Observability is mischaracterized
The report's only observability mention is "Sentry env-gated to a no-op." It missed `src/lib/observability.ts`, a full **Langfuse + OpenTelemetry LLM-tracing** layer (`startObservability`, generation spans, `telemetry-sanitize` redaction). This is directly relevant to the LLM-prompting and learning dimensions (it's where prompt-version/eval telemetry would land).
- **Recommendation:** Note Langfuse exists and recommend stamping prompt version + Bear-veto/diversity-collapse events as Langfuse observations — it operationalizes several of the report's own "wire the guardrail" asks.

## F. Deployment/ops & data-durability not covered
No coverage of: `docs/litestream.md` (continuous SQLite WAL → R2 backup via PM2 sidecar; single-replica 0.5.x constraint is an operational risk worth a line), `scripts/land.sh` landing gate, the `verify` ruleset, multi-worktree/PM2 model, or `src/lib/account-deletion.ts` (GDPR-style cascade delete across ~12 tables + MCP OAuth revocation — a compliance-relevant module for the stated paper/education GTM).
- **Recommendation:** One ops paragraph: confirm Litestream restore has been tested (a backup never restored is not a backup), and that account-deletion's table list stays in sync as new `db-*` tables are added (a known drift trap given the db-split).

## G. Process gap: the report didn't reconcile with existing audits
`docs/audit-2026-06-29.md` (6-agent audit, 1 day old) and `docs/improvement-program-2026-06-26.md` (owner-approved 11-workstream plan) already cover secrets-at-rest, money-path test gaps, cost (embedding cache/Voyage), scheduler durability, and several RAG items the report re-derives. The synthesis presents findings as net-new without cross-referencing these, risking duplicate work and contradicting the program's sequencing.
- **Recommendation:** Add a reconciliation column mapping each top-10 item to its status in the existing improvement program (done / in-flight / superseded).

## Dimensions with genuinely complete coverage
- **Data-source connectivity (6.7):** Complete and accurate; gaps named are correctly additive.
- **Aesthetic appeal (6.6):** Complete for the scope.
- **Cross-app Congress (6.8) / Usage Monitor (6.9):** Integration seams well-covered; the only addition is the cost-*enforcement* gap (item D), which is broader than the monitor wiring.
- **Architecture:** Correctly self-flagged as unscored — but `docs/architecture-blueprint.md` and the `db.ts` barrel-split exist and should be read before any architecture pass, rather than treated as absent.

**Single most important correction:** verify the live auth/IDOR state against `middleware.ts` + the ownership tests before publishing — the report's headline P0 appears already remediated, and leading with a stale critical undermines the rest of an otherwise solid audit.
