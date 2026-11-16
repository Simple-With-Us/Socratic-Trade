# Appendix J — Adversarial Red-Team Critiques

> Raw output from the large-team redesign workflow (48 agents, 2026-07-01). Preserved verbatim for provenance; the canonical synthesis lives in ../settings-navigation-redesign.md.

### Red-team: migration-risk
The code confirms the recommendation's anchors. The two `TuningCard` render sites (lines 3725 and 4441) both consume the same `strategyTuning` state, confirming the "duplicated, shared-state" claim. Now I have enough to attack the plan through the migration/feasibility lens. Here is my critique.

---

# Migration & Feasibility Critique — UNIFIED RECOMMENDATION v1

The design is architecturally coherent. That is exactly the problem: it is a coherent *destination* with almost no credible *path*. Verified against the live tree (`dashboard-client.tsx` 7015 lines, `WorkspaceTab`/`FeedTab`/`SettingsSection` unions, shared `strategyTuning` state at lines 3725 & 4441, localStorage keys at 197-199), here are the concrete failure scenarios, contradictions, and gaps a migration will actually hit — each with a fix.

## 1. The six-destination IA is a hard cutover disguised as a redesign; it cannot ship incrementally as written

The plan replaces 7 `WorkspaceTab` values + 4 `FeedTab` values (11 primary surfaces, two separate rails) with 6 verb destinations. But `WorkspaceTab` and `FeedTab` are **string-literal union types** driving a `switch`-style render tree and persisted to localStorage. There is no "add Approvals alongside Decision for one release" story here — Decision *becomes* Dashboard+Approvals, Performance+Tax *become* Review, the whole FeedTab rail dissolves into a lens. That is a simultaneous re-parenting of every primary surface.

**Failure scenario:** You try to ship "just the Approvals destination" in PR 1. But Approvals content currently lives inside the Decision tab's render path, which shares layout scaffolding, the feed rail, and `feedTab` state. To extract it you must fork the layout shell — so PR 1 already touches the global frame, the tab router, and localStorage migration. There is no small first PR.

**Fix:** Mandate an explicit **strangler-fig sequence** in the doc, with the tab unions as the seam:
- Phase 0: introduce a `DestinationTab` union that *maps onto* existing `WorkspaceTab`/`FeedTab` values (Dashboard→decision, Review→performance+tax, etc.) behind a feature flag, rendering the *same* existing panels. No content moves. This proves the new nav/routing shell in isolation.
- Phase 1..N: move one panel's *ownership* per PR, keeping the old tab value as a redirect alias.
The recommendation lists exactly one staged PR (the TuningCard merge). It needs a full ordered decomposition or it is a big-bang rewrite by omission.

## 2. localStorage tab persistence WILL silently break for every existing user — the plan never addresses migration

Confirmed keys: `WORKSPACE_TAB_KEY="dashboard-workspace-tab"`, `FEED_TAB_KEY="dashboard-feed-tab"`, `STRATEGY_TUNING_STORAGE_KEY`, plus `readStoredWorkspaceTab()` falling back to `"decision"`. When `WorkspaceTab` stops including `"decision"`/`"performance"`/`"tax"`, `isWorkspaceTab(saved)` returns false and every returning user is silently bounced to the default — **and the plan adds route-encoded scope (`/a/:accountId/...`) on top**, so a user's persisted deep state is now doubly invalid.

**Failure scenario:** User has `dashboard-workspace-tab="tax"` in localStorage. After deploy, `isWorkspaceTab("tax")` is false → dumped to Dashboard. Their bookmarked/persisted "Tax" view is gone with no redirect. Multiply across thousands of stored values including the two feed keys.

**Fix:** Ship a one-time **localStorage migration shim** in the same PR that changes the unions: read old keys, map `tax→review`, `performance→review`, `decision→dashboard`, `notifications(feed)→notifications-lens`, write new keys, delete old. This is ~30 lines and MUST be a named deliverable, not an "Open Question." The recommendation's Open Questions cover data migration for policy fields but are completely silent on the client-persistence migration, which affects 100% of users immediately.

## 3. Route-encoded scope (`/a/:accountId/...`) is presented as optional in Q4 but is load-bearing for Principles 2 and 8 — this is a contradiction that decides the whole risk profile

The design *derives its core safety guarantee* ("a stale tab cannot act on the wrong real-money account") from route-encoded scope, and Principle 2 states scope "is route-encoded" as an invariant. Yet Open Question 4 says the fallback is "keep scope in state short-term (accepting the stale-tab risk)." You cannot both claim the safety invariant as a design principle AND offer to ship without it. If you ship the state-only fallback, Principles 2 and 8's "fails to a neutral blocking state, never last-used-possibly-Live" are false — the app *does* keep last-used scope in React state across a client-side nav, which is exactly the wrong-account footgun.

**Concrete feasibility problem:** `dashboard-client.tsx` is a single 7015-line client component holding all tab state in `useState`. Converting to `/a/:accountId/...` means either (a) real app-router restructure — splitting the monolith into route segments, a multi-week high-risk rewrite, or (b) a catch-all `[accountId]` segment that just reads a param and threads it into the same monolith (cheap, but then scope is still fundamentally state-shaped and the "stale tab" guarantee is weaker than advertised because SPA navigations don't reload).

**Fix:** Resolve this now, don't defer it. Recommended low-risk path: adopt option (b) — a thin `/a/:accountId` param that seeds and *validates* the active-account state, plus a **guard on every mutating action** (the real safety boundary) that re-checks `accountId` against the server session before any order/config write. The guarantee that actually matters is "the write is validated server-side against an explicit account id," not "the URL is pretty." Move that server-side guard to a MUST; make the URL scheme a nice-to-have. As written, the design over-invests risk in the URL and under-specifies the server-side check.

## 4. The TuningCard/`strategyTuning` merge is correctly flagged as highest-risk, but the plan understates *why* and gives no rollback

Verified: `strategyTuning` is a single `useState` (line 1026), persisted to localStorage (1049-1052), and rendered by **two** `TuningCard` instances (3725 in one component, 4441 in another) that share `onApply={applyStrategyTuning}`/`onDiscard`. The recommendation says "collapse to one instance… stage as its own PR." Fine — but the two render sites live in **two different parent components** with different surrounding props (`snapshot`, `policy`, `currentPrompt`). Collapsing to one home means one of those parents loses the card entirely and the other must absorb its context. That is not a "move a component" edit; it is a state-ownership re-parenting.

**Failure scenario:** After the merge, a review generated from the (now-deleted) Studio path writes `strategyTuning`, but the surviving Strategy destination reads `currentPrompt` from a different `snapshot` prop than Studio did → the applied patch diffs against the wrong baseline → user applies a tuning patch computed against stale prompt text.

**Fix:** Before deleting either render site, assert both sites already read `strategyTuning` from the same source of truth for `currentPolicy`/`currentPrompt` (they appear to, but the props differ — verify `snapshot` is identical in both). Add an explicit **apply/discard round-trip test** and a localStorage-compat check to the PR's exit criteria (the doc says "tested end-to-end" — name the assertions). And specify the rollback: keep the deleted surface behind the same feature flag for one release so a bad merge is a flag flip, not a revert.

## 5. "Keep the `SettingsSection` union ids stable as routing keys… map old→new with redirects" — but the rename table changes the *tier* of sections, which the code couples to behavior

Confirmed: `ACCOUNT_SETTINGS_SECTIONS = Set(["strategy","operate","risk","tax","tuning"])` and `settingsTierForSection()` derives account-vs-user tier from membership. The plan moves `operate→Guardrails·Execution/Autonomy`, `risk→Guardrails·Risk`, `tuning→Review·Tuning`, and pulls Strategy out of Settings entirely. If you keep the union ids stable "for routing" but relocate their content out of the modal into destinations, then `settingsTierForSection("tuning")` and every `openSettings("operate")` call site (lines 1514, 1555, 1562, 1583, 1709, 1818) now point at a section that **no longer renders in the Settings modal** — they'd open an empty/redirecting modal.

**Failure scenario:** `onConfigureUniverse={() => openSettings("operate")}` at line 1818. Post-migration, universe config lives in Strategy→Signals, not the Operate settings section. The call still fires `openSettings("operate")` → opens a Settings modal to a section that's been gutted. Dead affordance, exactly the "false affordance" the design says it's eliminating.

**Fix:** The rename is not free-because-ids-are-stable. Every `openSettings(x)` call site that targets a relocated section must be rewritten to navigate to the new destination, not the modal. Add a **call-site inventory** to the plan (there are at least 6 `openSettings("operate")` sites plus palette entries) and make "no `openSettings` points at a relocated section" a merge gate. Keeping the id stable only helps for sections that *stay* in the modal (connections/display/notifications/data).

## 6. The persistent global frame (three-zone chrome, switcher, ambient risk strip, Halt) is drawn as if it exists — it's a from-scratch layout component wrapping a monolith

The ASCII frame implies a top-level shell rendered on *every* screen including the off-rail Settings and the `/admin/*`, `/mobile`, `/welcome`, `/login` routes. Today that chrome doesn't exist as a shared component; the layout is inline inside `dashboard-client.tsx`. Introducing a persistent frame means extracting a shell out of the monolith and applying it across separate route trees (`/admin/*` are separate routes per the constraints).

**Failure scenario:** The switcher + Halt must appear on `/admin/*` for the "system-wide halt/close-only" story, but `/admin/*` are separate route files that don't import the dashboard shell. Either they get a duplicate switcher (drift) or you hoist the shell to a root layout — which forces the account-scope context provider above routes that today have no notion of a selected account.

**Fix:** Specify the shell as an explicit `app/layout` or route-group `layout.tsx` deliverable with its own PR, landed *before* any destination moves, rendering the *current* tabs inside it first (ties to Fix #1 Phase 0). Decide explicitly whether `/admin`, `/mobile`, `/login` are inside or outside the shell — the plan currently implies "everywhere" while the routes say otherwise.

## 7. Fleet view is a new aggregation surface with no current data path, sold as a mode of an existing screen

"Selecting All accounts turns the Dashboard into a Fleet view" reads like a toggle, but today every scoped read is keyed to one `connectedAccountId`. Fleet needs N-account fan-out (equity, day P&L, pending-approval count, tripped breakers, last-run) — new aggregate queries and likely new API endpoints. Plus "Halt all / close-only all" is a new multi-account mutation with its own authorization and audit story.

**Fix:** Scope Fleet as its own milestone with named backend work (aggregate endpoint + fleet-halt mutation + audit), not a Dashboard render branch. It should not block the single-account IA migration — which brings up the biggest gap:

## 8. The plan optimizes for the multi-account power user and treats the single-account majority as an afterthought (Q7) — that inverts the risk

Every mechanism here (view/arm split, switcher-as-primary-control, Fleet, route-scope, three-tier provenance badges) exists to serve multi-account operators. Q7 asks, almost in passing, to "confirm we keep a zero-friction path" for single-account users. For a product where most users likely have one account, that's the *primary* case, and it's an open question rather than a design center.

**Failure scenario:** A single-account Test-mode user now must understand: switcher chip, money-reality badge, authority chip, scope tags on every setting, origin badges (`↳ from preset`), "Overrides (N)", view-vs-arm — to place one paper trade. The novice-safe Principle 9 is contradicted by the multi-account chrome the same design makes omnipresent.

**Fix:** Make single-account the default rendering and multi-account progressive: collapse the switcher to a static chip, suppress scope tags/origin badges/Fleet/"which account" machinery until a 2nd account is connected. Promote Q7 from open question to a **first-class design requirement** with an explicit "N=1 accounts" spec. This also de-risks migration: you can ship the whole IA to single-account users first (where scope ambiguity doesn't exist) and enable multi-account chrome behind the 2nd-account gate.

## 9. No test-surface accounting for a 7015-line component split

CLAUDE.md pins ~723 tests. This design deletes the Studio modal, dissolves the FeedTab rail, re-parents TuningCard, and relocates ~5 settings sections. Any test asserting on tab labels, `openSettings` targets, feed tabs, or the Studio modal breaks. The plan's verification story is silent on this.

**Fix:** Add "enumerate and update affected tests" as an exit criterion per phase, and land the union/localStorage changes with their test updates in the same PR (they can't be separated — the build gate will catch it, but only if sequenced).

---

## Bottom line

The end-state IA is defensible; the migration story is not. As written it is a coordinated big-bang across the tab unions, localStorage, settings routing, and layout shell, with exactly one staged PR called out and two client-side migrations (localStorage tab keys, `openSettings` call sites) entirely missing. The single lowest-risk restructuring is available and unspecified: **(1)** land the shared layout shell rendering *current* tabs, **(2)** introduce a `DestinationTab` mapping layer + localStorage shim behind a flag, **(3)** move one panel's ownership per PR with old ids as redirect aliases, **(4)** ship the entire thing to single-account users first where scope ambiguity is absent, **(5)** gate multi-account/Fleet/route-scope behind the 2nd-account connection. Until the doc contains that ordered decomposition with the two missing migrations named as deliverables, "cannot ship incrementally" stands.

### Red-team: multiaccount-edge
I have everything I need. The code reveals several traps the v1 doc either missed or oversimplified. Writing the attack now.

---

Attacking UNIFIED RECOMMENDATION v1 through the multi-account / edge-case lens. Findings, harshest first, each with a concrete failure scenario and a fix. I skip points that are genuinely solid.

## 1. The "view-scope switching is instant, free, reversible" claim is contradicted by the live code — there is a real active-account singleton that mutates state on switch

The doc's Principle 1 and the §Multi-account "How switching accounts changes the app" section both assert switching is pure view re-scope that "never changes what any agent *does*." **The code says otherwise.** `getActiveConnectedAccount(userId)` is a persisted singleton, and `mirrorPolicyToActiveAccount` (db-profiles.ts:249, called from `activateStrategyProfile:531` AND `updateStrategyProfile:512`) writes the active account's live `account_strategy_state` row. Worse, at db-profiles.ts:283-284, 349, 396 there is a **`systemState: "active" → "halted"` coercion applied to any account that is *not* the active one.** That means the system today enforces "only the active account may be running," and flipping the active pointer has execution consequences.

- **Failure scenario:** User has Alpaca-Paper running autonomously (`systemState: active`). They switch the chip to Roth-IRA to *read* its guardrails (the doc promises this is free). On the next policy write for the Paper account, the not-active coercion demotes it to `halted`. Autonomy silently stopped on the account the user thought they left running — because the doc's "view-scope" is layered on top of a codebase whose "active account" is an execution singleton.
- **Fix:** The doc must explicitly call out that `getActiveConnectedAccount` and the not-active→halted coercion are the **incumbent model the redesign replaces**, and specify the migration: decouple "which account is in view" (new, ephemeral, per-tab) from "which accounts are armed to run" (per-account, persisted, plural). Until that decoupling ships, the switcher is NOT free to flip — it changes execution. Add this as a blocking Open Question, not a footnote.

## 2. Zero-connected-accounts state is entirely unspecified — and the code shows it's a real crash/no-op surface

The doc's neutral "No account selected" blocking state covers *scope unresolved*, but a brand-new user (or one who disconnected their only broker) has **zero accounts**, which is a different state. `migrateLegacyStrategyModelFieldsToAccounts` bails at `if (accounts.length === 0) return;` and `getActiveConnectedAccount` returns undefined. The entire IA is "six account-scoped destinations + Settings." With zero accounts, five of six destinations have nothing to scope to.

- **Failure scenario:** A first-run user lands on Dashboard. The switcher has no chips, "Run once" has no target, Strategy/Guardrails/Approvals/Review have no account to render. The doc gives no first-run flow, so the user sees five empty blocking states and a Fleet view of nothing.
- **Fix:** Specify a **zero-account onboarding state** as a first-class screen: the app opens on Settings → Connections (or a dedicated welcome) with the six destinations disabled/greyed and a single CTA "Connect an account or start a Test sim." Decide explicitly whether a Test/local-sim pseudo-account is **auto-provisioned** so a keyless user is never at zero (this ties to point 3). This is the most common brand-new-user path and the doc is silent on it.

## 3. The Test/local-sim pseudo-account breaks three of the doc's own rules and is never reconciled

The Test sim is listed as a broker link ("Alpaca paper/live, Robinhood, Test/local-sim") and thus a Connected Account — but it is not a broker, has no real `accountNumber`, and (per tax.ts:113) its fills are mapped to `source: "paper"`. The doc treats it as just another row in the switcher, which creates contradictions:

- **Money-reality axis (Principle 3/4):** Test is "grey." But Test is *below* Paper on the money-reality ladder, and the ladder (Test→Paper→Live) is described as a property of the credential/data-plane. A Test account has **no credential**. Is "arm Live" even reachable from a Test account? Undefined.
- **Fleet emergency controls (Open Q6):** The doc leaves "does Halt-all hit Test" open — but the deeper problem is Test accounts have nothing to halt (no real orders), so they're pure noise in the Fleet panic controls. Open Q6 half-notices this but frames it as cosmetic; it's structural.
- **Cross-account wash-sale:** `getUserWashSaleLockedSymbols` (tax.ts:108) maps `broker === "test"` to `source: "paper"` and only excludes IRAs — so **a simulated loss in a Test account can contribute a wash-sale lockout onto a real taxable account** unless Test is filtered. The doc promises to surface cross-account lockout "naming the culprit account" without noticing the culprit could be a fake sim.
- **Fix:** Give the Test/sim account an explicit, separate classification in the switcher (not a peer broker row — a distinct "Sandbox" section), define that it is excluded from Fleet emergency controls and from cross-account wash-sale contribution, and state that "arm Live" is unreachable from it. Add "Is Test a Connected Account or a mode?" to the vocabulary/Open Questions.

## 4. "Presets copy, they don't link" is the right principle but collides with an ambient side-effect the doc under-scopes

The doc correctly flags `activateStrategyProfile`'s "mirror into active account" side effect for deletion (§three colliding verbs). **But it misses that the identical `mirrorPolicyToActiveAccount` call also fires from `updateStrategyProfile` (db-profiles.ts:512).** So editing a *library preset* while it happens to be `active` retro-writes the active account's live state — a live-link masquerading as a copy, on the edit path, not just the activate path.

- **Failure scenario:** User applied "Balanced Swing" to their Live account weeks ago (a copy, per the doc's model). Later they tweak the "Balanced Swing" preset in the library. If that preset is still flagged `active`, `updateStrategyProfile` mirrors the edit into whatever account is currently active — possibly a *different* account than the one they think they're editing, possibly Live. This is exactly the "edit the preset, silently mutate an account" bug Principle 7 promises can't happen, and it's live in the code on a path the doc didn't enumerate.
- **Fix:** The strategy-consolidation PR must remove the mirror from **both** `activateStrategyProfile` AND `updateStrategyProfile` (and the analogous call in `mergePolicy`-adjacent writers at :486). List all call sites of `mirrorPolicyToActiveAccount` in the "highest-risk change" PR scope, not just the one in the verbs table.

## 5. "Apply a preset, then edit the account" — provenance/divergence tracking has no defined semantics for partial resync or preset-side edits

The doc promises "Preset: Momentum-v3 · diverged: 6 fields" with "re-sync from preset (pull)" and "promote to preset (push)." Under the copy-on-bind model with `derived_from_profile_id`, several ordinary sequences are undefined:

- **Failure scenario A (three-way merge):** User applies preset P to account A (snapshot). User edits 3 fields on A. Separately, the preset P is edited (2 different fields). User clicks "re-sync from preset." Does pull overwrite the user's 3 local edits? Merge? The doc says "pull" as if it's one-way, but the account has *diverged from a snapshot*, and the preset has *also moved*. This is a three-way merge with no stated conflict policy.
- **Failure scenario B (safety fields in the diff):** The diff "highlights any safety-limit overwrite in the account's color." But if a user pulls a preset update that *loosens* a stop or raises a Live cap, the doc's own Principle 8 says loosening on Live needs type-to-confirm. Does the bulk resync honor per-field friction, or does it batch-apply and bypass the one-way-door confirms? Undefined, and it's the exact hole where a preset resync silently loosens Live guardrails.
- **Fix:** Define resync as an explicit **three-way diff** (base snapshot → preset-now vs base snapshot → account-now) with per-field conflict resolution, and state that any field whose resync *loosens* a Live-account limit inherits the same per-field confirm as a manual edit — no bulk bypass.

## 6. Global-vs-per-account mis-scoping: the doc's own migration Open Question hides a data-integrity trap

The doc's Open Q1 correctly identifies `marketScanCandidateLimit`/`marketScanOutlierReserve` as user-tier fields users might expect per-account. But it frames the "safe fallback" (leave user-scoped, relabel "applies to all accounts") as harmless. It isn't, given the code:

- **Failure scenario:** `pickUserFields`/`pickAccountFields` (db-profiles.ts:29-52) split policy by `USER_LEVEL_POLICY_FIELDS` on *every write*. If the redesign relabels these "all accounts" in UI but a future PR moves one to account-tier without updating the Set, the field silently writes to the wrong store and reads back as the default — the exact "silently never reaches" trap CLAUDE.md warns about for enrichment fields. The doc's "do not ship half-migrated" is right but under-stated: the failure is *silent*, not a crash.
- **Fix:** Add to Open Q1 that the field-scope Set is the single source of truth and any scope change is a coordinated migration + Set edit + back-fill in one PR, verified by a test asserting round-trip read-after-write per field. Also: `notificationSettings` is in the same user-tier Set — the doc puts Notifications delivery rules in user-scope Settings, which is consistent, but it should say so explicitly so no one "helpfully" makes per-account notification routing without the migration.

## 7. Cross-account wash-sale is enforced today, but the doc's UI promise over-reaches the code's scoping

Open Q2 hedges ("enforced or displayed?"). The code answers: it **is** enforced (policy.ts:317-323 resolves `getUserWashSaleLockedSymbols` when the caller doesn't pre-populate). But the enforcement has a scoping subtlety the doc's confident "naming the culprit account" UI will get wrong:

- **Failure scenario:** `getWashSaleLockedSymbolsForUser` returns a *union Set of symbols* — it does **not** carry which account contributed each symbol. The doc promises the blocked-proposal UI shows "locked by loss in Robinhood·Live, clears Jul 24." That attribution data (culprit account + clear date) is **not** in the current return type. Building the promised UI requires threading account + exit-date through the lockout computation, which today collapses to a bare symbol set.
- **Fix:** Change Open Q2 from "enforced vs displayed" (already answered: enforced) to "the lockout function must return per-symbol provenance (contributing account + earliest clear date), not a flat Set, before the Approvals UI can honor the promise." Otherwise the UI must degrade to "locked by a wash-sale in another account" with no name/date.

## 8. Fleet view "no trade from the roll-up" is good, but Fleet emergency controls have an ambiguous scope that maps onto the active-account singleton

"Halt all / Set all close-only / Pause autonomy" from Fleet is asserted as fleet-wide. But per point 1, the codebase currently only lets the *active* account be `active`; all others are coerced to `halted`. So "Halt all" today is partly a no-op (the non-active accounts are already halted-by-coercion) and "Pause autonomy" has undefined meaning for accounts that were never allowed to run concurrently.

- **Fix:** Fleet controls only make sense *after* the concurrent-execution model from point 1 exists. Sequence them: Fleet emergency controls are meaningless until multiple accounts can be armed simultaneously. State this dependency, and resolve Open Q6 (Live-only vs all-envs) *after* deciding whether Test/sim accounts can even be in a runnable state.

## 9. Single-account users (Open Q7) — the "collapse the switcher to a static chip" plan fights the route-encoded-scope primitive

Open Q7 wants a zero-friction single-account path with the switcher collapsed to a static chip. But Principle 2 makes scope route-encoded (`/a/:accountId/...`) and fails-closed to "No account selected." For a single-account user these two pull apart:

- **Failure scenario:** Single-account user bookmarks `/a/acct123/strategy`. They later disconnect and reconnect the broker (new `connectedAccountId`). The bookmark now resolves to a dead account id → fails-closed to "No account selected" blocking state → the "zero-friction" user is stuck on a neutral screen with no idea why, because there's exactly one account and they'd expect it auto-selected.
- **Fix:** For the single-account case, define a `/a/default/...` or auto-redirect-to-sole-account resolution so a stale/one-off account id resolves to "the only account" rather than fails-closed. Fails-closed is the right default for *multi*-account ambiguity; it's user-hostile when there is exactly one unambiguous account. The doc must state the single-account resolution rule explicitly, or Q7's "zero-friction" contradicts Principle 2.

---

**Net:** The scoping *principles* are sound, but the doc treats the greenfield model as if the current code is a blank slate. It is not: there is a persisted active-account **singleton** with a not-active→halted coercion, an ambient mirror on **two** write paths (activate *and* update), a Test pseudo-account that leaks into wash-sale and Fleet logic, and a wash-sale lockout that is **already enforced** but returns provenance-free symbol sets. The three highest-risk gaps to escalate before any build: **(1)** decouple view-scope from the execution singleton, **(4)** kill the mirror on the update path too, **(3/7)** classify Test and add lockout provenance. Zero-account first-run (point 2) is the most common user path the doc forgot entirely.

Key code anchors: `mirrorPolicyToActiveAccount` at `src/lib/db-profiles.ts:249` (called from `:486`, `:512`, `:531`); not-active→halted coercion at `db-profiles.ts:283-284, 349, 396`; `accounts.length === 0` no-op at `db-profiles.ts:265`; `USER_LEVEL_POLICY_FIELDS` at `db-profiles.ts:20`; cross-account lockout `getWashSaleLockedSymbolsForUser` (union Set, no provenance) at `src/lib/tax.ts:98`, Test→"paper" mapping at `tax.ts:113`, enforcement wired in `src/lib/policy.ts:317-323`.

### Red-team: novice-confusion
I'm the novice-confusion skeptic. Here's where this v1 will confuse or endanger a nervous first-timer.

## 1. "Run once" on the global bar silently binds to the active account — invisible scope for the single most consequential button

The right-zone `▶ Run once` acts on whatever the switcher currently points at. A novice who left the switcher on their Live account, then navigated to Dashboard/Review to read something, clicks the always-present global "Run once" with no per-click reminder of *which* account it fires against. The scope anchor is top-*left*; the button is top-*right* — the two things that must be read together are at opposite corners.
**Fix:** Stamp the target account + mode directly on the button ("Run once — Roth IRA · PAPER"), and on Live require the same armed ritual as any Live action. Never let "Run once" inherit scope silently on a Live account.

## 2. Test grey / Paper blue / Live red — but Test and Paper are the two the novice confuses, and they're the low-salience pair

The whole point of a novice is they don't yet know that "Paper" is also fake money. Your color logic makes Live loud (good) but leaves Test and Paper as two calm, similar-feeling cool colors (grey/blue). The dangerous novice error isn't "acted on Live thinking it was Paper" — it's "graduated from Paper to Live without registering that Live is categorically different," or "thinks Test and Paper are the same practice mode." Color alone doesn't teach *fake vs real*.
**Fix:** Collapse the top-level distinction the novice needs into two words on the badge — **PRACTICE** (Test+Paper, no real money) vs **REAL MONEY** (Live) — and keep the three-way color underneath. The badge should say "PAPER · practice money" in words, not rely on blue.

## 3. "Approve — LIVE" red button is the ONLY thing standing between a tired novice and a real order — and it's a single click

Principle 8 reserves type-to-confirm for exactly two doors: "arm Live" and "arm Auto-on-Live." But once Live is armed, every individual **Approve** on a real-money order is a plain click of a red button. A nervous first-timer who armed Live once (deliberately) is now one muscle-memory click from a real trade on every subsequent card. Red is not friction; it's color.
**Fix:** The *first* Live approval in a session (or after any idle period) should require an explicit confirm, and Adjust-and-approve on Live should always confirm the final size. Don't treat "armed Live once" as consent for unlimited frictionless real orders.

## 4. Three separate "Notifications" things after you promised to kill duplicated labels

You correctly flag the legacy dup, then ship: the 🔔 alert dropdown (chrome), "Notifications" delivery settings (Settings), and the Notifications *log* (under audit/Review). That's *three* homes for one word. A novice who wants "turn off the texts" has no way to know whether that's the bell, Settings, or the log — and "event routing" is jargon they won't map to "texts."
**Fix:** Rename ruthlessly. Bell = **Alerts**. Settings = **Alert delivery**. Log = **Alert history** (a Review lens). One noun family, three obviously-different modifiers. Kill the bare word "Notifications" entirely.

## 5. "Halt" vs "Halt & Flatten" — the novice's panic click is ambiguous at the exact moment they can't read carefully

In a crisis a scared user mashes the red button. You've made Halt one click (good) but the button is labeled "Halt & Flatten" and Flatten (sells real positions) needs confirm. So the panicking novice reads "Halt & Flatten," fears it will sell everything, and *hesitates* — or clicks and is surprised by a confirm dialog they don't understand. Compound-labeled emergency controls fail under stress.
**Fix:** One primary button = **STOP** (halts new activity, one click, always safe, never sells). Make "Flatten / sell positions" a distinct, secondary, clearly-worded action — not welded into the panic button's label.

## 6. Fleet "Halt all" and the open question about whether it touches Test/Paper is a novice trap, not just an owner decision

Open Question 6 asks whether fleet Halt hits all environments. For a novice this can't be left ambiguous: if they hit "Halt all" in a panic and it *doesn't* stop their Live account (because someone scoped it to "all including noisy Test" and they mis-picked), that's catastrophic. The novice cannot reason about environment scoping mid-panic.
**Fix:** Fleet emergency control must *always* include every Live account, unconditionally, with Live shown first and confirmed-halted state echoed per-account. Resolve this now toward "Live always halts"; don't ship it as a configurable ambiguity.

## 7. "No account selected" blocking state is safe — but a novice will land there and not know how to escape

Route-encoded scope failing to a neutral blocking state is correct for safety, but a first-timer who hits a stale link or clears state sees a dead screen. If the empty state isn't explicitly instructive, they'll assume the app is broken.
**Fix:** The blocking state must name the exact next action ("Pick an account to continue →") with the switcher auto-opened, and for single-account users auto-resolve to their one account (per Open Question 7 — but that's a *requirement*, not a question, for anyone with exactly one account).

## 8. Origin badges (`● ↳ ⊘`) and "Overrides (N)" are power-user vocabulary dumped on a novice's first config screen

Principle 9 promises plain-language Essentials, but the scoping model puts four glyph-coded origin states plus an "Overrides (N)" chip on *every effective value*. A nervous first-timer opening Guardrails for the first time sees glyphs they can't decode next to numbers that control real money. That's the opposite of reassuring.
**Fix:** Origin badges belong behind the "Advanced" reveal, not on the Essentials view. On Essentials, show at most a plain "Changed from preset" text pill on the few fields that differ; hide the glyph taxonomy until the user opts into depth.

## 9. Preset "copy vs link" is the right model but the novice mental model of "apply" is exactly the opposite

You correctly make apply a snapshot. But a first-timer's intuition of "apply Balanced Swing to this account" is a *live subscription* — they'll expect edits to the preset to flow through, and later be confused that their account didn't update (or that editing the account didn't change the preset). "Diverged: 6 fields / re-sync / promote" is Git vocabulary a novice doesn't have.
**Fix:** At apply time, one plain sentence: "This copies the settings once. Later changes to the preset won't affect this account, and your changes here won't affect the preset." Replace "re-sync / promote / diverged" with "Reset to preset" / "Save these as a new preset."

## 10. Six destinations + Assistant overlay + Scan + Fleet + command palette is still a lot of first-contact surface

You cut 11 primary surfaces to 6, which is real. But a *nervous first-timer* still meets, on day one: 6 verbs whose names (Approvals/Strategy/Guardrails/Review) are all somewhat abstract, plus a persistent Assistant, plus a switcher with a Fleet mode, plus ⌘K. "Guardrails" and "Review" especially don't self-explain to someone who's never traded.
**Fix:** Ship a novice default that hides Strategy/Review behind a "more" affordance until first proposal is approved, and lead with the three a first-timer needs — Dashboard, Approvals, Guardrails (labeled "Safety limits" on first run). Progressive disclosure at the *destination* level, not just within each screen.

## 11. Nothing defines the very first moment — where does a brand-new, zero-account user land?

The entire IA assumes an account is selected. There's `/welcome` and `/login` in current state, but the recommendation's global frame, scope contract, and every destination presuppose a connected account. A true first-timer has *zero* accounts, so every scoped screen is in the blocking state and Fleet is empty. The doc never describes the empty-state onboarding path.
**Fix:** Specify the zero-account first-run: land on a guided "Connect your first account (start with Test — no real money, no broker login)" flow that defaults them into Test + Propose-only, so their first-ever scope is unambiguously fake and safe before any broker or Live concept appears.

## 12. "Adjust-and-approve" lets a novice hand-edit size with no relation to the guardrail that would otherwise catch it

Adjust-and-approve on an Approvals card lets the user change size before approving. A novice can type a larger number than the strategy proposed. It's unclear whether the deterministic sizing caps re-gate the *adjusted* value or only the AI's original.
**Fix:** State explicitly that adjusted orders re-run the full policy gate (the doc's Principle 6 implies it but Approvals actions don't say it), and show the same live consequence preview ("this is 8% of equity, above your 5% cap — blocked") inline on the adjust control.

The strongest parts (route-encoded scope, copy-not-link presets, split brain/fence) are sound. The gaps above are all in the *labels and first-run moments* where a novice actually gets hurt.

### Red-team: coherence-scope-creep
This surfaces two real problems in the recommendation. Cross-account wash-sale enforcement already exists (`policy.ts:311`, "cannot be silently bypassed"), and `washSaleGuard` is a per-account boolean — both of which the recommendation gets wrong. And `USER_LEVEL_POLICY_FIELDS` contains exactly 3 fields, which lets me test the Open Question #1 framing. I have enough to write a harsh, specific critique.

---

# COHERENCE & SCOPE-CREEP CRITIQUE — UNIFIED RECOMMENDATION v1

Attacking through the lens of internal contradictions, surfaces that reappear in two homes, over-nesting, re-shuffled Frankenstein, and current-app surfaces dropped without a decision.

## A. FACTUAL CONTRADICTIONS WITH THE CODE (these poison the deliverable's credibility)

**A1. Cross-account wash-sale is falsely framed as an unverified "maybe." It's already enforced.**
The doc's Open Question #2 and the "Verify before promising it" caveat in Multi-account say cross-account lockout is "only honest if `src/lib/policy.ts` / the tax engine actually *enforces*" it. It does — `policy.ts:311-317`: *"Authoritative cross-account enforcement… so the gate cannot be silently bypassed by a caller"*, backed by `getUserWashSaleLockedSymbols(userId)` and documented in `types.ts:81-83`. The recommendation raised a fake open question about a feature that shipped. This is not a harmless hedge: it tells the owner to spend a verification cycle on settled behavior, and it signals the "anchors check out against the real code" claim was not actually run against `policy.ts`. **Fix:** Delete Open Question #2's conditional; state cross-account lockout is enforced today (cite `policy.ts:311`), and scope the *design* work to surfacing it, not to verifying it exists.

**A2. Tax "rules vs outcomes" split contradicts the actual per-account tax model.**
The doc repeatedly splits tax into "rules in Guardrails" + "outcomes in Review," and lists `washSaleGuard` as an account rule. But wash-sale is *cross-account by construction* (`types.ts:82-83`: a taxable-account loss locks rebuys "across ALL of the user's accounts"). So the wash-sale "rule" is neither purely account-scoped (its blast radius is every account) nor purely user-scoped (its trigger is one account's realized loss). The two-bucket Guardrails/Review taxonomy has no home for a rule whose scope is "one account's action, all accounts' consequences." **Fix:** Add an explicit third tax classification — *cross-account tax couplings* — surfaced identically in Fleet and on the blocked proposal, and stop implying `washSaleGuard` is a clean per-account toggle.

**A3. Open Question #1 is built on a near-empty set and inflates the migration cost.**
`USER_LEVEL_POLICY_FIELDS` is exactly three fields: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve` (`db-profiles.ts:20-24`). The doc frames migrating them as a weighty "pay the data-migration cost now vs ship safe fallback" fork. Two of three (`notificationSettings`) obviously *stays* user-global under the doc's own taxonomy; only the two market-scan breadth knobs are even candidates. The "open question" is dressed up as a strategic decision when it's a two-field call with an obvious answer (scan breadth is a scan concern, plausibly fine to leave global). **Fix:** Name the actual three fields, resolve `notificationSettings` immediately (stays global), and reduce OQ#1 to "do the two `marketScan*` knobs go per-account? default: no."

## B. SURFACES THAT REAPPEAR IN TWO HOMES (the exact bug this redesign exists to kill)

**B1. Notifications now lives in THREE homes, up from two.** The doc mocks the current app's "two approval homes" bug, then creates a worse notifications situation: (1) the 🔔 live-alert dropdown in global chrome, (2) Notifications *settings* under Settings → Notifications, (3) the Notifications *log* "under audit" (Review). The current app has two (feed tab + settings section). The redesign ships three, and leans on parenthetical disclaimers ("distinct from Notifications *settings*… and the Notifications *log*") to paper over it. Three things named "Notifications" that the user must mentally disambiguate is the Frankenstein pattern re-shuffled, not solved. **Fix:** Rename to eliminate collision — 🔔 = "Alerts" (chrome), Settings = "Alert delivery," Review lens = "Alert history." One noun, one home.

**B2. Audit is claimed as "a lens, not a surface," but is given four entry points and a home in Review.** Design principle: audit is "a filterable lens reachable" from Approvals/Dashboard/Settings *and* lives in Review. A thing with its own section-anchor in Review ("audit as a filterable lens reachable here") and four launch points is a surface. Calling it a "lens" is a vocabulary dodge that lets the doc claim it collapsed the current app's Audit Log feed tab without actually deciding where audit *lives*. **Fix:** Pick one canonical home (Review → History) and make the other three *deep-links into it*, stated as such — not "reachable from" four peers.

**B3. Kill switch / halt appears in three places with three different behaviors, unreconciled.** (1) Global chrome "■ Halt & Flatten," (2) Guardrails → Autonomy "kill-switch thresholds," (3) Fleet "Halt all / close-only," (4) Settings → Admin "system-wide halt/close-only." Four halt surfaces across four scopes (this account / this account's *thresholds* / all my accounts / all users' accounts) with no single place that answers "what is halted right now and by whom." The redesign scatters the single most safety-critical control across the exact "which home?" ambiguity it's meant to fix. **Fix:** One halt-state model surfaced consistently; the chrome button and Fleet control are *actuators* of that state, Guardrails holds *auto-trip thresholds*, Admin holds the *operator override* — and each must visibly say which layer it's touching.

## C. OVER-NESTING / KNOB EXPLOSION AGAINST ITS OWN PRINCIPLE

**C1. Guardrails violates Principle 9 on arrival.** Principle 9 says "~120–150 knobs never greet a newcomer… a handful of plain-language Essentials." Then Guardrails is specified as 7 sub-sections (Autonomy/Sizing/Exposure/Risk/Circuit-brk/Execution/Tax) enumerating ~35+ named controls (per-symbol/sector/gross/net/beta/correlation caps; ATR-&-beta stops; VIX/VVIX/SKEW thresholds; marketable-limit buffer; drift/staleness gates…). There is no Essentials layer specified for Guardrails at all — the doc lists the full ceiling and never shows the novice floor it promised. **Fix:** Actually specify the Guardrails Essentials (e.g. 5 items: max position size, daily loss stop, stop-loss on/off, autonomy dial, extended-hours on/off) and fold the other ~30 behind the one Advanced reveal. As written, Guardrails is the Frankenstein knob-pile relocated, not simplified.

**C2. The disclosure ladder is contradictory: "at most one Advanced reveal" vs "a two-level disclosure ladder" vs "a cordoned Expert tier."** Principle 9 says "at most one 'Advanced' reveal." Settings taxonomy says "a two-level disclosure ladder (Essentials → one Advanced reveal; a cordoned Expert tier)." That's Essentials + Advanced + Expert = three levels. The doc contradicts its own depth cap in the same document. **Fix:** Decide: is Expert a third level (then stop saying "at most one reveal") or is it just search-only power access (then don't call it a "tier")? Pick one.

## D. RE-SHUFFLING RATHER THAN SIMPLIFYING

**D1. "Strategy 5→1" is arithmetic sleight-of-hand; it's 5→3 by the doc's own table.** The headline "5 → 1 editable home." The fine print keeps Strategy Flow (reclassified "Understand" surface, still reachable from editor + Dashboard + palette) and `/how-it-works` (renamed, linked from editor + Help). So strategy-related surfaces the user can land on = editable Strategy + Flow overlay + how-it-works = 3, plus the Preset library which is *also* hosted in Strategy *and* managed in Settings (a 4th split home). The complaint was "strategy scattered across 5 surfaces with no intuitive reason"; the answer scatters it across ~3–4 with newly-asserted reasons. That may be defensible, but **claiming "5→1" is the same over-claiming that produced the Frankenstein** — it hides retained surfaces behind a re-label ("explainer," "Understand surface"). **Fix:** State honestly "1 editable home + 2 read-only explainers + preset library (hosted in Strategy, managed in Settings)" and defend the count instead of collapsing it to "1."

**D2. Preset library has two homes — the exact anti-pattern, unresolved.** "Hosts the Preset library" (Strategy destination, #3) AND "the strategy preset library manager" (Settings → Presets) AND "managed in Settings" (Multi-account table). Which is it? The doc says both "Strategy → Presets" and "managed in Settings" without a browse-vs-manage boundary that a user could predict. This is a surface in two homes — B-class bug — hiding in the Settings section. **Fix:** Explicit split — Strategy → Presets = *apply/capture in account context*; Settings → Presets = *rename/delete/version/share library CRUD* — and say so, or pick one home.

**D3. "Scan/Research" is left in quantum superposition.** IA table has no Scan destination. Then a paragraph says Scan "stays a light, read-only destination (or a Dashboard drill-down)." Then §"Why six" says "scan → light destination/drill-down." The doc never decides whether Scan is a 7th destination or a Dashboard facet — it lists six verb destinations but describes a seventh it won't commit to. This is precisely the "is it a tab or a facet" indecision that created the current mess. **Fix:** Decide. If Scan is browsable independently of a proposal (the doc's own justification), it's a destination — then it's *seven*, and the "why six not seven" section is wrong. If it's a drill-down, remove "destination" everywhere.

## E. CURRENT-APP SURFACES DROPPED WITHOUT A DECISION

**E1. `/mobile` (PWA) and `/welcome` and `/login` — silently vanished.** Current-state item 7 lists `/mobile` (PWA), `/welcome`, `/login` as real routes. The mobile PWA has its own command API (`src/lib/mobile-api.ts`, which the doc's own grep would have hit). The redesign's six-destination + chrome model is entirely desktop-three-zone; there is zero statement of what happens to the mobile surface, whether the three-zone chrome degrades to mobile, or whether `/welcome` onboarding survives. Dropping the PWA silently is a scope gap in a redesign that claims to be comprehensive. **Fix:** Add explicit dispositions: mobile chrome adaptation (the switcher + halt must survive on phone), and onboarding/login placement.

**E2. Command palette "run strategy" vs the new armed-Run split — unreconciled.** Current palette can "run strategy." New model: "▶ Run once" is one-click on Test/Paper but the Live/Decide rung is "armed separately." The doc promotes ⌘K with "run once" as a palette entry — but never says whether palette "run once" is blocked/soft on a Live-scoped account, or whether it bypasses the arming ritual. A palette shortcut that skips the Live arming ceremony is a side door, violating Principle 6/8. **Fix:** State that palette "run once" inherits the same money-reality gating as the chrome button (no Live execution without the arm ritual).

**E3. Help "MCP" section and `/admin/transcript`, `/admin/rag-coverage` — under-placed.** Admin consolidation names connections-health, llm-usage, rag-coverage, transcript, then Settings → Admin only enumerates "provider health / LLM usage / halt." `rag-coverage` and `transcript` (LLM debugging surfaces) are dropped from the enumeration without a word. Help's "MCP" tab is kept in the Help panel list but nothing in the IA explains what MCP config *is* in this product or where it's edited. **Fix:** Enumerate all four `/admin/*` targets in the Settings → Admin spec; state where MCP/tool config lives (it's real — there are MCP references in Help).

## F. INTERNAL PRINCIPLE CONTRADICTIONS

**F1. Principle 8 "autonomy resets to safe floor on restart" is asserted as current behavior but never verified.** The doc treats "autonomy resets to its safe floor on restart" as a design invariant *and* implies it's how the system behaves. Nothing in the anchors verifies a restart-reset of `system_state`/authority exists in `account_strategy_state`. If it doesn't exist, this is a new feature smuggled in as a principle. If it does, it needed a citation like the others. **Fix:** Either cite the restart-reset mechanism in code or flag it as net-new behavior requiring implementation (and cost it).

**F2. "Earlier principle wins" ordering creates a live conflict the doc doesn't resolve.** Principle 2 (scope fails to a *neutral blocking* "No account selected") vs Principle 7's Appearance setting "default landing account" (Settings → Appearance) — a default landing account means scope *is* silently inherited on load, contradicting P2's "never silently inherited… never 'last-used, possibly Live.'" A default-landing-account that is a Live account is exactly the silent-Live-inheritance P2 forbids. Per "earlier wins," P2 kills the default-landing feature — but the doc ships both. **Fix:** Either forbid Live accounts as default-landing targets, or drop "default landing account," and say which principle yielded.

## G. VOCABULARY / LABEL COLLISIONS STILL PRESENT

**G1. "Review" (destination #5) collides with "AI review / Red-Team review / diff-and-confirm review."** The doc uses "review" for: the Review destination, "reviewed like a code review" (Tuning), "AI-review config," "Green/Red-team review," "confirmable diff… reviewed." A supervisor told to "check the review" has five referents. This is the same duplicated-label disease as current "Tax"/"Notifications." **Fix:** Rename destination #5 (e.g. "Results" or "Ledger") so "review" can stay a verb for the approval/tuning actions.

**G2. "Tax" collision is claimed solved but re-created.** Current app: Tax appears as workspace tab + settings section + help section. Redesign: Tax RULES (Guardrails), Tax OUTCOMES (Review), Tax (Help), plus tax type is "account-intrinsic" (Connections/account). That's still 3–4 Tax homes; the label is split by suffix ("rules"/"outcomes") the user won't reliably carry. **Fix:** Acknowledge Tax remains multi-homed by nature and give it a single navigational anchor (a Tax lens like audit) rather than pretending Guardrails/Review suffixes disambiguate it.

## Highest-priority fixes (ranked)
1. **A1/A2** — correct the wash-sale factual errors; they undermine every "verified against code" claim.
2. **B3** — reconcile the four halt surfaces into one state model; this is safety-critical, not cosmetic.
3. **B1/G1/G2** — kill the Notifications-x3, Review-x5, Tax-x4 label collisions; this *is* the complaint, re-created.
4. **D1/D3** — stop the "5→1" and "six not seven" over-claims; count honestly or the redesign repeats the sin it diagnoses.
5. **E1** — decide the mobile/PWA and onboarding disposition; a whole surface is silently dropped.

Nothing here is praise-padding; solid parts (route-encoded scope as an authority grant, copy-not-link presets matching `derived_from_profile_id`, the deleted `activateStrategyProfile` ambient side-effect) I've deliberately left unremarked per instructions.
