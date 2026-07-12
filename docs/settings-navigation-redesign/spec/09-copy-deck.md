# Copy Deck — Settings & Navigation Redesign (v2)

**Author:** Copy Deck author · **Date:** 2026-07-01 · **Canonical design:** [`docs/settings-navigation-redesign.md`](../settings-navigation-redesign.md) (v2 — read Part I §"Target IA", §"Global frame", §"Multi-account & scoping model", §"Settings taxonomy", and Part II-B before wiring any of these strings).

This is the **canonical content/copy** for the whole redesign: every user-facing string, organized by surface. It is a build spec, not prose — each entry names the control type, the state it renders in, the backing field/route where relevant, and acceptance criteria. Where a string is load-bearing for safety (money-reality, one-way doors, halt), it is marked **[SAFETY-CRITICAL]** and its exact bytes are normative.

**Locked vocabulary this deck enforces** (from the LOCKED DECISIONS + design §"Open questions" #5): destinations are **Dashboard · Approvals · Scan · Strategy · Guardrails · Results**; **Settings** is off-rail; **Assistant** is an overlay, never a tab; **Preset** (not "Strategy Profile"); **Results** (not "Review"); the **Alerts** family (not "Notifications"); **Guardrails / Risk** (not "Safety"); **Appearance** (not "Display"); **Data & Privacy** (not "Data").

**Two global conventions every string below obeys:**
1. **Money-reality is stated in words first, color second, never color alone** (design principle 5). Word-class strings: `PRACTICE` (Test + Paper) vs `REAL MONEY` (Live). Per-tier: `TEST · practice money`, `PAPER · practice money`, `LIVE · real money`.
2. **Type-to-confirm phrases are UPPERCASE, space-delimited, matched case-insensitively after `.trim().toUpperCase()`** — consistent with the two existing constants in the tree: `CONFIRMATION_PHRASE_PREFIX = "APPROVE LIVE"` (`app/components/ConfirmationModal.tsx:20`) and `ACCOUNT_DELETE_PHRASE = "DELETE MY ACCOUNT"` (`src/lib/account-deletion.ts:5`). All new phrases in this deck are defined as exported constants so tests and handlers share one source of truth.

---

## 0. String constants to add (single source of truth)

Define these once and import everywhere; do **not** inline the literals. Suggested home: a new `src/lib/copy/nav-v2-copy.ts` (word-class + badge strings, pure, no React) plus `src/lib/copy/confirm-phrases.ts` (type-to-confirm constants, importable by both client dialogs and server-side validators).

```ts
// src/lib/copy/confirm-phrases.ts  — normative; server AND client import these
export const ARM_LIVE_PHRASE        = "ARM LIVE";              // one-way door #1
export const ARM_AUTO_ON_LIVE_PHRASE = "ARM AUTO ON LIVE";     // one-way door #2
export const FLATTEN_LIVE_PHRASE    = "SELL LIVE POSITIONS";   // Flatten on a Live account
export const FLEET_STOP_PHRASE      = "STOP ALL";              // fleet emergency stop
export const ENABLE_SHORTING_PHRASE = "ENABLE SHORTING";      // per-account, Live only
// existing, do not redefine: "APPROVE LIVE <SYMBOL>", "DELETE MY ACCOUNT"

// src/lib/copy/nav-v2-copy.ts
export const MONEY_CLASS = {
  test:  { word: "PRACTICE", tier: "TEST",  line: "TEST · practice money"  },
  paper: { word: "PRACTICE", tier: "PAPER", line: "PAPER · practice money" },
  live:  { word: "REAL MONEY", tier: "LIVE", line: "LIVE · real money"     },
} as const;
export const AUTHORITY_LABEL = { propose: "Propose", decide: "Decide" } as const;
```

**Acceptance criteria for §0:** grep the client bundle for the literal strings `"Halt & Flatten"`, `"Notifications"`, `"Strategy Profile"`, `"Review"` (as a destination label) and `"APPROVE LIVE"` re-inlined — zero hits outside these constant files and the redirect-alias maps. Every type-to-confirm dialog references a constant, never a literal (so the server validator and the dialog can never drift — the exact silent-mismatch trap CLAUDE.md warns about).

---

## 1. Global chrome — Left zone (Account Switcher / scope anchor)

Backing: `ConnectedAccount` (`types.ts:280`), bound state in `account_strategy_state`. Money-reality derives from `environment` (`"paper" | "live"`) + `broker === "test"`; authority from `strategyAuthority` (`"propose" | "decide"`); halt from `systemState` (`"active" | "halted" | "close_only" | "liquidating"`).

### 1.1 The account chip (collapsed, always visible)

| Line | Content | Source | State notes |
|---|---|---|---|
| Row 1 | `{alias} · {broker}` e.g. `Roth IRA · Alpaca` | `label` · `broker` | Truncate alias at 24 chars with `…`. |
| Row 2 | **Money-reality badge** `{MONEY_CLASS[x].line}` + **authority chip** `{AUTHORITY_LABEL[x]}` | derived | See §3 for badge byte-strings and color. |
| Row 2 suffix | Halt/brake suffix, appended only when tripped: `‖ HALTED` · `● close-only` · `⌾ liquidating` · `⚠ vol-brake` | `systemState` / vol-panic | See §4.4 for the mapping. Never show a suffix when `systemState === "active"` and no brake. |
| Row 3 | `{equity}  {▲/▼} {dayPct}` e.g. `$48,210  ▲ +1.2%` | live equity, day P&L | `▬ 0.0%` for flat. Green up / red down / muted flat. |

**[SAFETY-CRITICAL]** The money-reality word-class (`PRACTICE` / `REAL MONEY`) must be present as literal text on the chip. Do not render the chip with color-only differentiation (design principle 5, novice #2).

### 1.2 Single-account collapse (P11)

For a user with exactly one connected account: render Row 1–3 as a **static chip with no `▾` affordance** and no dropdown. Suppress all scope tags, origin badges, and Fleet entry. Copy is identical; only the disclosure caret and dropdown are removed.

### 1.3 The switcher dropdown (multi-account only)

Section headers (rendered as non-interactive group labels), in this fixed order:

1. `▸ All accounts (Fleet)` — top row. Sub-line: `aggregate net worth {sum}` e.g. `aggregate net worth $312,540`.
2. `LIVE — REAL MONEY` — group header. **Live accounts grouped and listed first** (design §Multi-account, novice #6).
3. `PAPER — practice money` — group header.
4. `SANDBOX — Test / local sim` — group header. Sub-caption on the header row: `fake & safe · excluded from Fleet stop and wash-sale`.

Per-account row template (each token space-or-dot separated):
`{●/◉/○ selector-dot} {alias} · {broker}   [{tier badge}]   {authority}   {♥ health}   {▲ dayPct}   {⚑ N pending}   {activePresetName}`

Example rows (verbatim):
- `● Robinhood · Individual   [LIVE · real money]   Decide   ♥ ok   ▲ +0.8%   ⚑ 2 pending   Momentum-v3`
- `◉ Roth IRA · Alpaca   [PAPER · practice money]   Propose   ♥ ok   ▲ +1.2%   ⚑ 0   Momentum-v3`
- `▨ Test Sim   [TEST · practice money]   Propose   fake & safe · excluded from Fleet stop & wash-sale`

**Health dot copy:** `♥ ok` · `♥ degraded` · `♥ tripped` · `♥ halted`. Tooltip on `degraded`: `A data provider or the broker connection is degraded — see Dashboard.`

Footer row: `+ Connect account`   ·   `Preferences… / Settings`

### 1.4 Zero-account / unresolved-scope states

**[SAFETY-CRITICAL]** — copy for the states that *block* scoped actions.

| State | Where | Copy |
|---|---|---|
| No account selected (multi-account, stale tab) | switcher auto-opens, scoped actions disabled | Heading: `Pick an account to continue →` · Body: `Choose which account you're working on. Nothing will run until you do.` |
| Zero connected accounts (first-run) | full-screen guided flow, six destinations greyed | Heading: `Connect your first account` · Sub: `Start with Test — no real money, no broker login.` · CTA button: `Start in Test mode` · Secondary link: `Connect a broker instead` |
| Single-account stale id | silent auto-resolve, no copy | No dialog. Resolve to the sole account (novice #7). Do **not** show the "Pick an account" blocker for single-account users. |

**Switching into a Live account** (transient acknowledgment, design §Multi-account): toast/inline banner, auto-dismiss after ack: `You're now acting on REAL MONEY — {alias} · {broker}.` The viewport red hairline paints simultaneously (§3.4).

**Acceptance:** the `Pick an account to continue →` blocker renders only for multi-account users; a single-account user with a stale/one-off account id never sees it and auto-resolves (design Open Q7, §"Edge cases").

---

## 2. Global chrome — destinations, Assistant, right zone verbs, palette, help

### 2.1 Primary rail (center spine) — destination labels

Exactly six primary labels, in order. Scan is secondary (rendered under a `more ›` affordance, not co-equal).

| Order | Label | Route seed | Tooltip (on hover, ≤ 80 chars) |
|---|---|---|---|
| 1 | `Dashboard` | `/a/:accountId/dashboard` | `What this account's agent is doing right now.` |
| 2 | `Approvals` | `/a/:accountId/approvals` | `Decisions the AI is asking you to make.` |
| 3 | `Strategy` | `/a/:accountId/strategy` | `How the AI thinks on this account.` |
| 4 | `Guardrails` | `/a/:accountId/guardrails` | `What the AI can never do here, and how much rope it has.` |
| 5 | `Results` | `/a/:accountId/results` | `How this account actually did.` |
| — (under `more ›`) | `Scan` | `/a/:accountId/scan` | `Research candidates. Read-only — never trades.` |

`more ›` affordance label: `Scan / more ›`. **Novice gating (design principle 10):** first-run users see only `Dashboard`, `Approvals`, and `Guardrails` (the latter tooltip-subtitled `Safety limits` — see §5.0). `Strategy`, `Results`, and `Scan` unlock after the first approved proposal with an unlock toast: `Strategy and Results are now unlocked — you've approved your first trade.`

### 2.2 Assistant overlay

- Rail button label / aria: `Assistant` · trigger hint `⌘K or click to ask`.
- Slide-over header: `Assistant — {alias} · {broker} [{tier badge}]`
- Empty-state prompt: `Ask about this account — “why is this proposal risky?”, “what would loosening my stop do?”, “explain this block.”`
- Routing footer (persistent, below the input): `I route trades to Approvals and config changes to a confirmable diff — I never execute directly.`

### 2.3 Right zone — ambient risk strip

Compact, single line, tooltip on each token:
`used {dailyUsed}/{dailyCap} · net {netExposure}x · {regime}`
Example: `used 2k/10k · net 0.4x · Neutral`

Tooltips:
- `used …` → `Daily order budget used vs your daily notional cap ({field maxDailyNotional}).`
- `net …` → `Net exposure vs your net cap ({field maxNetExposurePct}).`
- `{regime}` → `Current market regime: {regime}. Drives crisis caps if configured.`

### 2.4 Right zone — Run-once button (target-stamped) **[SAFETY-CRITICAL]**

**Format (normative):** `▶ Run once — {alias} · {tier}`
Where `{tier}` is the uppercase tier token only (`TEST` / `PAPER` / `LIVE`), not the full word-class line (keeps the button compact while still naming the money-reality).

| State | Button label | Notes |
|---|---|---|
| Test | `▶ Run once — Test Sim · TEST` | One click, no ritual. |
| Paper | `▶ Run once — Roth IRA · PAPER` | One click, no ritual. |
| Live, armed | `▶ Run once — Robinhood · LIVE` | Button is red-accented; still requires the first-Live-act-of-session re-consent (§6.3) before it fires. |
| Live, not armed | `▶ Run once — Robinhood · LIVE (locked)` + lock glyph | Click opens the Arm-Live ritual (§6.1), does not run. |
| No scope | `▶ Run once` disabled | Tooltip: `Pick an account first.` |

**Acceptance:** the button label always contains the current account alias and the uppercase tier token; it can never read a bare `Run once` when an account is selected (novice #1). The Live tier token is only reachable after the arm ritual; the palette equivalent (§2.7) inherits identical gating.

### 2.5 Right zone — STOP vs Flatten **[SAFETY-CRITICAL]**

Two **separate** controls. STOP is never welded to selling (design §Global frame, novice #5).

**STOP button:**
- Label: `■ STOP`
- Tooltip: `Halts new activity in one click. Always safe — never sells anything you hold.`
- Confirm: **none for single-account STOP** — one click, immediate. (It only stops *new* activity; it is always safe, so no friction.)
- Post-stop state label on the button: `■ STOPPED — resume` (click to resume; resume is a normal confirm, not type-to-confirm).
- Success toast: `Stopped {alias} — no new orders will be placed. Open positions are untouched.`

**Flatten button (separate, secondary):**
- Label: `Flatten / sell positions`
- Tooltip: `Sells your open positions on this account. This places real sell orders.`
- Placement: NOT adjacent to STOP in the panic zone; lives in the account's Dashboard positions area and Guardrails → Autonomy, visually separated.
- Confirm on Practice (Test/Paper): standard confirm dialog (§6.5).
- Confirm on Live: **type-to-confirm** using `FLATTEN_LIVE_PHRASE = "SELL LIVE POSITIONS"` (§6.4).

**Fleet mode** (switcher = All accounts) exposes:
- `STOP all` — tooltip `Halts new activity on every Live and Paper account. Test/sim is excluded.` Confirm: type-to-confirm `FLEET_STOP_PHRASE = "STOP ALL"` (§6.2).
- `Set all close-only` — tooltip `Every Live and Paper account will only close existing positions — no new opens.`
- `Pause autonomy (all)` — tooltip `Drops every account to Propose-only. You'll re-arm each to auto-execute.`

**Halt-state naming across surfaces (design coherence B3)** — one halt state per account, three typed role-labels:
- Chrome actuator: `■ STOP` (this section).
- Guardrails → Autonomy thresholds: `Auto-halt triggers` (§5.5).
- Settings → Admin operator override: `System-wide halt / close-only` (§7.9).

### 2.6 Right zone — remaining verbs

| Glyph | Label / aria | Tooltip |
|---|---|---|
| `🔔` | `Alerts` | `Live alerts stream. History lives in Results → Alert history.` |
| `⌘K` | `Command palette` | `Jump anywhere. Type to search destinations, settings, and fields.` |
| `?` | `Help` | `Overview, Guardrails, Settings Glossary, Tax, Data Sources, MCP.` |
| `⦿` | `Preferences` (avatar) | `Your identity, settings, and account management.` |

**[Locked] The bare noun "Notifications" is retired everywhere.** The `🔔` chrome stream is `Alerts`; Settings has `Alert delivery`; Results has `Alert history` (design coherence B1, novice #4).

### 2.7 Command palette entries (⌘K)

Group headers and representative entries:

- **Go to** — `Go to Dashboard`, `Go to Approvals`, `Go to Strategy`, `Go to Guardrails`, `Go to Results`, `Go to Scan`.
- **Switch account** — `Switch to {alias} · {tier}` (one per account).
- **Run** — `Run once — {alias} · {tier}` **[SAFETY-CRITICAL]**: this entry inherits the exact money-reality gating of the chrome button. A `… · LIVE` palette run entry opens the Arm-Live ritual / first-Live re-consent, never fires directly (design coherence E2). For an unarmed Live account render it as `Run once — {alias} · LIVE (locked)`.
- **Stop** — `STOP {alias}`, and in Fleet context `STOP all accounts`.
- **Open settings** — `Open Settings: {section}` for each Scope-B section (§7).
- **Jump to field** — deep-links, e.g. `Guardrails: Daily-loss stop`, `Strategy: scoring weights`, `Guardrails: Max drawdown`.

---

## 3. Money-reality, authority & halt badge strings (the badge system)

This section is the normative catalog of every badge string. **[SAFETY-CRITICAL]** in full.

### 3.1 Money-reality badges (word-class first)

| Tier | Chip line (Row 2) | Compact badge (`[…]`) | Group header | Color underlay | Word class |
|---|---|---|---|---|---|
| Test | `TEST · practice money` | `[TEST · practice money]` | `SANDBOX — Test / local sim` | grey | `PRACTICE` |
| Paper | `PAPER · practice money` | `[PAPER · practice money]` | `PAPER — practice money` | blue | `PRACTICE` |
| Live | `LIVE · real money` | `[LIVE · real money]` | `LIVE — REAL MONEY` | **red** | `REAL MONEY` |

Rules:
- The word `money` (or the class word `practice` / `real money`) must always be visible; color is decoration, never the sole signal.
- Where horizontal space forbids the full line (e.g. inside a dense table cell), the minimum acceptable form is `TEST` / `PAPER` / `LIVE` **plus** a `practice`/`real` word — never a bare colored tier token alone.

### 3.2 Authority chips

| Value | Chip | Tooltip |
|---|---|---|
| `propose` | `Propose` | `The AI proposes; you approve every trade.` |
| `decide` | `Decide` | `The AI auto-executes within your guardrails. You review after the fact.` |

### 3.3 Approve-button MODE badge (Approvals) **[SAFETY-CRITICAL]**

The money-reality binds to the exact commit action, not just the header:
- Practice: `Approve ▸ PAPER` / `Approve ▸ TEST`
- Live: `Approve ▸ LIVE` (red-accented button)

### 3.4 Viewport hairline

- Practice (Test/Paper): grey hairline, no announcement.
- Live in view: **solid red viewport hairline**, painted the instant a Live account is selected; paired with the §1.4 acknowledgment `You're now acting on REAL MONEY — {alias} · {broker}.`

### 3.5 Halt / brake suffixes (appended to the chip and per-account rows)

Map from `systemState` + vol-panic:

| Condition | Suffix | Full tooltip |
|---|---|---|
| `systemState === "active"`, no brake | *(none)* | — |
| `systemState === "halted"` | `‖ HALTED` | `New activity is stopped. Open positions are untouched.` |
| `systemState === "close_only"` | `● close-only` | `Only closing orders are allowed — no new positions.` |
| `systemState === "liquidating"` | `⌾ liquidating` | `Actively closing positions.` |
| vol-panic brake tripped | `⚠ vol-brake` | `Volatility brake tripped (VIX/VVIX/SKEW threshold). Opening exposure is capped.` |

**Acceptance:** the suffix mapping is exhaustive over the four `SystemState` values plus the brake; no state renders an empty or `undefined` suffix. A `close_only` account never shows `‖ HALTED` and vice-versa.

---

## 4. Confirmation dialogs (full catalog)

Every confirm dialog below names its **trigger**, **type** (plain confirm vs type-to-confirm), the exact **heading / body / consequence preview / buttons**, and the **backing phrase constant** where applicable. Consequence-preview templates are in §8; dialogs reference them.

### 4.0 Dialog anatomy (applies to all)

```
[icon]  {HEADING}
        {BODY — one plain sentence, no jargon}
        {CONSEQUENCE PREVIEW block — §8 template, when a live-money change}
        {TYPE-TO-CONFIRM row, when a one-way door}
        [ {CANCEL LABEL} ]   [ {CONFIRM LABEL} ]
```
Cancel label default: `Cancel`. Never pre-focus the confirm button on a type-to-confirm dialog; focus the input (matches existing `ConfirmationModal` behavior at `app/components/ConfirmationModal.tsx:58`).

---

## 5. Guardrails destination copy (account-scoped)

Backing fields per design Part II-B. Guardrails opens on **5 Essentials**, rest behind one `Advanced ▾` reveal.

### 5.0 Header & Essentials

- Destination header: `Guardrails — {alias} · {broker} [{tier badge}]`
- Novice subtitle (first-run only): `Safety limits`
- Advanced reveal control: `Advanced ▾` / collapsed state `Advanced ▸` · sub-caption `~30 more controls`.
- Essentials section label: `Essentials` · caption `The five that matter most. Everything else is under Advanced.`

**Essentials controls (5) — labels, control types, plain help:**

| # | Label | Control | Backing field | Help text (inline) |
|---|---|---|---|---|
| 1 | `Max position size` | currency input | `maxOrderNotional` (see §5.6 field-ambiguity resolution) | `The most this account can put into one buy order.` |
| 2 | `Daily-loss stop` | currency input | `riskRules.maxDailyLossNotional` | `If this account loses this much in a day, it stops opening new trades.` |
| 3 | `Stop-loss` | toggle + % | `riskRules.stopLossPct` present | `Automatically sell a position if it drops this far.` |
| 4 | `Autonomy` | segmented dial | `strategyAuthority` | `Propose = you approve each trade. Decide = the AI trades within these limits.` |
| 5 | `Extended-hours trading` | toggle | `permitExtendedHours` | `Allow orders outside regular market hours.` |

### 5.6 "Max position size" field-ambiguity — RESOLVED (closes design gap B4)

Design Part III gap #4 flags that "max position size" had no single backing field (position ≠ order). **Resolution for copy + wiring:**

- The **Essentials control labeled `Max position size` binds to `maxOrderNotional`** (per-order dollar cap) — because the Essentials layer is about "the most one action can spend," which a novice reads as position size.
- To avoid the position/order conflation in copy, the Essentials help text says **"one buy order"** explicitly (not "position").
- The true *position* cap (total holding per symbol) lives in Advanced → Exposure as **`Per-symbol cap`** (`maxSymbolExposurePct` / `maxSymbolExposureNotional`), labeled `Most of this account in any one symbol`.
- **Acceptance:** the Essentials `Max position size` control writes `maxOrderNotional` and nothing else; the word "position" never appears in its help text; the per-symbol total-holding cap is only in Exposure. This is the concrete resolution the design demanded ("pick one field or define the derived quantity").

### 5.1–5.5 Advanced groups — section labels & the loosening-confirm triggers

Advanced section labels (verbatim): `Autonomy` · `Sizing` · `Exposure` · `Risk` · `Circuit breakers` · `Execution` · `Learning params` · `Tax rules`.

**Loosening a limit fires a consequence-labeled confirm; tightening is frictionless** (design §"Woven through every control"). The set of fields whose *loosening* triggers a confirm on a Live account:

- Raising any cap: `maxOrderNotional`, `maxOrderPctOfNav`, `maxDailyNotional`, `maxDailyOrders`, `maxGrossExposurePct`, `maxNetExposurePct`, `maxSymbolExposurePct`.
- Weakening protection: turning **off** `stopLossPct`, raising `maxDrawdownPct`, raising `maxDailyLossNotional`, turning **off** `volPanicBrakeEnabled`.
- Enabling risk: `shortSellingEnabled` on → **type-to-confirm** on Live (§6.6).

**Generic loosening-confirm (Live), plain language:**
```
⚠  Loosen a safety limit on REAL MONEY
    You're about to {change}. This gives the AI more room on a real-money account.
    {§8.2 impact-preview: "under this rule, N of your last proposals would now be blocked" — inverted for loosening: "N more would now be allowed"}
    [ Keep current limit ]   [ Loosen it ]
```
On Practice accounts the same edit is a light inline confirm (no red styling): `Loosen {field}? This gives the AI more room. [Cancel] [Loosen]`.

### 5.5 Auto-halt triggers (Circuit breakers subsection)

- Subsection label: `Auto-halt triggers` (this is the "kill-switch thresholds" role from the halt-state model, §2.5).
- Fields: `Max drawdown` (`riskRules.maxDrawdownPct`) help `If the account falls this far from its high point, it goes close-only.`; `Max daily loss` (`riskRules.maxDailyLossNotional`); `Volatility brake` (`volPanicBrakeEnabled`) with VIX/VVIX/SKEW threshold inputs.
- Each breaker card doubles as live status: `Armed` (green) / `Tripped — {reason} at {time}` (red).

### 5.7 Tax rules subsection (with the wash-sale coupling copy) **[SAFETY-CRITICAL for labeling]**

- Subsection label: `Tax rules` · caption `Decision-time tax settings. Your realized tax outcomes live in Results → Tax.`
- `Tax treatment` — select `taxable | roth_ira | traditional_ira`, labels `Taxable` / `Roth IRA` / `Traditional IRA`. Help: `Set by your account type. Changes how the AI weighs gains.`
- `Wash-sale guard` — **NOT labeled as a clean per-account toggle** (design coherence A2, Part II-B note 3). Label: `Wash-sale guard (affects all accounts)`. Help: `Blocks rebuying a stock within 30 days of selling it at a loss — in any of your accounts. One account's loss can lock a symbol everywhere.` Scope tag: `CROSS-ACCOUNT`.
- `Short-term rate` / `Long-term rate` — `taxSettings.shortTermRatePct` / `longTermRatePct`, `%` inputs.
- `Subtract estimated tax from results` — toggle, `taxSettings.subtractFromResults`. Help: `Show Results net of an estimated tax bill.`

---

## 6. The rituals — one-way doors, re-consent, type-to-confirm strings

These are the highest-stakes strings. Each uses a phrase constant from §0. **[SAFETY-CRITICAL]** in full. Server-side validation of the typed phrase is required for the two one-way doors (arm Live, arm Auto-on-Live) — the dialog is not the security boundary; the server write-time check is (design principle 3).

### 6.1 One-way door #1 — Arm Live (`ARM_LIVE_PHRASE = "ARM LIVE"`)

Trigger: user flips an account's money-reality to Live, or first attempts a Live run on an unarmed account.
```
🔴  Arm REAL-MONEY trading — {alias} · {broker}
    From now on, this account can place orders with real money. You can turn this
    off anytime with STOP.
    {§8.1 consequence: "This account holds {equity}. Trades here risk real money."}
    Type  ARM LIVE  to confirm:
    [ ____________ ]
    [ Cancel ]   [ Arm real money ]   ← disabled until input === "ARM LIVE"
```
Confirm-button label: `Arm real money`. On success toast: `{alias} is armed for real money. STOP is always one click away.`

### 6.2 Fleet emergency STOP (`FLEET_STOP_PHRASE = "STOP ALL"`)

```
■  Stop ALL accounts
    This halts new activity on every Live and Paper account. Test/sim is not affected.
    Live accounts, stopped first:
      • Robinhood · Individual  [LIVE · real money]
      • Alpaca · Taxable        [PAPER · practice money]
    Type  STOP ALL  to confirm:
    [ ____________ ]
    [ Cancel ]   [ Stop all accounts ]
```
Per-account confirmed-halted echo (rendered as each halt lands, novice #6): `✓ Stopped — Robinhood · Individual [LIVE]`. Live rows echo first.

### 6.3 First-Live-act-of-session re-consent

Trigger: the first Live approval OR first Live run **of a session** (or after idle timeout), even on an already-armed account (design principle 9). This is a **confirm, not type-to-confirm.**
```
🔴  First real-money action this session
    You're about to act on REAL MONEY — {alias} · {broker}. Being armed once isn't
    consent for unlimited orders.
    {trade context: "BUY NVDA 120 sh (~$14,400)" when approving}
    [ Not now ]   [ Yes, proceed ]
```
For **Adjust-and-approve on Live**, additionally always confirm the final size (§6.7).

### 6.4 Flatten on Live (`FLATTEN_LIVE_PHRASE = "SELL LIVE POSITIONS"`)

```
⚠  Sell all positions — {alias} · {broker} [LIVE · real money]
    This places real sell orders to close every open position on this account.
    STOP does not do this — this is the deliberate sell action.
    {§8.3 positions summary: "12 positions, about $46,900 will be sold at market."}
    Type  SELL LIVE POSITIONS  to confirm:
    [ ____________ ]
    [ Cancel ]   [ Sell all positions ]
```

### 6.5 Flatten on Practice (Test/Paper) — plain confirm

```
Sell all positions — {alias} [PAPER · practice money]
    This closes every open position on this practice account.
    [ Cancel ]   [ Sell all positions ]
```

### 6.6 One-way door #2 — Arm Auto-on-Live (`ARM_AUTO_ON_LIVE_PHRASE = "ARM AUTO ON LIVE"`)

Trigger: setting `strategyAuthority = "decide"` on a Live account (the two dials cross — real money **and** auto-execute).
```
🔴  Let the AI trade REAL MONEY on its own — {alias} · {broker}
    In Decide mode the AI places real orders without asking you first, within your
    guardrails. It reviews go to Approvals as a record, not a question.
    {§8.4 auto-scope: "Within your limits, it can commit up to {maxDailyNotional} of
     real money per day without asking."}
    Type  ARM AUTO ON LIVE  to confirm:
    [ ____________ ]
    [ Cancel ]   [ Arm auto-trading ]
```
On success: `{alias} will now auto-trade real money within your guardrails. Drop to Propose anytime.`

### 6.7 Enable shorting on Live (`ENABLE_SHORTING_PHRASE = "ENABLE SHORTING"`)

```
⚠  Enable short selling — {alias} [LIVE · real money]
    Shorting can lose more than you put in. A hard stop-loss on shorts is required.
    {if riskRules.shortStopLossPct unset: "Set a short stop-loss first — this is mandatory."}
    Type  ENABLE SHORTING  to confirm:
    [ ____________ ]
    [ Cancel ]   [ Enable shorting ]
```
If `shortStopLossPct` is unset, the confirm button is disabled with helper: `Set a short stop-loss to continue.`

### 6.8 Adjust-and-approve size re-confirm (Live)

```
Confirm edited size — {alias} [LIVE · real money]
    You changed this to {qty} sh (~{notional}). It will re-run the full policy check.
    [ Cancel ]   [ Approve ▸ LIVE ]
```
**Acceptance:** an edited quantity always re-runs the full policy gate and, on Live, re-confirms final size (novice #12). It is never a gate bypass.

**Type-to-confirm acceptance criteria (all of §6):** input matched via `.trim().toUpperCase() === PHRASE`; confirm disabled until match; server re-validates the phrase for the two one-way doors before the write commits; Enter-to-confirm only when matched (mirrors `ConfirmationModal.tsx:75`).

---

## 7. Settings tree copy (user-global, off-rail)

Reached from switcher footer / `⦿` avatar. Header: `Settings — all accounts`. Sub: `These apply to every account you connect.` Search bar placeholder: `🔍 Search all settings…`

Section labels + one-line descriptions + notable field copy:

### 7.1 Account & Security
Description: `Your identity, sign-in, and sessions.` · Delete panel button `Delete my account` → type-to-confirm `DELETE MY ACCOUNT` (existing, `ACCOUNT_DELETE_PHRASE`).

### 7.2 Connections
Description: `Connect and disconnect brokers, set each to Test, Paper, or Live.` · Environment select labels: `Test` / `Paper` / `Live` with the §3.1 word-class caption under each. · Capabilities block: `Confirmed by your broker` (read-only).

### 7.3 Keys & Models
Description: `Your AI and market-data keys, and default model settings.` · Sub-item `MCP tools` — description `Connect external tools the AI can use.` · Key rows: `Test connection` button; states `✓ Connected` / `✗ Couldn't connect — check the key`.

### 7.4 Alert delivery
Description: `Where alerts are sent — email, push, SMS, webhook. This is delivery only, not the alerts themselves.` · Disambiguation caption: `The live stream is 🔔 Alerts. The log is Results → Alert history.` · Event routing checklist labels (from `NotificationEventType`): `Order filled` · `Trade blocked` · `Run failed` · `Waiting for approval` · `Kill switch tripped` · `Price alert` · `Proposal withdrawn` · `Limit order went stale` · `Data provider degraded`. · `Send test alert` button.

### 7.5 Data & Privacy
Description: `Which research sources the AI uses, and your data choices.` · Web-source toggles: `Congress trades` · `Insider buying` · `FINRA short interest` · `8-K filings` · `Technicals`. · **The two user-global scan knobs**, relabeled per LOCKED DECISIONS:
- `Scan breadth — candidates per run` (`marketScanCandidateLimit`) · scope tag `ALL ACCOUNTS` · help: `How many candidates each scan considers. Applies to all your accounts — you fund the shared data feed.`
- `Scan breadth — outlier reserve` (`marketScanOutlierReserve`) · scope tag `ALL ACCOUNTS` · help: `Slots reserved for high-variance outliers each scan. Applies to all your accounts.`
- Data-pool consent: `Share anonymized learnings` / `Use shared learnings`.

### 7.6 Presets (library CRUD only)
Description: `Rename, version, delete, and share your presets. You apply them from Strategy.` · Actions: `Rename` · `New version` · `Delete` · `Share`. · Empty state: `No presets yet. Capture one from Strategy → “Capture current as preset.”`

### 7.7 Appearance
Description: `Theme, density, and your default landing account.` · `Theme` · `Density` · `Alerts banner size` (`executionBannerMode`: `Full` / `Compact` / `Hidden`) · `Ticker logos` (`tickerLogoDisplay`: `Tiles` / `Transparent` / `Off`) · `Default landing account` — **[SAFETY-CRITICAL constraint]** select lists **non-Live accounts only** (design P12). Help: `Where you land on load. Live accounts can't be auto-selected, for safety.` If the user has only Live accounts: `No eligible account — Live accounts are never auto-selected. You'll pick an account each time.`

### 7.8 Admin (role-gated)
Description: `Operator tools.` · Sub-items: `User allowlist` · `LLM usage & billing` · `Provider & connection health` · `RAG coverage` · `Transcript` · `System-wide halt / close-only`.

### 7.9 System-wide halt (Admin) **[SAFETY-CRITICAL]**
Label: `System-wide halt / close-only` · Help: `Operator override — halts or close-onlys everything, across all users.` Confirm (type-to-confirm, reuse `STOP ALL`): body `This halts trading system-wide for all users. Type STOP ALL to confirm.`

### 7.10 Scope-A signpost (rendered in Settings, non-editable)
Panel heading: `Looking for strategy or risk settings?` · Body: `Those live with the account. If a setting changes how a trade is decided or placed, it belongs to the account.` · Buttons: `Open Strategy ›` · `Open Guardrails ›`

---

## 8. Consequence-preview & impact templates

Reusable, plain-language, no jargon. Each takes named params; render with `Intl.NumberFormat` (currency, en-US) and integer percents rounded to one decimal.

### 8.1 Per-limit risk preview (woven into every sizing/risk control)
Template: `Risks at most {maxRisk} — about {pctOfEquity}% of this account's equity.`
Example: `Risks at most $1,000 — about 2% of this account's equity.`
Params: `maxRisk` = the field's dollar effect (e.g. `maxOrderNotional`, or `stopLossPct × position`); `pctOfEquity = maxRisk / accountEquity × 100`.
Edge: if equity unknown, degrade to `Risks at most {maxRisk}.` (drop the percent clause; never show `NaN%` or a fabricated equity).

### 8.2 Pre-save impact preview (tightening) **[SAFETY-CRITICAL semantics]**
Template (tightening): `Under this rule, {N} of your last {window} proposals would now be blocked.`
Template (loosening): `Under this rule, {N} more of your last {window} proposals would now be allowed.`
Example: `Under this rule, 3 of your last 20 proposals would now be blocked.`
Edge: `N === 0` → `None of your recent proposals would be affected.` · window default 20; if fewer exist, `your last {actualCount} proposals`.

### 8.3 Flatten positions summary
Template: `{count} positions, about {notional} will be sold at market.`
Example: `12 positions, about $46,900 will be sold at market.`
Edge: `count === 0` → dialog does not open; toast `No open positions to sell.`

### 8.4 Auto-on-Live daily-scope preview
Template: `Within your limits, it can commit up to {maxDailyNotional} of real money per day without asking.`
Edge: if `maxDailyNotional` unset → `Within your limits — set a daily cap in Guardrails to bound this.` (and recommend setting one before arming).

### 8.5 Arm-Live equity context
Template: `This account holds {equity}. Trades here risk real money.`
Edge: equity unknown → `Trades here risk real money.`

**Acceptance for §8:** no template ever renders `undefined`, `NaN`, `$NaN`, or `null%`; every template has a defined degradation path when its input is missing. Percents are computed from real equity, never a placeholder (consistent with CLAUDE.md "never label real data mock/fake, never fabricate numbers").

---

## 9. Preset apply / resync — plain-language sentences (no jargon)

Copy-on-bind, never live-link (design principle 8). The novice path must not use the words "resync / promote / diverged / three-way diff."

### 9.1 Apply a preset (the one plain sentence, novice #9)
On apply, before confirm:
`This copies the settings once. Later changes to the preset won't affect this account, and your changes here won't affect the preset.`
Confirm dialog:
```
Copy “{presetName}” into {alias}?
    {the one sentence above}
    {if account-type guard fires: §9.4 warning}
    [ Cancel ]   [ Copy settings in ]
```
On Live target: adds type-to-confirm (reuse the arm-style friction is NOT needed here; use a plain confirm plus the account-type guard, and a `Approve ▸ LIVE`-styled button `Copy into LIVE account`). Never auto-arms a halted account — success toast: `Copied. {alias} stays {stateWord} — nothing was armed.`

### 9.2 Diverged-from-preset indicator (cockpit, Strategy header)
Novice pill (Essentials): `Changed from preset` (per differing field).
Header summary: `Preset: {presetName} · {N} settings changed here` with actions `See changes` · `Reset to preset` · `Save as new preset`.
(The words "diverged," "three-way," "resync" appear only in the Advanced diff view label `Compare with preset`, never in the novice path.)

### 9.3 Reset-to-preset (pull) & Save-as-new (push)
- `Reset to preset` confirm: `Replace your changes on {alias} with the preset’s values? This changes {N} settings back.` · buttons `Cancel` / `Reset to preset`.
- `Save as new preset`: input `Name this preset` · button `Save preset` · success `Saved “{name}” to your library.`

### 9.4 Account-type guard (short/margin preset onto IRA)
Block (hard): `“{presetName}” uses short selling, which isn’t allowed in a {accountType}. Remove shorting or pick another preset.` · single button `OK`.
Warn (soft, where broker permits but risky): `“{presetName}” uses margin. {alias} may not support it — some settings may not apply.` · buttons `Cancel` / `Copy anyway`.

### 9.5 Per-field resync-loosens-Live confirm (design principle 8)
When a resync/reset would *loosen* a Live-account limit, each such field inherits the §5 loosening-confirm (no bulk bypass):
`Resetting {field} to the preset would loosen a limit on REAL MONEY. Confirm this one?` · buttons `Skip this field` / `Loosen it`.

---

## 10. Empty-state & zero-account copy

| Surface | State | Copy |
|---|---|---|
| App (zero accounts) | first-run | Heading `Connect your first account` · Sub `Start with Test — no real money, no broker login.` · CTA `Start in Test mode` · link `Connect a broker instead` |
| Dashboard | Test auto-provisioned, no runs | `Nothing's run yet. Hit “Run once — Test Sim · TEST” to see the AI propose trades — safely, with fake money.` |
| Approvals | empty queue, Propose | `Nothing to approve right now. When the AI finds a trade, it'll ask you here.` |
| Approvals | empty, Decide | `Nothing pending. In Decide mode, auto-executed trades show here as a record.` |
| Scan | no candidates | `No candidates surfaced this run. Try widening your universe in Strategy → Signals.` |
| Strategy | no preset bound | `No preset applied. Start from a preset or write your own thesis below.` |
| Results | no closed trades | `No results yet — this account hasn't closed any trades. Come back after a few fills.` |
| Results → Alert history | empty | `No alerts yet. When something happens, it'll be logged here.` |
| Guardrails | fresh account | `Your safety limits are set to safe defaults. Review the five Essentials before you arm anything.` |
| Fleet | single account | *(Fleet suppressed entirely — never shown to single-account users, P11.)* |
| Presets (Settings) | empty library | `No presets yet. Capture one from Strategy → “Capture current as preset.”` |

**Autonomy-reset-on-restart notice** (net-new, design principle 9 + Open Q2 — build regardless): on the first load after a process restart, any account previously in `decide` shows a Dashboard banner:
`Autonomy was reset to Propose after a restart — for safety. Re-arm {alias} to let it trade on its own again.` · button `Re-arm autonomy ›` (routes to Guardrails → Autonomy; Live re-arm re-runs §6.6).

---

## 11. Help — "Settings Glossary" old→new mapping (rewrite in the same PR as the `openSettings` moves)

Rendered under `? Help → Settings Glossary`. Purpose: a returning user who knew the old names can find the new home. Each row: **old name → new home → one-line what-changed.** (Design merge requirement: update in lockstep with the 6 `openSettings` rewrites at `dashboard-client.tsx:1514, 1555, 1562, 1583, 1709, 1818`.)

| You used to call it… | It's now… | What changed |
|---|---|---|
| Strategy Profile | **Preset** | Same thing, clearer name. A reusable, copyable template of strategy settings. |
| Strategy (Settings section) | **Strategy** (destination) | The read-only mirror is gone. Strategy is now one editable home on the top nav. |
| Strategy Studio | **Strategy** (destination) | The pop-up editor was folded inline into the Strategy destination. |
| Operate | **Guardrails → Execution / Autonomy** (+ some to **Strategy → Signals**) | The vague "Operate" section was dissolved. Order types, hours, cadence → Guardrails; universe/scan → Strategy. |
| Safety | **Guardrails → Risk** | Renamed. Stops, take-profit, and trailing live here; the five most-used surface as Essentials. |
| Tuning | **Results → Tuning** (queue) + **Guardrails → Learning params** | The AI's proposed changes are reviewed in Results; the learning knobs live in Guardrails. |
| Tax (tab / section) | **Results → Tax** (outcomes) + **Guardrails → Tax rules** (rules) | Split by intent: your realized tax outcomes vs the decision-time tax rules. |
| Review (destination) | **Results** | Renamed. "Review" is now a verb for approving and tuning, not a place. |
| Notifications (feed tab) | **Results → Alert history** | The alerts log moved under Results. |
| Notifications (Settings section) | **Settings → Alert delivery** | Renamed. This is delivery rules only (channels/routing). |
| Notifications (the dropdown) | **🔔 Alerts** | The live stream is now called Alerts. |
| Display | **Settings → Appearance** | Renamed. Adds "default landing account" (non-Live only). |
| Data | **Settings → Data & Privacy** | Renamed. Houses web-source toggles and the two scan-breadth knobs (which apply to all accounts). |
| Halt & Flatten | **STOP** (+ a separate **Flatten**) | STOP halts new activity in one click and never sells. Selling is a separate, deliberate action. |
| Connections | **Settings → Connections** (+ **Keys & Models**) | Keys split into their own section; broker links stay in Connections. |
| /admin/* (four pages) | **Settings → Admin** | The four admin pages consolidated into one role-gated section. |
| /strategy (public page) | **/how-it-works** | The marketing explainer was renamed; it's linked from the editor footer and Help. |

Glossary footer line: `Rule of thumb: if a setting changes how a trade is decided or placed, it lives with the account (Strategy or Guardrails). Everything else is in Settings.`

---

## 12. Deferred-but-specified: Mobile/PWA parity copy

Full account-scope parity is **specified now**, implementation later (LOCKED DECISIONS, design coherence E1). The mobile chrome must carry the switcher + STOP with identical word-class strings:
- Mobile account chip: same `{alias} · {broker}` + `{MONEY_CLASS.line}` as §1.1 (word-class required; no color-only).
- Mobile STOP: `■ STOP` with the same one-click-never-sells semantics; Flatten remains a separate, deeper action.
- Mobile Live acknowledgment: same §1.4 `You're now acting on REAL MONEY` string.
- **[SAFETY-CRITICAL wiring note for copy consumers]** the mobile setter path (`src/lib/mobile-api.ts:648-651`, `setActiveConnectedAccount`) must switch **view-scope**, not the execution singleton, once P2 lands — otherwise mobile becomes the side-door that re-introduces the not-active→halted coercion (design Part III gap #3). Copy assumes view-scope switching; do not ship mobile switching copy against the pre-P2 singleton without the §1.4 "switching may pause the previously-active account" warning variant: `Switching may pause {previousAlias}. Continue?`

---

## 13. Consolidated acceptance criteria (copy-level merge gates)

1. Grep gate: literals `"Notifications"`, `"Halt & Flatten"`, `"Strategy Profile"`, and destination-label `"Review"` appear **only** in redirect-alias maps and the glossary old→new table — nowhere as a live label.
2. Every type-to-confirm dialog imports its phrase from §0 constants; the server-side validator for `ARM LIVE` and `ARM AUTO ON LIVE` imports the **same** constant (no drift).
3. Every money-reality surface (chip, dropdown rows, Approve button, Run-once button, badges) renders a **word** (`PRACTICE`/`REAL MONEY` or `practice`/`real money`), never color alone. Automated check: snapshot each badge with color stripped and assert the tier word is present.
4. Run-once button label always contains `{alias}` + uppercase tier token; never a bare `Run once` with an account selected.
5. `Max position size` Essentials help text does not contain the word "position" as the backing quantity (§5.6) and writes `maxOrderNotional`.
6. `Wash-sale guard` label always carries the `(affects all accounts)` / `CROSS-ACCOUNT` framing; it is never rendered as a plain per-account toggle.
7. Default landing account select excludes Live accounts (P12); no Live account string can appear as an option.
8. Every §8 consequence template has a missing-input degradation path; no template can render `NaN`/`undefined`/`$NaN`.
9. Help "Settings Glossary" old→new table is updated in the same PR as any `openSettings` relocation (design merge requirement).
10. The preset-apply plain sentence (§9.1) appears verbatim on every apply path (account context) and contains none of: "resync", "promote", "diverged", "three-way".

---

*This deck is organized by surface and cross-references [`docs/settings-navigation-redesign.md`](../settings-navigation-redesign.md) for the design rationale; it does not restate the design. Every phrase constant is defined once (§0) so client dialogs and server-side validators share one source of truth. Recommended homes: `src/lib/copy/nav-v2-copy.ts` (badge/word-class/label strings), `src/lib/copy/confirm-phrases.ts` (type-to-confirm constants). Existing conventions honored: `ConfirmationModal` type-to-confirm behavior (`app/components/ConfirmationModal.tsx`), `ACCOUNT_DELETE_PHRASE` (`src/lib/account-deletion.ts:5`).*
