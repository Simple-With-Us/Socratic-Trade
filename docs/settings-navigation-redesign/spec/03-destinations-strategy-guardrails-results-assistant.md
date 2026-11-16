# STRATEGY · GUARDRAILS · RESULTS · ASSISTANT — Destination Build Specification (v1)

**Scope owner:** DESTINATION spec author for the four account-scoped/overlay surfaces.
**Companion doc (canonical, do not restate):** `docs/settings-navigation-redesign.md` (v2). This spec goes deep on the four destinations and the field wiring; the IA frame, multi-account model, switcher, and phased plan live there and are referenced, not repeated.
**Grounding source of truth for fields:** `src/lib/types.ts` (`TradingPolicy` + nested types), `src/lib/defaults.ts` (`DEFAULT_POLICY`, `DEFAULT_SCORING_WEIGHTS`), `src/lib/db-profiles.ts:20-24` (`USER_LEVEL_POLICY_FIELDS`), `src/lib/tax.ts:99/108` (wash-sale), `src/lib/policy.ts:311-321` (wash-sale enforcement).
**Feature flag:** all rendering behind `NAV_V2`; Strategy consolidation additionally behind `STRATEGY_CONSOLIDATION` (per companion §II-D Phase 4).

Conventions used throughout:
- `[ACCOUNT]` = per `connectedAccountId`, stored in `account_strategy_state`.
- `[USER]` = one of the three `USER_LEVEL_POLICY_FIELDS`, stored in `user_settings.policy`.
- `[COUPLING]` = cross-account tax coupling (wash-sale) — physically in an account's Guardrails but consequences span accounts.
- **Field name in `code font`** = the exact `TradingPolicy` dotted path an implementer wires the control to. Every control below names its field so there is no ambiguity about the backing store.
- **Consequence preview** = the live plain-English line the companion requires on every control (`docs/settings-navigation-redesign.md` §"Woven through every control").

---

## 0. Shared machinery all four destinations depend on

These are specified once here because Strategy, Guardrails, and Results all consume them.

### 0.1 The account-scoped destination header (`<ScopedDestinationHeader>`)

Every account-scoped destination (Strategy, Guardrails, Results — **not** the Assistant overlay, which is scopeless-chrome) renders an identical stamped header band at the top of its panel. New component: `app/ui/scoped-destination-header.tsx`.

Layout (single row, left-to-right):
```
<DestinationName> — <accountAlias> · <broker>   [ MODE badge ]   [ preset provenance chip ]        [ Advanced ⌄ ] (Guardrails only)
```
- **`<DestinationName>`** — literal "Strategy", "Guardrails", "Results".
- **`<accountAlias> · <broker>`** — from `ConnectedAccount.label` + `ConnectedAccount.broker`. Reads the active view-scope account (post-P2: view-scope, not the execution singleton — see companion §Design principle 2).
- **MODE badge** — word-class first per companion Design principle 5: `PAPER · practice` (grey/blue) / `LIVE · real money` (red) / `TEST` (grey). Derived from `ConnectedAccount.environment` + `broker === "test"`. Never color-only.
- **Preset provenance chip** — `Preset: <name> · diverged: N fields` when `policy.activeProfileId` is set and the account has diverged from its `derived_from_profile_id` snapshot; `Preset: none` otherwise. Clicking opens the three-way diff (§1.3).
- **States:** `loading` (skeleton band), `unresolved-scope` (companion "Pick an account to continue →" — header shows the neutral prompt, body greyed), `live` (red viewport hairline active), `single-account` (alias chip is static text, no dropdown affordance — companion P11).

**Acceptance:** the header string is present and correct on every render of all three destinations; a Playwright/RTL assertion that switching the active account re-stamps the alias + MODE badge in place without a route change.

### 0.2 Consequence-preview engine (`useConsequencePreview`)

New hook `app/ui/use-consequence-preview.ts`. Given a `field`, a `pendingValue`, and the resolved `snapshot` (account equity/NAV, recent proposals), returns a plain-English string. Used by Guardrails and Strategy min-score. Two flavors:
- **Static** — e.g. max-position-size: `"risks at most $1,000 — about 2% of this account's equity"` (uses live equity from the account snapshot).
- **Retrospective** — on any live-money-affecting change: `"under this rule, N of your last M proposals would now be blocked"` (companion "pre-save impact preview"). Backed by a new read-only endpoint `GET /api/accounts/:accountId/impact-preview?field=…&value=…` that replays the last M proposals through the single policy engine (`src/lib/policy.ts`) with the pending value. **Never mutates.**

**Acceptance:** loosening a limit shows the preview but no confirm; tightening a Live cap / disabling a stop / enabling shorting / flipping to Live-or-Decide shows the preview **and** an inline consequence-labeled confirm (type-to-confirm for the two one-way doors, per companion P9).

### 0.3 Origin badge + scope tag (`<OriginBadge>` / `<ScopeTag>`)

- **`<ScopeTag>`** — `THIS ACCOUNT` / `ALL ACCOUNTS` / `PRESET` / `CROSS-ACCOUNT` per companion §Multi-account mechanism 4. Rendered on section headers, always visible.
- **`<OriginBadge>`** — the four-glyph taxonomy (`● account · ↳ from preset · ⊘ locked by account type · ▫ your global default`). **Advanced-only** (companion novice #8). On the Essentials view, a differing field shows only a plain **"Changed from preset"** text pill.

Both are suppressed entirely for single-account users until a 2nd account connects (companion P11).

---

# 1. STRATEGY — the one editable home (destination #4)

**Route/panel:** the Strategy destination (companion §Strategy consolidated). Account-scoped. Replaces the Strategy workspace tab, deletes the Strategy Studio modal (contents inline), and collapses the duplicated `TuningCard` (`app/dashboard-client.tsx:3725` + `:4441`) to one instance (companion §II-D Phase 4).

**Reference wireframe:** companion Screen 3.

## 1.0 Panel layout (top to bottom)

```
┌ <ScopedDestinationHeader: Strategy>  Preset: Momentum-v3 · diverged: 6  [diff][reset][save as new] ┐
├ PRESETS BAR  [ Start from preset… ] [ Capture current as preset… ] [ Copy to accounts… ]           │
├ THESIS         prompt · thesis language · holding horizon                                          │
├ SIGNALS        8 weights (default|current|auto-tuned + let-AI-tune) · min-score · universe/floors   │
├ AI REVIEW      Bull model · Red-Team model + conviction · reasoning effort                          │
└ ⓘ Autonomy lives in GUARDRAILS →                                                                    │
```

An optional **full-screen mode** toggle (companion: "preserves the distraction-free feel" of the deleted Studio modal) — a `?strategyFocus=1` view-state that hides the global chrome center-spine but keeps the LEFT switcher + RIGHT STOP (never hide the kill switch).

## 1.1 Presets bar (three explicit verbs — no ambient mirror)

Rendered directly under the header. Three buttons; **each is an explicit user action re-entering the deterministic gates** — the ambient `mirrorPolicyToActiveAccount` (`db-profiles.ts:486/512/531`) is deleted (companion Design principle 7), so a preset edit can never silently reach this account.

| Control | Type | Action | Backing |
|---|---|---|---|
| **Start from preset…** | button → picker modal | `applyProfileToAccount(profileId, accountId)` — **copy-on-bind**: snapshots `policy + prompt + scoringWeights` into `account_strategy_state`, stamps `derived_from_profile_id`. Diff-and-confirm always. | `strategy_profiles` → account state |
| **Capture current as preset…** | button → name modal | Snapshots the account's current `policy + prompt + scoringWeights` into a **new** `strategy_profiles` row. No auto-activate. | account state → `strategy_profiles` |
| **Copy to accounts…** | button → multi-select modal | `applyProfileToAccount` fan-out to N chosen accounts. Says "this will touch N accounts" before commit (companion mechanism 4). | account state → N accounts |

**Copy-on-bind apply rules (companion §Presets):**
- **Plain sentence at apply time (novice path):** *"This copies the settings once. Later changes to the preset won't affect this account, and your changes here won't affect the preset."* No "resync/promote/diverged" jargon in the novice path.
- **Account-type guard:** block or hard-warn applying a preset that enables short-selling (`policy.shortSellingEnabled`) or margin onto an IRA — gated on `ConnectedAccount.capabilities.accountType` / `capabilities.shortSelling`. IRA (`roth_ira`/`traditional_ira`) → block.
- **Live target:** type-to-confirm.
- **Never auto-arms a halted account** — apply leaves `systemState` untouched.

## 1.2 Section — THESIS

| # | Label | Control | Field `[scope]` | Default | Notes |
|---|---|---|---|---|---|
| T1 | Strategy prompt | multiline textarea | `strategyPrompt` (stored via `setStrategyPrompt`) `[ACCOUNT]` | `DEFAULT_STRATEGY_PROMPT` | The LLM instruction text. Full-screen mode expands this. |
| T2 | Thesis language | text/textarea | `strategyPrompt` sub-field (same store; UI affordance only) `[ACCOUNT]` | — | Companion lists as separate label; wire to the same prompt store unless a dedicated field is added. |
| T3 | Holding horizon | segmented select | `holdingHorizon` `[ACCOUNT]` | `"swing"` | Options `intraday \| swing \| position \| longterm`. Label swing as "swing 2–10d" etc. per wireframe. |

## 1.3 Section — SIGNALS (the 8 weights + universe)

**The 8 scoring-weight rows.** Use the **exact 8 names from `ScoringWeights`** (`src/lib/types.ts`), in this display order (grounding order), each a three-column row + a toggle:

```
<name>   default <D> │ current ▓▓▓░ <C> │ auto-tuned <A>   [ let the AI tune this ☑/☐ ]   [pill: Changed from preset]
```

| Row | `scoringWeights.<field>` | Default (`DEFAULT_SCORING_WEIGHTS`) | Tooltip (grounding) |
|---|---|---|---|
| Liquidity | `scoringWeights.liquidity` | 1.4 | Volume / bid-ask spread |
| Momentum | `scoringWeights.momentum` | 1.2 | Intraday & technical trend |
| Value | `scoringWeights.value` | 0.8 | P/E, dividend yield, PEG |
| Quality | `scoringWeights.quality` | 0.8 | Debt/equity, earnings stability |
| Volatility | `scoringWeights.volatility` | 0.8 | Beta, ATR, Sharpe-like |
| Sentiment | `scoringWeights.sentiment` | 0.6 | News sentiment, analyst ratings |
| Positioning | `scoringWeights.positioning` | 0.8 | Congress trades, insider buying, short squeezes |
| Diversification | `scoringWeights.diversification` | 1.0 | Sector/correlation diversity bonus |

Per-row control spec:
- **default `<D>`** — read-only, from `DEFAULT_SCORING_WEIGHTS`. Immutable reference.
- **current `<C>`** — the editable slider/number, bound to `scoringWeights.<field>`. Clamped non-negative (matches `normalizeScoringWeights`, `db-profiles.ts:150`).
- **auto-tuned `<A>`** — read-only, the auto-tuner's proposed value; renders `—` when none. Sourced from the Results→Tuning queue's latest proposal for this weight.
- **let the AI tune this** — a per-weight boolean. **This is net-new state** — there is no per-weight opt-in flag in `TuningSettings` today. Add `tuning.letAiTuneWeights?: Partial<Record<keyof ScoringWeights, boolean>>` to `TuningSettings` (`src/lib/types.ts`) `[ACCOUNT]`, default all `true` when `tuning` is set. Wire the auto-tuner (`src/lib/*` tuner) to skip weights whose flag is `false`. **Acceptance:** a weight with `let-AI-tune = ☐` is never mutated by an applied Tuning proposal (round-trip test).
- **"Changed from preset" pill** — shows when `current` differs from the bound preset snapshot; Advanced view swaps it for the full `<OriginBadge>`.

**Sub-controls under the weights:**

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| S1 | Min proposal score | number (0–100) + consequence preview | `tuning.minProposalScoreThreshold` `[ACCOUNT]` | 0 |
| S2 | Base indexes / universe | multi-select chips | `includedIndices` `[ACCOUNT]` | `["sp500"]` (options: sp100, sp500, nasdaq100, nasdaqComposite, dow30, russell2000, nyseComposite, ftWilshire5000) |
| S3 | Additional watchlist | tag input | `additionalSymbols` `[ACCOUNT]` | `[]` |
| S4 | Ignore / blocklist | tag input | `blocklist` `[ACCOUNT]` | `undefined` |
| S5 | Universe floor — min share price | number | `universeFloor.minPrice` `[ACCOUNT]` | 5 |
| S6 | Universe floor — min market cap | number ($) | `universeFloor.minMarketCapUsd` `[ACCOUNT]` | 100,000,000 |
| S7 | Universe floor — min $-volume | number | `universeFloor.minDollarVolume` `[ACCOUNT]` | 1,000,000 |

> **User-global note (companion §Multi-account edge #6, LOCKED):** the Market Scan **candidate limit** (`marketScanCandidateLimit`) and **outlier reserve** (`marketScanOutlierReserve`) are **NOT** here — they are `[USER]` and live in **Settings → Data & Privacy**, relabeled *"applies to all your accounts."* Rationale stamped in the companion: the user funds the shared keys/data feeding scans. If a Strategy user hunts for "how many candidates does the scan pull," Signals shows a one-line pointer chip: *"Scan breadth (candidate limit, outlier reserve) applies to all your accounts → Settings › Data & Privacy."* Do not duplicate the control here (avoids the silent write-to-wrong-store trap).

## 1.4 Section — AI REVIEW (overrides global default)

Header carries a scope note: *"Overrides your global default model (Settings › Keys & Models)."*

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| R1 | Bull model | model select | `llmModel` `[ACCOUNT]` | `"gpt-5.4-mini"` (falls back to global default) |
| R2 | Red-Team model | model select | `redTeamLlmModel` `[ACCOUNT]` | `undefined` → reuses `llmModel` when unset (show placeholder "same as Bull model") |
| R3 | Red-Team conviction threshold | number (0–100) | `tuning.redTeamConvictionThreshold` `[ACCOUNT]` | 80 |
| R4 | Reasoning effort | segmented `low\|medium\|high` | `llmReasoningEffort` `[ACCOUNT]` | `"medium"` |

## 1.5 Autonomy pointer (mandatory, non-editable here)

Bottom of panel, a static info strip: **`ⓘ Autonomy (Propose ↔ Decide) is NOT here — it lives in GUARDRAILS, next to the breakers that bound it. [ go › ]`** The `go ›` navigates to Guardrails → Autonomy (Advanced). Enforces companion Design principle 6 (brain ≠ fence). **No `strategyAuthority` control renders in Strategy.**

## 1.6 The TuningCard merge (highest-risk — build gate)

Per companion §II-D Phase 4 & §Strategy consolidated. The two render sites (`app/dashboard-client.tsx:3725`, `:4441`), both consuming `strategyTuning` state + `snapshot.strategyPrompt`, collapse to **one** instance rendered inside SIGNALS (the auto-tuned column + Tuning-apply affordance).
- **Precondition assertion:** verify both former parents pass an identical `snapshot` prop before deleting either (post-merge risk = a patch computed against a stale baseline).
- **Exit criteria (named):** (a) apply/discard round-trip test — generate review → apply → assert the `strategyTuning` patch diffs against the **live** prompt, not stale text; (b) localStorage-compat check on `STRATEGY_TUNING_STORAGE_KEY` (`app/dashboard-client.tsx:199`).
- **Rollback:** both sites coexist behind `STRATEGY_CONSOLIDATION` for one release; a bad merge is a flag flip.

## 1.7 Strategy states

- **loading / unresolved-scope / live** — from `<ScopedDestinationHeader>` §0.1.
- **preset-diverged** — provenance chip shows `diverged: N`; `[diff]` opens the three-way diff (base snapshot → preset-now vs base snapshot → account-now, companion P8), `[reset]` = pull preset values (per-field confirm on any field that loosens a Live limit), `[save as new]` = push to a new preset.
- **read-only (Decide-armed on Live during a run)** — edits queue as a confirmable diff via the Assistant/config path, never hot-applied mid-run.

---

# 2. GUARDRAILS — the fence (destination #5)

**Route/panel:** the Guardrails destination. Account-scoped. **Opens on 5 Essentials; the ~30 remaining controls fold behind one "Advanced" reveal** (companion §II-B, Design principle 10). Consolidates the former Settings→Safety, →Operate (execution/autonomy parts), →Tuning (learning params), and →Tax (rules) sections. Each Circuit-breaker card **doubles as live armed/tripped status**.

**Reference wireframe:** companion Screen 3 pointer + §II-B tree lines 451–535.

## 2.0 Layout

```
┌ <ScopedDestinationHeader: Guardrails>                                     [ Advanced ⌄ ] ┐
├ ESSENTIALS (5)  max position size · daily-loss stop · stop-loss on/off · autonomy · ext-hrs │
├ ── Advanced ─────────────────────────────────────────────────────────────────────────────┤
│  Autonomy · Sizing · Exposure · Risk · Circuit breakers · Execution · Learning params · Tax RULES │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2.1 ESSENTIALS (the 5, always visible)

Each Essentials control carries a live **consequence preview** (§0.2).

| # | Essentials label | Control | Backing field `[scope]` | Default | Consequence preview |
|---|---|---|---|---|---|
| E1 | **Max position size** | number ($) | `maxOrderNotional` `[ACCOUNT]` | `undefined` | "each order risks at most $X — Y% of equity" |
| E2 | **Daily-loss stop** | number ($) | `riskRules.maxDailyLossNotional` `[ACCOUNT]` | `undefined` | "trips to close-only after $X lost in a day" |
| E3 | **Stop-loss on/off** | toggle → reveals % | presence of `riskRules.stopLossPct` `[ACCOUNT]` | on (8%) | "exits a position down X%" |
| E4 | **Autonomy dial** | Propose ↔ Decide | `strategyAuthority` `[ACCOUNT]` | `"propose"` | "AI proposes; you approve every trade" / "AI auto-executes" |
| E5 | **Extended-hours on/off** | toggle | `permitExtendedHours` `[ACCOUNT]` | `false` | "may place orders outside 9:30–16:00 ET" |

> **RESOLVED GAP — "max position size" field ambiguity (companion Part III §B4).** The novice-facing **"Max position size"** Essentials control binds to **`maxOrderNotional`** (a single-order cap), **not** a total-holding cap. Rationale: it is the field the policy engine enforces per order and the one a novice most needs; a true per-position (total holding) cap is a separate power-user control living in Exposure as `maxSymbolExposurePct` / `maxSymbolExposureNotional`. **Essentials E1 label reads "Max order size" in the tooltip/help** to remove the position-vs-order confusion, while the friendly headline stays "Max position size." Acceptance: E1 mutations write **only** `maxOrderNotional`; a test asserts `maxSymbolExposure*` is untouched by E1.

E4 (Autonomy) and any tightening/loosening of E1/E2/E3 that affects Live triggers the §0.2 confirm; **flipping to Decide is a one-way-door type-to-confirm** (companion P9).

## 2.2 ADVANCED — Autonomy

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| A1 | Propose ↔ Decide | dial (same as E4) | `strategyAuthority` | `"propose"` |
| A2 | System state | select `active\|halted\|close_only\|liquidating` | `systemState` `[ACCOUNT]` | `"halted"` |
| A3 | Kill-switch / auto-trip thresholds | pointer → Circuit breakers | (see §2.6) | — |

> **NET-NEW — Autonomy-reset-on-restart (LOCKED DECISION, REQUIRED, DEFAULT ON).** On app/process restart, **every account's `strategyAuthority` drops to its safe floor (`"propose"`) until the user re-arms.** Design of the persistence + reset mechanism (net-new — build regardless of whether an equivalent exists):
> - **Schema anchor:** add two columns to `account_strategy_state` (migration in `src/lib/db.ts` `migrate()`, CRUD in `src/lib/db-execution.ts` per CLAUDE.md split rule): `armed_authority TEXT` (the user-armed value, e.g. `"decide"`) and `armed_at TEXT` (ISO). The **effective** authority at read time = `armed_authority` **iff** `armed_at` is within the current process epoch, else the safe floor `"propose"`.
> - **Process epoch:** a module-level `PROCESS_BOOT_ID` (uuid generated once at server start) persisted to a `runtime_state` singleton row on boot; on read, if `account_strategy_state.armed_boot_id != runtime_state.boot_id`, authority resolves to `"propose"` and a re-arm is required. This makes the reset survive both process restart and DB-restore.
> - **Re-arm ritual:** the Autonomy dial's "arm Decide" writes `armed_authority="decide"`, `armed_boot_id=<current>`, `armed_at=now` — behind the one-way-door type-to-confirm.
> - **UI:** after a restart, the dial shows `Propose (auto-reset on restart — re-arm to Decide)`; the chrome authority chip shows `Propose` regardless of the pre-restart value.
> - **Acceptance:** a test that arms Decide, simulates a boot-id change, and asserts effective authority reads back `"propose"`; and that the chrome + Guardrails both reflect it.

## 2.3 ADVANCED — Sizing

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| Sz1 | Max order notional | number ($) | `maxOrderNotional` | `undefined` |
| Sz2 | Max order % NAV | number (%) | `maxOrderPctOfNav` | 5 |
| Sz3 | Max order % of ADV | number (%) | `maxOrderPctOfAdv` | 5 |
| Sz4 | Max daily notional | number ($) | `maxDailyNotional` | 500 |
| Sz5 | Max daily % NAV | number (%) | `maxDailyPctOfNav` | `undefined` |
| Sz6 | Max hourly notional | number ($) | `maxHourlyNotional` | `undefined` |
| Sz7 | Max daily orders | number | `maxDailyOrders` | 10 |
| Sz8 | Max proposals per run | number | `maxProposalsPerRun` | 3 |
| Sz9 | Sell-to-fund-buys | select `off\|suggest\|propose\|automated` | `sellToFundBuy` | `"off"` |

## 2.4 ADVANCED — Exposure

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| Ex1 | Per-symbol cap % | number (%) | `maxSymbolExposurePct` | 25 |
| Ex2 | Per-symbol cap $ | number ($) | `maxSymbolExposureNotional` | `undefined` |
| Ex3 | Per-sector caps | key→% map editor | `sectorCaps` | `{}` |
| Ex4 | Max gross exposure % | number (%) | `maxGrossExposurePct` | 80 |
| Ex5 | Max net exposure % | number (%) | `maxNetExposurePct` | 80 |
| Ex6 | Max portfolio beta | number | `maxPortfolioBeta` | `undefined` |
| Ex7 | Max avg correlation | number | `maxAvgCorrelation` | `undefined` |

## 2.5 ADVANCED — Risk (stops & exits)

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| Rk1 | Stop-loss % | number (%) | `riskRules.stopLossPct` | 8 |
| Rk2 | Stop-loss $ | number ($) | `riskRules.stopLossNotional` | `undefined` |
| Rk3 | Take-profit % | number (%) | `riskRules.takeProfitPct` | 20 |
| Rk4 | Take-profit trim % | number (1–100) | `riskRules.takeProfitTrimPct` | 50 |
| Rk5 | Take-profit $ | number ($) | `riskRules.takeProfitNotional` | `undefined` |
| Rk6 | Trailing stop % | number (%) | `riskRules.trailingStopPct` | 0 |
| Rk7 | ATR stops toggle | toggle | `atrStops` | `undefined` |
| Rk8 | ATR period | number (bars) | `riskRules.atrStopPeriod` | `undefined` (14) |
| Rk9 | ATR multiple | number | `riskRules.atrStopMultiple` | `undefined` (2.0) |
| Rk10 | Beta-scaled stops | toggle | `betaScaledStops` | `undefined` |
| Rk11 | Broker-held brackets | toggle | `brokerBracketsEnabled` | `true` |
| Rk12 | Robinhood broker stops | toggle | `robinhoodBrokerStops` | `false` |
| Rk13 | **Enable short selling** | toggle (capability-gated) | `shortSellingEnabled` | `undefined` | 
| Rk14 | **Short stop-loss %** | number (%) — **mandatory when Rk13 on** | `riskRules.shortStopLossPct` | `8` |
| Rk15 | Max short order $ | number ($) | `maxShortOrderNotional` | `undefined` |
| Rk16 | Max short exposure % | number (%) | `maxShortExposurePct` | `undefined` |

**Coupling rule:** Rk14 is pre-filled at its 8% default, so enabling Rk13 is not blocked out of the box. Blanking the field is **not** a way to re-arm the mandatory-stop rejection: `PUT /api/policy` strips a cleared (`null`) `riskRules.shortStopLossPct` back to an absent key before saving (`stripNullsDeep`), and `setPolicy` re-merges through `mergePolicy`'s `{...DEFAULT_POLICY.riskRules, ...policy.riskRules}`, which silently restores the 8% default for an absent key — the guard (`policy.riskRules.shortStopLossPct <= 0` in `src/lib/policy.ts`) never fires. The only reachable way to re-arm the rejection is setting `shortStopLossPct` to **0 or a negative number** (a real, non-null value survives `stripNullsDeep` and overrides the default); block save if the user sets it to <= 0 while Rk13 is on. Rk13 is **greyed with an inline explainer when `ConnectedAccount.capabilities.shortSelling === false`** or the account is an IRA (capability-aware disabling, companion §"Woven through every control"). Enabling short selling is a §0.2 confirm.

## 2.6 ADVANCED — Circuit breakers (cards double as armed/tripped status)

Each row renders as a **status card**: label + threshold control + a live badge `● armed` / `⚠ TRIPPED (since HH:MM)` / `○ disabled`. Tripped state is read from the account's live runtime, not just config.

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| Cb1 | Max drawdown % | number (%) | `riskRules.maxDrawdownPct` | `undefined` (triggers close_only when set + breached) |
| Cb2 | Max daily loss $ | number ($) | `riskRules.maxDailyLossNotional` | `undefined` |
| Cb3 | Vol-panic brake | toggle | `volPanicBrakeEnabled` | `true` |
| Cb4 | VIX threshold | number | `volPanicVixThreshold` | 40 |
| Cb5 | VVIX threshold | number | `volPanicVvixThreshold` | 150 |
| Cb6 | SKEW threshold | number | `volPanicSkewThreshold` | 160 |
| Cb7 | Crisis open cap % NAV | number (%) | `tuning.crisisMaxOpeningExposurePct` | `undefined` (disabled) |

**Halt-state model (companion coherence B3):** these cards hold **auto-trip thresholds** only. The one-click chrome **■ STOP** actuator and the Settings→Admin operator override are *different roles* on the **one** halt state per account — do not fork `systemState` across surfaces. A tripped Cb card links to Dashboard/Fleet which answers "what is halted and by whom."

## 2.7 ADVANCED — Execution

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| X1 | Permitted order types | multi-select `market\|limit\|stop_market\|stop_limit` | `permittedOrderTypes` | `["market","limit"]` |
| X2 | Allow extended-hours orders | toggle | `permitExtendedHours` | `false` |
| X3 | Run during extended hours | toggle | `runDuringExtendedHours` | `false` |
| X4 | Fire synthetic stops in ext hours | toggle | `allowExtendedHoursSyntheticStops` | `false` |
| X5 | Cadence / run frequency (min) | number | `runCadenceMinutes` | 60 |
| X6 | Marketable-limit entries | toggle | `marketableLimitEntries` | `undefined` |
| X7 | Marketable-limit buffer (bps) | number | `tuning.marketableLimitBufferBps` | 15 |
| X8 | Max entry drift % | number (%) | `maxEntryDriftPct` | 10 |
| X9 | Proposal expiry (min) | number | `proposalExpiryMinutes` | 2880 |
| X10 | Proposal revalidate cadence (hrs) | number | `proposalRevalidateCadenceHours` | 0 |
| X11 | Stale limit-order alert (min) | number | `staleLimitOrderMinutes` | 15 |
| X12 | Max quote age (sec) | number | `maxQuoteAgeSec` | `undefined` (disabled) |
| X13 | Max fundamentals age (sec) | number | `maxFundamentalsAgeSec` | `undefined` (disabled) |

## 2.8 ADVANCED — Learning params (formerly the "Tuning" section)

The **decision-time tuning knobs** live here; the **AI-proposed-change review queue** lives in Results→Tuning (§3.5). Split rationale: params bound behavior, the queue reviews outcomes.

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| L1 | Shrinkage prior | number | `tuning.shrinkPrior` | 5 |
| L2 | Min closed lots for weight shift | number | `tuning.minClosedLotsForWeightShift` | 20 |
| L3 | Sizing floor % | number (%) | `tuning.sizingFloorPct` | 10 |
| L4 | Sizing ceiling % | number (%) | `tuning.sizingCeilingPct` | 100 |
| L5 | Conviction cap (uncorroborated) | number (0–1) | `tuning.convictionCapUncorroborated` | 0.6 |
| L6 | Corroboration win-rate % | number (%) | `tuning.corroborationWinRatePct` | 58 |
| L7 | Corroboration edge % | number (%) | `tuning.corroborationEdgePct` | 0 |
| L8 | FCF-yield veto floor % | number (%) | `tuning.bearVetoFcfYieldFloorPct` | `undefined` (disabled) |
| L9 | Debt/equity veto ceiling | number | `tuning.bearVetoDebtToEquityCeiling` | `undefined` (disabled) |
| L10 | Skip negative-expectancy gate | toggle | `tuning.skipNegativeExpectancy` | `undefined` (disabled) |
| L11 | …edge threshold % | number (%) | `tuning.skipNegativeExpectancyEdgePct` | 0 |
| L12 | OOS withhold unvalidated | toggle | `tuning.oosWithholdUnvalidated` | `true` |
| L13 | Use entry-run attribution | toggle | `tuning.useEntryRunAttribution` | `false` |

## 2.9 ADVANCED — Tax RULES (decision-time; distinct from Results→Tax outcomes)

| # | Label | Control | Field `[scope]` | Default |
|---|---|---|---|---|
| Tx1 | Tax treatment | select `taxable\|roth_ira\|traditional_ira` (account-intrinsic) | `taxSettings.taxationType` `[ACCOUNT]` | `"taxable"` (via `mergePolicy`) |
| Tx2 | **Wash-sale guard** | toggle | `taxSettings.washSaleGuard` **`[COUPLING]`** | `true` |
| Tx3 | Short-term rate % | number (%) | `taxSettings.shortTermRatePct` | 24 |
| Tx4 | Long-term rate % | number (%) | `taxSettings.longTermRatePct` | 15 |
| Tx5 | Subtract est. tax from results | toggle | `taxSettings.subtractFromResults` | `undefined` |

**Wash-sale as cross-account coupling (LOCKED, companion coherence A1/A2, §II-B Note 3):**
- Tx2 renders with a **`CROSS-ACCOUNT` scope tag**, **not** a `THIS ACCOUNT` toggle. Inline explainer: *"A loss in one taxable account locks rebuys of that symbol across all your accounts (including IRAs) for 30 days. This is enforced and cannot be silently bypassed."* (mirrors `src/lib/policy.ts:311-321`, `src/lib/tax.ts:108` `getWashSaleLockedSymbolsForUser`).
- Tx1 is **account-intrinsic** — changing it must revalidate the account-type guard (an IRA cannot run a short-enabled preset).
- **Test/sim exclusion (required fix):** `src/lib/tax.ts:113` maps `broker === "test" || environment === "paper" → source:"paper"`, so a **simulated** loss can currently contribute a lockout onto a **real** taxable account. Before the Approvals culprit-naming ships, Test must be filtered out of `getUserWashSaleLockedSymbols`. Spec'd in Results §3.1 and Approvals-owner spec; noted here because Tx2's explainer must not claim Test contributes.

## 2.10 Guardrails states

- **Essentials-only (default), Advanced-expanded** — one reveal, sticky per session.
- **capability-disabled** — greyed control + `⊘` explainer (short-selling on IRA, options controls on equity-only broker).
- **tripped** — Circuit-breaker cards show `⚠ TRIPPED`; a banner at top summarizes.
- **loosening vs tightening** — loosening a limit frictionless; raising a Live cap / disabling a stop / enabling shorting / flipping to Live-or-Decide → §0.2 inline confirm (type-to-confirm for the two one-way doors).

---

# 3. RESULTS — outcomes & learning (destination #6)

**Route/panel:** the Results destination (renamed from "Review", companion coherence G1). Account-scoped, with an All-accounts roll-up. Merges the former Performance + Tax(outcomes) workspace tabs and the Audit/Alert-history feed contents.

**Reference:** companion §Target IA row 6, §II-C migration rows for Performance/Tax/Activity/Runs/Notifications/Audit.

## 3.0 Layout — sub-tabs within Results

```
┌ <ScopedDestinationHeader: Results>   view: ○ This account ● All accounts ┐
│ [ Performance ] [ Scorecards ] [ Counterfactuals ] [ Tax outcomes ] [ Tuning ] [ Alert history ] [ History ] │
└───────────────────────────────────────────────────────────────────────────┘
```

## 3.1 Sub-tab — Performance

- **Realized P&L vs SPY** — line chart, realized P&L series vs SPY benchmark over the same window. Net-of-tax overlay toggles on when `taxSettings.subtractFromResults === true` (reads the Guardrails Tax rule; display only).
- **Attribution strip** — P&L by producing strategy/thesis tag (reuses `TradeProposal.tradeThesisTag`).
- **States:** empty ("no closed trades yet"), loading, live; All-accounts view aggregates and tags each series by account.

## 3.2 Sub-tab — Scorecards (thesis / regime / factor)

Three scorecards, each a table of {bucket, N trades, win-rate, avg return, shrunk estimate}:
- **Thesis scorecard** — grouped by `tradeThesisTag`.
- **Regime scorecard** — grouped by `entryMarketRegime`.
- **Factor scorecard** — the 8 scoring weights' realized contribution (ties to Strategy Signals' `auto-tuned` column and the Tuning queue). Uses the same `tuning.shrinkPrior` shrinkage the tuner uses so the numbers reconcile.

## 3.3 Sub-tab — Counterfactuals

"What would have happened" panel: rejected/snoozed proposals replayed forward, and the delta vs what was actually done. Read-only; sources the Approvals decision ledger (reject reason feeds learning per companion Approvals spec).

## 3.4 Sub-tab — Tax outcomes (distinct from Guardrails Tax RULES)

The **outcomes** side of the tax split (companion §II-C "Workspace tab: Tax" → splits):
- **Lots** — open/closed lot table with holding period.
- **Holding-period ladder** — days-to-long-term countdown per lot (ST→LT boundary).
- **Harvest candidates** — unrealized-loss positions eligible for tax-loss harvesting, **each annotated with the wash-sale coupling** (a harvest that would re-lock a symbol across accounts is flagged).
- **Net-of-tax** — realized P&L after estimated tax burden using `taxSettings.shortTermRatePct` / `longTermRatePct`; shown when `subtractFromResults` on.
- **Wash-sale ledger** — realized disallowed losses, **named with provenance** (contributing account + earliest clear date) — depends on the `getUserWashSaleLockedSymbols` return-type change (§3.8).

## 3.5 Sub-tab — Tuning queue (review-like-a-code-review)

The **AI-proposed-change review surface** (companion: "reviewed like a code review"; former Settings→Tuning queue relocates here). Each queued change is a **diff card**:
```
┌ Auto-tuner proposes: momentum weight 0.28 → 0.31                       ┐
│ evidence: 24 closed lots · shrunk win-rate 61% · edge +1.2%            │
│ affects: Strategy › Signals › momentum   [ let-AI-tune: ☑ ]           │
│ [ Approve ] [ Reject (reason) ] [ Snooze ]                            │
└───────────────────────────────────────────────────────────────────────┘
```
- **Approve** re-enters the deterministic config path (confirmable diff), writing `scoringWeights.<field>` — **only if that weight's `tuning.letAiTuneWeights[field] !== false`** (§1.3). A change to a `let-AI-tune = ☐` weight cannot appear as approvable here.
- **Reject reason feeds learning** (parallel to Approvals reject).
- Governed by `tuning.minClosedLotsForWeightShift`, `oosWithholdUnvalidated` (a withheld change shows "held: OOS validation pending").

## 3.6 Sub-tab — Alert history (the log)

The persistent **log** side of the Alerts noun-family (companion coherence B1): chronological list of delivered/undelivered alerts across the `NotificationEventType` union (`fill`, `block`, `run_failed`, `pending_approval`, `kill_switch`, `price_alert`, `proposal_withdrawn`, `limit_order_stale`, `provider_degraded`). **This is NOT** the chrome 🔔 Alerts stream and **NOT** Settings→Alert delivery (rules). Filter by event type + account.

## 3.7 Sub-tab — History (canonical audit home)

**The single canonical audit/History home** (companion coherence B2). Chronological `audit()` log (`src/lib/db.ts`). The Dashboard/Approvals/Settings audit entry points are **deep-links into this surface**, not parallel homes. Columns: timestamp · account · actor (user/AI/tuner/system) · action · before→after. Filter by account + actor + action.

## 3.8 Results dependency — wash-sale provenance return-type change (RESOLVED GAP, companion Part III §C8)

The Tax-outcomes wash-sale ledger and the Approvals culprit-naming both require `getUserWashSaleLockedSymbols` (`src/lib/tax.ts:108`) to return **per-symbol provenance**, not a flat `Set<string>`. **Full consumer inventory + migration (build gate):**
- **New return type:** `Map<string, { contributingAccountId: string; contributingAccountLabel: string; source: FillSource; earliestClearDate: string }>` (or a `WashSaleLockout[]` with a `.has()`-parity helper).
- **Consumers to update in the same PR (enumerated so the type change breaks at compile time, not runtime):**
  1. `src/lib/policy.ts:321` — currently `getUserWashSaleLockedSymbols(...)` used as a `Set` with `.has(symbol)` at the gate. Add a `lockedSymbolSet(lockouts)` adapter so the enforcement gate keeps `.has()` semantics unchanged (enforcement is authoritative and must not weaken — companion §Guardrails invariant).
  2. `src/lib/tax.ts:108` `getWashSaleLockedSymbolsForUser` — the inner producer; thread provenance through its per-account loop (it already iterates `accounts` with `accountNumber`/`source`/`taxationType` — add `label` + `earliestClearDate`).
  3. Results Tax-outcomes ledger (§3.4) and Approvals blocked-card culprit line — new consumers.
  4. Any test asserting on the `Set` shape (grep `getUserWashSaleLockedSymbols`, `getWashSaleLockedSymbolsForUser` in `test/`).
- **Test filter (required):** in the producer, **exclude `broker === "test"`** from contribution (fix the `tax.ts:113` `test → "paper"` leak) so a simulated loss never locks a real account. Acceptance test: a Test-account loss does **not** appear in another taxable account's lockout after the fix (companion §Guardrails invariant).
- **Degrade gracefully:** until provenance ships, the Approvals card shows "locked by a wash-sale in another account"; the Results ledger shows the symbol without the contributing-account column.

---

# 4. ASSISTANT — persistent scope-aware slide-over (overlay, NOT a tab)

**Not a destination.** A persistent slide-over overlaying all destinations, opened via ⌘K or a RIGHT-zone rail button (companion §"The Assistant", §Global frame). It reads the **active account's** context and **routes every trade → Approvals and every config change → a confirmable diff** — it never mutates directly. Counting it as a peer tab would recreate the "two approval homes" bug.

## 4.0 Layout & states

- **Presentation:** right-edge slide-over (~420px), overlays the current destination without unmounting it — you can ask "why is this proposal risky?" **on the Approvals card** without losing place.
- **Header:** `Assistant — <accountAlias> · <broker> [MODE badge]` — same scope stamp as §0.1, so the user always knows whose context the assistant reasons about.
- **States:** `collapsed` (rail button only), `open` (slide-over), `thinking` (streaming), `routed-to-approval` (a proposal chip linking into Approvals), `routed-to-diff` (a confirmable-diff chip), `unresolved-scope` (assistant available but scoped actions blocked with "Pick an account" — mirrors §0.1).

## 4.1 Interaction contract — the two routing rails (load-bearing)

| User intent | Assistant does | Never does |
|---|---|---|
| "Buy 100 NVDA" / any order intent | Constructs a `TradeProposal` (with required `tradeThesisTag` + `entryMarketRegime`, per CLAUDE.md cross-file trap) and **routes it to the Approvals queue** for the active account. Returns a chip: `Proposed → Approvals (Roth IRA · PAPER)`. | Place a trade. Bypass the policy gate. |
| "Raise my daily notional to $2k" / any config intent | Produces a **confirmable diff** against the active account's `TradingPolicy` (field, before→after, scope tag, consequence preview) routed through the same deterministic config path as a manual Guardrails edit. Returns a chip: `Config change ready → confirm diff`. | Write policy directly. Loosen a Live limit without the §0.2 confirm. |
| "Why is this proposal risky?" | Reads the active Approvals card's evidence (Bull→Bear→Red-Team, policy-gate checklist, wash-sale coupling) and explains, citing sources. | Approve/reject on the user's behalf. |

**Money-reality & one-way-door parity (companion coherence E2):** an Assistant-routed config change that loosens a Live cap, disables a stop, enables shorting, or flips to Live/Decide inherits the **exact same** friction as the chrome/Guardrails path — type-to-confirm for the two one-way doors, first-Live-act-of-session re-consent. The Assistant is not a side door (companion Design principle 7). Acceptance: an Assistant-proposed "flip to Decide on a Live account" surfaces the type-to-confirm, identical to the Guardrails dial.

## 4.2 Scope awareness

- Reads **view-scope** active account (post-P2 decoupling — companion Design principle 2). When view-scope switches, the Assistant header re-stamps and its context re-scopes in place.
- **Single-account collapse (P11):** header alias is static; no scope-picker inside the assistant.
- Every routed trade/config action carries the account id, **re-validated server-side at write time** (companion Design principle 3) — a stale assistant session cannot act on the wrong account.

---

# 5. Cross-cutting acceptance criteria (all four surfaces)

1. **Field-store correctness (silent-write trap, CLAUDE.md).** Every control writes to the store implied by its `[scope]` tag. `USER_LEVEL_POLICY_FIELDS` stays exactly 3 (`notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`, `src/lib/db-profiles.ts:20-24`); no account-scoped control in Strategy/Guardrails writes to `user_settings.policy`, and the two `marketScan*` knobs are NOT rendered in Strategy. Round-trip read-after-write test per field.
2. **No autonomy control in Strategy** — `strategyAuthority` renders only in Guardrails (Design principle 6). Grep-assert.
3. **No `openSettings` points at a relocated section** — the 6 sites (`app/dashboard-client.tsx:1514,1555,1562,1583,1709,1818`) navigate to Strategy/Guardrails destinations, not a gutted modal (companion merge gate, §II-D Phase 3).
4. **Autonomy-reset-on-restart** — after a boot-id change, every account's effective `strategyAuthority` is `"propose"`; chrome + Guardrails reflect it (§2.2).
5. **Wash-sale is never a plain per-account toggle** — Tx2 carries the `CROSS-ACCOUNT` tag + explainer; Test excluded from contribution; provenance change lands with the full consumer inventory (§3.8).
6. **Assistant routes, never mutates** — no direct policy/trade write path from the Assistant; both rails go through Approvals / confirmable-diff with money-reality parity (§4.1).
7. **Verify trio green before merge** (`npx tsc --noEmit` → `npm test` → `npm run build`, plus `npm run lint`), with affected tests updated in the same PR (companion §Guardrails invariants).

**Primary files touched:** `app/dashboard-client.tsx` (destination panels, TuningCard merge `:3725`/`:4441`, `openSettings` sites), new `app/ui/scoped-destination-header.tsx`, `app/ui/use-consequence-preview.ts`, `app/ui/origin-badge.tsx`, `app/ui/strategy-flow.tsx` (reclassify), `src/lib/types.ts` (net-new `tuning.letAiTuneWeights`), `src/lib/db.ts` + `src/lib/db-execution.ts` (net-new `armed_authority`/`armed_boot_id`/`armed_at` + `runtime_state`), `src/lib/tax.ts:108/113` (provenance return type + Test filter), `src/lib/policy.ts:321` (`.has()`-parity adapter), new `GET /api/accounts/:accountId/impact-preview`.
