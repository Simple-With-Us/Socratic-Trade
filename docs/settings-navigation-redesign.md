# Settings & Navigation Redesign — Canonical Proposal

**Status:** Direction **owner-approved (2026-07-01)**; all 7 Open Questions resolved. A complete **implementation-ready spec** now lives in [`settings-navigation-redesign/spec/`](./settings-navigation-redesign/spec/) (start at its [`00-README.md`](./settings-navigation-redesign/spec/00-README.md)), and a **clickable prototype** in [`settings-navigation-redesign/prototype/index.html`](./settings-navigation-redesign/prototype/index.html). This doc remains the canonical design; the spec folder is the buildable detail. Next code step: PR #1 of the delivery plan (relabels + scope-surfacing).
**Date:** 2026-07-01  ·  **Branch:** `claude/settings-navigation-redesign-a3k1yv`  ·  **Baseline:** `HEAD 0f6bf0a` (working tree clean)
**Scope:** The whole app frame — primary navigation, the 9-section settings surface, the scattered Strategy surfaces, and the multi-account/scoping model.

> **Open questions → resolved (2026-07-01).** The 7 questions in Part I are answered in the spec's [decisions log](./settings-navigation-redesign/spec/00-README.md#owner-decisions-log-2026-07-01--the-7-open-questions-resolved): market-scan breadth stays user-global; autonomy resets to Propose-only on restart (default ON); Fleet STOP = Live+Paper (Test excluded); thin `/a/:accountId` + server-side write validation; adopt the Preset/Results/Alerts vocabulary in full; full mobile parity specified; single-account stale-id auto-resolves.

---

## 0. Why this document exists (the complaint, in one paragraph)

The app grew by accretion, and it shows. **Strategy configuration lives in five different places** — a "Strategy" workspace tab, a "Strategy Studio" modal, a "Strategy" section inside Settings, a "Strategy Flow" overlay, and a public `/strategy` explainer — with no intuitive reason for the split. The same word means two different things depending on where you are: **"Tax"** is a workspace tab *and* a settings section *and* a help topic; **"Notifications"** is a feed tab *and* a settings section. And the multi-account story rests on **three overlapping concepts that are never named or visually distinguished** — Connected Accounts (broker links), Strategy Profiles (reusable presets), and user-global settings — so users can't answer the two questions that matter most: *"which account am I configuring right now?"* and *"does this apply to one account or all of them?"* This document redesigns the frame from end to end so it reads as **purpose-built**, not patched.

## 1. How this proposal was produced (why you can trust it)

You asked for two things: an expert team that knows the app to redesign it end-to-end, **and, separately, experts who don't know the current layout** designing fresh so the result isn't anchored to today's Frankenstein. This proposal is the synthesis of exactly that — run at scale (48 specialist agents, ~3.5M tokens):

1. **Forensic map (5 agents)** reverse-engineered the *current* IA from the code — every tab, section, modal, route, and the exact file\:line where each lives (Appendix A). A sixth output, a deliberately **layout-agnostic capability inventory** (Appendix B), described *what the product does* with zero UI vocabulary — the only thing the blind teams were allowed to see.
2. **Pattern research (6 agents)** studied how best-in-class products solve the same problems: consumer apps (Robinhood/Public/eToro), pro terminals (thinkorswim/IBKR/TradingView), algo & robo platforms (Composer/QuantConnect/Alpaca/Betterment), account/workspace switchers (Stripe/Vercel/Linear/GCP), and settings-taxonomy best practice (NN/g, iOS, Slack) — Appendix C.
3. **Four independent design teams (~22 designers)** each produced a complete design:
   - **Team A — Informed** (knew the app + the maps) → *Appendix D*
   - **Team B1 & B2 — Blind greenfield** (given *only* the capability inventory, forbidden from reading the current UI, different designer mixes) → *Appendices E, F*
   - **Team C — Pattern-led** (mapped proven external patterns onto the requirements) → *Appendix G*
4. **Adjudication (Appendix H)** found where **three or four teams independently converged** — those are the highest-confidence moves — and where they diverged, and named each team's blind spots.
5. **Adversarial red-team (Appendix J):** four skeptics attacked the draft (migration feasibility against the 7,015-line client, multi-account edge cases, novice-safety, coherence). The architect then **re-verified every contested claim against the live code tree** and revised to the v2 below. This is why the design carries real `file:line` anchors and names its own highest-risk change.

**The convergence is the headline.** Independently, the informed team and the blind teams arrived at the same spine: **the account is the primary object; navigation is a small set of verbs; strategy has exactly one editable home; money-reality (practice vs real) and authority (propose vs auto-execute) are two separate dials; and configuration splits by scope first.** That four teams reached this without seeing each other's work is the strongest signal that it's right.

## 2. The current state, diagnosed

The app today exposes **~40+ navigation surfaces**: 7 workspace tabs (Decision, Assistant, Market Scan, Macro, Performance, Tax, Strategy) + a separate 4-tab "feed" rail (Activity, Runs, Notifications, Audit) + a 9-section settings modal split across two *implicit* scope tiers + 7 major modals/overlays + a profile menu + a command palette + 9 separate routes. The forensic map (Appendix A) enumerates all of them with file\:line citations and surfaces **ten concrete redundancies**, the worst being:

- **Strategy config in 5 surfaces** — no canonical place to edit it.
- **Duplicate labels** — "Tax" (tab + settings + help) and "Notifications" (feed tab + settings) each mean both "view" and "configure."
- **The account⁄user scope split is invisible** — it exists in code (`ACCOUNT_SETTINGS_SECTIONS`, `dashboard-client.tsx:165`) but the UI barely signals it, so users don't know whether a change hit one account or all of them.
- **Three un-named scope concepts** — Connected Account vs Strategy Profile vs user-global — with no vocabulary or visual distinction.

Everything below is the fix.

### Relationship to existing docs

This proposal is about **where settings and features live and how you navigate them** (information architecture). It is complementary to — not a replacement for — [`docs/settings-and-universe-overhaul-plan.md`](./settings-and-universe-overhaul-plan.md), which is about **field completeness and honesty** (surfacing the ~17 enforced-but-invisible policy fields, universe floor, take-profit trim). That program decides *which knobs exist and whether the editor tells the truth about them*; this one decides *which home each knob lives in and how you get there*. The field-level settings tree in Part II-B is the join point: it places every field that program surfaces into a coherent scope-first structure. Land them in either order; Phase 1 here (pure relabel + scope-surfacing) does not conflict with that program.

---

# PART I — The canonical target design (v2)

*The definitive narrative. Detailed engineering artifacts (wireframes, field-level settings tree, full migration table, phased plan) follow in Part II; known gaps in Part III.*

## Design principles

Twelve invariants (v1 had nine; three added to close red-team gaps: incremental-path, view/execution decoupling, single-account-first). Where a later section makes a specific call, it traces to one of these. When two conflict, the **earlier wins**, and where earlier-wins kills a feature the doc names it explicitly (see P12 note).

1. **The Account is the primary object; account context is a persistent frame, never a destination.** Everything that matters — strategy, guardrails, autonomy, tax, P&L, wash-sale scope, proposals, fills — is scoped to one broker-connected account. You never "navigate to an account"; you *select* one and it re-scopes the current screen in place. The schema already assumes this (`account_strategy_state` keyed by `connectedAccountId`).
2. **View-scope and Execution-scope are different things and must be decoupled in code before the UI can promise "free switching."** *(New — closes multiaccount-edge #1/#8.)* Today `getActiveConnectedAccount` is a **persisted singleton**, and any non-active account is coerced `systemState → "halted"` on the next policy write (`db-profiles.ts:284/350/397`). So flipping the active pointer today has real execution consequences. The target model splits **which account is in view** (ephemeral, per-tab, plural-safe) from **which accounts are armed to run** (per-account, persisted, plural). Until that decoupling ships, the switcher is NOT free — this is the **first blocking migration**, not a footnote.
3. **Scope is an authority grant, not a view filter.** A wrong scope here can point an autonomous agent at the wrong *real-money* account. So scope is validated **server-side on every mutating write** against the session's explicit `accountId` (the load-bearing guarantee), route-encoded (`/a/:accountId/...`) as the client seed, and never silently inherited by automated/scheduled paths.
4. **Money-reality and Authority are two orthogonal dials, never one slider.** Test→Paper→Live is a property of the credential/data-plane. Propose→Decide is a separate axis of trust. Each is armed by its own deliberate ritual.
5. **Money-reality is ambient, Live is loud — and "practice vs real" is stated in words, not just color.** *(Strengthened — closes novice #2.)* Badges carry a **word-level class**: **PRACTICE** (Test + Paper, no real money) vs **REAL MONEY** (Live), with the three-way color (grey/blue/**red**) underneath. The badge reads "PAPER · practice money," never relying on blue alone to teach a novice that paper is fake.
6. **Separate the brain from the fence.** Strategy (how to make money) and Guardrails (how to never blow up) are two destinations on **one shared config engine**. A kill switch is never buried in a prompt screen; an aggressive mandate edit never silently loosens a stop.
7. **The AI never gets a side door — and neither does the preset-edit path.** *(Strengthened — closes multiaccount-edge #4.)* Anything the assistant, the auto-tuner, **or a preset edit** proposes re-enters the *same* deterministic gates (approval queue for trades, confirmable diff for config). The ambient `mirrorPolicyToActiveAccount` must be removed from **all three** call sites — `activateStrategyProfile:531`, `updateStrategyProfile:512`, and the profile-write at `:486` — not just the one v1 named.
8. **Presets copy, they don't link — and resync is a three-way diff that honors per-field friction.** *(Strengthened — closes multiaccount-edge #5.)* Applying a preset *forks* its values into an account (snapshot, not live reference). Resync is an explicit three-way diff (base snapshot → preset-now vs base snapshot → account-now); any field whose resync *loosens* a Live limit inherits the same per-field confirm as a manual edit — **no bulk bypass**.
9. **Safe by default; friction reserved for one-way doors — plus a re-consent for the first Live act of a session.** *(Strengthened — closes novice #3.)* New account = Test + Propose-only + stops-on + breakers-armed; autonomy resets to its safe floor on restart *(if this reset is not already in `account_strategy_state`, it is net-new — see Open Q).* Type-to-confirm is reserved for the two one-way doors: **arm Live** and **arm Auto-on-Live**. But the **first Live approval of a session (or after idle)** requires an explicit confirm, and Adjust-and-approve on Live always confirms final size — "armed once" is not consent for unlimited frictionless real orders. Halt is always one click.
10. **Novice-safe floor, power-complete ceiling — including at the destination level.** *(Strengthened — closes novice #10, coherence C1.)* ~120–150 knobs never greet a newcomer. Every config surface opens on a handful of plain-language Essentials with a live consequence preview; depth folds behind at most one "Advanced" reveal. A first-run novice sees only **Dashboard, Approvals, Guardrails** (labeled "Safety limits"); Strategy/Review unlock after the first approved proposal.
11. **Single-account is the default rendering; multi-account chrome is progressive.** *(New — closes migration #8, novice #7/#11.)* For a user with exactly one account, the switcher collapses to a static chip and all scope tags / origin badges / Fleet / "which account" machinery is suppressed until a 2nd account connects. This is both a UX requirement and the migration wedge (§Incremental build path).
12. **Every restructure ships incrementally behind a flag with a rollback; no big-bang cutover.** *(New — closes migration #1–#9.)* The end-state IA is reached by a strangler-fig sequence with a client-persistence migration shim, per-PR test updates, and old ids kept as redirect aliases. The full ordered decomposition is normative (§Incremental build path).

> **P12 earlier-wins note (coherence F2):** Principle 3 (scope never silently inherited, fails to neutral) **kills a Live account as a "default landing account."** The Appearance "default landing account" setting is therefore restricted to **non-Live accounts only**; a Live account is never auto-selected on load. This is the one place two principles collided and P3 won.

## Target information architecture — definitive top-level nav

**Six verb destinations** (Scan is a seventh, explicitly resolved below — coherence D3), all account-scoped except Settings, plus a persistent Assistant overlay that is deliberately *not* a tab. This replaces the current 7 workspace tabs + 4 feed tabs.

| # | Destination | Purpose | What lives there |
|---|---|---|---|
| 1 | **Dashboard** (home) | "What is this account's agent doing right now, and does anything need me?" | Equity/cash/buying-power, open positions attributed to the producing strategy, agent state (running/paused/tripped), next-run countdown, macro/regime strip, watchlist rail, live guardrail-budget gauges (daily notional used, drawdown vs high-water, net exposure), top-N of the approval queue. When the switcher is **All accounts**, this becomes the **Fleet view** (§Multi-account). |
| 2 | **Approvals** | "What is the AI asking me to decide, and why?" | The HITL decision queue for the active account (or All-accounts with per-row account tags). Each card: symbol/side/size, thesis tag + confidence, Bull→Bear→Red-Team debate, the policy-gate checklist (pass/block with plain reasons), entry-anchor + drift meter, projected bracket, expiry, **cross-account wash-sale lockout named on the blocked card** (§Multi-account), and the **MODE badge on the Approve button**. Actions: Approve / Reject (reason feeds learning) / Adjust-and-approve (**re-runs the full policy gate on the edited size**, novice #12) / Snooze. In **Decide** mode it becomes the reviewable ledger of what auto-executed, with identical evidence and a one-tap "drop to Propose." |
| 3 | **Scan** *(light, read-only destination — resolved as its own destination, coherence D3)* | "What did research surface, independent of any one proposal?" | Ranked candidates, factor scores, web-signal bulletins, skipped-candidate view. It is browsable independently of a proposal, so per the doc's own test it **is** a destination — but a *read-only, secondary* one (reachable from Dashboard drill-down and the rail's "more"), not a co-equal verb. It never edits config and never places trades. |
| 4 | **Strategy** | "How should the AI think — on this account, or as a reusable recipe?" | The brain: editable prompt/thesis, 8 scoring-weight sliders (default vs current vs auto-tuned, each with a "let the AI tune this" toggle), AI-review config (Bull model, Red-Team model + conviction threshold, reasoning effort), holding horizon, universe/scan (indices, blocklist, floors, candidate limit). **Apply/capture presets in account context** (browse-vs-manage boundary in §Settings). Header stamped with active account + MODE badge + preset provenance. |
| 5 | **Guardrails** | "What can the AI never do on this account, and how much rope does it have?" | The fence, apart from the brain. **Opens on an Essentials layer of 5** (max position size · daily-loss stop · stop-loss on/off · autonomy dial · extended-hours on/off — coherence C1); the ~30 remaining controls fold behind one Advanced reveal. Full ceiling: sizing & exposure caps, stops/take-profit/trailing, circuit breakers (each card doubles as live *armed/tripped* status), execution controls, tax **rules**, cross-account tax couplings (§Multi-account), and the **autonomy dial** next to the drawdown/daily-loss stops that make loosing the AI survivable. |
| 6 | **Results** *(renamed from "Review" — coherence G1)* | "How did this account actually do, and should I keep trusting it?" | Outcomes and learning: realized P&L vs SPY, thesis/regime/factor scorecards, counterfactuals, tax **outcomes** (lots, holding-period ladder, harvest candidates, net-of-tax), the **Tuning queue** (AI-proposed changes reviewed like a code review), **Alert history** (§notifications rename), and **audit — with a single canonical home here (Results → History)**; the Dashboard/Approvals/Settings entry points are deep-links *into* it, not parallel homes (coherence B2). |
| — | **Settings** | "My identity and wiring." | User-global only, **off the primary rail** (§Settings taxonomy). |

**Why "Review" became "Results."** "Review" was overloaded across the AI-review config, Red-Team review, and diff-and-confirm review (coherence G1). Destination #6 is now **Results**, freeing "review" to stay a verb for approval/tuning actions.

**Scan resolved (coherence D3).** v1 left Scan in superposition. Decision: **Scan is a seventh, deliberately-secondary read-only destination.** The nav shows six *primary* verbs; Scan lives one level down (Dashboard drill-down + rail "more"). "Six primary verbs + one read-only research surface" is the honest count.

**The Assistant** is a persistent, scope-aware slide-over (⌘K + a rail button) overlaying all destinations, so you can ask "why is this proposal risky?" *on the Approvals card* without losing place. It reads the active account's context, cites sources, and routes every trade → Approvals and every config change → a confirmable diff. Counting it as a peer tab would recreate the "two approval homes" bug.

## Global frame — account switcher, run/kill/status, notifications, help, command palette

Persistent chrome on every screen, three zones. It always answers the four questions a supervisor must never get wrong: *which account, what money-reality (practice/real), what authority, running or halted.*

```
┌─ LEFT (scope) ───────────────┬─ CENTER (spine) ─────────────────────────┬─ RIGHT (verbs + risk) ─────────────────────┐
│ ◈ Roth IRA · Alpaca      ▾   │ Dashboard Approvals Strategy Guardrails    │ ⟨used 2k/10k · net 0.4x · Neutral⟩         │
│   PAPER · practice · Propose │   Results        (Scan/more ›)             │ [▶ Run once — Roth IRA·PAPER] [■ STOP] 🔔 ⌘K ? ⦿ │
│   $48,210  ▲ +1.2%           │  (Settings off-rail, in footer/avatar)     │                                            │
└──────────────────────────────┴────────────────────────────────────────────┴────────────────────────────────────────────┘
```

**Left — the Account Switcher (the scope anchor).** Pinned top-left, present on every screen. The chip shows `alias · broker`, the **money-reality badge with word-class + ambient color** (`PAPER · practice` grey/blue; `LIVE · real money` red), the **authority chip** (`Propose` / `Decide`, plus `‖ HALTED` / `● close-only` / `⚠ brake`), and live equity + day P&L. The dropdown is a **portfolio-of-accounts list** with **a distinct "Sandbox" section for Test/sim accounts** (multiaccount-edge #3 — not a peer broker row) and **Live accounts grouped and separated first**, each row showing badge, autonomy, health dot, day P&L, pending-approval count, active preset. Top row: **"All accounts (Fleet)."** Footer: **+ Connect account** and **Preferences… / Settings**. A Live active account paints a persistent red viewport hairline. Switching re-scopes destinations in place, persists across nav/sessions, and — when scope is unresolved — shows a neutral **"Pick an account to continue →"** state with the switcher auto-opened that *blocks* scoped actions. **For a single-account user the switcher is a static chip** (P11) and, on a stale/one-off account id, **auto-resolves to the sole account** instead of failing closed (novice #7, multiaccount-edge #9).

**Right — global verbs + ambient risk** (never buried in Settings):
- **Ambient risk strip:** today's used/remaining daily notional, gross/net exposure vs cap, current regime.
- **▶ Run once** — **the button is stamped with its target: "Run once — Roth IRA · PAPER"** (novice #1). One click on Test/Paper; the Live/Decide rung is armed separately, never inherited here.
- **■ STOP** *(relabeled from "Halt & Flatten" — novice #5).* The always-visible kill switch: **STOP halts new activity in one click, always safe, never sells.** Selling positions is a **separate, secondary "Flatten / sell positions"** action (confirm; type-to-confirm on Live) — never welded into the panic button. In Fleet mode this exposes **STOP all / Set all close-only**.
- **🔔 Alerts** *(renamed — the live-alert dropdown; novice #4 / coherence B1).*
- **⌘K Command palette** — jump layer over destinations + sub-sections + "open Settings section X" + "run once" + deep-links into any config field. **Palette "run once" inherits the exact money-reality gating of the chrome button — no Live execution without the arm ritual** (coherence E2).
- **? Help** — contextual panel (Overview | Guardrails | Settings Glossary | Tax | Data Sources | MCP), updated in lockstep with renames.
- **⦿ Avatar / Preferences** — identity menu; owns Settings entry and account management. Distinct from the switcher (which owns *scope*).

**Halt-state model (coherence B3).** There is **one halt state per account**; the surfaces are typed roles, each labeled with the layer it touches: the chrome **■ STOP** and Fleet **STOP all** are *actuators*; Guardrails → Autonomy holds *auto-trip thresholds*; Settings → Admin holds the *operator/system override*. One place — Dashboard/Fleet — answers "what is halted right now and by whom."

## Multi-account & scoping model

The make-or-break axis, designed first. A user simultaneously runs, e.g., *Robinhood Live (taxable)*, *Alpaca Paper*, a *Roth IRA*, and a *Test Sim* — each with independent strategy, risk, tax, ledger, but sharing keys, notification prefs, and the preset library.

**Three entities, named and first-class:**

| Entity | Schema anchor | What it is | Blast radius | Lives |
|---|---|---|---|---|
| **Connected Account** | `ConnectedAccount` (`types.ts:280`); bound instance in `account_strategy_state` (`db-profiles.ts`) | A broker link + its one running strategy + guardrails + autonomy + ledger. The scope unit. | This account only | The switcher |
| **Preset** (renamed from "Strategy Profile") | `strategy_profiles` | A reusable, inert, named template of *(policy + prompt + scoringWeights)*. **Not** tax treatment, autonomy, or keys. | Every account it's copied into, **at copy time only** | Strategy (apply/capture) + Settings (manage) |
| **User-global** | `USER_LEVEL_POLICY_FIELDS` (`db-profiles.ts:20`) — **exactly three: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`** | Identity, keys, model defaults, notification channels, data-source toggles, the preset library. | All accounts | Settings |

**The three-tier resolution contract, with provenance:**
```
USER-GLOBAL  →  PRESET (copied in)  →  ACCOUNT OVERRIDE  →  EFFECTIVE (resolved, with "where it came from")
```
Every effective value wears an **origin badge** — but on the **Essentials view only a plain "Changed from preset" text pill** appears on the few differing fields; the four-glyph taxonomy (`● account · ↳ from preset · ⊘ locked by account type · your global default`) and the **"Overrides (N)"** chip live behind the Advanced reveal (novice #8). One-click reset-to-source everywhere.

**The "which account am I configuring right now?" solution** — four reinforcing mechanisms:
1. The switcher is always visible and every account-scoped screen echoes its chip in the header (`Live Strategy — Roth IRA · Alpaca [PAPER]`).
2. Scope is route-encoded (`/a/:accountId/strategy`) as the client seed, and **every mutating write re-validates `accountId` server-side against the session** (P3) — a stale tab *cannot* act on the wrong account regardless of URL prettiness.
3. Account-scoped config lives with the account (Strategy/Guardrails); user-global config lives in Settings — opening a gear never leaves you wondering whose behavior you're editing.
4. Every setting wears a scope tag (`THIS ACCOUNT` / `PRESET` / `ALL ACCOUNTS`) and any save touching N accounts says so *before* it commits.

**Switching behavior.** Switching is **view-scope** — instant, free, reversible, re-scoping all read/config surfaces in place — **once P2's decoupling ships.** *Until then this is not free* (see Edge cases). Execution-scope (arming) is a separate deliberate act. Switching *into* a Live account shows a brief "you are now acting on REAL MONEY" acknowledgment and paints the viewport red.

**Fleet view (All accounts).** The Dashboard becomes a read-and-triage board: one card per account (mode badge, equity + day P&L, autonomy, open-position count, pending-approval count, active preset, last-run, tripped-breaker banner) + aggregate net worth. **No trade can be placed from the roll-up** — you drill in to act. Fleet carries fleet-wide emergency controls (**STOP all / Set all close-only / Pause autonomy**), which **always include every Live account unconditionally, Live shown first, confirmed-halted echoed per-account** (novice #6). *Fleet controls are meaningful only after P2's concurrent-arming model exists* (multiaccount-edge #8).

**Presets: copy-on-bind, never live-link.** Apply **snapshots** values in and stamps `derived_from_profile_id`; from that instant the account is independent. The cockpit shows **"Preset: Momentum-v3 · diverged: 6 fields"** → diff → **"Reset to preset"** (pull) or **"Save these as a new preset"** (push). **At apply time, one plain sentence:** "This copies the settings once. Later changes to the preset won't affect this account, and your changes here won't affect the preset." (novice #9 — no "resync/promote/diverged" jargon in the novice path). Apply is always diff-and-confirm, with an **account-type guard** (block/hard-warn short/margin presets onto IRAs, gated on the `capabilities` snapshot) and **type-to-confirm for Live targets**; never auto-arms a halted account.

**The three colliding verbs, resolved:**
- `activateAccount(id)` → **"switch view"** via the chip. Instant, free, re-scopes reads (post-P2); no execution change.
- The ambient **"mirror into whatever account is active" side effect → deleted from all three call sites** (`:486`, `:512`, `:531` — multiaccount-edge #4). Split into explicit "set as library default" vs "copy into account X."
- `applyProfileToAccount(id, accountId)` → **"Copy preset in."**

### Edge cases resolved

- **Zero connected accounts (first-run / disconnected-only).** *(novice #11, multiaccount-edge #2 — the most common brand-new path, absent from v1.)* The app opens on a guided **"Connect your first account — start with Test (no real money, no broker login)"** flow, defaulting into **Test + Propose-only**. The six destinations render greyed with a single CTA; nothing is scoped until an account exists. A **Test/local-sim pseudo-account is auto-provisioned** so a keyless user is never at zero and their first-ever scope is unambiguously fake and safe. `migrateLegacyStrategyModelFieldsToAccounts`'s `accounts.length === 0` no-op (`db-profiles.ts:266`) is correct for this state and stays.
- **Test/sim account classification.** *(multiaccount-edge #3.)* Test is **not a peer broker row** — it lives in a distinct **"Sandbox"** switcher section. It is **excluded from Fleet emergency controls** (nothing real to halt), **"arm Live" is unreachable from it**, and — critically — it is **excluded from cross-account wash-sale contribution**. Today `tax.ts:113` maps `broker === "test"` to `source: "paper"`, so a *simulated* loss can currently contribute a wash-sale lockout onto a *real* taxable account; the redesign must filter Test out of `getUserWashSaleLockedSymbols` before the "named culprit" UI ships.
- **Preset-vs-account precedence + three-way resync.** *(multiaccount-edge #5, P8.)* Account override beats preset beats user-global. Resync is an explicit **three-way diff** (base snapshot → preset-now vs base snapshot → account-now) with per-field conflict resolution; **any field whose resync loosens a Live-account limit inherits the same per-field confirm as a manual edit — the bulk resync never bypasses one-way-door friction.**
- **Mid-task switch.** *(multiaccount-edge #1 — the sharpest gap.)* Because today's active account is an execution singleton with a not-active→halted coercion (`db-profiles.ts:284/350/397`), flipping the chip *today* can silently demote the account you left running to `halted` on its next policy write. **Therefore mid-task view-switching is only safe after P2 decouples view from execution.** Until that ships, the switcher must either (a) warn that switching may pause the previously-active account, or (b) be gated to read-only comparison — **decoupling is the first blocking migration.**
- **Per-account vs global disputes.** *(coherence A3, multiaccount-edge #6.)* The user-tier set is exactly three fields. `notificationSettings` **stays global** (delivery rules are a user concern). The only genuine question is the two `marketScan*` breadth knobs; default answer is **leave global, relabel "applies to all accounts."** The `USER_LEVEL_POLICY_FIELDS` Set is the **single source of truth**: any scope change is a coordinated migration + Set edit + per-account back-fill **in one PR**, verified by a **round-trip read-after-write test per field** (the failure mode is *silent* — the field writes to the wrong store and reads back as default, the exact enrichment trap CLAUDE.md warns about).

**Cross-account wash-sale — enforced today, surfaced with provenance.** *(coherence A1/A2, multiaccount-edge #7 — v1's Open Q2 was a false question.)* Enforcement already exists and is authoritative: `policy.ts:311` — "cannot be silently bypassed" — via `getUserWashSaleLockedSymbols`. The design work is **surfacing, not verifying**. But the current function returns a **flat `Set<string>` with no provenance** (`tax.ts:99`), so v1's promised "locked by loss in Robinhood·Live, clears Jul 24" is un-buildable as-is. **Required change: the lockout function must return per-symbol provenance (contributing account + earliest clear date)** before the Approvals card can name the culprit; until then it degrades to "locked by a wash-sale in another account." Wash-sale is neither purely account- nor user-scoped — it is a **cross-account tax coupling** (one account's action, all accounts' consequence), so it gets its **own third tax classification**, surfaced identically on the blocked proposal and in Fleet (coherence A2). `washSaleGuard` is therefore **not** a clean per-account toggle and must not be labeled as one.

## Settings taxonomy — definitive tree

Config splits **by scope first**, then ≤6 categories per scope, then a **two-level ladder: Essentials → one Advanced reveal.** A cordoned "Expert" set (env-managed flags) is **search-only access, not a third disclosure level** (coherence C2 — resolving v1's Essentials/Advanced/Expert contradiction). **Governing rule: if a setting changes how a trade is decided or placed, it belongs to the account.**

### Scope A — Account-scope config → lives in Strategy & Guardrails (not a modal)

```
STRATEGY  (account-scoped; header stamped with active account + preset provenance)
  Presets bar: Start from preset… · Capture current as preset… · Copy to accounts…
  ├─ Thesis        prompt / thesis language / holding horizon
  ├─ Signals       8 factor weights (default vs current vs auto-tuned) · min-score · universe/scan/blocklist/floors
  └─ AI Review     Bull model · Red-Team model + conviction threshold · reasoning effort  (overrides global default)

GUARDRAILS  (account-scoped; opens on 5 Essentials, rest behind one Advanced reveal)
  ESSENTIALS  max position size · daily-loss stop · stop-loss on/off · autonomy dial · extended-hours on/off
  ADVANCED
  ├─ Autonomy      Propose ↔ Decide dial · system state · kill-switch thresholds
  ├─ Sizing        max order notional/%NAV/%ADV · daily & hourly caps · proposals-per-run · sell-to-fund-buy
  ├─ Exposure      per-symbol / per-sector / gross / net / beta / correlation caps
  ├─ Risk          stop-loss / take-profit / trailing / trim · ATR-&-beta stops · brackets · short stop (mandatory when shorting)
  ├─ Circuit brk.  max drawdown · max daily loss · vol-panic + VIX/VVIX/SKEW thresholds
  ├─ Execution     order types · extended hours · cadence · marketable-limit + buffer · entry-drift % · staleness gates
  └─ Tax RULES     tax type (taxable/Roth/traditional — account-intrinsic) · wash-sale guard*  · ST/LT rates
                   *cross-account coupling — surfaced identically in Fleet + on blocked proposals
```

### Scope B — User-scope settings → the Settings tree (the only menu, off-rail)

```
SETTINGS  (user-scope · ALL ACCOUNTS · reached from switcher footer / avatar)
  [ 🔍 Search all settings… ]   ← indexes every field label + synonym + section + scope, derived from the
                                   same field definitions that render the controls (never a parallel list)
  ├─ Account & Security     identity · auth providers · sessions · deletion
  ├─ Connections            broker connect/disconnect · environment · confirmed capabilities · per-broker creds
  ├─ Keys & Models          LLM + market-data keys (encrypted, connection-test) · default model / reasoning effort
  ├─ Alert delivery         channels (email/push/SMS/webhook) · event routing · stale-order threshold · test-send
  │                          (delivery rules only — NOT the 🔔 Alerts stream, NOT Alert history)
  ├─ Data & Privacy         web-source toggles (Congress/insider/FINRA/8-K/technicals) + staleness · pool consent · observability · export
  ├─ Presets                library CRUD — rename/delete/version/share  (apply/capture happens in Strategy)
  ├─ Appearance             theme · density · default landing account (NON-LIVE only, per P12)
  └─ Admin (role-gated)     user allowlist · per-user LLM usage/billing · provider/connections health · rag-coverage · transcript · system-wide halt/close-only
```

**Notifications, disambiguated to one noun family (coherence B1, novice #4):** 🔔 **Alerts** (chrome stream) · Settings → **Alert delivery** (rules) · Results → **Alert history** (log). The bare word "Notifications" is retired.

**Preset library, browse-vs-manage boundary (coherence D2):** **Strategy → Presets** = *apply/capture in account context*; **Settings → Presets** = *library CRUD (rename/delete/version/share)*. Two verbs, one predictable rule.

**Admin, fully enumerated (coherence E3):** Settings → Admin consolidates **all four** `/admin/*` targets — connections-health, llm-usage, **rag-coverage, transcript** (the two v1 dropped) — role-gated and conditionally rendered. **MCP/tool config** (referenced in Help) is edited under **Keys & Models → MCP tools**; Help's MCP tab explains it.

**Renames** (keep `SettingsSection` union ids stable as routing keys; map old→new with redirects): `Operate → Guardrails·Execution/Autonomy`, `Safety → Guardrails·Risk`, `Tuning → Results·Tuning`, `Display → Appearance`, `Data → Data & Privacy`, `Strategy Profile → Preset`, `user-tier → all-accounts`, `Review(destination) → Results`. **Stable ids only help sections that STAY in the modal.** Every `openSettings(x)` call site targeting a *relocated* section must be rewritten to navigate to the new destination, not open a gutted modal — there are **6 confirmed sites** (`dashboard-client.tsx:1514, 1555, 1562, 1583, 1709, 1818`, several pointing `openSettings("operate")` at what is now Strategy→Signals / Guardrails). **Merge gate: no `openSettings` points at a relocated section** (migration #5). Update the Help "Settings Glossary" in the same PR.

**Woven through every control (both scopes):** effective value + default + origin badge (Advanced only) + a live plain-English consequence preview ("risks at most **$1,000** — about **2%** of this account's equity"), and a **pre-save impact preview on any live-money change** ("under this rule, N of your last proposals would now be blocked"). Loosening a limit is frictionless; raising a Live cap, disabling a stop, enabling shorting, or flipping to Live/Decide triggers an inline consequence-labeled confirm (typed acknowledgment for the two one-way doors + the first-Live-act-of-session re-consent, P9). Capability-aware disabling greys out what the broker/account-type forbids with an inline explainer.

## Strategy, consolidated

Strategy config collapses from **five surfaces** to **one editable home** (the Strategy destination, account-scoped) + two explicit *explainers* that read state but never edit. **Honest count (coherence D1): 1 editable home + 2 read-only explainers + preset library (applied in Strategy, managed in Settings) — not "5→1."** The header is always stamped **"Live Strategy — <account> [MODE]"** + preset provenance.

| Legacy strategy surface | Fate | Rationale |
|---|---|---|
| **Strategy workspace tab** | **Becomes the Strategy destination** — the one editable home (Thesis / Signals / AI Review + Presets bar). | The single home. |
| **Strategy Studio modal** (prompt + sliders + scoring matrix + Green/Red-team review) | **Deleted as a modal; contents move inline into Strategy, editable in place.** An optional full-screen *mode* preserves the distraction-free feel. | A modal duplicating the tab is pure Frankenstein. The **duplicated TuningCard** — two render sites at `dashboard-client.tsx:3725` and `:4441`, both consuming the same `strategyTuning` state and the same `snapshot.strategyPrompt` — collapses to **one instance.** |
| **Settings → "Strategy" section** (read-only mirror) | **Deleted → one-line pointer** for one release, then removed. | A read-only mirror is a dead-end false affordance and a duplicated label. |
| **Strategy Flow overlay** (`app/ui/strategy-flow.tsx`) | **Kept, reclassified as an "Understand" explainer** — a Flow toggle overlays the live pipeline diagram; reachable from Strategy + Dashboard + palette. Reads state, never edits. | Aids comprehension; it isn't config, so it must not masquerade as an editing surface. |
| **Public `/strategy` marketing page** (gated by `LANDING_PAGE_ENABLED`) | **Kept, renamed `/how-it-works`**, linked once from the editor footer + Help as "How the strategy works ↗". Explicitly **not** in-app IA. | Makes its separate SEO/marketing purpose obvious. |

**The TuningCard merge is the single highest-risk change — with named exit criteria and a rollback (migration #4):**
- **Precondition assertion:** both sites already read `currentPolicy`/`currentPrompt` from the **same** source; verify `snapshot` is identical in both parents before deleting either. Post-merge risk is a patch computed against a stale baseline if the surviving parent reads a different `snapshot` prop than Studio did.
- **Exit criteria (named, not "tested end-to-end"):** an **apply/discard round-trip test** (generate review → apply → assert `strategyTuning` patch diffs against the live prompt, not stale text) + a **localStorage-compat check** on `STRATEGY_TUNING_STORAGE_KEY`.
- **Rollback:** keep the deleted surface behind the same feature flag for one release — a bad merge is a flag flip, not a revert.

**The autonomy dial deliberately does not live here** — it lives in **Guardrails**, next to the breakers that bound it: arming the AI is a containment decision, not a mandate decision.

## Incremental build path

*(New top-level section — closes migration #1/#2/#5/#6/#7/#9 and P12. v1's fatal gap was "a coherent destination with no credible path." This is the normative ordered decomposition; no big-bang cutover.)*

- **P0 — Shell.** Extract the three-zone frame into a route-group `layout.tsx` **rendering the CURRENT tabs unchanged** behind a flag. Decide explicitly which routes are inside it: `/admin`, `/mobile`, `/welcome`, `/login` — **the switcher + STOP must survive on `/admin` (system halt) and on mobile** (migration #6, coherence E1). No content moves yet.
- **P1 — Mapping + persistence shim.** Introduce a `DestinationTab` union that *maps onto* existing `WorkspaceTab`/`FeedTab` values (`decision→dashboard`, `performance+tax→results`, `notifications(feed)→alert-history`, etc.), rendering the *same* panels. **Ship a one-time localStorage migration shim in the SAME PR** (migration #2 — affects 100% of returning users): read old keys (`WORKSPACE_TAB_KEY`, `FEED_TAB_KEY`), map values, write new keys, delete old. Without it every returning user is silently bounced to default (`isWorkspaceTab("tax")` → false).
- **P2 — Decouple view from execution** *(the first blocking safety migration, P2/multiaccount-edge #1).* Split ephemeral view-scope from persisted per-account arming; **remove the not-active→halted coercion** (`:284/350/397`) and the ambient `mirrorPolicyToActiveAccount` from all three call sites (`:486/512/531`). Add the **server-side write-time `accountId` validation** (the real safety boundary). Only after this is the switcher "free."
- **P3 — Single-account-first rollout** *(the de-risking wedge, P11/migration #8).* Ship the entire new IA to **single-account users first**, where scope ambiguity does not exist — static switcher chip, no scope tags/origin badges/Fleet. Gate all multi-account chrome (switcher list, Fleet, route-scope UI) behind the **2nd-account connection.**
- **P4..N — Move one panel's ownership per PR**, keeping old tab ids as **redirect aliases** and rewriting the 6 `openSettings` call sites as their sections relocate. **Per-PR exit criterion: enumerate and update affected tests in the same PR** (migration #9 — ~723 tests; any asserting on tab labels, `openSettings` targets, feed tabs, or the Studio modal will break, and the build gate only catches them if co-sequenced).
- **Deferred milestones (do not block the IA migration):** **Fleet** aggregation (new N-account endpoints + fleet-STOP mutation + audit — meaningful only post-P2, migration #7); **route-encoded `/a/:accountId/` restructure** adopted as option (b) — a thin catch-all `[accountId]` param that seeds and validates active-account state — with the server-side write guard doing the real work, not a multi-week monolith split (migration #3). **Wash-sale provenance return-type change** (Approvals culprit-naming) ships with the Approvals-panel PR.

## Open questions for the owner

*(v1 had 7; Q2 is deleted as factually answered. The survivors are genuine decisions, not disguised facts.)*

1. **`marketScan*` per-account migration.** The user-tier set is exactly three fields; `notificationSettings` stays global. Only `marketScanCandidateLimit` / `marketScanOutlierReserve` are candidates for per-account scoping. Default: **leave global, relabel "applies to all accounts."** Pay the migration+back-fill only if per-account scan breadth is genuinely wanted. Do not ship half-migrated.
2. **Autonomy-resets-on-restart: does it exist in code, or is it net-new?** *(coherence F1.)* P9 asserts autonomy resets to its safe floor on restart. This must be **cited in `account_strategy_state` or costed as a new feature** — it was assumed, not verified, in v1.
3. **Fleet emergency-control scope.** "STOP all / close-only all" always hits every **Live** account (novice #6 — non-negotiable). Open: does it *also* hit Paper, and is a Test STOP meaningful noise? Recommendation: **Live + Paper halt; Test excluded** (nothing real to stop) — confirm.
4. **Route-encoding sequencing.** Adopt option (b) (thin `[accountId]` param + server-side write guard) now, or defer entirely and rely on the write guard alone? The write guard is the safety boundary either way; the URL is ergonomics.
5. **Vocabulary lock-in.** Keeps **"Account,"** renames "Strategy Profile" → **"Preset,"** destination "Review" → **"Results,"** "Notifications" → the **Alerts** family. Rejects net-new nouns "Desk"/"Workspace." Confirm before threading through UI copy, Help glossary, and palette.
6. **Mobile/PWA disposition** *(coherence E1 — v1 dropped it silently).* The three-zone chrome must degrade to phone with the switcher + STOP surviving. Confirm whether `/mobile`'s existing command API (`src/lib/mobile-api.ts`) adopts the same account-scope context, and where `/welcome` onboarding lands in the new frame.
7. **Single-account default resolution rule.** For exactly one account, a stale/one-off account id **auto-resolves to the sole account** rather than failing closed (novice #7). Confirm this is desired (it contradicts the multi-account fail-closed default by design, resolved by account count).

---

**Anchors re-verified against the live tree this session (working tree clean, HEAD `0f6bf0a`):** `USER_LEVEL_POLICY_FIELDS` = 3 fields (`db-profiles.ts:20-24`); ambient mirror at `db-profiles.ts:486, 512, 531`; not-active→halted coercion at `:284, 350, 397`; zero-account no-op at `:266`; wash-sale **enforced** at `policy.ts:311-321`, flat-`Set` return + Test→"paper" mapping at `tax.ts:99/113`; two TuningCard sites sharing `strategyTuning`/`snapshot.strategyPrompt` at `dashboard-client.tsx:3725, 4441`; tab-persistence keys at `:197-199`; 6 `openSettings("operate")` sites at `:1514, 1555, 1562, 1583, 1709, 1818`; `ACCOUNT_SETTINGS_SECTIONS`/`settingsTierForSection` at `:165-168`. Every valid red-team point is fixed inline or explicitly deferred with a stated reason; the one factual error (v1 Open Q2, cross-account wash-sale "maybe") is corrected — it is enforced today.

---

# PART II — Engineering artifacts

These are the actionable, code-anchored views of the design above. An engineer should be able to execute from Part II directly.

## II-A. Annotated wireframes (5 key screens)

# Annotated Wireframes — 5 Key Screens

## Screen 1 — Global App Shell (persistent chrome, every screen)

```
┌─LEFT · SCOPE ANCHOR─────────────┬─CENTER · SPINE (destinations)──────────────┬─RIGHT · VERBS + AMBIENT RISK─────────────────┐
│ ◈ Roth IRA · Alpaca          ▾  │  Dashboard  Approvals  Strategy  Guardrails │ ⟨ used 2k/10k · net 0.4x · Neutral ⟩         │
│   ┌───────────────────────────┐ │  Results          (Scan / more ›)           │                                              │
│   │ PAPER · practice money    │ │                                             │ [ ▶ Run once — Roth IRA · PAPER ]            │
│   │ Propose                   │ │  ── Settings is OFF this rail ──            │ [ ■ STOP ]   🔔  ⌘K  ?  ⦿                     │
│   │ $48,210    ▲ +1.2%        │ │  (footer / ⦿ avatar menor)                  │                                              │
│   └───────────────────────────┘ │                                             │                                              │
└──────────────────────────────────┴─────────────────────────────────────────────┴──────────────────────────────────────────────┘
  (viewport hairline: GREY when practice — turns solid RED the instant a LIVE account is in view)
```

**Annotations**
- **Four-questions-always-answered (LEFT chip):** which account (`Roth IRA · Alpaca`), what money-reality (`PAPER · practice money` — word-class first, grey/blue/red color underneath, never color alone), what authority (`Propose` vs `Decide`), running/halted (`‖ HALTED`/`● close-only`/`⚠ brake` appended when tripped). Resolves the current "which real-money account am I about to act on?" ambiguity that today's persisted-singleton hides.
- **Run-once is stamped with its target** (`▶ Run once — Roth IRA · PAPER`). Fixes novice #1: the button can never silently fire on a Live account the user forgot was selected. The Live rung is armed by a separate ritual, never inherited here.
- **STOP ≠ Flatten.** `■ STOP` halts new activity in one click, always safe, never sells. Selling is a separate secondary "Flatten" action (confirm; type-to-confirm on Live). Resolves the "kill switch welded to a position-liquidator" panic-button hazard.
- **Settings is deliberately off the primary rail** (bottom-left footer / ⦿ avatar). Cue: account-scoped config lives *with* the account (center spine); user-global lives behind the avatar — opening a gear never leaves you wondering whose behavior you're editing.
- **Single-account collapse (P11):** for a one-account user the LEFT chip is static (no `▾`), and scope tags / origin badges / Fleet controls are suppressed until a 2nd account connects.
- **⌘K palette inherits the same money-reality gating** as the chrome Run button (coherence E2) — no Live execution via a palette shortcut without the arm ritual.

---

## Screen 2 — Approvals (primary decision / HITL workspace)

```
┌ Approvals — Roth IRA · Alpaca [ PAPER · practice ]              queue: 4 pending   view: ○ This account ● All accounts ┐
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌── CARD 1 ─────────────────────────────────────────────┐   ┌── evidence rail ─────────────────────────┐              │
│ │ BUY  NVDA  120 sh (~$14,400)      [ acct: Roth·PAPER ] │   │ Bull  → Bear → Red-Team debate            │              │
│ │ thesis: momentum-breakout   confidence 0.72           │   │  "conviction 0.68 > 0.60 threshold ✓"     │              │
│ │                                                       │   │                                           │              │
│ │ POLICY GATE                                           │   │ Entry anchor $141.20  ● drift +0.4% ▁▂▃    │              │
│ │  ✓ size ≤ 15% NAV     ✓ daily notional ok            │   │ Bracket: TP $151 / SL $134  · expires 14:30│              │
│ │  ✓ sector cap         ✓ stop-loss attached          │   └───────────────────────────────────────────┘              │
│ │  ⛔ WASH-SALE LOCKOUT                                  │                                                              │
│ │     locked by a loss in  Robinhood · LIVE            │   [ Approve ▸ PAPER ] [ Adjust & approve ] [ Reject ] [ Snooze]│
│ │     clears Jul 24 · cross-account tax coupling       │        └ MODE badge ON the button ┘   └ re-runs full gate ┘   │
│ └───────────────────────────────────────────────────────┘                                                             │
│ ┌── CARD 2 · Alpaca·PAPER · SELL AAPL … ────────────────┐                                                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Annotations**
- **MODE badge sits ON the Approve button** (`Approve ▸ PAPER` / `Approve ▸ LIVE`). Scope cue that resolves the "I approved without registering this was real money" failure — the money-reality is bound to the exact commit action, not just the header.
- **Wash-sale lockout is named with provenance** (`locked by a loss in Robinhood · LIVE · clears Jul 24`). This is the design's required change: `getUserWashSaleLockedSymbols` today returns a **flat `Set<string>`** (`tax.ts:99` — confirmed) with no provenance, so until the return type carries `{account, clearDate}` this card degrades to "locked by a wash-sale in another account." It is drawn as a **third, cross-account tax-coupling class**, not a per-account toggle — because enforcement is already authoritative (`policy.ts:311`, confirmed "cannot be silently bypassed").
- **Test/sim must be filtered out of the culprit line.** `tax.ts:113` maps `broker === "test" → source: "paper"` (confirmed), so a *simulated* loss can currently contribute a lockout onto a real taxable account. The Approvals culprit-naming ships only after Test is excluded from `getUserWashSaleLockedSymbols`.
- **Adjust-and-approve re-runs the full policy gate** on the edited size (novice #12) — an edited quantity is never a gate-bypass.
- **All-accounts view** tags each row with its account + mode (`acct: Roth·PAPER`); the queue is a single home. Counting the Assistant or Scan as a second approval surface is explicitly avoided (that was the "two approval homes" bug).
- In **Decide** mode this same surface becomes the reviewable ledger of what auto-executed, with identical evidence and a one-tap "drop to Propose."

---

## Screen 3 — Strategy home (consolidated: prompt + weights + AI-review + authority pointer)

```
┌ Strategy — Roth IRA · Alpaca [ PAPER ]     Preset: Momentum-v3 · diverged: 6 fields  [diff] [reset] [save as new] ┐
├────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Presets bar:  [ Start from preset… ]  [ Capture current as preset… ]  [ Copy to accounts… ]                       │
├─ THESIS ───────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   holding horizon:  ( swing 2–10d ▾ )          │
│  │ "Favor liquid large-caps breaking out on volume …"           │                                                │
│  └──────────────────────────────────────────────────────────────┘                                                │
├─ SIGNALS · 8 scoring weights ──────────────────────────────────────────────────────────────────────────────────┤
│   momentum   default 0.20 │ current ▓▓▓▓░ 0.28 │ auto-tuned 0.31   [ let AI tune ☑ ]   ← "Changed from preset"    │
│   value      default 0.15 │ current ▓▓░░░ 0.10 │ —                 [ let AI tune ☐ ]                              │
│   … 6 more …                                                      min-score ( 0.55 )  universe/blocklist/floors › │
├─ AI REVIEW  (overrides global default) ────────────────────────────────────────────────────────────────────────┤
│   Bull model ( gpt-x ▾ )   Red-Team model ( gpt-y ▾ )  conviction ≥ ( 0.60 )   reasoning effort ( high ▾ )        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ⓘ Autonomy (Propose↔Decide) is NOT here — it lives in GUARDRAILS, next to the breakers that bound it.  [ go › ]  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Annotations**
- **One editable home, honestly counted:** 1 editable Strategy destination + 2 read-only explainers (Strategy-Flow overlay, `/how-it-works`) + preset library (applied here, managed in Settings). Not the misleading "5→1." The old **Strategy Studio modal is deleted**, its contents moved inline.
- **The duplicated TuningCard collapses to one instance.** Two render sites confirmed sharing state — `dashboard-client.tsx:3725` and `:4441`, same `strategyTuning`, same `snapshot.strategyPrompt`. Highest-risk merge: exit criteria are an apply/discard round-trip test + a `STRATEGY_TUNING_STORAGE_KEY` localStorage-compat check, behind a flag for one-release rollback.
- **Preset provenance is explicit and copy-not-link** (`Preset: Momentum-v3 · diverged: 6 fields`). Applying a preset *snapshots* values (`derived_from_profile_id`); the account is independent thereafter. Novice path shows a plain "Changed from preset" pill on differing fields — the four-glyph origin taxonomy stays behind Advanced.
- **Authority is deliberately absent here.** The `ⓘ Autonomy … lives in GUARDRAILS` pointer enforces principle 6 (brain ≠ fence): arming the AI is a containment decision, not a mandate edit. Resolves the "aggressive prompt edit silently loosens the leash" hazard.
- **The ambient "mirror into active account" side effect is gone.** `mirrorPolicyToActiveAccount` at all three confirmed call sites (`db-profiles.ts:486, 512, 531`) is removed and split into explicit "set as library default" vs "copy into account X" — so a preset edit can't reach through a side door (principle 7).
- Header stamped with active account + MODE badge + preset provenance — you always know whose brain you are editing.

---

## Screen 4 — Settings home (account-scope vs user-scope split, explicit)

```
┌ Settings — user-scope · ALL ACCOUNTS      (reached from switcher footer / ⦿ avatar — NOT the primary rail)         ┐
├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ 🔍 Search all settings…  (indexes every field label + synonym + section + scope) ]                                 │
│                                                                                                                      │
│  ╔══ SCOPE B · USER-GLOBAL (this menu) ══════════╗    ╔══ SCOPE A · ACCOUNT-SCOPED (NOT here) ═══════════════════╗   │
│  ║  Account & Security   identity·auth·sessions   ║    ║  These live WITH the account, on the primary rail:        ║   │
│  ║  Connections          brokers·env·capabilities ║    ║                                                           ║   │
│  ║  Keys & Models        LLM/data keys · MCP tools ║    ║   → STRATEGY   thesis · signals · AI-review · presets     ║   │
│  ║  Alert delivery       channels·routing·test-send║    ║   → GUARDRAILS sizing · risk · breakers · autonomy · tax  ║   │
│  ║  Data & Privacy       web-sources·consent·export║    ║                                                           ║   │
│  ║  Presets              library CRUD (rename/ver) ║    ║  Governing rule: if a setting changes HOW A TRADE IS      ║   │
│  ║  Appearance           theme·density·landing acct║    ║  DECIDED OR PLACED, it belongs to the ACCOUNT.            ║   │
│  ║  Admin (role-gated)   allowlist·usage·health·   ║    ║  [ open Strategy › ]        [ open Guardrails › ]         ║   │
│  ║                       rag·transcript·system-halt║    ╚═══════════════════════════════════════════════════════════╝   │
│  ╚═════════════════════════════════════════════════╝                                                                │
│  Woven per control:  effective value · default · origin badge (Advanced only) · plain-English consequence preview    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Annotations**
- **Split by scope FIRST** is the load-bearing cue. Left column = user-global (all accounts); right column is a *sign-post*, not editable here — it points to Strategy/Guardrails. Resolves today's fatal ambiguity where a "Strategy" mirror lived in Settings, duplicating labels and hiding scope.
- **`USER_LEVEL_POLICY_FIELDS` = exactly 3** (confirmed `db-profiles.ts:20-24`: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`). This Set is the single source of truth for what may sit in Scope B. Any scope change is a coordinated migration + Set edit + per-account back-fill in one PR, gated by a round-trip read-after-write test per field (the silent enrichment-trap CLAUDE.md warns about).
- **Governing rule printed on the divider** ("if it changes how a trade is decided/placed → account"). This is the one sentence a user needs to predict where any setting lives.
- **Notifications disambiguated to one noun family:** 🔔 Alerts (chrome stream) · Settings → **Alert delivery** (rules only — labeled so it's not confused with the stream or the history) · Results → Alert history (log).
- **Appearance → default landing account is NON-LIVE only** (P12 earlier-wins note). Principle 3 (scope never silently inherited, fails to neutral) kills a Live account as an auto-landing target; this is the one place two principles collided and P3 won.
- **Admin fully enumerated** (all four `/admin/*`: connections-health, llm-usage, rag-coverage, transcript, plus system-wide halt) so no admin surface is orphaned. MCP tool config lives under Keys & Models.
- **6 confirmed `openSettings("operate")` sites** (`dashboard-client.tsx:1514, 1555, 1562, 1583, 1709, 1818`) that point at relocated sections must be rewritten to *navigate to the new destination*, not open a gutted modal — a merge gate enforces "no `openSettings` points at a relocated section."

---

## Screen 5 — Account switcher / accounts manager (presets + mode indicator)

```
┌ ◈ Roth IRA · Alpaca [ PAPER · practice ] ▾  ← click chip ──────────────────────────────────────────┐
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│ │  ▸ All accounts (Fleet)            aggregate net worth $312,540                                 │  │
│ ├─ LIVE — REAL MONEY  (grouped & separated first) ───────────────────────────────────────────────┤  │
│ │  ● Robinhood · Individual   [ LIVE·real ]  Decide   ♥ ok   ▲ +0.8%   ⚑ 2 pending   Momentum-v3 │  │
│ ├─ PAPER — practice money ───────────────────────────────────────────────────────────────────────┤  │
│ │  ◉ Roth IRA · Alpaca        [ PAPER ]      Propose  ♥ ok   ▲ +1.2%   ⚑ 0       Momentum-v3      │  │
│ │  ○ Alpaca · Taxable         [ PAPER ]      Propose  ♥ ok   ▬ 0.0%    ⚑ 1       Value-v2         │  │
│ ├─ SANDBOX — Test / local sim  (distinct section — NOT a peer broker row) ───────────────────────┤  │
│ │  ▨ Test Sim                 [ TEST ]       Propose  (fake & safe · excluded from Fleet/wash-sale)│  │
│ ├────────────────────────────────────────────────────────────────────────────────────────────────┤  │
│ │  + Connect account          Preferences… / Settings                                            │  │
│ └──────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
  Switching INTO a Live row → brief "you are now acting on REAL MONEY" ack + viewport paints RED.
```

**Annotations**
- **Three-way mode indicator, word-class first** (`LIVE·real money` red / `PAPER·practice` blue / `TEST` grey) per row and on the chip. Never teaches "paper = fake" with blue color alone (novice #2).
- **Live accounts grouped and separated FIRST; Sandbox is its own section** (multiaccount-edge #3) — Test is not a peer broker row. Sandbox is explicitly **excluded from Fleet emergency controls, from "arm Live," and from cross-account wash-sale contribution**. This is the UI counterpart to the required `tax.ts` fix (Test currently leaks in via the `broker==="test" → "paper"` mapping).
- **Each row is a portfolio-of-accounts summary:** badge · autonomy · health dot · day P&L · pending-approval count · active preset. Presets are shown as provenance (`Momentum-v3`), reinforcing copy-not-link.
- **Switching is view-scope — but NOT free until P2 ships.** Today `getActiveConnectedAccount` is a persisted singleton and any non-active account is coerced `→ halted` on the next policy write at **three confirmed points** (`db-profiles.ts:284, 350, 397`). So flipping the chip today can silently demote the account you left running. Until P2 decouples view-scope from execution-scope, the switcher must warn ("switching may pause the previously-active account") or be gated to read-only comparison. **This decoupling is the first blocking migration**, drawn here as a constraint, not a footnote.
- **Fleet controls are Live-inclusive and confirm-per-account** (`STOP all / Set all close-only`) — always hit every Live account unconditionally, Live shown first, halt echoed per account (novice #6). Meaningful only after P2's concurrent-arming model exists.
- **Single-account user:** this whole dropdown collapses to the static chip (P11); a stale/one-off account id **auto-resolves to the sole account** rather than failing closed (novice #7). Multi-account users keep the multi-account fail-closed default — resolved by account count.
- **Apply-preset guardrails:** diff-and-confirm, account-type guard (block/hard-warn short/margin presets onto IRAs against the `capabilities` snapshot), type-to-confirm for Live targets, never auto-arms a halted account.

Relevant source anchors verified this session: `/home/user/agentic-trading/src/lib/db-profiles.ts:20-24` (3 user fields), `/home/user/agentic-trading/src/lib/policy.ts:311` (wash-sale enforced), `/home/user/agentic-trading/src/lib/tax.ts:99` (flat Set, no provenance) and `:113` (`test→paper` leak).

## II-B. Settings taxonomy — field-level tree (every control, scope-tagged)

*This maps every one of the current 9 settings sections' individual controls into the new scope-first tree, so nothing is lost. `[ACCOUNT]` = per connected account; `[USER]` = user-global (all accounts); `[CROSS-ACCOUNT COUPLING]` = the special wash-sale case.*

```
NEW SETTINGS TAXONOMY (scope-first)
===================================

SCOPE A — ACCOUNT-SCOPE CONFIG  (lives in Strategy & Guardrails destinations, NOT a modal)
==========================================================================================

STRATEGY  (destination; header stamped with active account + preset provenance)
│  Presets bar: Start from preset… · Capture current as preset… · Copy to accounts…   [ACCOUNT action]
│
├─ Thesis
│   ├─ Strategy prompt (policy.strategyPrompt)                                          [ACCOUNT]
│   ├─ Thesis language                                                                  [ACCOUNT]
│   └─ Holding horizon (holdingHorizon: intraday|swing|position|longterm)               [ACCOUNT]
│
├─ Signals
│   ├─ 8 scoring weights (liquidity|momentum|value|quality|volatility|
│   │     sentiment|positioning|diversification) — default vs current vs auto-tuned,
│   │     each with "let the AI tune this" toggle                                       [ACCOUNT]
│   ├─ Min proposal score threshold (tuning.minProposalScoreThreshold)                  [ACCOUNT]
│   ├─ Base indexes / universe (includedIndices)                                        [ACCOUNT]
│   ├─ Additional watchlist (additionalSymbols)                                         [ACCOUNT]
│   ├─ Ignore list / blocklist (blocklist)                                              [ACCOUNT]
│   └─ Universe floors: min share price · min market cap · min $-volume (universeFloor) [ACCOUNT]
│
└─ AI Review  (overrides global default)
    ├─ Green/Bull model (policy.llmModel)                                               [ACCOUNT]
    ├─ Red-Team model (policy.redTeamLlmModel)                                          [ACCOUNT]
    ├─ Red-Team conviction threshold (tuning.redTeamConvictionThreshold)                [ACCOUNT]
    └─ Reasoning effort (policy.llmReasoningEffort)                                      [ACCOUNT]

GUARDRAILS  (destination; opens on 5 Essentials, rest behind one Advanced reveal)
│
├─ ESSENTIALS
│   ├─ Max position size (maxOrderNotional / % NAV mirror)                              [ACCOUNT]
│   ├─ Daily-loss stop (riskRules.maxDailyLossNotional)                                 [ACCOUNT]
│   ├─ Stop-loss on/off (riskRules.stopLossPct present)                                 [ACCOUNT]
│   ├─ Autonomy dial (strategyAuthority: propose|decide)                                [ACCOUNT]
│   └─ Extended-hours on/off (permitExtendedHours)                                      [ACCOUNT]
│
└─ ADVANCED
    ├─ Autonomy
    │   ├─ Propose ↔ Decide dial (strategyAuthority)                                    [ACCOUNT]
    │   ├─ System state (systemState: active|halted|close_only|liquidating)             [ACCOUNT]
    │   └─ Kill-switch / auto-trip thresholds (see Circuit brk.)                        [ACCOUNT]
    │
    ├─ Sizing
    │   ├─ Max order notional (maxOrderNotional)                                        [ACCOUNT]
    │   ├─ Max order % NAV                                                              [ACCOUNT]
    │   ├─ Max order % of ADV (maxOrderPctOfAdv)                                        [ACCOUNT]
    │   ├─ Daily cap (daily notional/orders)                                            [ACCOUNT]
    │   ├─ Max daily orders                                                             [ACCOUNT]
    │   ├─ Max hourly notional                                                          [ACCOUNT]
    │   ├─ Max proposals per run                                                        [ACCOUNT]
    │   └─ Sell-to-fund-buys (off|suggest|propose|automated)                            [ACCOUNT]
    │
    ├─ Exposure
    │   ├─ Per-symbol cap (symbol cap %)                                                [ACCOUNT]
    │   ├─ Per-sector caps (sector caps map)                                            [ACCOUNT]
    │   ├─ Max gross exposure % (maxGrossExposurePct)                                   [ACCOUNT]
    │   ├─ Max net exposure % (maxNetExposurePct)                                       [ACCOUNT]
    │   ├─ Max portfolio beta                                                           [ACCOUNT]
    │   └─ Max avg correlation                                                          [ACCOUNT]
    │
    ├─ Risk (stops & exits)
    │   ├─ Stop-loss % (riskRules.stopLossPct)                                          [ACCOUNT]
    │   ├─ Take-profit trim % (riskRules.takeProfitTrimPct)                             [ACCOUNT]
    │   ├─ Trailing stop % (riskRules.trailingStopPct)                                  [ACCOUNT]
    │   ├─ ATR stops toggle + ATR period + ATR multiple (atrStops, atrStopPeriod,
    │   │     atrStopMultiple)                                                          [ACCOUNT]
    │   ├─ Beta-scaled stops (betaScaledStops)                                          [ACCOUNT]
    │   ├─ Broker-held brackets / Robinhood broker stop (robinhoodBrokerStops)          [ACCOUNT]
    │   ├─ Short stop-loss % (riskRules.shortStopLossPct — mandatory when shorting)     [ACCOUNT]
    │   ├─ Enable short selling                                                         [ACCOUNT]
    │   ├─ Max short order $ (maxShortOrderNotional)                                    [ACCOUNT]
    │   └─ Max short exposure % (maxShortExposurePct)                                   [ACCOUNT]
    │
    ├─ Circuit breakers  (each card doubles as live armed/tripped status)
    │   ├─ Max drawdown % (riskRules.maxDrawdownPct)                                    [ACCOUNT]
    │   ├─ Max daily loss $ (riskRules.maxDailyLossNotional)                            [ACCOUNT]
    │   ├─ Vol-panic brake enabled (volPanicBrakeEnabled)                               [ACCOUNT]
    │   ├─ VIX threshold (volPanicVixThreshold)                                         [ACCOUNT]
    │   ├─ VVIX threshold (volPanicVvixThreshold)                                       [ACCOUNT]
    │   ├─ SKEW threshold (volPanicSkewThreshold)                                       [ACCOUNT]
    │   └─ Crisis open cap % NAV (tuning.crisisMaxOpeningExposurePct)                   [ACCOUNT]
    │
    ├─ Execution
    │   ├─ Permitted order types (permittedOrderTypes)                                  [ACCOUNT]
    │   ├─ Allow extended-hours orders (permitExtendedHours)                            [ACCOUNT]
    │   ├─ Run during extended hours                                                    [ACCOUNT]
    │   ├─ Fire synthetic stops in extended hours (allowExtendedHoursSyntheticStops)    [ACCOUNT]
    │   ├─ Cadence / run frequency (min)                                                [ACCOUNT]
    │   ├─ Marketable-limit entries + buffer (marketableLimitEntries)                   [ACCOUNT]
    │   ├─ Max entry drift % (maxEntryDrift)                                            [ACCOUNT]
    │   ├─ Stale limit-order alert (min) (staleLimitOrderMinutes)                       [ACCOUNT]
    │   └─ Staleness gates: max quote age · max fundamentals age                        [ACCOUNT]
    │
    ├─ Learning / Tuning params  (formerly the "Tuning" section)
    │   ├─ Shrinkage prior (tuning.shrinkPrior)                                         [ACCOUNT]
    │   ├─ Min closed lots for weight shift (tuning.minClosedLotsForWeightShift)        [ACCOUNT]
    │   ├─ Sizing floor % (tuning.sizingFloorPct)                                       [ACCOUNT]
    │   ├─ Sizing ceiling % (tuning.sizingCeilingPct)                                   [ACCOUNT]
    │   ├─ FCF-yield veto floor % (tuning.bearVetoFcfYieldFloorPct)                     [ACCOUNT]
    │   ├─ Debt/equity veto ceiling (tuning.bearVetoDebtToEquityCeiling)               [ACCOUNT]
    │   └─ Skip negative-expectancy gate + threshold % (tuning.skipNegativeExpectancy,
    │         tuning.skipNegativeExpectancyEdgePct)                                     [ACCOUNT]
    │
    └─ Tax RULES  (decision-time; distinct from Results→Tax outcomes)
        ├─ Tax treatment (taxSettings.taxationType: taxable|roth_ira|traditional_ira —
        │     account-intrinsic)                                                        [ACCOUNT]
        ├─ Wash-sale guard (taxSettings.washSaleGuard)                    [CROSS-ACCOUNT COUPLING]*
        ├─ Short-term rate % (taxSettings.shortTermRatePct)                             [ACCOUNT]
        ├─ Long-term rate % (taxSettings.longTermRatePct)                               [ACCOUNT]
        └─ Subtract estimated tax from results (taxSettings.subtractFromResults)        [ACCOUNT]
        *not a clean per-account toggle: one account's loss locks symbols on all
         accounts; surfaced identically in Fleet + on blocked proposals.


SCOPE B — USER-SCOPE SETTINGS  (the Settings tree; off-rail, reached from switcher footer / avatar)
==================================================================================================

SETTINGS  (ALL ACCOUNTS)
│  [ 🔍 Search all settings… ]   (indexes every field label + synonym + section + scope)
│
├─ Account & Security
│   ├─ Identity / profile                                                              [USER]
│   ├─ Auth providers                                                                   [USER]
│   ├─ Sessions                                                                         [USER]
│   └─ Account deletion (delete-account panel)                                          [USER]
│
├─ Connections
│   ├─ Broker connect / disconnect (link/unlink, labels)                                [USER]
│   ├─ Environment (Test/Paper/Live per broker link)                                    [USER]
│   ├─ Confirmed broker capabilities (readonly)                                         [USER]
│   └─ Per-broker credentials                                                           [USER]
│
├─ Keys & Models
│   ├─ LLM provider keys (encrypted, connection-test)                                   [USER]
│   ├─ Market-data provider keys (encrypted, connection-test)                           [USER]
│   ├─ Default model / reasoning effort (global default, overridden per-account)        [USER]
│   └─ MCP tools config                                                                 [USER]
│
├─ Alert delivery   (delivery RULES only — NOT the 🔔 stream, NOT Alert history)
│   ├─ Channels (email / push / SMS / webhook) (notificationSettings.webhookUrl + chans)[USER]
│   ├─ Event routing / enabled events (notificationSettings.enabledEvents: fill, block,
│   │     run_failed, pending_approval, kill_switch, limit_order_stale,
│   │     provider_degraded, price_alert, proposal_withdrawn)                           [USER]
│   ├─ Stale-order threshold (delivery)                                                 [USER]
│   └─ Test-send                                                                        [USER]
│
├─ Data & Privacy
│   ├─ Web-source toggles (Congress / insider / FINRA / 8-K / technicals) + staleness   [USER]
│   ├─ Market Scan candidate cap (marketScanCandidateLimit)              [USER — relabel "all accounts"]†
│   ├─ Market Scan outlier reserve (marketScanOutlierReserve)            [USER — relabel "all accounts"]†
│   ├─ Shared data-pool consent (poolConsent)                                           [USER]
│   ├─ Include shared learnings (lcSharing.includeShared)                               [USER]
│   ├─ Contribute my learnings (lcSharing.contributeShared)                             [USER]
│   ├─ Observability                                                                    [USER]
│   └─ Data export                                                                      [USER]
│
├─ Presets   (library CRUD — apply/capture happens in Strategy)
│   ├─ Rename / delete                                                                  [USER]
│   ├─ Version                                                                          [USER]
│   └─ Share                                                                            [USER]
│
├─ Appearance
│   ├─ Theme                                                                            [USER]
│   ├─ Density                                                                          [USER]
│   ├─ Account-mode banner size (executionBannerMode: full|compact|hidden)              [USER]
│   ├─ Ticker logo display (tickerLogoDisplay: tile|transparent|off)                    [USER]
│   └─ Default landing account (NON-LIVE accounts only, per P12)                        [USER]
│
└─ Admin  (role-gated)
    ├─ User allowlist                                                                   [USER]
    ├─ Per-user LLM usage / billing                                                     [USER]
    ├─ Provider / connections health (/admin/connections-health)                        [USER]
    ├─ RAG coverage (/admin/rag-coverage)                                               [USER]
    ├─ Transcript (/admin/transcript)                                                   [USER]
    └─ System-wide halt / close-only (operator override)                               [USER]

† These two are the ONLY genuinely-debatable scope fields; kept [USER] by default
  (Open Q1). Per-account is opt-in, migration-gated.
```

NOTES

1. Full legacy coverage (9 sections → new tree): **Strategy** → Strategy·Thesis/Signals/AI Review (prompt, scoring weights, models, reasoning effort — previously only in the Studio modal — now live editable here). **Operate** → split: universe/watchlist/blocklist/horizon → Strategy·Signals+Thesis; execution-mode banner → Appearance; approval mode + system state → Guardrails·Autonomy. **Safety** → Guardrails·Sizing/Exposure/Risk/Circuit breakers/Execution. **Tax** → split: decision-time rules → Guardrails·Tax RULES; realized outcomes/lots/harvest → Results·Tax (destination, not settings). **Tuning** → Guardrails·Learning params, with the AI-proposed-change review queue moving to Results·Tuning. **Connections** → Connections (+ keys split to Keys & Models). **Display** → Appearance. **Notifications** → Alert delivery (rules), with the live stream = 🔔 Alerts (chrome) and the log = Results·Alert history. **Data** → Data & Privacy. Nothing dropped.

2. Scope CHANGES vs today (and why): none of the 9 sections' fields flip account↔user tier. `USER_LEVEL_POLICY_FIELDS` stays exactly 3 (`notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve` — confirmed at `db-profiles.ts:20-24`). The two `marketScan*` knobs are flagged as the only migration candidates but recommended to STAY [USER] (relabeled "applies to all accounts"), so no code-side scope change ships by default.

3. New THIRD classification introduced: **wash-sale guard** is neither purely [ACCOUNT] nor [USER] — it is a cross-account tax coupling (`policy.ts:311` enforcement is authoritative and un-bypassable; one account's loss locks symbols on every account). It sits physically in an account's Guardrails·Tax RULES but is tagged as coupling and surfaced identically in Fleet and on blocked proposals. It must NOT be labeled a clean per-account toggle.

4. Fields that MOVE surface but NOT scope (the Frankenstein fix): all of the Strategy-workspace "Key Parameters" controls (max order, daily/hourly caps, symbol/sector/beta/correlation caps, stops, take-profit, cadence, max proposals, entry drift, staleness, sell-to-fund, extended hours, short selling, broker brackets, beta-scaled stops) were already account-scoped but scattered outside the Settings modal — they now consolidate into Guardrails. Scoring weights + prompt + models move from the Studio modal into Strategy. All stay [ACCOUNT].

5. Test/sim exclusion (scope caveat): Test accounts are [ACCOUNT]-scoped like any account but are excluded from wash-sale contribution — `tax.ts:113` currently maps `broker === "test"` → `source: "paper"`, which must be filtered out of `getUserWashSaleLockedSymbols` so a simulated loss never locks a real taxable account. This is a scope-correctness fix, not a tier change.

## II-C. Migration mapping — every current surface → its new home

*Covers all 7 workspace tabs, 4 feed tabs, 9 settings sections, Strategy Studio, Strategy Flow, the `/strategy` explainer, the Help modal's 6 sub-sections, command palette, profile menu, all four `/admin/*` routes, `/mobile`, `/welcome`, and `/login`. Nothing is dropped silently.*

# Migration Mapping — Current IA → Final Design

| Current surface | New home | Action | User-visible change | Notes |
|---|---|---|---|---|
| **Workspace tab: Decision** | **Dashboard** (destination #1) + **Approvals** (destination #2) | move / merge | The Decision tab splits: at-a-glance account state → Dashboard; the HITL proposal queue → Approvals. Two clearer verbs replace one overloaded tab. | `decision→dashboard` mapping is the canonical example in the P1 persistence shim; queue extraction is where the wash-sale-provenance culprit-naming lands (deferred to the Approvals-panel PR). Old id kept as redirect alias. |
| **Workspace tab: Assistant** | **Assistant slide-over** (persistent overlay, ⌘K + rail button) | move / rename | Assistant stops being a tab you navigate *to* and becomes a scope-aware panel you open *over* any destination without losing place. | Deliberately *not* a peer tab — counting it as one recreates the "two approval homes" bug. Routes trades → Approvals, config changes → confirmable diff. |
| **Workspace tab: Market Scan** | **Scan** (destination #3, read-only secondary) | move / rename | Becomes a read-only research destination one level down (Dashboard drill-down + rail "more"), not a co-equal primary verb. Never edits config, never trades. | "Six primary verbs + one read-only research surface" is the honest count (coherence D3). Label shortens "Market Scan" → "Scan." |
| **Workspace tab: Macro** | **Dashboard** (macro/regime strip) | merge | No longer a standalone tab; folds into the Dashboard's macro/regime strip and the ambient risk strip's "current regime." | Regime is ambient context a supervisor always needs, not a destination. |
| **Workspace tab: Performance** | **Results** (destination #6) | move / rename / merge | Performance merges with Tax outcomes into one "how did this account do" destination named **Results**. | `performance+tax→results` mapping in P1 shim. "Review→Results" rename frees "review" as an action verb (coherence G1). |
| **Workspace tab: Tax** | **Results** (tax **outcomes**) + **Guardrails → Tax RULES** (tax **rules**) | move / merge / rename | The single "Tax" tab splits by intent: lots / holding-period ladder / harvest candidates / net-of-tax → Results; tax type / wash-sale / ST-LT rates → Guardrails. Duplicate "Tax" label retired. | Resolves the outcomes-vs-rules overload. `isWorkspaceTab("tax")→false` under the new union is exactly why the P1 localStorage shim is mandatory (migration #2). |
| **Workspace tab: Strategy** | **Strategy** (destination #4) | keep / rename | Becomes the one editable Strategy home (Thesis / Signals / AI Review + Presets bar), account-scoped, header-stamped with account + MODE + preset provenance. | The consolidation anchor: 5 scattered strategy surfaces collapse to 1 editable home + 2 read-only explainers + preset library. |
| **Feed tab: Activity** | **Dashboard** (agent state / next-run) + **Results → History** (chronological activity) | move / merge | The separate feed rail disappears; recent activity surfaces on Dashboard, full chronology lives under Results → History. | The 4-tab feed rail is dissolved entirely; its four contents redistribute. |
| **Feed tab: Runs** | **Dashboard** (next-run countdown / last-run) + **Results → History** | move / merge | Run status shows on Dashboard; run history joins the canonical History log under Results. | Fleet view shows per-account last-run. |
| **Feed tab: Notifications** | **🔔 Alerts** (chrome stream) + **Results → Alert history** (log) | move / rename | The feed's alert list splits into a live chrome dropdown (🔔 Alerts) and a persistent log (Results → Alert history). The bare noun "Notifications" is retired across the app. | `notifications(feed)→alert-history` mapping in P1 shim. Disambiguates the duplicated "Notifications" label (coherence B1, novice #4). |
| **Feed tab: Audit Log** | **Results → History** (single canonical home) | move / merge | Audit becomes one canonical home under Results → History; Dashboard/Approvals/Settings entry points become deep-links *into* it, not parallel homes. | Kills the "parallel audit homes" ambiguity (coherence B2). |
| **Settings → Strategy** (account-tier, read-only mirror) | **Strategy** destination | remove (via one-release pointer) | For one release becomes a one-line pointer to the Strategy destination, then removed. | A read-only mirror is a dead-end false affordance + duplicated label. `SettingsSection` id stays only as a routing/redirect key, not a live section. |
| **Settings → Operate** (account-tier) | **Guardrails → Execution / Autonomy** (+ **Strategy → Signals** for universe/scan bits) | move / rename / merge | "Operate" (vague) is dissolved: order types / extended hours / cadence / entry-drift → Guardrails·Execution; Propose↔Decide + system state → Guardrails·Autonomy; universe/scan knobs → Strategy·Signals. | **All 6 `openSettings("operate")` sites** (`dashboard-client.tsx:1514, 1555, 1562, 1583, 1709, 1818`) must be rewritten to navigate to the new destination, not open a gutted modal. Merge gate: no `openSettings` points at a relocated section (migration #5). |
| **Settings → Safety (risk)** (account-tier) | **Guardrails → Risk** (+ Essentials layer) | move / rename | Renamed to Guardrails·Risk; the 5 most-used controls surface in the Guardrails Essentials layer, the rest fold behind one Advanced reveal. | `Safety→Guardrails·Risk` rename. Opens on Essentials (coherence C1, novice #10). |
| **Settings → Tax** (account-tier) | **Guardrails → Tax RULES** | move / rename | Tax *rules* (tax type, wash-sale guard, ST/LT rates) live under Guardrails; distinct from Results' tax *outcomes*. | `washSaleGuard` is NOT a clean per-account toggle — it's a cross-account tax coupling, surfaced identically in Fleet + on blocked proposals (coherence A2). Must not be labeled a simple per-account switch. |
| **Settings → Tuning** (account-tier) | **Results → Tuning** (queue) | move / rename | The AI-proposed-changes surface becomes the Tuning queue under Results, reviewed like a code review. | `Tuning→Results·Tuning` rename. |
| **Settings → Connections** (user-tier) | **Settings → Connections** | keep | Stays user-global in the Settings tree; adds environment + confirmed capabilities + per-broker creds framing. | User-global; off the primary rail. Also consolidates `/admin/connections` health (see below). |
| **Settings → Display** (user-tier) | **Settings → Appearance** | rename | Renamed Appearance; gains "default landing account" (**NON-LIVE only**, per P12). | `Display→Appearance` rename. A Live account is never auto-selected on load (P3 wins over the landing-account convenience). |
| **Settings → Notifications** (user-tier) | **Settings → Alert delivery** | rename | Renamed "Alert delivery" — channels / routing / stale-order threshold / test-send only. Explicitly NOT the 🔔 stream and NOT Alert history. | Part of the Alerts noun-family disambiguation (coherence B1). `notificationSettings` **stays user-global** (one of the 3 `USER_LEVEL_POLICY_FIELDS`). |
| **Settings → Data** (user-tier) | **Settings → Data & Privacy** | rename | Renamed; web-source toggles + staleness + pool consent + observability + export. | `Data→Data & Privacy` rename. Houses `marketScanCandidateLimit`/`marketScanOutlierReserve` (the other 2 user-tier fields), relabeled "applies to all accounts" pending Open Q1. |
| **(new) Settings → Keys & Models** | **Settings → Keys & Models** | new (extracted) | LLM + market-data keys, default model / reasoning effort, and **MCP tools** config get an explicit home (previously scattered/implicit). | MCP tool config referenced in Help now edited here; Help's MCP tab explains it (coherence E3). |
| **(new) Settings → Presets** | **Settings → Presets** (library CRUD) | new (extracted) | Library management (rename/delete/version/share) gets a dedicated section; *apply/capture* stays in Strategy. | Browse-vs-manage boundary (coherence D2): Strategy = apply/capture, Settings = CRUD. |
| **(new) Settings → Account & Security** | **Settings → Account & Security** | new (extracted) | Identity / auth providers / sessions / deletion get an explicit section. | User-global identity, formerly implicit. |
| **Strategy Studio modal** (prompt + sliders + scoring matrix + Green/Red-team review) | **Strategy** destination (inline) | remove / merge | Modal deleted; its contents move inline into Strategy, editable in place, with an optional full-screen *mode* preserving the distraction-free feel. | Single **highest-risk change**: the **duplicated TuningCard** at `dashboard-client.tsx:3725` and `:4441` (both consuming `strategyTuning` + `snapshot.strategyPrompt`) **collapses to one instance**. Named exit criteria: apply/discard round-trip test + `STRATEGY_TUNING_STORAGE_KEY` localStorage-compat check. Rollback = flag flip (migration #4). |
| **Strategy Flow overlay** (`app/ui/strategy-flow.tsx`) | **"Understand" explainer** (Flow toggle) | keep / rename | Reclassified as a read-only comprehension overlay of the live pipeline; reachable from Strategy + Dashboard + palette. Reads state, never edits. | Kept as-is functionally; must not masquerade as an editing surface. |
| **Public `/strategy` marketing page** (gated by `LANDING_PAGE_ENABLED`) | **`/how-it-works`** | rename | Route renamed; linked once from the editor footer + Help as "How the strategy works ↗". Explicitly **not** in-app IA. | Makes its separate SEO/marketing purpose obvious; keep old path as redirect. |
| **Help modal — Overview** | **? Help → Overview** | keep | Contextual Help panel retained; Overview stays. | Help panel updated in lockstep with every rename in the same PR. |
| **Help modal — Guardrails** | **? Help → Guardrails** | keep | Retained; now matches the Guardrails destination name (previously "Safety/Operate" mismatch). | Alignment with new destination naming. |
| **Help modal — Settings Glossary** | **? Help → Settings Glossary** | keep / update | Retained but rewritten to the new taxonomy (renamed sections, relocated targets). | **Must be updated in the same PR** as the `openSettings` rewrites (merge requirement). |
| **Help modal — Tax** | **? Help → Tax** | keep | Retained; explains the outcomes-vs-rules split (Results vs Guardrails). | Resolves the third duplicated "Tax" label (was tab + settings + help). |
| **Help modal — Data Sources** | **? Help → Data Sources** | keep | Retained; points at Settings → Data & Privacy. | Renamed target section referenced. |
| **Help modal — MCP** | **? Help → MCP** | keep / update | Retained; now explains that MCP/tool config is edited under **Keys & Models → MCP tools**. | Closes the "MCP referenced but had no config home" gap (coherence E3). |
| **Command palette** | **⌘K Command palette** (global chrome) | keep / rename | Retained as a jump layer; entries remapped to new destinations + sub-sections + "open Settings section X" + deep-links into any config field. **Palette "run once" inherits the exact money-reality gating of the chrome button — no Live execution without the arm ritual.** | Tab-jump commands (`tab-decision`…`tab-strategy` at `:1576–1581`) rewritten to new destination ids. Coherence E2. |
| **Profile menu** (top-right, 8 items) | **⦿ Avatar / Preferences** (global chrome, right zone) | keep / rename / merge | Becomes the identity menu owning the Settings entry and account management; **distinct from the account switcher** (which owns scope, not identity). | Splits the conflated "profile = both identity and account picking" — switcher owns scope, avatar owns identity. |
| **`/admin/connections`** | **Settings → Admin** (connections health) | move / merge | Folds into the role-gated Settings → Admin section (provider/connections health). | Admin fully enumerated (coherence E3): all four `/admin/*` consolidate. Role-gated, conditionally rendered. |
| **`/admin/llm-usage`** | **Settings → Admin** (per-user LLM usage/billing) | move / merge | Folds into Settings → Admin. | Same. |
| **`/admin/rag-coverage`** | **Settings → Admin** (rag-coverage) | move / merge | Folds into Settings → Admin (one of the two v1 dropped and this design restores). | Same. |
| **`/admin/transcript`** | **Settings → Admin** (transcript) | move / merge | Folds into Settings → Admin (the other v1-dropped target, restored). | Same. |
| **`/mobile` PWA** | **`/mobile`** (adopts three-zone chrome, degraded) | keep / defer details | Chrome degrades to phone with **the switcher + STOP surviving**; command API adopts the same account-scope context. | Inside the P0 route-group decision; exact adoption + whether `mobile-api.ts` takes account-scope context is **Open Q6**. Must survive the shell, not be dropped (coherence E1). |
| **`/welcome`** | **`/welcome`** (first-run into new frame) | keep / defer placement | Retained; leads into the guided "Connect your first account — start with Test" zero-account flow. Where it lands in the new frame is **Open Q6**. | Zero-account path is the most common brand-new path (novice #11, multiaccount-edge #2). Auto-provisions a Test/local-sim pseudo-account. |
| **`/login`** | **`/login`** | keep | Unchanged; explicitly named as one of the 4 routes P0 must decide are inside/outside the route-group shell (it's outside — no switcher/STOP needed pre-auth). | P0 route-group scoping decision. |

---

## Intentionally removed (and why)

- **Strategy Studio modal — removed.** A modal that duplicated the Strategy tab was pure Frankenstein; its contents move inline into the Strategy destination. The duplicated `TuningCard` (`:3725` / `:4441`) that this modal spawned collapses to one instance. (Contents preserved; only the modal container and the duplicate render site are removed.)
- **Settings → "Strategy" section (read-only mirror) — removed** after a one-release pointer. A read-only mirror of the editable Strategy home is a dead-end false affordance and a duplicated label; there is exactly one editable strategy home now.
- **"Operate" as a settings section — removed as a concept.** The name conveyed nothing about switching broker modes; its controls redistribute to Guardrails·Execution, Guardrails·Autonomy, and Strategy·Signals. Nothing is lost — the label is what's removed.
- **Secondary "Feed" rail (Activity / Runs / Notifications / Audit as a separate 4-tab surface) — removed as a rail.** The four contents redistribute (Dashboard, Results → History, 🔔 Alerts, Results → Alert history); the standalone feed navigation surface itself is eliminated.
- **The bare noun "Notifications" — retired everywhere.** Replaced by the single Alerts noun-family (🔔 Alerts stream · Settings → Alert delivery · Results → Alert history) to kill the tab-vs-settings duplicate-label ambiguity.
- **Standalone `/admin/*` route surfaces (connections / llm-usage / rag-coverage / transcript) — removed as separate top-level routes**, consolidated into one role-gated Settings → Admin section. (Capabilities preserved; the four scattered route entry points are removed.)
- **The ambient `mirrorPolicyToActiveAccount` side effect — removed from all three call sites** (`db-profiles.ts:486, 512, 531`). "Mirror into whatever account is active" is a side-door around the deterministic gates (P7) and is deleted, split into explicit "set as library default" vs "copy into account X." This is behavior removal, not a UI surface.
- **The not-active→halted coercion — removed** at `db-profiles.ts:284, 350, 397` (P2). Not a user-facing surface, but its removal is what makes view-switching free; listed because it is a required deletion in the same migration wave.

**Nothing else is removed.** Every other current surface is kept, renamed, moved, or merged above; the `SettingsSection` union ids are retained as stable routing/redirect keys even where the live section relocates, and old `WorkspaceTab`/`FeedTab` values persist as redirect aliases plus a one-time localStorage migration shim (P1) so no returning user is silently bounced to default.

## II-D. Phased implementation plan

*Five phases, lowest-risk → deepest, each independently shippable behind the `NAV_V2` flag. Phase 1 (pure relabel + scope-surfacing) is safe to start immediately on approval; it touches only copy and changes no data path.*

# Phased Implementation Plan — Agentic Trading IA/Settings Redesign

Five phases, ordered lowest-risk → deepest. Each ships independently behind a flag; no big-bang. Anchors verified against `HEAD 0f6bf0a` (working tree clean).

**Feature flag convention:** one client flag `NAV_V2` (env + localStorage override) gates the new shell/destination rendering; each phase adds its own sub-behavior behind it so any phase can be dark-launched and rolled back by a flag flip, not a revert. `openSettings` `SettingsSection` union ids stay stable as routing keys throughout — renames are label + redirect, never id churn.

---

## Phase 1 — Vocabulary, label de-duplication, and scope-surfacing (no structural moves)

**Goal:** Kill the duplicated-label confusion and make the existing (already-coded but hidden) account-vs-user tier split legible, without moving a single panel or changing any data path. Pure relabel + surface.

**Concrete changes:**
- Rename in copy only (ids untouched): settings `notifications` → **"Alert delivery"**; feed `Notifications` → **"Alert history"**; chrome notification dropdown → **"Alerts"**; destination-label prep "Review" → **"Results"**, `Strategy Profile` → **"Preset"**, `Display` → **"Appearance"**, `Data` → **"Data & Privacy"**. Retire the bare noun "Notifications."
- Surface the existing tier split from `ACCOUNT_SETTINGS_SECTIONS` (`dashboard-client.tsx:165`) / `settingsTierForSection` (`:167`): render a `THIS ACCOUNT` vs `ALL ACCOUNTS` scope tag on each settings section header — data already exists, it's just not shown.
- Relabel chrome "Halt & Flatten" → **"STOP"** with the semantic split made explicit in the label/tooltip ("halts new activity, never sells"); leave the underlying handler untouched this phase (split lands in Phase 4).
- Update Help "Settings Glossary" + command-palette entry labels in lockstep with every rename (same PR).

**Files/areas:** `app/dashboard-client.tsx` (label strings, settings-section headers, feed-tab labels, help modal content, palette command labels), `app/ui/*` help/glossary components. No `src/lib/*`, no API, no schema.

**Effort:** S.

**Risk:** Low. Label-only; the trap is tests asserting on visible text — co-update any test matching old tab/section labels in the same PR (subset of the ~723; grep `"Notifications"`, `"Halt & Flatten"`, `"Review"` in `test/`).

**Ships independently:** No flag needed — it's strictly clarifying copy on the current IA. Safe to merge ahead of the shell.

---

## Phase 2 — Persistence shim + `DestinationTab` mapping layer (rendering unchanged panels)

**Goal:** Introduce the new destination vocabulary as a *mapping* over existing `WorkspaceTab`/`FeedTab` values, and migrate every returning user's localStorage in one shot — so later phases can switch which panel a destination renders without a second migration. Panels themselves don't move yet. (Incremental-path P1.)

**Concrete changes:**
- Add a `DestinationTab` union that maps onto existing tab values: `decision→dashboard`, `performance+tax→results`, `notifications(feed)→alert-history`, `strategy→strategy`, etc. The renderer resolves destination → current panel; output is byte-identical.
- **One-time localStorage migration shim (same PR):** read `WORKSPACE_TAB_KEY` (`:197`) and `FEED_TAB_KEY` (`:198`), map old values to new keys, write, delete old. Without this, every returning user is silently bounced to default because `isWorkspaceTab("tax")` returns false against the new union. This affects 100% of returning users — it is the gating detail of the whole redesign.
- Keep old tab ids as **redirect aliases** so palette deep-links and any bookmarked in-app state still resolve.

**Files/areas:** `app/dashboard-client.tsx` (`:197-199` keys, `:280`/`:290` load effects, `:1033`/`:1041` persist effects, tab-type guards, the destination→panel resolver). No API/schema.

**Effort:** M.

**Risk:** Medium — the shim runs once per user; a bug silently resets everyone's last tab. Mitigate with a unit test that seeds old keys → asserts mapped new keys + old keys deleted, and a no-op assertion when new keys already exist (idempotent re-run).

**Ships independently:** Behind `NAV_V2`; with the flag off, old keys still drive rendering. The shim is written to be idempotent and reversible (keep a one-release read-fallback to old keys).

---

## Phase 3 — Settings taxonomy: scope-first tree, search index, and `openSettings` call-site rewrites

**Goal:** Restructure the 9-section modal into the scope-first tree (Account-scope config heads toward Strategy/Guardrails; user-scope stays in the off-rail Settings tree) with Essentials → one Advanced reveal, and rewire the 6 confirmed `openSettings` sites so relocated sections navigate to their new home instead of opening a gutted modal.

**Concrete changes:**
- Reorganize `SettingsSection` rendering into Scope A (Strategy/Guardrails-bound) vs Scope B (Settings tree: Account & Security, Connections, Keys & Models, Alert delivery, Data & Privacy, Presets, Appearance, Admin). Ids stay stable as routing keys; map old→new labels with redirects.
- Add the **Essentials → Advanced** two-level ladder per surface (Guardrails opens on the 5 Essentials; origin badges/`Overrides (N)` chip live behind Advanced).
- Build the **settings search index** derived from the *same field definitions that render the controls* (never a parallel list — the enrichment-drift trap from CLAUDE.md). Expert/env flags are search-only.
- **Rewrite the 6 `openSettings("operate")` sites** (`:1514, :1555, :1562, :1583, :1709, :1818`) to route to the correct new destination/section (several now point at Strategy→Signals or Guardrails, not a modal). Note `:1819` already targets `"data"` → route to Data & Privacy.
- **Consolidate `/admin/*`** (connections-health, llm-usage, rag-coverage, transcript) under Settings → Admin (role-gated, conditionally rendered); MCP config under Keys & Models → MCP tools.

**Files/areas:** `app/dashboard-client.tsx` (`ACCOUNT_SETTINGS_SECTIONS`, settings modal component, the 6 `openSettings` sites, palette "open Settings section X"), `app/admin/*` (surface consolidation), Help glossary.

**Effort:** L.

**Risk:** Medium-high. **Merge gate: no `openSettings` call points at a relocated section** (grep-assert in CI). Tests asserting on `openSettings` targets or admin routes break — enumerate + update in the same PR. Guardrails against breaking admin: Admin section stays role-gated and conditionally rendered exactly as today; only its *entry point* moves.

**Ships independently:** Behind `NAV_V2`. Each settings section can be migrated one-at-a-time (section-scoped sub-flag) so a partial tree is shippable; old modal remains the fallback render path until all sections move.

---

## Phase 4 — Consolidate Strategy (5 surfaces → 1 home + 2 explainers) and the TuningCard merge

**Goal:** Collapse the scattered strategy config into the single editable Strategy destination and de-duplicate the twin TuningCard. This is the single highest-risk change (shared state + stale-baseline patch risk), so it gets named exit criteria and a flag rollback.

**Concrete changes:**
- Strategy workspace tab becomes the editable Strategy destination (Thesis / Signals / AI Review + Presets bar). **Delete Strategy Studio as a modal**; move its contents inline (optional full-screen mode preserves distraction-free feel). Settings→"Strategy" section → one-line pointer for one release, then removed. Strategy Flow overlay kept, reclassified as a read-only "Understand" explainer. `/strategy` marketing page renamed `/how-it-works`, linked once from footer/Help.
- **TuningCard merge** — two render sites at `dashboard-client.tsx:3725` and `:4441`, both consuming the same `strategyTuning` state and `snapshot.strategyPrompt`, collapse to **one instance**:
  - *Precondition assertion:* verify both parents pass an identical `snapshot` prop before deleting either (post-merge risk = patch computed against a stale baseline if the surviving parent reads a different `snapshot`).
  - *Exit criteria:* apply/discard round-trip test (generate review → apply → assert `strategyTuning` patch diffs against the *live* prompt, not stale text) + a localStorage-compat check on `STRATEGY_TUNING_STORAGE_KEY` (`:199`).
  - *Rollback:* keep the deleted surface behind the same flag for one release — a bad merge is a flag flip, not a revert.
- The autonomy dial deliberately lives in Guardrails, not Strategy.

**Files/areas:** `app/dashboard-client.tsx` (Studio modal, TuningCard `:3725`/`:4441`, `strategyTuning` state, `STRATEGY_TUNING_STORAGE_KEY`), `app/ui/strategy-flow.tsx` (reclassify), `app/strategy/page.tsx` (→ `/how-it-works`).

**Effort:** L.

**Risk:** High (named the highest by the design). Fully mitigated by precondition assertion + round-trip test + flag rollback above. Grep `strategyTuning`/`snapshot.strategyPrompt` before deleting to confirm no third consumer.

**Ships independently:** Behind `NAV_V2` + a dedicated `STRATEGY_CONSOLIDATION` sub-flag; both TuningCard sites coexist until the round-trip test is green, then the flag deletes the duplicate.

---

## Phase 5 — New nav shell, view/execution decoupling, and single-account-first rollout

**Goal:** Land the three-zone frame, the account switcher, and the deepest safety migration: decouple **view-scope** (ephemeral, per-tab) from **execution-scope** (persisted, per-account arming) so the switcher can promise free switching. Roll the whole new IA to single-account users first, where scope ambiguity doesn't exist.

**Concrete changes (sequenced within the phase):**
- **P0-shell:** extract the three-zone frame into a route-group `layout.tsx` rendering current destinations behind `NAV_V2`. Explicitly keep the **switcher + STOP surviving on `/admin`** (system halt) **and on `/mobile`**. No content moves.
- **P2-decouple (the first blocking safety migration):** split ephemeral view-scope from persisted per-account arming; **remove the not-active→halted coercion** at `db-profiles.ts:284, 350, 397`; **remove the ambient `mirrorPolicyToActiveAccount`** from all three call sites (`:486, :512, :531`). Add **server-side write-time `accountId` validation against the session** (the real safety boundary — the switcher is not "free" until this ships). Split the colliding verbs: `activateAccount`→"switch view", mirror side-effect→deleted, `applyProfileToAccount`→"copy preset in."
- **Single-account-first:** ship the full IA to single-account users (static switcher chip, no scope tags/Fleet/origin badges). Gate all multi-account chrome behind 2nd-account connection.
- **Wash-sale provenance:** change `getUserWashSaleLockedSymbols` (`tax.ts:99`) from bare `Set<string>` to per-symbol provenance (contributing account + earliest clear date); filter Test out of contribution (`tax.ts:113` currently maps `broker==="test"`→`"paper"`, letting a simulated loss lock a real account). Ships with the Approvals culprit-naming PR. Round-trip read-after-write test per `USER_LEVEL_POLICY_FIELDS` field.
- **Deferred (do not block IA migration):** Fleet aggregation endpoints + fleet-STOP mutation; route-encoded `/a/:accountId/` as a thin `[accountId]` catch-all that seeds+validates active-account state (write guard does the real work).

**Files/areas:** new `app/(shell)/layout.tsx`; `app/dashboard-client.tsx` (switcher, chrome verbs, STOP split, Fleet); `src/lib/db-profiles.ts` (`:284/350/397` coercion, `:486/512/531` mirror, arming model); `src/lib/tax.ts` (`:99` return type, `:113` Test filter); `src/lib/policy.ts` (enforcement already at `:311`, unchanged); `app/api/profiles`/`connected-accounts` (write-time validation), new fleet endpoints; `app/api/*` for `[accountId]` seed; `src/lib/mobile-api.ts`.

**Effort:** L (largest; internally staged P0→decouple→single-account→provenance).

**Risk:** Highest — touches the execution singleton and real-money scoping. Mitigation: decouple lands *before* the switcher is advertised as free; server-side write validation is the load-bearing guarantee (a stale tab cannot act on the wrong account regardless of URL); single-account-first removes scope ambiguity from the initial blast radius.

**Ships independently:** Behind `NAV_V2`; the shell renders current tabs unchanged first, then the decouple migration lands as its own PR (safety-critical, isolated), then single-account rollout, then provenance. Fleet + route-encoding are explicitly deferred milestones, not gates.

---

## Guardrails (do-not-break invariants, every phase)

- **Execution modes untouched by IA work.** Test→Paper→Brokerage is a data-plane property; none of Phases 1–4 touch order placement or mode gating. Only Phase 5's decouple changes execution wiring, and it *removes* silent coercion — it must never *add* a path that arms an account. Verify: `npm test` on policy/execution suites green before every merge.
- **Kill switch always one click, always safe.** STOP relabel (Phase 1) and STOP/Flatten split (Phase 4/5) must keep "halt new activity" as one click that **never sells**; selling stays a separate secondary action. Never weld flatten into the panic button. The chrome STOP and `/admin` system-halt must survive the shell extraction (Phase 5 P0).
- **One halt state per account, typed roles.** Chrome STOP = actuator; Guardrails→Autonomy = auto-trip thresholds; Settings→Admin = operator override. Don't fork the halt state across surfaces during the settings move.
- **Admin stays role-gated + conditionally rendered.** Moving admin's entry point (Phase 3) must not change its gating; the four `/admin/*` targets stay behind the same role check.
- **Palette "run once" inherits chrome money-reality gating.** No Live execution path may be reachable from the palette without the same arm ritual as the chrome button.
- **`USER_LEVEL_POLICY_FIELDS` is the single source of truth for scope.** Any field's scope change = coordinated Set edit + migration + per-account back-fill **in one PR**, with a round-trip read-after-write test (the failure is silent: field writes to wrong store, reads back as default). Don't half-migrate `marketScan*`.
- **Wash-sale enforcement is authoritative and stays so.** `policy.ts:311` already blocks; Phase 5 only *surfaces* provenance and filters Test — the enforcement gate itself is not weakened. Add a test that a Test-account loss does **not** lock a real taxable account after the `tax.ts:113` fix.
- **Verify trio before every merge:** `npx tsc --noEmit` → `npm test` → `npm run build` (plus `npm run lint`). Each phase enumerates and updates affected tests **in the same PR** — the build gate only catches label/`openSettings`/feed-tab/Studio-modal assertions if co-sequenced.

**Relevant files (absolute):** `/home/user/agentic-trading/app/dashboard-client.tsx`, `/home/user/agentic-trading/src/lib/db-profiles.ts`, `/home/user/agentic-trading/src/lib/tax.ts`, `/home/user/agentic-trading/src/lib/policy.ts`, `/home/user/agentic-trading/app/ui/strategy-flow.tsx`, `/home/user/agentic-trading/app/strategy/page.tsx`, `/home/user/agentic-trading/app/admin/`, `/home/user/agentic-trading/app/api/profiles/`, `/home/user/agentic-trading/app/api/connected-accounts/`, `/home/user/agentic-trading/src/lib/mobile-api.ts`.

---

# PART III — Known gaps & must-fix-before-build

*The completeness critic re-verified every anchor and found the design "not building on sand," but flagged real implementation-sequencing gaps. These are not design flaws — they are the sharp edges to resolve before the deep phases. They are reproduced here so they are not lost.*

# Completeness Review — Final Design (v2)

## Verified: the design's anchors are real
All load-bearing claims check out against `HEAD 0f6bf0a`: wash-sale enforced (`policy.ts:305-325`), the Test→"paper" leak (`tax.ts:113`), the flat `Set<string>` return (`tax.ts:99` — actual fn name is `getUserWashSaleLockedSymbols`, correct), `USER_LEVEL_POLICY_FIELDS`=3 (`db-profiles.ts:20-24`), 6 `openSettings("operate")` sites, `SettingsSection` 9-member union, all four `/admin/*` routes, and `/welcome`/`/mobile`/`/login`. The design is not building on sand.

---

## Real gaps (no praise)

### A. Current surfaces MISSING from the migration table

1. **The `/admin/layout.tsx` and admin route-group shell is unaccounted for.** The table folds `/admin/connections`, `llm-usage`, `rag-coverage`, `transcript` into Settings→Admin, but `app/admin/layout.tsx` exists as a real wrapper. The plan says "only its *entry point* moves" — but it never says what happens to the `/admin/*` **routes themselves** post-consolidation. Are they deleted, kept as redirects, or kept as a parallel deep-link target (the way Results→History is)? An implementer cannot tell whether to `rm -rf app/admin/{connections,llm-usage,...}` or leave them. This is a genuine unresolved fate, not a rename.

2. **`app/strategy/page.tsx` → `/how-it-works` rename lacks the redirect/`LANDING_PAGE_ENABLED` mechanics.** The table says "rename, keep old path as redirect" but the page is gated by `LANDING_PAGE_ENABLED`. Does the rename preserve the gate? Is the redirect itself gated (so a disabled landing page 404s both paths)? SEO-facing route renames with a feature gate need the interaction spelled out; it isn't.

3. **The mobile command API's `setActiveConnectedAccount` path is a live P2 hazard the plan doesn't name.** `mobile-api.ts:648-651` calls `setActiveConnectedAccount(accountId, ...)` — i.e. mobile **writes the execution singleton** directly. P2 "decouples view from execution" and removes the not-active→halted coercion, but the plan lists `mobile-api.ts` only under Phase 5 "files/areas" without stating that this mobile mutation must be re-pointed at the new view-scope vs arming split. If P2 lands but mobile still calls the old singleton setter, mobile becomes the surviving side-door that re-introduces the exact coercion P2 deleted. This is a **risk to existing behavior**, under-specified.

### B. Vagueness / contradictions that will confuse an implementer

4. **"Max position size" Essentials control has no single backing field.** Settings tree maps it to `maxOrderNotional / % NAV mirror` — but "position size" (total holding) and "order notional" (single order) are **different quantities**, and the design uses them interchangeably in the Guardrails Essentials. An implementer wiring the 5-Essentials layer won't know if the novice-facing "max position size" caps a position (needs a per-symbol exposure field) or an order (`maxOrderNotional`). The Sizing/Exposure sections list *both* separately; the Essentials collapses them ambiguously. Pick one field or define the derived quantity.

5. **Phase ordering contradicts the design's own "P2 is the FIRST blocking migration" invariant.** The design principles and multiaccount-edge #1 both state P2 (view/execution decouple) is "the first blocking migration" and the switcher "is NOT free" until it ships. But the **Phased Plan runs P2's decouple inside Phase 5** (the last phase), *after* Phases 1-4 have already shipped renames, the persistence shim, settings moves, and the Strategy consolidation. So the account switcher chrome (introduced in Phase 5's P0-shell) and the decouple land in the same phase — fine — but Phases 2-4 ship a `DestinationTab` mapping and settings relocations that assume in-place view re-scoping works, while the singleton coercion is still live. If any Phase 2-4 surface lets a user switch account context, it hits the unfixed coercion. The plan needs an explicit statement that **no account-switching UI ships before Phase 5's decouple**, or it must reorder decouple earlier. Right now "first blocking migration" and "Phase 5" contradict.

6. **"Delete Studio modal contents move inline" vs "keep deleted surface behind flag for one release" — which for the modal?** Phase 4 says both delete the Studio modal AND keep the deleted surface behind a flag for rollback. For the TuningCard that's coherent (dup collapses to one, flag-gated). For the **Studio modal container** it's unclear whether the modal is flag-retained too. An implementer needs to know if the modal JSX stays (dead-but-flagged) or is removed outright.

### C. Multi-account / scoping edge cases still unresolved

7. **Concurrent arming persistence model is asserted but never designed.** P2 promises "which accounts are armed to run (per-account, persisted, plural)" replacing the singleton. But there is **no schema anchor** for where plural per-account arming state lives. `account_strategy_state` is keyed by `connectedAccountId` (good), yet the current `systemState` field IS the arming, and the coercion exists *because* activating one account touches others. Removing the coercion without defining "what does armed mean when 3 accounts are active and the scheduler runs" leaves the scheduler's account-selection undefined. **Which accounts does a scheduled/cron run iterate over post-P2?** The design defers "Fleet aggregation endpoints" but the scheduler's fan-out is not Fleet UI — it's core execution semantics, and it's absent.

8. **Wash-sale provenance return-type change has no consumer inventory.** The plan changes `getUserWashSaleLockedSymbols` from `Set<string>` to per-symbol provenance. `policy.ts:315` consumes it as `Set<string>` with `.has(symbol)`. Changing the return type breaks that call site and any test asserting on the Set. The plan says "ships with the Approvals PR" but never enumerates the **downstream consumers** (policy gate, any tests, the internal `getWashSaleLockedSymbolsForUser` that also returns a Set). This is exactly the silent-write trap CLAUDE.md warns about, inverted: a type change with an unaudited blast radius.

9. **Open Q3 (Fleet STOP hits Paper?) and Open Q7 (single-account auto-resolve) can conflict for a Paper-only multi-account user.** If a user has two Paper accounts and no Live, Open Q7's "auto-resolve to sole account" doesn't apply (2 accounts), but Open Q3's "Live + Paper halt" means Fleet STOP hits both Papers. Neither question addresses the **all-Paper multi-account** fleet — a common tester setup. Minor, but the two open questions don't compose.

### D. Risks to existing behavior the plan under-weights

10. **The persistence shim (Phase 2) deletes old localStorage keys, but Phase 2 ships behind `NAV_V2` with the flag possibly off.** The plan says "with the flag off, old keys still drive rendering" AND "the shim reads old keys, writes new, deletes old." If the shim runs but the flag is off, it deleted the old keys that the flag-off path still needs → returning users on flag-off get bounced to default anyway. The shim's run-condition (only when `NAV_V2` on? always?) is contradictory. This affects 100% of returning users — the plan itself calls it "the gating detail" yet leaves the gate's trigger ambiguous.

11. **Mobile and `/welcome` are explicitly deferred to Open Q6 but Phase 5 P0 requires "switcher + STOP survive on `/mobile`."** You cannot both defer the mobile disposition to an open question AND make it a P0 exit criterion. One of them is wrong; an implementer hits this immediately when scoping P0.

---

## The 3 most important fixes before implementation

1. **Reorder or firewall P2.** Either move the view/execution decouple (P2) *before* any account-switching UI ships, or add an explicit gate: "no chrome that changes account context merges before the decouple + server-side write-time `accountId` validation lands." As written, Phases 2-4 can expose switching against the still-live not-active→halted coercion (`db-profiles.ts:284/350/397`) and the mobile singleton setter (`mobile-api.ts:649`). This is the one gap that can point an autonomous agent at the wrong real-money account — the design's own stated worst case.

2. **Design the post-singleton arming + scheduler fan-out, with a schema anchor.** Before removing the coercion, specify where plural per-account "armed" state persists and how a scheduled run enumerates accounts. Right now the design removes the mechanism (coercion) that currently makes account-selection deterministic without defining its replacement. Fleet *UI* is correctly deferred; scheduler *semantics* cannot be.

3. **Resolve the shim trigger and the wash-sale return-type blast radius — both are silent-failure changes.** (a) State unambiguously whether the Phase 2 localStorage shim runs flag-independently and keeps a one-release read-fallback so flag-off users aren't stranded. (b) Enumerate every `getUserWashSaleLockedSymbols` / `getWashSaleLockedSymbolsForUser` consumer (starting with `policy.ts:315`) in the provenance-change PR, with a compile-time break rather than a runtime `.has` on a now-differently-shaped value.

---

## Genuinely complete parts (one line each)

- **The three-entity model (Connected Account / Preset / User-global) with copy-on-bind and three-way resync** is fully specified and internally consistent.
- **The Settings scope-first taxonomy** covers all 9 legacy sections with no field dropped; the coverage note (Notes #1) is accurate.
- **The label de-duplication** (Notifications→Alerts family, Tax split, Review→Results) is complete and each duplicate is traced to a single new home.
- **The TuningCard merge** has real exit criteria (round-trip test + localStorage-compat) and a flag rollback — genuinely implementable as written.
- **Wash-sale as a third "cross-account coupling" classification** is the correct call and correctly refuses to label `washSaleGuard` a per-account toggle.

---

# PART IV — Appendices (full team outputs, verbatim)

The complete corpus is preserved under [`docs/settings-navigation-redesign/`](./settings-navigation-redesign/) for provenance and deeper reading:

| # | File | What it is |
|---|------|------------|
| A | [Current-state maps](./settings-navigation-redesign/appendix-A-current-state-maps.md) | Forensic map of today's IA, settings, strategy duplication, account model — with file:line |
| B | [Capability inventory](./settings-navigation-redesign/appendix-B-capability-inventory.md) | The layout-agnostic "what the product does" brief given to the blind teams |
| C | [Pattern research](./settings-navigation-redesign/appendix-C-patterns-research.md) | Best-in-class IA/settings/switcher patterns from comparable products |
| D | [Design A — Informed](./settings-navigation-redesign/appendix-D-design-A-informed.md) | The team that knew the app |
| E | [Design B1 — Blind](./settings-navigation-redesign/appendix-E-design-B1-blind.md) | Greenfield team #1 (capabilities only) |
| F | [Design B2 — Blind](./settings-navigation-redesign/appendix-F-design-B2-blind.md) | Greenfield team #2 (capabilities only) |
| G | [Design C — Pattern-led](./settings-navigation-redesign/appendix-G-design-C-pattern-led.md) | Design by analogy to best-in-class |
| H | [Adjudication](./settings-navigation-redesign/appendix-H-adjudication.md) | Convergence / divergence / blind-spots across the four designs |
| I | [Unified v1](./settings-navigation-redesign/appendix-I-unified-v1.md) | Pre-red-team draft (for provenance) |
| J | [Red-team](./settings-navigation-redesign/appendix-J-red-team.md) | The adversarial critiques that produced v2 |

---

*Produced by a large-team, code-anchored redesign workflow on 2026-07-01. The canonical design is Part I (v2); it supersedes v1 (Appendix I). This is a proposal — implementation follows owner approval of the direction and the Open Questions in Part I.*
