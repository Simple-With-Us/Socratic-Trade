# Appendix E — Design B1 (Blind greenfield team #1)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

# Design B1 — Agentic Trading: Synthesized Greenfield IA/UX

*Directed synthesis of five independent from-scratch proposals. The spine is drawn from the strongest shared convergence; the best distinct ideas are grafted in. One coherent design.*

---

## 1. Core Mental Model / Primary Object

**The primary object is the Account — a single broker-connected pool of capital running one strategy under one set of guardrails at one autonomy level.**

All five proposals converged here independently, and the convergence is not accidental: the product's actual value proposition is *supervised autonomy over money*, and the only object that has a mandate, a fence, an autonomy dial, and a P&L ledger simultaneously is the account. Portfolio, watchlist, and chart are the wrong heroes; the account is the unit of trust.

The user's one-sentence mental model:

> **"I run one or more Accounts. Each is an AI trader I've hired, given a mandate (Strategy), fenced with safety rules (Guardrails), and set to either *ask me first* or *act on its own*. I watch it work, decide on what it proposes, and review results to retune the mandate."**

The "AI trader I've hired" metaphor (from onboarding-mentalmodel) is the load-bearing framing because it maps every scary concept to an intuition an employer already has:
- **Hiring** = connecting a broker account.
- **The mandate** = the Strategy (universe, prompt, weights, AI review).
- **The fence** = Guardrails (risk limits, execution controls, circuit breakers, tax).
- **Ask-first vs. act-alone** = the autonomy dial (`propose` vs `decide`).
- **The performance review** = did my hire make money, and why.

An Account bundles four inseparable things (fintech-generalist's framing):
1. **Money & positions** — the reality (equity, cash, holdings, fills).
2. **A Strategy** — the intent (the brain).
3. **Guardrails** — the constraints (the fence).
4. **An Autonomy level** — how much rope the AI has, plus halt/close-only state.

**Second-class objects that orbit the Account:**
- **Proposal → Fill → Lot** — the atomic lifecycle of one trade idea through gates to execution to outcome. The unit of *daily interaction*.
- **Strategy Preset** — a reusable, named template of strategy + guardrail values that exists *above* any account and is stamped onto many. The unit of *authoring/reuse*.
- **Run** — one tick of the loop (scan → propose → gate → execute). The unit of *audit/forensics*.
- **The User** — identity, keys, model defaults, notification channels: genuinely *yours*, shared across all accounts.

**The control loop is the product's soul and must be a first-class, always-legible spine — never buried in logs:**

> **Scan → Propose → Gate → (Approve | Auto-decide) → Execute → Learn → Tune**

---

## 2. Design Principles

1. **The Account is the object; account context is a persistent frame, not a destination.** You never "navigate to an account" — you select one, and it colors every account-scoped screen. Switching re-scopes the current screen in place (so you can flip between two accounts' Guardrails to compare), never bouncing you home.

2. **Make the control loop legible.** Every screen answers "what is it doing / what does it want from me?" The scan→propose→gate→execute→learn→tune spine is visible, not archaeological.

3. **Novice-safe by default, power-complete on demand.** ~120–150 knobs must never greet a newcomer as a wall. Three-tier progressive disclosure everywhere; safe defaults always win.

4. **Separate the brain from the fence.** Strategy (make money) and Guardrails (never blow up) are authored and reviewed *independently*, so aggressive mandate edits can never silently loosen a stop, and vice versa. This is the single most important structural decision after "account is the object."

5. **Scope is always explicit.** Every setting shows its blast radius — *this account* / *this preset (N accounts)* / *all your accounts* — and, where a value is inherited, its **provenance** with one-click "reset to source." Multi-scope config is only humane when you can always see *why* a value is what it is.

6. **Presets copy, they don't link.** Applying a preset *forks* its values into an account (snapshot, not live reference). Propagation of preset edits back to accounts is explicit, previewed, and per-account — never silent. Presets seed; they don't entangle.

7. **The AI never has a side door.** Anything the Assistant proposes — a trade or a settings change — re-enters the *same* gated pipeline (Approvals / a previewed, confirmable diff) as manual action. The deterministic gates are inviolable.

8. **LIVE and DECIDE are earned, never defaulted.** Real money and auto-execution each require deliberate, friction-ful, informed acts. LIVE never looks casual anywhere in the chrome.

---

## 3. Target Top-Level Navigation (definitive)

A single left rail with a **persistent Account Switcher pinned at the very top** (above the destinations, because it re-scopes most of them) and the **user avatar at the bottom**. Six destinations — the count all five proposals gravitated toward — plus a persistent Assistant surface that overlays rather than occupying a nav slot.

| # | Destination | Purpose | Scope | Cadence |
|---|---|---|---|---|
| 1 | **Desk** (home) | The live cockpit for the active account: equity, positions, autonomy state, the control-loop status, macro/regime + breadth strip, watchlist rail, kill-switch, next-run countdown, and the top of the approval queue. "What's happening and what needs me right now?" | Per-account (+ Fleet mode) | Constant |
| 2 | **Approvals** | The decision worklist. Every pending proposal with full evidence (thesis, Bull/Bear/Red-Team debate, policy-gate trace, entry anchor + drift meter, projected bracket). Approve / Reject / Modify. Badged with a live count. In *decide* mode, becomes a transparency ledger of what auto-executed. | Per-account | Frequent |
| 3 | **Strategy** | Author the account's brain (mandate/prompt, factor weights, AI Bull/Bear review, scan universe & cadence) **and** manage/apply the Preset library. | Per-account (+ Preset library) | Occasional |
| 4 | **Guardrails** | All safety: risk limits, exposure caps, position-risk rules, circuit breakers, execution controls, tax treatment, and the autonomy dial. The fence. | Per-account | Occasional |
| 5 | **Review** | Look backward and learn: realized P&L, benchmark vs SPY, thesis/regime scorecards, factor efficacy, counterfactuals, tax-lot & net-of-tax review, and the AI **Tuning** proposals that come out of it. Audit is a lens reachable here. | Per-account (+ cross-account roll-up) | Periodic |
| 6 | **Settings** | Everything account-agnostic: identity, connected brokers, API keys, LLM defaults, notification channels, data/web-source toggles, the Preset library manager, observability, admin. | User-global | Rare |

**Plus, not a nav slot:** the **Assistant** — a persistent, context-aware co-pilot reachable via ⌘K and a side-rail that can slide over *any* screen (so you can ask "why is this proposal risky?" *on the Approvals card* without losing place). It reads the active account's context, cites its sources, and any trade/setting it suggests flows through the standard gates. It overlays all six destinations, so counting it as a peer tab would misrepresent it.

**Why six, and the key departure from a naive split:**

- **Desk / Approvals / Strategy / Guardrails / Review** are five genuinely distinct cognitive modes: *monitor now*, *decide*, *author the brain*, *author the fence*, *judge results*. This design deliberately **splits Strategy and Guardrails into two destinations** (the strongest idea from pro-terminal, settings-systems, and onboarding-mentalmodel) rather than fusing them into one "Config" mega-page. The safety premise *requires* that the aggressive config and the defensive config be separate places — a novice needs the fence to be a distinct, reassuring room; a power user needs to tune the mandate without fear of touching a stop.
- **Approvals earns its own destination** (not a Desk panel) because proposals have a lifecycle and a backlog and carry deep artifacts (the full Bull→Bear→Red-Team transcript, the decision-time scan snapshot, the policy trace). The Desk shows the *count and top few*; Approvals is where you adjudicate and audit.
- **Settings** is the sixth because ~40% of the inventory is genuinely user-global infrastructure (keys, channels, broker roster, preset library) and must not be re-entered per account.

**Explicitly rejected as top-level slots** (each is a section inside its natural parent, not a verb): Tuning (→ Review), Watchlist/alerts (→ Desk rail), Audit (→ a lens across Desk/Approvals/Review/Settings), Tax (→ *settings* in Guardrails, *results* in Review), Notifications (→ Settings), and a standalone "Accounts" tab (management → Settings; switching → the persistent Switcher).

---

## 4. Multi-Account Model (the center of gravity)

This is the make-or-break axis. A user runs, e.g., *Robinhood Live (taxable)*, *Alpaca Paper*, *Roth IRA*, and a *Test Sim* simultaneously — each with independent strategy, risk, execution, tax, and ledger, but sharing LLM keys, notification prefs, and the preset library. It is designed first, not bolted on.

### 4.1 The Account Switcher — persistent, top of rail, always present

The single most-looked-at control in the app; it doubles as a fleet health dashboard. The chip always shows the three facts a user must **never** be wrong about:

```
┌──────────────────────────────────┐
│ ◈ Robinhood · Live      ▾        │
│   $48,204 · ● DECIDE   [LIVE]     │
├──────────────────────────────────┤
│ ● All Accounts (Fleet)           │
├──────────────────────────────────┤
│ ● Robinhood·Live [LIVE] DECIDE   │ $48.2k  ▲+$310   • Grind
│ ○ Alpaca·Paper   [PAPER] PROPOSE │ $102.9k ▼−$45    2 pending
│ ○ Roth IRA·Live  [LIVE] ‖HALTED  │ $22.1k  ⚠ drawdown brake
│ ○ Test·Sim       [TEST] DECIDE   │ $10.0k  —
├──────────────────────────────────┤
│ + Connect account   ⚙ Manage     │
└──────────────────────────────────┘
```

Every row/chip surfaces:
1. **Which account** — broker glyph + user nickname.
2. **Execution reality** — a hard, color-coded badge: `TEST` (neutral/grey), `PAPER` (blue), `LIVE` (loud amber-red). **LIVE gets visual armor everywhere**: when a LIVE account is active, the global chrome takes a persistent accent (red hairline border + "LIVE" in the header), and the badge is repeated on every *action* button ("Approve — **LIVE**"). No one ever approves a real trade thinking it was paper. This is a safety feature, not decoration.
3. **Autonomy state** — `PROPOSE` / `DECIDE`, plus tripped-breaker states inline (`‖ HALTED`, `● CLOSE-ONLY`, `⚠ brake`), and a pending-approval count so you can triage *which account needs me* without entering each.

Switching account re-scopes Desk, Approvals, Strategy, Guardrails, and Review in place. The active account persists across navigation and sessions.

### 4.2 The Fleet view — the operator's morning glance

Selecting **All Accounts (Fleet)** turns **Desk** (and Review's roll-up) into a read-mostly portfolio-of-accounts board: one card per account with environment badge, equity + day P&L, autonomy state, open-position count, pending-approval count, active preset name, last-run time, and any tripped breaker as a red banner. Aggregate net worth sits at the top as a single number. This is the *only* cross-account acting surface, and it is deliberately triage-only plus **fleet-wide emergency controls** — **Halt all / Set all close-only / Pause autonomy** — because a panic doesn't respect account boundaries. You cannot place a trade from Fleet; you drill into an account to act, which prevents the classic "acted on the wrong account" disaster.

### 4.3 Per-account vs. Preset vs. Global — the explicit three-tier contract

Every setting is classified into exactly one tier, and the UI shows which tier you're editing before you touch anything (settings-systems' layering model made concrete):

```
USER-GLOBAL   (identity, LLM/data keys, model defaults, notification channels, web-source toggles)
     │  inherited by every account
     ▼
STRATEGY PRESET   (reusable template: universe/weights/prompt/AI-review + guardrail defaults)
     │  stamped onto an account (copy, not link)
     ▼
ACCOUNT OVERRIDE  (this account's deviations + connection facts + tax type + autonomy)
     │  resolved at runtime
     ▼
EFFECTIVE CONFIG  (what actually governs a run — shown as "resolved value + where it came from")
```

| Tier | Lives in | Blast radius | Examples |
|---|---|---|---|
| **User-global** | **Settings** | All accounts | LLM keys + model/effort default, market-data & broker keys, notification channels/targets, web-source toggles, auth/allowlist, observability, the Preset library |
| **Strategy Preset** | **Strategy → Presets** | Every account bound to it | Universe, scoring weights, prompt, AI-review config, default risk limits, default execution rules, tax defaults, tuning config |
| **Account override** | **Strategy / Guardrails (this account)** | Only this account | Any preset field, overridden; plus connection facts, **tax type** (a legal fact of the account), and **autonomy** |

**The rule, encoded in UI copy:** *"Set it once for everyone → Settings. Set it for a way of trading → a Preset. Set it for this one account → the account's overrides."* And a hard safety invariant (from design-systems-nav + onboarding-mentalmodel): **anything that is a safety or money decision is per-account and never silently inherited.** Global settings are limited to infrastructure and preferences — never trading behavior. Where a global default *does* seed an account (e.g., default LLM model), the account shows it as an explicit, overridable value with a `Using global default` chip, not invisible inheritance.

**Provenance badges everywhere** (settings-systems' most important interaction): every effective setting on an account screen shows a badge — **Inherited** (grey, "from *Balanced Swing* preset") vs **Overridden** (blue, with "reset to preset") — and an **"Overrides (N)"** summary chip lists exactly how this account deviates from its template.

### 4.4 Presets — reuse without coupling

- **Library** (Settings, applied contextually from Strategy/Guardrails): named templates with a usage badge ("bound to 3 accounts"). Actions: **Clone**, **Edit**, **Duplicate as new**, **Archive**.
- **Strategy vs Guardrail preset types are separate** (onboarding-mentalmodel), mirroring the Strategy/Guardrails destination split — so you can pair an "Aggressive Momentum" brain with a "Conservative Fence." This combinatorial freedom is a core multi-account value.
- **Bind = copy, not link.** Applying a preset snapshots its values into the account; later tuning one account never mutates the preset or other accounts. The account shows *"Based on Balanced Swing (3 local edits)"* with a diff view.
- **Save current account as Preset** / **Clone Preset** — promote a dialed-in account into a reusable template; fan out variants.
- **Propagation is explicit, previewed, per-account, and never silent:** *"3 accounts use this — 1 has an override on `maxOrderNotional` that will be preserved. Apply?"* **A LIVE account bound to an edited preset requires a second confirmation** before the change takes effect on the next run.

### 4.5 Cross-account behaviors the UI must surface (pro-terminal + settings-systems)

Two behaviors cross account boundaries and must appear where they bite, not buried:
- **Cross-account wash-sale lockout** — a realized loss in the taxable account locks rebuys of that symbol in *all* accounts (including IRAs) for 30 days. Surfaced as a badge on the symbol in every account's Approvals/Desk: *"locked by loss in Robinhood·Live, clears Jul 24,"* and prominently in the Fleet view.
- **Hourly-cap auto-revert** — a breach flips an account from Decide → Propose. Surfaced as a state change on the account chip plus a notification with the reason and reset time.

---

## 5. Configuration Taxonomy (grouping, disclosure, scope)

Design goal: **novice-safe by default, power-complete on demand,** with nothing from the inventory orphaned.

### 5.1 Three-tier progressive disclosure (applied on every config screen)

1. **Tier 1 — Essentials** (default view): the 3–6 high-leverage decisions that define the screen, in plain language with safe defaults pre-filled and a live **"what this means" preview** (sliding *Max order notional* updates a sentence: *"Each trade risks at most **$1,000** — about **2%** of this account's equity."*). A novice accepts these and is done.
2. **Tier 2 — Advanced** (one expand): the full common knob set, grouped into labeled cards with inline help and safe-range hints. Power users live here.
3. **Tier 3 — Expert / Environment** (behind an explicit "Expert" reveal, or surfaced read-only as "operator-managed"): env-tier flags (cache TTLs, price-event thresholds, scheduler leasing, OOS withholding, Bayesian shrink priors). Never in a novice's path.

Every control carries: plain-language label, one-line "what this does," current **effective value**, its **default**, a **provenance badge** (§4.3), and — for anything money-affecting — a **"what changes if I do this"** preview. Every change writes to the audit trail.

### 5.2 The configuration map (canonical homes)

**A. Per-account — `Strategy`** (the brain; preset-level, overridable per account):
- *Universe & Scan:* indices, additional symbols, blocklist, universe floor (min price/cap/volume), candidate limit, outlier reserve, min-score filter.
- *AI Setup:* Bull model + reasoning effort, Bear/Red-Team model, conviction/consensus threshold, editable strategy prompt (with read-only "what the AI will see" context chips — portfolio, macro, learned facts), holding horizon, hard vetoes (FCF floor, debt/equity ceiling).
- *Scoring Weights:* the 8 factor multipliers (0.6–1.4) as labeled sliders, each showing current auto-tuned value with a "let the AI tune this" toggle.
- *Cadence:* run frequency, extended-hours running, proposal expiry, re-validation cadence.
- *Learning subsection:* a **"How aggressively should it learn?"** slider expanding to the full tuning block (Tier 3).

**B. Per-account — `Guardrails`** (the fence; grouped cards):
- *Essentials:* the **autonomy dial** (Ask first / Act on its own), max order size, stop-loss %, take-profit %, max daily loss, max drawdown.
- *Sizing:* per-order notional / %NAV / %ADV, daily & hourly notional, max proposals/orders per run/day, sell-to-fund-buy mode.
- *Exposure:* per-symbol, per-sector, gross, net, portfolio beta, correlation-cluster caps.
- *Position Risk:* stop-loss, take-profit (+trim), trailing stop, short stop (mandatory when shorting on); ATR/beta-scaled toggles; bracket & broker-held-stop options.
- *Circuit Breakers:* max drawdown, max daily loss, vol-panic brake + VIX/VVIX/SKEW thresholds — each card doubles as *status* (green "armed" / red "TRIPPED — reset").
- *Execution:* permitted order types, extended-hours permission, marketable-limit conversion + buffer, entry-drift %, quote/fundamentals staleness gates, short-selling enable + short caps (collapsed until enabled).
- *Tax:* taxation type (account-level), wash-sale guard, ST/LT rates, net-of-tax display.

**Autonomy lives in Guardrails, not Strategy** (onboarding-mentalmodel's insight): turning the AI loose is a *safety* decision and belongs on the same screen as the drawdown and daily-loss stops that make loosing it survivable — the fence and the release of the leash are one deliberate act.

**C. User-global — `Settings`:**
- *Connected Accounts:* add/disconnect brokers, environment, confirmed capabilities (fractional/short/options), per-account credentials (managed here, scoped to the account).
- *Keys & Models:* LLM + market-data keys (AES-encrypted per-user, connection-test buttons, operator-fallback status), default model/effort.
- *Data & Signals:* market-data provider toggles, web-source toggles (Congress/insider/FINRA/SEC-8K/technicals) + staleness thresholds.
- *Notifications:* channels (email/push/SMS/webhook), targets, per-event-type enablement, stale-order threshold, test-send.
- *Presets:* the strategy + guardrail preset library.
- *Observability & Privacy:* Sentry/Langfuse opt-ins, data export, account deletion.
- *Admin* (operator-only, conditionally rendered): user allowlist, per-user LLM usage/billing, provider health, system-wide halt/close-only.

### 5.3 Guardrails baked into the forms (settings-systems + design-systems-nav)

- **Capability-aware disabling:** if the bound broker can't short, short-selling controls render disabled with "Not supported by this connection."
- **Environment-aware friction:** loosening a limit *down* is frictionless; raising a cap *on a LIVE account*, disabling a stop, enabling shorting, or flipping to **Decide/Live** triggers an inline confirm stating the consequence in plain words (typed acknowledgment for Live/Decide).
- **Mandatory-field enforcement:** the form won't save unsafe combinations (e.g., shorting enabled without a short stop-loss).
- **Safe defaults:** new account = Test, Halted/Propose, brackets on, vol-panic on, wash-sale guard on for taxable, extended hours off.

---

## 6. Homes for the Named Workflows

| Workflow | Home | Rationale |
|---|---|---|
| **Strategy authoring** (prompt / weights / AI-review) | **Strategy** (preset-level, per-account override) | The brain as one coherent authoring surface: prompt + 8 weight sliders (with auto-tune toggles) + Bull/Red-Team pickers + conviction threshold, co-located. Weight changes *proposed by the tuner* are reviewed in Review, applied here. |
| **Risk limits** | **Guardrails → Sizing / Exposure / Position-Risk / Circuit-Breakers** | The fence, structurally apart from the brain. *Default* limits live in the preset; *effective* limits + overrides + live breaker status render on the account with provenance badges. |
| **Execution controls** | **Guardrails → Execution** (config) + live overrides on **Desk** | Order types, hours, cadence, marketable-limit, drift/staleness gates are constraints on *how orders reach the broker*. You *set* cadence in Guardrails; you *slam the brakes* (halt/cancel/close-only) on the Desk. |
| **Performance & tax review** | **Review** (results) + tax *settings* in **Guardrails → Tax** | Review tabs: *Returns* (equity curve vs SPY, rolling 30/90/365, realized P&L), *Scorecards* (by thesis, by regime, factor efficacy), *Missed* (counterfactuals), *Tax* (lots, holding periods, wash-sale candidates, LT-maturity, net-of-tax). Every closed trade drills into a post-mortem (entry/exit regime, MAE/MFE, holding days, thesis). Live tax *lots* also visible on the Desk (state); Review is the *analysis*. |
| **Approval workflow** | **Approvals** (queue) + top-N card on **Desk** (fast path) | Two depths, one workflow. Each proposal is a decision card: symbol/side/size, thesis tag + confidence, Bull vs Bear vs Red-Team debate, **policy-gate checklist (pass/fail + reasons)**, entry anchor + **drift meter**, projected bracket. Actions: Approve / Reject (reason) / Modify — each carrying the LIVE/PAPER badge. In *decide* mode, an activity ledger of auto-approved fills with identical evidence, so autonomous choices are always auditable. Stale-order and re-validation-failed items surface here too. |
| **AI assistant** | **Assistant** (persistent rail + ⌘K), account-scoped | Reads active-account context; cites sources (scan rows, audit events, scorecards); can **propose trades** (→ enter the Approvals queue through the same gates) and **suggest settings** (→ rendered as a previewed diff requiring human confirm). Hosts the **learned-memory** panel: extracted constraints/preferences, reviewable and editable, with a human-approval queue for risky-tier learnings. Never a bypass. |
| **Tuning / learning loop** | **Review → Tuning** (evidence + accept/reject) + config in **Strategy → Learning** | Split by intent: *configure* how aggressively it self-tunes in Strategy; *inspect and accept/reject* the resulting weight & policy changes next to the P&L that justifies them in Review. Every tuning change is an audit event, linkable from both. |
| **Audit trail** | A **filterable lens**, not a destination — entered from Desk (recent), Approvals (decision trail), Review (post-mortems + full export), Settings (settings-change history) | Same immutable log, reached from wherever you're asking "why did that happen?" JSON/CSV export from Review. |
| **Watchlist & price alerts** | **Desk** rail (monitoring) + alert *delivery* config in **Settings → Notifications** | Advisory monitoring belongs beside the live view; *where alerts go* is global. |
| **Macro / regime / breadth** | **Desk** strip (ambient) | The regime snapshot proposals are stamped against; contextualizes the live view. |

---

## 7. First-Run / Onboarding

**Goal:** get a novice from nothing to *a safe, running, watchable account whose first proposal they understand* — in under five minutes, in TEST mode, with zero required keys and zero broker risk — teaching the mental model (Hire → Mandate → Fence → Watch it work) along the way. Every path to real money is deliberately, visibly gated; LIVE is never an onboarding step.

**Step 0 — Sign in.** OAuth (Google/GitHub/Apple), allowlist-gated. Identity verified server-side. No card, no keys yet. (Primary user inherits admin.)

**Step 1 — "Meet your AI trader."** One screen setting the metaphor before any form: *you'll connect an account, give it a mandate, set its limits, and decide whether it asks first or acts alone.*

**Step 2 — Instant Test account, pre-seeded.** The very first account is auto-created as **Test Sim** (local simulator), Halted, with a **Balanced starter preset already stamped on** — the user lands on a *populated* Desk, not an empty state. "Connect a real broker" (Alpaca Paper / Robinhood) is offered but clearly secondary; **the first account cannot be Live.**

**Step 3 — Pick a starting posture, not settings.** Choose **Conservative / Balanced / Aggressive** (each a paired strategy + guardrail starter preset, described in *outcomes*: "small orders, tight stops, always asks before trading"). One click forks a complete, safe config. Advanced users skip to full authoring. This is the antidote to the knob-wall.

**Step 4 — Confirm the fence.** Show the six essential guardrails the preset set (max order size, stop-loss, daily-loss, drawdown) with the **autonomy dial defaulted to Ask first**. This is the single most important onboarding screen: it teaches that *there is always a fence, and the AI asks-first until you say otherwise.* One deliberate "these look right" confirmation.

**Step 5 — Add your AI key (or use operator fallback).** Only now, when it's needed to generate a proposal, ask for one LLM key — with a clear note that scan, sim, and config all work without it; only AI proposal generation is unavailable. Skippable, never a dead end.

**Step 6 — Run one loop, together.** A guided **"Run once"** fires the loop against the Test account and narrates the result: here's the scanned universe → here's why this name scored high → here's the thesis → here's what the Red Team said → here's the policy check it passed → **here's where you approve it.** The user approves their first (simulated) trade; a fill appears in Activity. Watching the loop *once* installs the entire mental model better than any tour.

**Persistent scaffolding after onboarding:**
- A dismissible **"Next steps"** checklist on the Desk (connect a real broker, set a notification channel, enable a web signal, review your first week in Review) — earned complexity, not front-loaded.
- **A Readiness path to Live, never an onboarding step:** *Connect a real broker → run in Paper → review paper performance → enable Live.* **Going Live is its own gated ceremony:** switching any account to Live requires re-confirming the guardrails, a typed acknowledgment, and **resets autonomy back to Ask-first regardless of the paper setting.** Flipping to **Decide** is separately gated behind a confirm that restates the active caps ("Auto-execute up to $X/order, $Y/day, stops at Z%").
- Adding a **second account** later triggers a brief explainer on the switcher and on **how presets copy vs. propagate** — the one thing that confuses multi-account users.
- The **Assistant** is seeded with suggested questions ("Why did you pick this stock?", "Make me more conservative") so exploration *is* the tutorial.

---

### One-breath summary
The **Account is the object** and lives as a **persistent context** (an always-visible switcher with hard TEST/PAPER/LIVE and PROPOSE/DECIDE badges); navigation splits into six by the genuinely distinct modes — **Desk** (monitor), **Approvals** (decide), **Strategy** (the brain), **Guardrails** (the fence), **Review** (judge/learn), **Settings** (global infrastructure) — with a control-surface **Assistant** overlaying all six. The **Strategy/Guardrails split** keeps the brain and the fence independently authored; **three-tier scope** (global → preset → account override) with **provenance badges** and **copy-not-link presets** makes multi-account safe and legible; **three-tier progressive disclosure** makes ~150 knobs novice-safe yet power-complete; and onboarding proves the value — *watch the AI reason, safely, in Test* — before it ever asks for money or arms auto-execution. Autonomy and Live are always earned; the AI never bypasses the deterministic gates.
