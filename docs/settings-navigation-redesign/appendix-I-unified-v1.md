# Appendix I — Unified Recommendation v1 (pre-red-team)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

## Design principles

These nine principles are the invariants. Where later sections make a specific call, it traces to one of these. When two conflict, the earlier wins.

1. **The Account is the primary object; account context is a persistent frame, never a destination.** Everything that matters — strategy, guardrails, autonomy, tax, P&L, wash-sale scope, proposals, fills — is scoped to one broker-connected account. You never "navigate to an account"; you *select* one, and it re-scopes the current screen in place. All four independent designs converged here, and the existing schema (`account_strategy_state` keyed by `connectedAccountId`) already assumes it.
2. **Scope is an authority grant, not a view filter.** A wrong scope in a normal SaaS app shows wrong data; here it can point an autonomous agent at the wrong *real-money* account. So scope is route-encoded (`/a/:accountId/...`), fails to a neutral "No account selected" blocking state, and is never silently inherited by automated/scheduled paths.
3. **Money-reality and Authority are two orthogonal dials, never one slider.** Test→Paper→Live is a property of the credential/data-plane. Propose→Decide is a separate axis of trust. Each is armed by its own deliberate ritual; neither is a casual toggle.
4. **Money-reality is ambient, and Live is loud.** Test = grey, Paper = blue, **Live = red** — repeated on the switcher, on the viewport accent, and on every action button ("Approve — **LIVE**"). No one ever acts on real money believing it was paper.
5. **Separate the brain from the fence.** Strategy (how to make money) and Guardrails (how to never blow up) are authored in two distinct destinations built on *one shared config engine*. A kill switch must never be buried inside a prompt-tuning screen; an aggressive mandate edit must never silently loosen a stop.
6. **The AI never gets a side door.** Anything the assistant or the auto-tuner proposes — a trade or a config change — re-enters the *same* deterministic gates (approval queue for trades, confirmable diff for config). The gates are inviolable.
7. **Presets copy, they don't link.** Applying a preset *forks* its values into an account (snapshot, not live reference); apply is always diff-and-confirm. Later edits to one account never mutate the preset or sibling accounts. Provenance ("from *Balanced Swing* · 6 local edits, reset to source") is always visible.
8. **Safe by default; friction reserved for one-way doors.** New account = Test + Propose-only + stops-on + breakers-armed; autonomy resets to its safe floor on restart. Cheap friction everywhere is alert fatigue, so type-to-confirm is reserved for exactly two one-way doors: **arm Live** and **arm Auto-on-Live**. Halt is always one click.
9. **Novice-safe floor, power-complete ceiling.** ~120–150 knobs never greet a newcomer. Every config surface opens on a handful of plain-language Essentials with a live consequence preview; depth folds behind at most one "Advanced" reveal; search + command palette are the power-user escape valves.

## Target information architecture

**Six verb destinations** (all account-scoped except Settings), plus a persistent Assistant overlay that is deliberately *not* a tab. This replaces the current 7 workspace tabs + 4 feed tabs (11 primary surfaces) and folds the 9-section settings modal into a scope-first tree.

| # | Destination | Purpose | What lives there |
|---|---|---|---|
| 1 | **Dashboard** (home) | "What is this account's agent doing right now, and does anything need me?" | Equity/cash/buying-power, open positions attributed to the strategy that produced them, agent state (running/paused/tripped), next-run countdown, macro/regime strip, watchlist rail, live guardrail-budget gauges (daily notional used, drawdown vs high-water, net exposure), and the top-N of the approval queue. When the switcher is set to **All accounts**, this becomes the **Fleet view** (see §Multi-account). |
| 2 | **Approvals** | "What is the AI asking me to decide, and why?" | The HITL decision queue for the active account (or All-accounts with per-row account tags). Each card: symbol/side/size, thesis tag + confidence, Bull→Bear→Red-Team debate, the policy-gate checklist (pass/block with plain reasons), entry-anchor + drift meter, projected bracket, expiry, and the **MODE badge on the Approve button**. Actions: Approve / Reject (reason feeds learning) / Adjust-and-approve / Snooze. In **Decide** mode it becomes the reviewable ledger of what auto-executed, with identical evidence and a one-tap "drop to Propose." |
| 3 | **Strategy** | "How should the AI think — on this account, or as a reusable recipe?" | The brain: editable prompt/thesis, the 8 scoring-weight sliders (each showing default vs current vs auto-tuned value, with a "let the AI tune this" toggle), AI-review config (Bull model, Red-Team model + conviction threshold, reasoning effort), holding horizon, and universe/scan (indices, blocklist, floors, candidate limit). **Hosts the Preset library.** Header always stamped with the active account + MODE badge + preset provenance. |
| 4 | **Guardrails** | "What can the AI never do on this account, and how much rope does it have?" | The fence, deliberately apart from the brain: sizing & exposure caps, stops/take-profit/trailing, circuit breakers (each card doubles as live *armed / tripped* status), execution controls (order types, hours, cadence, marketable-limit, drift/staleness gates), tax **rules** (lot method, wash-sale guard, ST/LT rates), and — the key placement call — **the autonomy dial**, sitting next to the drawdown and daily-loss stops that make loosing the AI survivable. |
| 5 | **Review** | "How did this account actually do, and should I keep trusting it?" | Outcomes and learning: realized P&L vs SPY, thesis/regime/factor scorecards, counterfactuals ("ideas we passed on"), tax **outcomes** (lots, holding-period ladder, harvest candidates, net-of-tax), the **Tuning queue** (AI-proposed weight/policy changes reviewed like a code review), and **audit as a filterable lens** reachable here (and from Approvals/Dashboard/Settings). |
| 6 | **Settings** | "My identity and wiring." | User-global only, **off the primary rail** (reached from the switcher footer / avatar menu): identity/auth, broker connections + per-broker capabilities, API keys (LLM + market-data + broker creds), default model/reasoning-effort, notification channels & event routing, web-source/data toggles, learned-memory review, the Preset library manager, observability, and **Admin (role-gated, conditionally rendered)**. |

**Scan/Research** stays a light, read-only destination (or a Dashboard drill-down) rather than being demoted to "just an input" — the ranked candidates, factor scores, web-signal bulletins, and skipped-candidate view are evidence a supervisor browses independently of any one proposal.

**The Assistant** is a persistent, scope-aware slide-over reachable via ⌘K and a rail button that overlays all six destinations — so you can ask "why is this proposal risky?" *on the Approvals card* without losing your place. It reads the active account's context, cites its sources, and routes every trade → Approvals and every config change → a confirmable diff. Counting it as a peer tab would misrepresent it and would recreate the current app's "two approval homes" bug.

**Why six and not five or seven.** The six map to six genuinely distinct cognitive modes — *monitor / decide / author the brain / author the fence / judge & learn / wire up*. The two most-debated splits are both resolved toward more destinations: **Approvals earns its own home** (proposals have a lifecycle, a backlog, and deep artifacts — the Dashboard shows only the count and top few), and **Strategy and Guardrails are split** rather than fused, because the safety premise requires the fence to be a distinct, reassuring room. Everything else that *looks* like a top-level area is a facet: macro/watchlist → Dashboard strip; scan → light destination/drill-down; tax → rules in Guardrails + outcomes in Review; notifications → events are chrome badges, config is Settings; audit → a lens; "accounts" → the switcher (management in Settings).

## Global frame

Persistent chrome on every screen, three zones. It never scrolls and it always answers the four questions a supervisor must never get wrong: *which account, what money-reality, what authority, running or halted.*

```
┌─ LEFT (scope) ───────────────┬─ CENTER (spine) ─────────────────────────┬─ RIGHT (verbs + risk) ─────────────────────┐
│ ◈ Roth IRA · Alpaca      ▾   │ Dashboard Approvals Strategy               │ ⟨used 2k/10k · net 0.4x · Neutral⟩         │
│   ● PAPER · Propose-only     │ Guardrails  Review                         │ [▶ Run once] [■ Halt & Flatten] 🔔 ⌘K ? ⦿ │
│   $48,210  ▲ +1.2%           │  (Settings off-rail, in footer/avatar)     │                                            │
└──────────────────────────────┴────────────────────────────────────────────┴────────────────────────────────────────────┘
```

**Left — the Account Switcher (the scope anchor).** Pinned top-left, present on every screen, the single most-looked-at control in the app. The chip shows `alias · broker`, the **money-reality badge with ambient color** (grey/blue/**red**), the **authority chip** (`Propose` / `Decide`, plus tripped states inline: `‖ HALTED`, `● close-only`, `⚠ brake`), and live equity + day P&L. The dropdown is a **portfolio-of-accounts list** with Live accounts grouped and separated first (so you never fat-finger a live account), each row showing badge, autonomy, health dot, day P&L, pending-approval count, and active preset. It has a top **"All accounts (Fleet)"** row, and a footer with **+ Connect account** and **Preferences… / Settings**. When a Live account is active, the whole viewport gets a persistent red hairline accent. Switching re-scopes Dashboard/Approvals/Strategy/Guardrails/Review in place, persists across navigation and sessions, and — when scope is unresolved — shows a neutral **"No account selected"** state that *blocks* scoped actions.

**Right — global verbs + ambient risk** (never buried in Settings):
- **Ambient risk strip:** today's used/remaining daily notional, gross/net exposure vs cap, current regime — the numbers the approver needs, always visible.
- **▶ Run once** — produce proposals now. One click on Test/Paper; the Live/Decide rung is armed separately, not here.
- **■ Halt & Flatten** — the always-visible kill switch, safety-asymmetric: **Halt is one click** (reversible, safe); **Flatten** (sells positions) requires confirm, type-to-confirm on Live. In Fleet mode this exposes **Halt all / Set all close-only**.
- **🔔 Notifications** — a live-alert dropdown (distinct from Notifications *settings* in Settings and the Notifications *log* under audit). Bell + unread count.
- **⌘K Command palette** — promoted as the power-user jump layer over the six destinations + their sub-sections + "open Settings section X" + "run once" + deep-links into any config field.
- **? Help** — contextual panel (Overview | Guardrails | Settings Glossary | Tax | Data Sources | MCP), kept and updated in lockstep with renames.
- **⦿ Avatar / Preferences** — identity menu; owns Settings entry and account management. Distinct from the switcher, which owns *scope*.

## Multi-account & scoping model

This is the make-or-break axis and is designed first, not bolted on. A user simultaneously runs, e.g., *Robinhood Live (taxable)*, *Alpaca Paper*, a *Roth IRA*, and a *Test Sim* — each with independent strategy, risk, tax, and ledger, but sharing keys, notification prefs, and the preset library.

**Three entities, named and first-class:**

| Entity | Schema anchor | What it is | Blast radius | Lives |
|---|---|---|---|---|
| **Connected Account** | `ConnectedAccount` (`types.ts:280`); live bound instance in `account_strategy_state` (`db-profiles.ts`) | A broker link + its one running strategy + guardrails + autonomy + ledger. The scope unit. | This account only | The persistent switcher |
| **Preset** (renamed from "Strategy Profile") | `strategy_profiles` | A reusable, inert, named template of *(policy + prompt + scoringWeights)*. **Not** tax treatment, **not** autonomy, **not** keys — those are account-intrinsic. | Every account it's copied into (at copy time) | Strategy → Presets; managed in Settings |
| **User-global** | `USER_LEVEL_POLICY_FIELDS` (`db-profiles.ts:20`) + user settings | Identity, keys, model defaults, notification channels, data-source toggles, the preset library. | All accounts | Settings |

**The three-tier resolution contract, with provenance:**
```
USER-GLOBAL  →  PRESET (copied in)  →  ACCOUNT OVERRIDE  →  EFFECTIVE (resolved, with "where it came from")
```
Every effective value on an account screen wears an **origin badge**: `● account value` · `↳ from preset "X"` · `⊘ locked by account type` · `your global default`, with one-click **reset-to-source**. An **"Overrides (N)"** chip lists exactly how this account deviates from its template.

**The "which account am I configuring right now?" solution** — four reinforcing mechanisms so the answer is never ambiguous:
1. **The switcher is always visible** and every account-scoped screen echoes its chip in the header (`Live Strategy — Roth IRA · Alpaca [PAPER]`).
2. **Scope is route-encoded** (`/a/:accountId/strategy`) so a stale tab or deep link *is* a scope and cannot act on the wrong account; unresolved scope fails to the neutral blocking state, never "last-used, possibly Live."
3. **Account-scoped config lives with the account** (Strategy/Guardrails destinations), while user-global config lives in Settings — so opening a "gear" never leaves you wondering whose behavior you're editing.
4. **Every setting wears a scope tag** (`THIS ACCOUNT` / `PRESET` / `ALL ACCOUNTS`) and any save that touches N accounts says so *before* it commits.

**How switching accounts changes the app.** Switching is **view-scope**, and it is instant, free, and reversible: it re-scopes all read/config surfaces in place (so you can flip between two accounts' Guardrails to compare) and never bounces you home or changes what any agent *does*. **Execution-scope (arming)** is a separate, deliberate act. Switching *into* a Live account shows a brief "you are now acting on REAL MONEY" acknowledgment and flips the viewport accent red.

**Fleet view (All accounts).** Selecting "All accounts" turns the Dashboard into a read-and-triage board: one card per account with mode badge, equity + day P&L, autonomy state, open-position count, pending-approval count, active preset, last-run time, and any tripped breaker as a red banner; aggregate net worth on top. **No trade can be placed from the roll-up** — you drill into an account to act (this structurally prevents "acted on the wrong account"). But because panic doesn't respect account boundaries, Fleet *does* carry fleet-wide emergency controls: **Halt all / Set all close-only / Pause autonomy.**

**Presets: copy-on-bind, never live-link.** Applying a preset **snapshots** its values into the account and stamps `derived_from_profile_id`; from that instant the account is independent. The account cockpit shows **"Preset: Momentum-v3 · diverged: 6 fields"** → click to diff, then **re-sync from preset** (pull) or **promote to preset** (push as a new version). Apply is always **diff-and-confirm**, with an **account-type guard** (block/hard-warn short/margin presets onto IRAs, gated on the `capabilities` snapshot) and **type-to-confirm for Live targets**. "Capture current as preset" snapshots a dialed-in account out to the library.

**The three colliding verbs, resolved** (this is the concrete behavior change the greenfield designs couldn't see):
- `activateAccount(id)` → **"switch view"** via the chip. Instant, free, re-scopes reads; no execution change.
- `activateStrategyProfile(id)`'s **ambient "mirror into whatever account is active" side effect → deleted.** Split into explicit "set as library default" vs "copy into account X." This silent behavior is the single most dangerous legacy mechanic and must be removed, not merely re-skinned.
- `applyProfileToAccount(id, accountId)` → **"Copy preset in"**: pick preset → pick one or more targets → per-target diff (highlighting any safety-limit overwrite in the account's color) → account-type guard → type-to-confirm for Live → copy; never auto-arms a halted account.

**Cross-account behaviors surfaced where they bite** (not in a settings backwater):
- **Cross-account wash-sale lockout** — a realized loss in the taxable account locks rebuys of that symbol across *all* accounts for 30 days; surfaced **on the blocked proposal, naming the culprit account** ("locked by loss in Robinhood·Live, clears Jul 24") and in Fleet. *(Verify against `src/lib/policy.ts` / tax logic that the engine actually enforces cross-account lockout before promising it in UI — see Open Questions.)*
- **Hourly-cap breach auto-revert** — flips an account Decide → Propose; surfaced as a chip state-change + notification with reason and reset time.

## Settings taxonomy

Config splits **by scope first**, then by ≤6 categories per scope, then by at most a two-level disclosure ladder (Essentials → one Advanced reveal; a cordoned Expert tier for env-managed flags). The account-vs-user tier stops being a hidden `ACCOUNT_SETTINGS_SECTIONS` toggle and becomes the structural top of the tree. **Governing rule: if a setting changes how a trade is decided or placed, it belongs to the account** — a mis-scoped risk field is a money bug.

### Scope A — Account-scope config → lives in the Strategy & Guardrails destinations (not a modal)

```
STRATEGY  (account-scoped; header stamped with the active account + preset provenance)
  Presets bar (always visible): Start from preset… · Capture current as preset… · Copy to accounts…
  ├─ Thesis        prompt / thesis language / holding horizon
  ├─ Signals       8 factor weights (0.6–1.4, default vs current vs auto-tuned) · min-score · universe/scan/blocklist/floors
  └─ AI Review     Bull model · Red-Team model + conviction threshold · reasoning effort  (overrides global default)

GUARDRAILS  (account-scoped; each breaker card doubles as live armed/tripped status)
  ├─ Autonomy      Propose ↔ Decide dial · system state · kill-switch thresholds     [Layer-1, always visible]
  ├─ Sizing        max order notional/%NAV/%ADV · daily & hourly caps · proposals-per-run · sell-to-fund-buy
  ├─ Exposure      per-symbol / per-sector / gross / net / beta / correlation caps
  ├─ Risk          stop-loss / take-profit / trailing / trim · ATR-&-beta stops · brackets · short stop (mandatory when shorting)
  ├─ Circuit brk.  max drawdown · max daily loss · vol-panic + VIX/VVIX/SKEW thresholds
  ├─ Execution     order types · extended hours · cadence · marketable-limit + buffer · entry-drift % · staleness gates
  └─ Tax RULES     tax type (taxable/Roth/traditional — account-intrinsic) · wash-sale guard · ST/LT rates
```

### Scope B — User-scope settings → the Settings tree (the only thing that stays a menu, off-rail)

```
SETTINGS  (user-scope · ALL ACCOUNTS · reached from switcher footer / avatar)
  [ 🔍 Search all settings… ]   ← indexes every field label + synonym + section + scope, derived from the
                                   same field definitions that render the controls (never a parallel hand-maintained list)
  ├─ Account & Security     identity · auth providers · sessions · deletion
  ├─ Connections            broker connect/disconnect · environment · confirmed capabilities · per-broker creds
  ├─ Keys & Models          LLM + market-data keys (encrypted, connection-test) · default model / reasoning effort
  ├─ Notifications          channels (email/push/SMS/webhook) · event routing · stale-order threshold · test-send   (delivery rules only — NOT the alert stream, NOT the log)
  ├─ Data & Privacy         web-source toggles (Congress/insider/FINRA/8-K/technicals) + staleness · pool consent · observability opt-ins · export
  ├─ Presets                the strategy preset library manager
  ├─ Appearance             theme · density · default landing account
  └─ Admin (role-gated)     user allowlist · per-user LLM usage/billing · provider health · system-wide halt/close-only   [conditionally rendered — /admin/* consolidated here]
```

**Renames** (keep the `SettingsSection` union ids stable as routing keys; map old→new with redirects so existing `openSettings("operate")` call sites and palette entries keep working): `Operate → Guardrails·Execution`/`Autonomy`, `Safety → Guardrails·Risk`, `Tuning → Review·Tuning`, `Display → Appearance`, `Data → Data & Privacy`, `Strategy Profile → Preset`, `user-tier → all-accounts`. Update the Help "Settings Glossary" in the same PR (cross-file trap).

**Woven through every control, in both scopes:** effective value + default + origin badge (§scoping) + a live plain-English consequence preview ("risks at most **$1,000** — about **2%** of this account's equity"), and a **pre-save impact preview on any live-money change** ("under this rule, N of your last proposals would now be blocked"). Auto-tuned values are attributed to the audit entry that set them. Loosening a limit *down* is frictionless; raising a cap on Live, disabling a stop, enabling shorting, or flipping to Live/Decide triggers an inline consequence-labeled confirm (typed acknowledgment for the two one-way doors). Capability-aware disabling greys out what the broker/account-type forbids with an inline explainer.

## Strategy, consolidated

Strategy config today lives in **five surfaces** with no intuitive reason. It collapses to **one editable home** (the Strategy destination, account-scoped) + two explicit *explainers* that read state but never edit it. The header is always stamped **"Live Strategy — <account> [MODE]"** + preset provenance.

| Legacy strategy surface | Fate | Rationale |
|---|---|---|
| **Strategy workspace tab** | **Becomes the Strategy destination** — the one editable home (Thesis / Signals / AI Review sub-tabs + the Presets bar). | The single home. |
| **Strategy Studio modal** (prompt + sliders + scoring matrix + Green/Red-team review) | **Deleted as a modal; contents move inline into Strategy → Thesis/Signals/AI Review, now editable in place.** An optional full-screen *mode* of the editor preserves the distraction-free feel. | A modal that duplicates the tab is pure Frankenstein surface. The duplicated LLM Review/TuningCard (currently in both the Strategy tab and Studio, **sharing `strategyTuning` state**) collapses to one instance — this is the **highest-risk change; stage it as its own PR** with apply/discard tested end-to-end. |
| **Settings → "Strategy" section** (read-only mirror) | **Deleted → one-line pointer** ("Strategy is configured in the Strategy tab →") for one release, then removed. | A read-only mirror in Settings is a dead-end false affordance and a duplicated label. |
| **Strategy Flow overlay** (`app/ui/strategy-flow.tsx`) | **Kept, reclassified as an "Understand" surface** — a Flow toggle in the Strategy editor overlays the live pipeline diagram next to what it visualizes; also reachable from Dashboard + palette. Reads state, never edits. | It genuinely aids comprehension; it just isn't *config*, so it must not masquerade as another editing surface. |
| **Public `/strategy` marketing page** (gated by `LANDING_PAGE_ENABLED`) | **Kept, renamed `/how-it-works`**, linked once from the editor footer + Help as an external "How the strategy works ↗". Explicitly **not** in-app IA. | Removes the 5th "strategy" from the mental model by making its separate (SEO/marketing) purpose obvious. |

**Net:** strategy config surfaces **5 → 1** editable home, plus 2 clearly-labeled explainers. The autonomy dial deliberately does **not** live here — it lives in **Guardrails**, next to the breakers that bound it, because arming the AI is a containment decision, not a mandate decision.

## Open questions for the owner

1. **`USER_LEVEL_POLICY_FIELDS` migration vs. relabel-in-place.** Moving fields (e.g. `marketScanCandidateLimit` / `marketScanOutlierReserve`) from user-tier to account-tier requires a data migration + per-account back-fill. Do we pay that cost now for true per-account scoping, or ship the **safe fallback** (leave them user-scoped, relabel "applies to all accounts") this cycle? Do **not** ship half-migrated. *(Which fields, if any, are worth the fan-out is your call.)*
2. **Cross-account wash-sale: enforced or displayed?** Design B2's "block the rebuy across all accounts, name the culprit" is only honest if `src/lib/policy.ts` / the tax engine actually *enforces* the cross-account lockout today. Before we promise it in the Approvals UI, confirm enforcement — otherwise we scope it as display-only with a clear label.
3. **Admin/operator home.** All four source designs under-specified this. Proposal: consolidate `/admin/*` (connections-health, llm-usage, rag-coverage, transcript) under **Settings → Admin**, role-gated and conditionally rendered. Confirm the operator-vs-user role boundary in code and whether any admin surface must remain a separate route for ops reasons.
4. **Route-encoded scope migration.** Adopting `/a/:accountId/...` is the strongest safety primitive but is a routing change against a ~7,000-line `dashboard-client.tsx` monolith. Do we land it as a first-class app-router restructure, or keep scope in state short-term (accepting the "stale tab can act on wrong account" risk) and route-encode later? This decides sequencing.
5. **Vocabulary lock-in.** Recommendation keeps **"Account"** (matches schema + 3 of 4 designs) and renames "Strategy Profile" → **"Preset"** — and explicitly rejects net-new nouns "Desk" / "Workspace." Confirm before we thread the rename through UI copy, Help glossary, and the palette.
6. **Fleet-wide emergency controls scope.** Should "Halt all / close-only all" from the Fleet view hit **Live accounts only**, or **all environments** including Test/Paper? (Argument for Live-only: a Test halt is meaningless noise in a crisis. Argument for all: muscle-memory consistency.)
7. **Single-account users.** The view/arm split and the switcher add value only for multi-account operators. Confirm we keep a **zero-friction path** for the common single-account user (their one account viewed and armed by default, the switcher collapsing to a static chip) so the multi-account machinery never taxes the majority case.

---

Deliverable is the markdown body above. Key code anchors verified against the live tree this session: `src/lib/db-profiles.ts` — `USER_LEVEL_POLICY_FIELDS:20`, `derived_from_profile_id:186/198/211/216`, `activateStrategyProfile:518` (with the documented ambient side-effect at `:531`), `applyProfileToAccount:547` (copy-not-link, comment at `:540`); `src/lib/db.ts:477` (`derived_from_profile_id` schema); `ConnectedAccount` at `src/lib/types.ts:280`. Working tree is clean; latest commit `0f6bf0a`.
