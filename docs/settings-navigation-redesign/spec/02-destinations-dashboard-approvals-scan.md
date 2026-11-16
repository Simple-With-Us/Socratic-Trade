# Destination Specs — Dashboard, Approvals, Scan

**Author:** Destination spec (Dashboard / Approvals / Scan) · **Date:** 2026-07-01 · **Status:** build-ready, gated behind `NAV_V2`
**Canonical parent:** [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2). This document does not restate the frame, principles, or migration plan — it goes deep on three of the six destinations. Wherever this doc says "see parent," it means the section of that file. **Wireframe references:** Dashboard = parent Screen 1/Fleet; Approvals = parent **Screen 2**; Scan = parent §"Scan resolved (D3)" + migration table row *Workspace tab: Market Scan*.

All three destinations are **account-scoped** (parent Principle 1). The active-account chip, the money-reality badge (`PRACTICE`/`REAL MONEY`, word-class first — parent P5), and the authority chip (`Propose`/`Decide`) frame every screen below and are rendered by the global shell (`app/(shell)/layout.tsx`, Phase-5 P0), **not** re-implemented per destination. Each destination header re-echoes the chip so scope is never ambiguous (parent §Multi-account, mechanism #1).

Shared naming used throughout:
- `activeAccountId` — the ephemeral **view-scope** pointer (per-tab, plural-safe, post-P2). Distinct from execution-scope arming. Until P2 ships, switching is not free (parent P2 / Edge "Mid-task switch").
- `fleetMode` — boolean, `true` when the switcher = **All accounts**. Suppressed entirely for single-account users (parent P11).
- Route seed: `/a/:accountId/<destination>` (thin catch-all `[accountId]`, parent P4/Open Q4). The URL is a **seed only**; server-side write-time `accountId` validation against the session is the real safety boundary (parent P3). Reads may render from the seed; **no mutation trusts the URL.**

---

## 1. DASHBOARD

### 1.1 Purpose

Answer one question on load: **"What is this account's agent doing right now, and does anything need me?"** (parent IA table, row 1). It is a **read-and-orient** surface — the single at-a-glance operational picture for the active account. It surfaces the top of the approval queue but is **not** where approvals are worked (that is Approvals). In `fleetMode` it becomes the **read-and-triage Fleet roll-up**: no trade is ever placed from the roll-up (parent §Fleet view).

Data source: `GET /api/dashboard` → `getDashboardSnapshot(userId, …)` (`src/lib/dashboard.ts:476`), plus the SSE `GET /api/events/stream` for live deltas. The snapshot already carries every field the single-account Dashboard needs — `policy`, `portfolio`/`displayPortfolio`, `positions`/`displayPositions`, `scheduler`, `macroBoard`, `pendingProposals`, `dailyStats`, `connectedAccounts`, `regimeScorecard`. Fleet aggregation is a **new N-account endpoint** (parent P5 deferred milestone; §1.9 below).

### 1.2 Layout regions

Single-account (default rendering, parent P11):

```
┌ Dashboard — Roth IRA · Alpaca [ PAPER · practice ]        next run 14:32 (in 6m) · last 14:02 ┐
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ REGION A · ACCOUNT STATE STRIP   equity · cash · buying power · day P&L · open positions count │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ REGION B · MACRO / REGIME STRIP  regime chip · VIX/VVIX/SKEW · breadth · earnings-yield        │
├───────────────────────────────────────────┬──────────────────────────────────────────────────┤
│ REGION C · AGENT STATE CARD               │ REGION E · GUARDRAIL-BUDGET GAUGES               │
│  running/paused/tripped · next-run · last │  daily notional used · drawdown vs HWM · net exp │
│  · run-once (stamped) · STOP echo         │  · hourly notional · gross exp · proposals/run   │
├───────────────────────────────────────────┴──────────────────────────────────────────────────┤
│ REGION D · POSITIONS (attributed to producing strategy)                                        │
│  symbol · qty · mkt val · unreal P&L · thesis tag · entry regime · preset-at-entry · bracket   │
├───────────────────────────────────────────┬──────────────────────────────────────────────────┤
│ REGION F · TOP-N APPROVAL QUEUE (peek)    │ REGION G · WATCHLIST RAIL                         │
│  up to 3 cards · "N pending → Approvals ›" │  watchlist symbols · quote · score · scan drill  │
└───────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

`fleetMode` replaces Regions A–G with the **Fleet grid** (§1.9).

### 1.3 Components — every one, with backing fields

**Region A — Account state strip** (`<AccountStateStrip>`)
- Equity: `snapshot.displayPortfolio.totalMarketValue`. Cash: `.cash`. Buying power: `.buyingPower`.
- Day P&L: derived from `snapshot.dailyStats` (absolute + %). Green up / red down; never color-only — prefix `▲/▼` + signed value.
- Open positions count: `snapshot.displayPositions.length`.
- Money-reality note inline: `PAPER · practice money` — echoes chip (parent P5). For Live, the viewport red hairline is painted by the shell, not here.
- **Test/Paper/Live provenance:** the strip reads `displayPortfolio` (which the snapshot already resolves to the account's environment). Never label a Paper number "real."

**Region B — Macro / regime strip** (`<MacroRegimeStrip>`)
- Backing: `snapshot.macroBoard` (`src/lib/dashboard.ts:447`): `.regime` (`determineMarketRegime(macro)`), `.derived` (earnings yield etc.), `.signals` (VIX/VVIX/SKEW via `getMarketSignals`), scan `breadthPct` from `snapshot`'s latest scan when present.
- Regime chip label text is the same deterministic regime stamped on every proposal (`TradeProposal.entryMarketRegime`) and candidate (`CandidateEvidence.regime`) — so the Dashboard regime, an Approvals card's `entryMarketRegime`, and `Results→regimeScorecard` always read the same string. **Acceptance:** regime chip text === `macroBoard.regime`.
- This strip **absorbs the retired Macro workspace tab** (parent migration table). Full macro detail lives in Results; this is the ambient supervisor cue only. A "Macro detail ›" deep-link opens Results→Macro.
- Deep-link out: clicking VIX/breadth opens Results→Macro anchored to that metric.

**Region C — Agent state card** (`<AgentStateCard>`)
- State machine label from `snapshot.policy.systemState` (`SystemState`: `active | halted | close_only | liquidating`, `types.ts:386`) crossed with `snapshot.policy.strategyAuthority` (`propose | decide`, `types.ts:396`). Rendered as one of: **Running (Propose)** · **Running (Decide)** · **Paused** · **Close-only** · **Tripped — <breaker>** · **HALTED**.
  - Tripped source: most-recent `kill_switch`/`policy_violation_*` audit event in `snapshot.auditFeed` (breaker reason string). "Tripped" is visually distinct (amber) from operator "HALTED" (red).
- **Next-run countdown / last-run:** `snapshot.scheduler.nextRunAt` and `.lastRunAt` (`src/lib/scheduler.ts:99`). Render `next run 14:32 (in 6m)`; when `nextRunAt === null` show `next run — (market closed)` or `— (not scheduled)` depending on `marketSession` (`snapshot.marketSession`). **Autonomy-reset banner:** if the account's autonomy was force-dropped to Propose by the restart-reset (§1.8, net-new), show an inline amber ribbon `Autonomy reset to Propose on restart — re-arm in Guardrails ›` deep-linking to Guardrails→Autonomy.
- **▶ Run once** — mirror of the chrome button, **stamped with target** (`Run once — Roth IRA · PAPER`, parent novice #1). Disabled with actionable copy when `snapshot.llmConfigured === false` ("Add an LLM key in Settings → Keys & Models"). Posts to `POST /api/strategy/run`. On a Live target it inherits the arm ritual — the Dashboard Run button can **never** silently fire Live (parent Screen 1 annotation; §Approvals mode gating is the same gate).
- **STOP echo:** the card shows the current halt state and *by whom* (actuator / auto-trip / operator — parent §Halt-state model). The actual STOP button lives in chrome; Dashboard is the one place that answers "what is halted and by whom" (parent §Halt-state model, single canonical answer).

**Region D — Positions attributed to producing strategy** (`<AttributedPositionsTable>`)
- Rows from `snapshot.displayPositions` (`EquityPosition`: `symbol, quantity, averageCost, marketValue, sector, industry`).
- **Attribution columns (the load-bearing requirement):** each open position is joined to the proposal that opened it to display **thesis tag** (`TradeProposal.tradeThesisTag`), **entry regime** (`TradeProposal.entryMarketRegime`), and **preset-at-entry** (the account's `derived_from_profile_id` snapshot at fill time). Join path: position `symbol` → most-recent opening fill → its `proposalId` → `getProposal` → `proposal.tradeThesisTag/entryMarketRegime`. Where no proposal is found (manual/pre-existing position), show `—` in the thesis/regime cells and tag the row `unattributed` (never fabricate an attribution — parent CLAUDE.md "never label real data mock/fallback").
  - **Build note (new join):** the snapshot's `symbolMetaBySymbol` (`dashboard.ts:495`) already carries per-symbol meta; extend the Dashboard builder to attach `{ thesisTag, entryRegime, presetAtEntry }` per open symbol by resolving the opening fill's proposal. This is a **read-time join in `getDashboardSnapshot`**, not a new table. Acceptance: a position opened by an approved proposal shows that proposal's exact `tradeThesisTag`.
- Bracket column: from the position's live bracket legs (TP/SL) when broker-held (`robinhoodBrokerStops`) or synthetic; show `TP $151 / SL $134` or `— no bracket` (amber if a stop-loss is expected by policy but absent).
- Row click → Symbol drilldown overlay (existing pattern, dashboard-client `tickerScan`), which offers "Open in Scan ›" and "View proposal history ›".

**Region E — Guardrail-budget gauges** (`<GuardrailBudgetGauges>`) — see §1.5.

**Region F — Top-N approval queue (peek)** (`<ApprovalQueuePeek>`)
- Shows up to **3** highest-priority pending proposals from `snapshot.pendingProposals` (already performance-annotated as `pendingProposalsWithPerf`, `dashboard.ts:508`). Priority order: (1) expiring-soonest, (2) highest `confidenceScore`, (3) newest.
- Each peek card is a **compact** version of the Approvals card (§2.4): `BUY NVDA 120sh (~$14,400)`, thesis tag + confidence, and a single **"Review ›"** that deep-links to `/a/:id/approvals#<proposalId>`. **No Approve/Reject affordance on the Dashboard peek** — approvals are worked in Approvals only, to preserve one approval home (parent Assistant/Scan "two approval homes" bug).
- Header: `N pending → Approvals ›`. Zero pending → collapsed empty state (§1.6).

**Region G — Watchlist rail** (`<WatchlistRail>`)
- Symbols from `snapshot.policy.additionalSymbols` (watchlist) plus current holdings not already shown. Per row: symbol, live quote + intraday %, composite `score` (from the latest scan's `quotesBySymbol`), and a spark of `sectorRelStrength` when available.
- Each row → Scan drilldown (deep-link into Scan anchored to that symbol) and a "＋ add to watchlist" / "－ remove" affordance that PATCHes `additionalSymbols` via `/api/watchlist` (account-scoped write; server validates `accountId`).

### 1.4 Account-state framing

Every region reads only the active account's slice. When `activeAccountId` is unresolved (multi-account user, stale id, post-restart), the Dashboard renders the neutral **"Pick an account to continue →"** gate with the switcher auto-opened (parent §Global frame). For a **single-account** user a stale id **auto-resolves to the sole account** (parent P11/Open Q7) — Dashboard never blocks a single-account user.

### 1.5 Guardrail-budget gauges (detail)

Three primary gauges + a fold of secondary caps. Each is a `used / cap → remaining` bar with the plain-English consequence preview (parent §"Woven through every control"). All values are **live budget**, not config (config lives in Guardrails; these are the runtime meters).

| Gauge | Used (numerator) | Cap (denominator) | Source |
|---|---|---|---|
| **Daily notional used** | today's executed notional | `policy.maxDailyNotional` (sizing) | `snapshot.dailyStats.dailyNotionalUsed` (see `types.ts:842`) / policy cap |
| **Drawdown vs high-water** | current equity drop from HWM | `policy.riskRules.maxDrawdownPct` | `dailyStats` + breaker state |
| **Net exposure** | current net `Σ marketValue` / equity | `policy.maxNetExposurePct` | `displayPositions` + policy |
| Hourly notional *(fold)* | rolling-60m executed | `policy.maxHourlyNotional` (`types.ts:411`) | dailyStats/rolling |
| Gross exposure *(fold)* | `Σ|marketValue|`/equity | `policy.maxGrossExposurePct` | positions + policy |
| Proposals/run *(fold)* | this-run proposal count | `policy.maxProposalsPerRun` | latestStrategyRun |

- Color bands: green `<70%`, amber `70–90%`, red `≥90%` of cap — **plus** a text label (`8.2k of 10k used · 18% left`), never color alone.
- A gauge at/over cap shows the auto-action consequence inline: e.g. hourly-notional breach note "at cap, `strategyAuthority` auto-reverts to Propose and the order is rejected" (matches `types.ts:411` behavior).
- Each gauge title deep-links to its Guardrails field: **Dashboard gauge → Guardrails→Sizing/Exposure/Circuit-breakers** (adjust the cap). This is the concrete Dashboard→Guardrails deep-link.
- **Acceptance:** each gauge's `cap` reads the *effective* resolved policy value for the active account (user-global → preset-copied → account-override, parent 3-tier contract), and the numerator is the account-scoped runtime figure — never a cross-account sum in single-account/normal mode.

### 1.6 States

- **Loading:** skeleton per region; the strip and agent card resolve first from cached snapshot, gauges/positions stream in. No spinner over the whole page.
- **Empty (no positions):** Region D shows "No open positions. The agent will propose entries on its next run (`next run 14:32`)." Region F empty → "Nothing awaiting your decision." Region G empty → "Add symbols to your watchlist in Strategy → Signals ›."
- **Error (dashboard fetch failed):** inline banner "Couldn't load account state — retry"; last-good snapshot stays visible (stale-marked with `as of HH:MM`). SSE drop falls back to the existing 2-minute poll.
- **Zero-account / first-run:** the six destinations render greyed with the single CTA **"Connect your first account — start with Test (no real money, no broker login)"** (parent §Edge "Zero connected accounts"). A Test/local-sim pseudo-account is auto-provisioned so the user is never at true zero; Dashboard then renders normally scoped to Test.
- **Restart / autonomy-reset:** amber ribbon in Region C (§1.3) until the user re-arms. Default state after restart is **Propose-only** for every account (parent P9, net-new — §1.8).
- **Fleet mode:** §1.9.

### 1.7 Interactions & deep-links

**In (to Dashboard):** default landing (`/a/:id/dashboard` or `/a/:id`); chrome "home"; palette `Go to Dashboard`; Appearance→default-landing-account (NON-LIVE only, parent P12) selects which account Dashboard opens on.
**Out (from Dashboard):**
- Region B metric → Results→Macro.
- Region C "re-arm" → Guardrails→Autonomy; "▶ Run once" → `POST /api/strategy/run`.
- Region D row → Symbol drilldown → Scan / proposal history.
- Region E gauge → Guardrails (relevant cap).
- Region F "Review ›" / "N pending →" → **Approvals** (anchored to proposal).
- Region G row → Scan (anchored to symbol); watchlist edit → `/api/watchlist`.
- Assistant slide-over is available over Dashboard (⌘K) scoped to the active account.

### 1.8 Autonomy-reset-on-restart (net-new — parent P9 / Open Q2)

**Requirement (LOCKED):** REQUIRED and DEFAULT ON. On app/process restart, every account's autonomy drops to its **safe floor (Propose-only)** until the user re-arms. This is specified net-new regardless of any equivalent today (parent Open Q2 flagged it as unverified).

**Persistence + reset mechanism (concrete):**
- Add a boot-epoch marker: a process-start timestamp `PROCESS_BOOT_ID` (or persisted `server_boot_epoch` row) established once per process start.
- Add a per-account column on `account_strategy_state` (keyed by `connectedAccountId`, parent Principle 1 schema anchor): `armed_boot_epoch TEXT NULL`. An account is considered **armed** for the current process only if `armed_boot_epoch === current boot epoch`.
- On **resolve of effective `strategyAuthority`** (the single read path used by Dashboard, Approvals, and the scheduler), coerce to `propose` whenever `armed_boot_epoch !== current boot epoch`, *even if the stored `strategyAuthority === decide`*. The stored value is preserved (so re-arm restores intent) but is **not effective** until re-armed.
- **Re-arm ritual:** arming to Decide (or Live) in Guardrails→Autonomy writes `armed_boot_epoch = current boot epoch` alongside the authority change, gated by the existing arm confirm (type-to-confirm for the two one-way doors, parent P9). Re-arm is per-account.
- **Interaction with `autoResumeOnBoot`:** the snapshot already carries `autoResumeOnBoot` (`dashboard.ts:524`). The reset **overrides** any auto-resume for the *authority* axis: even auto-resume brings an account back only to Propose; Decide always requires an explicit human re-arm. (This closes the "restart silently re-arms Decide" hazard.)
- **Migration/back-fill:** existing rows get `armed_boot_epoch = NULL` → treated as unarmed (Propose) on first boot after the migration — fail-safe. Round-trip read-after-write test per account (parent §Guardrails invariant).
- **Scheduler coupling:** the scheduler fan-out (parent Open gap C7) reads the same effective-authority resolver, so a scheduled run on an un-rearmed account can only **propose**, never auto-execute. Acceptance: after a simulated restart, a Decide account's scheduled run produces proposals with status `proposed` (queued to Approvals), not `placed`.

### 1.9 Fleet roll-up (All accounts)

Rendered when `fleetMode === true` (multi-account only; suppressed for single-account users, parent P11). **Read-and-triage only — no trade may be placed from the roll-up** (parent §Fleet).

**Layout:** aggregate header (total net worth = `Σ` per-account equity) + one **account card grid**.

**Per-account card** (`<FleetAccountCard>`), Live cards **grouped and shown first**, then Paper, then a separate **Sandbox** section for Test (parent Screen 5; Test excluded from emergency controls):
- alias · broker · money-reality badge (`LIVE · real money` red / `PAPER · practice` / `TEST`)
- authority (`Propose`/`Decide`) + halt state (`● close-only` / `‖ HALTED` / `⚠ brake`)
- equity + day P&L, open-position count, **pending-approval count**, active preset (`Momentum-v3`), last-run time, tripped-breaker banner if any
- **No Approve/Run/trade control on the card.** The only actions are **"Open ›"** (drill into that account — sets `activeAccountId`, leaves Fleet) and, for a card with pendings, **"Review N ›"** → that account's Approvals.

**Fleet emergency controls** (header, `<FleetEmergencyControls>`) — parent LOCKED decision + novice #6:
- **STOP all** and **Set all close-only** and **Pause autonomy (all)**.
- **Scope (LOCKED): halts all Live + all Paper accounts; EXCLUDES Test/local-sim.** Live accounts are **listed first** in the confirm dialog; each account echoes a **confirmed-halted** state per-account after the action.
- Confirm dialog: enumerates every affected account (Live block first, Paper block second, Test explicitly shown as *excluded — nothing real to stop*). Type-to-confirm because it touches Live.
- Wiring: **new** `POST /api/fleet/stop` (and `/close-only`, `/pause-autonomy`) mutations that iterate the user's Live+Paper accounts server-side, validating each `accountId` against the session (parent P3). Per-account result returned so the UI can echo `Robinhood · LIVE — halted ✓`. These are **deferred milestones** (parent P5) and meaningful only after P2's concurrent-arming model (§1.8) exists.
- **Acceptance:** Fleet STOP confirm lists Live first; a Test account is never in the affected set; every Live+Paper account returns `halted: true` echoed inline; a partial failure (one account errors) is shown per-account, not swallowed.

**Fleet states:** loading = card skeletons; error on the aggregation endpoint = "Couldn't load fleet — showing last-known" with per-card stale marks; a single account's sub-error degrades only its card ("data unavailable"), never the whole grid.

---

## 2. APPROVALS

### 2.1 Purpose

**"What is the AI asking me to decide, and why?"** (parent IA table, row 2; wireframe **Screen 2**). The single Human-in-the-Loop (HITL) decision home for the active account. It is the **only** place trades are approved — the Assistant and Scan explicitly are **not** second approval homes (parent §Assistant, "two approval homes" bug). In **Decide** mode the same surface becomes the reviewable **ledger** of what auto-executed, with identical evidence and a one-tap "drop to Propose."

Data: `snapshot.pendingProposals` (as `pendingProposalsWithPerf`, `dashboard.ts:508`) for the queue; `snapshot.recentProposals` for the Decide ledger. Actions hit `POST /api/proposals/[id]/approve` and `/reject` (existing routes) plus a **new** adjust endpoint (§2.5).

### 2.2 Layout regions

```
┌ Approvals — Roth IRA · Alpaca [ PAPER · practice ]   queue: 4 pending   view: ○ This account ● All accounts ┐
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌── CARD (per proposal) ─────────────────────────────┐   ┌── EVIDENCE RAIL (per selected card) ─────────┐ │
│ │ header: side/symbol/size · [acct tag] · thesis+conf │   │ Bull → Bear → Red-Team debate                │ │
│ │ POLICY GATE checklist (pass ✓ / block ⛔ w/ reason) │   │ entry anchor + drift meter                   │ │
│ │ wash-sale lockout (named + provenance) when blocked │   │ projected bracket · expiry countdown         │ │
│ │ actions row: [Approve ▸ MODE][Adjust&approve][Reject][Snooze]                                          │ │
│ └────────────────────────────────────────────────────┘   └──────────────────────────────────────────────┘ │
│ … more cards …                                                                                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 View toggle: This account / All accounts

- Segmented control `○ This account ● All accounts` (top-right). Default = **This account**. Suppressed for single-account users (parent P11 — no all-accounts concept).
- **All-accounts view:** the queue merges every account's pendings into one list; **each row is tagged with its account + mode** (`acct: Roth·PAPER`, parent Screen 2). It remains a single queue (one approval home); the account tag is provenance, not a second surface.
- All-accounts is a **read+act aggregation** — approving a row acts on that row's own account (server validates that row's `accountId`), never the "active" one. This is the safety crux: **the approve action carries the proposal's own `connectedAccountId`, never the view pointer** (parent P3). Acceptance: approving an All-accounts row whose account ≠ `activeAccountId` executes on the row's account and the server rejects any mismatch against the session's grant.

### 2.4 The HITL queue card — every element

`<ApprovalCard>` — backed by one `pendingProposals[i]` (`{ proposal: TradeProposal, status, reasons[], performanceSinceProposalPct, proposalReferencePrice, proposalCurrentPrice, … }`).

1. **Symbol / side / size:** `BUY NVDA 120 sh (~$14,400)` — `proposal.side`, `proposal.symbol`, `proposal.quantity` (or `dollarAmount`), estimated notional. Side badge colored + labeled (`BUY`/`SELL`/`SHORT`/`COVER` — all four `OrderSide` values, parent CLAUDE.md short/cover trap).
2. **Account tag** (All-accounts view only): `[ acct: Roth · PAPER ]` from the proposal's `connectedAccountId` → `snapshot.accountLabelById`.
3. **Thesis tag + confidence:** `thesis: momentum-breakout · confidence 0.72` — `proposal.tradeThesisTag`, `proposal.confidenceScore`.
4. **Bull → Bear → Red-Team debate** (evidence rail): the three-stage review with the Red-Team conviction line (`"conviction 0.68 > 0.60 threshold ✓"`). Sourced from the proposal's persisted review record (Red-Team model + `redTeamConvictionThreshold`). Collapsed by default; expands per card. If a proposal was Red-Team-**rejected** it does not appear as pending (it never reaches the queue) — but a "why was X not proposed" trace is reachable via Scan→skipped (§3).
5. **Policy-gate checklist:** the deterministic gate results as `✓ pass` / `⛔ block` rows with **plain-language reasons**, computed by the same `evaluateProposal`/policy engine (`src/lib/policy.ts`) that gates execution — **not** a re-derived client list. Examples (real gate reasons): `✓ size ≤ 15% NAV`, `✓ daily notional ok`, `✓ sector cap`, `✓ stop-loss attached`, `⛔ projected short exposure exceeds maxShortExposurePct`. A blocked proposal shows its exact `reasons[]` strings from the snapshot.
6. **Wash-sale lockout (named, with provenance)** — see §2.7.
7. **Entry anchor + drift meter:** anchor = `proposal.referencePrice` (`types.ts:605`, the decision-time price); live drift = `(currentPrice − referencePrice)/referencePrice`, compared against `policy.maxEntryDriftPct` (`proposal`/policy). Render `Entry anchor $141.20 · drift +0.4% ▁▂▃` with amber when drift approaches the cap and **⛔ block** when it exceeds it (the gate itself blocks; the meter explains).
8. **Projected bracket:** `TP $151 / SL $134` from `proposal.bracketTakeProfit` / `bracketStopLoss` (+ `bracketStopLimit` if stop-limit). If policy expects a stop and none is attached, show `⛔ stop-loss required` (matches `policy.ts` size-less/stop-less rejection).
9. **Expiry:** countdown to the proposal's expiry (`expires 14:30`); expired proposals drop from pending and move to the ledger as `expired`.
10. **MODE badge ON the Approve button** — see §2.6.

### 2.5 Actions

Row: **`[ Approve ▸ MODE ]  [ Adjust & approve ]  [ Reject ]  [ Snooze ]`**

- **Approve ▸ MODE** → `POST /api/proposals/[id]/approve`. Body carries `liveConfirmation` (`LiveApprovalConfirmation`, `strategy.ts:116`: `{ proposalId, accountNumber, executionMode, estimatedNotional, typedText }`) **only when the target is Live** (§2.6). On success → `executeProposal`; card moves to ledger with fill/placed status. Server re-runs the gate at execution time (approval is not a bypass).
- **Reject → reason feeds learning** → `POST /api/proposals/[id]/reject`. **Required change:** the reject route currently takes no reason (`app/api/proposals/[id]/reject/route.ts` calls `rejectProposal(id, userId)` with no reason). Spec: add an optional-but-prompted **reason** field (free text + a small taxonomy chip set: `bad thesis` / `wrong size` / `bad timing` / `don't like symbol` / `other`). The reason is persisted with the rejection and fed to `recordRejectedProposalCounterfactual` (already imported in `strategy.ts:37`) so the learning loop correlates the human veto with the counterfactual forward return. Acceptance: a rejection with a reason writes both the rejection status and a learning record carrying that reason; an empty reason is allowed but the chip taxonomy is offered first.
- **Adjust & approve → re-runs the FULL policy gate** (parent novice #12): opens an inline editor for `quantity`/`dollarAmount` (and optionally limit). On submit it **re-evaluates the edited proposal through the complete policy gate** before executing — an edited size is never a gate bypass. **New endpoint** `POST /api/proposals/[id]/adjust-approve` (or approve with an `adjustment` body) that (a) applies the edit, (b) re-runs `evaluateProposal` on the new size, (c) if it now blocks, returns the new `reasons[]` and does **not** execute, (d) if Live, re-derives `estimatedNotional` and **always re-confirms final size** (parent P9 — "armed once is not consent for unlimited frictionless real orders"). Acceptance: adjusting a size upward past a cap returns a block with the fresh reason and executes nothing; adjusting on Live re-prompts the typed confirm with the new notional.
- **Snooze** → removes the card from the active queue for a chosen interval (`15m / 1h / next run / EOD`) without rejecting; it re-surfaces at expiry of the snooze if still valid (not past proposal expiry). Snooze is a client/queue-state action (persist a `snoozedUntil` per proposal); it never touches execution.

### 2.6 MODE badge on the Approve button (money-reality binding)

- The badge is rendered **on** the Approve control: `Approve ▸ PAPER`, `Approve ▸ LIVE`, `Approve ▸ TEST` — money-reality bound to the exact commit action, not just the header (parent Screen 2). Word + color (parent P5): `PAPER`/`TEST` = practice (grey/blue), `LIVE` = **REAL MONEY** red.
- Target mode is derived from the proposal's own account (`connectedAccountId` → environment/broker), **not** the view pointer — so an All-accounts Live row shows `Approve ▸ LIVE` even while viewing from a Paper account.
- **Live gate:** clicking `Approve ▸ LIVE` triggers the arm/confirm ritual: the server returns `LiveApprovalConfirmationError` (`code: LIVE_CONFIRMATION_REQUIRED`, `reasons`, `expectedText`) if `liveConfirmation.typedText` doesn't match `liveApprovalText(symbol)` (`strategy.ts:1396`). The UI shows the typed-confirm modal seeded with `expectedText`, then re-POSTs with the full `liveConfirmation`. **First Live approval of a session (or after idle)** always confirms even if the account is armed (parent P9). Acceptance: a Live approve without matching typed text 409s and executes nothing; with matching text it executes.

### 2.7 Wash-sale lockout — named with provenance (LOCKED)

Enforcement is **already authoritative and un-bypassable** (`policy.ts:311–325`, `getUserWashSaleLockedSymbols` resolved server-side even if the caller omits the set). The design work is **surfacing**, and it requires a return-type change with a full consumer inventory (parent Open gap C8).

**Card rendering when a BUY is wash-sale-blocked:**
```
⛔ WASH-SALE LOCKOUT
   locked by a loss in  Robinhood · LIVE
   clears Jul 24 · cross-account tax coupling
```
- Drawn as a **third, cross-account tax-coupling class** (parent §Cross-account wash-sale) — **not** a per-account toggle. Same treatment on the blocked card and in Fleet.

**Required return-type change + consumer inventory (closing parent gap C8):**
- Change `getUserWashSaleLockedSymbols(userId, now)` (`src/lib/tax.ts:110`) and its helper `getWashSaleLockedSymbolsForUser(accounts, now, userId)` (`tax.ts:99`) from `Set<string>` to a provenance-carrying map:
  ```ts
  type WashSaleLockout = { symbol: string; contributingAccountId: string; contributingAccountLabel: string; source: FillSource; clearDate: string /* ISO */ };
  type WashSaleLockoutMap = Map<string, WashSaleLockout>; // keyed by normalized symbol; earliest clearDate wins on union
  ```
- **Consumer inventory that MUST be updated in the same PR** (compile-time break, not a runtime `.has` on a reshaped value — parent's inverted silent-write trap):
  1. `src/lib/policy.ts:319–322` — the gate consumes it as `Set<string>` with `.has(symbol)`. Change to `lockedSymbols.has(symbol)` → `lockoutMap.has(symbol)` (Map also has `.has`), and pass the matched `WashSaleLockout` into the reason string so the *server-side reason* itself names the culprit (so the Approvals card's `reasons[]` already carries provenance without a second lookup). Keep the enforcement semantics identical.
  2. `context.washSaleLockedSymbols` (the pre-populated caller path, `policy.ts:320`) — its type widens to `WashSaleLockoutMap`; audit all constructors of policy `context` (tests included — grep `washSaleLockedSymbols` across `src/lib` and `test/`).
  3. Any test asserting on the `Set` return shape (grep `getUserWashSaleLockedSymbols`, `getWashSaleLockedSymbolsForUser` in `test/`).
  4. Fleet card wash-sale banner (§1.9) reads the same map.
- **Test-account exclusion (LOCKED correctness fix):** `tax.ts:113` currently maps `broker === "test" → source: "paper"`, so a **simulated** loss can contribute a lockout onto a **real** taxable account. Filter Test out of contribution *before* building the map: skip any `AccountTaxContext` whose account is a Test/local-sim account (parent §Edge "Test/sim classification"). Acceptance: a loss realized in the Test account produces **no** lockout entry on any real account; a loss in a real taxable account still locks rebuys everywhere including IRAs (existing IRA logic at `tax.ts:102` unchanged).
- **Degradation:** until the return-type change ships, the card degrades to the generic `locked by a wash-sale in another account · clears <date>` — never fabricate a culprit account.

### 2.8 Decide-mode ledger

When the account's **effective** authority is `decide` (post-restart-reset resolved, §1.8), Approvals renders as a **reviewable ledger** of what auto-executed:
- Rows from `snapshot.recentProposals` (perf-annotated) with status `placed`/`paper`/`filled`, showing **identical evidence** to a pending card (thesis, confidence, policy-gate result that passed, bracket, entry drift at execution).
- Each row: **"Drop to Propose"** one-tap → sets `strategyAuthority = propose` for this account (writes via Guardrails→Autonomy path; account-scoped, server-validated). This is the "instant de-escalation" affordance (parent IA row 2).
- The ledger and the queue coexist: in Decide mode, anything the gate *blocks* still surfaces as a pending card needing a human (Decide never auto-executes a blocked proposal); the ledger is only the auto-executed stream.
- Acceptance: in Decide mode, an auto-executed proposal appears in the ledger with its passing gate checklist; a blocked one appears as a normal pending card; "Drop to Propose" flips authority for that account only.

### 2.9 States

- **Loading:** card skeletons; the count header resolves first.
- **Empty:** "Nothing awaiting your decision." + a hint of `next run 14:32` and a "Run once" affordance (same gating as Dashboard). In Decide mode with an empty ledger: "No auto-executed trades yet this session."
- **Error:** approve/reject failures surface inline on the card (`system_stopped` 409 → "System is stopped — clear the STOP to act"; 404 → "Proposal no longer exists — refreshing"). Never silently drop a card on error.
- **System-stopped:** when `isProposalActionStopped(policy)` is true (STOP engaged), all approve/adjust/reject controls are disabled with the `STOPPED_PROPOSAL_ACTION_MESSAGE`; the queue is still readable.
- **Zero-account / unresolved scope:** same neutral gate as Dashboard (§1.6); no proposals exist without an account.
- **Fleet interaction:** there is no "Fleet Approvals" surface; the All-accounts toggle is the multi-account queue. Drilling from a Fleet card's "Review N ›" opens Approvals in All-accounts view anchored to that account's rows.

### 2.10 Deep-links

**In:** Dashboard Region F peek; Fleet card "Review N ›"; chrome 🔔 Alerts `pending_approval` event; palette `Go to Approvals`; `pending_approval` push notification; `/a/:id/approvals#<proposalId>` (anchor scrolls+expands the card).
**Out:** card symbol → Scan (candidate detail) / Dashboard position; "why is this risky?" → Assistant slide-over scoped to the card; rejected/expired → Results→History; a blocked-by-wash-sale culprit account name → that account's Results→Tax (the realizing loss).

---

## 3. SCAN

### 3.1 Purpose

**"What did research surface, independent of any one proposal?"** (parent IA table, row 3). A **read-only, secondary** destination (not a co-equal primary verb) — ranked candidates, factor scores, web-signal bulletins, and the skipped-candidate view. **It never edits config and never places a trade** (parent §"Scan resolved (D3)"). It is browsable independently of a proposal, which is exactly why it earns destination status while staying one level down (reachable from Dashboard drill-down and the rail "more", parent Screen 1 spine `(Scan / more ›)`).

Data: `GET /api/scan` → `MarketScan` (`types.ts:708`). The Dashboard's symbol drilldown already fetches a ticker scan; Scan is the full table.

### 3.2 Layout regions

```
┌ Scan — Roth IRA · Alpaca [ PAPER ]   (read-only research)   source: nasdaq+finnhub+yahoo · as of 14:01 · breadth 58% ┐
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ toolbar: [ column picker ▾ ] [ view: ● Candidates ○ Skipped ] [ 🔍 filter ]     scanned 512 · returned 40           │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ RANKED CANDIDATE TABLE                                                                                                 │
│  # · symbol · price · Δ% · score · factor breakdown (8) · sector · analyst · congress · insider · bulletins · asOf   │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ WEB-SIGNAL BULLETINS (per selected row)   ·   FACTOR DETAIL (per selected row)                                        │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Components

**Header / provenance strip**
- `source` = `MarketScan.source` — the `+`-joined **derived** provider list (parent CLAUDE.md "don't hardcode a provider name"; e.g. `nasdaq-delayed-screener+finnhub+yahoo-finance`).
- `generatedAt` → `as of 14:01`; `scannedSymbols` / `returnedQuotes`; `breadthPct` (advancing %); `candidateLimit` / `outlierReserve` / `outlierCandidateCount`.
- `warnings[]` render as an inline amber note (e.g. degraded provider), never dropped.
- **Read-only banner:** a subtle `research · read-only` chip so no user expects to trade here.

**Ranked candidate table** (`<ScanTable>`) — rows = `MarketScan.topCandidates` (`MarketQuote[]`):
- Rank, `symbol` (+ `companyName`), `price`, `intradayChangePct`, composite `score`.
- **Factor scores:** `factorBreakdown` (`MarketFactorBreakdown` — the 8 `ScoringWeights` factors + `weightedTotal`) as a compact 8-cell heat row; hovering a cell shows the factor's contribution.
- Enrichment columns (opt-in via column picker): `sector`, `analystRating`/`analystScore`, `senateTrades`/`congressCompositeScore`+`congressCompositeDirection`, `insiderSentiment`, `shortPercentOfFloat`, `beta`, `peRatio`, `fcfYield`, `debtToEquity`, `sectorRelStrength`, `technicalScore`/`technicalDirection`/`technicalSignals`, `vwap`, price targets (`targetMean/High/Low/Median`).
- **P/E display rule (parent CLAUDE.md):** `"n/a"` = negative/zero earnings (real "no ratio"), `"-"` = data unavailable — decided by `eps`. Never interchangeable, never a fabricated number.
- **Per-field source attribution:** each enriched cell carries a single-source tooltip from `MarketQuote.sources` (`EnrichmentSources`) — parent CLAUDE.md per-field enrichment sourcing. `-`/`n/a` when a value never arrived; never a mock tier.
- Column picker persists to the existing `scan-visible-cols` localStorage key (client-only display state).

**Web-signal bulletins** (`<ScanBulletins>`) — per selected row: `MarketQuote.evidenceBulletins` (1-line backend web-source bulletins: congress, insider, 8-K, technicals). Congress detail can expand `congressCompositeComponents`/`congressCompositeProvenance`.

**Skipped view** (`view: ○ Skipped`)
- The top-ranked-but-**not-acted** candidates for the latest run, from the per-run `CandidateEvidence` audit (`types.ts:743`, `chosen: false`). Per row: `symbol`, `score`, `factorBreakdown`, `regime`, `refPrice` (counterfactual anchor), and — when learning has matured — forward-return since `refPrice`. This is the "why wasn't X proposed?" surface, and it is where an Approvals "why not proposed" deep-link lands. Read-only.

### 3.4 States

- **Loading:** table skeleton; header provenance resolves first from `cached` scan when present.
- **Empty (no candidates):** "No candidates in the last scan." + `Run a scan` hint (which triggers a strategy/scan run via the normal run path — still not a trade). If `topCandidates` is empty the Dashboard's `fullMarketScan` guard (`dashboard.ts:538`) also treats it as absent — Scan shows the empty state, not a broken table.
- **Cached / stale:** when `MarketScan.cached === true`, show `cached · as of HH:MM` and the `cacheTtlMs` remaining; never present cached as live.
- **Error / degraded:** `warnings[]` inline; a full fetch failure shows "Couldn't load scan — retry" with last-good table stale-marked.
- **Zero-account:** Scan is account-scoped (its universe/floors come from the account's `policy` — `includedIndices`, `universeFloor`, `blocklist`); with no account it shows the connect-first gate. A single-account user always resolves (parent P11).
- **Fleet mode:** Scan is inherently per-account (a scan is scoped to one account's universe); in `fleetMode` the destination shows a scope prompt "Pick an account to view its scan" rather than aggregating — there is no meaningful cross-account merged scan. (Consistent with Fleet being read-and-triage, not a config/research aggregator.)

### 3.5 Interactions & deep-links

- **Read-only everywhere:** rows expand for detail; no Approve/Adjust/trade control exists on Scan. A row's only outbound actions are **"Open in Approvals"** *if a live pending proposal exists for that symbol on this account* (deep-link, not a create-trade), **"Add to watchlist"** (the one write Scan offers — account-scoped `additionalSymbols` PATCH, server-validated), and **"Ask the Assistant about <symbol>"** (opens the slide-over scoped to the row).
- **In:** Dashboard Region D position drilldown; Dashboard Region G watchlist row; chrome spine `(Scan / more ›)`; palette `Go to Scan` / `Scan <symbol>`; Approvals card symbol → Scan candidate detail; Approvals "why not proposed" → Scan→Skipped.
- **Out:** symbol → Approvals (if pending) / Dashboard position (if held) / Assistant.

### 3.6 Account-state framing

Scan reflects the active account's **strategy universe** (indices, floors, blocklist from `policy`) and its **scoring weights** (the `score`/`factorBreakdown` are computed with the account's effective weights). Two accounts with different presets viewing "the same market" see **different rankings** — the header's account chip makes that explicit so a user never mistakes one account's scan for another's. The two scan-**breadth** knobs (`marketScanCandidateLimit`, `marketScanOutlierReserve`) are **USER-GLOBAL** (parent LOCKED: relabel "applies to all your accounts" because the user funds the shared keys/data feeding scans) — Scan's header shows the resulting `candidateLimit`/`outlierReserve` as user-global values, not per-account overrides.

---

## 4. Cross-destination acceptance criteria (build gate)

1. **No trade is placeable from Dashboard (peek or Fleet) or from Scan.** Only Approvals mutates execution. Grep gate: no approve/execute call originates from Dashboard/Scan components.
2. **Every mutation carries the proposal's/target's own `accountId`, never the view pointer**, and the server validates it against the session (parent P3). All-accounts approve on a non-active row executes on the row's account.
3. **MODE badge is on the Approve button** and derived from the proposal's account; Live approve requires the typed `liveConfirmation` (`strategy.ts:116/1396`).
4. **Adjust-and-approve re-runs the full gate**; an over-cap adjustment blocks and executes nothing; Live adjustment re-confirms final size.
5. **Reject carries a reason into `recordRejectedProposalCounterfactual`** (reject route extended).
6. **Wash-sale surfacing:** provenance map replaces the flat `Set`; all consumers (starting `policy.ts:319`) updated in one PR; a **Test-account loss never locks a real account** (`tax.ts:113` filtered).
7. **Autonomy resets to Propose on restart** (per-account `armed_boot_epoch`); a Decide account after restart auto-executes nothing until re-armed; scheduler honors the same resolver.
8. **Fleet emergency STOP hits all Live + all Paper, excludes Test, lists Live first, echoes per-account halted** (`/api/fleet/*`, new).
9. **Regime string is identical** across Dashboard strip, Approvals `entryMarketRegime`, and Results scorecards.
10. **Single-account users** get static chip, no scope tags/Fleet/origin badges, and stale ids auto-resolve (parent P11/Open Q7); multi-account users keep fail-closed + the neutral "pick an account" gate.
11. **Mobile parity (spec now, build later, parent §Mobile/PWA + Open Q6):** the account switcher chip, the **STOP** actuator, the **Approvals** queue with MODE-badged approve, and the Dashboard account-state + agent-state + guardrail gauges must survive on `/mobile`. The mobile command API (`src/lib/mobile-api.ts`) **must be re-pointed** off the execution singleton `setActiveConnectedAccount` (`mobile-api.ts:~649`) onto the P2 view-scope/arming split — otherwise mobile becomes the surviving side-door that re-introduces the coercion P2 deletes (parent gap C3). Mobile approve inherits the identical Live arm ritual.

**Key files:** `src/lib/dashboard.ts` (snapshot + new position-attribution join + Fleet endpoint feeders), `app/api/dashboard/route.ts`, `app/api/proposals/[id]/{approve,reject}/route.ts` (+ new `adjust-approve`, + reject-reason), new `app/api/fleet/{stop,close-only,pause-autonomy}/route.ts`, `src/lib/policy.ts:311–325` (wash-sale consumer), `src/lib/tax.ts:99/110/113` (provenance return type + Test filter), `src/lib/scheduler.ts` (effective-authority resolver honoring `armed_boot_epoch`), `src/lib/strategy.ts:116/1396` (Live confirmation), `src/lib/mobile-api.ts` (P2 re-point), `src/lib/types.ts` (new `WashSaleLockout`/attribution fields), `app/api/scan/route.ts` + `src/lib/types.ts:708` (`MarketScan`). All account-scoped writes validated server-side against the session (parent P3).
