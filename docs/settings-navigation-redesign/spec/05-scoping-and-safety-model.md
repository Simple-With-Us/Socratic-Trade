# Multi-Account Scoping & Safety Model

> **Section owner:** Multi-account scoping & safety correctness.
> **Canonical parent:** [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2). This section goes deep on Principles **2, 3, 7, 8**, Open Questions **2/3/7**, and Part III gaps; it does not restate the IA, wireframes, or vocabulary — those are locked in the parent. Where the parent says "spec it here," this is here.
> **Grounding baseline:** verified against the live tree this session — `src/lib/db-profiles.ts`, `src/lib/tax.ts`, `src/lib/scheduler.ts`, `src/lib/db-settings.ts`, `src/lib/db-api-keys.ts`, `src/lib/db.ts`, `src/lib/types.ts`. Every `file:line` below is real.

---

## 0. What this section fixes, and the two facts the parent doc got wrong

The parent doc (v2) carries two assumptions in its Open Questions that this session's code read **resolves outright**. Correcting them is load-bearing for the rest of the spec:

1. **Open Q2 — "Autonomy-resets-on-restart: does it exist, or is it net-new?"** — **It exists and is authoritative.** `reconcileAutonomyOnBoot()` (`src/lib/scheduler.ts:66-97`) already reverts every `systemState === "active"` account to `"halted"` on boot unless a per-user `autoResumeOnBoot` opt-in (`src/lib/db-settings.ts:249-258`) or the `AUTONOMY_RESUME_ON_BOOT=1` env override is set. The reset is **audited** (`autonomy_halted_on_boot`) and iterates **every** connected account, not just the active one (`scheduler.ts:82-84`). The net-new work is not the mechanism — it is (a) making the default-ON contract explicit and un-overridable-by-accident, (b) surfacing the post-reset state in the new chrome, and (c) a per-account (not per-user) opt-in granularity. See §5.

2. **Part III / multiaccount-edge #8 — "Fleet controls are meaningful only after P2's concurrent-arming model exists."** — **The concurrent-arming model already exists in the execution path.** The scheduler fan-out (`scheduler.ts:211-310`) **already** enumerates `listConnectedAccounts(userId)` and runs each account whose **own** `policy.systemState === "active"`, keyed per `(userId, accountId)` (`scheduleKey`, `:44-46`), with per-account cadence clocks (`accountSchedules`, `:39-42`). Plural per-account "armed" state is **already persisted** in `account_strategy_state.system_state`. What is *not* decoupled is the **view/read** path (`getActiveConnectedAccount` singleton) and the **write** path's not-active→halted coercion. So P2 is narrower than the doc feared: it is a *read/write-path* fix, not a *scheduler rewrite*. See §3 and §6.

These two corrections are why this section can be concrete about schema — most of the safety substrate is already in the DB; the redesign is about **closing the leaks around it**, not building it from scratch.

---

## 1. The three entities (schema-anchored, canonical)

| Entity | Canonical schema anchor | Identity key | What it holds | Blast radius | Mutating API surface |
|---|---|---|---|---|---|
| **Connected Account** | `connected_accounts` (`db.ts` CREATE, cols `id, user_id, broker, environment, account_number, label, taxation_type, capabilities, is_active`) + its bound live row `account_strategy_state` (PK `user_id, connected_account_id`) | `connected_accounts.id` (UUID) | Broker link + the one running `(policy, prompt, scoringWeights)` + `system_state` + `derived_from_profile_id` + ledger (`fill_events`, `trade_proposals`, `portfolio_snapshots`, all scoped by `user_id`+`account_number`) | **This account only** | `/api/connected-accounts`, `/api/policy` (PUT), `/api/strategy/{run,pause,enable,tune}` |
| **Preset** (renamed from "Strategy Profile") | `strategy_profiles` (cols `id, user_id, name, policy, prompt, scoring_weights, active`) | `strategy_profiles.id` (UUID) | Inert reusable template of **exactly** `(policy-account-fields + prompt + scoringWeights)`. **Never** `taxation_type`, `system_state`, keys, or `notificationSettings`. | Every account it is **copied into, at copy time only** | `/api/profiles`, `/api/profiles/[id]`, `/api/profiles/[id]/{activate,copy}` |
| **User-global** | `USER_LEVEL_POLICY_FIELDS` (`db-profiles.ts:20-24`) — **exactly three**: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve` — stored in `user_settings.policy`; plus `user_api_keys`, `notification_prefs`, `user_memory` | `user_id` | Identity, keys, model defaults, notification channels, data-source toggles, the preset library, shared-scan breadth | **All accounts** | `/api/keys`, `/api/notifications`, `/api/settings/*`, `/api/policy` (user-field slice) |

**Invariant (single source of truth):** `USER_LEVEL_POLICY_FIELDS` is the *only* arbiter of which fields are user-global. `pickUserFields`/`pickAccountFields`/`stripUserFields` (`db-profiles.ts:29-61`) all derive from it. **Any field-scope change is a coordinated migration + Set edit + per-account back-fill in ONE PR, gated by a round-trip read-after-write test per field** (§9, acceptance criteria). This is the exact silent-write trap CLAUDE.md's enrichment note warns about: the field writes to the wrong store and reads back as default.

---

## 2. The three-tier resolution contract with provenance

The parent's contract is:

```
USER-GLOBAL  →  PRESET (copied in)  →  ACCOUNT OVERRIDE  →  EFFECTIVE (+ origin)
```

### 2.1 How resolution actually runs today (and where provenance must be added)

`getPolicy(userId, connectedAccountId?)` (`db-profiles.ts:330-374`) already implements the *value* half of this contract:

1. Resolve the account (`resolveAccount`, `:190-193`).
2. Read the account's live row (`account_strategy_state`), else seed it from `getBasePolicy` (active preset, else legacy `user_settings.policy`).
3. **Overlay** the three user-level fields on top (`readUserPolicyFields` → `mergePolicy({...policy, ...userFields})`, `:362-363`).
4. Stamp `connectedAccountId`, `activeBroker`, `accountNumber`, `paperMode` (`:364-367`).

What it does **not** produce is **provenance** — the `EffectiveField.origin`. The redesign adds a **read-only projection function** that returns, per field, where the effective value came from. This must not disturb the hot `getPolicy` path (it stays value-only); provenance is a **separate, opt-in, read-only computation** for the config surfaces.

### 2.2 New type + function (net-new, spec)

**File:** `src/lib/policy-provenance.ts` (new)

```ts
export type FieldOrigin =
  | "account"          // ● overridden on this account (differs from preset+global)
  | "preset"           // ↳ inherited from the copied-in preset, unchanged
  | "account-type"     // ⊘ locked/forced by taxation_type or capabilities (e.g. washSaleGuard=false on IRA)
  | "global";          // your user-global default (the 3 USER_LEVEL fields)

export interface EffectiveField<T = unknown> {
  key: keyof TradingPolicy;
  value: T;
  origin: FieldOrigin;
  presetValue?: T;      // for "Changed from preset" pill + reset-to-source
  globalValue?: T;      // for reset-to-global
  locked: boolean;      // account-type/capability lock → control renders disabled
}

/** Read-only. NEVER seeds account_strategy_state. Composes on top of peekPolicy(). */
export function resolveEffectivePolicy(
  userId: string,
  connectedAccountId: string
): Record<keyof TradingPolicy, EffectiveField>;
```

**Derivation rules (deterministic, no LLM):**
- `origin = "global"` iff `USER_LEVEL_POLICY_FIELDS.has(key)`.
- `origin = "account-type"` iff the field is forced by `resolveTaxSettings` (`tax.ts:51-61` zeroes rates + `washSaleGuard=false` for IRAs) **or** greyed by the account's `capabilities` JSON (e.g. shorting on a cash account). `locked = true`.
- `origin = "preset"` iff the account row's value **equals** the `derived_from_profile_id` preset's value for that field (three-way base compare, §4).
- `origin = "account"` otherwise (diverged from preset).
- Base it on **`peekPolicy`** (`db-profiles.ts:381-410`), the existing read-only projection that **never seeds** — so opening a config screen for a not-yet-touched account can't write a row (which today would trip the halted-coercion, §3).

### 2.3 Origin badge rendering (per parent §Multi-account)

- **Essentials view:** only a plain **"Changed from preset"** text pill on the few differing fields (`origin === "account" && presetValue !== value`). No glyphs.
- **Advanced reveal:** full four-glyph taxonomy `● account · ↳ from preset · ⊘ locked by account type · (blank) your global default`, plus the **"Overrides (N)"** chip = count of `origin === "account"` fields.
- **Reset-to-source** on every field: `origin==="account"` → reset to `presetValue`; `USER_LEVEL` field → reset to `globalValue`. Both are ordinary `PUT /api/policy` writes and go through the full server guard (§7).

**Acceptance:** `resolveEffectivePolicy` never mutates the DB (assert row count unchanged before/after a call on a fresh account). Every `EffectiveField` with `locked===true` renders a disabled control with the account-type explainer.

---

## 3. VIEW-scope vs EXECUTION-scope decouple (the first blocking migration, P2)

### 3.1 The three couplings that make switching unsafe today

Grounded in code:

| # | Coupling | Where | Effect |
|---|---|---|---|
| C-1 | **Active account is a persisted singleton** | `connected_accounts.is_active` + `getActiveConnectedAccount` (`db-api-keys.ts:580`), `setActiveConnectedAccount` (`:681-688`) | "Which account is in view" and "which account APIs mutate by default" are **the same pointer**. |
| C-2 | **not-active → halted coercion** | `db-profiles.ts:283-284, 349-350, 396-397` | When a non-active account's row is seeded/read, if base policy is `active` it is forced to `halted`. Flipping the active pointer can **silently demote the account you left running** on its next policy write. |
| C-3 | **Ambient mirror to active account** | `mirrorPolicyToActiveAccount` (`db-profiles.ts:249-259`), called at `:486, :512, :531` | A preset edit / activation writes into **whatever account is active** — a side door bypassing per-account intent (Principle 7). |

### 3.2 Target model

**VIEW-scope** = *which account is on screen*. Ephemeral, **per-tab**, plural-safe, never persisted to `connected_accounts.is_active`. Lives in:
- URL seed: `/a/:accountId/...` (§8).
- Client state: a per-tab `viewAccountId` (React context), **not** localStorage-global (avoids the mobile singleton-setter hazard, §10).

**EXECUTION-scope** = *which accounts are armed to run*. Persisted, **plural**, already correct in `account_strategy_state.system_state` per account. The scheduler already reads this per-account (`scheduler.ts:231, 277`). Arming is a **deliberate write** to one account's `system_state`, never a side effect of viewing.

### 3.3 The P2 migration, concretely (ordered)

1. **Introduce `viewAccountId` as a request-scoped parameter, not a DB read.** New helper `resolveViewAccountId(req)` in `src/lib/request-account.ts` (new): reads `/a/:accountId` route param (or `X-Account-Id` header for API/mobile), validates it against the session (§7), returns it. `getActiveConnectedAccount` is **retained only** as the *default landing* resolver and the *scheduler's "which account's schedule to show on the dashboard"* helper (`scheduler.ts:104`) — it is **removed from every mutating path**.
2. **Delete the not-active→halted coercion (C-2).** Remove the `if (account.id !== activeId && policy.systemState === "active") policy.systemState = "halted"` blocks at `db-profiles.ts:283-284, 349-350, 396-397`. Once execution-scope is per-account-persisted and reads no longer imply "this is the one true active account," a non-active account being `active` is **correct** (that is exactly what the scheduler fan-out expects). Boot safety is preserved by `reconcileAutonomyOnBoot` (§5), which is the *intended* place for the "don't resume unattended" interlock — not a read-time side effect.
3. **Delete the ambient mirror (C-3).** Remove `mirrorPolicyToActiveAccount` calls at `:486, :512, :531`. Replace with explicit intent:
   - `createStrategyProfile(active:true)` / `updateStrategyProfile` / `activateStrategyProfile` → write **only** the library `strategy_profiles` row + `user_settings.policy` "library default." They **do not** touch any account.
   - Copying into an account is **only** `applyProfileToAccount(profileId, accountId)` (`db-profiles.ts:547-578`) — which already exists, already preserves `system_state` (`:557`, "never arm a halted account"), already stamps `derived_from_profile_id`, and already audits `copy_to_account`. This is the sanctioned door.
4. **Only after 1–3 is the switcher "free."** Until then the switcher is gated to (a) read-only comparison, or (b) a warn-on-switch ("switching may pause the previously-active account"). This gate is a client flag `multiAccountViewSwitchEnabled`, default OFF until P2 lands.

**Acceptance criteria (P2):**
- Grep proves zero `mirrorPolicyToActiveAccount` call sites remain.
- Grep proves zero not-active→halted coercions remain.
- Test: with accounts A (active) and B (running/`active`), a `PUT /api/policy` scoped to A does **not** change B's `system_state` (read B's row before/after).
- Test: activating a preset changes **no** `account_strategy_state` row (only `strategy_profiles` + `user_settings`).
- Test: `applyProfileToAccount` onto a `halted` account leaves `system_state === "halted"`.

---

## 4. Presets: copy-on-bind + three-way resync with per-field Live friction

### 4.1 Copy-on-bind (already partially built)

`applyProfileToAccount` (`db-profiles.ts:547-578`) is the copy-on-bind primitive: snapshot preset `(policy, prompt, scoringWeights)` into `account_strategy_state`, stamp `derived_from_profile_id = profile.id`, preserve `system_state`. **Gap:** it snapshots the *current* preset but does **not** record the **base snapshot** needed for a three-way diff. Add one column.

**Schema change (migration v9):**
```sql
ALTER TABLE account_strategy_state ADD COLUMN derived_snapshot TEXT;  -- JSON {policy, prompt, scoringWeights} at copy time
ALTER TABLE account_strategy_state ADD COLUMN derived_at TEXT;        -- ISO timestamp of last copy/resync
```
Write `derived_snapshot` = the exact preset payload copied in, inside `applyProfileToAccount` and `activateStrategyProfile`'s (now-removed-mirror-replaced) account path. This is the **base** for the three-way diff.

### 4.2 The three-way resync algorithm

**File:** `src/lib/preset-resync.ts` (new). Inputs: `base` (`derived_snapshot`), `presetNow` (`strategy_profiles` current), `accountNow` (`account_strategy_state` current).

Per field `f` (iterate the union of preset-eligible fields — **account-level policy fields + prompt + each scoring weight**; never the 3 user-global fields, never `taxation_type`/`system_state`):

```
baseV, presetV, accountV = base[f], presetNow[f], accountNow[f]

if presetV == baseV:                      # preset unchanged since copy
    result[f] = accountV                  # keep account (incl. local edits)   → class: UNCHANGED
elif accountV == baseV:                    # account never diverged on f
    result[f] = presetV                    # fast-forward to preset            → class: FAST_FORWARD
else:                                       # both moved → real conflict
    result[f] = CONFLICT(baseV, presetV, accountV)   # user picks per field    → class: CONFLICT
```

The UI presents **only** `FAST_FORWARD` and `CONFLICT` fields (UNCHANGED are silent). Default selection: FAST_FORWARD adopts `presetV`; CONFLICT defaults to **keep account** (never silently overwrite an account edit).

### 4.3 Per-field Live-loosening friction

A field's resolved `result[f]` requires an **inline typed/confirm acknowledgment** iff **all** of:
1. The target account's `environment === "live"` (from `connected_accounts.environment`), **and**
2. Adopting `result[f]` **loosens a limit** vs `accountNow[f]`.

**"Loosens a Live limit" is a per-field predicate**, defined in a table (`src/lib/limit-direction.ts`, new):

| Field | Loosen direction |
|---|---|
| `maxOrderNotional`, `maxDailyNotional`, `maxPositionPct`, `maxDailyOrders`, `maxProposalsPerRun`, per-symbol/sector/gross/net/beta caps | **increase** |
| `stopLossPct`, `takeProfitPct`, drawdown/daily-loss breaker thresholds | **widen** (larger loss tolerated) |
| `requireStopLoss`, `washSaleGuard`, circuit breakers, `runDuringExtendedHours=false→true` | **on→off** (or enabling extended hours) |
| `systemState` | never resynced (excluded) |

**No bulk bypass:** the resync "Apply all" button applies non-friction fields immediately but **queues each loosening field for its own inline confirm** — identical to a manual edit (parent Principle 8). A resync that loosens 3 Live limits produces 3 confirms, not one.

**Acceptance:**
- Test: base=preset (preset unchanged) → resync is a no-op regardless of account edits.
- Test: FAST_FORWARD on a **tightening** Live field applies with no friction; FAST_FORWARD on a **loosening** Live field demands confirm.
- Test: CONFLICT defaults to keep-account and never auto-adopts preset.
- Test: resync onto a Paper/Test account has **zero** friction gates (only Live).

---

## 5. Autonomy-reset-on-restart (default ON) — where the reset happens, what persists

**This mechanism exists (`scheduler.ts:66-97`). The redesign hardens and re-scopes it.**

### 5.1 Contract (locked)

- **Default ON.** On process boot, **every** account's `system_state === "active"` is reverted to `"halted"` and audited, **unless** that account is explicitly opted into auto-resume.
- **What persists across restart:** the account's full `(policy, prompt, scoringWeights)` and its `derived_from_profile_id` — only the **run authority** (`system_state`) drops to the safe floor. Config is never lost; only the leash re-tightens.
- **What resets:** `system_state: active → halted`. `close_only` and `liquidating` are **left untouched** (`scheduler.ts:61`) — they are themselves human/breaker-set safe states.

### 5.2 Where the reset happens (ordering, load-bearing)

`reconcileAutonomyOnBoot()` runs **once, before the first tick**, inside `startScheduler()` (`scheduler.ts:130`), *before* `void tick()` (`:133`). This ordering is a hard requirement: a restored/copied DB must not fire a run between boot and reconcile. **Do not move the reconcile after the first tick.**

### 5.3 Net-new: per-account opt-in granularity

Today the opt-in is **per-user** (`autoResumeOnBoot`, `db-settings.ts:251-258`) — all-or-nothing across a user's accounts. The redesign makes it **per-account** so a user can auto-resume a Paper account but never a Live one.

**Schema change (migration v9, same as §4.1):**
```sql
ALTER TABLE account_strategy_state ADD COLUMN auto_resume_on_boot INTEGER NOT NULL DEFAULT 0;
```

**Resolution rule in `reconcileAutonomyOnBoot` (replace `getAutoResumeOnBoot(userId)` gate at `scheduler.ts:74`):**
```
resumeThisAccount =
     process.env.AUTONOMY_RESUME_ON_BOOT === "1"          # global operator override (unchanged)
  || account_strategy_state.auto_resume_on_boot === 1     # NEW per-account opt-in
  || (legacy) getAutoResumeOnBoot(userId) === true        # back-compat: honor old per-user flag for one release
```
**Live safety floor:** a **Live** account's `auto_resume_on_boot` toggle requires **type-to-confirm** to enable (it is a one-way-door — you are pre-authorizing unattended real-money autonomy across restarts) and is surfaced with a persistent warning in Guardrails → Autonomy. The per-user legacy flag is migrated to per-account (back-fill: set `auto_resume_on_boot=1` on all of a user's accounts iff the legacy user flag was true) and then retired.

**UI home:** Guardrails → Autonomy (account-scoped), a single toggle **"Auto-resume this account's autonomy after a restart"**, default OFF, with the Live confirm. Settings → Admin still shows the global `AUTONOMY_RESUME_ON_BOOT` env state read-only.

**Acceptance:**
- Test: boot with A=`active` (opt-in OFF), B=`active` (opt-in ON) → A becomes `halted` + audited `autonomy_halted_on_boot`; B stays `active`.
- Test: `close_only`/`liquidating` survive boot untouched.
- Test: enabling `auto_resume_on_boot` on a Live account without the typed confirm is rejected server-side (§7).
- Test: legacy per-user `autoResumeOnBoot=true` back-fills all accounts to `auto_resume_on_boot=1` on the v9 migration.

---

## 6. Scheduler fan-out semantics (post-singleton) — schema anchor

**The critic gap ("how does a scheduled/cron run enumerate which accounts to run post-singleton?") is already answered by the code and needs only to be made normative + hardened.**

### 6.1 Fan-out is per-account, not per-active-singleton (grounded)

Every tick (`scheduler.ts:140-336`):
1. `for (const userId of listUsers())` → `for (const account of listConnectedAccounts(userId))` (`:217-218`) — **enumerates all accounts**, never `getActiveConnectedAccount`.
2. Per account, reads its **own** `policy = getPolicy(userId, accountId)` (`:231`) — the per-account `account_strategy_state` row.
3. Runs a strategy pass **iff `policy.systemState === "active"`** (`:277, :306-308`), on that account's **own cadence clock** (`accountSchedules[scheduleKey(userId, accountId)]`, `:44, :294-308`).
4. Executes due runs with bounded concurrency (`MAX_CONCURRENCY = 3`, `:313`) via `runStrategyOnce(userId, { connectedAccountId: accountId })` (`:317`).

**Schema anchor for "plural per-account armed state":** `account_strategy_state (user_id, connected_account_id, system_state)` — PK `(user_id, connected_account_id)`. This **is** the fan-out enumeration source. There is no singleton in the execution path. The "active" singleton (`connected_accounts.is_active`) is used **only** for view-default and the dashboard's "which schedule to show" (`scheduler.ts:104`) — never for deciding what runs.

### 6.2 What P2 changes for the scheduler (minimal)

Because the scheduler already fans out per-account, P2's only scheduler-adjacent requirement is: **the not-active→halted coercion removal (§3.3-2) must not change fan-out behavior.** It doesn't — the scheduler reads `system_state` directly from the row; the coercion only fired in `getPolicy`/`peekPolicy` seeding. After removal, an account the user armed and left running **stays armed across a view-switch**, which is the intended plural-arming semantics. Add a regression test pinning this.

### 6.3 Normative statement for the doc

> A scheduled run enumerates accounts by iterating `account_strategy_state` (via `listConnectedAccounts` + per-account `getPolicy`) and runs **each account whose own `system_state === "active"`**, independently, on its own cadence, under a global concurrency cap of 3. The active-view singleton has **no role** in this enumeration. Arming is per-account and persisted; boot reverts every armed account to the safe floor unless per-account-opted-in (§5).

**Acceptance:**
- Test: accounts A(`active`), B(`halted`), C(`active`) → a due tick queues runs for A and C only, never B.
- Test: view-switch from A to B (P2) does not change A's or C's `system_state`; a subsequent tick still runs A and C.
- Test: two `active` accounts of one user maintain **independent** `nextRunAt` clocks (`accountSchedules` keyed separately).

---

## 7. Server-side write-time `accountId` validation — the real safety boundary (P3)

The URL (`/a/:accountId`) and client `viewAccountId` are **ergonomics**. The **only** thing that prevents an autonomous agent (or a stale tab, or a spoofed request) from acting on the wrong real-money account is **server-side validation on every mutating write**.

### 7.1 The validator

**File:** `src/lib/request-account.ts` (new).

```ts
/**
 * Resolve + AUTHORIZE the target account for a mutating request. Throws (→ 403/404) if the
 * accountId does not belong to the session's userId. This is the safety boundary — no mutating
 * path may resolve an account by trusting the URL/header alone.
 */
export function requireAuthorizedAccount(
  req: Request,
  opts?: { allowSingleAccountFallback?: boolean }
): { userId: string; accountId: string; account: ConnectedAccount } {
  const userId = resolveRequestUserId(req);              // existing helper
  const requested = readRequestedAccountId(req);         // /a/:id param OR X-Account-Id header OR body.accountId
  const accounts = listConnectedAccounts(userId);

  // SINGLE-ACCOUNT auto-resolve (parent LOCKED decision): exactly one account → a stale/absent id
  // resolves to the sole account instead of failing closed.
  if (accounts.length === 1 && (!requested || requested === accounts[0].id || opts?.allowSingleAccountFallback)) {
    return { userId, accountId: accounts[0].id, account: accounts[0] };
  }

  // MULTI-ACCOUNT: fail closed. The requested id MUST exist AND belong to this user.
  const match = accounts.find((a) => a.id === requested);
  if (!match) throw new AccountScopeError(requested, userId); // → 403
  return { userId, accountId: match.id, account: match };
}
```

### 7.2 Where it is mandatory (every mutating account-scoped route)

Retrofit **every** route that writes account-scoped state to call `requireAuthorizedAccount` and pass the returned `accountId` explicitly into the `db-profiles` functions (which already accept `connectedAccountId`):

| Route | Current risk | Required change |
|---|---|---|
| `/api/policy` PUT | writes via `setPolicy` → resolves active singleton | resolve `accountId` via validator; call `setPolicy(policy, userId, accountId)` |
| `/api/strategy/run` POST | `runStrategyOnce(userId)` uses active singleton | pass validated `{ connectedAccountId }` |
| `/api/strategy/{pause,enable,tune}` | active singleton | validated `accountId` |
| `/api/profiles/[id]/copy`, `/api/profiles/[id]/activate` | copy target trusts body | validate **target** `accountId` belongs to user |
| `/api/proposals/[id]/{approve,reject}` | proposal→account link | validate the proposal's account belongs to user **and** matches the request's scope |
| `/api/connected-accounts/[id]/activate` (`route.ts`) | already scopes by `resolveRequestUserId` in `setActiveConnectedAccount` (`db-api-keys.ts:687` — `WHERE id=? AND user_id=?`) | **keep**, but this is view-scope only post-P2; add validator for symmetry |
| `/api/orders/*`, `/api/positions`, `/api/portfolio` | reads, but `cancel`/`replace-market` mutate broker | validate `accountId` on the mutating ones |
| `/api/mobile/commands` POST | mobile arming/run | validator with `X-Account-Id`; **no single-account fallback for Live arming** |

**Rule:** the DB write functions already take `connectedAccountId` (`setPolicy`, `getPolicy`, `applyProfileToAccount`). The safety boundary is **making the route pass a *validated* id** instead of letting `resolveAccount` fall back to the active singleton for mutations. `getActiveConnectedAccount` fallback is acceptable for **reads/view-default only**, never for writes.

### 7.3 Automated/scheduled paths never inherit view-scope

The scheduler already passes an explicit `connectedAccountId` (`scheduler.ts:317`) and never reads the view singleton for execution. Normative rule: **any automated caller of `runStrategyOnce`/`setPolicy` MUST pass an explicit `connectedAccountId`; the active-singleton fallback is forbidden on automated paths** (enforced by a lint/grep gate in the land script: no `runStrategyOnce(userId)` without options in `src/lib/scheduler.ts`, `congress-share.ts`, `mobile-api.ts`).

**Acceptance:**
- Test: `PUT /api/policy` with an `accountId` belonging to **another** user → 403, zero rows written.
- Test: multi-account user, absent `accountId` on a mutating write → 400/403 (fail closed), **not** silent active-singleton write.
- Test: single-account user, stale/garbage `accountId` on a read/nav → auto-resolves to the sole account (200).
- Test: single-account user Live-arming with a garbage `accountId` → **no** fallback; arming requires the explicit resolved id + ritual.

---

## 8. The thin `/a/:accountId` route seed

Adopt parent Open-Q4 option (b): a **thin catch-all seed**, not a monolith split.

**File:** `app/a/[accountId]/layout.tsx` (new route group). Behavior:
1. On server render, call `requireAuthorizedAccount` with the route param (single-account fallback allowed for navigation). On `AccountScopeError` for a multi-account user → redirect to the neutral **"Pick an account to continue →"** state with the switcher auto-opened.
2. Seed the per-tab `viewAccountId` React context from the validated `accountId`. **This is the only thing the URL does** — it seeds and validates; it grants no authority.
3. Child destinations (`/a/:accountId/{dashboard,approvals,strategy,guardrails,results}`) read `viewAccountId` from context. Legacy flat routes (`/dashboard`, etc.) remain as **redirect aliases** that resolve the default-landing account (non-Live only, per parent P12) and 302 into `/a/:accountId/...`.
4. **P12 enforcement:** the default-landing resolver **excludes Live accounts** — a Live account is never auto-selected on load; if the only sensible default is Live, land on the neutral pick-account state instead.

**Acceptance:**
- Test: `/a/:foreignAccountId/strategy` for an account not owned by the session → redirect to pick-account, no data leak.
- Test: `/dashboard` (legacy) for a single-account user → 302 to `/a/<sole>/dashboard`.
- Test: default-landing resolver never returns a Live account.

---

## 9. Cross-account wash-sale — third coupling class + provenance + Test/sim exclusion

### 9.1 It is a third coupling class (not per-account, not user-global)

Wash-sale lockout is **cross-account tax coupling**: one account's realized loss constrains **all** the user's accounts (IRC §1091 + Rev. Rul. 2008-5). It is enforced today and authoritative — `policy.ts:321` blocks buys on locked symbols via `getUserWashSaleLockedSymbols`, and the parent notes it "cannot be silently bypassed." So `washSaleGuard` is **not** a clean per-account toggle and must not be labeled as one; the per-account `washSaleGuard` flag (`tax.ts:57-58`) governs only the *intra-account* harvest math, while the cross-account lockout is unconditional.

### 9.2 The return-type change (the buildable-provenance requirement)

Today all three functions return a flat `Set<string>` (`tax.ts:75, 99, 110`) — **no provenance**, so the Approvals card cannot name the culprit account or clear date. **Required change:** return per-symbol provenance.

**New return type** (`src/lib/tax.ts`):
```ts
export interface WashSaleLock {
  symbol: string;
  contributingAccountNumber: string;
  contributingAccountLabel: string;   // for UI ("Robinhood · LIVE")
  contributingSource: FillSource;      // "live" | "paper"
  earliestClearDate: string;           // ISO — when the 30-day window ends
}
export type WashSaleLockMap = Map<string, WashSaleLock>;  // keyed by normalized symbol; earliest-clear wins on collision
```

`getWashSaleLockedSymbols`, `getWashSaleLockedSymbolsForUser`, `getUserWashSaleLockedSymbols` change from `Set<string>` → `WashSaleLockMap`.

### 9.3 Full consumer inventory (must change in the SAME PR)

From the grounding, every call site of the three functions:

| Consumer | File:line | Change |
|---|---|---|
| **`evaluateProposal`** | `policy.ts:321` (import `:4`) | Gate reads `map.has(symbol)`; blocked-proposal reason now carries `map.get(symbol)` provenance into the `TradeProposal` block reason. |
| **`proposeTrades` (main loop)** | `strategy.ts:219, 1552` (import `:61`) | Populate context with the map; pass through to `evaluateProposal`. |
| **`getTaxSummary` (internal)** | `tax.ts:104, 116, 232` | `lockedSymbols[]` in the API response derives from `[...map.keys()]`; optionally expose provenance array. |
| **`test/tax.test.ts`** | `:55, 82, 91, 132, 149` (import `:5`) | Assert on `WashSaleLock` fields, not raw set membership. |
| **`test/policy.test.ts`** | `:130, 141, 146-147, 159` (mock `:9`) | Mock returns a `WashSaleLockMap` (e.g. `new Map([["NVDA", {…}]])`) not a `Set`. |
| **`test/strategy-hardening.test.ts`** | `vi.mock :21` | Mock returns empty `Map` not empty `Set`. |
| **`test/staleness-gate.test.ts`** | mock `:11` | Mock returns empty `Map`. |

**Backward-compat helper (optional, to shrink the PR):** keep a thin `getUserWashSaleLockedSymbolsSet(userId, now): Set<string>` = `new Set(map.keys())` for any pure membership caller, so only the *provenance-consuming* sites (Approvals) take the new type. But the three canonical functions return the map; do not keep two source-of-truth implementations.

### 9.4 Test/sim exclusion — the `tax.ts:113` paper→test leak fix

**The bug:** `getUserWashSaleLockedSymbols` (`tax.ts:110-117`) maps `broker === "test"` **and** `environment === "paper"` both to `source: "paper"` (`:113`). Since `getWashSaleLockedSymbolsForUser` only skips **IRAs** (`:102`), a **simulated (Test) loss currently contributes a wash-sale lockout onto a real taxable account.** This is a Test→real leak.

**Fix (in `getUserWashSaleLockedSymbols`, `tax.ts:111-116`):** exclude Test/local-sim accounts from contribution entirely.
```ts
const accounts: AccountTaxContext[] = listConnectedAccounts(userId)
  .filter((a) => a.broker !== "test")          // NEW: Test/sim never contributes a real lockout
  .map((a) => ({
    accountNumber: a.accountNumber ?? "",
    source: (a.environment === "paper" ? "paper" : "live") as FillSource,  // no longer folds "test" into "paper"
    taxationType: a.taxationType
  }));
```
This aligns with the parent's Sandbox classification: Test is excluded from Fleet controls **and** from cross-account wash-sale contribution.

**Open sub-decision (surface to owner):** Paper (non-Test) losses — should a Paper loss lock rebuys in a **Live** account? A paper account has no tax reality, so a paper loss creating a real lockout is arguably also a leak. **Recommendation: Paper contributes only within Paper; a Paper loss never locks a Live/taxable rebuy.** Implement by treating the lockout as **partitioned by `source`** — `live` losses lock `live` rebuys; `paper` losses lock `paper` rebuys; Test contributes nothing. This makes the coupling honest (real tax consequence only from real fills). If the owner wants the conservative "any loss locks everywhere," keep the union but still drop Test.

### 9.5 Surfacing with provenance (parent Approvals card)

The blocked Approvals card renders `map.get(symbol)`:
> `⛔ WASH-SALE LOCKOUT — locked by a loss in {contributingAccountLabel} · clears {earliestClearDate} · cross-account tax coupling`

Until the return-type change ships, degrade to "locked by a wash-sale in another account." Same provenance surfaces in the Fleet view. It is drawn as the **third coupling class**, visually distinct from per-account toggles.

**Acceptance:**
- Test: a Test-account loss produces **no** lockout on a taxable account (regression for the `tax.ts:113` leak).
- Test: `getUserWashSaleLockedSymbols` returns a `WashSaleLockMap` with correct `contributingAccountLabel` + `earliestClearDate`.
- Test (chosen partition): a Paper loss does not lock a Live rebuy; a Live loss does.
- Test: all four mocks updated to `Map`; `npm test` green.
- Test: IRA-realized losses still create no lockout (existing `tax.ts:102` behavior preserved).

---

## 10. Fleet STOP scope (Live + Paper, exclude Test)

Per parent Open-Q3 recommendation, **locked here:**

- **Fleet STOP / Set all close-only / Pause autonomy** hits **all Live + all Paper** accounts, **excludes Test/local-sim** (nothing real to stop; Test is Sandbox).
- **Live accounts listed first**, grouped and visually separated; **per-account confirmed-halted echo** (each account flips to `halted`/`close_only` and the UI shows a per-row confirmation, not a single aggregate "done").
- **STOP ≠ Flatten.** Fleet STOP sets `system_state` to `halted` (new activity stops); it **never sells**. "Flatten all" is a separate, secondary, type-to-confirm-on-Live action.

**Implementation:** new mutation `fleetStop(userId, { scope: "live" | "paper" | "both" })` in `src/lib/db-execution.ts` (new fn) that iterates `listConnectedAccounts(userId).filter(a => a.broker !== "test")`, and for each writes `system_state = "halted"` (or `close_only` for the softer variant) directly to `account_strategy_state`, audited per account (`fleet_stop`). Endpoint: `POST /api/strategy/fleet-stop`. Each per-account write goes through the same server authorization (all accounts already belong to the session `userId`).

**Acceptance:**
- Test: `fleetStop("both")` halts every Live + Paper account, leaves Test untouched, writes one `fleet_stop` audit row per halted account.
- Test: response payload echoes per-account `{accountId, from, to}` confirmations.
- Test: no `fill_events` / sell orders are produced by a STOP.

---

## 11. Mobile/PWA account-scope parity (spec now, land later)

The mobile command queue (`mobile_commands`, migration v8; `mobile-api.ts:625` calls `runStrategyOnce`) must carry account scope:

- Every mobile command payload includes `accountId`. `processPendingMobileCommands` resolves it via `requireAuthorizedAccount`-equivalent (validate `accountId` ∈ user's accounts) before executing — **no active-singleton inheritance** (the mobile singleton-setter hazard, Part III).
- **Mobile singleton hazard fix:** mobile must **not** call `setActiveConnectedAccount` to "select" an account for a run — that mutates the persisted view singleton and can silently re-scope the web session's writes. Mobile passes `accountId` per-command (execution-scope), never flipping `is_active`.
- Switcher + STOP survive on phone: the mobile bootstrap (`/api/mobile/bootstrap`) returns the account list with per-account mode/authority/health; Fleet STOP is available as a mobile command (`command_type: "fleet_stop"`).

**Acceptance:**
- Test: a mobile `run` command with a foreign `accountId` is rejected (queue row → `failed`, no run).
- Test: a mobile command never writes `connected_accounts.is_active`.

---

## 12. State machine / sequence: switching accounts safely

### 12.1 View-switch state machine (post-P2)

```
        ┌───────────────────────────── (any account-scoped screen) ─────────────────────────────┐
        │                                                                                        │
   [VIEWING A] ──user clicks chip B──▶ [VALIDATE B]                                              │
        ▲                                  │  requireAuthorizedAccount(B) against session        │
        │                                  ├── invalid/foreign ──▶ [PICK-ACCOUNT] (switcher open, │
        │                                  │                        scoped actions BLOCKED)       │
        │                                  └── valid ──▶ [B is Live?]                             │
        │                                                 ├── no  ──▶ set viewAccountId=B (per-tab)│
        │                                                 │          re-scope reads in place ─────┘
        │                                                 └── yes ──▶ [LIVE ACK] "you are now acting
        │                                                              on REAL MONEY" + red hairline
        │                                                              └──ack──▶ set viewAccountId=B
        └──────────────────────────────────────────────────────────────────────────────────────┘

INVARIANTS during a view-switch:
  • NO write to connected_accounts.is_active (view is per-tab, ephemeral).
  • NO change to ANY account's system_state (execution-scope untouched — A stays armed if it was).
  • NO mirrorPolicyToActiveAccount (deleted). Config edits target viewAccountId explicitly.
  • Scheduler continues running every account whose own system_state==="active", unaffected.
```

### 12.2 Sequence: safe switch A→B while A is running autonomously

1. **Precondition (P2 shipped):** not-active→halted coercion removed; ambient mirror removed; per-tab `viewAccountId`.
2. User (viewing A, `A.system_state="active"`) clicks B.
3. Server validates B ∈ session (`requireAuthorizedAccount`). Foreign → `PICK-ACCOUNT`, stop.
4. If B is Live → show REAL-MONEY ack + paint red hairline; require acknowledge.
5. Set per-tab `viewAccountId = B`. Re-scope Dashboard/Strategy/Guardrails/Results reads to B in place.
6. **A is untouched:** `A.system_state` stays `active`; the scheduler's next tick still fans out to A (`scheduler.ts:277,306-308`) and runs it. No demotion. No mirror.
7. Any config edit the user makes now targets **B** explicitly (`setPolicy(policy, userId, B)`), server-revalidated (§7).
8. Switching back to A re-scopes reads; A never stopped running.

### 12.3 Sequence: arming B for autonomy (execution-scope, deliberate)

1. User navigates Guardrails → Autonomy for B (view-scope = B).
2. Sets the dial to Decide / flips `system_state → active`. This is a **mutating write** → `requireAuthorizedAccount(B)` (§7).
3. If B is Live → the two one-way-door confirms (arm Live + arm Auto-on-Live) apply (parent P9); first-Live-act-of-session re-consent applies.
4. `setPolicy({...B, systemState:"active"}, userId, B)` persists to `account_strategy_state`. B is now in the scheduler's armed set — **independent of view**.
5. Boot interlock: unless B's per-account `auto_resume_on_boot=1` (§5), a restart reverts B to `halted` (audited).

---

## 13. Consolidated migration & merge-gate checklist

**Migration v9 (single PR, one `migrate()` bump in `db.ts`):**
```sql
ALTER TABLE account_strategy_state ADD COLUMN derived_snapshot TEXT;                    -- §4.1 three-way base
ALTER TABLE account_strategy_state ADD COLUMN derived_at TEXT;                          -- §4.1
ALTER TABLE account_strategy_state ADD COLUMN auto_resume_on_boot INTEGER NOT NULL DEFAULT 0;  -- §5.3
-- back-fill: set auto_resume_on_boot=1 for all accounts of any user whose legacy user_settings
-- auto_resume_on_boot === true; then the per-user read path is retired after one release.
```

**Code deletions (P2 safety migration):**
- `mirrorPolicyToActiveAccount` calls at `db-profiles.ts:486, 512, 531` (and the function if no callers remain).
- not-active→halted coercions at `db-profiles.ts:283-284, 349-350, 396-397`.

**Return-type change (one PR, all consumers in §9.3):** `Set<string>` → `WashSaleLockMap` across `tax.ts` + `policy.ts` + `strategy.ts` + 4 test files.

**Bug fix (can ride with §9 PR):** `tax.ts:113` Test→paper leak — filter `broker !== "test"`.

**Merge gates (enforced in `scripts/land.sh` / CI `verify`):**
1. Grep: zero `mirrorPolicyToActiveAccount` call sites.
2. Grep: zero not-active→halted coercions.
3. Grep: no automated caller invokes `runStrategyOnce(userId)` / `setPolicy(...)` without an explicit `connectedAccountId` in `scheduler.ts`, `congress-share.ts`, `mobile-api.ts`.
4. Every mutating account-scoped route calls `requireAuthorizedAccount`.
5. `USER_LEVEL_POLICY_FIELDS` unchanged unless the PR also ships the per-field round-trip read-after-write test.
6. `npx tsc --noEmit` → `npm test` → `npm run build` all green (the wash-sale return-type change breaks types loudly if a consumer is missed — that is the safety net).

---

## 14. Acceptance-criteria summary (the section's definition of done)

| # | Guarantee | Test anchor |
|---|---|---|
| A1 | Provenance projection never seeds `account_strategy_state` | row-count invariant around `resolveEffectivePolicy` |
| A2 | View-switch never changes any account's `system_state` and never touches `is_active` | §3.3 / §12 tests |
| A3 | Preset resync loosening a Live limit demands per-field confirm; tightening does not; Paper/Test have none | §4.3 tests |
| A4 | Boot reverts every `active` account to `halted` unless per-account opted-in; `close_only`/`liquidating` survive | §5 tests |
| A5 | Scheduler runs every account whose own `system_state==="active"`, independent of view singleton | §6 tests |
| A6 | Every mutating write revalidates `accountId` server-side; multi-account fails closed, single-account auto-resolves | §7 tests |
| A7 | `/a/:accountId` seeds+validates; default-landing never returns Live | §8 tests |
| A8 | Wash-sale returns per-symbol provenance; Test never contributes; chosen source-partition holds | §9 tests |
| A9 | Fleet STOP = Live+Paper, excludes Test, per-account echo, never sells | §10 tests |
| A10 | Mobile passes explicit `accountId`, never flips `is_active` | §11 tests |

---

**Files this section creates or touches (absolute-path map for the implementer):**
- New: `src/lib/policy-provenance.ts` (§2), `src/lib/preset-resync.ts` (§4), `src/lib/limit-direction.ts` (§4.3), `src/lib/request-account.ts` (§7), `app/a/[accountId]/layout.tsx` + child routes (§8), `POST /api/strategy/fleet-stop` (§10).
- Modified: `src/lib/db.ts` (migration v9), `src/lib/db-profiles.ts` (delete mirror + coercion, write `derived_snapshot`/`auto_resume_on_boot`), `src/lib/tax.ts` (return-type + Test filter), `src/lib/policy.ts` + `src/lib/strategy.ts` (consume `WashSaleLockMap`), `src/lib/scheduler.ts` (per-account `auto_resume_on_boot` gate), `src/lib/db-settings.ts` (retire per-user flag after back-fill), `src/lib/db-execution.ts` (`fleetStop`), `src/lib/mobile-api.ts` (per-command `accountId`), and the mutating account-scoped routes under `app/api/**` (§7 table).
- Tests updated: `test/tax.test.ts`, `test/policy.test.ts`, `test/strategy-hardening.test.ts`, `test/staleness-gate.test.ts` (map mocks) + new tests per §14.
