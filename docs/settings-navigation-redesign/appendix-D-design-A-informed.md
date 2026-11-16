# Appendix D — Design A (Informed team)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

# Design A — Agentic Trading: Purpose-Built Redesign

The six lenses converge with remarkable consistency. The data model (Connected Account / Strategy Preset / User-global; the account-vs-user settings tier) is already sound — every problem is **presentation, verb-collision, and mis-scoping**, not schema. Design A resolves the disagreements decisively and specifies one target.

**Reconciled tensions (where lenses differed, and the ruling):**
- **Assistant's placement.** IA-architect nests it under Research; domain-workflow docks it inside Decision. **Ruling: docked side-panel inside Decision.** The Assistant approves trades today (two approval homes is the crown-jewel bug); it must collapse into the one decision surface, not sit one nesting-click away in Research.
- **Tax's home.** IA/workflow put tax-the-outcome under Performance/Review. **Ruling: yes** — Tax is a sub-view of Performance (outcome); tax *rules* are a sub-tab of Strategy (config). The label collision dies because the two are in different scopes.
- **Where account-tier config lives.** Settings-taxonomy keeps risk/automation *inside* a restructured Settings modal; IA-architect/strategy-consolidation move them *out* into the Strategy destination. **Ruling: account-scoped config lives in the Strategy destination's sub-tabs; the Settings modal holds user-scope only.** A gear that configures how one account trades violates "which account am I configuring." Settings-taxonomy's two-level disclosure + search + scope-badge patterns are adopted *within* the Strategy sub-tabs and Preferences.
- **Vocabulary.** Adopt interaction/scope lenses' retirement of "activate/apply" → **"copy a preset in" / "save as preset."** Rename "Strategy Profile" → **Preset**, "user-tier" → **Workspace** (avoids Profile-menu collision).

---

## 1. Design principles

1. **One navigational spine, one monitor rail, one persistent frame.** No two competing primary tab strips.
2. **The daily loop is the shape.** monitor → decide → tune → manage risk → review → learn. Decision is the hot core; everything else is one click out, in loop order.
3. **Scope is always answerable and never ambient.** Which account, what money-reality, what authority, running or halted — visible on every screen. No operation silently mutates "whatever account is active."
4. **Place ≠ action ≠ panel.** A destination you go to, a verb you fire, and a contextual panel are three different things and are treated as such. No concept is reachable four ways.
5. **Money-reality and authority are two orthogonal dials, never one slider.** Test→Paper→Live is a property of the credential; Propose→Autonomous is a separate axis. Raising either is a deliberate ritual.
6. **Config lives with what it configures.** If a setting changes how one account decides or places trades, it belongs to that account's Strategy — not a global gear.
7. **Two levels of nav depth, max** (destination → sub-tab). Density lives *inside* panels; search + command palette are the power-user escape valves.
8. **Presets are inert templates you copy in.** They never touch a live account except through an explicit, previewed, diff-confirmed copy.
9. **Safe defaults, progressive disclosure, and safety-asymmetry.** Halt is frictionless; arming Live/Autonomous is type-to-confirm. Fail toward the reversible action.

---

## 2. Target top-level navigation (definitive)

Five destinations. That's it. (From 7 workspace + 4 feed = 11.)

| # | Destination | Purpose | Absorbs |
|---|---|---|---|
| 1 | **Decision** | The hot core. Pending proposals to approve/modify/reject, each self-contained with account + risk-budget + regime; docked Assistant Q&A pane; "Latest Decisions" ledger; current run status. This is where the operator lives. | Decision tab + Assistant tab + "what's the bot doing now" status |
| 2 | **Research** | Read/analysis evidence *behind* proposals, consulted on demand. Sub-tabs: `Market Scan` · `Macro`. | Market Scan tab + Macro tab |
| 3 | **Strategy** | The ONE home to configure how the active account decides and what it may do. Sub-tabs (see §5). Scoped to the current account, always stamped with the account chip. | Strategy tab + Strategy Studio modal + Strategy Flow + Settings→(Strategy/Operate/Risk/Tax/Tuning) |
| 4 | **Performance** | Outcomes and retrospective review. Sub-tabs: `Performance` · `Tax` (tax outcomes — NOT tax rules). | Performance tab + Tax tab |
| 5 | **Activity** | One chronological system log. Filter chips: `All · Runs · Orders/Fills · Alerts · Audit`. | Runs + Activity + Notifications-log + Audit Log (the entire FeedTab rail) |

The FeedTab rail is deleted as a second spine and becomes filter chips inside Activity. Research and Strategy default to last-used sub-tab; all sub-tabs are command-palette-addressable so power users skip the nesting.

---

## 3. Global frame (persistent chrome, every screen, never scrolls)

```
┌─ LEFT (scope) ───────────┬─ CENTER (spine) ─────────────────────┬─ RIGHT (verbs + risk) ──────────────┐
│ [◈ Alpaca Paper ▾]       │ Decision  Research  Strategy          │ ⟨used 2k/10k · net 0.4x · Neutral⟩  │
│  ● PAPER · Propose-only  │ Performance  Activity                 │ [▶ Run once] [■ Halt & Flatten] 🔔 ? ⌘K │
└──────────────────────────┴───────────────────────────────────────┴─────────────────────────────────────┘
```

**Left — Account Switcher (the scope anchor).** Persistent top-left (Stripe/AWS/Notion pattern). Shows active account label + **money-reality color chip** (Test = grey, Paper = blue, **Live = red**) + authority badge (`Propose-only` / `Autonomous`). Dropdown lists every account with balance, environment badge, running state, one-line status ("Running · $12.4k left today"), and preset provenance (`from: Aggressive Momentum · modified`). Footer: **"Manage accounts…"** (Accounts hub) and **"Preferences…"** (user-scope settings). **Every AI action is scoped to whatever this shows.** No account resolved → neutral "No account selected" state that **blocks scoped actions** (fail-safe). Switching *into* a Live account shows a brief "you're now acting on REAL MONEY" confirm.

**Center — the five-destination spine** (§2). All nouns/places.

**Right — global verbs + ambient risk** (never buried in Settings):
- **Live risk strip:** today's used/remaining daily notional, gross/net exposure vs cap, current regime — the numbers the approver needs, always visible.
- **▶ Run once** — produce proposals now. One click on Test/Paper; type-to-confirm arming only for the Live/Autonomous rung.
- **■ Halt & Flatten** — always-visible kill switch. **Halt is one click (reversible, safe); Flatten (sells positions) requires confirm, type-to-confirm on Live.** Safety-asymmetric by design.
- **🔔 Notifications** — bell + unread count, opens a *dropdown panel* of live alerts. Distinct from Notifications *settings* (delivery rules → Preferences) and the Notifications *log* (→ Activity/Alerts filter).
- **? Help** — contextual help panel (Overview | Guardrails | Settings Glossary | Tax | Data Sources | MCP).
- **⌘K Command palette** — kept and promoted as the power-user jump layer over the spine.

---

## 4. Settings taxonomy (definitive tree, scope-explicit)

Settings splits **by scope first**. The account-vs-user tier stops being a hidden toggle and becomes structural.

### 4a. Account-scope config → lives in the **Strategy destination**, NOT a modal
Everything that changes how *this account* decides or trades is a Strategy sub-tab (§5). Reached with the account chip always stamped on the header. Within each sub-tab: **two-level disclosure only** (primary controls up front, one "Advanced" reveal), per-control **scope badges** (`This account`), and preset-origin tags (`from preset: X · modified`).

### 4b. User-scope settings → the **Preferences** panel (the only thing that keeps a modal)
Reached from the account-switcher menu ("Preferences…"), never a spine tab. Global to the user. Four sections, all clearly labeled **ALL ACCOUNTS**:

```
PREFERENCES  (user-scope · all accounts)
  [ 🔍 Search all settings… ]           ← indexes every field label + synonym + section + scope
  ── ALL ACCOUNTS ──
   Connections        broker links + API keys/credentials
   Notifications      delivery rules (which alerts fire, where) — NOT the alert stream, NOT the log
   Appearance         (was "Display")
   Data & Privacy     (was "Data") — pool consent, learned-facts sharing, account deletion
```

### 4c. Renames (with internal id redirects so call sites don't break)
`Operate → Automation` (in Strategy) · `Tuning → Learning` (in Strategy) · `Display → Appearance` · `Data → Data & Privacy` · `Strategy Profile → Preset` · `user-tier → Workspace`. Keep the `SettingsSection` union ids stable as routing keys; map old→new (`operate→automation`, `display→appearance`, `data→data-privacy`, `tuning→learning`) so existing `openSettings("operate")` call sites and command-palette entries keep working during migration. Update the Help "Settings Glossary" in the same PR (cross-file trap).

### 4d. Settings search
A search box (in Preferences and in Strategy) indexing every field label + synonyms + section + scope, deep-linking to the control and auto-expanding its Advanced group. Index is **derived from the same field definitions that render the controls** (never a hand-maintained parallel list — same failure mode as the enrichment-cascade trap).

### 4e. One scope re-classification (data-model change, coordinate with persistence owner)
Move `marketScanCandidateLimit` / `marketScanOutlierReserve` from user-scope Data → **account-scope Strategy → Automation** (scan breadth affects how *this account* trades; cost is per-account-per-run). This shifts fields out of `USER_LEVEL_POLICY_FIELDS` and needs a back-fill fanning each user's single value out to each account. **If the migration is too costly this cycle, the safe fallback is to leave it user-scoped but relabel "applies to all accounts"** — do not ship it half-migrated.

---

## 5. The ONE home for Strategy

**Promote the Strategy workspace tab into the single Strategy Editor**, scoped to the active account, with a persistent header: **"Live Strategy — Alpaca Paper"** + money-reality badge + preset-provenance. Everything strategy-config collapses here. Structure (two-level disclosure, one "Advanced" reveal per group):

```
STRATEGY  (destination — the one config home; header stamped with the active account)
  Presets bar (always visible)   Start from preset… · Save as preset… · Copy to accounts…
  ── sub-tabs ──
   Editor        prompt/thesis + Green/Red-team models + reasoning effort + 8-factor scoring weights
                 + the SINGLE LLM Review & Tune card (green/red team) + sizing & cadence
                 (max order, daily cap, symbol cap, proposals/run, cadence, sell-to-fund, ext-hours)
                 [ ⟲ Flow toggle → overlays the live pipeline diagram next to what it visualizes ]
   Guardrails    risk & safety: stop-loss, take-profit, daily-loss, drawdown (primary);
                 vol brake, exposure caps, ATR stops, order types, short limits, universe floor (Advanced)
   Automation    Execution Mode (Test/Paper/Live) + Authority (Propose/Autonomous) as headline controls;
                 cadence, universe multi-select, blocklist, scan breadth (from §4e)
   Tax rules     tax-lot method, wash-sale, harvesting rules  (config — NOT tax outcomes)
   Learning      (was Tuning) auto-tuner params, all behind a "defaults are safe" primer
```

### Fate of the old 5 strategy surfaces
| Old surface | Fate |
|---|---|
| **Strategy workspace tab** | Becomes the Strategy Editor destination (the one home). |
| **Strategy Studio modal** (prompt + weights + review) | **Deleted**; contents move into Editor sub-tab (now editable, not a modal). Optional full-screen *mode* of the Editor preserves the distraction-free feel. |
| **Settings → Strategy section** (read-only mirror) | **Deleted** (dead-end false-affordance). Replaced by a one-line pointer for one release: "Strategy is configured in the Strategy tab →" (redirect, not a 404). |
| **Strategy Flow overlay** | **Kept, reclassified as an "Understand" surface.** A Flow toggle on the Editor overlays the live pipeline diagram; also reachable from Decision + palette. Reads state, never edits. |
| **/strategy marketing page** | **Kept unchanged** as a public, indexing-gated SEO/marketing explainer — explicitly NOT in-app IA. Rename route to **`/how-it-works`**, linked once from the Editor footer + Help as an external "How the strategy works ↗". Removes the 5th "strategy" from the mental model. |

The duplicated LLM Review/TuningCard (currently in both Strategy tab and Studio, sharing `strategyTuning` state) collapses to **one instance** in Editor — highest-risk code change; stage as its own PR with the apply/discard flow tested end-to-end.

---

## 6. Multi-account / scoping model

### Three scopes, named and first-class

| Scope | What it is | Label | Lives |
|---|---|---|---|
| **Account** | A broker link + its one live running strategy (`account_strategy_state`) | **Account** chip (broker · env · label) | Persistent top-left switcher |
| **Preset** | A reusable, portable, *inert* named strategy template (`strategy_profiles`) | **Preset** | Presets library (in Strategy) + Accounts hub |
| **Workspace** | Everything shared across all the user's accounts | **Workspace** / "all accounts" | Preferences (§4b) |

### The five mental models the UI must make obvious
1. **You operate one account at a time, and it's always visible** (the chip; neutral fail-safe when none resolved).
2. **An account runs exactly one live strategy; a preset is a template you copy in.**
3. **Configuring = editing this account's live strategy in one place** (the Strategy Editor, stamped).
4. **Money-reality and authority are two separate visible dials** (`PAPER · Propose-only`).
5. **Autonomy is bounded, visible, and instantly stoppable** (guardrail numbers + one-click Halt).

### Verbs retired and replaced (kills the three-verb ambiguity)
- `activateAccount(id)` → **switch view** via the chip. Instant, free, re-scopes all read surfaces. No silent execution change.
- `activateStrategyProfile(id)`'s ambient "mirror into whatever account is active" side effect → **deleted**. Split into explicit "set as library default" vs "copy into account X."
- `applyProfileToAccount(id, accountId)` → **"Copy preset in"**: pick preset → pick one *or more* target accounts → **diff per target** (what changes, especially safety-limit overwrites) → **account-type guard** (block/hard-warn short/margin presets onto IRAs, gated on the `capabilities` snapshot) → **type-to-confirm for Live targets** → copy. Preserves `systemState` (never auto-arms a halted account). "Save as preset" snapshots the current live strategy out to the library.

### Switching mental model
- **View-scope (switch)** is instant and free; **execution-scope (arm)** is a separate deliberate act. Switching what you *look at* never changes what the agent *does*.
- **Provenance/drift** (`derived_from_profile_id`) surfaces in the switcher dropdown, Accounts hub cards, and Editor header (`from: X · modified`).
- **Going live is a ritual, not a toggle** (two ordered one-way doors): **D1 Arm Real Money** — allowed only after the account ran in Paper (enforced Paper-before-Live); "REAL MONEY" restatement + type-to-confirm → chip flips red. **D2 Arm Autonomy** — separate ritual; acknowledge the concrete guardrail envelope; on Live+Autonomous, type-to-confirm again.
- **Route-encoded scope** (`/accounts/:id/…`) recommended so a link *is* a scope and a stale tab can't act on the wrong account.
- **Single-account users stay on a zero-friction path** — their one account is viewed and armed by default; the view/arm split only surfaces for genuine multi-account users.

---

## 7. "What moves where" — every current surface

| Current surface | → New home | Note |
|---|---|---|
| Decision tab | **Decision** destination (hot core) | Cards upgraded: inline account + remaining-budget + regime + nearest risk rule |
| Assistant tab (approval path) | **Docked pane inside Decision** | Kills the two-approval-homes bug; same pending list |
| Market Scan tab | **Research → Market Scan** | Evidence-on-demand |
| Macro tab | **Research → Macro** | " |
| Performance tab | **Performance → Performance** | |
| Tax tab (outcomes) | **Performance → Tax** | Resolves label collision (outcome ≠ rules) |
| Strategy tab | **Strategy** destination (the Editor) | The one config home |
| Strategy Studio modal | **Strategy → Editor** | Deleted as modal; contents now editable inline |
| Settings → Strategy (read-only) | **Deleted** → one-line pointer redirect | Dead-end mirror |
| Strategy Flow overlay | **Strategy → Editor "Flow" toggle** (+ Decision, palette) | Reclassified "Understand"; reads state only |
| /strategy marketing page | **`/how-it-works`** (public, unchanged) | Linked from Editor footer + Help only |
| Settings → Operate | **Strategy → Automation** | Renamed; account-scope |
| Settings → Safety/Risk | **Strategy → Guardrails** | Account-scope; two-level disclosure |
| Settings → Tax | **Strategy → Tax rules** | Config ≠ the Performance Tax outcome view |
| Settings → Tuning | **Strategy → Learning** | Renamed |
| Settings → Connections | **Preferences → Connections** | User-scope |
| Settings → Display | **Preferences → Appearance** | Renamed |
| Settings → Notifications | **Preferences → Notifications** | Delivery rules only |
| Settings → Data | **Preferences → Data & Privacy** | Renamed |
| `marketScanCandidateLimit`/`OutlierReserve` | **Strategy → Automation** (was Data) | §4e; data-model change — coordinate/back-fill or relabel-in-place |
| Feed: Activity | **Activity (All)** | Whole rail becomes one log |
| Feed: Runs | **Activity → Runs filter** | |
| Feed: Notifications | **Split:** live → 🔔 chrome dropdown; log → **Activity → Alerts** | One label was doing three jobs |
| Feed: Audit Log | **Activity → Audit filter** | |
| Account selector (Settings-only) | **Persistent top-left switcher** | #1 multi-account safety cue |
| Execution mode banner | **Money-reality color chip on the switcher** | Grey/blue/red |
| Run once (top bar) | **Global chrome, right zone** | Kept, promoted |
| Start/Stop system | **Global chrome: Halt & Flatten** | Halt one-click; Flatten confirmed |
| Kill switch (event/auto only) | **First-class Halt & Flatten verb in chrome** | Manual brake beside auto breakers |
| Risk limits (Settings + Strategy card) | **Ambient risk strip in chrome + on proposal cards** | Legible at moment of action |
| Copy-to-account picker (buried div) | **Presets → "Copy to accounts…" multi-select + diff/confirm** | Core workflow, promoted |
| Strategy Profiles (buried card) | **Presets bar (top of Strategy) + Accounts hub** | First-class; renamed "Presets" |
| Command palette | **Kept + promoted** | Re-pointed to 5 destinations + sub-tabs first |
| Profile menu (top-right) | **Kept**; account-switcher owns scope, this owns identity | No more "Profile" collision (presets renamed) |
| Help modal | **Kept**; Settings Glossary updated in lockstep | |
| /admin/*, /mobile, /welcome, /login | **Unchanged** | Out of this redesign's scope |

**Net:** primary spine **11 → 5**; strategy config surfaces **5 → 1** (Editor) + 2 explicit explainers (Flow toggle, /how-it-works); settings surfaces **4 → 2** (Strategy destination for account-scope, Preferences for user-scope); duplicated labels **2 → 0**; scope answerable **never → always**.

Key implementation anchors: `app/dashboard-client.tsx` (tab defs `:148/161/162/165`, tier logic `:165-168,4508-4797`, account selector `:4722-4756`, palette `:1576+`, DecisionView `:2241`, top-bar Run/Stop `:1720-1760`, buried copy-to-account `:3563-3582`); `src/lib/db-profiles.ts` (`USER_LEVEL_POLICY_FIELDS:20`, `activateStrategyProfile:518/531`, `applyProfileToAccount:547`, `derived_from_profile_id:216`); `src/lib/types.ts:280` (`ConnectedAccount`); `app/ui/strategy-flow.tsx`; `app/strategy/page.tsx`.
