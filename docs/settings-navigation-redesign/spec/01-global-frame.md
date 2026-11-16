# Global Frame / App-Shell Specification — The Persistent Chrome

**Owner:** Global Frame / App-Shell spec author · **Date:** 2026-07-01
**Parent design (read first, do not restate):** [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2) — this document is the deep, buildable spec for the "Global frame" section (Part I) and Screens 1 & 5 (Part II-A) of that doc. It closes the Part III gaps that touch chrome.
**Feature flag:** all new-shell rendering gates behind `NAV_V2` (env + localStorage override), per II-D. Every state below is a `NAV_V2=on` state; `NAV_V2=off` renders today's header unchanged.

---

## 0. Scope, non-goals, and the four questions

The shell is the persistent chrome rendered on every authenticated destination. It is the **only** surface that answers the four supervisor-critical questions at all times, per Principle 1/4/5 of the parent doc:

1. **Which account** am I scoped to? (LEFT zone — Account Switcher)
2. **What money-reality** — practice or real? (LEFT chip badge, word-class first)
3. **What authority** — Propose or Decide? (LEFT chip authority pill)
4. **Running or halted?** (LEFT chip state suffix + RIGHT STOP actuator)

**In scope:** the three-zone frame, account switcher (all states), money-reality + authority + halt badges, ambient risk strip, Run-once (target-stamped), the STOP kill switch, Alerts dropdown, command palette, Help, avatar/Preferences menu, responsive/mobile degradation, keyboard shortcuts, focus order, the Live red-viewport treatment, and the **autonomy-reset-on-restart** mechanism (net-new, per LOCKED DECISIONS).

**Out of scope (owned by sibling specs):** destination content bodies (Dashboard/Approvals/Strategy/Guardrails/Results); the Settings tree internals; the Assistant slide-over content; the Approvals card. This spec defines the shell's *edges* with each (route targets, event contracts, where a control hands off).

**Non-goals:** this spec does not move any panel ownership (that is P4..N). It defines the container that the strangler-fig migration renders into (P0), plus the switcher/run-state action/badges that P2/P3 make real.

**Governing file targets (new):**

| Concern | New file | Notes |
|---|---|---|
| Route-group shell | `app/(shell)/layout.tsx` | P0. Renders the three zones; children = current tabs unchanged behind flag. |
| Shell chrome components | `app/ui/shell/*` (`AccountSwitcher.tsx`, `MoneyRealityBadge.tsx`, `AmbientRiskStrip.tsx`, `RunOnceButton.tsx`, `RunStateButton.tsx`, `AlertsDropdown.tsx`, `CommandPalette.tsx`, `HelpPanel.tsx`, `AvatarMenu.tsx`) | Extracted from `app/dashboard-client.tsx`. |
| Shell client state | `src/lib/shell/view-scope.ts` | Ephemeral view-scope store (P2). Distinct from persisted execution-scope. |
| Autonomy-reset | `src/lib/autonomy-reset.ts` + schema in `src/lib/db.ts` `migrate()` | Net-new, §9. |
| Catch-all account route | `app/(shell)/a/[accountId]/...` | Thin seeder, §2.6. |

The `[accountId]` route param is a **seed only**; the load-bearing safety boundary is server-side write-time validation of `accountId` against the session (Principle 3, §2.6).

---

## 1. Three-zone layout

### 1.1 Structure

The shell is a CSS grid header bar (`role="banner"`, height `56px` desktop) plus a body region below it. Three zones, left → right:

```
┌─ LEFT · SCOPE (min 240px, max 320px) ─┬─ CENTER · SPINE (flex, min 0) ────────────┬─ RIGHT · VERBS + RISK (auto) ─────────────┐
│  Account Switcher chip                │  Destination rail (6 verbs + Scan/more)   │  Ambient risk strip                       │
│  money-reality · authority · equity   │  Assistant is NOT here (overlay)          │  [▶ Run once —target] [■ STOP] 🔔 ⌘K ? ⦿  │
└───────────────────────────────────────┴────────────────────────────────────────────┴────────────────────────────────────────────┘
   (viewport hairline: grey when practice, solid red when a Live account is in view — §10)
```

Grid template: `grid-template-columns: minmax(240px, 320px) minmax(0, 1fr) auto`. The CENTER `minmax(0, 1fr)` is required so a long destination rail truncates into a "more ›" overflow rather than pushing the RIGHT zone off-screen.

- **LEFT** is the scope anchor. Pinned, `position: sticky; left: 0`, so it survives horizontal scroll of the spine on narrow desktop.
- **CENTER** is the spine: the six primary destination verbs + a `Scan / more ›` overflow. Settings is deliberately absent (footer/avatar only). This zone is owned by the destination-nav sub-spec; the shell only reserves it and renders the overflow control.
- **RIGHT** is global verbs + ambient risk, never scrollable-away. On width pressure it collapses icon-first (§8).

### 1.2 Zone contents (authoritative list)

| Zone | Component | Data source | Owner |
|---|---|---|---|
| LEFT | `AccountSwitcher` chip + dropdown | `GET /api/shell/scope` (active account) + `GET /api/connected-accounts` (list) | this spec |
| CENTER | Destination rail | `NAV_V2` destination map (static) + per-destination badge counts from `/api/shell/scope` | destination-nav spec (shell reserves the region) |
| CENTER | `Scan / more ›` overflow | static | this spec |
| RIGHT | `AmbientRiskStrip` | `GET /api/shell/scope` → `risk` block | this spec |
| RIGHT | `RunOnceButton` (target-stamped) | active account + money-reality | this spec |
| RIGHT | `RunStateButton` (Start / Resume / STOP) | active account system state | this spec |
| RIGHT | `AlertsDropdown` (🔔) | `GET /api/alerts?scope=active` + SSE `alert` events | this spec |
| RIGHT | `CommandPalette` trigger (⌘K) | destination map + settings index | this spec |
| RIGHT | `HelpPanel` trigger (?) | static content, context param | this spec |
| RIGHT | `AvatarMenu` (⦿) | session identity | this spec |

### 1.3 Data contract — `GET /api/shell/scope`

New endpoint (P0), the single fetch that hydrates the whole shell. Returns:

```ts
interface ShellScope {
  activeAccount: {
    id: string;                         // connectedAccountId
    label: string;                      // "Roth IRA"
    broker: "alpaca" | "robinhood" | "test";
    moneyReality: "test" | "paper" | "live";     // derived: broker==="test" ? "test" : environment
    realityClass: "practice" | "real";           // test|paper → practice; live → real
    authority: "propose" | "decide";             // policy.strategyAuthority
    systemState: "active" | "halted" | "close_only" | "liquidating";
    equity: number | null;
    dayPnlPct: number | null;
    pendingApprovals: number;
    activePreset: { id: string; name: string; divergedFields: number } | null;
    healthDot: "ok" | "degraded" | "down";       // provider/connection health for THIS account
  } | null;                             // null ⇒ "pick an account" blocking state
  accountCount: number;                 // drives single-account collapse (P11)
  risk: {
    dailyNotionalUsed: number; dailyNotionalCap: number | null;
    grossExposure: number; netExposure: number; exposureCap: number | null;
    regime: string;                     // "Neutral" | "Risk-off" | …
  } | null;                             // null when unscoped
  scopeUnresolved: boolean;             // true ⇒ render blocking state (§2.5)
}
```

`moneyReality`/`realityClass` are computed server-side from `ConnectedAccount.broker` + `.environment` (`db-api-keys.ts:588-589`), never trusted from the client. `authority`/`systemState` come from the effective `TradingPolicy` (`db-profiles.ts getPolicy`).

---

## 2. Account switcher (LEFT zone) — all states

The switcher owns **scope**; the avatar owns **identity** (§7). These are visually and functionally distinct (parent doc resolves the conflated "profile = both" bug). Component: `app/ui/shell/AccountSwitcher.tsx`.

### 2.1 The chip (collapsed, always visible)

Renders four lines in a `<button aria-haspopup="menu" aria-expanded={open}>`:

```
◈ Roth IRA · Alpaca              ▾
PAPER · practice money   ·  Propose
$48,210            ▲ +1.2%
```

Line 1: `◈ {label} · {brokerDisplayName}` + disclosure `▾` (omitted in single-account state, §2.2).
Line 2: **money-reality badge** (word-class first, §3) `·` **authority pill** `·` state suffix when tripped (`‖ HALTED` / `● close-only` / `⚠ brake` / `⟳ liquidating`).
Line 3: `{equity formatted}` + `{dayPnl arrow + pct}`, colored by sign (green up / red down / grey flat). Renders `—` when `equity === null`.

**Chip states:**

| State | Trigger | Rendering |
|---|---|---|
| default | `activeAccount != null` | full chip as above |
| loading | scope fetch in flight, no cached account | skeleton: greyed label line + two shimmer bars; disclosure disabled |
| error | scope fetch failed | chip shows last-known-good account with a `⚠` and tooltip "Account state may be stale — retry"; dropdown still opens; a "Retry" row appears at top |
| empty (zero accounts) | `accountCount === 0` | chip replaced by CTA button "Connect your first account →" routing to `/welcome` guided flow (§2.4) |
| blocking (pick-an-account) | `scopeUnresolved === true` | chip renders neutral "Pick an account to continue →", dropdown **auto-opens** on mount, scoped actions disabled (§2.5) |
| single-account (static) | `accountCount === 1` | no `▾`, non-interactive `<div>` not `<button>`; all multi-account chrome suppressed (§2.2) |

### 2.2 Single-account static chip (P11 — LOCKED)

For a user with exactly one connected account (`accountCount === 1`):

- The chip is a **static, non-interactive** element (no dropdown, no `▾`, no `aria-haspopup`).
- **All multi-account chrome is suppressed:** Fleet row, per-setting scope tags (`THIS ACCOUNT`/`ALL ACCOUNTS`), origin badges (four-glyph taxonomy), and the "Overrides (N)" chip are hidden app-wide. The single account's config is simply "the config."
- **Stale/one-off account id auto-resolves to the sole account** (LOCKED, novice #7). Concretely: when the `[accountId]` route param or a persisted `viewScopeAccountId` does **not** match the one account, `resolveAccount` returns the sole account instead of failing closed. This is the *only* place fail-closed is overridden, and it is gated strictly on `accountCount === 1`.

  **Implementation (`db-profiles.ts:190-193`, `resolveAccount`):**
  ```ts
  function resolveAccount(userId: string, connectedAccountId?: string) {
    const accounts = listConnectedAccounts(userId);
    if (connectedAccountId) {
      const match = accounts.find((a) => a.id === connectedAccountId);
      if (match) return match;
      // LOCKED single-account auto-resolve: a stale/one-off id falls back to the
      // sole account rather than failing closed. Multi-account users keep fail-closed.
      if (accounts.length === 1) return accounts[0];
      return undefined;                 // multi-account: fail closed → scopeUnresolved
    }
    return getActiveConnectedAccount(userId);
  }
  ```
  **Acceptance:** `resolveAccount("u", "does-not-exist")` returns the sole account when the user has 1 account; returns `undefined` (→ blocking state) when the user has ≥2 accounts. Round-trip test both branches.

- **The Test/local-sim pseudo-account counts as an account** for `accountCount`. A keyless user auto-provisioned with only Test (`ensureTestAccount`, `db-api-keys.ts:566`) is a single-account user and gets the static chip. Multi-account chrome unlocks only when a **second real** account connects.

### 2.3 Multi-account dropdown (`accountCount ≥ 2`)

A `role="menu"` panel anchored under the chip. Ordering and grouping are **normative**:

```
▸ All accounts (Fleet)            aggregate net worth $312,540      ← Fleet row, always top
─ LIVE — REAL MONEY ─────────────────────────────────────────────  ← Live group, always FIRST
  ● Robinhood · Individual   [LIVE·real]  Decide   ♥ ok  ▲ +0.8%  ⚑ 2  Momentum-v3
─ PAPER — practice money ────────────────────────────────────────
  ◉ Roth IRA · Alpaca        [PAPER]      Propose  ♥ ok  ▲ +1.2%  ⚑ 0  Momentum-v3
  ○ Alpaca · Taxable         [PAPER]      Propose  ♥ ok  ▬ 0.0%   ⚑ 1  Value-v2
─ SANDBOX — Test / local sim (distinct section, NOT a peer broker row) ─
  ▨ Test Sim                 [TEST]       Propose  (fake & safe · excluded from Fleet/wash-sale)
──────────────────────────────────────────────────────────────────
  + Connect account                       Preferences… / Settings   ← footer
```

**Grouping rules:**

1. **Fleet row** (`▸ All accounts (Fleet)`) is always the first row; shows aggregate net worth (sum of `equity` across non-Test accounts). Selecting it enters Fleet view (§2.7).
2. **Live group is always rendered first**, labeled `LIVE — REAL MONEY`, red group header. Ordered within by equity desc.
3. **Paper group** next, labeled `PAPER — practice money`, blue group header.
4. **Sandbox section** last, labeled `SANDBOX — Test / local sim`, grey header, with the explicit note "(fake & safe · excluded from Fleet/wash-sale)". Test is **not** a peer broker row (multiaccount-edge #3). It is excluded from Fleet emergency controls, "arm Live" is unreachable from it, and it is excluded from cross-account wash-sale contribution (the `tax.ts:113` `broker==="test" → "paper"` leak fix is a precondition, tracked by the tax/wash-sale spec — the switcher just renders the classification).
5. Empty groups are omitted entirely (no empty "LIVE" header if no live accounts).

**Per-row fields (left → right):** selection glyph (`●` active-live / `◉` active / `○` inactive / `▨` sandbox) · `{label} · {broker}` · money-reality badge · authority · `♥ {healthDot}` · day-P&L arrow+pct · `⚑ {pendingApprovals}` · `{activePreset.name}`. Each row is a `role="menuitem"`; the whole row is one selection target.

**Row states:**

| State | Rendering |
|---|---|
| default | full row |
| loading (per-row lazy) | label + badge render immediately from `/api/connected-accounts`; equity/pnl/pending/health shimmer until `/api/shell/accounts-summary` resolves |
| error (per-row) | health dot shows `♥ down` red; equity/pnl show `—`; row still selectable |
| empty group | header + rows omitted |

**Footer:** `+ Connect account` (routes to Connections onboarding) and `Preferences… / Settings` (opens avatar/Preferences menu, §7 — the switcher does NOT own Settings, it links to the identity owner).

### 2.4 Empty / zero-account state (first-run)

When `accountCount === 0` (should be rare — `ensureTestAccount` normally auto-provisions Test on first touch, `db-api-keys.ts:566`): the chip becomes a single CTA "Connect your first account →" that routes to the `/welcome` guided flow ("Connect your first account — start with Test (no real money, no broker login)"), defaulting into Test + Propose-only. The six destinations render greyed with that one CTA; nothing is scoped. This is the parent doc's Edge-cases "Zero connected accounts" path.

### 2.5 Blocking "pick an account" state

When `scopeUnresolved === true` (multi-account user, no valid active/route-seeded account — e.g. the active account was deleted, or a multi-account user hit a stale `[accountId]`):

- The chip renders neutral: `Pick an account to continue →`, no money-reality color, grey hairline.
- The **dropdown auto-opens** on mount (`open` initialized `true`, focus moved to the first selectable account row).
- **All scoped actions are disabled**: Run once, STOP, and every destination in the spine are `aria-disabled`, greyed, and non-navigable; the Assistant slide-over refuses trade/config actions. A banner in the body reads "Select an account to continue."
- Selecting any row resolves scope, closes the dropdown, and re-enables the shell.
- This state **never** appears for single-account users (they auto-resolve, §2.2).

### 2.6 Stale-id auto-resolve vs fail-closed (route encoding)

Route encoding adopts the LOCKED thin catch-all: `app/(shell)/a/[accountId]/...`. The param **seeds** `viewScopeAccountId`; it is **not** the safety boundary.

- On mount, the layout reads `params.accountId`, calls `resolveAccount(userId, accountId)`:
  - **Match** → set as view-scope, render.
  - **No match, `accountCount === 1`** → auto-resolve to sole account, rewrite URL to the resolved id via `router.replace` (no history entry), render (§2.2).
  - **No match, `accountCount ≥ 2`** → `scopeUnresolved = true` → blocking state (§2.5). Do **not** silently fall back to the persisted active account (that could point an autonomous action at the wrong real-money account — Principle 3).
- **The real boundary:** every mutating write (`/api/policy`, `/api/proposals/:id/approve`, `/api/strategy/run`, `POST /api/shell/stop`, etc.) re-validates its `accountId` argument against the session server-side before acting. A stale tab whose URL still says `/a/oldId/...` cannot mutate `oldId` if the session/write-guard rejects it. The URL is ergonomics; the server guard is safety. This closes the P2/route-encoding gap concretely: **ship the write-guard regardless; ship the `[accountId]` seed as option (b).**

**Acceptance:** a `POST /api/policy` with `accountId` not owned by the session → `403`, no write, `audit("scope_violation", …)`. A `GET` with a stale id for a single-account user → auto-resolved 200. A `GET` with a stale id for a multi-account user → 200 rendering the blocking state (read is safe; the block is a UX gate, the write-guard is the real gate).

### 2.7 Switching behavior & the mid-task-switch hazard (P2)

Selecting an account is **view-scope switch**: instant, re-scopes all read/config surfaces in place, persists `viewScopeAccountId` (per-tab, ephemeral store in `src/lib/shell/view-scope.ts`) and mirrors to the URL.

**Until P2 ships, view-switch is NOT free** — this is the sharpest current-code hazard and the shell must guard it: today `getActiveConnectedAccount` is a persisted singleton (`db-api-keys.ts:580`) and any non-active account is coerced `systemState → "halted"` on its next policy read/write at **three confirmed points** (`db-profiles.ts:284, 349, 397`). So flipping the active pointer today can silently demote the account you left running.

**Shell obligation, pre-P2 (`NAV_V2` + `VIEW_SCOPE_DECOUPLED=off`):** the switcher shows a confirm on switch — "Switching may pause **{previousAccount}** (its autonomy drops to Propose/halt). Continue?" — OR is gated to read-only comparison. **Post-P2** (`VIEW_SCOPE_DECOUPLED=on`): view-scope is decoupled from execution-scope, the not-active→halted coercion is removed (`:284/349/397`), and switching is free with no confirm.

**Switching into a Live account** always shows a brief "You are now acting on **REAL MONEY**" acknowledgment (auto-dismiss 3s or on interaction) and paints the viewport red (§10) — regardless of P2.

---

## 3. Money-reality, authority, and halt badges

Component: `app/ui/shell/MoneyRealityBadge.tsx`. **Words first, color second** (Principle 5, LOCKED — practice vs real stated in words, never color alone).

### 3.1 Money-reality badge

Two orthogonal facts encoded: the **word-class** (`realityClass`) and the **three-way tier** (`moneyReality`).

| `moneyReality` | Badge text | `realityClass` word | Color | Notes |
|---|---|---|---|---|
| `test` | `TEST` | `· practice` (in dropdown) | grey `#6b7280` | sandbox; never real |
| `paper` | `PAPER` | `· practice money` | blue `#2563eb` | practice, but broker-connected |
| `live` | `LIVE` | `· real money` | red `#dc2626` | the only real-money tier |

- On the chip line 2, render `{TIER} · {realityClass word}` e.g. `PAPER · practice money`. Never render the word-class as color alone.
- `realityClass` collapses `test`+`paper` → **practice**; `live` → **real**. This is the "Practice vs Real" dial the LOCKED decision names.
- The badge is a `<span role="status">` with `aria-label` including the full words ("Paper, practice money") for screen readers.

### 3.2 Authority pill

Reflects `strategyAuthority` (`types.ts:17` — `"propose" | "decide"`), the **orthogonal** dial:

| Authority | Pill | Color |
|---|---|---|
| `propose` | `Propose` | neutral grey outline |
| `decide` | `Decide` | amber outline `#d97706` (auto-execute is a heightened-attention state) |

Money-reality and authority are rendered as **two separate pills**, never merged into one slider (Principle 4). A `LIVE · real money · Decide` chip is the maximum-attention combination and additionally paints the viewport red.

### 3.3 Halt / state-suffix badge

Appended to line 2 only when `systemState !== "active"` (`types.ts:16`):

| `systemState` | Suffix | Color | Meaning |
|---|---|---|---|
| `active` | *(none)* | — | running |
| `halted` | `‖ HALTED` | red | no new activity |
| `close_only` | `● close-only` | amber | closes allowed, no opens |
| `liquidating` | `⟳ liquidating` | red | actively flattening |

A transient **`⚠ brake`** suffix renders when a vol-panic circuit breaker has tripped this run (from `/api/shell/scope` risk block), independent of `systemState`.

**Halt-state model (parent doc coherence B3):** there is **one** halt state per account (`systemState`). The chrome ■ STOP and Fleet STOP are *actuators* that write it; Guardrails→Autonomy holds the *auto-trip thresholds*; Settings→Admin holds the *operator/system override*. The shell renders the state; it does not own three competing halt concepts.

---

## 4. Ambient risk strip (RIGHT zone)

Component: `app/ui/shell/AmbientRiskStrip.tsx`. A compact, non-interactive read-out, never buried in Settings. Sourced from `/api/shell/scope` → `risk`.

```
⟨ used 2k/10k · net 0.4x · Neutral ⟩
```

| Segment | Field | Format | Empty/loading |
|---|---|---|---|
| daily notional | `dailyNotionalUsed / dailyNotionalCap` | `used {k}/{cap}k`; if `cap === null` → `used {k}` (no cap) | `used —` while loading |
| net exposure | `netExposure`, `exposureCap` | `net {x}x` (net exposure as multiple of NAV); color amber when `> 0.8×cap`, red when `≥ cap` | `net —` |
| regime | `regime` | plain word | `Neutral` fallback |

- Clicking the strip deep-links to **Guardrails → Circuit breakers / Exposure** (read the live gauges in full). It is otherwise inert.
- **States:** default (values); loading (each segment `—` with shimmer); empty/unscoped (strip hidden when `risk === null`, i.e. blocking state); error (last-known values with a `⚠` tooltip "risk data stale").
- **Responsive:** first segment to drop under width pressure (§8) — it collapses into the STOP button's tooltip and a small `⚠` if any segment is at-cap.

---

## 5. Run-once — target-stamped (RIGHT zone)

Component: `app/ui/shell/RunOnceButton.tsx`. Executes one strategy run against the active account. **The button is stamped with its target** (novice #1) so it can never silently fire on a forgotten Live account.

### 5.1 Label & states

Label template: `▶ Run once — {label} · {TIER}` e.g. `▶ Run once — Roth IRA · PAPER`.

| State | Trigger | Rendering / behavior |
|---|---|---|
| default (practice) | active account is Test/Paper | enabled; one click → `POST /api/strategy/run { accountId }`; button shows spinner + `Running…` until run completes/SSE `run` event |
| default (Live) | active account is Live | enabled **only if Live-run is armed** for this session; label `▶ Run once — {label} · LIVE` in red. If not armed, clicking opens the **arm-Live ritual** (type-to-confirm, §5.2) — the run does not fire until armed |
| running | run in flight | disabled, spinner, `Running…`; STOP remains enabled (you can abort by halting) |
| loading | scope not yet hydrated | disabled skeleton |
| disabled (unscoped) | blocking state | disabled + tooltip "Pick an account first" |
| disabled (halted) | `systemState === "halted"` | disabled + tooltip "Account is halted — resume in Guardrails" (a run cannot start on a halted account) |

### 5.2 Live-run arming ritual

The Live rung is **armed separately, never inherited** from a Paper run. First Run-once on a Live account in a session (or after idle timeout, §9) requires an explicit inline confirm: money-reality-labeled ("This will run against **REAL MONEY** in {label}"), plus type-to-confirm for the *first-Live-arm* of the session. Once armed, subsequent Run-once clicks this session are one-click (the arm persists in the ephemeral session store), but **Decide-on-Live auto-execution still re-consents per the Approvals path** (that is the Approvals spec's concern, not the shell's — the shell only arms the manual Run-once).

**Acceptance:** a palette "run once" (§6) and the chrome button share the **exact same** arming gate — no Live execution via a palette shortcut without the ritual (coherence E2). Both call the same `armLiveRun()` guard in `src/lib/shell/view-scope.ts`.

---

## 6 → renumbered. Run-state action + STOP kill switch (RIGHT zone)

Component: `app/console/components/chrome.tsx` (`RunStateButton`). The header action is intent-specific:
Start when halted, Resume when close-only, and red STOP only when the visible action is stopping
active/winding-down behavior. **STOP ≠ Flatten** (novice #5, LOCKED).

### 6.1 Semantics (non-negotiable)

- **STOP halts new activity in one click. It is always safe. It never sells.** One click writes `systemState → "halted"` for the active account via `POST /api/shell/stop { accountId }`. No confirm on STOP — halting is always safe, and friction on a panic button is a bug.
- **Selling is a separate, secondary action.** "Flatten / sell positions" is a distinct control living in Guardrails → Autonomy (and optionally a secondary button *inside* the STOP popover, clearly separated), which writes `systemState → "liquidating"`. It **always** confirms; type-to-confirm on Live. It is never welded into the STOP button.
- Grounding: today `strategy.stop` maps to `setStrategyState(userId, "halted")` and sets `enabled = false` (`mobile-api.ts:632, 589-590`) — it does not liquidate. `liquidating` is a separate command (`mobile-api.ts:635`). The shell preserves this separation and makes it visible in the label.

### 6.2 States

| State | Rendering | Action |
|---|---|---|
| armed (running) | solid `■ STOP`, red outline, enabled | one click → halt active account; optimistic → chip shows `‖ HALTED` immediately, reconcile on response |
| already halted | green `Start` with play icon | opens the run-state sheet titled "Start the strategy"; Start is first, Wind down remains secondary/red; Live start keeps the typed phrase ritual |
| close-only | green `Resume` with play icon | opens the run-state sheet titled "Resume or change run state"; Resume full operation is first, STOP/Wind down remain available but visually separate |
| liquidating | solid `■ STOP`, red outline, enabled | halts the wind-down without selling more; resume remains in the run-state sheet |
| in-flight | spinner on the button, label `Stopping…`; button disabled to prevent double-fire | — |
| unscoped | disabled + tooltip "Pick an account first" | — |
| error | button returns to `■ STOP` with a toast "Halt failed — retry"; **fail loud** (a silently-failed STOP is the worst outcome) | retry |

### 6.3 Fleet STOP scope (LOCKED)

When the switcher is in Fleet view (§2.7 / All accounts), the STOP button becomes **STOP all** with expanded scope:

- **Halts all Live + all Paper accounts. Excludes Test/local-sim** (nothing real to halt). This is the LOCKED decision (Open Q3 resolved: Live + Paper halt; Test excluded).
- **Live accounts listed first**, halted first, with a **per-account confirmed-halted echo**: the Fleet STOP opens a progress list showing each account transitioning `→ ‖ HALTED` with a check as each write confirms. The operation is not "done" until every Live + Paper account echoes halted.
- Endpoint: `POST /api/shell/fleet-stop` → iterates every Live + Paper account, writes `systemState → "halted"` each, returns a per-account result array. Audited per account (`audit("fleet_stop", { accountId, from, to })`).
- Fleet STOP is **not welded to a Fleet-flatten** either; "Set all close-only" is a separate Fleet control, and Fleet-flatten (liquidate all) is intentionally not offered as a single button (too dangerous to weld).
- Fleet controls are meaningful only after P2's concurrent-arming model exists; pre-P2 the Fleet STOP is still safe (halting is always safe) but Fleet *arming* is unavailable.

**Acceptance:** `POST /api/shell/fleet-stop` halts every non-Test account and returns `{ results: [{accountId, systemState:"halted"}, …] }` with Live entries first; a Test account in the set is skipped with `{accountId, skipped:"test"}`. Never sells.

---

## 7. Alerts dropdown (🔔, RIGHT zone)

Component: `app/ui/shell/AlertsDropdown.tsx`. The **live chrome alert stream** — one member of the Alerts noun-family (chrome 🔔 **Alerts** stream · Settings → **Alert delivery** rules · Results → **Alert history** log). The bare noun "Notifications" is retired everywhere (coherence B1, novice #4).

- **Trigger:** 🔔 icon with an unread-count superscript badge. Opens a `role="menu"` popover of recent alerts, scoped to the active account (with an account tag per row in Fleet/multi-account).
- **Data:** `GET /api/alerts?scope=active&limit=20` for the initial list; live updates via the SSE `alert` event on `/api/events/stream`. Event types are the existing `NotificationEventType` set: `fill`, `block`, `run_failed`, `pending_approval`, `kill_switch`, `limit_order_stale`, `provider_degraded`, `price_alert`, `proposal_withdrawn`.
- **Row:** icon-by-type · plain-language summary · relative time · account tag (multi-account). Clicking a row deep-links to the relevant destination (e.g. `pending_approval` → Approvals; `kill_switch` → Guardrails→Circuit breakers; `provider_degraded` → Settings→Admin).
- **Footer:** "Mark all read" + "Alert history →" (routes to Results → Alert history) + "Alert delivery settings →" (routes to Settings → Alert delivery). The dropdown itself never edits delivery rules — it only displays and links.

**States:** default (list); loading (3 shimmer rows); empty ("No alerts — you're all caught up"); error ("Couldn't load alerts — retry"). Unread badge hidden when count is 0.

---

## 8 → renumbered. Command palette (⌘K, RIGHT zone)

Component: `app/ui/shell/CommandPalette.tsx`. A jump layer over destinations + sub-sections + settings + actions. Opened by `⌘K` / `Ctrl+K` or the ⌘K trigger.

### 8.1 Indexed entries

1. **Destinations** — Dashboard, Approvals, Scan, Strategy, Guardrails, Results (+ old `WorkspaceTab`/`FeedTab` ids as hidden aliases so `tab-decision`… still resolve during migration).
2. **Sub-sections** — "Guardrails → Circuit breakers", "Strategy → Signals", "Results → Alert history", etc.
3. **"Open Settings section X"** — every Settings section (Account & Security, Connections, Keys & Models, Alert delivery, Data & Privacy, Presets, Appearance, Admin).
4. **Deep-links into any config field** — sourced from the same field-definition index that renders the controls and powers Settings search (never a parallel list). E.g. "Max drawdown %", "Wash-sale guard".
5. **Actions** — "Run once", "STOP (halt active account)", "Switch account →", "Connect account", "Open Assistant".

### 8.2 Money-reality gating (LOCKED / coherence E2)

Palette **"Run once"** inherits the **exact** money-reality gating of the chrome Run button (§5.2). Selecting "Run once" while the active account is Live and unarmed triggers the same arm-Live ritual — no Live execution via a palette shortcut without the arm ritual. The palette calls the same `armLiveRun()` guard; it does not have its own bypass path.

Similarly, palette "STOP" calls the same `POST /api/shell/stop` (always safe, one-step). Palette cannot invoke Flatten/liquidate without the confirm+type-to-confirm ritual.

**States:** default (recent + all commands); typing (filtered fuzzy results); no-match ("No commands match '{q}'"); loading (field index hydrating — destinations/actions available immediately, config-field deep-links populate async).

---

## 9 → renumbered. Help (?, RIGHT zone)

Component: `app/ui/shell/HelpPanel.tsx`. A contextual slide-in panel, updated in lockstep with every rename (same PR as the rename, per parent doc merge requirement).

- **Tabs:** Overview · Guardrails · Settings Glossary · Tax · Data Sources · MCP.
- **Context param:** opening Help from a destination passes `?context={destination}` so the panel opens on the most relevant tab (e.g. from Guardrails → Guardrails tab; from an Approvals card → Guardrails/Tax as relevant).
- **Settings Glossary** must reflect the new taxonomy (renamed sections, relocated targets). **MCP** tab explains that MCP/tool config is edited under Keys & Models → MCP tools.
- **States:** default (Overview or context tab); loading (content is static/bundled — effectively instant); no error state (bundled content).

---

## 10 → renumbered. Avatar / Preferences menu (⦿, RIGHT zone)

Component: `app/ui/shell/AvatarMenu.tsx`. The **identity** menu — deliberately distinct from the account switcher (which owns **scope**). This split resolves the conflated "profile = both identity and account picking" bug.

- **Owns:** the Settings entry (Settings is off the primary rail — reached only here and from the switcher footer), account management (Connect / manage connected accounts), sign-out, and quick Appearance toggles (theme, density).
- **Items:** `{userEmail}` header · Settings → (opens the off-rail Settings tree) · Connected accounts → (manage) · Appearance (theme/density inline) · Help · Sign out.
- The avatar **never** switches scope. Selecting "Connected accounts" opens the management surface, not the scope switcher.
- **States:** default (menu); loading (identity from session — instant on authenticated routes); error (menu still opens; identity line shows "Account" fallback).

---

## 11 → renumbered. Live red-viewport treatment

The single loudest ambient cue (Principle 5 — Live is loud).

- **Practice (Test/Paper) in view:** a **grey** 1px viewport hairline border (`box-shadow: inset 0 0 0 1px #d1d5db`).
- **Live account in view:** the hairline turns **solid red** (`box-shadow: inset 0 0 0 2px #dc2626`), applied to the whole viewport, the instant a Live account becomes the active view-scope. Combined with the LEFT chip's `LIVE · real money` red badge, this is impossible to miss.
- **On switching into Live:** brief "You are now acting on **REAL MONEY**" acknowledgment banner (§2.7), then the red hairline persists for the duration Live is in view.
- **Fleet view** with any Live account present: red hairline persists (a real-money account is in scope even in the roll-up).
- **Reduced-motion / high-contrast:** the red border is static (no pulse); in high-contrast mode it thickens to 3px rather than relying on hue.
- **P12 earlier-wins:** a Live account is **never auto-selected on load** (default-landing-account is non-Live only). So the red viewport is never the *first* thing a returning user sees unless they explicitly re-enter a Live scope.

Implementation: the shell layout sets a `data-reality={realityClass}` and `data-live={isLive}` attribute on the `(shell)` root; CSS keys the hairline off these. Single source of truth = `/api/shell/scope`.

---

## 12. Autonomy-reset-on-restart (net-new, LOCKED — REQUIRED, DEFAULT ON)

Per LOCKED decisions this is **net-new**: build it regardless of whether an equivalent exists today. It does **not** exist in current code — `account_strategy_state` (`db.ts:470-480`) persists `system_state` and `policy` (which carries `strategyAuthority`) but has **no restart-epoch column and no reset-on-boot hook**. This section specifies the persistence + reset mechanism.

### 12.1 Requirement

On every app/process restart, **every account's autonomy drops to its safe floor (Propose-only, `strategyAuthority → "propose"`) until the user re-arms.** `systemState` is independently reset to a safe floor as well (`active → halted` is *not* forced — halting live positions' management could be unsafe; instead autonomy is the reset dial, matching Principle 9 "autonomy resets to its safe floor on restart"). Concretely: **restart resets `strategyAuthority` from `decide` → `propose`** for all accounts; it does not touch `systemState` (an account mid-close_only stays close_only).

### 12.2 Mechanism (schema anchor)

Add a boot-epoch guard so the reset fires exactly once per process start, and is auditable:

1. **New table in `db.ts` `migrate()`** (per CLAUDE.md: new tables' `CREATE TABLE` goes in `migrate()`, CRUD in the matching `db-*` module):
   ```sql
   CREATE TABLE IF NOT EXISTS autonomy_reset_epoch (
     id INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
     last_boot_id TEXT NOT NULL,              -- process boot uuid that last ran the reset
     reset_at TEXT NOT NULL
   );
   ```
2. **New module `src/lib/autonomy-reset.ts`** exporting `resetAutonomyOnBootIfNeeded(bootId: string)`:
   - Read `autonomy_reset_epoch.last_boot_id`. If it equals the current process `bootId`, no-op (already ran this boot).
   - Otherwise, for **every** `account_strategy_state` row: parse `policy`, if `policy.strategyAuthority === "decide"` set it to `"propose"`, re-serialize, write back. Also clear any ephemeral session Live-run arms.
   - Update the epoch row to the current `bootId`.
   - `audit("autonomy_reset_on_restart", { accountsReset: n }, userId)` per affected user.
3. **Boot hook:** call `resetAutonomyOnBootIfNeeded(process-boot-uuid)` from the DB-init path in `src/lib/db.ts` `getDb()` first-initialization (the same place `migrate()` runs), guarded so it runs once per process. The `bootId` is a module-level `crypto.randomUUID()` generated at process start.
4. **Default ON:** gated behind no flag for the behavior itself; an env `AUTONOMY_RESET_ON_RESTART=false` escape hatch exists for tests/local only, default `true`.

### 12.3 Session idle re-arm

Beyond process restart, the first Live *act* of a session (or after an idle timeout, default 30 min, `SESSION_LIVE_IDLE_MINUTES`) re-consents (Principle 9). This is a client-session concern in `src/lib/shell/view-scope.ts`: the ephemeral Live-run arm (§5.2) and Decide-on-Live arm carry an `armedAt` timestamp; on idle expiry they clear, forcing re-consent. This is orthogonal to the process-restart reset (which is server-side and resets the persisted `strategyAuthority`).

**Acceptance:**
- Restart the process with an account at `strategyAuthority: "decide"` → after boot, `getPolicy` for that account returns `strategyAuthority: "propose"`; an audit row `autonomy_reset_on_restart` exists.
- Re-invoking `resetAutonomyOnBootIfNeeded` with the *same* bootId is a no-op (idempotent within a boot).
- A user re-arming Decide after restart persists until the *next* restart.
- Test-only `AUTONOMY_RESET_ON_RESTART=false` skips the reset (so restart-heavy test suites don't fight it).

---

## 13. Responsive / mobile degradation (spec now, land later — LOCKED)

Full account-scope parity is specified now; implementation lands later. **The switcher + STOP survive on every breakpoint** (coherence E1, migration #6). Applies to `app/mobile/` PWA and narrow desktop.

### 13.1 Breakpoints & collapse order

| Width | LEFT | CENTER | RIGHT |
|---|---|---|---|
| ≥1200px (full) | full 3-line chip | all 6 verbs + Scan/more | full strip + labeled buttons |
| 900–1199px | 2-line chip (equity line drops into tooltip) | verbs, Scan folds into "more ›" | risk strip → `⚠`+cap only; Run once loses label suffix→tooltip; STOP full |
| 600–899px (tablet) | chip → account glyph + badge only, dropdown unchanged | verbs → overflow menu (hamburger) except current | Run once → icon; **STOP stays full-label** (never degrade the kill switch to an ambiguous icon); 🔔 ⌘K ? ⦿ collapse into a `⋯` menu |
| <600px (phone/PWA) | **switcher survives** as a top-bar account glyph+badge, tap → full-screen account sheet | destinations → bottom tab bar (Dashboard/Approvals/Strategy/Guardrails/Results, Scan under "more") | **STOP survives** as a persistent floating red button, always reachable; Run once + Alerts move into the account sheet / a top-bar 🔔 |

**Invariant:** at no breakpoint do the **account switcher** or **STOP** disappear or become unreachable. If only two controls survive on the smallest screen, they are these two.

### 13.2 Mobile account-scope context (Open Q6 resolved)

The mobile command API (`src/lib/mobile-api.ts`) **adopts the same account-scope context**: every mobile command carries the target `accountId`, validated server-side against the session (§2.6). The mobile singleton-setter hazard is closed by **not** routing mobile commands through `setActiveConnectedAccount` (`db-api-keys.ts:681`, which flips the global persisted singleton and would demote other accounts pre-P2). Instead:

- Mobile commands include `accountId` in their payload; the command executor resolves and validates it per-command (like the web write-guard), **without** mutating the global active pointer.
- `account.activate` (`mobile-api.ts:46`) remains the *only* mobile command that intentionally changes the persisted active account, and it is an explicit user action — not a side effect of every scoped command.
- The mobile STOP command (`strategy.stop`) already targets via `getPolicy(userId)` scope and calls `setStrategyState(userId, "halted")` (`mobile-api.ts:632`); post-decoupling it takes an explicit `accountId` so a phone STOP halts the intended account, not just the global-active one.

**Acceptance:** a mobile `strategy.run_once { accountId }` for an account not owned by the session → rejected, no run. A mobile `strategy.stop { accountId }` halts exactly that account and does not flip the global active pointer.

### 13.3 `/welcome` placement

`/welcome` (first-run) lands **outside** the `(shell)` route-group pre-account, then hands into the shell once the auto-provisioned Test account exists (§2.4). `/login` is outside the shell (no switcher/STOP pre-auth). `/admin` is **inside** the shell (switcher + STOP must survive for system-halt access). These four route dispositions are the P0 route-group decision.

---

## 14. Keyboard shortcuts

Global, registered by the shell layout. All respect an `input`/`textarea`/`contenteditable` focus guard (typing in a field never triggers a shortcut).

| Shortcut | Action | Notes |
|---|---|---|
| `⌘K` / `Ctrl+K` | Open command palette | §8 |
| `⌘/` / `Ctrl+/` | Open Help (context tab) | §9 |
| `⌘.` / `Ctrl+.` | **STOP** the active account (halt) | one-key panic; always safe; no confirm. Mirrors the button exactly. Deliberately a low-collision chord. |
| `⌘⇧A` / `Ctrl+Shift+A` | Open account switcher (focus first row) | §2 |
| `g` then `d/a/s/g/r` | Go to Dashboard/Approvals/Strategy/Guardrails/Results | Vim-style two-key jump; `g s` → Scan. |
| `⌘J` / `Ctrl+J` | Toggle Assistant slide-over | Assistant is an overlay, not a tab |
| `⌘↵` / `Ctrl+Enter` | Run once (target-stamped) | inherits Live arm ritual (§5.2) — on unarmed Live it opens the ritual, does not fire |
| `Esc` | Close top-most overlay (palette / Help / switcher / Assistant), in that z-order | never closes a confirm dialog without explicit choice |

**No destructive one-key without safety:** `⌘.` STOP is exempt from confirm because halting is always safe (it never sells). There is **no** one-key Flatten/liquidate shortcut — liquidation always requires the full confirm ritual.

---

## 15. Focus order & accessibility

### 15.1 Tab order (desktop, `NAV_V2`)

Focus order follows visual reading order, left → right, so a keyboard user reaches scope → spine → verbs → risk actuators in a predictable line:

1. Skip-to-content link (visually hidden, first focusable)
2. **Account switcher chip** (`aria-haspopup="menu"`)
3. Destination rail items (Dashboard → Approvals → Scan/more → Strategy → Guardrails → Results)
4. Ambient risk strip (single focusable, links to Guardrails)
5. **Run once** button
6. **STOP** button
7. Alerts (🔔)
8. Command palette (⌘K)
9. Help (?)
10. Avatar / Preferences (⦿)
11. → main content region (`<main id="content">`)

### 15.2 Rules

- **Blocking state (§2.5):** focus is trapped to the auto-opened switcher dropdown; the rest of the tab order is `aria-disabled` and skipped. Escaping the dropdown without selecting is not possible (there is nothing else to do — you must pick an account).
- **Dropdowns/popovers** (switcher, Alerts, palette, avatar) are focus-trapped while open; `Esc` closes and returns focus to the trigger.
- **STOP** carries `aria-label="Stop — halt new activity on {label}. Does not sell positions."` so a screen-reader user knows STOP ≠ Flatten before activating.
- **Money-reality badge** exposes the full word-class in `aria-label` ("Live, real money") — never color-only.
- **Live viewport:** on entering Live scope, an `aria-live="assertive"` announcement fires "Now acting on real money in {label}" once (matching the visual ack).
- **Reduced motion:** spinners degrade to static "Running…"/"Stopping…" text; the red viewport border is static.

---

## 16. Migration / build sequencing (this spec's slice)

Traces to the parent doc's Incremental build path (P0–P4). The shell is built in this order, all behind `NAV_V2`:

1. **P0 — Shell container.** Create `app/(shell)/layout.tsx` rendering the three zones with the **current** tabs unchanged in CENTER. Decide route-group membership: `/admin` **in**, `/mobile` **in** (degraded), `/welcome` **out** (pre-account) then hands in, `/login` **out**. Ship `GET /api/shell/scope`. Switcher renders read-only (no free switching yet), STOP wired to existing halt handler, Run once target-stamped. **Acceptance:** switcher + STOP render on `/admin` and mobile; no content moved.
2. **P2 — Decouple view from execution** (first blocking safety migration). Split ephemeral view-scope (`src/lib/shell/view-scope.ts`) from persisted per-account arming; remove the not-active→halted coercion (`db-profiles.ts:284, 349, 397`); add the server-side write-time `accountId` validation (§2.6). Flip `VIEW_SCOPE_DECOUPLED=on`. Only now is switching free (drop the mid-task-switch confirm, §2.7).
3. **P3 — Single-account-first.** Ship the whole shell to single-account users first (static chip, no multi-account chrome, auto-resolve). Gate the multi-account dropdown / Fleet / scope tags behind the 2nd-account connection.
4. **Autonomy-reset (§12)** lands with P2 (it depends on the per-account arming model being coherent) — schema + boot hook + `src/lib/autonomy-reset.ts`.
5. **Fleet STOP (§6.3)** and Fleet view are deferred until post-P2 concurrent-arming exists; the per-account STOP ships in P0.

**Per-PR exit criterion (per parent doc migration #9):** every PR that renames a control or changes a shortcut updates the affected tests in the **same** PR (~723 tests; any asserting on "Halt & Flatten" label, tab ids, or `openSettings` targets will break). The chrome relabel "Halt & Flatten" → "STOP" (P1) updates its handler test in lockstep.

---

## 17. Acceptance criteria (consolidated, shell-level)

1. **Four questions answered on every screen:** the LEFT chip always shows account, money-reality (word-class + color), authority, and running/halted state; verified on Dashboard, Approvals, Strategy, Guardrails, Results, and `/admin`.
2. **STOP ≠ Flatten:** one click on ■ STOP halts (`systemState → "halted"`), never sells; there is no code path from the STOP button to a liquidation. Flatten is a separate, always-confirmed control.
3. **Fleet STOP scope:** halts all Live + all Paper accounts, excludes Test, Live listed first, per-account confirmed-halted echo.
4. **Run once is target-stamped** and cannot fire on Live without the arm ritual; palette "run once" shares the identical gate.
5. **Single-account auto-resolve:** a stale id resolves to the sole account for 1-account users; multi-account users hit the blocking "pick an account" state instead.
6. **Blocking state** disables all scoped actions and auto-opens the switcher; single-account users never see it.
7. **Autonomy-reset-on-restart** drops every account's `strategyAuthority` from `decide` → `propose` exactly once per process boot, audited, default-on.
8. **Switcher + STOP survive** at every breakpoint down to phone/PWA; the mobile command API carries validated `accountId` per command without flipping the global active pointer.
9. **Live red viewport** engages the instant a Live account is in view and is never auto-engaged on load (P12: no Live default-landing).
10. **Write-guard is the real boundary:** any mutating write with a session-mismatched `accountId` is rejected server-side with an audit row, regardless of URL.

---

**Grounding facts this spec relies on (verified in the live tree):** `SystemState` / `StrategyAuthority` unions (`src/lib/types.ts:16-17`); not-active→halted coercion at `db-profiles.ts:284, 349, 397`; `resolveAccount` at `db-profiles.ts:190-193`; `getActiveConnectedAccount` persisted singleton at `db-api-keys.ts:580`; `setActiveConnectedAccount` global flip at `db-api-keys.ts:681`; `ensureTestAccount` at `db-api-keys.ts:566`; `account_strategy_state` schema (no reset-epoch column) at `db.ts:470-480`; mobile STOP = halt-not-sell at `mobile-api.ts:589-590, 632`; `mobile_commands` schema at `db.ts:227-243`; `USER_LEVEL_POLICY_FIELDS` = 3 at `db-profiles.ts:20-24`. The dashboard client is `app/dashboard-client.tsx` (7,015 lines) with the current kill-confirm at `:907` — the shell components extract out of it behind `NAV_V2`.
