# Field-by-Field Settings Reference — The Master Control Catalog

**Companion to:** [`docs/settings-navigation-redesign.md`](./settings-navigation-redesign.md) (v2, the canonical design). This document does not restate the IA — it is the exhaustive per-field build spec that the design's Part II-B tree points at. Every configurable field from the grounding catalog (all `TradingPolicy` account-scope fields + nested `riskRules`/`scoringWeights`/`taxSettings`/`tuning`/`universeFloor`/`notificationSettings`, the 3 user-global fields, and the capability-gating inputs) appears exactly once, grouped by its **new home** in the v2 tree.

**Grounding anchors (verified this session):** `src/lib/types.ts` (all enums, `AccountCapabilities`), `src/lib/defaults.ts` (`DEFAULT_POLICY`, `DEFAULT_RISK_RULES`, `DEFAULT_SCORING_WEIGHTS`, `DEFAULT_TAX_SETTINGS`, `DEFAULT_NOTIFICATION_SETTINGS`), `src/lib/db-profiles.ts:20-24` (`USER_LEVEL_POLICY_FIELDS` = exactly 3), `db-profiles.ts:142-147` (`mergePolicy` server-side clamps), `app/dashboard-client.tsx:162-168` (`SettingsSection`, `ACCOUNT_SETTINGS_SECTIONS`, `settingsTierForSection`).

---

## 0. How to read this catalog

**Column contract for every field row:**

| Column | Meaning |
|---|---|
| **Field (dotted path)** | Exact `TradingPolicy`/nested key. Wire new controls against these — do not invent aliases. |
| **New home** | Destination + section per the v2 settings tree (§Settings taxonomy, `settings-navigation-redesign.md`). |
| **Scope** | `[ACCOUNT]` (per `connectedAccountId`, in `account_strategy_state`) · `[USER]` (in `user_settings.policy`, all accounts) · `[CROSS-ACCOUNT COUPLING]` (wash-sale — one account's act, all accounts' consequence). |
| **Disclosure** | `Essentials` (opens visible) vs `Advanced` (one reveal) vs `Expert` (env/search-only, not a UI level — coherence C2). |
| **Control** | toggle / slider / number+unit / select / multiselect / text / textarea. |
| **Default** | From `defaults.ts`. `undefined` ⇒ feature disabled/inactive unless a merge fallback fills it (noted). |
| **Range / validation** | Client validation + any server-side `mergePolicy` clamp. |
| **Capability gate** | Which broker/account-type/capability disables (greys) the control. |
| **Friction** | `frictionless` (loosening-safe or read) · `inline-confirm` (consequence-labeled confirm) · `type-to-confirm` (typed acknowledgment; the two one-way doors + first-Live-act). |

**Friction governing rule (from P9, woven per control):** *Loosening a limit is frictionless; raising a Live cap, disabling a stop, enabling shorting, or flipping to Live/Decide triggers an inline consequence-labeled confirm; typed acknowledgment is reserved for the two one-way doors (arm Live, arm Auto-on-Live) plus the first Live approval of a session.* Each row states the **default** friction; every account-scoped write additionally inherits **type-to-confirm when the active account is Live and the edit loosens a cap** (the per-field-confirm-on-Live rule from P8/P9).

**Consequence-preview copy template.** Every account-scope numeric/toggle control renders a live plain-English preview (§"Woven through every control"). Templates are given per field. The two standard shapes:
- **Sizing/exposure:** `"Caps each {order|position} at ~${X} — about {X/NAV}% of this account's equity (${NAV})."`
- **Stop/breaker:** `"Exits/halts when {metric} crosses {X}. Under this rule, {N} of your last {M} proposals would have been {blocked|exited}."` (the pre-save impact preview).

---

# SCOPE A — Account-scope config (lives in Strategy & Guardrails destinations)

Governing rule (printed on the Settings divider): **if a setting changes how a trade is decided or placed, it belongs to the account.** All fields below are `[ACCOUNT]` unless tagged otherwise.

---

## A1. STRATEGY → Thesis

*Destination: Strategy. Header stamped `Live Strategy — <account> [MODE]` + preset provenance.*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `strategyPrompt` *(stored as `account_strategy_state.prompt`, not a `policy.*` key — read/write via `getStrategyPrompt`/`setStrategyPrompt`)* | ACCOUNT | Essentials | textarea (monospace, full-screen mode) | `DEFAULT_STRATEGY_PROMPT` (`defaults.ts:86`) | Non-empty; soft max ~8000 chars (LLM context budget); never blank-saved (falls back to default). | none | frictionless (loosening); **inline-confirm on Live** — an aggressive mandate edit shows "This changes how the AI picks trades on a REAL-MONEY account." |
| "Thesis language" | ACCOUNT | Essentials | text (short) | derived from prompt; no discrete field | free text; advisory tag only | none | frictionless |
| `holdingHorizon` | ACCOUNT | Essentials | select | `"swing"` | `intraday \| swing \| position \| longterm` (`types.ts:27`) | none | frictionless |

**Consequence template (holdingHorizon):** `"Targets {swing 2–10 day} holds — shapes stop/target defaults and turnover."`

---

## A2. STRATEGY → Signals

*8 scoring weights render as a triad: **default vs current vs auto-tuned**, each row with a `[ let the AI tune this ☑ ]` toggle (the toggle drives whether the auto-tuner may shift that weight — see `tuning.minClosedLotsForWeightShift`).*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `scoringWeights.liquidity` | ACCOUNT | Essentials (weights block) | slider (0–3, step 0.05) | `1.4` | `≥ 0`; `normalizeScoringWeights` clamps negatives/non-finite → `0` (`db-profiles.ts:150`). | none | frictionless |
| `scoringWeights.momentum` | ACCOUNT | Essentials | slider | `1.2` | as above | none | frictionless |
| `scoringWeights.value` | ACCOUNT | Essentials | slider | `0.8` | as above | none | frictionless |
| `scoringWeights.quality` | ACCOUNT | Essentials | slider | `0.8` | as above | none | frictionless |
| `scoringWeights.volatility` | ACCOUNT | Essentials | slider | `0.8` | as above | none | frictionless |
| `scoringWeights.sentiment` | ACCOUNT | Essentials | slider | `0.6` | as above | none | frictionless |
| `scoringWeights.positioning` | ACCOUNT | Essentials | slider | `0.8` | as above | none | frictionless |
| `scoringWeights.diversification` | ACCOUNT | Essentials | slider | `1` | as above | none | frictionless |
| `tuning.minProposalScoreThreshold` | ACCOUNT | Advanced | number (score, 0–100) | `undefined` → treated as `0` | `0 ≤ x ≤ 100` | none | frictionless |
| `includedIndices` | ACCOUNT | Essentials | multiselect | `["sp500"]` | subset of `IndexUniverse` (`sp100\|sp500\|nasdaq100\|nasdaqComposite\|dow30\|russell2000\|nyseComposite\|ftWilshire5000`, `types.ts:7`); ≥1 required | none | frictionless |
| `additionalSymbols` | ACCOUNT | Essentials | multiselect / tag-input (tickers) | `[]` | uppercase A–Z tickers; dedup vs blocklist | none | frictionless |
| `blocklist` | ACCOUNT | Essentials | multiselect / tag-input | `undefined` → `[]` | uppercase tickers; conflicts with `additionalSymbols` warn | none | frictionless |
| `universeFloor.minPrice` | ACCOUNT | Advanced | number+unit ($/share) | `5` | `≥ 0`; applies to **scanned** candidates only (explicit symbols/held positions exempt) | none | frictionless |
| `universeFloor.minMarketCapUsd` | ACCOUNT | Advanced | number+unit (USD) | `100_000_000` | `≥ 0`; applied only when market cap known | none | frictionless |
| `universeFloor.minDollarVolume` | ACCOUNT | Advanced | number+unit (USD/day) | `1_000_000` | `≥ 0` (= price × volume); applied only when known | none | frictionless |

**Consequence template (weights):** `"Raising {factor} makes the AI favor {high-liquidity/momentum/...} names more strongly in ranking."`
**Consequence template (universeFloor.*):** `"Excludes scanned names under ${X} {price/cap/$-vol}. Your explicit watchlist and current holdings are never filtered out."`

**Auto-tune toggle semantics:** the per-weight `[ let the AI tune this ]` checkbox gates whether the auto-tuner may move that specific weight. It is a UI-derived per-weight flag; if it needs persistence, add a `scoringWeightAutoTune: Partial<Record<keyof ScoringWeights, boolean>>` to `TuningSettings` (net-new; not in current type — **flag for owner**). Until persisted, treat as a session-only view control that gates whether the tuner's proposed weight patch includes that key.

---

## A3. STRATEGY → AI Review

*Overrides the user-global default model set in Settings → Keys & Models. When unset, the account inherits the global default (merge in `getPolicy`).*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `llmModel` (Green/Bull model) | ACCOUNT | Essentials | select (model list) | `"gpt-5.4-mini"` | model id in provider catalog | requires `OPENAI_API_KEY` configured; else control greyed with "Add an LLM key in Settings → Keys & Models" | frictionless |
| `redTeamLlmModel` (Red-Team model) | ACCOUNT | Advanced | select | `undefined` (reuses `llmModel`) | model id or "same as Green" | same as above | frictionless |
| `tuning.redTeamConvictionThreshold` | ACCOUNT | Advanced | number / slider (0–100) | `80` | `0 ≤ x ≤ 100` | none (no-op if Red-Team disabled) | frictionless |
| `llmReasoningEffort` | ACCOUNT | Advanced | select | `"medium"` | `low \| medium \| high` (`types.ts:25`) | requires LLM key | frictionless |

---

## A4. GUARDRAILS → ESSENTIALS

*Opens visible. Exactly 5 controls (coherence C1). These are **novice labels** over precise backing fields — the label ↔ field mapping is load-bearing and resolved below.*

| Essentials control (novice label) | Backing field(s) | Scope | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| **Max position size** *(see §A5 resolution)* | primary write: `maxOrderNotional`; mirror display: `maxOrderPctOfNav` | ACCOUNT | number+unit ($) with live "% of equity" echo | `maxOrderNotional`: `undefined`; `maxOrderPctOfNav`: `5` | `maxOrderNotional`: `> 0`, **server clamps to ≤ 100_000** (`db-profiles.ts:146`); `maxOrderPctOfNav`: `0 < x ≤ 100` | none | frictionless when lowered; **inline-confirm** when raised; **type-to-confirm** raising on Live |
| **Daily-loss stop** | `riskRules.maxDailyLossNotional` | ACCOUNT | number+unit ($) | `undefined` (disabled) | `> 0`; triggers `close_only` when hit | none | frictionless when tightened; **inline-confirm** when raised/disabled on Live |
| **Stop-loss on/off** | presence of `riskRules.stopLossPct` (toggle writes `8` on / clears off) | ACCOUNT | toggle | on (`stopLossPct = 8`) | toggling off sets `stopLossPct = undefined` | none | **inline-confirm to disable** ("removes the automatic loss exit"); **type-to-confirm to disable on Live** |
| **Autonomy dial** | `strategyAuthority` | ACCOUNT | segmented toggle (Propose ↔ Decide) | `"propose"` | `propose \| decide` (`types.ts:17`) | Decide requires a connected non-Test broker to be meaningful | Propose→frictionless; **Decide = type-to-confirm** (one-way door: "arm Auto"); **Auto-on-Live = the second type-to-confirm door** |
| **Extended-hours on/off** | `permitExtendedHours` | ACCOUNT | toggle | `false` | boolean | broker must support extended-hours routing; greyed on Test | enable→inline-confirm; disable→frictionless |

**Essentials consequence previews:**
- Max position size: `"Risks at most ${maxOrderNotional} per order — about {pct}% of this account's equity (${NAV})."`
- Daily-loss stop: `"If this account loses ${X} in one day, the AI stops opening new trades (goes close-only)."`
- Stop-loss: `"Every position auto-exits after a {8}% loss."` / (off) `"No automatic loss exit — positions can fall without a floor."`
- Autonomy: (Propose) `"The AI proposes; nothing trades until you approve."` (Decide) `"The AI executes approved-shape trades automatically within these guardrails."`
- Extended-hours: `"Allows order placement outside 9:30–16:00 ET (wider spreads, thinner liquidity)."`

---

## A5. RESOLUTION — the "max position size" Essentials field (closes Part III gap #4)

The design flagged this as ambiguous: *"position size" (total holding) and "order notional" (single order) are different quantities.* **Resolved concretely for the build:**

**The Essentials "Max position size" control maps to `maxOrderNotional` (single-order dollar cap), NOT to a per-symbol total-holding cap.** Rationale and exact wiring:

1. **Primary write target = `maxOrderNotional`.** This is the hard per-order dollar ceiling the strategy prompt already calls "a hard safety cap" (`defaults.ts:103`) and that `mergePolicy` clamps to ≤ `100_000` (`db-profiles.ts:146`). It is the single number a novice means by "the most the AI can put into one buy."
2. **Displayed mirror = `maxOrderPctOfNav` (default `5`).** The control shows the dollar value with a live "≈ {pct}% of equity" echo derived from `maxOrderPctOfNav × NAV`. When the user types a dollar amount, write `maxOrderNotional` and **recompute+store `maxOrderPctOfNav = round(maxOrderNotional / NAV × 100)`** so the two stay consistent (both are enforced; the effective per-order cap is `min(maxOrderNotional, maxOrderPctOfNav% × NAV)`). When the user has never set a dollar figure (`maxOrderNotional === undefined`), the Essentials control renders the `%NAV`-derived dollar value as its placeholder and writes `maxOrderNotional` on first edit.
3. **The novice label deliberately does NOT bind to a per-symbol *exposure* cap.** Total-holding exposure is a **distinct, Advanced-only** concern governed by `maxSymbolExposurePct` (default `25`) and `maxSymbolExposureNotional` (default `undefined`) under **Guardrails → Advanced → Exposure** (§A7). The Essentials label is intentionally narrowed to *per-order* size because (a) it is the value that most directly bounds a single autonomous action, and (b) collapsing "how big is one buy" and "how big can one name get overall" into one novice slider is exactly the conflation the design warns against.
4. **Cross-reference copy.** The Essentials control carries a one-line Advanced pointer: `"This caps each order. To cap how much of one stock the AI can hold in total, see Exposure → Per-symbol cap."` — so the novice is never misled into thinking the order cap also bounds accumulation across multiple buys.

**Acceptance criteria (max-position-size wiring):**
- Editing the Essentials dollar field writes `maxOrderNotional` and recomputes `maxOrderPctOfNav`; round-trip read returns the same dollar value at the current NAV.
- Value > 100_000 is clamped server-side to 100_000 and the UI reflects the clamp with an inline note.
- `maxSymbolExposurePct` / `maxSymbolExposureNotional` are **not** touched by this control (assert no write).
- On a Live active account, raising `maxOrderNotional` requires type-to-confirm; lowering is frictionless.

---

## A6. GUARDRAILS → ADVANCED → Autonomy

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `strategyAuthority` | ACCOUNT | Advanced (also in Essentials) | segmented toggle | `"propose"` | `propose \| decide` | Decide meaningful only on non-Test broker | Decide = **type-to-confirm** |
| `systemState` | ACCOUNT | Advanced | select / status control | `"halted"` | `active \| halted \| close_only \| liquidating` (`types.ts:16`) | `liquidating` only on brokers that support flatten | active = **inline-confirm**; `liquidating` = **type-to-confirm** (sells) |

**AUTONOMY-RESET-ON-RESTART (net-new, REQUIRED, DEFAULT ON — closes Open Q2 / Part III #7).** The design asserts autonomy drops to its safe floor on process restart; grounding confirms **no such field exists today** — `systemState`/`strategyAuthority` persist verbatim in `account_strategy_state`. Build it net-new:

- **Persistence anchor:** add two columns to `account_strategy_state` (owning migration in `db.ts` `migrate()`, CRUD in `db-profiles.ts` per the barrel rule):
  - `armed_authority TEXT` — the *persisted, user-intended* authority (`propose|decide`).
  - `armed_at TEXT` (ISO) + a process-scoped boot token compared against a module-level `PROCESS_BOOT_ID` (set once per process start).
- **Reset mechanism:** on the first `getPolicy`/scheduler read for an account within a new process (i.e. `armed_at`'s boot token ≠ current `PROCESS_BOOT_ID`), the *effective* `strategyAuthority` is forced to `"propose"` and `systemState` to its safe floor (`halted` if it was `active`; `close_only`/`liquidating` are left as they are — they are safer, not looser) **without** mutating `armed_authority` (the user's intent is remembered so the re-arm UI can show "was Decide"). Re-arming writes a fresh `armed_at`+boot token.
- **UI:** on restart the Autonomy dial shows `Propose (reset on restart — re-arm to resume Decide)` and the chrome authority chip reads `Propose` with a `↻ reset` badge.
- **Scope interaction:** reset is per-account (each account re-arms independently). Fleet has no bulk re-arm — arming stays a deliberate per-account act (P4/P9).
- **Acceptance:** simulate a process restart (new `PROCESS_BOOT_ID`) → assert every account's effective `strategyAuthority === "propose"` and no `active` account remains `active` until an explicit re-arm write lands; assert `armed_authority` still records the pre-restart intent.

---

## A7. GUARDRAILS → ADVANCED → Sizing / Exposure

**Sizing**

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `maxOrderNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` | `> 0`, **server clamp ≤ 100_000** | none | raise = inline-confirm / type-to-confirm on Live |
| `maxOrderPctOfNav` | ACCOUNT | Advanced | number+unit (%) | `5` | `0 < x ≤ 100` | none | raise = inline-confirm on Live |
| `maxOrderPctOfAdv` | ACCOUNT | Advanced | number+unit (%) | `5` | `0 < x ≤ 100` | none | frictionless |
| `maxDailyNotional` | ACCOUNT | Advanced | number+unit ($) | `500` | `> 0`; **`≥ 500_000` resets to default + caps `maxDailyOrders`** (`db-profiles.ts:142-144`) | none | raise = inline-confirm on Live |
| `maxDailyPctOfNav` | ACCOUNT | Advanced | number+unit (%) | `undefined` (disabled) | `0 < x ≤ 100` | none | raise = inline-confirm on Live |
| `maxHourlyNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` (disabled) | `> 0` | none | raise = inline-confirm on Live |
| `maxDailyOrders` | ACCOUNT | Advanced | number (count) | `10` | integer `≥ 1`; auto-capped when `maxDailyNotional` resets | none | frictionless |
| `maxProposalsPerRun` | ACCOUNT | Advanced | number (count) | `3` | integer `≥ 1` | none | frictionless |
| `sellToFundBuy` | ACCOUNT | Advanced | select | `"off"` | `off \| suggest \| propose \| automated` (`types.ts:23`) | `automated` meaningful only with Decide authority | `automated` = **inline-confirm** |

**Exposure**

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `maxSymbolExposurePct` (Per-symbol cap) | ACCOUNT | Advanced | number+unit (%) | `25` | `0 < x ≤ 100` | none | raise = inline-confirm on Live |
| `maxSymbolExposureNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` | `> 0` | none | raise = inline-confirm on Live |
| `sectorCaps` (Per-sector caps map) | ACCOUNT | Advanced | key-value editor (sector → %) | `{}` | each `0 < x ≤ 100`; sector keys from GICS list | none | frictionless |
| `maxGrossExposurePct` | ACCOUNT | Advanced | number+unit (%) | `80` | `0 < x ≤ 200` (margin) | > 100 requires `capabilities.marginEnabled` | raise = inline-confirm on Live |
| `maxNetExposurePct` | ACCOUNT | Advanced | number+unit (%) | `80` | `0 < x ≤ 200`; net ≤ gross | none | raise = inline-confirm on Live |
| `maxPortfolioBeta` | ACCOUNT | Advanced | number | `undefined` (disabled) | `> 0` | none | frictionless |
| `maxAvgCorrelation` | ACCOUNT | Advanced | number (0–1) | `undefined` (disabled) | `0 ≤ x ≤ 1` | none | frictionless |

**Consequence template (exposure):** `"No single {stock|sector} can exceed {X}% of equity; total {gross|net} exposure capped at {X}% (leaves {100−X}% cash buffer)."`

---

## A8. GUARDRAILS → ADVANCED → Risk (stops & exits)

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `riskRules.stopLossPct` | ACCOUNT | Advanced (also Essentials toggle) | number+unit (%) | `8` | `0 < x ≤ 100` | none | disable/raise = **inline-confirm**; on Live = type-to-confirm |
| `riskRules.stopLossNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` | `> 0` | none | raise = inline-confirm |
| `riskRules.takeProfitPct` | ACCOUNT | Advanced | number+unit (%) | `20` | `> 0` | none | frictionless |
| `riskRules.takeProfitTrimPct` | ACCOUNT | Advanced | number / slider (%) | `50` | `1 ≤ x ≤ 100` (% of position sold at target) | none | frictionless |
| `riskRules.takeProfitNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` | `> 0` | none | frictionless |
| `riskRules.trailingStopPct` | ACCOUNT | Advanced | number+unit (%) | `0` (off) | `0 ≤ x ≤ 100`; `0` = disabled | none | frictionless |
| `riskRules.shortStopLossPct` | ACCOUNT | Advanced | number+unit (%) | `undefined` | `> 0`; **required when `shortSellingEnabled`** | greyed unless `capabilities.shortSelling` | **inline-confirm** (mandatory-when-shorting) |
| `riskRules.atrStopPeriod` | ACCOUNT | Advanced | number (bars) | `undefined` (fn default 14) | integer `≥ 1` | none | frictionless |
| `riskRules.atrStopMultiple` | ACCOUNT | Advanced | number (×) | `undefined` (fn default 2.0) | `> 0` | none | frictionless |
| `atrStops` (toggle) | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | none | frictionless |
| `betaScaledStops` | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | none | frictionless |
| `brokerBracketsEnabled` | ACCOUNT | Advanced | toggle | `true` | boolean | broker must support native brackets (Alpaca); greyed elsewhere | disable = inline-confirm |
| `robinhoodBrokerStops` | ACCOUNT | Advanced | toggle | `false` | boolean | only on Robinhood live; greyed otherwise | enable = **inline-confirm** (verify RH stop semantics) |
| `marketableLimitEntries` | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | none | frictionless |
| `shortSellingEnabled` | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean; enabling requires `shortStopLossPct` set | **greyed unless `capabilities.shortSelling === true`**; hard-blocked on IRA account types | enable = **type-to-confirm** |
| `maxShortOrderNotional` | ACCOUNT | Advanced | number+unit ($) | `undefined` | `> 0` | greyed unless shorting enabled | raise = inline-confirm |
| `maxShortExposurePct` | ACCOUNT | Advanced | number+unit (%) | `undefined` | `0 < x ≤ 100` | greyed unless shorting enabled | raise = inline-confirm |

**Capability-gate note (shorting):** `AccountCapabilities.shortSelling` is `false` for Robinhood MCP always and parsed from `account.shorting_enabled` for Alpaca (`types.ts:106`). When `false`, grey `shortSellingEnabled`, `maxShortOrderNotional`, `maxShortExposurePct`, and `riskRules.shortStopLossPct` with the explainer "This broker/account doesn't allow short selling." Preset-apply onto an IRA (`accountType ∈ {traditional_ira, roth_ira}`) hard-warns/blocks any short/margin field (§Presets guard).

---

## A9. GUARDRAILS → ADVANCED → Circuit breakers

*Each card doubles as live armed/tripped status.*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `riskRules.maxDrawdownPct` | ACCOUNT | Advanced | number+unit (%) | `undefined` (disabled) | `0 < x ≤ 100`; triggers `close_only` from high-water | none | raise/disable = **inline-confirm** on Live |
| `riskRules.maxDailyLossNotional` | ACCOUNT | Advanced (also Essentials) | number+unit ($) | `undefined` (disabled) | `> 0`; triggers `close_only` | none | raise/disable = **inline-confirm** on Live |
| `volPanicBrakeEnabled` | ACCOUNT | Advanced | toggle | `true` | boolean; flips `active → close_only` on tail extreme | requires VIX/VVIX/SKEW feed | disable = **inline-confirm** |
| `volPanicVixThreshold` | ACCOUNT | Advanced | number | `40` | `> 0` | greyed if brake off | raise = inline-confirm |
| `volPanicVvixThreshold` | ACCOUNT | Advanced | number | `150` | `> 0` | greyed if brake off | raise = inline-confirm |
| `volPanicSkewThreshold` | ACCOUNT | Advanced | number | `160` | `> 0` | greyed if brake off | raise = inline-confirm |
| `tuning.crisisMaxOpeningExposurePct` | ACCOUNT | Advanced | number+unit (%) | `undefined` (disabled) | `0 ≤ x ≤ 100` | none | frictionless |

---

## A10. GUARDRAILS → ADVANCED → Execution

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `permittedOrderTypes` | ACCOUNT | Advanced | multiselect | `["market","limit"]` | subset of `market\|limit\|stop_market\|stop_limit` (`types.ts:4`); ≥1 | stop types greyed if broker lacks native stops | frictionless |
| `permitExtendedHours` | ACCOUNT | Advanced (also Essentials) | toggle | `false` | boolean | broker must support ext-hours; greyed on Test | enable = inline-confirm |
| `runDuringExtendedHours` | ACCOUNT | Advanced | toggle | `false` | boolean | requires `permitExtendedHours` | frictionless |
| `allowExtendedHoursSyntheticStops` | ACCOUNT | Advanced | toggle | `false` | boolean | requires ext-hours support | enable = inline-confirm |
| `runCadenceMinutes` | ACCOUNT | Advanced | number+unit (min) | `60` | integer `≥ 1` | none | frictionless |
| `marketableLimitEntries` *(cross-listed with Risk)* | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | none | frictionless |
| `tuning.marketableLimitBufferBps` | ACCOUNT | Advanced | number+unit (bps) | `15` | integer `≥ 0` | greyed unless `marketableLimitEntries` on | frictionless |
| `maxEntryDriftPct` | ACCOUNT | Advanced | number+unit (%) | `10` | `> 0`; rejects stale opening order drifted > x% | none | raise = inline-confirm |
| `staleLimitOrderMinutes` | ACCOUNT | Advanced | number+unit (min) | `15` | integer `≥ 1` | none | frictionless |
| `proposalExpiryMinutes` | ACCOUNT | Advanced | number+unit (min) | `2880` | integer `≥ 1` | none | frictionless |
| `proposalRevalidateCadenceHours` | ACCOUNT | Advanced | number+unit (hr) | `0` (off) | integer `≥ 0` | none | frictionless |
| `maxQuoteAgeSec` | ACCOUNT | Advanced | number+unit (sec) | `undefined` (disabled) | integer `> 0` | none | frictionless |
| `maxFundamentalsAgeSec` | ACCOUNT | Advanced | number+unit (sec) | `undefined` (disabled) | integer `> 0` | none | frictionless |

---

## A11. GUARDRAILS → ADVANCED → Learning / Tuning params

*Formerly the "Tuning" settings section; the AI-proposed-change **review queue** moves to Results → Tuning (a destination, not a setting). These are the tuner's **parameters**.*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `tuning.shrinkPrior` | ACCOUNT | Advanced | number | `5` | `≥ 0` | none | frictionless |
| `tuning.minClosedLotsForWeightShift` | ACCOUNT | Advanced | number (count) | `20` | integer `≥ 0` | none | frictionless |
| `tuning.sizingFloorPct` | ACCOUNT | Advanced | number+unit (%) | `10` | `0 ≤ x ≤ sizingCeilingPct` | none | frictionless |
| `tuning.sizingCeilingPct` | ACCOUNT | Advanced | number+unit (%) | `100` | `sizingFloorPct ≤ x ≤ 100` | none | frictionless |
| `tuning.convictionCapUncorroborated` | ACCOUNT | Advanced | number (0–1) | `0.6` | `0 ≤ x ≤ 1` | none | frictionless |
| `tuning.corroborationWinRatePct` | ACCOUNT | Advanced | number+unit (%) | `58` | `0 ≤ x ≤ 100` | none | frictionless |
| `tuning.corroborationEdgePct` | ACCOUNT | Advanced | number+unit (%) | `0` | any real | none | frictionless |
| `tuning.bearVetoFcfYieldFloorPct` | ACCOUNT | Advanced | number+unit (%) | `undefined` (disabled) | any real | none | frictionless |
| `tuning.bearVetoDebtToEquityCeiling` | ACCOUNT | Advanced | number (ratio) | `undefined` (disabled) | `> 0` | none | frictionless |
| `tuning.skipNegativeExpectancy` | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | none | frictionless |
| `tuning.skipNegativeExpectancyEdgePct` | ACCOUNT | Advanced | number+unit (%) | `0` | any real | greyed unless above toggle on | frictionless |
| `tuning.oosWithholdUnvalidated` | ACCOUNT | Advanced | toggle | `true` | boolean | none | frictionless |
| `tuning.useEntryRunAttribution` | ACCOUNT | Advanced | toggle | `false` | boolean | none | frictionless |

*(`tuning.redTeamConvictionThreshold` and `tuning.minProposalScoreThreshold` live in Strategy → AI Review / Signals respectively — see §A2, §A3. They are `TuningSettings` members surfaced under Strategy because they shape the decision, not the tuner.)*

---

## A12. GUARDRAILS → ADVANCED → Tax RULES

*Decision-time rules; distinct from Results → Tax **outcomes**.*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `taxSettings.taxationType` | ACCOUNT (account-intrinsic) | Advanced | select (often read-only, derived from `capabilities.accountType`) | `undefined` → `"taxable"` in merge | `taxable \| roth_ira \| traditional_ira` (`types.ts:86`) | **derived from `capabilities.accountType`** when present (`brokerage→taxable`, `roth_ira→roth_ira`, `traditional_ira→traditional_ira`); shown read-only for connected brokers that report it | frictionless (usually locked) |
| `taxSettings.washSaleGuard` | **[CROSS-ACCOUNT COUPLING]** | Advanced | toggle (with coupling banner) | `true` | boolean | none | **inline-confirm to disable** — banner: "This isn't a per-account switch: a loss in any account locks the symbol everywhere." |
| `taxSettings.shortTermRatePct` | ACCOUNT | Advanced | number+unit (%) | `24` | `0 ≤ x ≤ 100` | greyed for `roth_ira` (tax-free) | frictionless |
| `taxSettings.longTermRatePct` | ACCOUNT | Advanced | number+unit (%) | `15` | `0 ≤ x ≤ 100` | greyed for `roth_ira` | frictionless |
| `taxSettings.subtractFromResults` | ACCOUNT | Advanced | toggle | `undefined` (off) | boolean | greyed for `roth_ira`/`traditional_ira` (no ST/LT gains tax on qualified) | frictionless |

**`washSaleGuard` — the CROSS-ACCOUNT COUPLING (closes Part III #8).** It sits physically in an account's Guardrails → Tax RULES but is tagged `[CROSS-ACCOUNT COUPLING]` and must **not** be rendered as a clean per-account toggle. Enforcement is authoritative and un-bypassable at `policy.ts:311` via `getUserWashSaleLockedSymbols`. Required implementation coupling:
- **Return-type change (with consumer inventory):** `getUserWashSaleLockedSymbols` today returns a flat `Set<string>` (`tax.ts:99`), consumed as `.has(symbol)` at `policy.ts:315`. To name the culprit on the Approvals card, change the return to per-symbol provenance `Map<string, { account: string; clearDate: string }>` (or a `{ locked: Set; provenance: Map }` pair to avoid breaking `.has`). **Enumerate every consumer before the change**: `policy.ts:315` (the gate), any `getWashSaleLockedSymbolsForUser` sibling that also returns a Set, and all tests asserting on the Set. Prefer a compile-time break (rename or shape change) over a silent runtime `.has` on a re-shaped value.
- **Test-account exclusion:** `tax.ts:113` maps `broker === "test" → source: "paper"`, so a **simulated** loss can currently lock a **real** taxable symbol. Filter Test out of contribution before culprit-naming ships. Acceptance: a Test-account loss does not appear in the lockout for a real taxable account.
- **Surfacing parity:** the coupling is surfaced identically on the blocked Approvals card and in Fleet (coherence A2).

---

# SCOPE B — User-scope settings (the off-rail Settings tree, ALL ACCOUNTS)

The `USER_LEVEL_POLICY_FIELDS` Set (`db-profiles.ts:20-24`) is the single source of truth and contains **exactly three** policy fields: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`. Everything else in Scope B is user identity/wiring stored outside `TradingPolicy` (in `connected_accounts`, `user_settings`, `strategy_profiles`, key stores). **Any change to which fields are user-scoped = coordinated `Set` edit + migration + per-account back-fill in one PR, gated by a round-trip read-after-write test per field** (the silent enrichment-trap CLAUDE.md warns about).

---

## B1. Settings → Account & Security

| Field | Scope | Disclosure | Control | Default | Validation | Friction |
|---|---|---|---|---|---|---|
| Identity / profile | USER | Essentials | text fields | — | — | frictionless |
| Auth providers | USER | Essentials | provider link/unlink | — | — | inline-confirm (unlink) |
| Sessions | USER | Advanced | session list + revoke | — | — | inline-confirm (revoke) |
| Account deletion | USER | Advanced | destructive button | — | — | **type-to-confirm** |

---

## B2. Settings → Connections

*Per broker link, stored in `connected_accounts` (`ConnectedAccount`, `types.ts:280`). Not `TradingPolicy` fields — these are the account-instance record.*

| Field (`ConnectedAccount.*`) | Scope | Disclosure | Control | Default | Validation | Capability gate | Friction |
|---|---|---|---|---|---|---|---|
| `broker` | USER | Essentials | select | — | `alpaca \| alpaca-mcp \| robinhood \| test` | — | frictionless |
| `environment` | USER | Essentials | select | — | `paper \| live` | Live requires valid live creds | Live = **type-to-confirm** (arm Live door) |
| `label` | USER | Essentials | text | — | non-empty | — | frictionless |
| `accountNumber` | USER | Essentials | text (read-only after link) | — | broker-supplied | — | frictionless |
| `apiKey` / `apiSecret` | USER | Essentials | password field (encrypted, connection-test) | — | non-empty; test on save | — | frictionless |
| `baseUrl` | USER | Advanced | text (gateway override) | — | valid URL | — | frictionless |
| `isActive` | USER | Essentials | primary toggle | — | one primary | — | inline-confirm |
| `capabilities.*` (`equityTrading`, `shortSelling`, `optionsTrading`, `optionsLevel`, `futuresTrading`, `cryptoTrading`, `marginEnabled`, `marginRequirementPct`, `accountType`) | USER | Advanced (read-only) | capability chips (read-only snapshot) | broker-reported; absent ⇒ `false`/`undefined` | — | — | read-only |
| `taxationType` (**deprecated** — use `capabilities.accountType`) | USER | Advanced (legacy) | select (hidden when `capabilities.accountType` present) | `undefined` | `taxable\|roth_ira\|traditional_ira` | — | frictionless |

**`capabilities.*` are the capability-gating inputs** referenced throughout Scope A (shorting, margin, options, ext-hours, account-type). They are displayed read-only here and consumed as gates elsewhere. `optionsTrading`/`optionsLevel`/`futuresTrading`/`cryptoTrading` have **no equity-strategy controls to gate today** (no options/futures/crypto config fields exist in `TradingPolicy`) — surface them as read-only capability chips only; **flag for owner** if/when options config is added.

---

## B3. Settings → Keys & Models

| Field | Scope | Disclosure | Control | Default | Validation | Friction |
|---|---|---|---|---|---|---|
| LLM provider keys | USER | Essentials | password (encrypted, connection-test) | — | test on save | frictionless |
| Market-data provider keys | USER | Essentials | password (encrypted, connection-test) | — | test on save | frictionless |
| Default `llmModel` / `llmReasoningEffort` (global default) | USER | Essentials | select | `"gpt-5.4-mini"` / `"medium"` | model id / enum | frictionless |
| MCP tools config | USER | Advanced | tool config editor | — | — | frictionless |

*Note: the account-scope `llmModel`/`redTeamLlmModel`/`llmReasoningEffort` in §A3 **override** these globals per account (merge in `getPolicy`; legacy seed via `LEGACY_STRATEGY_MODEL_FIELDS`, `db-profiles.ts:26`). These are the global defaults, not the same store.*

---

## B4. Settings → Alert delivery

*Delivery **rules** only — NOT the 🔔 Alerts chrome stream, NOT Results → Alert history. Backed by `notificationSettings` (USER, one of the 3 user-global policy fields).*

| Field (dotted path) | Scope | Disclosure | Control | Default | Range / validation | Friction |
|---|---|---|---|---|---|---|
| `notificationSettings.webhookUrl` | USER | Essentials | text (URL) | `""` | valid URL or empty | frictionless |
| `notificationSettings.enabledEvents` | USER | Essentials | multiselect | all 9 enabled (`NOTIFICATION_EVENT_TYPES`, `types.ts:30`) | subset of `fill \| block \| run_failed \| pending_approval \| kill_switch \| price_alert \| proposal_withdrawn \| limit_order_stale \| provider_degraded` | frictionless |
| Channels (email/push/SMS) | USER | Essentials | per-channel toggles | — | — | frictionless |
| Stale-order threshold (delivery) | USER | Advanced | number+unit (min) | — | integer `≥ 1` | frictionless |
| Test-send | USER | Essentials | action button | — | — | frictionless |

**`notificationSettings` stays USER-global (coherence A3, multiaccount-edge #6).** Delivery rules are a user concern; do not per-account it. This is the single source of truth (`USER_LEVEL_POLICY_FIELDS`).

---

## B5. Settings → Data & Privacy

| Field | Scope | Disclosure | Control | Default | Range / validation | Friction |
|---|---|---|---|---|---|---|
| Web-source toggles (Congress / insider / FINRA / 8-K / technicals) + staleness | USER | Essentials | per-source toggles + number (sec) | source-specific | — | frictionless |
| `marketScanCandidateLimit` | **USER** *(relabel "applies to all your accounts")* | Advanced | number (count) | `DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT` = `30` | integer `≥ 1` | frictionless |
| `marketScanOutlierReserve` | **USER** *(relabel "applies to all your accounts")* | Advanced | number (count) | `DEFAULT_MARKET_SCAN_OUTLIER_RESERVE` = `8` | integer `≥ 0`, `≤ candidateLimit` | frictionless |
| Shared data-pool consent (`poolConsent`) | USER | Advanced | toggle | — | — | inline-confirm |
| Include shared learnings (`lcSharing.includeShared`) | USER | Advanced | toggle | — | — | frictionless |
| Contribute my learnings (`lcSharing.contributeShared`) | USER | Advanced | toggle | — | — | inline-confirm |
| Observability | USER | Advanced | toggle | — | — | frictionless |
| Data export | USER | Advanced | action button | — | — | frictionless |

**`marketScan*` scope decision (LOCKED, Open Q1):** both stay **USER-global**, relabeled "applies to all your accounts" — the user funds the shared keys/data feeding scans, so scan breadth is a shared-resource setting. These are the only two genuinely-debatable scope fields; per-account is opt-in and migration-gated, and **must not ship half-migrated** (round-trip read-after-write test per field if ever moved).

---

## B6. Settings → Presets

*Library CRUD only. **Apply/capture happens in Strategy** (browse-vs-manage boundary, coherence D2). Backed by `strategy_profiles` (`StrategyProfile`: `id`, `name`, `policy`, `prompt`, `scoringWeights`, `active`, `createdAt`, `updatedAt`).*

| Field / action | Scope | Disclosure | Control | Default | Validation | Friction |
|---|---|---|---|---|---|---|
| `name` (rename) | USER | Essentials | text | — | non-empty, unique per user | frictionless |
| Delete | USER | Essentials | destructive button | — | active-reassign to oldest (`db-profiles.ts:588`) | inline-confirm |
| Version | USER | Advanced | action | — | — | frictionless |
| Share | USER | Advanced | action | — | — | inline-confirm |
| `active` flag | USER | Essentials | toggle | `false` | one active per user | inline-confirm |

**Copy-on-bind (LOCKED, P8):** applying a preset (`applyProfileToAccount`, `db-profiles.ts:547`) **snapshots** `policy+prompt+scoringWeights` into the account's `account_strategy_state` and stamps `derived_from_profile_id` — never a live link. The account's `systemState` is preserved (never auto-arms a halted account). Resync is an explicit three-way diff; any field whose resync **loosens a Live limit** inherits per-field type-to-confirm. Apply carries an account-type guard (block/hard-warn short/margin presets onto IRAs against `capabilities`) and type-to-confirm for Live targets. **The ambient `mirrorPolicyToActiveAccount` side effect is removed from all three call sites** (`db-profiles.ts:486, 512, 531`) so a preset edit can't reach a side door (P7).

---

## B7. Settings → Appearance

| Field | Scope | Disclosure | Control | Default | Range / validation | Friction |
|---|---|---|---|---|---|---|
| Theme | USER | Essentials | select | — | theme id | frictionless |
| Density | USER | Essentials | select | — | comfortable/compact | frictionless |
| Account-mode banner size (`executionBannerMode`) | USER | Advanced | select | — | `full \| compact \| hidden` (`dashboard-client.tsx:995`) | frictionless |
| Ticker logo display (`tickerLogoDisplay`) | USER | Advanced | select | `DEFAULT_TICKER_LOGO_DISPLAY` | `tile \| transparent \| off` | frictionless |
| Default landing account | USER | Advanced | select (**NON-LIVE accounts only**) | none | must be non-Live (P12 earlier-wins) | frictionless |

**Default landing account = NON-LIVE only (LOCKED, P12).** Principle 3 (scope never silently inherited, fails to neutral) kills a Live account as an auto-landing target. The select must **exclude every Live account** from its options; a Live account is never auto-selected on load.

---

## B8. Settings → Admin (role-gated)

| Field / surface | Scope | Disclosure | Control | Default | Gate | Friction |
|---|---|---|---|---|---|---|
| User allowlist | USER | Advanced | list editor | — | role-gated | inline-confirm |
| Per-user LLM usage / billing (`/admin/llm-usage`) | USER | Advanced | read-only dashboard | — | role-gated | read-only |
| Provider / connections health (`/admin/connections-health`) | USER | Advanced | read-only dashboard | — | role-gated | read-only |
| RAG coverage (`/admin/rag-coverage`) | USER | Advanced | read-only dashboard | — | role-gated | read-only |
| Transcript (`/admin/transcript`) | USER | Advanced | read-only viewer | — | role-gated | read-only |
| System-wide halt / close-only (operator override) | USER | Advanced | action | — | role-gated | **type-to-confirm** |

*All four `/admin/*` routes consolidate here (coherence E3); admin stays role-gated + conditionally rendered exactly as today — only the entry point moves. The **fate of the `/admin/*` routes themselves** (delete vs redirect vs parallel deep-link) is a Part III #1 open item — recommend keeping as redirect deep-links into Settings → Admin, mirroring the Results → History pattern.*

---

# Fields with no clean single home — flagged for owner

Per the "flag any field with no obvious new home" instruction:

1. **`activeProfileId`** (`policy.activeProfileId`, default `undefined`) — **not a user control.** It is internal provenance (which preset seeded this account's state), stamped by `applyProfileToAccount`/`activateStrategyProfile`. Surface as **read-only** in the Strategy header ("Preset: Momentum-v3") and the diverged-fields pill; never an editable field.
2. **`activeBroker`** (`policy.activeBroker`, default `undefined`) — **derived, not set.** `getPolicy` sets it from the connected account (`db-profiles.ts:365`). Read-only; reflected in the switcher chip. No control.
3. **`connectedAccountId`** (`policy.connectedAccountId`) — **derived**, set by `getPolicy` from the resolved account (`:364`). Not a control; it is the scope key itself.
4. **`accountNumber`** (`policy.accountNumber`) — **derived** from the connected account (`:366`); read-only mirror of `ConnectedAccount.accountNumber`. Editable form lives in Connections (§B2), not as a policy field.
5. **`paperMode`** (`policy.paperMode`, default `false`) — **derived, never a toggle.** `getPolicy` forces it from broker (`account.broker === "test"`, `:367`; `true` when no account, `:370`). This is the **money-reality dial** and is set by the **Connections `environment` field + broker choice**, armed by its own ritual (arm Live door) — never a free-standing checkbox. Surfaced as the PRACTICE/REAL badge, not an editable field.
6. **`paperStartingCash`** (`policy.paperStartingCash`, default `10000`) — **[ACCOUNT]**, but only meaningful for Test/Paper. Home: a small **Connections** field on Test/sim account rows ("Practice starting cash"); greyed/hidden for Live. Number+unit ($), `> 0`, frictionless. Flag: it is a policy field but conceptually belongs to the account-instance setup, not the trading guardrails — place it in Connections, not Guardrails.
7. **`ConnectedAccount` bookkeeping fields** (`id`, `userId`, `createdAt`, `updatedAt`) and **`StrategyProfile` bookkeeping** (`id`, `createdAt`, `updatedAt`) — system-managed, never rendered as controls.
8. **`AccountCapabilities.optionsTrading` / `optionsLevel` / `futuresTrading` / `cryptoTrading`** — capability inputs with **no corresponding config controls today** (no options/futures/crypto strategy fields in `TradingPolicy`). Render as read-only capability chips in Connections; **flag for owner** to add config homes if those asset classes are ever wired.
9. **Auto-tune per-weight flags** (§A2) — the `[ let the AI tune this ]` checkboxes have **no backing persisted field** in `TuningSettings` today. Either persist as a net-new `TuningSettings.scoringWeightAutoTune` map or keep session-only. **Flag for owner.**

---

# Cross-cutting acceptance criteria (every field)

1. **Scope round-trip:** each field writes to and reads back from its declared store — account fields to `account_strategy_state` (via `pickAccountFields`), the 3 user fields to `user_settings.policy` (via `pickUserFields`). A read-after-write test per user-global field is mandatory (the silent enrichment trap).
2. **Server clamps honored in UI:** `maxOrderNotional ≤ 100_000`, `maxDailyNotional ≥ 500_000 → reset`, `normalizeScoringWeights` non-negativity — the control must reflect the clamped value, not the typed value.
3. **Capability gating is data-driven:** every gated control reads `ConnectedAccount.capabilities` (never hardcoded per broker) and shows the inline explainer when disabled.
4. **Friction rule enforced at write time, not just UI:** loosening on a Live active account triggers the per-field confirm; the server-side write-time `accountId` validation (P2) is the real boundary regardless of client friction.
5. **Consequence preview derives from the same field definition that renders the control** — never a parallel copy list (feeds the settings search index too).
6. **No `openSettings` points at a relocated section** (merge gate) — the 6 sites at `dashboard-client.tsx:1514, 1555, 1562, 1583, 1709, 1818` navigate to the new destination, not a gutted modal.

**Relevant source files (absolute):** `/home/user/agentic-trading/src/lib/types.ts`, `/home/user/agentic-trading/src/lib/defaults.ts`, `/home/user/agentic-trading/src/lib/db-profiles.ts`, `/home/user/agentic-trading/src/lib/tax.ts`, `/home/user/agentic-trading/src/lib/policy.ts`, `/home/user/agentic-trading/src/lib/scan-settings.ts`, `/home/user/agentic-trading/app/dashboard-client.tsx`, `/home/user/agentic-trading/docs/settings-navigation-redesign.md`.

---

## Forward-looking / optional fields (additive, default-off — absence is NOT a bug)

These backend fields landed (or are landing) on other branches after this spec's `0f6bf0a` baseline, so
the grounding field catalog above does not include them. They are **additive, default-off, and have no UI
dependency** — the redesign works whether or not they are surfaced. They slot cleanly into homes the design
already defines, so exposing them is a small follow-on, never a blocker. Relayed by the owner 2026-07-01.

| Field | Type / default | New home | Scope | Disclosure | Control | Notes |
|---|---|---|---|---|---|---|
| `policy.llmFallbackModels` | `string[]`, default `[]`/off | **Strategy → AI Review** | `[ACCOUNT]` | Advanced (optional) | ordered model list (add/remove/reorder) | Fallback LLM chain if the primary model fails; render below the Bull/Red-Team model pickers. If omitted, the field simply isn't shown — backend behavior unchanged. |
| `policy.tuning.gateOnRationaleCollapse` | `boolean`, default `false` | **Guardrails → Learning/Tuning params** | `[ACCOUNT]` | Advanced (optional) | toggle "Gate on rationale collapse" | A learning-safety gate; sits with the other `tuning.*` params. Consequence copy: "blocks proposals whose rationale has collapsed to boilerplate." |
| `trade_proposals.prompt_version` | column, populated | **provenance only** | n/a (per-proposal) | — | read-only chip | Pure data/provenance. *Optional* surfacing: a small "prompt vN" chip on the **Approvals** evidence rail and/or **Results → History**. Never required; see `06-data-model-and-api-changes.md` (provenance). |

**Rule for future authors:** treat these three as Optional/Advanced. Their absence from a screen is a
deliberate default, not a missing feature — do not file it as a bug or auto-expose them without a product call.
