# Reconciliation & Consistency Report — Settings/Nav Redesign Spec (11 sections)

Ground truth: `docs/settings-navigation-redesign.md` (v2) + LOCKED DECISIONS (owner, 2026-07-01) + live code verified this session (`scheduler.ts:66-97`, `tax.ts:99/113/104`, `mobile-api.ts:647-651`, `db-profiles.ts:20-24`).

---

## 1. CONFLICTS (two sections disagree → fix + authority)

**C1 — Autonomy-reset-on-restart: "net-new" vs "already exists." [HIGH]**
- §05 (Scoping/Safety) §0.1 states the mechanism **exists and is authoritative** (`reconcileAutonomyOnBoot()`, `scheduler.ts:66-97`), and frames net-new work as only (a) default-ON contract, (b) chrome surfacing, (c) per-account opt-in granularity.
- §01 (Global Frame) §9 and §06 (Data-Model) §2 call it **"net-new"** and design a fresh `armed_boot_epoch` persistence + reset mechanism.
- LOCKED DECISIONS: "REQUIRED and DEFAULT ON… Spec it as net-new (build regardless of whether an equivalent exists today); design the persistence + reset mechanism."
- **Reality:** §05 is factually right — the function exists. But it is **per-user opt-in (`autoResumeOnBoot`), defaulting to reset**, and iterates every account. It is NOT default-ON-un-overridable, NOT per-account granular, and has no boot-epoch anchor.
- **Fix / authority:** Reconcile the *words*, not the intent. All three sections must state: "the boot-reconcile primitive exists (`scheduler.ts:66-97`); the net-new work is (i) make reset default-and-un-overridable-by-accident, (ii) migrate `autoResumeOnBoot` from per-user to per-account, (iii) add `armed_boot_epoch` (§06 v9) as the anchor, (iv) surface post-reset state in chrome." **§06's schema (`armed_boot_epoch`, migration v9) is authoritative for persistence; §05 is authoritative for the existing fan-out semantics; §01 owns the chrome surfacing.** Delete the bare "net-new" claim from §01/§06 and replace with "extends the existing `reconcileAutonomyOnBoot`." The LOCKED "spec as net-new" instruction is satisfied by building the mechanism fully — but the spec must not *claim* nothing exists, or an implementer duplicates `scheduler.ts` logic.

**C2 — Wash-sale env override name for reset. [LOW]**
- §05 cites `AUTONOMY_RESUME_ON_BOOT=1` env override (matches code). §01/§06 design a reset with no mention of the existing env override. **Fix:** §01/§06 must acknowledge `AUTONOMY_RESUME_ON_BOOT` exists and state its fate (per LOCKED "un-overridable-by-accident" → likely deprecate the global env override, keep per-account opt-in only). Authority: §05 for the existing override; the deprecation decision must be stated in §06 (owning the schema/migration).

**C3 — Wash-sale underlying function name + which function changes. [MEDIUM]**
- §08 (Delivery) inventory: consumers `policy.ts:321`, `strategy.ts:219`, `strategy.ts:1552`; underlying `getWashSaleLockedSymbolsForUser` (`tax.ts:99`? — actually `:104`) returns `Set<string>`.
- Design doc + §02/§03 reference `getUserWashSaleLockedSymbols` at `tax.ts:99`.
- **Reality (verified):** BOTH exist — `getWashSaleLockedSymbolsForUser(accounts,…)` (`tax.ts:104`, takes contexts) and the convenience wrapper `getUserWashSaleLockedSymbols(userId,…)` (`tax.ts:115`). Both return `Set<string>`. The Test→paper leak is in the **wrapper** (`tax.ts:117`: `broker === "test" || environment === "paper" ? "paper" : "live"`), not in `getWashSaleLockedSymbolsForUser`. **Fix / authority:** §08's consumer inventory is authoritative and must be adopted verbatim by §02/§03/§06; the return-type change touches BOTH functions (provenance must flow through the inner one). The "`tax.ts:99`" anchor is stale across §02/§03/design — correct to `:104`/`:115`. **The Test filter belongs in the wrapper at `:117`.**

**C4 — "Max position size" backing field. [MEDIUM]**
- §03 (Guardrails) §0.2 example uses max-position-size → "risks at most $1,000." §04 (Field Reference) A/Essentials maps it to `maxOrderNotional / % NAV mirror`. Design Part III gap #4 flags this exact ambiguity (position ≠ order).
- **Conflict:** §04 maps the Essentials "max position size" to `maxOrderNotional` (a *single-order* cap), but the label says *position* (total holding). §03's consequence-preview copy ("risks at most $X") reads like order-level too.
- **Fix / authority:** Per LOCKED "resolve concretely." Decide one: the Essentials control caps **`maxOrderNotional`** (single order) and is **relabeled "Max order size"** — OR it caps a derived per-symbol position via an exposure field. Recommended: relabel to "Max order size" wired to `maxOrderNotional`, because that field exists and is enforced; a true position cap needs `per-symbol cap %` (Exposure section) which is a different control already listed. **§04 is the authoritative field catalog — it must pick the field and fix the label; §03 must match §04's choice in its consequence-preview copy.** This is currently unresolved in both.

**C5 — Confirm-phrase wording drift. [MEDIUM]**
- §09 (Copy Deck) §0 defines exact constants: `ARM_LIVE_PHRASE = "ARM LIVE"`, `FLATTEN_LIVE_PHRASE = "SELL LIVE POSITIONS"`, `FLEET_STOP_PHRASE = "STOP ALL"`, `ENABLE_SHORTING_PHRASE = "ENABLE SHORTING"`.
- §03/§04 refer to "type-to-confirm" for the two one-way doors + Live loosening but do **not** cite the constant names.
- **Fix / authority:** **§09 is the single source of truth for all user-facing strings and confirm phrases.** §03, §04, §08, §10 must import from `src/lib/copy/confirm-phrases.ts` and never inline literals. Add a cross-ref line in §03/§04 pointing at §09 §0. (§09 already flags this as the silent-mismatch trap.)

**C6 — Flatten phrase vs existing "APPROVE LIVE" convention. [LOW]**
- §09 introduces `FLATTEN_LIVE_PHRASE = "SELL LIVE POSITIONS"`. Existing tree uses `CONFIRMATION_PHRASE_PREFIX = "APPROVE LIVE"` + `ACCOUNT_DELETE_PHRASE = "DELETE MY ACCOUNT"`. No conflict in convention (all uppercase/space-delimited), but §09 must confirm STOP itself takes **no** phrase (LOCKED: STOP is one click, never sells). **Fix:** §09 already says STOP ≠ Flatten; ensure §01 (`RunStateButton` when rendering STOP) and §08 [KILL-1CLICK] both assert STOP has zero confirm and only Flatten uses `FLATTEN_LIVE_PHRASE`. Consistent today; keep the cross-ref explicit.

**C7 — `activeAccountId` view-scope store location. [LOW]**
- §01 §0 puts the ephemeral view-scope store at `src/lib/shell/view-scope.ts`. §02 uses `activeAccountId` as "per-tab, plural-safe, post-P2." §06 §1 defines persisted execution-scope columns on `account_strategy_state`. No direct conflict, but §02 must reference §01's `view-scope.ts` as the owning module and §06's `armed_authority`/`armed_boot_epoch` as the execution-scope store, so the two-store split is named identically everywhere. **Authority:** §01 owns view-scope store; §06 owns execution-scope schema.

**C8 — Fleet STOP scope: Paper inclusion. [MEDIUM]**
- LOCKED DECISIONS: "FLEET EMERGENCY STOP: halts all Live + all Paper accounts; EXCLUDES Test/local-sim. Live listed first." Design Open Q3 left Paper as an open question ("Recommendation: Live + Paper halt; Test excluded — confirm").
- **Conflict:** Open Q3 is now **RESOLVED by LOCKED** (Live+Paper, Test excluded). Any section still treating it as open (design doc Open Q3, and Part III gap #9's "all-Paper multi-account" worry) must be marked resolved. §01 (`RunStateButton`/Fleet STOP) and §08 (PR#12 deferred fleet-STOP) and §09 (`FLEET_STOP_PHRASE`) must all state: **Live+Paper included, Test excluded, Live listed first, per-account confirmed-halted echo.** **Fix:** §01 is authoritative for Fleet-STOP behavior; it must encode the LOCKED scope and note Open Q3 is closed. Gap #9 (all-Paper fleet) is resolved: two Papers → both halted, no auto-resolve (auto-resolve is single-account only).

**C9 — Route-group directory naming. [LOW]**
- §01/§07/§10 use `app/(shell)/…`. §10 puts `/welcome` **outside** `(shell)`; §01 lists `/admin`, `/mobile`, `/welcome`, `/login` as P0 route-group decisions with switcher+STOP surviving on `/admin` and `/mobile`. Consistent. Confirm §07 (decomposition) uses the identical `app/(shell)/layout.tsx` path and `app/(shell)/_components/fields/` — it does. No fix beyond ensuring §02/§03 destination files land under `app/(shell)/` not `app/ui/` (§01 §0 says shell chrome extracted to `app/ui/shell/*`, §03 puts `app/ui/scoped-destination-header.tsx`). **Minor inconsistency:** chrome in `app/ui/shell/*` vs destinations implied under `app/(shell)/`. **Fix:** §07 is authoritative for the decomposition target layout; align §01/§03 component paths to §07's tree (§07 already establishes `./ui/` precedent → `app/(shell)/…` migration).

**C10 — `NAV_V2` sub-flag inventory. [LOW]**
- §08 defines sub-flags `STRATEGY_CONSOLIDATION` (PR#6), `MULTI_ACCOUNT_CHROME` (PR#10). §03 cites `STRATEGY_CONSOLIDATION`. §01/§02/§10 cite only `NAV_V2`. No conflict, but `MULTI_ACCOUNT_CHROME` appears only in §08 — §01 (switcher states), §10 (mobile parity), and §11 must reference it as the gate for switcher-list/Fleet/scope-tags. **Fix / authority:** §08 is authoritative for the flag/sub-flag list; §01 and §10 must name `MULTI_ACCOUNT_CHROME` where they describe multi-account chrome suppression.

---

## 2. MUST-FIX CLOSURE (Part III gaps → resolving section, concrete & sufficient?)

**Gap #5/#1 — P2 decouple sequencing (view/execution firewall).** → **§08 (Delivery Plan). RESOLVED, concrete & sufficient.** PR#7 is an explicit hard gate ("⛔ GATE"); PRs #9/#10/#11 carry merge-gate CI assertions that fail if the coercion (`db-profiles.ts:284/350/397`) or mobile singleton setter (`mobile-api.ts:649`) still exists. §10 adds a matching "hard sequencing rule." **Sufficient.** One tightening: §08's CI assertion must also cover `strategy.ts` consumers if they touch active-singleton (verify).

**Gap #7 — per-account arming + scheduler fan-out schema anchor.** → **§05 (Scoping/Safety) + §06 (Data-Model). RESOLVED, concrete.** §05 §0.2 proves the scheduler **already** fans out per-account (`scheduler.ts:211-310`, `listConnectedAccounts`, per-`(userId,accountId)` `scheduleKey`), so P2 is a read/write-path fix, not a scheduler rewrite. §06 v9 adds `armed_authority`/`armed_at`/`armed_boot_epoch` to `account_strategy_state` as the persisted plural-arming anchor. **Sufficient** — the previously-"undefined" scheduler semantics are shown to already exist. Ensure §06's removal of the coercion (§1.2) is cross-referenced by §05 §3/§6.

**Gap #8 — wash-sale return-type + consumer inventory.** → **§08 + §06. RESOLVED, concrete.** §08 enumerates consumers (`policy.ts:321`, `strategy.ts:219`, `strategy.ts:1552`) and names the inner fn returning `Set<string>`; §06 §4 designs the provenance return type. **Caveat (see C3):** the anchor `tax.ts:99` is stale (real: `:104` inner / `:115` wrapper), and BOTH functions return Sets — the provenance change must thread through both, and the Test filter lives at the wrapper `:117`. **Sufficient once C3's dual-function correction is applied.** Add [WASH-SALE] compile-time-break requirement: change the type so `policy.ts:321`'s `.has()` fails to compile rather than silently mis-shaping (§08 [WASH-SALE] item already asks for this — good).

**Gap #10 — localStorage shim trigger.** → **§07 (Frontend) + §08. PARTIALLY RESOLVED — verify wording.** Design gap #10 is the contradiction "shim deletes old keys but flag may be off." §08 PR#2 and §07 §1.2 must state unambiguously: **shim runs flag-independently, once, and keeps a one-release read-fallback to old keys** (per Part III "3 fixes" #3a). Confirm §07 explicitly says the shim is NOT gated by `NAV_V2` and preserves a read-fallback. **Flag:** if §07/§08 leave the run-condition ambiguous, this is STILL OPEN. Must assert: shim trigger = first load post-deploy, flag-independent, idempotent, read-fallback for one release.

**Gap #3/#11 — mobile singleton setter (`mobile-api.ts:648-651`).** → **§06 + §08 + §10 + §11. RESOLVED, concrete.** Verified: `account.activate` calls `setActiveConnectedAccount` directly (the side-door). §06 re-points it at the view-scope/arming split; §08 PR#7 merge-gate CI fails if `mobile-api.ts:649` still calls the old singleton; §10/§11 (accessibility/mobile) specify parity. **Sufficient.** Ensure §06 names the exact new function mobile calls (view-scope setter, NOT arming).

**Gap #4 — "max position size" field mapping.** → **§04 (Field Reference) + §03. NOT YET RESOLVED (see C4).** Both sections touch it; neither picks the field concretely. **STILL OPEN.** §04 must bind the Essentials control to a named field and fix the label ("Max order size" → `maxOrderNotional`, or define a derived position quantity). This is the one MUST-FIX where the resolution is currently absent, not just inconsistent.

**Also-open Part III items (not in the 6 named, but flagged):**
- **Gap #1 (admin route fate):** No section states whether `app/admin/{connections,llm-usage,rag-coverage,transcript}/` routes are deleted, redirected, or kept as deep-link targets. §08/§11 touch Admin consolidation but don't decide. **OPEN — assign to §08 (delivery) or a settings section.**
- **Gap #2 (`/strategy`→`/how-it-works` + `LANDING_PAGE_ENABLED` redirect mechanics):** §10 mentions the rename but not whether the redirect is gated. **OPEN — assign to §10.**
- **Gap #6 (Studio modal: dead-but-flagged vs removed):** §03/§07 delete Studio inline; neither states if the modal JSX is flag-retained for rollback like TuningCard. **OPEN — assign to §07 (decomposition) / §08 PR#5.**

---

## 3. COVERAGE GAPS (implementer needs, no section covers)

1. **`GET /api/shell/scope` full response schema.** §01 §1.3 starts the `ShellScope` interface but the excerpt truncates mid-`activeAccount`. No section gives the complete contract (risk block fields, badge counts, halt state, single-vs-multi flag). Blocks §02/§03 header wiring. **Owner: §01 must complete it.**
2. **Admin `/admin/*` route disposition** (Part III gap #1) — delete vs redirect vs deep-link. No section decides.
3. **`/how-it-works` redirect + `LANDING_PAGE_ENABLED` interaction** (gap #2) — unspecified.
4. **Studio modal container fate under flag** (gap #6) — unspecified.
5. **Migration rollback/`down()` scripts** for §06 migrations v9–v11. §06 says "what changes → file → migration/rollback" but the excerpt shows no `down()` bodies. Confirm each migration has a rollback (CLAUDE.md: additive `ALTER` guarded by `PRAGMA table_info`; document irreversibility if columns can't be dropped in SQLite).
6. **`Modal` focus-trap fix ownership.** §11 flags `app/ui/overlays.tsx:62` has no focus trap / no initial-focus — a prerequisite for switcher/STOP-in-overlay. §11 requires the fix but no section *owns the implementation PR*. **Assign to §07 or §08 as a pre-req PR.**
7. **`prefers-contrast` / `forced-colors`** — §11 notes they're unhandled and net-new but the actual token/CSS work isn't scoped to a PR in §08.
8. **SSE `alert` event contract** for §01 AlertsDropdown (`GET /api/alerts?scope=active` + SSE) — the event shape isn't defined in any section.
9. **Per-account `armed_at`/authority read API** (`§06 §5.4 AccountArmingState`) — the endpoint path/response used by §01 chrome and §10 mobile isn't cross-referenced into those sections.
10. **`density` token implementation** — §11 lists `density` as a net-new Appearance field but no design tokens/CSS var are specified (only `theme` exists today).

---

## 4. RECOMMENDED READING ORDER / INDEX

Read the canonical `docs/settings-navigation-redesign.md` (v2) first — everything below is a deep-dive on one slice of it. Then:

1. **`00` (canonical, external)** `docs/settings-navigation-redesign.md` — the v2 design: principles, 6-destination IA, multi-account model, settings tree, wireframes, migration table, phased plan, Part III gaps. Ground truth for all 11.
2. **`05-scoping-and-safety-model.md`** — the substrate. Three entities, three-tier resolution, the P2 view/execution decouple, scheduler fan-out, autonomy-reset. **Read before any UI section** — it defines what "scope" means and corrects two design-doc assumptions.
3. **`06-data-model-and-api-changes.md`** — the backend contract: migrations v9–v11, arming columns, coercion removal, wash-sale provenance return type, mobile setter re-point. The schema every UI section wires against.
4. **`07-frontend-architecture-and-decomposition.md`** — how the 7,015-line `dashboard-client.tsx` is strangler-figged into the `(shell)` route-group + per-destination modules. The extraction map.
5. **`01-global-frame.md`** — the persistent three-zone chrome: switcher, money-reality/authority/halt badges, Run-once, STOP, `ShellScope` contract, autonomy-reset chrome. The frame every destination renders into.
6. **`02-destinations-dashboard-approvals-scan.md`** — Dashboard (+ Fleet), Approvals (HITL queue, wash-sale culprit card), Scan (read-only). Three of six destinations.
7. **`03-destinations-strategy-guardrails-results-assistant.md`** — Strategy (one editable home), Guardrails (Essentials+Advanced), Results, Assistant overlay. The other three + overlay; shared `ScopedDestinationHeader` + consequence-preview engine.
8. **`04-settings-field-reference.md`** — the exhaustive per-field catalog (every `TradingPolicy` field → new home, scope, control, default, friction). The lookup table §02/§03 wire to.
9. **`09-copy-deck.md`** — every user-facing string + confirm-phrase constants (`src/lib/copy/*`). Single source of truth for labels/phrases; all sections import from it.
10. **`10-onboarding-modes-and-first-run.md`** — zero-account flow, Test auto-provision, Test→Paper→Live + Propose→Decide rituals, autonomy-reset, mobile parity.
11. **`11-accessibility-responsive-mobile.md`** — keyboard/focus model, non-color safety cues, Live-red viewport, responsive collapse, `Modal` focus-trap fix, Appearance settings.
12. **`08-delivery-plan-prs-and-tests.md`** — read LAST as the execution spine: ordered PR#1–#14, the P2 firewall gate, do-not-break checklist, per-PR tests. Ties all sections into merge order.

**One-line rule for the folder:** 05/06/07 = substrate; 01–04 = surfaces; 09/10/11 = copy/flows/a11y; 08 = the order you build them in.
