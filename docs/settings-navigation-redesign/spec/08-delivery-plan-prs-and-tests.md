# Settings & Navigation Redesign — Ordered Delivery Plan (PR-by-PR Build Spec)

**Author's contract:** This is the normative, ordered PR list that executes the 5-phase plan in [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) §II-D. It does **not** restate the design — read Part I/II for the *what* and *why*. This document is the *how, in what order, behind which flag, with which tests, and what can never break*. Every PR is independently shippable behind `NAV_V2` (env + localStorage override) unless flagged "no flag needed."

The critic's #1 fix (Part III, "3 most important fixes") is encoded structurally here: **the view/execution decouple + server-side write-time `accountId` validation (PR #7) is a hard gate that must land before ANY account-switching chrome (PR #9+) merges.** This is enforced as an explicit ordering dependency and as a per-PR merge-gate checklist item, not prose.

---

## Global conventions (apply to every PR)

- **Flag:** one client flag `NAV_V2` (env `NAV_V2` + `localStorage` override `nav-v2`). Sub-flags: `STRATEGY_CONSOLIDATION` (PR #6), `MULTI_ACCOUNT_CHROME` (PR #10). A phase is dark-launchable and rolled back by flag flip, never a revert.
- **`SettingsSection` union ids never churn.** Renames are label + redirect only. Ids remain routing/redirect keys even when the live section relocates off the modal.
- **Old `WorkspaceTab`/`FeedTab` values persist as redirect aliases** through the whole migration.
- **Verify trio + lint before every merge:** `npx tsc --noEmit` → `npm test` → `npm run build`, plus `npm run lint`. Each PR enumerates and updates its own broken tests in the same PR (the build gate only catches label/`openSettings`/feed-tab/Studio assertions if co-sequenced — CLAUDE.md handoff protocol).
- **Handoff protocol per PR:** update `STATUS.md`, add a `docs/rollouts/YYYY-MM-DD-*.md` note, update `PLAN.md` and the relevant phase doc, reference touched docs in the commit message.

### The do-not-break guardrail checklist (verified against every PR)

Copy this block into every PR description; check each item or mark N/A with a one-line reason:

1. **[EXEC-MODE]** Execution modes (Test→Paper→Live) untouched. IA work never adds a path that arms an account. Only PR #7 changes execution wiring, and only to *remove* silent coercion. `npm test` on policy/execution suites green.
2. **[KILL-1CLICK]** Kill switch is one click, always safe, **never sells**. STOP ≠ Flatten. Flatten stays a separate secondary action (confirm; type-to-confirm on Live). Chrome STOP + `/admin` system-halt survive every shell change.
3. **[ADMIN-GATE]** Admin stays role-gated + conditionally rendered. Moving its entry point never changes its gating. All four `/admin/*` targets stay behind the same role check.
4. **[PALETTE-MONEY]** ⌘K palette "run once" inherits the exact money-reality gating of the chrome Run button. No Live execution reachable from the palette without the arm ritual.
5. **[USER-FIELDS-SSOT]** `USER_LEVEL_POLICY_FIELDS` (`db-profiles.ts:20`) is the single source of truth for scope. Any scope change = Set edit + migration + per-account back-fill **in one PR** + a round-trip read-after-write test per field. Never half-migrate `marketScan*`.
6. **[WASH-SALE]** Wash-sale enforcement (`policy.ts:321`, "cannot be silently bypassed") is authoritative and is never weakened. Surfacing/provenance/Test-filter changes (PR #8) must keep the block gate intact; add a test that a Test-account loss does **not** lock a real taxable account.

---

## PR ordering at a glance (the dependency spine)

```
PR#1  Vocab/label de-dup + scope-surfacing        [Phase 1] — NO FLAG, ships first
PR#2  DestinationTab mapping + localStorage shim   [Phase 2]
PR#3  Settings scope-first tree + search index     [Phase 3a]
PR#4  openSettings call-site rewrites + Admin cons. [Phase 3b]
PR#5  Strategy consolidation (Studio→inline)       [Phase 4a]
PR#6  TuningCard merge (highest-risk)              [Phase 4b, STRATEGY_CONSOLIDATION]
────────────────────────────────────────────────────────────────────────────────
PR#7  ⛔ GATE: view/exec decouple + server write-validation + arming schema  [Phase 5, P2]
       ↑ NO account-switching chrome (PR#9+) may merge before THIS lands ↑
────────────────────────────────────────────────────────────────────────────────
PR#8  Wash-sale provenance return-type + Test filter [Phase 5]
PR#9  Nav shell (three-zone frame) + STOP/Flatten split [Phase 5, P0-shell]
PR#10 Account switcher + single-account-first rollout [Phase 5]
PR#11 Approvals destination + wash-sale culprit-naming UI [Phase 5]
PR#12 (deferred) Fleet aggregation + fleet-STOP
PR#13 (deferred) /a/:accountId route-encoding
PR#14 (deferred) Mobile account-scope parity
```

**The gate, stated once, normatively:** PRs #1–#6 change **only labels, mapping, settings structure, and strategy consolidation** — none introduce chrome that *changes account context*. PR #7 is the first blocking safety migration (view/execution decouple + server-side write-time `accountId` validation + the plural-arming schema). **No PR that renders an account switcher, a Fleet control, a route-scope selector, or any UI that mutates the active account may merge before PR #7 is on `main`.** This closes Part III gap #5 and #1. Enforcement mechanism: PR #9/#10/#11 each carry a merge-gate assertion (below) that fails CI if the not-active→halted coercion (`db-profiles.ts:284/350/397`) or the mobile singleton setter (`mobile-api.ts:649`) still exists in its old form.

---

## PR #1 — Vocabulary, label de-duplication, and scope-surfacing

> **Status (2026-07-01): LANDED** on `claude/settings-navigation-redesign-a3k1yv-mce45j`. New shared module
> `app/settings-scope.ts` (scope-tag SSOT) + `test/scope-tag-render.test.ts`; relabels + settings-header
> `THIS ACCOUNT`/`ALL ACCOUNTS` tags in `app/dashboard-client.tsx`. Kill-button handler byte-identical.
> tsc/lint/test/build green. See `docs/rollouts/2026-07-01-nav-v2-pr1-relabels-scope-surfacing.md`.

**Phase:** 1. **Flag:** none (pure clarifying copy on current IA; safe ahead of the shell). **Effort:** S. **Risk:** Low.

**Goal.** Kill duplicated-label confusion and make the already-coded but hidden account-vs-user tier split legible, without moving a panel or touching a data path.

**Exact scope (files/areas).**
- `app/dashboard-client.tsx`: label strings only — settings section `notifications` → **"Alert delivery"**; feed `Notifications` → **"Alert history"**; chrome notification dropdown → **"Alerts"**; destination-label prep "Review" → **"Results"**, `Strategy Profile` → **"Preset"**, `Display` → **"Appearance"**, `Data` → **"Data & Privacy"**; retire the bare noun "Notifications." Relabel chrome **"Halt & Flatten" → "STOP"** with tooltip "halts new activity, never sells" (handler untouched — split lands in PR #9).
- Surface the tier split: read `ACCOUNT_SETTINGS_SECTIONS` / `settingsTierForSection` (`dashboard-client.tsx:165-168`) and render a **`THIS ACCOUNT` vs `ALL ACCOUNTS`** scope tag on each settings-section header. Data already exists; this only displays it.
- Help "Settings Glossary" + command-palette entry labels updated in lockstep (same PR).
- No `src/lib/*`, no API, no schema.

**Flag it ships behind.** None. Strictly clarifying copy on the current IA.

**Acceptance criteria.**
- No occurrence of the bare user-facing noun "Notifications" remains as a nav/section label (webhook-error strings that contain "Notifications" are data, not labels — out of scope).
- Every settings section header shows a `THIS ACCOUNT` or `ALL ACCOUNTS` tag matching `settingsTierForSection`.
- Chrome kill button reads "STOP"; tooltip states it never sells; handler unchanged (diff shows no handler edit).
- Help glossary + palette labels match the new copy.

**Tests to add/update — exact grep list (run in `test/`):**
```bash
grep -rn '"Halt & Flatten"\|Halt and Flatten' test/          # relabel → "STOP"
grep -rn '"Review"\|Strategy Profile\|"Display"\|"Data"' test/  # destination/section relabels
grep -rn 'Notifications' test/                                 # DISTINGUISH: label assertions vs webhook-error data
```
Confirmed today: the only `Notifications` hits in `test/` are **webhook-error data strings** in `test/persistence-notification.test.ts:556,586` and `test/dashboard-feed.test.ts:83,91,148,154,171,260` — these assert on `event.error`/`detail` text like `"Notifications Webhook Not Configured"` and are **NOT** nav labels; **do not** rewrite them. Any *new* failures from this PR will be label assertions in dashboard-render tests. Add: a `scope-tag-render.test.ts` asserting each section header renders the correct tier tag from `settingsTierForSection`.

**Do-not-break checklist:** [KILL-1CLICK] STOP relabel keeps one-click-never-sells (handler untouched) ✓ · [ADMIN-GATE] N/A (no admin change) · others N/A (copy-only).

**Rollback.** Revert the copy commit; no flag, no data migration, trivially reversible.

---

## PR #2 — `DestinationTab` mapping layer + one-time localStorage migration shim

**Phase:** 2. **Flag:** `NAV_V2`. **Effort:** M. **Risk:** Medium (shim runs once; a bug silently resets everyone's last tab — affects 100% of returning users).

**Goal.** Introduce the destination vocabulary as a *mapping* over existing `WorkspaceTab`/`FeedTab` values and migrate every returning user's localStorage in one shot, so later PRs re-point a destination's panel without a second migration. Panels don't move; output is byte-identical.

**Exact scope.**
- `app/dashboard-client.tsx`: add `DestinationTab` union mapping onto existing values (`decision→dashboard`, `performance+tax→results`, `notifications(feed)→alert-history`, `strategy→strategy`, `market-scan→scan`, `macro→dashboard`). Renderer resolves destination → current panel.
- Persistence keys at `:197-199` (`WORKSPACE_TAB_KEY`, `FEED_TAB_KEY`, `STRATEGY_TUNING_STORAGE_KEY`); load effects `:280/:290`; persist effects `:1033/:1041`; tab-type guards (`isWorkspaceTab`, `isFeedTab`).
- **One-time shim (same PR):** read old keys → map values → write new keys → delete old.
- Keep old ids as redirect aliases.
- No API/schema.

**Shim trigger — resolves Part III gap #10 (the contradiction) explicitly:**
- The shim **runs flag-independently** (on every client mount, once) — NOT gated on `NAV_V2`. Rationale: if it ran only under the flag but deleted old keys, a flag-off user would be stranded on default.
- The shim is **write-only-additive first, delete-deferred:** it writes new keys and keeps a **one-release read-fallback** to old keys. Old-key deletion is deferred to a *follow-up cleanup PR one release later*, not this PR. So a flag-off render path still finds old keys during the transition release.
- Idempotent: no-op when new keys already exist.

**Acceptance criteria.**
- With `NAV_V2` off: rendering is byte-identical to today; old keys still drive the current tab.
- With `NAV_V2` on: destination resolves to the same panel the old tab id rendered.
- Seed old keys (`workspace-tab=tax`, `feed-tab=notifications`) → after mount, new keys hold mapped values (`results`, `alert-history`); old keys still present (delete deferred); re-mount is a no-op.

**Tests.** Add `destination-shim.test.ts`: (a) seed old→assert mapped new keys written; (b) idempotent re-run no-op when new keys exist; (c) `isWorkspaceTab("tax")` legacy value still resolves via alias; (d) flag-off read-fallback returns old-key value. Update any test asserting on raw `WorkspaceTab`/`FeedTab` string equality.

**Do-not-break checklist:** all N/A except [USER-FIELDS-SSOT] N/A (no scope change). No execution path touched.

**Rollback.** Flag off → old keys drive rendering (read-fallback preserved). The additive-write shim leaves old keys intact this release, so flag-off is fully safe.

---

## PR #3 — Settings scope-first tree + Essentials/Advanced ladder + search index

**Phase:** 3a. **Flag:** `NAV_V2` (+ optional per-section sub-flag for incremental section migration). **Effort:** L. **Risk:** Medium.

**Goal.** Restructure the 9-section modal into the scope-first tree — Scope A (account-scope, heads toward Strategy/Guardrails) vs Scope B (user-scope Settings tree, off-rail) — with an Essentials → one Advanced reveal, and a search index derived from the same field definitions that render the controls.

**Exact scope.**
- `app/dashboard-client.tsx`: reorganize `SettingsSection` rendering into Scope A vs Scope B per §II-B tree. Scope B tree: Account & Security, Connections, Keys & Models, Alert delivery, Data & Privacy, Presets, Appearance, Admin. Ids stable; old→new label redirects.
- Add Essentials → Advanced two-level ladder per surface (Guardrails opens on the 5 Essentials — see field-ambiguity resolution below; origin badges + `Overrides (N)` chip behind Advanced).
- **Settings search index** built from the *same field-definition source* that renders controls (never a parallel list — the enrichment-drift trap, CLAUDE.md). Expert/env flags are search-only, not a third disclosure level.

**Resolve Part III gap #4 ("max position size" ambiguity) here, concretely.** The Guardrails Essentials "max position size" control **binds to `maxOrderNotional`** (single-order cap), **not** a per-symbol position/exposure field. Rationale: it is the existing, always-enforced field with a clear plain-language consequence preview ("this order risks at most $X"). The Essentials label is **"Max order size (per trade)"** to remove the position-vs-order confusion. Per-symbol total-exposure caps stay in Advanced → Exposure (`symbol cap %`). This is a naming + binding decision an implementer can execute without guessing.

**Acceptance criteria.**
- Settings modal renders Scope A sign-post (pointing to Strategy/Guardrails) + Scope B editable tree; governing rule printed on the divider ("if it changes how a trade is decided/placed → account").
- Guardrails opens on exactly 5 Essentials; the rest fold behind one Advanced reveal.
- Search returns any field by label + synonym + section + scope; index provably derived from the control field-definitions (a test that adds a field to the def source makes it searchable without a second list edit).
- `maxOrderNotional` is the sole backing field for the Essentials "Max order size (per trade)".

**Tests.** `settings-tree-scope.test.ts` (each field renders under its §II-B scope); `settings-search-index.test.ts` (index derives from field defs — add-a-field test); `guardrails-essentials.test.ts` (exactly 5 Essentials; Advanced reveal gates the rest). Update tests asserting old flat-9-section structure.

**Do-not-break checklist:** [ADMIN-GATE] Admin section stays role-gated + conditionally rendered (only structure around it changes) ✓ · [USER-FIELDS-SSOT] tree placement reads `USER_LEVEL_POLICY_FIELDS`; no field flips tier ✓ · others N/A.

**Rollback.** `NAV_V2` off → old flat modal renders. Per-section sub-flag allows partial-tree shipping with the old modal as fallback render path.

---

## PR #4 — `openSettings` call-site rewrites + `/admin/*` consolidation

**Phase:** 3b. **Flag:** `NAV_V2`. **Effort:** M. **Risk:** Medium-high (merge-gate enforced). **Depends on:** PR #3.

**Goal.** Rewire the 6 confirmed `openSettings("operate")` sites so relocated sections navigate to their new home instead of opening a gutted modal, and consolidate the four `/admin/*` routes under Settings → Admin.

**Exact scope.**
- `app/dashboard-client.tsx`: rewrite the **6 `openSettings` sites** at `:1514, :1555, :1562, :1583, :1709, :1818` to route to the correct new destination/section (several now point at Strategy→Signals or Guardrails·Execution/Autonomy, not a modal). `:1819` already targets `"data"` → route to Data & Privacy.
- Palette "open Settings section X" + tab-jump commands (`tab-decision`…`tab-strategy` at `:1576-1581`) remapped to new destination ids.
- `app/admin/*`: consolidate connections-health, llm-usage, rag-coverage, transcript under Settings → Admin (role-gated, conditionally rendered). MCP config under Keys & Models → MCP tools. Help MCP tab updated.
- Help "Settings Glossary" rewritten to new taxonomy **in the same PR** (merge requirement).

**Resolve Part III gap #1 (admin route fate) here, concretely.** The four `/admin/{connections,llm-usage,rag-coverage,transcript}` **routes are kept as thin deep-link redirect targets into Settings → Admin** (the Results→History pattern), **not deleted**. `app/admin/layout.tsx` stays as the role-gate wrapper. So: entry points move into Settings; the routes themselves become redirect shims (`/admin/rag-coverage` → open Settings → Admin → RAG). Implementer directive: **do not `rm` the `app/admin/*` route dirs**; convert each `page.tsx` to a redirect/deep-link into the consolidated section, preserving `app/admin/layout.tsx`'s role gate.

**Merge gate (CI-enforced).** `grep`-assert: **no `openSettings(...)` call in `app/**` points at a relocated section** (relocated = `operate`, and any Scope-A section that moved to Strategy/Guardrails). Fails the build if violated (migration #5).

**Acceptance criteria.**
- All 6 `openSettings` sites navigate to their new destination; grep-gate green.
- `/admin/*` routes redirect into Settings → Admin; role gate unchanged; direct nav by a non-admin still 403s exactly as today.
- Help glossary reflects every rename and relocation.

**Tests.** Update every test asserting `openSettings` targets or admin-route rendering — enumerate in-PR. Add `openSettings-relocation.test.ts` (grep-gate mirror as a unit assertion). Add `admin-role-gate.test.ts` regression (non-admin blocked on both old route + new Settings→Admin entry).

**Do-not-break checklist:** [ADMIN-GATE] role gate + conditional render unchanged; only entry point moves ✓ · [PALETTE-MONEY] palette remap doesn't add a Live path ✓ · others N/A.

**Rollback.** `NAV_V2` off → old `openSettings`/modal path + standalone admin routes. Redirect shims are inert with the flag off.

---

## PR #5 — Strategy consolidation: Studio modal → inline home; explainers reclassified

**Phase:** 4a. **Flag:** `NAV_V2`. **Effort:** M. **Risk:** Medium. **Depends on:** PR #3.

**Goal.** Collapse the scattered strategy config into the single editable Strategy destination and reclassify the two read-only explainers, **without** yet merging the duplicated TuningCard (that is PR #6, isolated).

**Exact scope.**
- `app/dashboard-client.tsx`: Strategy workspace tab becomes the editable Strategy destination (Thesis / Signals / AI Review + Presets bar). **Delete Strategy Studio as a modal**; move its contents inline (optional full-screen *mode* preserves distraction-free feel).
- Settings → "Strategy" section → **one-line pointer** to the Strategy destination for one release (removal in a later cleanup PR).
- `app/ui/strategy-flow.tsx`: reclassify as read-only "Understand" explainer (Flow toggle overlay; reachable from Strategy + Dashboard + palette; reads state, never edits).
- `app/strategy/page.tsx`: rename route `/strategy` → `/how-it-works`, linked once from editor footer + Help.
- Autonomy dial stays in Guardrails (do **not** add it to Strategy).

**Resolve Part III gap #6 (Studio modal flag fate) here, concretely.** The **Studio modal container JSX is flag-retained (dead-but-`NAV_V2`-gated) for one release**, so rollback is a flag flip, not a revert. Its *contents* render inline in Strategy under the flag. After one clean release, a cleanup PR removes the dead modal JSX. Implementer directive: keep the modal component behind `!NAV_V2`; do not delete it outright this PR.

**Resolve Part III gap #2 (`/how-it-works` + `LANDING_PAGE_ENABLED`) here, concretely.** The rename **preserves the `LANDING_PAGE_ENABLED` gate**: `/how-it-works` is gated identically to the old `/strategy`. The old `/strategy` path becomes a redirect to `/how-it-works` that is **also gated** — when `LANDING_PAGE_ENABLED` is false, *both* paths 404 (redirect target is gated, so the redirect resolves to a 404). Implementer directive: gate the redirect, not just the destination.

**Acceptance criteria.**
- Strategy destination editable in place; Studio modal not reachable with `NAV_V2` on; modal JSX still present behind `!NAV_V2`.
- Strategy Flow renders as a read-only overlay (no edit affordance).
- `/strategy` redirects to `/how-it-works`; with `LANDING_PAGE_ENABLED=false` both 404; footer/Help link points at `/how-it-works`.
- Settings → Strategy shows only the one-line pointer.

**Tests.** `strategy-destination.test.ts` (inline edit path works); `strategy-flow-readonly.test.ts` (no edit controls); `how-it-works-redirect.test.ts` (redirect + gated-404 both paths). Update tests asserting Studio-modal presence.

**Do-not-break checklist:** all N/A (no execution/scope change). Autonomy dial confirmed NOT added to Strategy ✓.

**Rollback.** `NAV_V2` off → Studio modal + old `/strategy` render (modal JSX retained).

---

## PR #6 — TuningCard merge (single highest-risk change)

**Phase:** 4b. **Flag:** `NAV_V2` + dedicated `STRATEGY_CONSOLIDATION` sub-flag. **Effort:** M. **Risk:** High (design names this the highest-risk change). **Depends on:** PR #5.

**Goal.** De-duplicate the twin TuningCard (two render sites, same state) down to one instance, with named exit criteria and a flag rollback.

**Exact scope.**
- `app/dashboard-client.tsx`: two render sites at `:3725` and `:4441`, both consuming the same `strategyTuning` state and `snapshot.strategyPrompt`. Collapse to one instance.
- `STRATEGY_TUNING_STORAGE_KEY` (`:199`) localStorage compat preserved.

**Named exit criteria (not "tested end-to-end").**
1. **Precondition assertion:** verify both parents pass an *identical* `snapshot` prop before deleting either (post-merge risk = a patch computed against a stale baseline if the surviving parent reads a different `snapshot`). Grep `strategyTuning` / `snapshot.strategyPrompt` to confirm **no third consumer**.
2. **Apply/discard round-trip test:** generate review → apply → assert the `strategyTuning` patch diffs against the **live** prompt, not stale text.
3. **localStorage-compat check** on `STRATEGY_TUNING_STORAGE_KEY`.

**Acceptance criteria.** One TuningCard instance renders under `STRATEGY_CONSOLIDATION`; both sites coexist under `!STRATEGY_CONSOLIDATION`; round-trip test green; no third `strategyTuning` consumer.

**Tests.** `tuningcard-roundtrip.test.ts` (the named apply/discard round-trip); `tuningcard-storage-compat.test.ts`; a precondition unit test asserting both parents' `snapshot` identity before deletion.

**Do-not-break checklist:** all N/A (no execution/scope/admin change). Pure client-state de-dup.

**Rollback.** `STRATEGY_CONSOLIDATION` off → both sites coexist (the surviving-duplicate deletion is flag-guarded). A bad merge is a flag flip, not a revert.

---

## PR #7 — ⛔ GATE: view/execution decouple + server-side write-time validation + plural-arming schema

**Phase:** 5 (P2 — *the first blocking safety migration, executed here as an isolated PR*). **Flag:** `NAV_V2` for UI seams; the **safety migration itself is not flag-conditional** (removing a coercion must not depend on a client flag). **Effort:** L. **Risk:** Highest — touches the execution singleton and real-money scoping.

**This PR is the gate.** No account-switching chrome (PR #9/#10/#11) may merge before this is on `main`. See "The gate, stated once" above.

**Goal.** Split ephemeral **view-scope** (per-tab, plural-safe) from persisted **execution-scope** (per-account arming, plural); remove the not-active→halted coercion and the ambient mirror; add the load-bearing server-side write-time `accountId` validation; **and design the post-singleton plural-arming persistence + scheduler fan-out** (Part III fix #2).

**Exact scope.**
- `src/lib/db-profiles.ts`:
  - **Remove the not-active→halted coercion** at `:284, :350, :397` (confirmed: three `getActiveConnectedAccount(userId)?.id` guarded coercion points).
  - **Remove the ambient `mirrorPolicyToActiveAccount`** (defined `:249`) from all three call sites `:486, :512, :531`. Split into explicit "set as library default" vs "copy into account X."
  - Split the colliding verbs: `activateAccount` → "switch view" (ephemeral, no execution change); `applyProfileToAccount` → "copy preset in."
- **Plural-arming schema (resolves Part III gap #7 — schema anchor).** `account_strategy_state` is already keyed by `connectedAccountId`. The current `systemState` field IS the per-account arming; the coercion existed *only* to keep the singleton consistent. Post-removal, **each account's `systemState` is independently authoritative** — no cross-account write. **Scheduler fan-out semantics (core execution, not Fleet UI):** a scheduled/cron run **iterates every connected account whose `systemState` is `active` (armed)**, independent of the view-scope pointer. Add a `armed_at` / `armed_by` column (or reuse `systemState` + an explicit `AUTONOMY_RESET_ON_RESTART` sweep) so "armed" is a durable per-account fact, not a function of which account is "active."
- **Autonomy-reset-on-restart (Open Q2 / locked decision — build regardless):** on app/process restart, a startup sweep drops every account's autonomy to its safe floor (Propose-only) until re-armed. Anchor it in `account_strategy_state` (new `armed_at` cleared on boot). Spec'd as net-new per the locked decision.
- **Server-side write-time `accountId` validation (the real safety boundary):** `app/api/profiles/*`, `app/api/connected-accounts/*` — every mutating write re-validates `accountId` against the session; a stale tab cannot act on the wrong account regardless of URL.
- **Mobile singleton hazard (resolves Part III gap #3 / #11's setter).** `src/lib/mobile-api.ts:649` currently calls `setActiveConnectedAccount(accountId, ...)` — mobile **writes the execution singleton**. Re-point this at the new view-scope-vs-arming split so mobile does not become the surviving side-door that re-introduces the coercion P2 deleted.

**Merge-gate assertions (CI, block the gate PR itself and all downstream chrome PRs).**
- `grep`-assert the not-active→halted coercion pattern is gone from `db-profiles.ts:284/350/397`.
- `grep`-assert `mirrorPolicyToActiveAccount` has zero call sites.
- `grep`-assert `mobile-api.ts` no longer calls `setActiveConnectedAccount` as an execution mutation on view-switch.
- A test proving a mutating API write with a stale/mismatched `accountId` is **rejected server-side** against the session.

**Acceptance criteria.**
- Switching the view pointer causes **zero** execution change on any other account (no coercion to `halted`).
- A scheduled run enumerates exactly the accounts whose `systemState=active`, independent of view-scope.
- On restart, every account is Propose-only until re-armed (autonomy-reset sweep runs).
- A stale-`accountId` write is rejected server-side.

**Tests.** `decouple-no-coercion.test.ts` (switch view → other account's `systemState` unchanged); `scheduler-fanout.test.ts` (armed-set iteration independent of active pointer); `autonomy-reset-on-restart.test.ts` (boot sweep → all Propose-only); `write-time-accountid-validation.test.ts` (stale/mismatched id rejected); `mobile-view-scope.test.ts` (mobile switch no longer arms/coerces). Round-trip read-after-write per `USER_LEVEL_POLICY_FIELDS` field.

**Do-not-break checklist:** [EXEC-MODE] this PR only *removes* silent coercion, never adds an arming path — policy/execution suites green ✓ · [KILL-1CLICK] halt semantics preserved; per-account halt stays one-click ✓ · [USER-FIELDS-SSOT] per-field round-trip test ✓ · [WASH-SALE] enforcement untouched (`policy.ts:321`) ✓.

**Rollback.** This is safety-critical and *removes* a hazard; a straight revert restores the coercion. Prefer forward-fix. The UI seams are `NAV_V2`-gated; the coercion removal is not, by design.

---

## PR #8 — Wash-sale provenance return-type + Test-account filter

**Phase:** 5. **Flag:** `NAV_V2` for the UI consumer; the type change is unconditional. **Effort:** M. **Risk:** Medium-high (type change with a blast radius — Part III gap #8). **Depends on:** PR #7 (Test-account classification stabilized) — but independent of switcher chrome.

**Goal.** Change the lockout function to carry per-symbol provenance (contributing account + earliest clear date) and filter Test out of contribution, so the Approvals card (PR #11) can name the culprit — without weakening the authoritative enforcement gate.

**Exact scope + full consumer inventory (verified this session — closes Part III gap #8).**
- `src/lib/tax.ts`:
  - `getWashSaleLockedSymbolsForUser` (`:99`) and `getUserWashSaleLockedSymbols` (`:110`) change return type from bare `Set<string>` to a provenance map `Map<string, { account: string; clearDate: Date }>` (or a `Set` + parallel provenance accessor to minimize blast radius — implementer's call, but the type change must be **compile-time-breaking**, not a silent runtime shape change).
  - **Filter Test out of contribution:** `:113` currently maps `broker === "test"` → `source: "paper"`, so a *simulated* loss can lock a *real* taxable account. Exclude Test from the contribution set before it reaches the lockout.
- **Downstream consumers to update (compile-time break, verified):**
  1. `src/lib/policy.ts:321` — consumes via `.has(symbol)` inside the enforcement gate. Must adapt to the new shape while keeping the block authoritative.
  2. `src/lib/strategy.ts:219` — `washSaleLockedSymbols = getUserWashSaleLockedSymbols(...)`.
  3. `src/lib/strategy.ts:1552` — `washSaleLockedSymbols: getUserWashSaleLockedSymbols(...)`.
  4. Any test asserting on the `Set` shape.

**Directive:** make the return-type change break the build at every consumer (no runtime `.has` on a now-differently-shaped value) — the inverse of the silent-write trap CLAUDE.md warns about.

**Acceptance criteria.**
- Enforcement still blocks (`policy.ts` gate authoritative; "cannot be silently bypassed" preserved).
- A **Test-account loss does NOT lock a real taxable account** (the `:113` leak fixed).
- Provenance available per locked symbol (contributing account + clear date) for the Approvals UI.

**Tests.** `washsale-test-account-excluded.test.ts` (Test loss → no lock on real account — [WASH-SALE] checklist test); `washsale-provenance.test.ts` (locked symbol carries account + clear date); update `policy.ts` gate tests + `strategy.ts` consumer tests for the new shape.

**Do-not-break checklist:** [WASH-SALE] enforcement gate stays authoritative; Test-exclusion test added ✓ · [EXEC-MODE] N/A · others N/A.

**Rollback.** Type change is unconditional; the UI culprit-naming (PR #11) is `NAV_V2`-gated. Forward-fix preferred (a revert restores the Test→real leak).

---

## PR #9 — Nav shell (three-zone frame) + STOP/Flatten split

**Phase:** 5 (P0-shell). **Flag:** `NAV_V2`. **Effort:** L. **Risk:** High. **Depends on:** **PR #7 (GATE — must be on `main`)**.

**Goal.** Land the three-zone frame and the STOP/Flatten split, rendering current destinations behind the flag. No content moves.

**Exact scope.**
- New `app/(shell)/layout.tsx`: three-zone frame (LEFT scope / CENTER spine / RIGHT verbs+risk). Explicit route-group decision: **switcher + STOP survive on `/admin` (system halt) and `/mobile`**; `/login` is outside the shell (pre-auth, no switcher/STOP). `/welcome` disposition per Open Q6 — but the P0 exit criterion "STOP survives on `/mobile`" is honored (resolves Part III gap #11 by having PR #7 already re-point the mobile setter).
- `app/dashboard-client.tsx`: **STOP/Flatten split** — chrome `■ STOP` halts new activity in one click, always safe, **never sells**; **Flatten / sell positions** is a separate secondary action (confirm; type-to-confirm on Live). In Fleet mode this exposes STOP all / Set all close-only (Fleet controls themselves land in PR #12).
- Chrome right zone: ambient risk strip, `▶ Run once` stamped with target, 🔔 Alerts, ⌘K, ? Help, ⦿ Avatar.

**Merge-gate (inherited from PR #7).** CI asserts the coercion/mirror/mobile-setter are already removed (the shell is chrome that *changes account context*, so the gate applies).

**Acceptance criteria.**
- Shell renders current destinations unchanged with `NAV_V2` on.
- STOP is one click, never sells; Flatten is separate and confirmed (type-to-confirm on Live).
- Chrome STOP + `/admin` system-halt survive the shell extraction.
- Run-once button label carries its target + mode.

**Tests.** `shell-stop-never-sells.test.ts` ([KILL-1CLICK] — STOP handler places no sell); `shell-flatten-separate.test.ts` (Flatten is a distinct confirmed action); `admin-system-halt-survives-shell.test.ts`; `palette-runonce-money-gate.test.ts` ([PALETTE-MONEY]).

**Do-not-break checklist:** [KILL-1CLICK] STOP never sells; Flatten separate; STOP survives shell ✓ · [ADMIN-GATE] `/admin` still role-gated inside shell ✓ · [PALETTE-MONEY] run-once palette gated ✓ · [EXEC-MODE] no arming path added ✓.

**Rollback.** `NAV_V2` off → current frame + old combined Halt button (label already "STOP" from PR #1; handler split is flag-gated).

---

## PR #10 — Account switcher + single-account-first rollout

**Phase:** 5. **Flag:** `NAV_V2` + `MULTI_ACCOUNT_CHROME` sub-flag. **Effort:** L. **Risk:** High. **Depends on:** **PR #7 (GATE)**, PR #9.

**Goal.** Ship the account switcher and roll the full IA to **single-account users first**, where scope ambiguity does not exist. Gate all multi-account chrome behind the 2nd-account connection.

**Exact scope.**
- `app/dashboard-client.tsx`: LEFT-zone switcher chip (`alias · broker`, money-reality word-class badge, authority chip, equity + day P&L). Dropdown: portfolio list with **Live grouped first**, a distinct **Sandbox** section for Test/sim (not a peer broker row), + Connect account / Preferences footer.
- **Single-account collapse (P11):** for exactly one account, the chip is **static** (no `▾`); scope tags / origin badges / Fleet suppressed until a 2nd account connects (`MULTI_ACCOUNT_CHROME` gated on account count ≥ 2).
- **Single-account auto-resolve (locked decision / Open Q7):** a stale/one-off account id **auto-resolves to the sole account** rather than failing closed; multi-account users keep the fail-closed default. Resolved by account count.
- Switching-into-Live acknowledgment ("you are now acting on REAL MONEY") + red viewport hairline.

**Merge-gate (inherited from PR #7):** the switcher is "free" **only** because PR #7 removed the coercion. CI asserts the coercion is gone before this merges.

**Acceptance criteria.**
- Single-account user: static chip, zero multi-account chrome; stale id auto-resolves to the sole account.
- Multi-account user: switcher list with Live-first grouping + Sandbox section; switching re-scopes reads in place with no execution change (relies on PR #7); Live switch shows the ack + red hairline.
- Test/sim in Sandbox section, excluded from arm-Live reachability.

**Tests.** `switcher-single-account-collapse.test.ts`; `single-account-auto-resolve.test.ts` (stale id → sole account, not fail-closed); `multi-account-fail-closed.test.ts` (≥2 accounts → unresolved scope blocks scoped actions); `switch-no-execution-change.test.ts` (view switch → no coercion, depends on PR #7); `live-switch-ack.test.ts`.

**Do-not-break checklist:** [EXEC-MODE] switch changes view only, never arms ✓ · [KILL-1CLICK] STOP present in switcher/Fleet context ✓ · gate assertions green ✓.

**Rollback.** `NAV_V2` / `MULTI_ACCOUNT_CHROME` off → static chip / current single-account behavior.

---

## PR #11 — Approvals destination + wash-sale culprit-naming UI

**Phase:** 5. **Flag:** `NAV_V2`. **Effort:** M. **Risk:** Medium. **Depends on:** **PR #7 (GATE)**, PR #8 (provenance return type), PR #9.

**Goal.** Split the Decision tab into Dashboard + Approvals and render the wash-sale lockout with per-symbol provenance on the blocked card (now buildable because PR #8 shipped the provenance type + Test filter).

**Exact scope.**
- `app/dashboard-client.tsx`: Approvals destination (HITL queue). Card: symbol/side/size, thesis + confidence, Bull→Bear→Red-Team, policy-gate checklist, entry-anchor + drift, bracket, **MODE badge ON the Approve button**, **Adjust-and-approve re-runs the full policy gate** on edited size.
- **Wash-sale culprit line** with provenance ("locked by a loss in Robinhood · LIVE · clears Jul 24"), drawn as a **third cross-account tax-coupling class**, not a per-account toggle. Degrades to "locked by a wash-sale in another account" if provenance absent. Test excluded from culprit line (PR #8 filter).
- All-accounts view tags each row with account + mode.

**Acceptance criteria.**
- Approvals renders the queue; MODE badge on Approve button; Adjust-and-approve re-runs the gate on the edited size.
- Wash-sale lockout names the contributing account + clear date; a Test loss never appears as a culprit.

**Tests.** `approvals-mode-badge.test.ts`; `adjust-approve-reruns-gate.test.ts` (edited size hits full gate — never a bypass); `washsale-culprit-provenance.test.ts` (named account + clear date); `washsale-test-not-culprit.test.ts`.

**Do-not-break checklist:** [WASH-SALE] card surfaces provenance without weakening the gate ([policy.ts:321](src/lib/policy.ts) unchanged) ✓ · [EXEC-MODE] Adjust-and-approve re-runs the gate ✓ · [PALETTE-MONEY] N/A.

**Rollback.** `NAV_V2` off → Decision tab; provenance UI dark (type change from PR #8 stays, unused).

---

## Deferred milestones (do NOT block the IA migration)

These are named so they aren't lost, but they are explicitly out of the critical path. Each still carries the do-not-break checklist.

- **PR #12 — Fleet aggregation + fleet-STOP.** New N-account endpoints + fleet-STOP mutation + audit. **Meaningful only post-PR #7** (concurrent-arming model). Fleet STOP hits every Live account unconditionally, Live shown first, confirmed-halted echoed per account. **Open Q3 / Part III gap #9 (all-Paper multi-account):** recommended scope = **Live + Paper halt, Test excluded** — confirm before build; resolve the all-Paper fleet case explicitly (Fleet STOP hits both Papers; auto-resolve does not apply at ≥2 accounts). [KILL-1CLICK] fleet-STOP never sells.
- **PR #13 — `/a/:accountId/` route-encoding.** Thin `[accountId]` catch-all that **seeds and validates** active-account state; the **server-side write guard (PR #7) does the real safety work** — the URL is ergonomics (Open Q4). Not a multi-week monolith split.
- **PR #14 — Mobile account-scope parity.** `/mobile` + `src/lib/mobile-api.ts` adopt the same account-scope context (switcher + STOP + scoped context survive on mobile). Spec is required now (locked decision: mobile/PWA parity specified); implementation lands here. Depends on PR #7's mobile-setter re-point.

---

## Traceability: how this plan closes each Part III gap

| Part III gap | Closed in |
|---|---|
| #1 admin route fate | PR #4 — routes kept as redirect shims, `app/admin/layout.tsx` role-gate preserved, do-not-`rm` directive |
| #2 `/how-it-works` + `LANDING_PAGE_ENABLED` | PR #5 — gate preserved, redirect itself gated (both 404 when disabled) |
| #3 mobile singleton setter | PR #7 — `mobile-api.ts:649` re-pointed at view-scope/arming split; grep-gate |
| #4 "max position size" ambiguity | PR #3 — binds to `maxOrderNotional`, relabeled "Max order size (per trade)" |
| #5 P2 ordering contradiction | **The gate** — PR #7 lands before any switching chrome (PR #9+); CI merge-gate |
| #6 Studio modal flag fate | PR #5 — modal JSX flag-retained one release, cleanup PR later |
| #7 concurrent-arming + scheduler fan-out | PR #7 — per-account `systemState` authoritative + `armed_at` schema anchor + scheduler iterates armed set |
| #8 wash-sale return-type blast radius | PR #8 — full consumer inventory (`policy.ts:321`, `strategy.ts:219`, `strategy.ts:1552`), compile-time break |
| #9 all-Paper fleet | PR #12 — explicit Live+Paper-halt / Test-excluded, all-Paper case resolved |
| #10 shim trigger contradiction | PR #2 — shim runs flag-independently, additive-write, one-release read-fallback, delete deferred |
| #11 mobile deferred vs P0 requirement | PR #7 re-points the setter; PR #9 honors "STOP survives on `/mobile`"; full parity in PR #14 |

**Grounding re-verified this session (HEAD as checked out):** `USER_LEVEL_POLICY_FIELDS` at `src/lib/db-profiles.ts:20`; `mirrorPolicyToActiveAccount` defined `:249`, called `:486/:512/:531`; not-active→halted coercion `:284/:350/:397`; `mobile-api.ts:649` `setActiveConnectedAccount`; wash-sale enforced `policy.ts:321` consuming `getUserWashSaleLockedSymbols`; `tax.ts:99` `getWashSaleLockedSymbolsForUser` (flat `Set`), `:110` `getUserWashSaleLockedSymbols`, `:113` `broker==="test"→paper` leak; strategy consumers `strategy.ts:219, :1552`; test-label grep confirms the only `test/` "Notifications" hits are webhook-error data (`persistence-notification.test.ts:556/586`, `dashboard-feed.test.ts:83/91/148/154/171/260`), **not** nav labels.
