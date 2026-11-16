# Appendix H — Cross-Team Adjudication (convergence / divergence / blind-spots)

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

# Adjudication: Four Redesigns of Agentic Trading's Settings + Navigation

## 1. CONVERGENCE — What ≥3 of 4 designs independently landed on

These are the highest-confidence recommendations: multiple independent teams (some blind to the app) reached them without coordination.

| Convergent idea | A | B1 | B2 | C | Confidence |
|---|---|---|---|---|---|
| **The account is the primary object / scope unit** — everything (strategy, risk, tax, P&L, autonomy) is scoped to one broker-connected account, not to "the user" | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Persistent, top-left account switcher — never a tab** — re-scopes screens in place; doubles as fleet-health glance | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Money-reality is ambient color, Live = loud/red** — Test grey / Paper blue / Live red, repeated app-wide | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Money-reality (Test→Paper→Live) and Authority (Propose→Decide) are two orthogonal dials, never one slider** | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Presets are inert templates that COPY into an account (copy-on-bind, not live-link); apply shows a diff + confirm** | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **The AI never gets a side door** — assistant/tuner trades & config changes re-enter the same gates (approval queue / confirmable diff) | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Assistant is a scope-aware overlay/slide-over, NOT a top-level tab** (kills the two-approval-homes bug in A's legacy) | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Config split by SCOPE first** (user-global vs account) then by category; every field wears a scope/origin badge | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Type-to-confirm friction reserved for the two one-way doors** (arm Live, arm Auto-on-Live); cheap friction elsewhere = fatigue | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Always-reachable kill switch / Halt in persistent chrome** | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Provenance / drift surfacing** — an account shows "from preset X · N local edits," with reset-to-source | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Approvals is its own destination** (a lifecycle + backlog + deep artifacts), not a dashboard panel | partial* | ✓ | ✓ | ✓ | **3–4/4** |
| **Progressive disclosure: novice-safe Essentials → power-complete Advanced**, ~120–150 knobs never greet a newcomer | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Safe defaults are structural** — new account = Test + Propose-only + stops-on + breakers-armed; autonomy resets on restart | partial | ✓ | ✓ | ✓ | **3–4/4** |
| **Audit is a lens/filter reachable from multiple surfaces, not a top-level tab** | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Tax splits: tax RULES = config (per-account), tax OUTCOMES = review/reporting** | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Cap top-level nav at ~5–6 verb destinations**; new capability → preset/gear/section, never a new tab | ✓ | ✓ | ✓ | ✓ | **4/4** |
| **Route-encodes-scope + fail-neutral "no account selected" blocking state** | ✓ | — | — | ✓ | 2/4 (notable) |

\*A folds Approvals into "Decision" (its hot core) rather than a separate destination, but treats it as the dominant surface — functionally aligned.

**Verdict on convergence:** The single strongest signal in the whole exercise is that **blind greenfield teams (B1, B2, C) independently reinvented the account-as-object + persistent-switcher + two-orthogonal-dials + copy-not-link-presets model — and the informed team (A) confirmed the existing schema already supports it.** This is the load-bearing spine. It is not speculative; it is the intersection of "what four teams chose" and "what the data model already is."

---

## 2. DIVERGENCE — Key disagreements, judged

### D1. Strategy and Guardrails: one destination or two?
- **A:** ONE "Strategy" destination with Guardrails as a sub-tab.
- **B1, B2:** TWO peer destinations (Strategy = the brain; Guardrails = the fence).
- **C:** ONE "Strategy" tab holding a dense searchable config tree (risk is a category within it).

**Stronger: the B1/B2 split — but conditionally.** The argument that "how smart" (reward-seeking) and "how contained" (deterministic safety) are different cognitive modes is genuinely strong for a *trust* product: a novice needs the fence to be a distinct, reassuring room, and a kill-switch must never be buried inside a prompt-tuning screen. **However**, A and C are right that both are account-scoped config and share the same disclosure/provenance/scope machinery. **Ruling: two destinations, one engine.** Split Strategy and Guardrails at the nav level (B1/B2's insight) but build them on a single shared config-rendering system with identical scope badges, disclosure ladders, and search (A/C's insight). This is the highest-value graft in the entire exercise.

### D2. Where does the autonomy dial live — Strategy or Guardrails?
- **B1, B2:** In **Guardrails** ("turning the AI loose is a safety decision; it belongs next to the drawdown stops that make loosing it survivable").
- **A, C:** In the mandate/automation area (A: "Automation" sub-tab; C: "Mandate & Autonomy").

**Stronger: B1/B2 (autonomy in Guardrails).** This is a subtle but correct call. Autonomy is the release of the leash; it should sit on the same screen as the circuit breakers that bound it, so arming Decide and seeing the daily-loss stop are one deliberate act. C's "Mandate & Autonomy" coupling is defensible but weaker — it associates autonomy with *intent* rather than *containment*.

### D3. Fleet / cross-account acting surface
- **B1, B2:** Explicit **Fleet/Floor** aggregate view — read-and-triage only, **no trade action from the roll-up**, but WITH fleet-wide emergency controls (Halt all / close-only all).
- **A:** "Accounts hub" for management; no strong aggregate cockpit.
- **C:** "All accounts" panel is the switcher itself (list rows), no separate dashboard.

**Stronger: B1/B2's Fleet-as-triage-only.** The "aggregate for awareness, isolate for action, but panic doesn't respect account boundaries" reasoning is airtight for a multi-account real-money product. A operator with 4 live accounts needs a morning glance AND a fleet-wide halt without drilling in. C's switcher-list is elegant but insufficient in a crisis; A under-specifies it. **Graft B1/B2's Fleet view + fleet-wide emergency controls.**

### D4. Number of top-level destinations
- **A:** 5 (Decision, Research, Strategy, Performance, Activity).
- **B1, B2:** 6 (adds a distinct Approvals + splits Strategy/Guardrails; Settings on-rail).
- **C:** 5 (Dashboard, Proposals, Scan, Activity, Strategy) + Settings off-rail.

**Stronger: 6, mostly.** Once you accept the Strategy/Guardrails split (D1) and Approvals-as-destination (convergent), 6 is forced. The disagreement is really about **Settings placement**: B1 puts it on-rail (bottom); B2/C push it off-rail (profile/gear menu) as "plumbing." **Ruling: Settings off the primary verb rail** (B2/C) — it's user-global, infrequent, and cluttering the daily-loop verbs with it mis-signals frequency. Reached from the account-switcher footer or avatar menu (A's "Preferences…" pattern is the cleanest execution).

### D5. Research/Scan as a destination vs. an input
- **A, C:** Scan/Research is its own read-heavy destination.
- **B1, B2:** Scan is an *input to proposal generation* — folded into Strategy config + a Desk/Floor drill-down, not a peer tab.

**Stronger: A/C (keep Scan visible).** B1/B2's "scan is just an input" is theoretically clean but ignores that the scan output (ranked candidates, factor scores, web-signal bulletins, skipped-candidate view) is genuinely consulted evidence a supervisor reads independently of any one proposal. Demoting it hides a surface users actively browse. Keep it as a lightweight destination (C's "Scan") or a sub-tab under a "Research" umbrella (A).

### D6. Vocabulary for the reusable template
- **A:** "Preset" (renamed from Strategy Profile), account-tier renamed "Workspace."
- **B1:** "Strategy Preset."
- **B2:** "Preset" (and running instance = "Desk").
- **C:** "Strategy Preset."

**Stronger: "Preset" (all four converge in substance).** B2's "Desk" for the running instance is evocative but introduces a novel noun with migration cost against an existing `account_strategy_state` / ConnectedAccount vocabulary. **Ruling: keep "Account" for the instance (matches schema + 3 of 4 teams), "Preset" for the template.** Drop "Desk" and "Workspace" as net-new nouns that raise migration/comprehension cost for no functional gain.

### Cross-cutting scoring (which philosophy wins on each axis)

| Axis | Winner | Why |
|---|---|---|
| **Fitness for multi-account** | **B2** (marginally over B1/C) | The copy-on-bind divergence model with "diverged: 6 fields → diff / re-sync / promote" + cross-account wash-sale surfaced *at the blocked proposal naming the culprit account* is the most complete multi-account treatment. |
| **Discoverability** | **C** | Scope-first + searchable + deep-linkable from day one + object-scoped gears + depth capped at 2 is the most rigorous findability system. |
| **Novice + power** | **B1/B2 (tie)** | Three-tier disclosure ladder with live plain-English consequence previews ("risks at most $1,000 — about 2% of equity") is the most humane. B2's "pick a risk-appetite card that sets the whole advanced block" is the best novice on-ramp. |
| **Migration cost from known current state** | **A (decisively)** | Only A knows the real anchors: `USER_LEVEL_POLICY_FIELDS`, `activateStrategyProfile`/`applyProfileToAccount`, the `SettingsSection` union ids, the duplicated TuningCard sharing `strategyTuning` state, `dashboard-client.tsx` line anchors. A's id-redirect + staged-PR plan is the only implementable migration. |
| **Coherence** | **B2** | Tightest through-line; every element traces to "supervise one Desk, watch/decide/author/contain/review/wire-up." |

---

## 3. BLIND-SPOTS

### What A missed by anchoring to legacy
- **Under-committed on the Strategy/Guardrails split.** A folded Guardrails into a Strategy sub-tab because the legacy app has "one Strategy tab" — it optimized *away from* the current mess rather than *toward* the ideal. The blind teams, unburdened, all saw that safety config deserves its own room. A's anchoring cost it the single best structural idea.
- **No Fleet cockpit.** A's "Accounts hub" is management-flavored (add/disconnect) rather than an operational morning-glance with fleet-wide halt. Anchoring to the legacy Settings-only account selector, A never imagined the aggregate operational surface.
- **Autonomy placed in "Automation," not next to breakers** — a legacy-shaped grouping (Operate→Automation) rather than the safety-shaped grouping B1/B2 found.
- **Kept a "/how-it-works" marketing route and Flow overlay in scope** — spends design energy preserving legacy surfaces the greenfield teams simply didn't carry.

### What B1/B2/C missed by not knowing the real constraints
- **The three-entity tangle is worse than they modeled.** The real schema has **Connected Account** (`ConnectedAccount`, `types.ts:280`), **Strategy Profile** (`strategy_profiles`, the preset), **`account_strategy_state`** (the live bound instance), AND **`USER_LEVEL_POLICY_FIELDS`** (a hard-coded set of policy fields that are currently user-tier, not account-tier). B1/B2/C's clean "global → preset → account-override" tiers assume the tier boundary is a free design choice — but **`USER_LEVEL_POLICY_FIELDS` is a concrete list that already classifies specific fields as user-global**, and A's §4e shows moving even *two* fields (`marketScanCandidateLimit`/`OutlierReserve`) out of it requires a **data migration + per-account back-fill**. The greenfield "just scope everything to the account" is not free; it's a fan-out migration with real cost. A is the only one who priced this.
- **Three verbs already collide in code:** `activateAccount(id)`, `activateStrategyProfile(id)` (with an ambient "mirror into whatever account is active" side effect), and `applyProfileToAccount(id, accountId)`. B1/B2/C's "copy-on-bind" is the right target, but only A knows there's an existing **ambient side-effect that must be explicitly deleted** — a silent behavior the blind designs don't know to kill.
- **Execution mode isn't a UI toggle — it's a credential/data-plane property.** B2 and C intuited this ("connect a different account," "credential-bound"), but none but A grounds it against the actual `ConnectedAccount` capabilities snapshot and the account-type guards (block short/margin presets onto IRAs) that already exist in `capabilities`.
- **Admin surfaces exist and are conditionally rendered.** B1/B2 mention admin (allowlist, per-user LLM billing, provider health, system-wide halt); C and A largely punt (`/admin/*` "unchanged"). None fully reckons with the operator-vs-user role boundary already in the code. This is a real gap in **all four** — admin/operator config needs an explicit home decision, not "unchanged."
- **The `dashboard-client.tsx` monolith is the actual migration surface.** Only A cites the real anchors (tab defs `:148/161/162/165`, tier logic `:165-168,4508-4797`, account selector `:4722-4756`, palette `:1576+`, DecisionView `:2241`, buried copy-to-account `:3563-3582`). B1/B2/C design in a vacuum where this file's size and the **duplicated TuningCard sharing `strategyTuning` state** (A's "highest-risk change, stage as its own PR") simply don't exist. Any greenfield IA that ignores this will underestimate effort by an order of magnitude.
- **Cross-account wash-sale is real and B2 nailed it blind** — but the blind teams don't know whether the current engine actually *enforces* cross-account lockout or just displays it. A doesn't mention it at all (legacy blind spot in the other direction). This needs verification against `src/lib/policy.ts` / tax logic before it's promised in UI.

---

## 4. RECOMMENDED SPINE + What to Graft

### The spine (decisive)

**Primary object:** the **Account** (broker link + bound strategy + guardrails + autonomy + ledger). Keep the existing noun — do **not** introduce "Desk" or "Workspace."

**Persistent chrome (every screen):**
- **Top-left Account Switcher** (never a tab) — shows `label · broker · MODE-badge` with ambient color (Test grey / Paper blue / **Live red**), autonomy chip (`Propose` / `Decide`), day P&L, pending count. Dropdown = fleet list, Live grouped first, + "All accounts (Fleet)" row, + Connect account, + Preferences… footer. **Fail-neutral "No account selected" blocking state.**
- **Right chrome:** ambient risk strip (daily notional used, net exposure, regime) + **Run once** + **Halt & Flatten** (halt one-click; flatten confirmed) + notifications bell + **⌘K palette** + Assistant launcher.
- **Live viewport accent** (red hairline) app-wide whenever a Live account is active; MODE badge repeated on every action button.

**Six verb destinations (all account-scoped except Settings):**
1. **Dashboard** (home) — live cockpit for the active account; **Fleet mode** when "All accounts" selected (read+triage only, with fleet-wide Halt-all / close-all).
2. **Approvals** — the decision queue; deep proposal cards (thesis, Bull→Bear→Red-Team, policy-gate checklist, entry-drift, projected bracket, MODE badge on Approve); in Decide mode, the auto-execution ledger.
3. **Strategy** — the brain: prompt, 8 weight sliders (with auto-tune toggles), AI-review models, universe/scan. Hosts the **Preset library**.
4. **Guardrails** — the fence: sizing/exposure caps, stops/breakers (each card doubles as live armed/tripped status), execution controls, tax RULES, **and the autonomy dial**.
5. **Review** — outcomes: P&L vs SPY, thesis/regime/factor scorecards, tax OUTCOMES, the **Tuning queue** (accept/reject like a code review), audit as a lens.
6. **Settings** — **off the primary rail** (avatar/switcher-footer menu): identity, broker connections, keys, model defaults, notification channels, data-source toggles, preset library manager, **admin (conditionally rendered)**.

**Assistant:** persistent scope-aware slide-over over all six (⌘K + rail), never a tab; every trade → Approvals, every config change → confirmable diff.

**Config engine (one system, rendered in two destinations):** scope-first (user-global vs account) → ≤6 categories → **two-level disclosure max** (Essentials → one Advanced reveal) → **searchable + deep-linkable, index derived from the same field defs that render controls** (never a parallel list) → every control shows effective value + default + **origin badge** (`account` / `from preset X` / `locked by account type` / `global default`) + live plain-English consequence preview.

**Scope model:** three tiers — **User-global → Preset → Account-override → Effective (resolved, with provenance)**. Presets **copy-on-bind, never live-link**; apply = **diff + confirm** (type-to-confirm for Live targets, account-type guard for IRA/short/margin). Two orthogonal dials, **Paper-before-Live and Decide-gated-separately enforced in code, not just UI.**

### What to graft, from where

| Graft | From | Onto the spine |
|---|---|---|
| **Strategy/Guardrails as two peer destinations** built on **one shared config engine** | B1/B2 (split) + A/C (shared engine) | The #1 structural graft |
| **Autonomy dial lives in Guardrails, next to the breakers** | B1/B2 | D2 |
| **Fleet view: read+triage only + fleet-wide emergency halt** | B1/B2 | Dashboard's aggregate mode |
| **Copy-on-bind divergence UI** ("diverged: 6 fields → diff / re-sync / promote") | B2 | Preset↔Account interaction |
| **Cross-account wash-sale surfaced at the blocked proposal, naming the culprit account** | B1/B2 | Approvals cards (verify engine support first) |
| **Scope-first + searchable + deep-linkable + object-scoped gears, depth capped at 2** | C | Config engine findability |
| **Origin/provenance badges + reset-to-source on every effective value** | all four (C/B2 sharpest) | Config engine |
| **Live plain-English consequence preview + pick-a-posture card that sets the block** | B1/B2 | Novice on-ramp |
| **"Watch it reason once in Test" onboarding aha** | B1/B2 | First-run |
| **The real migration plan** — `SettingsSection` id redirects, staged TuningCard-dedup PR, `USER_LEVEL_POLICY_FIELDS` back-fill (or relabel-in-place fallback), `dashboard-client.tsx` line anchors, delete the `activateStrategyProfile` ambient side-effect | **A (only A can supply this)** | Sequencing — this is what makes the spine shippable |
| **Keep Scan/Research as a light destination** | A/C | Don't demote per B1/B2 |
| **Settings off the primary rail** | B2/C | Nav |
| **Explicit admin/operator home** (all four under-specified this) | new decision | Settings → Admin (role-gated) |

### One-line ruling
Adopt the **blind teams' greenfield spine** (account-object + persistent switcher + Strategy/Guardrails split + copy-on-bind presets + two orthogonal dials), execute its config surface with **C's scope-first searchable engine and B2's divergence model**, and sequence the whole migration with **A's concrete knowledge of the real schema, the three colliding verbs, `USER_LEVEL_POLICY_FIELDS`, and the `dashboard-client.tsx` monolith** — because the ideal IA is worthless if it can't be landed on the app that actually exists. The greenfield teams found the destination; only A knows the road.
