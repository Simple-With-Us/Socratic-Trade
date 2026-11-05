# Data-Model & API Changes — Settings & Navigation Redesign (v2)

**Author:** Data-Model & API Changes lane · **Date:** 2026-07-01
**Canonical design:** [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2) — read Part I §Multi-account, §Incremental build path, and Part III before executing from this doc. This section goes deep only on the **backend** contract those parts assume and closes the Part III gaps that are data-model/API-shaped: per-account arming, autonomy-reset-on-restart, preset provenance, wash-sale provenance return-type change (with full consumer inventory), the fleet/`/a/:accountId`/write-time-validation API surface, the localStorage migration shim, and the `mobile-api.ts` singleton-setter re-point.

Every change below is expressed as: **what changes → exact file path(s) → migration/rollback**. All schema changes go through the versioned-migration framework in `src/lib/db.ts` (`MIGRATIONS[]`, `SCHEMA_BASELINE = 1`, `PRAGMA user_version`; **current head = version 8**, `db.ts:222-248`). New tables' `CREATE TABLE` also goes into `migrate()`'s idempotent baseline so fresh DBs are byte-identical to migrated ones (the split-vs-modified boundary CLAUDE.md warns about — put `CREATE TABLE` in `migrate()`, CRUD in the owning `db-*` module).

---

## 0. Migration version plan (authoritative ordering)

Append these to `MIGRATIONS[]` in `src/lib/db.ts` in this order. Each is idempotent (`IF NOT EXISTS` / `PRAGMA table_info` guards) and runs once, stamped by `user_version`.

| Version | Name | Purpose | §Ref |
|---|---|---|---|
| **9** | `account_arming_state` | Add per-account arming columns + boot-epoch to `account_strategy_state`; add `autonomy_armed_epoch` internal setting scaffolding | §1, §2 |
| **10** | `preset_provenance` | Add `derived_from_snapshot` (base snapshot for three-way resync) to `account_strategy_state`; backfill `derived_from_profile_id` already present (no-op verify) | §3 |
| **11** | `wash_sale_provenance_indexes` | Composite index on `fill_events` to make per-account wash-sale provenance queries cheap (no schema shape change to lockout — that is code-level, §4) | §4 |

`derived_from_profile_id` **already exists** on `account_strategy_state` (`db.ts:477`) — it is NOT missing. The grounding's "if missing" is resolved: **present, keep it, add only the base-snapshot column in v10.** Do not re-add the column; migration 10 must guard with `PRAGMA table_info` and only ADD `derived_from_snapshot`.

---

## 1. Per-account arming state (execution-scope decoupled from view-scope)

**Design driver:** P2 (`docs/settings-navigation-redesign.md` §Design principles #2) — view-scope (ephemeral, per-tab) must be split from execution-scope (per-account, persisted, plural). Today execution-scope is a **persisted singleton** (`connected_accounts.is_active`, `db-api-keys.ts:580-601/681-689`) and any non-active account is coerced `systemState → "halted"` on the next policy write/read (`db-profiles.ts:284, 350, 397`). Fleet arming and free switching are impossible until this is decoupled.

### 1.1 Schema — new columns on `account_strategy_state`

Current shape (`db.ts:470-480`) already has `system_state TEXT NOT NULL DEFAULT 'halted'`. That is the per-account run state — good; it is **already per-account**, not a singleton. The gap is (a) the **coercion writes** that force non-active accounts to halted, and (b) there is no separate persisted "armed" flag distinct from the transient `systemState`, and no boot-epoch to key autonomy-reset off (§2).

Migration **v9** (`account_arming_state`) adds:

```sql
-- in migrate() baseline CREATE TABLE account_strategy_state (...) add these columns,
-- AND in MIGRATIONS[v9].up ALTER-if-missing each:
armed_authority      TEXT NOT NULL DEFAULT 'propose',   -- 'propose' | 'decide' — persisted execution-scope authority, per account
armed_at             TEXT,                              -- ISO8601 when the user last armed (Decide or Live); null = never armed
armed_boot_epoch     INTEGER NOT NULL DEFAULT 0,        -- process-boot epoch at which this arming was set (see §2)
```

- **`armed_authority`** replaces the reliance on `policy.strategyAuthority` (`types.ts:396`) as the *persisted* per-account arming record. `policy.strategyAuthority` remains the in-policy effective value, but the **authoritative persisted arm** is this column so a preset copy / policy overlay can never silently re-arm (principle #7). `systemState` (`active|halted|close_only|liquidating`, `types.ts:16`) continues to carry the money-plane run state; `armed_authority` carries the Propose↔Decide dial (`types.ts:17`).
- **`armed_boot_epoch`** is the anchor for autonomy-reset-on-restart (§2).

**File paths:**
- `src/lib/db.ts` — `migrate()` baseline `CREATE TABLE account_strategy_state` + `MIGRATIONS` v9 entry (`up` uses `PRAGMA table_info(account_strategy_state)` guard pattern, cf. `db.ts:55-58`).
- `src/lib/db-profiles.ts` — `writeAccountStrategyState` (~`:230-241`), `getAccountStrategyStateRow`, and the `RawAccountStrategyState` row type must read/write the three new columns.
- `src/lib/types.ts` — no new `TradingPolicy` field required (`strategyAuthority` already exists); add an `AccountArmingState` interface `{ connectedAccountId: string; armedAuthority: StrategyAuthority; armedAt: string | null; armedBootEpoch: number; systemState: SystemState }` for the new read API (§5.4).

### 1.2 Remove the not-active→halted coercion (P2, first blocking migration)

Delete the three coercion blocks — they conflate view-scope with execution-scope:
- `src/lib/db-profiles.ts:283-285` (`migrateLegacyStrategyModelFieldsToAccounts`)
- `src/lib/db-profiles.ts:348-351` (`getPolicy`)
- `src/lib/db-profiles.ts:395-398` (`peekPolicy`)

Replace with: each account's `systemState` is read from its own `account_strategy_state` row verbatim; **no cross-reference to `getActiveConnectedAccount`.** After this, `is_active` becomes a **view-scope hint only** (last-viewed account for UI seeding), never an execution gate.

### 1.3 Remove ambient mirror from all three call sites (principle #7)

Delete `mirrorPolicyToActiveAccount` (`db-profiles.ts:249-259`) invocations at:
- `db-profiles.ts:486` (`createStrategyProfile`)
- `db-profiles.ts:512` (`updateStrategyProfile`)
- `db-profiles.ts:531` (`activateStrategyProfile`)

Split into two explicit verbs (no implicit "whatever account is active" target):
- **`setLibraryDefaultProfile(profileId, userId)`** — sets the active library profile only (`strategy_profiles.active`), touches **no** `account_strategy_state` row.
- **`applyProfileToAccount(profileId, connectedAccountId, userId)`** — already exists (`db-profiles.ts:547`), copy-on-bind, stamps `derived_from_profile_id`, preserves `systemState`/`armed_authority`. This is the ONLY path that writes account state from a preset.

**Migration/rollback for §1:** Ship v9 behind the same P2 feature flag as the decoupling. Rollback = flag flip; the new columns are additive and default to the safe floor (`propose` / `armed_at NULL`), so a rollback that ignores them degrades to today's behavior. **Data risk:** removing the coercion means an account left `active` in its own row will now actually run — this is why §2 (autonomy-reset-on-restart) must land in the *same* PR as §1.2, never after. **Test:** round-trip read-after-write per new column; a `getPolicy(userId, nonActiveId)` test asserting the returned `systemState` is NOT coerced to `halted`.

---

## 2. Autonomy-reset-on-restart (REQUIRED, DEFAULT ON — net-new)

**Design driver:** LOCKED DECISION + P9. On every app/process restart, every account's autonomy drops to its safe floor (Propose-only, new-entries-halted) until the user re-arms.

**What exists today (grounding-confirmed):** `reconcileAutonomyOnBoot()` (`src/lib/scheduler.ts:66-97`) already reverts persisted `systemState === "active"` → `"halted"` at boot — **BUT it is opt-OUT** (`autoResumeOnBoot` per-user setting or `AUTONOMY_RESUME_ON_BOOT=1` env defeats it) and it only touches `systemState`, **not** the Propose↔Decide `strategyAuthority` dial. Open Q2 in the design ("does it exist or is it net-new?") is hereby resolved: **a partial mechanism exists for `systemState`; the authority-dial reset and the DEFAULT-ON-with-no-opt-out contract are net-new.**

### 2.1 Persistence + reset mechanism

Two orthogonal dials both reset (design §Money-reality/Authority):

1. **Money-plane run state (`systemState`)** — already reset by `reconcileAutonomyOnBoot`. **Change:** make DEFAULT-ON the true default. The `autoResumeOnBoot` opt-out remains only for `close_only`/`liquidating` (self-safe states, untouched today) — but for `active`, keep the revert. Per LOCKED DECISION "DEFAULT ON", flip the semantics so the reset is unconditional for `active` unless an explicit operator override is present; downgrade `autoResumeOnBoot` to a Live-account-only, per-account, audited opt-in (never a silent global).

2. **Authority dial (`armed_authority`)** — net-new reset. Add to `reconcileAutonomyOnBoot`: for every `account_strategy_state` row, if `armed_authority === 'decide'`, set it back to `'propose'`, set `armed_at = NULL`, and audit `autonomy_authority_reset_on_boot`.

### 2.2 Boot-epoch anchor (how "restart" is detected)

Add a process-boot epoch so the reset is idempotent and observable, not dependent on wall-clock:

- New internal setting `autonomy_boot_epoch` (integer, monotonically incremented once per process start) written by `startScheduler()` / server init via `setInternalSetting` (`db.ts` re-exports `getInternalSetting`/`setInternalSetting`).
- On boot: increment `autonomy_boot_epoch`; then for each account row where `armed_boot_epoch < autonomy_boot_epoch` **and** the row is armed above the floor, reset to floor and stamp `armed_boot_epoch = autonomy_boot_epoch`.
- When the user re-arms (§5.3 mutation), the arm writes `armed_boot_epoch = current autonomy_boot_epoch`, so it survives *until* the next restart and no further.

**File paths:**
- `src/lib/scheduler.ts` — extend `reconcileAutonomyOnBoot()` (`:66`) to also reset `armed_authority` and stamp `armed_boot_epoch`; make `active` revert unconditional-by-default.
- `src/lib/db.ts` / `src/lib/db-settings.ts` — `autonomy_boot_epoch` internal setting getter/setter (or reuse `getInternalSetting`/`setInternalSetting`).
- `src/lib/db-profiles.ts` — `writeAccountStrategyState` stamps `armed_boot_epoch` on arm.
- **New audit kinds:** `autonomy_authority_reset_on_boot`, extend existing `autonomy_halted_on_boot` (`scheduler.ts:89`).

**Migration/rollback:** additive columns default to the safe floor, so a fresh boot with the new code on an old DB resets everything to Propose-only/halted (exactly the intended safe posture). Rollback to old code simply ignores `armed_authority`/`armed_boot_epoch` and falls back to the existing `systemState`-only interlock — still safe (fails closed). **Acceptance:** integration test that (a) arms an account to Decide, (b) simulates a boot (increment epoch + call `reconcileAutonomyOnBoot`), (c) asserts `armed_authority === 'propose'`, `systemState === 'halted'`, `armed_at === null`, and an audit row exists.

---

## 3. Preset provenance / `derived_from_profile_id` and three-way resync

**Design driver:** P8 — presets are copy-on-bind (snapshot), never live-link; resync is an explicit three-way diff (base snapshot → preset-now vs base snapshot → account-now).

**Grounding-confirmed:** `derived_from_profile_id` **already exists** on `account_strategy_state` (`db.ts:477`) and is stamped by `applyProfileToAccount` and the current mirror paths. **Nothing to add for the id itself.** The gap for the three-way diff is that we store only the *pointer* to the source profile, not the **base snapshot** captured at copy time, so "base snapshot → account-now" is un-computable.

### 3.1 Schema — add base snapshot (migration v10, `preset_provenance`)

```sql
-- ALTER-if-missing on account_strategy_state:
derived_from_snapshot TEXT   -- JSON: the {policy, prompt, scoringWeights} of the preset AT COPY TIME (the resync base)
```

- Stamped by `applyProfileToAccount` (`db-profiles.ts:547`) and `setLibraryDefaultProfile`→copy path at the instant of copy.
- Null for legacy rows / accounts never bound to a preset (their provenance shows "no preset / custom").

### 3.2 Resync computation (code-level, no further schema)

Add `computePresetResync(userId, connectedAccountId)` in `src/lib/db-profiles.ts` returning:
```ts
interface PresetResyncDiff {
  profileId: string | null;
  fields: Array<{
    field: keyof TradingPolicy | `scoringWeights.${string}` | "prompt";
    base: unknown;        // from derived_from_snapshot
    presetNow: unknown;   // current strategy_profiles row
    accountNow: unknown;  // current account_strategy_state row
    presetChanged: boolean;
    accountChanged: boolean;
    conflict: boolean;    // both changed
    loosensLiveLimit: boolean; // §per-field-confirm gate (P8) — true when pulling preset value relaxes a Live risk cap
  }>;
}
```
`loosensLiveLimit` is computed by comparing numeric risk-cap fields (max notional, drawdown, daily-loss, exposure caps) in a "looser" direction on a **Live** target account only. Any field with `loosensLiveLimit === true` inherits the same per-field type-to-confirm as a manual Live edit — the bulk resync never bypasses one-way-door friction (P8).

**File paths:**
- `src/lib/db.ts` — v10 migration + baseline column.
- `src/lib/db-profiles.ts` — stamp `derived_from_snapshot` on copy; new `computePresetResync`; `resyncPresetField(userId, accountId, field, direction)` mutation.
- `src/lib/types.ts` — `PresetResyncDiff` interface.

**Migration/rollback:** additive nullable column; legacy rows get `derived_from_snapshot = NULL` and the resync UI degrades to "no base snapshot — showing preset-now vs account-now (2-way)" until the account is next re-bound. Rollback = ignore the column. **Acceptance:** copy a preset, mutate both preset and account, assert `computePresetResync` classifies `presetChanged`/`accountChanged`/`conflict` correctly and flags `loosensLiveLimit` on a Live drawdown loosening.

---

## 4. Wash-sale provenance — `getUserWashSaleLockedSymbols` return-type change (silent-failure gap, RESOLVED)

**Design driver:** §Multi-account "Cross-account wash-sale — enforced today, surfaced with provenance"; §II Approvals wireframe requires "locked by a loss in Robinhood · LIVE · clears Jul 24." Enforcement is authoritative today (`policy.ts:315-325`, "cannot be silently bypassed"); the work is **surfacing**, plus a **correctness fix** (exclude Test).

### 4.1 The two silent-failure hazards (both must be fixed together)

1. **Return type has no provenance.** `getUserWashSaleLockedSymbols` returns a flat `Set<string>` (`tax.ts:110-117`); `getWashSaleLockedSymbolsForUser` (`tax.ts:99`) and `getWashSaleLockedSymbols` (`tax.ts:75`) likewise. The Approvals card cannot name the culprit account or clear date.
2. **Test contributes to real lockouts.** `tax.ts:113` maps `broker === "test" → source: "paper"`, so a *simulated* loss can lock a rebuy in a *real taxable* account. This is a correctness bug independent of the UI and must be fixed before any culprit-naming ships (design §Edge cases, `multiaccount-edge #3`).

### 4.2 New return type (compile-time-safe migration approach)

**Do NOT change the existing functions' return type in place** — that would break all 7 consumer sites silently at runtime if any were missed. Instead, **add a new provenance-carrying function and keep the `Set<string>` one as a thin adapter** so the compiler forces every migrated call site to opt in explicitly:

```ts
// src/lib/tax.ts — NEW
export interface WashSaleLock {
  symbol: string;                  // normalized
  contributingAccount: {
    connectedAccountId: string;
    label: string;                 // e.g. "Robinhood · Individual"
    broker: string;
    environment: "live" | "paper";
  };
  earliestClearDate: string;       // ISO date the 30-day window expires for the earliest contributing loss
}

// Returns per-symbol provenance. When multiple accounts/lots lock the same symbol,
// keep the account whose lock clears LATEST (most conservative) but expose earliestClearDate
// as the date the *symbol* becomes rebuyable = latest contributing exit + 30d.
export function getUserWashSaleLocks(userId?: string, now?: Date): Map<string, WashSaleLock>;

// KEEP as a compile-time-safe adapter — existing callers that only need membership are unchanged.
export function getUserWashSaleLockedSymbols(userId: string = "local", now = new Date()): Set<string> {
  return new Set(getUserWashSaleLocks(userId, now).keys());
}
```

- `getUserWashSaleLocks` is the new source of truth; `getUserWashSaleLockedSymbols` becomes a **one-line adapter** over it. This keeps every existing `.has(symbol)` consumer working with **zero behavioral change** while the Approvals path adopts the richer `Map`.
- **Test exclusion:** in the account-context mapping (`tax.ts:110-116`), drop accounts where `broker === "test"` entirely (not map to "paper"). Add a unit test asserting a Test loss never appears in `getUserWashSaleLocks`.
- Provenance requires threading the contributing account through `getWashSaleLockedSymbolsForUser` and `getWashSaleLockedSymbols`. Add parallel `*WithProvenance` internals; keep the `Set` versions as adapters over them (same pattern — compiler-forced, no silent drift).

### 4.3 FULL consumer inventory (every call site — from grounding, re-verified this session)

| # | Call site | Uses | Migration action |
|---|---|---|---|
| 1 | `src/lib/policy.ts:321` | membership `.has(symbol)` in the wash-sale gate | **No change** — keeps calling `getUserWashSaleLockedSymbols` (adapter). Enforcement contract (`policy.ts:315` "cannot be silently bypassed") preserved. Optionally accept an injected `WashSaleLock` map via `context.washSaleLockedSymbols` for the block *reason* string to name the culprit — but the gate itself stays `Set`-based. |
| 2 | `src/lib/strategy.ts:219` | `washSaleLockedSymbols` for the run context | **No change** (adapter) unless the Approvals card is fed from here — then pass the `Map` alongside. |
| 3 | `src/lib/strategy.ts:1552` | context population | **No change** (adapter). |
| 4 | `src/lib/tax.ts:116` | internal (`getUserWashSaleLockedSymbols` → `getWashSaleLockedSymbolsForUser`) | Re-implement over `*WithProvenance`. |
| 5 | `src/lib/tax.ts:104` | internal (`getWashSaleLockedSymbolsForUser` → `getWashSaleLockedSymbols`) | Re-implement over `*WithProvenance`. |
| 6 | `src/lib/tax.ts:232` | `getTaxSummary.lockedSymbols` → `Array.from(...)` for API | **No change** (adapter returns `Set`, `Array.from` still works). `TaxSummary.lockedSymbols: string[]` type unchanged; optionally add `lockedSymbolsDetailed: WashSaleLock[]` as an additive field. |
| 7 | `test/policy.test.ts:5,9,130,141,147,159` | `vi.mock("../src/lib/tax", { getUserWashSaleLockedSymbols })` returning `new Set(...)` | **No change** — mock still returns `Set`; adapter signature unchanged. If policy adopts the `Map` for reasons, add a `getUserWashSaleLocks` mock. |
| 8 | `test/strategy-hardening.test.ts:21` | `vi.mock(... getUserWashSaleLockedSymbols: vi.fn(() => new Set()))` | **No change** (adapter). Add `getUserWashSaleLocks: vi.fn(() => new Map())` **only if** `strategy.ts` is migrated to the Map. |
| 9 | `test/staleness-gate.test.ts:11` | same mock shape | **No change** (adapter). Same conditional add. |
| 10 | `test/tax.test.ts:5,55,82,91,132,149` | direct `getWashSaleLockedSymbols` / `getWashSaleLockedSymbolsForUser` (`Set`) | **No change** (adapters preserved). **Add** new tests for `getUserWashSaleLocks` provenance + Test-exclusion. |

**Compile-time safety guarantee:** because the old `Set<string>` functions are retained as adapters with identical signatures, `npx tsc --noEmit` will **not** flag any existing site — there is no silent runtime break. The only *new* type surface is `getUserWashSaleLocks`/`WashSaleLock`, adopted deliberately by the Approvals PR. This is the "compile-time-safe migration approach" the task requires: **add-and-adapt, never mutate-in-place.**

### 4.4 Schema/index (migration v11)

No lockout table (it's computed from `fill_events`). Add a composite index to keep the per-account provenance scan cheap when iterating all accounts:
```sql
CREATE INDEX IF NOT EXISTS idx_fill_events_washsale
  ON fill_events (user_id, account_number, source, symbol, side, filled_at DESC);
```
**File paths:** `src/lib/tax.ts` (all changes), `src/lib/db.ts` (v11 index), `src/lib/types.ts` (`WashSaleLock`), `test/tax.test.ts` (new provenance + Test-exclusion tests).

**Migration/rollback:** pure additive (new fn + adapter + index). Rollback = drop the new fn/index; adapters revert to direct implementations. **Acceptance:** (a) two taxable accounts each locking `NVDA` → `earliestClearDate` = latest exit + 30d, `contributingAccount` = the latest locker; (b) a Test loss on `AAPL` → absent from `getUserWashSaleLocks`; (c) `policy.ts` gate still blocks a locked buy (regression on `policy.test.ts:130`).

---

## 5. API endpoints — fleet aggregation, fleet-STOP, `/a/:accountId` scoping, write-time validation, autonomy state

All routes live under `app/api/`. Existing per-account scoping is via an optional `connectedAccountId` query param resolved in `db-profiles.resolveAccount`. The design requires **route-encoded scope + server-side write-time validation** (P3 — the real safety boundary).

### 5.1 `/a/:accountId` route-scoping (thin catch-all, design §Incremental build path "option (b)")

- **Client seed only.** Add a route-group segment `app/a/[accountId]/` (or a middleware that reads `/a/:accountId/...`) that **seeds** the active-account context for the client. It does NOT grant authority.
- **Server-side write-time validation is the real boundary.** Add a shared helper `assertAccountInSession(accountId, userId)` in `src/lib/account-scope.ts` (new) that verifies `accountId` belongs to the session's user via `getConnectedAccount(accountId, userId)` and throws `403` otherwise. **Every mutating route** (proposal approve/reject, setPolicy, arm, STOP, apply-preset) calls it with the explicit body/param `accountId` — never an inferred `is_active` singleton.
- **Single-account auto-resolve (LOCKED DECISION):** `assertAccountInSession` accepts an `allowAutoResolve` flag; when the user has exactly one account, a stale/unknown `accountId` auto-resolves to the sole account (does not fail closed). Multi-account users keep fail-closed. Implement by counting `listConnectedAccounts(userId)`.

**File paths:** `app/a/[accountId]/layout.tsx` (seed), `src/lib/account-scope.ts` (validation helper), and edits to every mutating route handler under `app/api/`.

### 5.2 Fleet aggregation — `GET /api/fleet`

New read endpoint returning one entry per account for the Fleet/All-accounts Dashboard:
```ts
// GET /api/fleet  → { accounts: FleetAccountSummary[], aggregate: { netWorth, totalDayPnl } }
interface FleetAccountSummary {
  connectedAccountId: string;
  label: string; broker: string; environment: "live" | "paper" | "test";
  moneyRealityClass: "practice" | "real";       // Test+Paper = practice, Live = real (design §5)
  armedAuthority: "propose" | "decide";          // from account_strategy_state (§1)
  systemState: SystemState;
  equity: number; dayPnl: number;
  openPositionCount: number; pendingApprovalCount: number;
  activePresetName: string | null;               // via derived_from_profile_id (§3)
  lastRunAt: string | null; trippedBreaker: string | null;
  healthOk: boolean;
}
```
**No trade can be placed from `/api/fleet`** (read-only, design §Fleet). Aggregates across `listConnectedAccounts`, joining `account_strategy_state`, `portfolio_snapshots`, `trade_proposals` (pending count), and the breaker state.

**File path:** `app/api/fleet/route.ts` (new, `GET`). Reads only; no `assertAccountInSession` per-account (it's a whole-user aggregate scoped to the session user).

### 5.3 Fleet-STOP mutation — `POST /api/fleet/stop`

Design §Fleet + LOCKED DECISION: halts **all Live + all Paper** accounts; **EXCLUDES Test/local-sim**; Live listed first; per-account confirmed-halted echo.
```ts
// POST /api/fleet/stop  { mode: "stop" | "close_only" | "pause_autonomy" }
// → { halted: Array<{ connectedAccountId, label, environment, priorState, newState }>,  excluded: Array<{ connectedAccountId, reason: "test" }> }
```
- Iterates `listConnectedAccounts(userId)`, **skips `broker === "test"`**, orders `environment === "live"` first.
- For each: sets `systemState → "halted"` (or `close_only`) and `armed_authority → "propose"` (drops autonomy) via `setPolicy` / the §1 writer; audits `fleet_stop`.
- Returns a per-account confirmed-halted echo (the design's "per-account confirmed-halted echo") so the UI can show each Live account was actually stopped.
- **STOP never sells** (design §STOP ≠ Flatten). Flatten is a separate route (`POST /api/fleet/flatten`, type-to-confirm on Live) — not specified here beyond noting it must stay distinct.

**File path:** `app/api/fleet/stop/route.ts` (new, `POST`). Calls `assertAccountInSession` is not needed (whole-fleet, session-scoped) but the mutation must be gated on the session user only.

### 5.4 Autonomy state — `GET/POST /api/account/[accountId]/autonomy`

Exposes/mutates the §1 per-account arming state, separate from `setPolicy`:
```ts
// GET  → AccountArmingState  { armedAuthority, armedAt, armedBootEpoch, systemState }
// POST { authority: "propose"|"decide", confirmation?: LiveConfirmation }
//   - Arming to "decide" on a Live account requires type-to-confirm (P9, first-Live-act re-consent)
//   - Stamps armed_boot_epoch = current autonomy_boot_epoch (§2) so it survives until next restart
//   - assertAccountInSession(accountId, userId) — the write-time boundary (P3)
```
**File paths:** `app/api/account/[accountId]/autonomy/route.ts` (new), `src/lib/db-profiles.ts` (read/write arming), `src/lib/types.ts` (`AccountArmingState`, `LiveConfirmation`).

**Migration/rollback for §5:** new routes are additive; no existing endpoint changes shape. The `/a/:accountId` layout is behind the P3 flag. Rollback = remove routes + flag; existing `connectedAccountId`-query scoping is untouched and still works. **Acceptance:** (a) `POST /api/fleet/stop` halts Live+Paper, excludes Test, echoes per-account; (b) `POST /api/account/:id/autonomy` with a mismatched-session accountId → 403 (multi-account) or auto-resolves (single-account); (c) arming to Decide on Live without `confirmation` → 400.

---

## 6. One-time localStorage migration shim (trigger resolved — flag-independent)

**Design driver:** §Incremental build path P1 — the shim affects **100% of returning users**; without it every returning user is silently bounced to default because `isWorkspaceTab("tax")` → false after the tab union changes. Persistence keys confirmed at `dashboard-client.tsx:197-199` (`WORKSPACE_TAB_KEY`, `FEED_TAB_KEY`, and the tuning key `STRATEGY_TUNING_STORAGE_KEY`).

### 6.1 Trigger condition (RESOLVED — the silent-failure gap)

The shim must **NOT** be gated behind the new-IA feature flag, because a flag-OFF user who has the new client code deployed would otherwise never get their keys migrated, and a later flag flip (or a flag-off user reading a half-migrated key) strands them on default. **Resolution:**

- **Trigger flag-independently, on client mount, once per browser**, guarded by a dedicated version sentinel key `nav_migration_v1_done` (NOT the feature flag).
- **One-release read-fallback:** for one release, the tab-reading code reads the **new** key first, then **falls back to mapping the old key on the fly** if the new key is absent and the sentinel is unset. This guarantees flag-off users are never stranded: even if the write-migration hasn't run, reads still resolve the legacy value. After one release, drop the fallback and the old-key writes.

```ts
// src/lib/nav-migration.ts (new) — runs in a client effect on mount, before first tab read.
const SENTINEL = "nav_migration_v1_done";
export function migrateNavLocalStorage(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SENTINEL)) return;
  const map = (old: string | null): DestinationTab | null => { /* decision→dashboard, performance+tax→results, notifications(feed)→alert-history, ... */ };
  const ws = map(localStorage.getItem(WORKSPACE_TAB_KEY));
  const feed = map(localStorage.getItem(FEED_TAB_KEY));
  if (ws) localStorage.setItem(DESTINATION_TAB_KEY, ws);
  if (feed) localStorage.setItem(DESTINATION_TAB_KEY /* or feed equivalent */, feed);
  // one-release: leave old keys in place for the read-fallback; delete them in the NEXT release.
  localStorage.setItem(SENTINEL, "1");
}
```

**File paths:** `src/lib/nav-migration.ts` (new), `app/dashboard-client.tsx` (call in mount effect + read-fallback in the tab resolver near `:197-199`). Ships in the **same PR as the `DestinationTab` union** (design P1).

**Migration/rollback:** localStorage-only, no server state. Rollback = the read-fallback still resolves legacy keys for one release, so a revert is non-destructive. **Acceptance:** unit test that seeds `WORKSPACE_TAB_KEY="tax"`, runs the shim, asserts `DESTINATION_TAB_KEY==="results"` and sentinel set; a second test that with the sentinel unset and only the old key present, the read-fallback still resolves to `results` (flag-off-not-stranded).

---

## 7. `mobile-api.ts` singleton-setter re-point (P2 hazard)

**Design driver:** §Open Q6 mobile parity + P2 — `mobile-api.ts` mutates the persisted active-account **singleton** and must adopt the same view-scope/execution-scope split, or a mobile `account.activate` will, post-P2, re-trigger exactly the coercion/mirror behavior we removed.

**Grounding-confirmed sites:**
- `src/lib/mobile-api.ts:11` imports `setActiveConnectedAccount`.
- `src/lib/mobile-api.ts:649` (`account.activate` command) calls `setActiveConnectedAccount(accountId, command.userId)` — mutates the singleton `connected_accounts.is_active` (`db-api-keys.ts:681-689`).
- `src/lib/mobile-api.ts:772` reads `connectedAccounts.find(a => a.isActive)` for the mobile snapshot's `activeConnectedAccount`.

**Re-point:**
1. **`account.activate` (`:649`) becomes view-scope only.** After P2, `is_active` is a view hint, not an execution gate, so keeping `setActiveConnectedAccount` is acceptable — **but** it must **not** be the arming path. Add an explicit separate mobile command **`account.arm`** (authority propose↔decide) routed through the §5.4 autonomy mutation with `assertAccountInSession` + Live type-to-confirm; `account.activate` never changes authority.
2. **`:772` snapshot** must additionally surface each account's `armedAuthority`/`systemState` from `account_strategy_state` (§1) so the mobile switcher + STOP have parity (design §Mobile/PWA "switcher + STOP + scoped context survive on mobile"). Add `fleet: FleetAccountSummary[]` (§5.2) and a `mobile` `strategy.stop`/fleet-STOP command that reuses §5.3 semantics (Live+Paper, exclude Test).
3. Mobile write commands (`proposal.approve` `:637`, `strategy.*` `:629-636`) must pass an explicit `accountId` through `assertAccountInSession` rather than relying on the active singleton — otherwise a mobile approve acts on whatever account is globally active, the exact P2 hazard.

**File paths:** `src/lib/mobile-api.ts` (`:11` import, `:649` command, `:772` snapshot, add `account.arm` + fleet-STOP commands), `src/lib/account-scope.ts` (shared validation), `app/api/mobile/*` route handlers if command schemas change.

**Migration/rollback:** `account.activate` behavior is preserved (view-scope); the new `account.arm` command is additive. Rollback = drop `account.arm`, and `account.activate` continues to work as today. **Acceptance:** a mobile `account.activate` does NOT change `armed_authority`; a mobile `proposal.approve` with an accountId not in session → rejected (multi-account) or auto-resolved (single-account); the mobile snapshot exposes per-account `armedAuthority`.

---

## 8. Summary — file/migration/rollback matrix

| Change | Primary files | Migration | Rollback |
|---|---|---|---|
| Per-account arming columns | `db.ts` (v9), `db-profiles.ts`, `types.ts` | v9 additive, safe-floor defaults | flag flip; columns ignored |
| Remove halt-coercion + mirror | `db-profiles.ts:283/348/395/486/512/531` | ships with v9 + P2 flag | flag flip restores coercion |
| Autonomy-reset-on-restart | `scheduler.ts:66`, `db-settings.ts`, `db-profiles.ts` | net-new; boot-epoch; default-ON | old code = `systemState`-only interlock, still fails closed |
| Preset base-snapshot + resync | `db.ts` (v10), `db-profiles.ts`, `types.ts` | v10 additive nullable | 2-way diff fallback |
| Wash-sale provenance return type | `tax.ts`, `db.ts` (v11 index), `types.ts`, `test/tax.test.ts` | add-and-adapt (compile-safe), Test-exclusion | drop new fn; adapters revert |
| `/a/:accountId` + write-time validation | `app/a/[accountId]/layout.tsx`, `src/lib/account-scope.ts`, all mutating `app/api/*` | P3 flag; write-guard is the boundary | remove routes; query-scoping unchanged |
| Fleet aggregation + STOP + autonomy API | `app/api/fleet/route.ts`, `app/api/fleet/stop/route.ts`, `app/api/account/[accountId]/autonomy/route.ts` | additive routes | delete routes |
| localStorage shim | `src/lib/nav-migration.ts`, `dashboard-client.tsx:197` | flag-independent, sentinel-gated, 1-release read-fallback | non-destructive; fallback resolves legacy |
| mobile singleton re-point | `mobile-api.ts:11/649/772`, `account-scope.ts` | additive `account.arm`; scoped writes | `account.activate` unchanged |

**Two silent-failure gaps explicitly closed:** (1) wash-sale return type via **add-and-adapt** (no in-place mutation → `tsc` catches nothing silently; every one of the 7+ consumers audited and left working) plus **Test-exclusion correctness fix**; (2) localStorage shim via **flag-independent trigger + one-release read-fallback** so flag-off users are never stranded. Both are verified by explicit round-trip read-after-write / read-fallback tests per the CLAUDE.md enrichment-trap discipline.

Relevant file paths (all absolute): `/home/user/agentic-trading/src/lib/tax.ts`, `/home/user/agentic-trading/src/lib/policy.ts`, `/home/user/agentic-trading/src/lib/db.ts`, `/home/user/agentic-trading/src/lib/db-profiles.ts`, `/home/user/agentic-trading/src/lib/db-api-keys.ts`, `/home/user/agentic-trading/src/lib/scheduler.ts`, `/home/user/agentic-trading/src/lib/mobile-api.ts`, `/home/user/agentic-trading/src/lib/types.ts`, `/home/user/agentic-trading/app/dashboard-client.tsx`, and new files `/home/user/agentic-trading/src/lib/account-scope.ts`, `/home/user/agentic-trading/src/lib/nav-migration.ts`, `/home/user/agentic-trading/app/api/fleet/route.ts`, `/home/user/agentic-trading/app/api/fleet/stop/route.ts`, `/home/user/agentic-trading/app/api/account/[accountId]/autonomy/route.ts`, `/home/user/agentic-trading/app/a/[accountId]/layout.tsx`.
