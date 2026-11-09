# Multi-Expert App Analysis — Ways to Improve the App

> An advisory-panel review of the intended **AI-powered trading / financial-assistant app**, covering layout, flexibility, aesthetics, intuitiveness of controls, financial markets, trading algorithms, LLM databases, cache/embedding/memory, prompting, and machine learning.
>
> _Generated 2026-06-19. Branch: `claude/multi-expert-app-analysis-jm99bb`._

---

## 0. Current State (important context)

The repository today is a **stock GitHub Pages placeholder** — the default "Welcome to GitHub Pages" template for "Jay Wedgeworth" (`index.html`, `stylesheets/styles.css`, `javascripts/scale.fix.js`, a checker.png). There is **no trading or LLM application code yet**. The page also still ships legacy cruft: an old `google-analytics.com/ga.js` snippet (`UA-63193536-1`), `<!--[if lt IE 9]>` IE conditionals, and an `html5shiv` reference over plain HTTP.

Everything below is therefore **forward-looking product guidance** for the intended app — a panel of eleven domain experts each enumerating concrete ways to improve it — plus a short list of literal do-this-now fixes for the current page. Sections are ordered high→low impact within each discipline.

### Cross-cutting north stars (every expert agreed on these)
- **The AI must never autonomously move money.** It can draft/stage/explain orders; execution always requires an explicit human action on a separate, deterministic code path the model cannot reach.
- **Stale data is a trust/liability failure.** Every number carries an as-of timestamp and a live / delayed / disconnected indicator.
- **This is informational, not licensed advice.** Persistent disclaimers; live trades route only through a licensed broker.
- **Tabular numerals, dark-first, color + sign + glyph** (never color alone) is the baseline for a credible financial UI.

### Expert deep-dive appendices

Sections 6–11 below are concise overviews. Each has a much deeper, code-rich companion file produced by a dedicated multi-specialist panel (ordered high→low impact within each):

| Deep dive | Covers |
|---|---|
| [06 — Trading Algorithms & Quant](deep-dives/06-trading-algorithms.md) | Strategy framework & event-driven backtester · risk/sizing/kill-switches · execution algos & transaction-cost modeling |
| [07 — Databases & Retrieval (RAG)](deep-dives/07-databases-and-rag.md) | pgvector/HNSW tuning · financial-document chunking · hybrid search + reranking + eval · time-series/point-in-time storage · ingestion/freshness/versioning/multi-tenancy |
| [08 — Cache, Embeddings & Memory](deep-dives/08-cache-embeddings-memory.md) | Embedding economics (MRL/quantization) · Anthropic prompt caching + semantic caching · 4-tier memory architecture · memory lifecycle/personalization/invalidation |
| [09 — Prompting & LLM Orchestration](deep-dives/09-prompting-and-llm.md) | System-prompt design · tool use & agent loops · grounding/anti-hallucination · structured output · prompt eval harness · guardrails/injection defense · context/latency/cost |
| [10 — Machine Learning](deep-dives/10-machine-learning.md) | ML learning path · time-series done right · NLP on filings/news · MLOps/reproducibility · leakage prevention · RL honest guide · signal combination & portfolio construction |
| [11 — Implementation](deep-dives/11-implementation.md) | From placeholder to MVP: scaffolding, hosting, secrets/BFF, the first vertical slice, CI/eval/leakage/secret gates |
| [12 — Memory, Format & Model Governance](deep-dives/12-memory-format-and-model-decisions.md) | **Memory debates** (what to remember / how to abbreviate / how to organize) · LLM structure/format debate · model-change governance · model-to-task routing map |

> **Most-requested topic — memory:** the deepest treatment of *deciding what to remember, how to abbreviate it, and how to organize it* lives in [Deep Dive 12](deep-dives/12-memory-format-and-model-decisions.md), with supporting architecture in [Deep Dive 8](deep-dives/08-cache-embeddings-memory.md).

---

## 1. Intuitiveness of Controls (Priority)

_The highest-stakes dimension: mistakes here cost real money._

**Tier 0 — AI assistant trust & guardrails**
- Make the assistant **advisory by default**: it can draft, stage, and pre-fill orders but is structurally incapable of submitting a live trade — execution requires an explicit human click on a control the AI cannot reach (separate code path, not just a prompt instruction).
- Every AI-proposed action renders as a **preview ticket** the user reviews before execution: symbol, side, qty, order type, limit price, est. cost, fees, buying-power impact, and a plain-language restatement ("You are BUYING 100 AAPL, ~$X, using Y% of buying power"). Nothing executes from natural language alone.
- Show the assistant's **parsed interpretation and confidence** for every command, plus the exact parameters extracted, so the user catches misreads ("sell all" vs "sell half"). Low-confidence parses ask a clarifying question instead of guessing.
- Hard guardrails the AI cannot override: per-order and per-day notional caps, restricted-symbol lists, leverage/options-level limits, and a global "AI may not place orders" master switch that is **ON by default** for new accounts.
- Keep an immutable, user-visible **audit trail** of every AI suggestion and who approved it; "Why did this happen?" is answerable in one click.
- Make AI-staged controls **visually distinct** ("drafted by Assistant" badge / dashed border) so an AI-filled ticket is never mistaken for a user-typed one.

**Tier 1 — Order entry & destructive-action safety**
- Calibrate friction to consequence: trivial friction for reversible acts (add to watchlist), deliberate friction for irreversible ones (submit/cancel/flatten). Market orders, oversized orders (>X% of buying power or ADV), and short sells get an extra confirm; a small limit order does not.
- Replace blind "Are you sure?" dialogs with **review-what-changed confirmations** that restate the actual consequence; require an action proportional to risk (button for normal, typed quantity or hold-to-confirm for account-flattening).
- **BUY/SELL controls must be unmistakable**: color + label + icon redundancy (never color alone), side-swap requires a distinct gesture. Per Fitts's Law, make the correct action a large/close target and the destructive one smaller/farther.
- **Default to the safest order type and a sane price**: limit pre-filled at a reasonable reference, quantity blank/0 (never a pre-filled non-zero qty), TIF = Day.
- **Inline real-time validation**: insufficient buying power, fat-finger price guard (">N% from last"), invalid lot size, market-closed, PDT violations — surfaced next to the field before submit. Block on hard errors; warn (don't block) on soft ones.
- **One-click flatten/cancel-all** exists but is guarded — reachable in a panic (big, fixed location) yet protected by confirm/hold.

**Tier 2 — Undo, cancel, feedback & optimistic UI**
- Provide **undo/cancel windows wherever physics allows**: a brief "Cancel" on just-submitted orders before they reach the exchange; instant modify/cancel on resting orders. Once filled, offer "close position," not a fake "undo."
- **Optimistic UI only for reversible/low-stakes feedback.** For orders, show true state transitions (Submitting → Working → Filled/Rejected) — never a fake "done."
- **Sub-100ms visual feedback** on every control press, decoupled from the network round-trip, so the UI never feels dead.
- **Explicit, specific error/rejection messages** ("Rejected: limit below NBBO" / "Insufficient buying power: need $X, have $Y") placed where the action was, with the corrective next step.

**Tier 3 — Keyboard, hotkeys & command palette**
- **Command palette (Ctrl/Cmd-K)** for fuzzy/natural-language entry ("buy 100 AAPL limit 230") that routes into the same preview ticket — fast to invoke, but execution still goes through the standard confirm path.
- **Discoverable, remappable hotkeys** (focus ticket, set side, increment qty/price by tick, repeat last order, cancel-all) with an always-available cheatsheet ("?") and shortcuts shown inline on buttons.
- **Dangerous hotkeys are opt-in or require a deliberate combo** (one-key market order is off by default).
- Predictable focus order, visible focus rings, Enter/Escape semantics; confirm dialogs default-focus the **safe** choice.

**Tier 4 — Affordances, signifiers, mode reduction**
- Controls look like what they do; no mystery-meat icons — pair every icon with a label/tooltip.
- **Minimize modes; eliminate mode-errors** — prefer always-visible explicit side selection over a sticky global "buy/sell mode."
- **Persistent account-state visibility** (buying power, positions, pending orders, day P&L, market-open) so the user has context before acting.
- Consistency across every order surface (ticket, chart-trade, palette, AI ticket): same field order, defaults, confirm behavior.

**Tier 5 — Accessibility, onboarding, progressive disclosure**
- Full control accessibility: keyboard-operable everything, ARIA roles/labels, status announced via live regions, 44px+ touch targets, WCAG-AA contrast.
- Progressive disclosure: novices see a simple limit/market ticket; advanced order types (bracket, OCO, trailing, options legs) reveal on demand.
- Just-in-time coach-marks on first use of risky controls; a **paper-trading sandbox** to learn controls before real money.
- A clearly marked, unmistakable **LIVE vs PAPER** mode (banner/color theme) — one of the costliest mode-errors possible.

---

## 2. Layout & Information Architecture

**Top-level structure & navigation**
- Persistent **left icon-rail** (Dashboard, Markets, Watchlists, Positions, Trade, Research, Assistant, Alerts, Settings) so the workspace never reflows on context switch; reserve the top bar for account state, market-status clock, search, and connection/latency indicators.
- A **global command palette (Cmd/Ctrl-K)** as the fastest path to any symbol, screen, or action.
- Center on a single **Trade Terminal workspace** (chart + watchlist + detail + order ticket) rather than many shallow pages; treat Portfolio/Research/Settings as secondary.
- **Symbol is the universal routing primitive**: clicking any ticker anywhere deep-links the active workspace and syncs every linked pane.

**Dashboard composition**
- Home dashboard as a configurable card grid with strict hierarchy: portfolio value + day P&L hero strip → movers/positions/market overview → news/calendar. Lead with "what changed since I last looked."
- 12-column responsive grid with drag-resizable, dockable widgets and **savable workspaces** ("Pre-market," "Active trading," "Research").
- Uniform widget chrome (title, context, overflow menu, collapse-to-header).

**Dense market-data panels**
- Standardized table component: sticky headers, virtualized rows, right-aligned **tabular numerals**, column choosers.
- Encode change with color + sign + a subtle directional tick-flash (colorblind-safe alt palette + up/down glyph); flashes short and disable-able.
- Density scale (compact / comfortable / spacious) as a setting; default traders to compact.
- Reserve saturated color exclusively for P&L/price direction; chrome stays muted neutral; dark theme by default.

**Watchlist / detail / chart / assistant**
- Classic 3-zone terminal: narrow left watchlist, dominant center chart + tabbed detail (quote, options chain, depth, news, fundamentals), right-side order ticket — with the assistant as a dockable 4th zone.
- Shared "active symbol" context across panes; per-pane "lock to symbol X" pin to break sync for comparison.
- Tabbed center detail; resizable/maximizable/pop-out chart.
- Symbol comparison via ticker tabs or split workspace.

**LLM assistant coexistence**
- Default the assistant to a **collapsible right-edge rail** (hotkey toggle) that overlays/pushes rather than permanently consuming the chart.
- Make it **context-aware of the active symbol/panes**; show bound context as a removable chip.
- Render outputs as **structured actionable cards** (quote card, mini-chart, "draft order" card that pre-fills the ticket), not walls of text.
- Distinguish AI content (accent border/badge) and always show provenance/timestamp on cited data.
- Offer a second surface via inline Cmd-K "ask" for quick lookups; persist longer research in the rail with thread history.

**Progressive disclosure, responsive & multi-monitor**
- Layer complexity (clean quote by default; options chains, Level 2, Greeks behind expanders / "Advanced" mode); beginner/pro mode switch.
- **Multi-monitor as first-class**: panes pop out into independent OS windows with persisted arrangement.
- Explicit breakpoints: full terminal on desktop → 2-zone on laptop → single-column stacked with bottom tab bar on mobile (never horizontal-scroll the terminal; order ticket becomes a slide-up sheet).

**Empty / loading / error states**
- Branded, instructive empty states (empty watchlist → "Add symbols or ask the assistant"; empty portfolio → connect-broker CTA).
- **Skeleton loaders** matched to each widget's final shape; stream data progressively.
- Per-pane **data-staleness/connection indicator** (live / delayed / disconnected / last-updated).
- Differentiate error severity: inline banners for degraded feeds, blocking modals only for execution failures; never wipe an in-progress order ticket on a transient error.

---

## 3. Aesthetic & Visual Design

**Quick wins (replace the default GitHub Pages look)**
- Strip the stock theme; ship a **dark-first shell**: near-black background (`#0B0E14`), elevated surface panels (`#141925`), a single restrained accent.
- Replace the centered `<h1>` + tagline with a real wordmark/nav bar; add favicon, OG/social card, theme-color meta.
- Self-host an intentional font pairing as `woff2` (avoid FOUT); set a global `:root` design-token sheet.

**Color system (highest impact)**
- Dark-first **layered elevation ramp** (background → surface → raised → overlay) via measured lightness, not opacity hacks.
- **Semantic up/down tokens** (`--pos`, `--neg`) decoupled from raw hex for instant re-theming.
- **Colorblind-safe mode** (teal/amber or blue/orange); never hue alone — pair every up/down with ▲▼ and +/−.
- Tune green/red for dark backgrounds (desaturate, lift luminance to pass contrast on `#0B0E14`).
- Full status palette (info/warning/critical/neutral) with precomputed AA-contrast on-colors.
- Calm low-chroma neutral gray ramp for the 90% of UI that isn't data; explicit categorical + sequential/divergent data palettes (OKLCH-spaced).
- Optional light/"daylight" theme from the same tokens; `prefers-color-scheme` auto-switch.

**Typography & number hierarchy**
- **Tabular numerals everywhere numbers live** (`font-variant-numeric: tabular-nums`) — the single biggest "feels like a real terminal" upgrade.
- Pair a humanist/grotesque UI sans (Inter / IBM Plex Sans) with a numeric monospace (IBM Plex Mono / JetBrains Mono).
- Modular type scale with named tokens; encode number hierarchy (big figure, small muted unit, signed/colored delta).
- Right-align numeric columns, consistent decimals per instrument; slashed zero, lining figures in headers.

**Spacing, density, data-viz, motion, tokens**
- Explicit density modes (Comfortable / Compact / Terminal) as a token-driven switch; 8px (+4px sub-step) scale.
- Minimal charts (thin axes, muted gridlines, max data-ink); inline sparklines; OKLCH heatmaps with legend + on-cell values; semantic up/down candlesticks.
- Motion token set (120/200/320ms), calm microinteractions (tick flash, odometer roll on big figures), **respect `prefers-reduced-motion`**; skeleton shimmer loaders.
- Three-tier **design tokens** (primitive → semantic → component) as a single source of truth (Style Dictionary → CSS vars) so dark/light/colorblind/density modes are all token-set swaps. Distinct ownable brand accent used sparingly; consistent radius/border/elevation scales.

---

## 4. Options, Flexibility & Accessibility

**Accessibility foundations (WCAG 2.2 AA) — highest impact**
- Native semantic HTML / full ARIA so screen readers announce role, name, state, value on every control.
- Full keyboard operability, logical tab order, no traps, Escape closes overlays.
- Visible high-contrast focus indicators (Focus Appearance / Focus Not Obscured — sticky headers must not hide focus).
- Contrast minimums (4.5:1 text, 3:1 UI/graphics); never meaning-by-color-alone — pair P&L/candles with icons/signs.
- `prefers-reduced-motion` mode; never flash >3×/second.
- Focus management on route/modal changes; ARIA live regions for ticks/fills/alerts (polite vs assertive, not spammy).
- 200% zoom / 400% reflow support via rem-based fluid type; "view as table" toggle for every chart.
- Skip-links, landmarks, descriptive titles; 24×24px min targets with accessible drag alternatives; labeled forms with `aria-describedby` errors and confirmation for transactions.

**Theming, layouts & widgets**
- Light / dark / true-black (OLED) + high-contrast + system-auto themes; user-selectable gain/loss schemes (incl. East-Asian red-up); accent customization; import/export theme presets.
- Draggable/resizable/dockable grid; named, duplicable, cloud-synced **workspaces**; persona starter templates; multi-monitor tear-off; reset-to-default + per-widget lock.
- Per-widget config (columns, sort, refresh rate, symbol scope); widget gallery; multiple instances; configurable AI-assistant widget (verbosity, risk tone, allowed sources, proactive vs on-demand).

**Watchlists, screeners, alerts, data options**
- Multiple named watchlists (custom columns/sort/grouping/tags); composable screener (AND/OR fundamentals + technicals + AI signals), saved screens, screen→watchlist piping.
- Flexible **alert rule engine** (price/%/volume/indicator/news/AI-signal) with thresholds, cooldowns, expiry; per-channel routing (in-app/push/email/SMS/webhook) with quiet hours and grouping to prevent fatigue; natural-language alert creation.
- Data-source priority + real-time/delayed indicators; configurable timeframes, sessions (regular vs extended), adjusted/unadjusted; default chart type + saved indicator templates; configurable benchmarks.

**Preferences, i18n, export**
- **Novice / Intermediate / Pro** experience mode that progressively unlocks complexity; distinct per-context profiles ("Retirement" vs "Active Trading"); searchable preferences hub; "Labs" feature flags; persisted default order params with safety confirms.
- Full i18n (strings, locale date/number/%, RTL); configurable display currency with FX conversion; configurable timezone; locale large-number conventions (lakh/crore); decimal/thousands separators.
- Export/import watchlists, screens, layouts, alerts, themes (JSON/CSV); export data/charts (CSV/Excel/PNG/SVG/PDF); account-level data portability (positions, history, tax lots); shareable read-only links; webhook/API access.

---

## 5. Financial Markets Capabilities

**Market-data foundation (nothing works without it)**
- Primary real-time consolidated equities/ETF feed (NBBO) with per-symbol delayed-vs-realtime labeling (Polygon.io / Alpaca / Finnhub / Databento; free-tier fallback IEX-style / Yahoo delayed).
- **Streaming WebSocket** quotes (not just REST polling) for live tick/L1/prints so P&L updates intraday.
- Multi-asset normalized symbology (US/global equities, ETFs, options, FX, crypto) via FIGI/OpenFIGI identity resolution.
- Crypto real-time + historical (Coinbase/Binance/Kraken/Crypto.com) incl. order-book depth, mark/index price, funding rates.
- FX spot/cross rates (exchangerate.host, ECB EOD); historical OHLCV + adjusted close (Polygon/Tiingo/Stooq); options chains with greeks/IV/OI (Polygon/Tradier/ORATS).
- Corporate-actions handling, market-hours/holiday/session awareness, and a **data-quality layer** (vendor failover, staleness detection, bad-tick filtering, visible source stamp).

**Portfolio, P&L, risk, sizing**
- Multi-account, multi-currency aggregation with FX-effect attribution; real-time + historical P&L (unrealized/realized, by asset/sector/strategy); TWR + money-weighted (XIRR), benchmark-relative, Sharpe/Sortino/Calmar.
- **Tax-lot tracking** (FIFO/LIFO/HIFO/specific-ID), wash-sale flagging, holding-period classification; brokerage sync (Alpaca / SnapTrade / Plaid Investments) read-only and trade tiers; dividend/income tracking.
- Risk analytics: gross/net + sector/factor/country/currency exposure, concentration limits; **VaR & Expected Shortfall** (historical/parametric/Monte Carlo); portfolio greeks + scenario shocks; drawdown analytics; vol/correlation/risk-contribution; historical stress tests; liquidity (days-to-liquidate vs ADV).
- Position sizing (fixed-fractional, vol-targeted/ATR, fractional-Kelly, max-loss-per-trade); pre-trade risk/reward + margin/buying-power checks; tax-aware rebalancing trade lists.

**Orders, news, fundamentals, screening**
- Full order-type vocabulary in planning/paper (market/limit/stop/stop-limit/trailing/MOC-LOC/bracket/OCO/TWAP-VWAP intent), TIF (DAY/GTC/IOC/FOK), extended-hours flags; **fees & slippage modeling**; simulated fills vs live NBBO (live routing only via licensed broker).
- Event-driven **backtester** + **paper-trading sandbox** with realistic fills/fees/slippage, survivorship-aware universes, walk-forward validation, backtest-vs-live tracking error.
- News aggregation tagged to holdings (FMP/Finnhub/Benzinga/GDELT) + sentiment + LLM filing/transcript summarization; economic calendar (FRED/Trading Economics), earnings calendar, macro dashboard.
- Fundamentals/valuation (statements, ratios, DCF, analyst targets; FMP/SEC EDGAR/Quartr); SEC filings + summarization (10-K/Q, 8-K, 13F, Forms 3/4/5); insider/institutional/government-trading signals; ESG + ETF look-through; earnings-call transcripts.
- Multi-factor screeners + saved scans; technical-indicator library; price/indicator/news/earnings alerts with push.

**Regulatory & compliance (mandatory, cross-cutting)**
- Persistent "informational only — not personalized advice" disclaimer on every analytic/alert/AI output, with timestamp + source attribution.
- Clear separation of informational features from order placement; live trades only via licensed broker-dealers (you remain a tool, not an RIA/BD).
- Suitability/risk-tolerance gating; "past performance ≠ future results" on backtests/projections/VaR (state assumptions/limitations).
- Market-data **licensing/redistribution compliance** (real-time vs delayed entitlements, exchange display agreements); PDT/margin/options-approval awareness; crypto-specific disclosures; audit trail + PII encryption; never store brokerage credentials (use OAuth/token aggregators).

---

## 6. Trading Algorithms & Quant

**Foundational architecture**
- Modular framework with strict stages: `signal → sizing → portfolio construction → execution → risk overlay`, each a typed, versioned, independently testable interface.
- Single **point-in-time data layer** distinguishing information-available time vs event time, so no stage reads data it couldn't have known.
- **Event-driven backtester** as source of truth for realism; keep a fast vectorized backtester only for coarse research, never final validation.
- Deterministic, reproducible runs (fixed seeds, pinned data snapshots, config hashing, run manifest).

**Validation & bias avoidance**
- Walk-forward analysis (rolling/anchored), parameters fit only in-sample, metrics reported only out-of-sample; a **lockbox holdout** touched exactly once before go-live.
- Eliminate lookahead (lag signals ≥1 bar, as-of fundamentals), survivorship (include delisted symbols + historical index constituents), and model corporate actions; data-quality gates (gaps/outliers/halts/stale quotes/timezone).

**Overfitting controls**
- Track trial count; apply multiple-testing corrections (deflated Sharpe, White's Reality Check/SPA, Probability of Backtest Overfitting).
- Prefer parameter **plateaus** over peak points; combinatorial purged CV with embargo for ML signals; cap complexity vs sample size; require an economic rationale per signal.

**Strategy families, sizing, execution, metrics**
- Momentum/trend (vol-scaled), mean-reversion (z-score/OU half-life), stat-arb (cointegration/PCA-residual), market-making (inventory-aware Avellaneda-Stoikov), factor/risk-premia, event/calendar.
- Vol-targeting & risk-parity sizing; fractional-Kelly/drawdown-aware with hard per-position/sector/gross-net caps; **risk overlay** (max DD, daily loss, concentration, leverage, correlation-cluster limits); **kill-switches/circuit breakers** (auto-flatten on breach, data staleness, NaN/anomaly, reject-rate) + manual master kill; pre-trade fat-finger/size/collar/buying-power/restricted-list checks.
- Explicit transaction-cost model (commissions/fees/spread/square-root market impact); slippage & partial fills via book/volume participation; execution algos (TWAP/VWAP/POV/implementation-shortfall); separate alpha decay from execution cost; latency/queue modeling for HFT.
- Full metric suite (CAGR, Sharpe, Sortino, Calmar, max DD + duration, hit rate, profit factor, turnover) with bootstrap CIs; factor/risk attribution (separate alpha from disguised beta); per-regime tear sheets; live-vs-backtest tracking-error & signal-decay dashboards.

**LLM assistance (advisory only)**
- LLM for **ideation** (signals/regimes/features) that always feed the rigorous backtest pipeline before any trust; for **code-gen** of strategy/indicator/backtest scaffolding gated by tests/types/human review; for **explaining** tear sheets and flagging overfitting/bias; for research/filing synthesis into point-in-time features — never a real-time trade trigger.
- **Hard architectural boundary**: the LLM can read data and write/annotate code/reports, but has no path to place/modify/cancel live orders; all order actions require deterministic code + explicit human authorization. Log every suggestion + downstream outcome for an auditable track record.

---

## 7. Databases & Retrieval (RAG)

**Foundational stack (do first)**
- Standardize on **Postgres + pgvector** as the single primary store for vectors, chunk text, metadata, and relational data — one ACID system avoids cross-store sync and is sufficient well past millions of chunks.
- Add **TimescaleDB** (Postgres extension) for OHLCV/quote/tick time-series (hypertables, ~90% compression, continuous aggregates for pre-rolled bars) so market data and RAG live in one cluster.
- **Hybrid retrieval from day one**: dense (pgvector) fused with lexical (Postgres FTS BM25-style) via Reciprocal Rank Fusion — critical in finance where tickers/CUSIPs/dates/numbers must match literally.
- Add a **cross-encoder reranker** (Cohere Rerank / hosted bge-reranker) over top-~50 hybrid candidates → ~5-8; typically the single largest precision win.
- **Strict metadata pre-filtering** on every query (ticker, sector, doc_type, source, as-of dates) pushed into the SQL `WHERE` clause — essential for correctness and tenant isolation.

**Schema & chunking**
- Normalized hierarchy `documents → chunks` so citations resolve to exact source/section/offset; rich typed + JSONB chunk metadata (ticker[], cik, doc_type, section, published_at, period_end, fiscal_period, source, url, language, token_count).
- **Structure-aware chunking** (by SEC item / news paragraph / earnings-call speaker turn), tables kept atomic; **contextual retrieval** (prepend parent-doc/section summary before embedding); distinct `period_end`/`as_of` temporal axis to avoid look-ahead.

**Indexing, freshness, multi-tenancy, audit**
- **HNSW** default (tune `m`, `ef_construction`, per-query `ef_search`); IVFFlat only for very large write-heavy corpora; explicit embedding dimension/version; halfvec/quantization to cut index memory; partial/composite indexes + partitioning aligned to hot filters; a **retrieval eval harness** (recall@k, nDCG, citation faithfulness) wired into CI.
- Incremental idempotent ingestion (EDGAR/news/transcripts keyed on accession/GUID) via a durable job queue with dead-letter + backfill; per-document ingestion state + content hash; freshness SLAs/monitoring.
- **Tenant isolation** via mandatory `tenant_id` + Postgres Row-Level Security; **data versioning/lineage** (immutable content-hashed versions, valid_from/valid_to); **per-answer grounding records** (query, retrieved chunk IDs + scores, model versions, final prompt) for auditable/reproducible answers; source provenance + licensing; feedback/eval store for reranker tuning.
- **Scale beyond Postgres only when metrics demand**: Qdrant (first step), Milvus (100M+), Weaviate (built-in hybrid), Pinecone (ops-light managed); ClickHouse for heavy analytics; Parquet-on-object-storage as cheap archive/backtest tier; separate OpenSearch only if Postgres FTS becomes the bottleneck.

**Concrete starting stack:** Postgres 16 + pgvector (HNSW, hybrid dense+FTS with RRF) + TimescaleDB in one managed cluster · Cohere/bge reranker on top-50 · RLS multi-tenancy · content-hashed versioned docs/chunks · durable ingestion queue · per-answer grounding records · Parquet archive — graduating to Qdrant/ClickHouse only when measured latency/scale require it.

---

## 8. Cache, Embeddings & Memory

**Semantic & LLM response caching (highest cost/latency impact)**
- **Anthropic prompt caching** (`cache_control: ephemeral`) on the stable prefix — system prompt, tool schemas, few-shot exemplars, user profile block — to cut input cost ~90% and TTFT; order context most-static-first. Keep the prefix warm within the 5-min TTL; promote slow-moving high-reuse content (disclaimers, playbooks, profile) to the **1-hour extended TTL**.
- **Semantic response cache**: embed normalized query, ANN-lookup prior (query, answer) pairs, serve above ~0.92-0.95 cosine — but **gate by freshness class** (never cache live quotes/positions/order status; only evergreen content). Normalize before hashing/embedding (canonicalize tickers, resolve "today"); exact-hash L1 + semantic L2. Memoize deterministic tool computations keyed by `(inputs, as-of)`.

**Embeddings**
- Pick a finance-tuned/strong general model and **benchmark recall@k on your own queries** (MTEB is a starting point); use **Matryoshka (MRL)** truncation (query at reduced dim, store full for rerank); **quantize** stored vectors (int8/binary) with full-precision rerank on the shortlist.
- **Pin model version** per vector; re-embed only on model or content change (hash chunk text); dual-write/shadow-index migrations (never mix vector spaces); asymmetric query/passage encoding if supported.
- Content-addressed **embedding cache** (`hash(normalized_text + model_version)`) with cross-user dedupe; batch + coalesce in-flight duplicates; near-duplicate dedupe before insert to prevent index bloat.

**Multi-tier memory**
- **Short-term**: recent turns verbatim; summarize-and-compact older turns (preserve decisions/constraints) rather than truncate.
- **Long-term profile**: compact structured slowly-changing record (risk tolerance, horizon, watchlist, sectors, constraints) injected into the cached prefix, updated via explicit writes.
- **Episodic trade history**: structured events (timestamp, instrument, action, size, rationale, context, outcome) retrievable by metadata + semantic similarity.
- **Semantic knowledge**: the RAG KB (strategies, definitions, regulations) — separate store, separate freshness policy. Keep the four tiers in separate namespaces; merge only at prompt-assembly time.

**Write/forget policies, personalization, staleness, budgets**
- Write selectively (lightweight extraction pass — don't persist every utterance); **reconcile on write** (upsert, supersede contradictions, timestamp); forget policy (TTL/decay on episodic, archive stale conversation, hard-delete on request/PII); periodic compaction into higher-level patterns; importance×recency×relevance ranking on retrieval.
- Retrieve analogous **past decisions** to ground advice in the user's actual behavior; personalize retrieval/ranking by profile + history; surface realized outcomes.
- **Never cache live market data** in the semantic layer; tier TTLs by velocity (quotes sub-second/none, intraday seconds-minutes, fundamentals hours-days, static until source changes); **event-driven invalidation** (fill, price-band breach, earnings, corporate action); always stamp injected context with as-of and keep volatile data in the **uncached suffix** so the cached prefix keeps hitting.
- Per-request token/latency budgets with degradation tiers; **tier models by task** (cheap/fast for routing/classification/extraction, flagship for final reasoning); instrument cache-hit rates + cost-per-conversation; cap retrieval breadth; precompute embeddings/profile prefix off the hot path.

---

## 9. Prompting & LLM Orchestration

_(Authored to cover the panel gap; aligned to Anthropic/Claude best practices.)_

**System prompt & role framing**
- A clear, durable system prompt that fixes the assistant's role ("an informational markets research assistant — not a licensed advisor, cannot place trades"), tone, and hard boundaries; put it in the **cached prefix** with tool schemas and exemplars.
- Encode refusal/guardrail patterns explicitly: decline personalized investment advice, refuse to "guarantee" returns, and never claim to have executed a trade. Provide an approved redirect ("Here's the data and the trade-offs; the decision and execution are yours").

**Tool use & structured output**
- Express every market action as a **structured tool/function call** (get_quote, run_screen, draft_order) — the model proposes; deterministic code validates and a human confirms. Never let the model "execute" by emitting prose.
- **Delegate all math to tools** (P&L, position sizing, greeks, indicator values) — LLMs are unreliable at arithmetic; the model orchestrates and explains, code computes.
- Emit **JSON conforming to a schema** for anything the UI renders (cards, tables, draft tickets) so output is machine-parseable, not scraped from prose.
- Enforce **grounding/citation**: answers about filings/news must cite retrieved chunk IDs; if retrieval returns nothing relevant, the model says so rather than hallucinating.

**Reasoning, accuracy & uncertainty**
- Use extended/chain-of-thought reasoning for genuinely analytical questions, but keep **final answers concise**; separate the reasoning from the user-facing summary.
- Require explicit **uncertainty/confidence communication** (data as-of, assumptions, "this is not a recommendation") instead of false precision.
- Few-shot exemplars for the app's specific output formats (a good "draft order" card, a good earnings summary); zero-shot for open Q&A.

**Multi-agent decomposition & model tiering**
- Decompose into roles: a **Researcher** (retrieval + summarization), an **Analyst** (computes via tools, interprets), an **Explainer** (plain-language, guardrailed). Each can run on the cheapest model that suffices.
- **Tier models by cost/latency**: Haiku for routing/classification/extraction/memory-writes, Sonnet for most interactive analysis, Opus for the hardest reasoning. Route dynamically based on task complexity and budget.
- Streaming responses for perceived latency; show tool-call progress ("fetching AAPL quote…") so the user sees work happening.

**Evaluation & safety harness**
- A **prompt regression-test suite**: a fixed set of inputs with expected behaviors (correct refusals, correct tool selection, citation present, no fabricated numbers) run in CI on every prompt change — treat prompts as versioned code.
- Adversarial tests for the dangerous cases: jailbreak attempts to make the AI place trades, prompt-injection from ingested news/filings, requests for guaranteed-return advice. Injected/retrieved external text is **data, not instructions** — sandbox it and never let it escalate tool permissions.
- Log prompts, tool calls, retrieved context, and outputs (the grounding records from §7) so every answer is reproducible and auditable.

---

## 10. Machine Learning & Continuous Learning

_(Authored to cover the panel gap.)_

**Honesty first — what ML can and can't do here**
- Be candid that financial markets are **low signal-to-noise and non-stationary**; most naive ML "predict the price" approaches overfit and fail live. Frame ML as an **edge-finder and assistant**, not a money printer, and always **benchmark against a naive baseline** (last-value/random-walk for prices, equal-weight for allocation) — a model that can't beat the baseline ships nothing.
- Prevent **leakage** ruthlessly (point-in-time features, proper time-series CV with embargo — never random k-fold on time series); guard against survivorship/lookahead exactly as in §6.

**High-value, realistic ML applications**
- **NLP/sentiment** on news, filings, and earnings transcripts (classification, summarization, event extraction) — among the highest-ROI uses, feeding structured point-in-time features.
- **Anomaly & regime detection** (volatility regimes, unusual volume/price action, change-points) to adapt UI and risk posture.
- **Ranking/recommendation** for watchlist ideas and screener results — learning-to-rank from user engagement, framed as exploration not prediction.
- **Time-series forecasting** of volatility (more tractable than price), with classical baselines (ARIMA/GARCH/exponential-smoothing) before deep models; report calibrated intervals, not point guesses.
- **Personalization** of the assistant from explicit feedback (thumbs, accepted vs dismissed suggestions) — a preference signal / RLHF-lite loop, kept well clear of anything that places trades.

**MLOps lifecycle**
- **Feature store** with point-in-time correctness; experiment tracking, a model registry, and reproducible pinned-data training runs.
- **Walk-forward / out-of-sample evaluation** with deflated metrics and multiple-testing awareness; a lockbox holdout before promotion.
- **Model monitoring & drift detection** in production (feature drift, prediction drift, performance decay) with automatic alerts; clear online vs batch retraining policies (most things batch; only retrain online with strong guardrails).
- Track **live-vs-backtest tracking error** so model decay is visible early; every model output that reaches the user is logged for later evaluation.

**Pitfalls to flag loudly (anti-overfitting culture)**
- Beware p-hacking across many trials; prefer simple, economically-motivated models with stable parameter plateaus.
- Never present a backtest as a forecast; always attach "past performance ≠ future results" and confidence/assumptions.
- Keep ML strictly **advisory** — like the LLM, no model has a path to autonomously place, modify, or cancel live orders.

---

## 11. Immediate Fixes for the Current Repository

These are literal do-now items for the existing placeholder page, independent of the larger product:

- **Remove dead/legacy code**: the `google-analytics.com/ga.js` snippet (`UA-63193536-1`, long-deprecated Universal Analytics), the `<!--[if lt IE 9]>` conditional + `html5shiv` over HTTP, and the `chrome=1`/`X-UA-Compatible` meta.
- **Replace placeholder content**: the default "Welcome to GitHub Pages" body in `index.html` and `params.json` says nothing about the product.
- **Fix the viewport meta**: `user-scalable=no` blocks pinch-zoom and is an accessibility regression — drop it.
- **Add basics**: favicon, meta description, OG/social card, `theme-color`, and a real `<title>`/wordmark.
- **Modernize analytics** (if wanted): a current privacy-respecting analytics tag over HTTPS, or remove tracking entirely.
- **Decide the architecture** before building the app proper: a static marketing page can stay on GitHub Pages, but the trading terminal needs a real front-end framework + a server-side BFF (LLM keys and broker tokens must never touch the client).

---

## 12. Suggested Sequencing (90-day-ish view)

1. **Foundation (weeks 1-3)** — clean up the placeholder; choose framework + BFF architecture; stand up Postgres + pgvector + Timescale; pick market-data + LLM providers; ship the design-token system and dark-first shell.
2. **Core terminal (weeks 3-8)** — 3-zone terminal layout, tabular-numeral data tables, real-time WebSocket quotes with staleness indicators, watchlists, charting, the order-ticket UX (paper-trading only), and the safety/confirmation model from §1.
3. **Assistant (weeks 6-12)** — RAG over filings/news with grounding + citations; the collapsible assistant rail with structured-card output; prompt-caching + multi-tier memory; the **advisory-only** guardrails and audit trail; prompt regression-test harness.
4. **Depth (ongoing)** — backtester + quant framework, risk analytics (VaR/greeks/drawdown), screeners/alerts engine, ML sentiment + anomaly detection, accessibility audit to WCAG 2.2 AA, customization/workspaces, and broker integration (read-only first) behind compliance review.

---

_Panel: Layout/IA · Visual Design · Interaction/Intuitiveness · Flexibility/Accessibility · Financial Markets · Trading Algorithms/Quant · LLM Databases/RAG · Cache/Embeddings/Memory · Prompt Engineering · Machine Learning. Sections 1-8 synthesized from independent domain-expert analyses; sections 9-12 authored to complete coverage._
