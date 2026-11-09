# Appendix F — Design B2 (Blind greenfield team #2)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

# Design B2 — Agentic Trading: A Greenfield UI/IA

## 1. Core Mental Model / Primary Object

**The primary object is the Desk: one broker-connected account fused with the strategy, guardrails, and autonomy level currently governing it.**

The single most consequential fact in this product is that *everything meaningful is scoped to a broker account*. Strategy, risk limits, execution rules, tax treatment, autonomy, wash-sale scope, proposals, fills, and performance — none of it exists "for the user." It all exists for one specific connected account. A user running a Robinhood-live account, an Alpaca-paper account, and a Test sim is running three genuinely different operations, each with different money, different trust, and different rules.

So the mental model is not "one trading app with settings." It is:

> **A user supervises one or more Desks. A Desk = a broker account + the strategy driving it + the guardrails containing it + the autonomy level it runs at + its track record. The AI is a junior trader working one Desk at a time, under a written mandate the human sets, at a trust level the human chose. The human's core loop is: watch a Desk, judge what the AI wants to do on it, and decide how much rope to give it.**

The verb is **supervise**, not operate. The AI is never the hero of any screen — it is a worker inside a cage the user built. Every surface answers the user's three standing questions: *Which money am I looking at and is it real? What are the rules protecting it? What is the AI about to do, and can I stop it?*

**Object hierarchy the user can say out loud:**

```
YOU (identity, keys, model defaults, notification channels)
  └─ DESK  (one broker account — the thing I watch & trust)
       ├─ Strategy   (how the AI thinks: prompt, weights, AI-review)
       ├─ Guardrails (how it's contained: risk, execution, tax, autonomy)
       ├─ Autonomy   (Watch · Propose · Decide — the trust dial)
       └─ Track record (proposals, fills, positions, P&L, learning)

PRESETS  (reusable strategy+risk recipes — cloned INTO a Desk, then diverge)
```

**Two load-bearing vocabulary decisions, made explicit everywhere:**

- The **running instance** is a **Desk**. The **reusable template** is a **Preset**. A Desk is *born from* a Preset by copy, then **diverges**. This single distinction kills the entire class of "which one am I editing / did I just change three accounts" confusion.
- **Execution environment (Test / Paper / Live) is intrinsic to the connected broker account** — never a free toggle. A paper account cannot become live by flipping a switch; you connect a different account.

**Safety-first default state:** every new Desk is born in **Test/Paper + Propose-only**. You cannot lose a cent until you deliberately connect real money *and* deliberately graduate autonomy. Autonomy also **resets to its safe floor on restart** — armed autonomy is never a silent, sticky state.

---

## 2. Design Principles

These govern every decision below; when principles conflict, the earlier one wins.

1. **Legibility beats density.** A machine spends real money while the user sleeps. At every altitude, surface *why* over *what*. Trust is earned by observation, not asserted.
2. **Safe is the default at every fork.** Test/Paper, Propose-only, stops-on, circuit-breakers-armed are the pre-selected state. Every path toward more risk (Live, Decide, disabling a stop) is deliberately effortful: consequence-labeled, confirmed, and for Live, type-to-confirm.
3. **"Which money?" is never ambiguous.** The persistent Desk switcher answers it at zero clicks; Live capital is always visually loud across the entire app.
4. **Scope is always visible.** Every setting wears a scope tag — `THIS DESK`, `PRESET`, or `ALL YOUR DESKS` — and a change that touches N accounts says so before it saves.
5. **Novice-safe floor, power-complete ceiling.** Every config screen opens on a handful of plain-language choices; the full parameter tail folds behind a consistent Advanced disclosure. Nothing a beginner needs is buried; nothing a power user needs is missing.
6. **The AI proposes, it never silently acts.** Every AI-originated trade routes through the approval gate; every AI-originated config change surfaces as a confirmable diff. This holds for the chat assistant and the learning loop alike.
7. **Consequences are legible before commit.** Config changes on live money show an impact preview ("under this rule, N of your last proposals would now be blocked") — outcome, not just value.

---

## 3. Top-Level Navigation

**Six destinations**, each mapping to exactly one supervisor question / verb. Plus two persistent, cross-cutting elements that are context and companion, not destinations: the **Desk Switcher** (§4) and the **AI Assistant** (a global overlay, §7).

| # | Destination | The question it answers | What lives here |
|---|-------------|-------------------------|-----------------|
| 1 | **Floor** (home) | *"What's happening across everything, and does anything need me?"* | The multi-Desk command surface. One row/card per Desk: environment badge, autonomy level, live equity & day P&L, open-risk & circuit-breaker headroom, pending-approval count, health/kill state. Plus a combined approvals inbox and a macro/watchlist strip. Landing page and morning-coffee triage. Read-and-triage only — no trade action from the roll-up. |
| 2 | **Approvals** | *"What is the AI asking me to decide, and why?"* | The proposal queue (scoped to the active Desk, or All-Desks with per-row account tags). Each is a full decision card: thesis, Bull→Bear→Red-Team debate, the policy-gate checklist (pass/block with reasons), entry-drift vs. anchor, confidence, expiry. Actions: Approve / Reject / Adjust-and-approve / Snooze. In Decide mode this becomes the reviewable log of what the AI auto-executed. Badged with a live count. |
| 3 | **Strategy** | *"How should the AI think — here or as a reusable recipe?"* | Authoring "how the AI thinks": prompt, scoring weights (8 factors), AI-review config (Bull model, Red-Team model + conviction threshold), holding horizon, universe. **The Preset library lives here.** Mirrored editor for Desk-bound strategy (with divergence indicator) and standalone Presets. |
| 4 | **Guardrails** | *"What can the AI never do on this Desk?"* | The deterministic safety layer, deliberately separate from Strategy so users reason about *how smart* vs. *how contained* as two dials. Risk limits, stops, exposure caps, circuit breakers, execution controls, tax treatment, and the autonomy dial. |
| 5 | **Review** | *"How did this Desk actually do, and should I keep trusting it?"* | Retrospective + accountability. Realized P&L, benchmark vs. SPY, thesis/regime scorecards, counterfactuals, tax lots & harvesting, after-tax P&L, and the immutable **audit trail** (exportable). Also home to the **Tuning queue** — the learning loop's proposed weight/policy changes awaiting human sign-off, reviewed like a code review. |
| 6 | **Settings** | *"My identity and wiring."* | User-global only: identity/auth, broker connections, API keys (LLM + market-data + broker creds), default model/reasoning-effort, notification channels & event routing, web-source toggles, learned-memory review, observability/ops. |

**Why six.** The six map to six genuinely distinct supervisor jobs — *watch all / decide / author / contain / review / wire-up*. Each is a different cognitive mode; collapsing any pair harms legibility:
- **Floor vs. Approvals** — burying time-sensitive decisions in a dashboard is dangerous; approval is the irreducible recurring human action and earns a badged home.
- **Strategy vs. Guardrails** — the sharpest split in the design. "How the AI thinks" (reward-seeking) and "what it can never do" (deterministic containment) are different mental models; a kill-switch must never be buried inside a prompt-tuning screen.
- **Approvals (what it wants) vs. Review (what happened + was it good)** — accountability ≠ evaluation ≠ live decision.

**Why not more.** The inventory *looks* like a dozen capability areas, but most are **facets, not places**: macro/market context is decoration on decisions (a strip on Floor, inline on cards); watchlist & price alerts are an advisory panel (they don't gate trades); market scan is an input to proposal generation (inside Strategy + a Floor drill-down); notifications config is Settings while notification *events* are the Floor/Approvals badges; execution/risk/tax are the *content* of Guardrails. The test for a top-level slot: it must be a *question a person asks*, not a *feature the system has*.

**Why Settings is off the primary rail.** It's user-global, infrequent, and conceptually "the plumbing." Elevating it would clutter the six job-destinations and wrongly imply it's part of the daily loop. It lives behind the profile/gear menu, top-right.

---

## 4. Multi-Account Model (the spine)

This is the make-or-break decision. Three linked mechanisms: the **switcher**, the **scope split**, and the **preset→desk divergence model**.

### 4a. The Desk Switcher — persistent, stateful, health-aware

A persistent **Desk chip pinned top-left of every screen**. Not a subtle dropdown — a stateful, color-coded control, because which Desk you're viewing changes what every number and every setting *means*.

```
┌──────────────────────────────────────────────┐
│ ● Roth IRA · Alpaca   ▾    $48,210  +1.2% ↑   │  ← tap name to switch
│   LIVE · Propose-only                          │
└──────────────────────────────────────────────┘
```

The chip always shows the four triage-critical facts:
- **Desk name + broker** ("Roth IRA · Alpaca")
- **Environment** as an unmissable colored badge: **Test** (grey) · **Paper** (blue) · **LIVE** (red). This is the highest-stakes fact on screen and is *never* subtle. A Live Desk additionally carries a persistent tinted border around the **entire viewport**, app-wide, so real capital is never confused with paper.
- **Autonomy level** (Watch · Propose · Decide)
- **Live equity + day P&L**

Opening the switcher shows a **portfolio-of-Desks list**, LIVE Desks grouped first and visually separated (so you never fat-finger a live account thinking it's paper). Each row: environment badge, autonomy, health dot, day P&L, pending-approval count. Top row is **"Floor (all Desks)"** — the aggregate view — so the switcher toggles breadth↔depth without a separate nav action. Bottom row: **+ Connect an account** (where a new Desk is born).

**Context-propagation rule:** the active Desk scopes Approvals, Strategy, Guardrails, and Review automatically, with a "Viewing: [Desk] · switch · see all" breadcrumb. The user never wonders which Desk an action will hit. Cross-Desk roll-ups exist only on the Floor (and as an optional All-Desks filter in Approvals/Review) — and even then every row is account-tagged.

**Kill-switches:** a per-Desk **Halt** is always reachable from the Floor/Approvals header; a red **Halt ALL Desks** master switch lives at the far end of the switcher bar behind a confirm.

### 4b. What's per-Desk vs. Preset vs. Global

Three explicit tiers, each with a visible scope tag. **The enforced rule: anything that could make one Desk's money behave like another's is per-Desk. Anything about *you as an operator* is global.**

| Tier | Scope tag | What | Home |
|------|-----------|------|------|
| **Per-Desk** | `THIS DESK` | Bound strategy (prompt, weights, threshold); all risk limits & circuit breakers; execution controls; **tax treatment (taxable/Roth/traditional)**; autonomy; system state; run cadence | Strategy & Guardrails (Desk-scoped) |
| **Preset** | `PRESET` | Reusable recipe: prompt + weights + policy/risk defaults + execution defaults. **Not** tax treatment, **not** autonomy, **not** keys — those are account-intrinsic | Strategy → Presets |
| **User-global** | `ALL YOUR DESKS` | Identity/auth; API keys (LLM, market-data, broker creds); default model/reasoning-effort; notification channels & event routing; web-source toggles; learned memory; observability | Settings |

When a Desk *overrides* a global default (e.g., a per-Desk model), the field shows an **"overriding global"** chip so you always know which layer wins. Editing a Preset bound to N Desks shows **"This will change N Desks: [list]"** before saving — the single most important guardrail against the classic multi-account footgun.

**Tax treatment is account-intrinsic and constrains legal config.** Roth/traditional/taxable is a property of the real broker account — set on the Desk, not carried by a Preset — and it *drives* which policy defaults are legal: on an IRA, the wash-sale guard is force-disabled and greyed with an inline explainer. This prevents nonsensical Preset→Desk mismatches.

### 4c. Presets → Desks: the copy-on-bind divergence model

- **Author** a Preset in the library (from scratch, clone an existing one, or **"capture current"** from a Desk you like). Ships with a few plain-language starters — *Careful Starter*, *Balanced Swing*, *Aggressive Momentum*, *Paper Sandbox* — so a novice never faces a blank strategy.
- **Bind** a Preset to a Desk → this **copies** its values in. From that instant they are independent. **Copy-on-bind, never live-link** — a live-linked preset silently editing three real-money accounts at once is a footgun.
- The Desk **diverges** as you (or the AI auto-tuner) adjust it. The cockpit shows **"Preset: Momentum-v3 · diverged: 6 fields"**. Click to diff, then **re-sync from preset** (pull template changes down) or **promote to preset** (push improvements up as a new version).
- **Apply is always diff-and-confirm:** *"Applying 'Aggressive Momentum' to Roth IRA · LIVE will change stop-loss 8%→5%, max-order $1k→$3k. Confirm."* Applying to a Live Desk requires type-to-confirm.

This serves the multi-account requirement cleanly: run the *same* Preset across three Desks to A/B a strategy (real vs. paper), let each diverge, and always see how far each has drifted from origin. A power user runs 5 Desks off 2 Presets with a handful of overrides and reasons about the fleet from the Floor; a novice runs one Desk off one starter and never has to learn the Preset concept until they add a second account.

### 4d. Aggregation vs. isolation

The Floor aggregates *read-only* signal (total equity, total day P&L, count needing approval, any tripped breakers) but **no trade action is possible from the aggregate** — actions require entering a specific Desk. Aggregation for awareness; isolation for action; this prevents cross-account fat-fingers.

**The one intentional leak — cross-account wash-sale.** A taxable loss locks rebuys everywhere per IRC §1091. Because it's a surprising exception to isolation, the block surfaces *at the point of the blocked proposal* and **names which other Desk caused the lock** — never hidden in tax settings.

---

## 5. Configuration Taxonomy

Config is split first by **scope** (§4b) into two homes, then disclosed within each via a consistent **three-layer ladder** so the 100+ knobs never hit a beginner at once, yet every knob is reachable.

### The three-layer disclosure ladder (applied identically everywhere config appears)

1. **Layer 1 — Essentials (default view).** The 4–6 plain-language decisions that define behavior and risk, rendered as human-labeled sliders/toggles/cards with safe defaults pre-filled and a live plain-English preview. A novice can operate entirely here. *Example — Guardrails opens on: risk appetite [Cautious / Balanced / Bold], stop-loss %, take-profit %, max per-trade $, daily-loss kill-switch $.* Picking a risk-appetite card sensibly sets the whole advanced block.
2. **Layer 2 — Standard (one expand).** The full working set: exposure caps (symbol/sector/gross/net/beta/correlation), notional caps (order/daily/hourly), take-profit/trailing/trim, order types, extended hours, universe, tax settings, proposal expiry/revalidation cadence.
3. **Layer 3 — Advanced / Expert (labeled, cordoned).** The deep tail: ATR/beta-scaled stops, entry-drift & quote/fundamentals staleness gates, vol-panic thresholds, marketable-limit bps, price-event triggers, sell-to-fund-buy, extended-hours synthetic stops, OOS validation, Bayesian shrink priors, conviction-corroboration gates, bear-veto floors, raw prompt editing. Entering shows a one-time gentle notice: *"These are for experienced traders. The defaults are already safe — you don't need to change anything here."* Nothing here is required; everything has a safe default.

**Woven through every config surface:**
- **Every field carries its scope tag** (§4b), **its current effective value, its default, and its source layer** (default / preset / desk-override / auto-tuned), with one-click "reset to default."
- **Auto-tuned values are attributed:** *"last changed by AI tuning on <date>: +0.05 momentum"* → links to the audit entry. Config is a diffable, attributable state, never a dead form.
- **Every setting states its consequence in plain English, live**, as you touch it ("This means the AI can spend at most $50/hour buying").
- **Pre-save impact preview on any live-money change** ("under this rule, X of your last N proposals would now be blocked").
- **Changing a rule on a LIVE Desk triggers a confirmation** that restates the change in outcome terms and shows what it *was*.
- **Safety-critical settings never hide.** Autonomy (Propose vs. Decide), environment, and kill-switch thresholds always render at Layer 1 with confirmation friction — a novice must see and understand "is this allowed to trade on its own with real money?" without opening anything.

### Config homes map

| Config group | Home | Scope | Layer |
|---|---|---|---|
| Prompt, thesis language, holding horizon | Strategy → Thesis | `THIS DESK` / `PRESET` | 1–3 |
| Scoring weights (8 factors), min-score threshold | Strategy → Signals | `THIS DESK` / `PRESET` | 1–3 |
| AI-review (Bull model, Red-Team model, conviction) | Strategy → AI Review | `THIS DESK` (overrides global) | 1–3 |
| Universe, blocklist, floors, scan limits | Strategy → Signals | `THIS DESK` / `PRESET` | 1–2 |
| Sizing/exposure/beta/correlation caps, notional caps | Guardrails → Risk | `THIS DESK` | 1–2 |
| Stops (fixed/ATR/beta), take-profit/trim, trailing, brackets | Guardrails → Risk | `THIS DESK` | 1–3 |
| Drawdown, daily-loss, vol-panic circuit breakers | Guardrails → Circuit breakers | `THIS DESK` | 1 |
| Order types, extended hours, cadence, marketable-limit, sell-to-fund-buy, drift/staleness/price-event | Guardrails → Execution | `THIS DESK` | 1–3 |
| Tax treatment, rates, wash-sale, net-of-tax | Guardrails → Tax | `THIS DESK` | 1–2 |
| Autonomy, system state, kill-switch | Guardrails → Autonomy | `THIS DESK` | 1 |
| Tuning-loop internals (shrink, OOS, thresholds, vetoes) | Review → Tuning → Advanced | `THIS DESK` | 3 |
| Identity, auth, account deletion | Settings → Account | `ALL YOUR DESKS` | 1 |
| Broker connections + per-broker capabilities | Settings → Connections | `ALL YOUR DESKS` | 1–2 |
| API keys (LLM, market-data, broker creds) | Settings → Keys | `ALL YOUR DESKS` | 1–2 |
| Default model / reasoning effort | Settings → AI defaults | `ALL YOUR DESKS` | 1 |
| Notification channels + event routing | Settings → Notifications | `ALL YOUR DESKS` | 1–2 |
| Web-source toggles, observability, ops token | Settings → Data & Ops | `ALL YOUR DESKS` | 2–3 |
| Learned memory / preferences | Settings → Memory | `ALL YOUR DESKS` | 1–2 |

**Presets mirror the Desk config surface exactly** (Strategy + Risk/Execution defaults, minus live-money/environment/tax/autonomy bits) — same layers, same layout. Learn the form once, use it in both places.

---

## 6. Homes for Each Capability

| Capability | Home | Framing |
|---|---|---|
| **Strategy authoring** (prompt, weights, AI-review) | **Strategy** — sub-panels *Thesis* (prompt, horizon, thesis tags), *Signals* (8 factor sliders 0.6–1.4 + universe/scan), *AI Review* (Bull model, Red-Team model + conviction threshold). Mirrored for Desk-bound (with divergence indicator) and Presets. | Novice: pick a Preset + a plain "personality" (value/momentum/balanced). Weight sliders show default vs. current vs. auto-tuned and *how the last realized scorecard would nudge them* — grounded in evidence, not vibes. The Bull→Bear→Red-Team consensus is surfaced reassuringly as "A second AI double-checks every idea before it reaches you." Raw prompt editing is Layer 3. |
| **Risk limits** | **Guardrails → Risk / Circuit breakers** | The emotional heart. Layer-1 presets up top; sliders behind. Circuit breakers ("Stop everything if I lose more than $X today / 10% from my high") shown as **seatbelts ON by default**, with live headroom as a gauge ("drawdown 4.2% of 10% budget") mirrored onto the Floor row. |
| **Execution controls** | **Guardrails → Execution** | Novice sees three plain choices: how often the AI checks, regular-hours-only (recommended), and "attach a safety-sell to cap losses" (brackets, on by default). Order-type permissions, extended-hours synthetic stops, marketable-limit buffers, sell-to-fund-buy → Layer 3. Per-broker capability annotated ("Robinhood: no native brackets"). Execution *mode* shown read-only — it's a property of the connected account. |
| **Performance & tax review** | **Review** — *Performance* (equity curve vs. SPY, win rate, thesis/regime/factor scorecards, rolling windows), *Counterfactuals* ("Ideas we passed on — for learning", opt-in/softened), *Tax* (lots, holding-period ladder, unrealized-loss harvest candidates, wash-sale locks, net-of-tax toggle), *Audit* (immutable, filterable, exportable). | Top line is one honest sentence: *"You're up $63 (+1.3%). Just holding the market would've made $41."* Tax *config* lives in Guardrails → Tax; tax *reporting* lives here — linked both ways. |
| **Approval workflow** | **Approvals** (deep) + pending inbox surfaced on Floor and All-Desks. | Each proposal is a decision card: symbol/side/size, plain thesis, confidence, Bull rationale + **Red-Team rebuttal**, the exact stop/take-profit that will protect it, entry-drift vs. anchor, and the **policy-gate checklist** (green checks / red blocks with plain reasons — turning rejections into trust-building moments, naming the cross-Desk wash-sale culprit where relevant). Actions: Approve / Reject (reason feeds learning) / Adjust-and-approve / Snooze, with a friendly expiry countdown. In Decide mode: a reviewable auto-execution log with one-tap "drop autonomy → Propose." |
| **AI assistant** | **Global overlay** — a floating button on every screen (not a tab), opening a context-aware panel that inherits the active Desk + current screen. | Answers "why did you skip MSFT on this Desk?"; proposes trades → routed through Approvals gates; suggests config changes → surfaced as a confirm-diff, **never applied silently** ("I'll draft changes for you to approve — I won't change your rules on my own"). Learned memory it extracts is reviewable in Settings → Memory. Citations link back to the scan/portfolio/audit event grounding each answer. |
| **Tuning loop** (AI-proposed weight/policy changes) | **Review → Tuning** | A review queue: before/after weights, confidence, OOS walk-forward result, corroboration gate, and the realized evidence — approve/reject like a code review. Keeps AI-initiated config changes under the same human gate as everything else. Risky learned-memory ingests that need sign-off queue here too. |
| **Watchlist & price alerts / macro** | **Floor** (advisory strip) + inline on proposal cards | Advisory context, not trade gates — so they sit on the home surface and inside decisions, never as a competing destination. Alert *events* also flow to notifications. |
| **Audit trail** | **Review → Audit** | The immutable ledger of every fill, block, tuning change, and kill-switch event — reverse-chronological, plain-language, filterable, JSON/CSV export. Reachable but not headlined (too technical to be a top-level verb). |

---

## 7. First-Run / Onboarding

**Goal:** get a nervous person from empty app to *watching a safe simulated Desk work* in under three minutes — zero chance of real loss, no keys required to see value — while teaching the mental model by doing. Onboarding stands up **one trustworthy Desk you understand in the safest possible mode**, ending with the user *watching the AI reason*, because trust is built by observation.

**Step 0 — Sign in.** OAuth (Google/GitHub/Apple). Identity provider-verified; no passwords typed.

**Step 1 — A promise, not a feature list.**
> *"An AI will suggest stock trades. You stay in control: it starts with pretend money, it only suggests (never buys) until you say otherwise, and safety rules you set can stop it at any time. Let's stand up your first practice Desk."*
One button: **Start in the sandbox.** The first Desk is **pre-set to Test/Sim** — no broker keys, no LLM key required to *see the loop*; the market scan runs on keyless data. Connecting a real broker is deliberately *not* offered first.

**Step 2 — Pick a starter strategy (feel, not numbers).** Three plain-language Preset cards — *Careful / Balanced / Bold* — each showing in one sentence the position size and stop-loss it implies. Default highlighted: **Careful.** No knob-tuning; power users get a "start blank / advanced" link. This silently creates the Desk's first (diverged-from-Preset) strategy.

**Step 3 — Set the rope.** One question sets the autonomy default: *"Should the AI ask you before every trade (Propose) or trade within limits on its own (Decide)?"* — defaulted to **Propose**; **Live + Decide is not offered during onboarding at all.**

**Step 4 — The safety contract (30 seconds, the trust-builder).** A short, non-skippable card with three sentences and a diagram of *propose → gate → approve → execute → learn*: deterministic gates always run; autonomy starts at Propose and **resets to halted on restart**; a kill-switch exists. Trust-building, not legalese.

**Step 5 — Add the brain (optional, gated, in-context).** If an LLM key is needed to actually generate proposals, ask here with a plain explanation and a "do this later" path (or use operator fallback if enabled). Without it, the Desk still runs the scan and the full safety machinery — the app states *exactly* what's unavailable (proposal generation) and what still works (everything else). Never a dead end.

**Step 6 — Watch it think (the aha).** A single **"Run once"** triggers one sandbox cycle. The user watches the AI scan → score candidates → Bull thesis → Red-Team critique → proposal land in **Approvals** with full evidence and gate checklist, and makes their first Approve/Reject — risking nothing. This single narrated loop makes the whole pipeline legible in ~90 seconds.

**After onboarding.** The user lands on the **Floor** with one healthy sandbox Desk and a persistent, dismissible **"Next steps"** strip: connect a real broker (paper first), turn on alerts, add a watchlist symbol, ask the AI to explain a decision, explore Review once trades accrue.

**The progressive-trust ladder is the product's through-line, made explicit:** **Test → Paper → Live** (environment) and, within any Desk, **Watch → Propose → Decide** (autonomy). The UI always makes the *next* rung available but **never auto-promotes**; every promotion is a deliberate, reversible, consequence-labeled act. Connecting a Live broker is its own heavier flow — capability check, a distinct "this Desk can spend real money" confirmation, type-to-confirm, and autonomy forced back down to Propose regardless of prior setting. The one unrecoverable mistake in this product — an unsupervised live trade — is made to require deliberate intent at every step.

---

### Through-line in one line

The running **Desk** (one broker account + its strategy + its guardrails + its autonomy + its record) is the primary object; the **Desk Switcher** is the spine that keeps "which money?" unambiguous with LIVE never quiet; you **watch all on the Floor, decide in Approvals, author in Strategy, contain in Guardrails, review in Review, wire up in Settings**; **Presets** are copy-on-bind recipes you clone in and diverge from; **scope tags** kill the global/per-Desk footgun; a **novice-essentials → expert-advanced ladder** makes it safe for beginners yet complete for power users; and an explicit **Test→Paper→Live / Watch→Propose→Decide** trust ladder — never auto-promoted — is how a "can I trust it?" product earns a yes, one observed, reversible step at a time.
