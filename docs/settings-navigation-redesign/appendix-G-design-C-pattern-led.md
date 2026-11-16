# Appendix G — Design C (Pattern-led team)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

# Design C: The Pattern-Led Synthesis — "Scope-Bound Autonomy"

## Core mental model

The user does not "use an app." The user **oversees a fleet of autonomous agents, one per broker account, each operating under an enforced authority boundary.** Two facts must be true at every instant, on every screen:

1. **Which account am I looking at, and is it real money?** — answered by a persistent, colored account scope in the shell.
2. **What is that account's agent allowed to do right now, and what has it done?** — answered by a live status surface and a per-account decision log.

Everything else is subordinate to these two questions. The product's defining tension — a *pro-terminal configuration surface* operated in a *consumer trust posture* with *real money moving while no human watches* — is resolved not by choosing a side but by layering: **consumer-app navigation restraint on top, pro-terminal config density underneath, infra-SaaS scope enforcement as the spine, and algo-platform autonomy gating as the safety ladder.**

The load-bearing insight, shared by all five proposals: **scope is not a view filter, it is an authority grant.** A wrong scope in Stripe shows wrong data; here it points an autonomous agent at the wrong real-money account. So scope is route-encoded, credential/data-plane-bound, fail-neutral, and ambient-colored — never a soft toggle.

## Design principles (with the borrowed pattern named)

1. **Scope switcher, top-left, persistent, never a tab** *(Public "All accounts", Stripe, Notion, Vercel)* — the single most load-bearing safety primitive.
2. **Ambient color per money-reality, loudest = highest consequence** *(AWS account colors, Stripe test/live)* — Test = gray, Paper = blue, **Live = red band**.
3. **Environment enforces, not just displays** *(Stripe greys live-only controls in test)* — wrong-scope actions are structurally impossible, not merely discouraged.
4. **Route encodes scope; fail to a neutral no-account state** *(GitHub `/org/repo`, GCP project-in-URL, AWS "fail to gray")* — a stale tab or deep link cannot act on the wrong account; automated paths never inherit ambient scope.
5. **Two orthogonal axes: money-reality × authority — never one slider** *(Alpaca paper→live, HITL→HOTL)* — "go live" and "let the AI fire unattended" are independent, each gated separately.
6. **Strategy is a first-class named object with provenance** *(Composer Symphony, QuantConnect algorithm, Betterment goal)* — every position/order/log entry is attributed to the strategy that produced it; AI-driven activity is visually separated from hand-placed.
7. **Presets encode intent, carry a scope badge, diff-on-apply** *(Betterment goal-types, Wealthfront risk score; Linear/Notion apply-into-scope)* — a broad preset can never silently overwrite an account's safety limits.
8. **Settings layered account-default → override, every value labeled by origin** *(Linear workspace/personal, Slack lock icon, GitHub inherit-and-tighten)*.
9. **Dense config = scope-first, searchable, collapsed tree + object-scoped gears; depth capped at 2 levels** *(TWS Global Config, tastytrade panel gears, NN/g)*.
10. **Type-to-confirm friction reserved for the two one-way doors only** *(GitHub/AWS destructive-action confirms)* — arming Live, and arming Auto-on-Live. Cheap friction everywhere else is alert fatigue.
11. **Legible guardrails + live "the bot is doing X" status + always-reachable kill switch** *(Schwab ">5% drift", QuantConnect live dashboard + logs, Composer liquidate)*.

## Target top-level navigation

A persistent **shell** wraps five **verb tabs**. Account switching and configuration are *not* tabs.

**Persistent shell chrome (every screen):**
- **Top-left — Account scope chip:** `alias · broker · MODE-badge` with ambient color band (gray/blue/red). Opens the "All accounts" panel. Shows a neutral **"No account selected"** blocking state when scope is unresolved.
- **Beside it — Autonomy tier chip:** `Off / Propose-only / Auto-with-guardrails`.
- **Top-right — Global "Pause all" kill switch** + avatar → **Menu hub**.
- **Chat** is a scope-aware slide-over (reads current account, proposals route through the same gates), not a tab.
- **Routes:** `/a/:accountId/{dashboard|proposals|scan|activity|strategy}`; global surfaces live outside the namespace: `/settings/*`, `/presets/*`, `/accounts`.

**The five tabs (verbs, all scoped to the active account):**

| Tab | Purpose |
|---|---|
| **Dashboard** | "What is this account's agent doing right now." Equity/cash/buying-power, open positions (**attributed to strategy**), agent state (running/paused/errored), next scheduled run, macro/regime chip, and **live guardrail-budget gauges** (daily notional used, drawdown vs high-water, remaining risk). The trust surface. |
| **Proposals** | The HITL approval queue. Each card shows target account + color + remaining risk budget + thesis tag + entry regime + which gates it passed, inline. Approve / reject / edit. Below: the chronological **AI decision log** (placed / blocked-with-reason / expired). |
| **Scan** | Market scan output — ranked candidates, factor scores, web-signal bulletins, skipped-candidate view, watchlist, macro/regime. Read-heavy, advisory; does not gate opens. |
| **Activity** | Per-account fills, closed-lot P&L, benchmark vs SPY, thesis/regime scorecards, and the full audit trail. The compliance surface. |
| **Strategy** | The account's bound strategy object + dense per-account config (searchable tree). Apply presets here with diff-confirm. |

*Rationale:* every consumer app studied caps at ~5 tabs; new capability becomes a preset, a gear, or a Menu entry — never a new tab. Density lives inside panels, not navigation.

## Multi-account model

**Entities.** *User* (global identity, keys, notifications, appearance) → owns many *Accounts* (the scope unit: broker + environment + tax type + capabilities + its own resolved policy) → each bound to one *Strategy* (many-to-one, with provenance) → *Strategy Presets* are portable, user-global objects **applied into** accounts.

**The "All accounts" panel** (Public model). One row per account, each answering broker / type / mode / authority / strategy / balance / health in a line:
```
● Roth IRA · Alpaca      [PAPER]  $12,340  Momentum-Aggressive · Auto · 62% win (30d)
● Taxable · Robinhood    [LIVE]🔴 $48,900  Conservative-Income · Propose · HALTED (drawdown)
● Sandbox · Test Sim     [TEST]   $100k    Experiment-01 · Auto
```
The active account is unmistakable (bold + persistent header echo).

**Type-aware accounts.** Each account declares `broker + environment + taxType (taxable/Roth/Traditional) + capabilities (short/fractional/margin)`. The UI hides/disables what the type forbids; an AI proposal the account can't legally place is **blocked-with-reason before it's shown**, never silently dropped.

**Two orthogonal axes, per account, never merged:**
```
MONEY-REALITY:  Test(sim) ──▶ Paper ──▶ Live      (a credential/data-plane property, not a UI toggle)
AUTHORITY:      Off ──▶ Propose-only(HITL) ──▶ Auto-with-guardrails(HOTL)
```
**Enforced ordering (the safety spine, in code not just UI):** Auto-on-Live cannot be armed until that strategy has run Auto on Paper. New accounts start Test + Propose-only.

**Scope defaulting.** Sticky default account per user; per-proposal override allowed only via inline "Target: X → change to Y?" confirm. **Automated/scheduled/agent paths name the account explicitly and never inherit ambient scope** (GCP "always pass `--project`"). Unresolved scope → neutral blocking state, never last-used-possibly-Live.

**Provenance.** Every position/order/fill/log row is stamped with its `accountId` and the strategy that produced it; AI-driven vs hand-placed is visually separated.

## Configuration taxonomy

**Split by scope first, then ≤6 categories per scope, depth capped at 2 (one "Advanced" reveal), searchable + deep-linkable from day one, object-scoped gears for panel-local config.** Governing rule: **if a setting changes how a trade is decided or placed, it belongs to the account** (a mis-scoped risk setting is a money bug). Every control carries an **origin badge**: `● account value` · `↳ from preset "X"` · `⊘ locked by account type` · `your global default`.

### Scope A — User-global (`/settings/*`, Menu hub)
| Category | Contents |
|---|---|
| **Profile & Security** | identity, auth providers, sessions, deletion |
| **API & Broker Keys** | encrypted LLM/market-data keys, broker connect/disconnect, usage/billing |
| **AI Defaults** | default LLM, Red-Team model, reasoning effort (overridable per account) |
| **Notifications** | channels (email/push/SMS/webhook), event types |
| **Data Sources** | web-source toggles (Congress/insider/FINRA/8-K), technical source, observability opt-ins |
| **Appearance** | theme, density, default landing account |

### Scope B — Per-account (`/a/:id/strategy`, behind the account)
| Category | Primary (visible) | Advanced (one reveal) |
|---|---|---|
| **Mandate & Autonomy** | applied preset, authority tier, money-mode (gated), run cadence, holding horizon, Pause/Flatten | resume-on-boot, extended-hours cadence, proposal expiry/revalidation |
| **Universe & Order Rules** | included indices, blocklist, permitted order types | universe floor (price/cap/$vol), ADV cap, scan limit, entry-drift %, quote/fundamentals staleness |
| **Sizing & Exposure** | max order notional, max daily notional | %NAV, %ADV, hourly cap, symbol/sector/gross/net/beta/correlation caps |
| **Risk & Circuit Breakers** | stop-loss %, take-profit %, max drawdown %, daily-loss limit | trailing/ATR/beta stops, trim, brackets, broker-held stops, vol-panic thresholds |
| **Tax** | tax type (drives wash-sale), wash-sale guard | ST/LT rates, subtract-from-results |
| **Scoring & Tuning** | the 8 factor weights (preset-driven view) | Bayesian shrink, OOS withholding, conviction caps, min-lots-for-shift, bear vetoes |

### Presets (`/presets/*`, first-class objects)
Named intent presets ("Conservative Income", "Aggressive Momentum", "Congress-Follow") that expand into visible concrete numbers — sliders are the advanced tier, not the entry point. Each badges its scope (user-global). **Apply-to-account shows a diff + confirm**, highlighting any risk-limit change in the account's color: *"Applying 'Aggressive Momentum' to Taxable (LIVE) changes maxOrderNotional $500→$2,000, stopLoss 8%→5%. Keep wash-sale guard? [Yes]"* — a broad preset can never silently loosen an account's safety limits.

## Homes for each capability

- **Strategy config** → per-account **Strategy** tab (bound object) + **Presets** library (reusable templates). Diff-confirm on apply.
- **Risk / limits / circuit breakers** → per-account, Scope B categories *Sizing & Exposure* and *Risk & Circuit Breakers*. Surfaced *legibly* as live budget gauges on **Dashboard** and inline on each **Proposals** card.
- **Execution rules** (order types, drift, staleness, extended hours, brackets) → per-account, Scope B *Universe & Order Rules* + *Mandate & Autonomy*.
- **Performance & tax** → **Activity** tab (fills, closed-lot P&L, scorecards, benchmark) for reporting; tax *config* lives in Scope B *Tax*.
- **Approval / HITL** → **Proposals** tab; every card names its target account and the gates it passed; kill switch always reachable in shell.
- **AI assistant** → scope-aware **Chat** slide-over on every screen; proposes through the same deterministic gates; AI model defaults in Scope A *AI Defaults*.

## First-run / onboarding

Two orthogonal axes, taught as a ladder — never one slider, HITL-before-HOTL, prove-on-Paper-before-Live:

1. **Start in Test + Propose-only, zero funding friction.** The user runs the full scan → propose → approve loop in simulation first, with a permanent mode banner and "no real orders can be placed here." (Fintech "experience value before KYC.")
2. **Pick an intent preset**, not raw sliders — it expands into visible concrete numbers the user can inspect.
3. **Rung-ups explain *why* and *what changes*, and reserve heavy friction for exactly two transitions:** connecting/arming a **Live** account, and enabling **Auto-on-Live**. Both require **type-to-confirm** (type the account name / the dollar limit) + a restated summary of what is being armed. A **cooldown** also gates *raising* a real-money limit — never lowering it.
4. **Enforced ordering:** Auto-on-Live stays disabled until the strategy has demonstrably run Auto on Paper. Every autonomy grant ships with its preset limits + an always-visible kill switch, plus **error-driven auto-pause-and-notify**.

**The single biggest risk, and the seam that mitigates it:** every borrowed consumer/SaaS pattern makes autonomy *feel* frictionless and scope-switching *feel* cheap — but here the agent acts with no human present, and a wrong scope points it at real money. So the whole design keeps money-mode and autonomy-authority **louder-than-normal, enforced-not-displayed, per-account-and-attributed, ritual-gated** — borrowing consumer navigation restraint and preset intent, while refusing to borrow consumer friction-minimization for the controls that hand a robot your money.
