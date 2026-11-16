# 2026-07-01 — Settings & navigation redesign proposal (large-team, code-anchored)

Branch: `claude/settings-navigation-redesign-a3k1yv`. Baseline `HEAD 0f6bf0a` (working tree clean at start).

## Summary
Produced a full **canonical proposal to redesign the app's information architecture** — primary
navigation, the 9-section settings surface, the scattered Strategy surfaces, and the multi-account/
scoping model. Deliverable is docs-only (no app code changed): a self-contained main doc plus a
10-file appendix corpus preserving every team output verbatim.

- Main doc: `docs/settings-navigation-redesign.md` (~125 KB): diagnosis of the current Frankenstein IA,
  the method, the canonical target design (v2), 5 annotated wireframes, a field-level scope-tagged
  settings tree, a complete current→new migration table, a 5-phase implementation plan, a
  must-fix-before-build gap list, and open questions for the owner.
- Appendices: `docs/settings-navigation-redesign/appendix-A..J-*.md` (current-state maps, capability
  inventory, pattern research, the four independent designs, adjudication, unified v1, red-team).

## Why (decision)
Owner: the app's settings/layout are "Frankenstein-like patchwork" — Strategy config lives in 5 places
(Strategy tab + Strategy Studio modal + Settings→Strategy + Strategy Flow overlay + `/strategy`
explainer); "Tax"/"Notifications" are duplicated labels; and the multi-account model has three un-named
overlapping concepts (Connected Account vs Strategy Profile/preset vs user-global). Owner explicitly
asked for two independent efforts: one informed team, and one that does **not** know the current layout
designing fresh. Then asked to scale it up ("large team… as well as possible").

## Method (how it was produced)
Ran a large orchestrated workflow (`settings-nav-redesign-max`, run `wf_000ecc50-7eb`): **48 agents,
~3.5M tokens, ~48 min**.
- Phase 0: 5 read-only mappers (forensic current-state maps with file:line) + a layout-agnostic
  capability inventory + 6 competitive-pattern researchers.
- Phase 1: **four independent design teams** (~22 designers) — A Informed, B1/B2 Blind-greenfield
  (capability inventory only, forbidden from reading current UI), C Pattern-led.
- Phase 2: adjudication (convergence/divergence/blind-spots) → unified v1.
- Phase 3: 4-skeptic adversarial red-team → architect re-verified against the live tree → v2.
- Phase 4: concrete artifacts (settings tree, migration table, phased plan, wireframes) + completeness
  critic.

An earlier smaller run (`wf_52400b1b-4c4`, ~20 agents) was stopped and superseded when the owner asked
to scale up; nothing from it was committed.

## Headline of the proposal
Independent convergence across teams:
- **The account is the primary object;** scope is a persistent frame, never a destination.
- Navigation collapses from 7 workspace tabs + 4 feed tabs to **six verb destinations** (Dashboard,
  Approvals, Scan[secondary], Strategy, Guardrails, Results) + off-rail Settings + a persistent
  Assistant overlay.
- **Strategy → one editable home** (+ 2 read-only explainers + preset library); Strategy Studio modal
  deleted, the duplicated TuningCard (`dashboard-client.tsx:3725`/`:4441`) collapses to one.
- **Money-reality (Test/Paper/Live) and Authority (Propose/Decide) are two orthogonal dials.**
- **Settings split by scope first** (account vs user), with the tier made explicit; the `Notifications`
  duplicate retired into an Alerts noun-family; the four `/admin/*` routes consolidate under
  Settings→Admin.
- Multi-account: three named entities (Connected Account / Preset / User-global), copy-on-bind presets
  (never live-link), route-encoded scope with **server-side write-time `accountId` validation** as the
  real safety boundary.

## Files (touched this session)
- Added: `docs/settings-navigation-redesign.md`
- Added: `docs/settings-navigation-redesign/appendix-A-current-state-maps.md`
- Added: `docs/settings-navigation-redesign/appendix-B-capability-inventory.md`
- Added: `docs/settings-navigation-redesign/appendix-C-patterns-research.md`
- Added: `docs/settings-navigation-redesign/appendix-D-design-A-informed.md`
- Added: `docs/settings-navigation-redesign/appendix-E-design-B1-blind.md`
- Added: `docs/settings-navigation-redesign/appendix-F-design-B2-blind.md`
- Added: `docs/settings-navigation-redesign/appendix-G-design-C-pattern-led.md`
- Added: `docs/settings-navigation-redesign/appendix-H-adjudication.md`
- Added: `docs/settings-navigation-redesign/appendix-I-unified-v1.md`
- Added: `docs/settings-navigation-redesign/appendix-J-red-team.md`
- Updated: `STATUS.md`, `PLAN.md`, this rollout note.
- Cross-referenced (not modified): `docs/settings-and-universe-overhaul-plan.md` (complementary
  field-completeness program; the new field-level settings tree is the join point).

## Verification
Docs-only change — no code touched, so the tsc/test/build trio was not required to run and was not run.
The design's own factual anchors were re-verified against the live tree *inside the workflow* by the
red-team and completeness-critic agents (e.g. wash-sale enforced `policy.ts:311`; flat-`Set` return +
`test→paper` leak `tax.ts:99/113`; `USER_LEVEL_POLICY_FIELDS`=3 `db-profiles.ts:20-24`; not-active→
halted coercion `:284/350/397`; ambient mirror `:486/512/531`; twin TuningCard `dashboard-client.tsx:
3725/4441`; 6 `openSettings("operate")` sites `:1514/1555/1562/1583/1709/1818`).

## Follow-ups / open items (not yet done)
- **This is a proposal, not an implementation.** No app behavior changed. Owner should approve the
  direction + the Open Questions (Part I) before the deep phases.
- **Phase 1 is safe to start on approval** (pure relabel + surfacing the existing account/user scope
  tag; touches only copy, no data path) — a good first PR to validate the direction cheaply.
- Must-fix-before-build items the completeness critic flagged (Part III): reorder/firewall the
  view↔execution decouple (P2) relative to any account-switching UI; design the post-singleton
  per-account arming + scheduler fan-out with a schema anchor; resolve the localStorage shim trigger and
  the `getUserWashSaleLockedSymbols` return-type blast radius (both silent-failure changes); clarify
  the "max position size" Essentials field mapping; reconcile mobile deferral vs the P0 "switcher+STOP
  survive on /mobile" requirement.
- Seven Open Questions for the owner are listed at the end of Part I (e.g. `marketScan*` per-account
  scoping; whether Fleet STOP hits Paper; vocabulary lock-in: "Preset"/"Results"/"Alerts").

---

## Update 2 (later 2026-07-01) — owner approved; full implementation spec built

Owner approved the design ("love it") and answered all 7 open questions. Ran a second large workflow
(`wf_598c6d71-77d`: **16 agents, ~1.67M tokens**) to flesh the approved design into a complete
implementation-ready spec: 4 code-grounding readers → 11 parallel spec authors → a consistency/closure
editor. Deliverable committed under `docs/settings-navigation-redesign/spec/`:
- `00-README.md` (index + reading order + owner decisions log + editor's resolutions), `00-reconciliation-report.md`.
- `01-global-frame` · `02/03` destinations · `04-settings-field-reference` (every field) · `05-scoping-and-safety-model` ·
  `06-data-model-and-api-changes` · `07-frontend-architecture-and-decomposition` · `08-delivery-plan-prs-and-tests` ·
  `09-copy-deck` · `10-onboarding-modes-and-first-run` · `11-accessibility-responsive-mobile`.
- `grounding/` — authoritative code-fact extracts (policy field catalog, client structure, API/schema, onboarding/mobile).

**Owner decisions locked:** marketScan* stays user-global; autonomy-reset-on-restart required + default ON;
Fleet STOP = Live+Paper (Test excluded); thin `/a/:accountId` + server-side write validation; full
Preset/Results/Alerts vocabulary; full mobile parity specified; single-account stale-id auto-resolves.

**Editor's reconciliation found (and I resolved via `00-README.md` R1–R8):** the autonomy-reset primitive
already EXISTS (`scheduler.ts:66-97`, per-user `autoResumeOnBoot`) so the net-new work is scoped to
default-ON + per-account granularity + `armed_boot_epoch` + chrome (not a from-scratch build); the scheduler
already fans out per-account (`scheduler.ts:211-310`); wash-sale anchors corrected to `tax.ts:104` (inner) /
`:115` (wrapper) / `:117` (Test→paper leak), not the design doc's stale `:99`; "max order size" Essentials
bound to `maxOrderNotional` (position cap stays Exposure→per-symbol %); admin routes kept as shell deep-link
targets (no deletion); `/how-it-works` redirect gated by `LANDING_PAGE_ENABLED`; Studio modal flag-retained
one release; localStorage shim runs flag-independently with a one-release read-fallback.

**Forward-looking fields folded in** (owner relay, additive/default-off, no UI dependency): `policy.llmFallbackModels`
→ Strategy/AI Review (optional Advanced); `policy.tuning.gateOnRationaleCollapse` → Guardrails/Learning
(optional Advanced); `trade_proposals.prompt_version` → optional provenance chip. See the
"Forward-looking / optional fields" section in `04-settings-field-reference.md`.

**Still no app code changed** — the spec is docs. Verify trio not required/run.

## Update 3 (2026-07-01) — clickable prototype

Built a self-contained interactive prototype at `docs/settings-navigation-redesign/prototype/index.html`
(vanilla HTML/CSS/JS, mock data, no deps) demonstrating the shell + all six destinations + account
switcher + Fleet + Settings. Verified by rendering with the pre-installed headless Chromium
(`/opt/pw-browsers/.../headless_shell`, `--screenshot`) across Dashboard, Live-account Approvals (red
real-money treatment + mode-stamped Approve + wash-sale provenance card), Guardrails (Essentials→Advanced
+ scope pills), Settings (scope-split), and Fleet (STOP all Live+Paper, Test excluded). Fixed two render
bugs found via screenshot (toggle `display:inline-block`; nav truncation vs risk strip). Deep-link params
(`?acct=&dest=&adv=1`) added for sharing specific screens. See `prototype/README.md`.

**Next:** start delivery-plan **PR #1** (relabels + scope-surfacing) on the owner's word — pure copy/UI,
no data path, the safe first real-code step.
