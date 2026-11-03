# Onboarding, Modes & First-Run — Build Spec

**Scope:** the zero-account first-run flow, the Test → Paper → Live money-reality progression, the Propose → Decide authority arming rituals, autonomy-reset-on-restart, money-reality education copy, progressive destination unlock, and full mobile/PWA parity for account-scope + STOP + arming.
**Canonical design:** [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2) — this document goes deep on the onboarding/modes/first-run slice and does **not** restate the frame, IA, or settings tree. Read Part I §"Edge cases resolved" → "Zero connected accounts," principles P4/P5/P9/P10/P11, and Open Q6/Q7 first.

All file paths are absolute where a new file is proposed, repo-relative where an existing file is cited.

---

## 0. Where this sits in the phased plan

This spec is delivered across the existing phases, not as one drop:

| Concern | Phase (per Part II-D) | Flag |
|---|---|---|
| Money-reality education copy, PRACTICE/REAL word-class badges | Phase 1 (relabel) | none |
| `/welcome` → onboarding entry rewrite, greyed destinations, progressive unlock | Phase 5 P0-shell | `NAV_V2` |
| Zero-account guided flow + Test auto-provision | Phase 5 P0-shell | `NAV_V2` |
| Propose→Decide arming ritual + first-Live-of-session re-consent | Phase 5 (after P2 decouple) | `NAV_V2` |
| **Autonomy-reset-on-restart** (net-new; see §5) | Phase 5, ships with P2-decouple | `NAV_V2` + always-on server behavior |
| Mobile parity (switcher + STOP + arming + scope) | Phase 5, after P2 | `NAV_V2` |

**Hard sequencing rule (closes Part III gap #5/#11, the P2 contradiction):** No onboarding surface that lets a user **switch account context or arm autonomy** may ship before Phase 5's P2 decouple (`db-profiles.ts:284/350/397` coercion removed) + server-side write-time `accountId` validation land. The zero-account flow itself (single Test pseudo-account, no switching, Propose-only) is safe to ship earlier because it never switches context and never arms — there is exactly one account and it cannot reach Live.

---

## 1. Zero-account first-run flow

### 1.1 Entry & routing

`/welcome` (`app/welcome/page.tsx`) stays the **public, unauthenticated marketing page**, gated by `LANDING_PAGE_ENABLED` (unchanged). It is explicitly **outside** the `(shell)` route-group (no switcher/STOP pre-auth — matches migration table row `/welcome` and P0's route-group decision). Its "Request access" CTA and `/how-it-works` link are unchanged except the strategy link target follows the `/strategy → /how-it-works` rename.

The **authenticated first-run flow** is a distinct in-app surface, not `/welcome`. Resolve Open Q6 concretely:

- Post-login landing = `app/(shell)/page.tsx` → the **Dashboard destination**.
- Dashboard reads onboarding state on mount (server component) via a new `getFirstRunState(userId)` helper (see §1.4). When `firstRun === true`, Dashboard renders the **First-Run Guide panel** in place of the normal Dashboard body; the three-zone chrome still renders (switcher chip = the auto-provisioned Test account, STOP visible-but-inert).
- `/welcome`'s only relationship to the flow: after "Request access" and account approval, the user signs in and lands in the in-app flow. `/welcome` never renders the guide.

New component: `app/(shell)/onboarding/first-run-guide.tsx`.

### 1.2 Test pseudo-account auto-provision (never at zero)

**A keyless/broker-less user is never at zero accounts.** On the first authenticated request, ensure a Test/local-sim pseudo-account exists.

- **Reuse the existing primitive:** `ensureTestAccount(userId)` already exists at `src/lib/db-api-keys.ts:566` — it no-ops if any `broker === "test"` row exists, else inserts a `{ broker: "test", environment: "paper" }` row. **Do not write a new provisioner.**
- **Call site (new):** invoke `ensureTestAccount(userId)` inside `getFirstRunState(userId)` (§1.4) so it fires exactly once per user on first Dashboard load, and inside `mobileReadiness(userId)` (`mobile-api.ts:762`) so a phone-first user is also seeded. Both are idempotent.
- **Activation:** if no account is currently `is_active = 1`, call `setActiveConnectedAccount(<testAccountId>, userId)` (`db-api-keys.ts:681`) so `getActiveConnectedAccount` (`:580`) returns the Test account rather than null. This makes `deriveExecutionState` (`execution-mode.ts:41`) resolve to `{ mode: "test/local", label: "Test", usesLocalSimulation: true, submitsBrokerOrders: false }` — the correct, unambiguously-fake first scope.
- **Label/copy:** the row's `label` = `"Test — Local Sim"` (matches the `/welcome` copy string already in the tree). In the switcher it renders under the **Sandbox** section (design §Screen 5), never as a peer broker row.

**Defaults on the auto-provisioned account** (the account's `account_strategy_state` seed):
- `systemState: "halted"` — never armed on creation (P9 safe floor).
- `strategyAuthority: "propose"` — Propose-only (P9).
- `paperMode` legacy boolean: the Test account already forces `test/local` via `deriveExecutionState`; do not rely on `paperMode` alone.
- Guardrails: stops-on, breakers-armed per `DEFAULT_POLICY` (`src/lib/defaults.ts`).

**Acceptance:**
- AC-1: A brand-new `userId` with zero rows, on first Dashboard load, has exactly one `connected_accounts` row (`broker="test"`, `is_active=1`) afterward.
- AC-2: `deriveExecutionState(getPolicy(userId), getActiveConnectedAccount(userId))` returns `label: "Test"`, `submitsBrokerOrders: false`.
- AC-3: Re-running first-run load does not create a second Test row (idempotent — `ensureTestAccount` early-returns).
- AC-4: `migrateLegacyStrategyModelFieldsToAccounts`'s `accounts.length === 0` no-op (`db-profiles.ts:266`) is **never hit** for a first-run user because provisioning runs first; confirm ordering in the load path.

### 1.3 The guided panel: "Connect your first account — start with Test"

`first-run-guide.tsx` renders a single-column card with three ordered rungs. Copy is fixed (Phase-1-locked vocabulary):

```
Welcome. Let's get you running — safely.

  ①  You're in Test mode right now.
      Test is a local simulator. No broker, no login, no real money — nothing
      you do here can touch a real account. Practice as much as you want.
      [ Take a practice run → ]     ← fires strategy.run_once on the Test account

  ②  Ready for something more realistic? Connect a Paper account.
      Paper trading runs your strategy against a real broker's sandbox
      (e.g. Alpaca Paper). Still practice money — but real market plumbing.
      [ Connect a Paper account → ] ← opens Settings → Connections

  ③  Go Live only when you've seen it work.
      Live means real money and real orders. It's locked until you connect a
      Live broker account, and even then the AI can only *propose* until you
      arm it. You approve every order.
      [ greyed until a Live account exists ]
```

- Rung ① primary CTA `[ Take a practice run → ]` dispatches the same code path as chrome **▶ Run once** stamped `Run once — Test — Local Sim · TEST`.
- Rung ② `[ Connect a Paper account → ]` navigates to Settings → Connections (off-rail; `app/(shell)` avatar footer route). It does **not** open a gutted modal — follows the `openSettings`-relocation merge gate.
- The panel dismisses permanently once the **first proposal is approved** (see §6 unlock trigger), replaced by the normal Dashboard body. Provide a "Skip setup" text link that flips `firstRunDismissed = true` without requiring an approval.

### 1.4 First-run state model (net-new persistence)

New helper module: `src/lib/onboarding.ts`.

```ts
export interface FirstRunState {
  firstRun: boolean;            // true until firstApprovedProposalAt set OR dismissed
  hasAnyBrokerAccount: boolean; // any connected_accounts row with broker != "test"
  hasLiveAccount: boolean;      // any row environment === "live"
  hasPaperAccount: boolean;     // any broker (non-test) row environment === "paper"
  firstApprovedProposalAt: number | null;
  dismissedAt: number | null;
  unlockedDestinations: DestinationId[]; // derived — see §6
}
export function getFirstRunState(userId: string): FirstRunState; // calls ensureTestAccount + activation
export function markFirstApprovedProposal(userId: string): void;  // idempotent, sets timestamp once
export function dismissFirstRun(userId: string): void;
```

Persist `firstApprovedProposalAt` and `dismissedAt` as **user-global** rows via `getUserSetting`/`setUserSetting` (`src/lib/db-settings.ts`) under keys `onboarding.firstApprovedProposalAt` and `onboarding.dismissedAt`. This is per-user identity state, not per-account — it belongs to Scope B, never `account_strategy_state`.

`markFirstApprovedProposal(userId)` is called from the proposal-approval success path (`executeProposal` in the mobile path `mobile-api.ts:637`, and the equivalent web approval handler) — call after the fill is recorded, only on genuine approval (not reject/snooze).

**Acceptance:**
- AC-5: `getFirstRunState` returns `firstRun: true` for a user with only the auto-Test account and no approvals.
- AC-6: After one approved proposal (any account, incl. Test), `firstRun` flips false and `firstApprovedProposalAt` is stamped once and never overwritten.

---

## 2. Money-reality: the two-word education (Practice vs Real)

**The dial (money-reality) is orthogonal to authority (§3).** Test and Paper are both **PRACTICE**; Live is **REAL MONEY** (P5). Never teach "paper = fake" with color alone.

### 2.1 Word-class mapping (single source of truth)

New pure helper in `src/lib/execution-mode.ts` (co-located with `deriveExecutionState`):

```ts
export type MoneyRealityClass = "practice" | "real";
export function moneyRealityClass(state: ExecutionState): MoneyRealityClass {
  return state.mode === "broker/live" ? "real" : "practice"; // test/local + broker/paper => practice
}
export function moneyRealityLabel(state: ExecutionState): string {
  switch (state.label) {
    case "Test":      return "TEST · practice money";
    case "Paper":     return "PAPER · practice money";
    case "Brokerage": return "LIVE · real money";
  }
}
```

Color is applied **under** the word, never instead of it. Reuse existing `getThemeClasses` mode→class but **re-map to the word-class palette**:
- `test/local` → grey (`bg-slate-…`), word `TEST · practice money`.
- `broker/paper` → blue. **Change required:** `getThemeClasses("paper")` currently returns emerald (`execution-mode.ts:94`). The design's color spec is **grey/blue/red** (P5). Repaint paper to blue and live to red (currently amber `:96`). This is a Phase-1 copy/color change; update any test asserting emerald/amber on mode chips in the same PR.

### 2.2 Where the word-class renders

- **Switcher chip** (left zone): `alias · broker` + `moneyRealityLabel(state)` + authority chip. Single-account users: static chip, same label.
- **Run-once button** (right zone): stamped `Run once — <account> · <label>` where `<label>` is `TEST`/`PAPER`/`LIVE` (P novice #1).
- **Approve button** (Approvals card): `Approve ▸ PAPER` / `Approve ▸ LIVE` — money-reality bound to the commit action.
- **Viewport hairline:** grey when practice, **solid red** the instant a Live account is in view. Driven by `moneyRealityClass(state) === "real"`.

**Acceptance:**
- AC-7: For a Paper account, every chip/button reads the literal word "practice"; for Live, the literal words "real money," in text, independent of CSS.
- AC-8: `moneyRealityClass` returns `"real"` **only** for `broker/live`; Test and Paper both return `"practice"`.

---

## 3. Test → Paper → Live progression rituals

Money-reality advances by **connecting a broker account of that class**, not by flipping a slider. The progression is gated by account existence, not a mode toggle.

| From | To | Trigger | Ritual |
|---|---|---|---|
| Test | Paper | Connect a Paper broker link (Settings → Connections; `POST /api/connected-accounts` with a paper-env broker — `alpaca`/`alpaca-mcp` `PA*` prefix, or `robinhood` synced) | Standard connect flow; no type-to-confirm (still practice money). On success, switcher gains a **Paper** row; user must **switch into it** to act there. |
| Paper | Live | Connect a Live broker link (`alpaca` `PK*` prefix / `robinhood` live / env=`live`) | Connect flow **+** first switch-into-Live acknowledgment (P: "you are now acting on REAL MONEY" ack + red viewport). Rung ③ of the guide un-greys. |

**"Arm Live" (money-reality one-way door) vs "arm Auto-on-Live" (authority one-way door) are two separate type-to-confirm rituals** (P9). Connecting a Live account does **not** arm anything — the account lands `systemState: "halted"`, `strategyAuthority: "propose"`. See §4 for the arming rituals.

**Test exclusions carried through:** the Test account is never a Live-progression source — "arm Live" is unreachable from it (design §Screen 5), it is excluded from Fleet emergency controls, and excluded from cross-account wash-sale contribution (requires the `tax.ts:113` `test→paper` filter fix — out of scope here but a dependency for the Approvals culprit line).

**Acceptance:**
- AC-9: Connecting a Live account leaves it `systemState="halted"`, `strategyAuthority="propose"` (no auto-arm) — assert against `account_strategy_state` after `POST /api/connected-accounts`.
- AC-10: Switching *into* a Live account for the first time in a session renders the REAL MONEY acknowledgment and paints the viewport red.

---

## 4. Propose → Decide arming ritual + first-Live re-consent

Authority (`strategyAuthority: "propose" | "decide"`, `types.ts:17`) is the second orthogonal dial. It lives in **Guardrails → Autonomy** (design principle 6 — the dial is a containment decision, not a strategy edit), not Strategy.

### 4.1 Arm to Decide — type-to-confirm

Control: the **Autonomy dial** in Guardrails Essentials (design II-B: `strategyAuthority` [ACCOUNT]).

- Toggling `propose → decide` opens an inline **type-to-confirm** modal (not a browser confirm). Required typed string depends on money-reality:
  - Target is **practice** (Test/Paper): type `ARM DECIDE`.
  - Target is **Live** (real money): this is the "**arm Auto-on-Live**" one-way door — type the literal phrase `ARM LIVE AUTONOMY` and additionally re-echo the account alias.
- The confirm modal shows a **consequence preview** ("The AI will place orders on <account> · <label> without asking. You can drop to Propose or STOP at any time.").
- On confirm, write `strategyAuthority: "decide"` to that account's `account_strategy_state` via `setPolicy(next, userId, connectedAccountId)`. **Never** via the ambient mirror (removed at `db-profiles.ts:486/512/531` in P2).
- Dropping `decide → propose` is **frictionless** (loosening the leash toward safety), one click, no confirm.

### 4.2 First-Live-act-of-session re-consent (P9)

"Armed once" is **not** unlimited frictionless real orders. Independent of the Decide dial:

- The **first Live approval of a session** (Approve on a `broker/live` card) **and** the first Live approval after an idle window require an explicit confirm step.
- **Reuse the existing mechanism:** `executeProposal(..., { liveConfirmation })` already exists (`mobile-api.ts:639`), and `LiveApprovalConfirmationError` / `LiveApprovalConfirmation` are already the typed gate. Wire the session-first-act to require a `liveConfirmation` payload with `expectedText` echoed by the UI. Adjust-and-approve on Live **always** confirms final size (novice #12; re-runs the full policy gate on edited size).
- Session tracking: store `lastLiveActAt` per session (server session or a short-TTL user-setting key `onboarding.lastLiveActAt`); if `now - lastLiveActAt > IDLE_MS` (default 30 min) or unset this session, require re-consent.

**Acceptance:**
- AC-11: `propose → decide` on a Live account rejects the write unless the typed phrase `ARM LIVE AUTONOMY` + alias match; practice accounts accept `ARM DECIDE`.
- AC-12: First Live approval in a fresh session without `liveConfirmation` throws `LiveApprovalConfirmationError`; second approval within the idle window does not.
- AC-13: `decide → propose` writes with zero confirmation and one click.

---

## 5. Autonomy-reset-on-restart (net-new, REQUIRED, default ON)

**This is net-new** (Open Q2 resolved: build it regardless of whether an equivalent exists — the current `systemState` persistence does the opposite, it *survives* restart). From the user's perspective: **after the app/process restarts, every account drops to its safe floor (Propose-only) and stops running until the user re-arms.** This is a safety promise, not a preference.

### 5.1 Behavior (user-visible)

- On process restart, for **every** account (Live, Paper, Test):
  - `strategyAuthority` → `"propose"` (drop from Decide).
  - `systemState` → `"halted"` if it was `"active"` (drop from running); `close_only`/`liquidating` are preserved (they are already de-escalations, not autonomy).
- The switcher chip and Dashboard show the dropped state; a one-time banner: *"Autonomy was reset to Propose after a restart. Re-arm any account you want running."*
- Re-arming is the normal §4 ritual (type-to-confirm for Live).

### 5.2 Persistence + reset mechanism (design)

Add two columns to `account_strategy_state` (migration in `db.ts` `migrate()` per CLAUDE.md new-table/column rule; CRUD in `db-profiles.ts`):

- `armed_at INTEGER NULL` — set to `now` whenever `strategyAuthority` is written to `decide` **or** `systemState` to `active`.
- `armed_boot_id TEXT NULL` — the process boot id at arm time.

Add a module-load-time constant `BOOT_ID = crypto.randomUUID()` in a new `src/lib/runtime.ts` (one per process start).

**Reset trigger — lazy, at read time (safe across serverless + long-lived):** in `getPolicy(userId, connectedAccountId?)` (`db-profiles.ts:330`), when reading an account whose `armed_boot_id !== BOOT_ID` (or null) **and** it is currently `decide`/`active`, coerce the returned policy to `strategyAuthority: "propose"` and `systemState: "halted"` **and** write the demotion back (so the DB reflects the floor, not just the read). This mirrors the existing not-active→halted coercion pattern (`:348-350`) but keyed on boot-id rather than active-singleton — and it **replaces** that active-singleton coercion post-P2 as the deterministic floor.

- Also run an **eager sweep** on server boot: a `resetAutonomyOnBoot()` in `src/lib/runtime.ts` invoked once from server init, `UPDATE account_strategy_state SET system_state='halted' WHERE system_state='active'; ... strategy_authority='propose' WHERE strategy_authority='decide' AND (armed_boot_id IS NULL OR armed_boot_id != ?)`. The lazy read-time coercion is the correctness backstop for environments where boot init doesn't run.
- **Scheduler interaction (closes Part III gap #7):** the scheduled/cron run enumerates only accounts where `systemState='active' AND strategy_authority='decide' AND armed_boot_id = BOOT_ID`. A restart therefore empties the fan-out set until re-arm — exactly the intended safety floor. This is the concrete post-singleton fan-out semantics.

**Acceptance:**
- AC-14: An account armed `decide`/`active` under boot id A, read under boot id B, returns `propose`/`halted` and the DB row is rewritten to that floor.
- AC-15: The scheduler's account set is empty immediately after a restart until at least one account is re-armed under the current boot id.
- AC-16: `close_only` and `liquidating` states survive restart unchanged.

---

## 6. Progressive destination unlock

A first-run novice sees only **Dashboard, Approvals, Guardrails** (Guardrails labeled "Safety limits" in the novice frame). **Strategy** and **Results** unlock after the **first approved proposal** (P10).

### 6.1 Unlock model

`getFirstRunState(userId).unlockedDestinations` is derived, not stored:

```ts
const BASE: DestinationId[] = ["dashboard", "approvals", "guardrails"];
const UNLOCKED_AFTER_FIRST_APPROVAL: DestinationId[] = ["strategy", "results"];
// Scan is always reachable read-only via Dashboard drill-down (secondary), not gated here.
unlockedDestinations = firstApprovedProposalAt || dismissedAt
  ? [...BASE, ...UNLOCKED_AFTER_FIRST_APPROVAL]
  : BASE;
```

- Rendering: the center-spine nav (`app/(shell)/layout.tsx` chrome) renders **Strategy** and **Results** as **greyed, non-interactive** items with a tooltip *"Unlocks after your first approved proposal"* until unlocked. Greyed items are visible (so the user sees the ceiling) but not navigable — matches the design's "greyed until an account exists" pattern applied to destinations.
- **Guardrails is never greyed** for a first-run user — the fence must always be reachable. It is relabeled "Safety limits" in the novice frame; the label reverts to "Guardrails" once unlocked (or leave "Guardrails" throughout if simpler — owner may pick; default: relabel).
- The "Skip setup" link (§1.3) sets `dismissedAt`, which also unlocks everything — a power user is never trapped in the novice frame.
- **Single-account + first-run compose cleanly:** the Test auto-account is single, so all multi-account chrome (Fleet, scope tags, origin badges) is already suppressed (P11); progressive unlock is orthogonal and layers on top.

### 6.2 Greyed destinations when no account exists

Distinct from progressive unlock: if (hypothetically) **no** account exists — which the Test auto-provision (§1.2) prevents — all six destinations render greyed with the single "Connect your first account" CTA. Because auto-provision guarantees ≥1 account, this state is only reachable transiently before provisioning completes; render it as a loading/greyed shell, never a dead end.

**Acceptance:**
- AC-17: A first-run user's nav renders Strategy and Results greyed + non-navigable; Dashboard/Approvals/Guardrails interactive.
- AC-18: After first approval (or Skip), Strategy and Results become navigable in the same session without reload.
- AC-19: Guardrails is interactive for a first-run user at all times.

---

## 7. Mobile / PWA parity (spec now, implement in Phase 5)

Full account-scope parity is specified now; the switcher, STOP, arming, and scoped context all survive on phone. Grounding: `src/lib/mobile-api.ts`, `app/api/mobile/commands/route.ts`, `app/mobile/page.tsx`.

### 7.1 mobile-api adopts account-scope (closes Part III gap #3 — the P2 side-door)

Today `account.activate` (`mobile-api.ts:647-651`) calls `setActiveConnectedAccount(accountId, userId)` — it **writes the execution singleton**. Post-P2 that is a side-door that re-introduces the coercion P2 deletes. **Required changes:**

- **Split the command** into two, mirroring the web view/execution decouple:
  - `account.switch_view` — sets the **ephemeral, per-session** view-scope (does NOT write the persisted singleton). This becomes the default mobile "look at account X" action.
  - `account.activate` — retained but **re-pointed** at the new per-account arming path, and gated: it may set which account is armed, but only via the same server-side write-time `accountId` validation (P3) and never coerces siblings to halted.
- **All scoped mobile commands carry an explicit `accountId` in `payload`.** `strategy.start/stop/close_only/liquidating` (`:629-636`), `policy.patch` (`:675`), `proposal.approve/reject`, `alert.*`, `watchlist.*` must accept and validate `payload.accountId` against the session (server-side write-time validation — the real safety boundary, P3). Where absent, fall back to the session view-scope for single-account users (auto-resolve, P11/Open Q7); **fail closed** for multi-account users.
- `setStrategyState` (`mobile-api.ts:576`) and `applyPolicyPatch` (`:596`) currently call `getPolicy(userId)` / `setPolicy(next, userId)` with **no account arg** — they resolve to the active singleton. Re-point both to take `connectedAccountId` from the validated command payload: `getPolicy(userId, accountId)` / `setPolicy(next, userId, accountId)` (`db-profiles.ts:330/412` already accept the optional arg).

### 7.2 Mobile switcher + STOP + arming

- **Switcher:** `app/mobile/page.tsx` renders the same account list from `listConnectedAccounts(userId)` with Sandbox grouping, money-reality word-class, authority chip, health/day-P&L. Single-account = static chip. Selecting a row dispatches `account.switch_view` (view-scope), not `account.activate`.
- **STOP:** the mobile chrome carries an always-visible **■ STOP** dispatching `strategy.stop` with `payload.accountId` = current view-scope. STOP halts new activity, never sells (parity with chrome; Flatten is a separate secondary action). **Fleet STOP** (all Live + all Paper, Test excluded) on mobile dispatches a fleet halt that iterates every non-Test account and echoes per-account confirmed-halted — same semantics as web Fleet controls; meaningful only post-P2.
- **Arming:** Propose→Decide on mobile uses `policy.patch` with `{ accountId, patch: { strategyAuthority: "decide" } }` **plus** a client-side type-to-confirm before dispatch; Live targets require the `ARM LIVE AUTONOMY` phrase echoed in the payload as an idempotency-guarded confirm token. First-Live-act re-consent reuses the `liveConfirmation` payload already threaded through `proposal.approve` (`:639`).

### 7.3 Autonomy-reset-on-restart on mobile

`mobileReadiness(userId)` (`:762`) already returns `systemState` + `strategyAuthority`. After a server restart the boot-id coercion (§5) makes these read `halted`/`propose`; the mobile client surfaces the same "Autonomy was reset after a restart — re-arm to resume" banner. No mobile-specific reset logic — it inherits the server floor via `getPolicy`.

### 7.4 mobileControlCatalog + readiness additions

- Add the two new command types to `MOBILE_COMMAND_TYPES` and `mobileControlCatalog().commands` (`:758`): `account.switch_view`.
- Add to `mobileReadiness`: `firstRun` and `unlockedDestinations` from `getFirstRunState(userId)` so the PWA can render the same progressive-unlock frame and the onboarding guide. `ensureTestAccount(userId)` is invoked inside `mobileReadiness` so a phone-first user is auto-provisioned identically (§1.2).

### 7.5 Where /welcome lands on mobile

`/welcome` remains the public marketing page (outside the shell, unauthenticated) on mobile too. The **in-app** first-run guide renders inside `app/mobile/page.tsx` when `mobileReadiness().firstRun === true`, using the same three-rung copy (§1.3) adapted to a single mobile column. `/welcome` never renders the guide on mobile.

**Acceptance:**
- AC-20: A mobile `strategy.start` without `payload.accountId` for a multi-account user fails closed (validation error); for a single-account user it auto-resolves to the sole account.
- AC-21: `account.switch_view` does not mutate `connected_accounts.is_active`; `account.activate` is the only path that touches arming, and it never coerces siblings to `halted`.
- AC-22: `mobileReadiness` on a brand-new user auto-provisions the Test account and returns `firstRun: true`, `unlockedDestinations: ["dashboard","approvals","guardrails"]`.

---

## 8. Cross-cutting acceptance / verify

Run the CLAUDE.md trio + lint before claiming done: `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`.

New/changed tests to add in the owning PRs:
- `test/onboarding.test.ts` — first-run state, Test auto-provision idempotency (AC-1..6,17,18), progressive unlock derivation.
- `test/execution-mode.test.ts` (extend) — `moneyRealityClass`/`moneyRealityLabel` word-class (AC-7,8); repainted paper=blue/live=red (update emerald/amber assertions).
- `test/autonomy-reset.test.ts` — boot-id coercion + scheduler-fanout emptiness after restart (AC-14,15,16).
- `test/arming-ritual.test.ts` — type-to-confirm phrases + first-Live re-consent via `liveConfirmation` (AC-11,12,13).
- `test/mobile-api.test.ts` (extend) — `account.switch_view` vs `account.activate` split, per-command `accountId` validation fail-closed/auto-resolve (AC-20,21,22).

**Dependencies on other sections' work (do not duplicate here):**
- Test-out-of-wash-sale `tax.ts:113` filter and `getUserWashSaleLockedSymbols` provenance return-type change — owned by the Approvals/Multi-account section; this section only relies on Test being excluded from Live consequences.
- P2 view/execution decouple + server-side write-time `accountId` validation + `mirrorPolicyToActiveAccount` removal (`db-profiles.ts:486/512/531`) — owned by the frame/scoping section; §4/§5/§7 here **require** it landed first.

Key files this section creates or touches: **new** `src/lib/onboarding.ts`, `src/lib/runtime.ts`, `app/(shell)/onboarding/first-run-guide.tsx`; **modified** `src/lib/execution-mode.ts` (word-class helpers, repaint), `src/lib/db-profiles.ts` (`getPolicy` boot-id coercion, `armed_at`/`armed_boot_id` CRUD), `src/lib/db.ts` (`migrate()` columns), `src/lib/mobile-api.ts` (command split, per-command `accountId`, readiness additions), `app/mobile/page.tsx` (mobile switcher/STOP/guide), `app/(shell)/layout.tsx` (greyed destinations), `app/(shell)/page.tsx` (first-run panel mount); **reused unchanged** `src/lib/db-api-keys.ts` `ensureTestAccount:566` / `setActiveConnectedAccount:681` / `getActiveConnectedAccount:580`.
