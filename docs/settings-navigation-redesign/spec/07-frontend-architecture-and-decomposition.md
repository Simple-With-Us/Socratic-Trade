# Front-End Architecture & Decomposition Spec — Strangler-Fig Extraction of `app/dashboard-client.tsx`

**Scope of this section.** How to break the 7,015-line `app/dashboard-client.tsx` (verified: `wc -l` = 7015 at `HEAD c3b951d`) into a maintainable route-group shell + per-destination component tree **without a big-bang rewrite**. This is the buildable decomposition that underlies the six-destination IA in [`docs/settings-navigation-redesign.md`](../../settings-navigation-redesign.md) Part I and the five-phase plan in Part II-D. It closes the Part III gaps that are architectural (shim trigger #10, Studio-modal flag fate #6, mobile singleton-setter #3/#11) and defers the ones that are data-plane (arming/scheduler #7, wash-sale return type #8) to their owning specs. Every `file:line` below was re-verified against the working tree this session; where the design doc's anchors have drifted since `HEAD 0f6bf0a`, the corrected line is noted.

---

## 1. The current monolith, mapped (what we are cutting up)

`app/dashboard-client.tsx` is a single 7,015-line module holding **~45 component functions**, **3 tab/section unions**, **9 localStorage keys**, **~50 `useState` hooks in `DashboardApp` alone**, one `EventSource` SSE subscription, and every modal/overlay in the app. Two views are *already* extracted to `./ui/` (`MacroBoardView` from `./ui/macro-panel`, line 112; `AssistantView` from `./ui/assistant-console`, line 113) — **this is the precedent and target for the whole file**: every destination becomes its own `./ui/` (soon `app/(shell)/…`) module, and `dashboard-client.tsx` shrinks to a thin orchestrator.

### 1.1 Component inventory (verified line anchors)

| Component (line) | Role | Destination it maps to (§2) |
|---|---|---|
| `DashboardClient` (675) | SSR wrapper / entry export | shell entry |
| `DashboardBootstrap` (683) | client fetch of initial snapshot | shell entry |
| `DashboardSsrShell` (709) | SSR skeleton | shell chrome |
| `ConsentGate` (785) | data-pool consent gate | shell (pre-render gate) |
| **`DashboardApp` (876)** | **the orchestrator — owns ~50 hooks, SSE, all handlers, render tree** | **splits into shell + context providers + destination router** |
| `AccountMenu` (516) | profile menu (top-right, 8 items) | → `⦿ Avatar` chrome (§2.2) |
| `ReadinessStrip` (460), `StatusPill` (2065), `DailyRiskPill` (2074) | chrome status bits | → ambient-risk strip (§2.2) |
| `MobilePortfolioSummary` (2093), `PortfolioRail` (2155) | Dashboard chrome | → Dashboard destination |
| `DecisionView` (2241) | HITL proposal queue + account state | **splits → Dashboard + Approvals** |
| `MarketScanView` (2810) | scan table + col picker | → Scan (secondary) |
| `SmartMoneyView` (3203) | congress/insider | → Dashboard drill / Scan |
| `PerformanceView` (3282), `TaxView` (3357) | outcomes | → **Results** (merged) |
| `StrategyView` (3491) | strategy editor (tab) | → **Strategy** destination |
| `TuningCard` (3826) | AI-tuning diff card | **de-duplicated (§6)** |
| `StrategyStudio` (4290) | prompt+sliders+review modal | **deleted as modal, inlined into Strategy** |
| `ScoringWeights` (4473) | 8-weight sliders | → Strategy·Signals |
| `ActivityFeed` (3960), `RunHistory` (4181), `NotificationsList` (4241), `AuditLog` (4268) | the 4 feed-rail tabs | **dissolved → Dashboard + Results·History + Alerts + Results·Alert-history** |
| `MarketReplaceModal` (4037) | market-replacement confirm | → Approvals overlay |
| `SettingsContent` (4486, **~1060 lines**) | 9-section settings modal | **splits into Scope-A (→Strategy/Guardrails) + Scope-B tree** |
| `ApiKeysSection` (6170), `IntegrationsSection` (6310, ~440 lines) | settings sub-panels | → Settings·Keys&Models / Connections |
| `AccountDeletionPanel` (5547), `AccountDeletionModal` (5581) | deletion flow | → Settings·Account&Security |
| `HelpContent` (6798), `HelpSourceLink` (6752), `CongressionalTradesHelpLine` (6776) | help modal | → `? Help` chrome |
| Field primitives: `EditableParam` (3741), `NumberField` (5829), `OptionalNumberField` (5860), `RangeField` (5886), `KeyVal` (3732), `StrategyTuningModelSelect` (4449) | reusable inputs | → `app/(shell)/_components/fields/` |
| Chip/misc: `SentimentChip` (3146), `RatingChip` (3260), `ProposalTimeMeta` (2604), `TuningChangeGroup` (3895), `DetailLine` (3951) | leaf presentational | co-located with owning destination |

### 1.2 State the orchestrator owns (the hard part)

`DashboardApp` (876) holds the state that makes extraction non-trivial. Grouped by eventual owner:

- **Snapshot/data (must become shared context — §3):** `snapshot` (877), `busy` (878), `tickerScan` (927), `drilldownSymbol` (922), `learnedQueueCount` (889), `consentGate` (892). SSE subscription at **1072** (`new EventSource("/api/events/stream")`) with a fallback poll; this is the single write-point for `snapshot` and **must stay in one place** (a `SnapshotProvider`, §3.2) or every destination re-subscribes.
- **Navigation (becomes router + persisted context — §3.3):** `workspaceTab` (879, `readStoredWorkspaceTab`), `feedTab` (880, `readStoredFeedTab`), `feedOpen` (881), `settingsOpen` (882), `settingsInitialSection` (883, default `"operate"`), `accountsOpen` (884), `studioOpen` (885), `nodeEditorOpen` (886), `helpOpen` (887), `learnedQueueOpen` (888), `cmdOpen` (909).
- **Confirmations/overlays (per-destination or shell overlay):** `killConfirm` (907), `decideConfirm` (908), `liveConfirmation` (910), `replaceMarketOrder`/`replaceMarketText` (920/921).
- **Appearance (becomes `AppearanceProvider`, all localStorage-backed):** `tickerLogoDisplay` (928), `compactExecutionBanner` (929), `executionBannerHidden` (930), `hideTestAccount` (931).
- **Strategy tuning (moves with Strategy destination — §6):** `strategyTuning` (1026, `readStoredStrategyTuning`), `tuningBusy` (1027), `tuningError` (1028), `newProfileName` (1025), `promptSaveTimer` ref (1029, 800ms prompt auto-save debounce).

### 1.3 localStorage keys (verified — the migration surface, §3.4)

| Key const (line) | Value | New owner |
|---|---|---|
| `TICKER_LOGO_DISPLAY_KEY` (187) `= "ticker-logo-display"` | `tile\|transparent\|off` | Settings·Appearance |
| `EXECUTION_BANNER_COMPACT_KEY` (188), `LEGACY_EXECUTION_BANNER_HIDDEN_KEY` (189), `EXECUTION_BANNER_MODE_KEY` (194) `= "execution-banner-mode"` | banner mode (+ legacy migration already present) | Settings·Appearance |
| `HIDE_TEST_ACCOUNT_KEY` (196) `= "hide-test-account"` | bool | switcher/Sandbox |
| **`WORKSPACE_TAB_KEY` (197) `= "dashboard-workspace-tab"`** | `WorkspaceTab` | **shim source (§3.4)** |
| **`FEED_TAB_KEY` (198) `= "dashboard-feed-tab"`** | `FeedTab` | **shim source (§3.4)** |
| `STRATEGY_TUNING_STORAGE_KEY` (199) `= "strategy-tuning-proposal"` | `StrategyTuningProposal` | Strategy (unchanged; §6 compat check) |
| `scan-visible-cols-v5` (inside `MarketScanView`, ~2824) | column set | Scan (stays local) |

The three type unions and the tier helper are all in the header block: `WorkspaceTab` (**148**), `FeedTab` (**161**), `SettingsSection` (**162**), `SettingsTier` (**163**), `ACCOUNT_SETTINGS_SECTIONS` (**165**), `settingsTierForSection` (**167**), `isWorkspaceTab` (**269**), `isFeedTab` (**273**).

---

## 2. Target module layout — route-group shell + destination tree

The end state is a Next.js **route group** `app/(shell)/` that owns the persistent three-zone chrome (§design Global frame) and renders destinations as segments. `dashboard-client.tsx` is retired to a thin compatibility shim that re-exports the shell during migration, then deleted.

```
app/
  (shell)/
    layout.tsx                     # P0 — three-zone chrome; renders <ShellChrome> + <DestinationRouter>
    _providers/
      snapshot-provider.tsx        # SSE + fallback poll + snapshot state (from DashboardApp:877,1072)
      active-account-provider.tsx  # view-scope (ephemeral) — the switcher's selection (§3.1)
      appearance-provider.tsx      # ticker-logo / banner-mode / hide-test localStorage (§3.4)
      nav-provider.tsx             # DestinationTab + feed/overlay open-state + persistence shim (§3.3/3.4)
    _components/
      chrome/
        account-switcher.tsx       # LEFT zone; from AccountMenu(516) scope-half + new list
        spine-nav.tsx              # CENTER zone; DestinationTab tabs
        ambient-risk-strip.tsx     # RIGHT zone; StatusPill(2065)+DailyRiskPill(2074)+ReadinessStrip(460)
        run-stop-controls.tsx      # ▶ Run once (target-stamped) + ■ STOP (split from Halt&Flatten)
        alerts-dropdown.tsx        # 🔔 Alerts (from NotificationsList:4241, live half)
        command-palette.tsx        # ⌘K (cmdOpen:909, palette entries §5)
        help-panel.tsx             # ? Help (from HelpContent:6798)
        avatar-menu.tsx            # ⦿ Preferences (identity half of AccountMenu:516)
      fields/                      # EditableParam(3741) NumberField(5829) OptionalNumberField(5860)
                                   #   RangeField(5886) KeyVal(3732) StrategyTuningModelSelect(4449)
      overlays/
        assistant-slideover.tsx    # persistent Assistant (wraps ./ui/assistant-console AssistantView)
        drilldown.tsx              # symbol drilldown (drilldownSymbol:922 + tickerScan:927)
        confirmations.tsx          # kill/decide/live/market-replace confirms (907-921)
    dashboard/page.tsx             # Dashboard destination (PortfolioRail:2155 + DecisionView:2241 state half + macro strip)
    approvals/page.tsx             # Approvals destination (DecisionView:2241 queue half + MarketReplaceModal:4037)
    scan/page.tsx                  # Scan (secondary) — MarketScanView(2810) + SmartMoneyView(3203)
    strategy/page.tsx              # Strategy — StrategyView(3491) + inlined StrategyStudio(4290) + ScoringWeights(4473) + TuningCard(§6)
    guardrails/page.tsx            # Guardrails — Scope-A risk/sizing/exposure/execution/autonomy/tax-rules (from SettingsContent:4486)
    results/
      page.tsx                     # Results — PerformanceView(3282) + TaxView(3357) outcomes
      history/page.tsx             # canonical History (RunHistory:4181 + AuditLog:4268 + ActivityFeed:3960)
      alerts/page.tsx              # Alert history (NotificationsList:4241, log half)
      tuning/page.tsx              # Tuning queue (TuningCard review-queue view)
    settings/
      layout.tsx                   # off-rail Settings tree shell (Scope-B only)
      [section]/page.tsx           # Account&Security | Connections | Keys&Models | Alert-delivery
                                   #   Data&Privacy | Presets | Appearance | Admin
  ui/                              # existing extraction target (macro-panel, assistant-console already here)
```

**Route-group membership decision (P0, closes design §Incremental P0).** Inside `(shell)`: all six destinations + Settings + Scan. **Outside** `(shell)` (no switcher/STOP): `/login` (pre-auth). **Inside but degraded:** `/admin` (switcher + **system-halt STOP must survive** — mount `run-stop-controls.tsx` in `app/admin/layout.tsx` too), `/mobile` (switcher + STOP survive per design §Mobile; §7 resolves the singleton-setter hazard). `/welcome` renders the zero-account guided flow *inside* the shell with destinations greyed.

**`ScopeTag` and `OriginBadge` primitives** (`_components/fields/scope-tag.tsx`) render from the *already-present* data at `settingsTierForSection` (167) / `ACCOUNT_SETTINGS_SECTIONS` (165). Phase 1 surfaces these with zero new data path (design §Phase 1).

---

## 3. Where shared state lives (context boundaries)

The orchestrator's ~50 hooks split into **four providers** nested in `(shell)/layout.tsx`. Ordering matters: account-scope must wrap snapshot (a snapshot refetch is account-scoped), and nav must wrap everything so palette/deep-links can navigate.

```tsx
<ActiveAccountProvider>      {/* view-scope: which account is in view */}
  <SnapshotProvider>         {/* SSE + poll; snapshot keyed by active account */}
    <AppearanceProvider>     {/* localStorage display prefs */}
      <NavProvider>          {/* DestinationTab + overlay open-state + shim */}
        <ShellChrome/>       {/* switcher, spine, risk strip, run/stop, alerts, ⌘K, help, avatar */}
        <DestinationRouter>{children}</DestinationRouter>
        <AssistantSlideOver/> <Drilldown/> <Confirmations/>
      </NavProvider>
    </AppearanceProvider>
  </SnapshotProvider>
</ActiveAccountProvider>
```

### 3.1 `ActiveAccountProvider` — view-scope (ephemeral)
Owns the switcher's *selected* account id (view-scope only, **not** execution/arming — that split is design P2, deferred to the data-plane spec). Seeds from the `/a/:accountId` catch-all param (§4) when present, else from the persisted last-view id, else — for a single-account user — **auto-resolves to the sole account** (design novice #7); multi-account users **fail closed** to the "Pick an account →" state. Exposes `{ activeAccountId, accounts, setViewAccount, isSingleAccount }`. **Critical constraint:** `setViewAccount` must NOT call the execution singleton `setActiveConnectedAccount` until design P2 lands — until then it only re-scopes reads, and the switcher warns per design §Edge/Mid-task-switch. This provider is the seam that makes the mobile singleton-setter hazard (§7) fixable in one place.

### 3.2 `SnapshotProvider` — the one SSE owner
Lifts `snapshot` (877), `busy` (878), the `EventSource("/api/events/stream")` subscription (1072), the 2-minute fallback poll, and `tickerScan` (927). Exposes `{ snapshot, refresh, busy }` plus derived selectors (`useProposals()`, `useExecutionState()`, `usePolicy()`) so a destination subscribes to *its slice* without re-rendering on every SSE tick. **Do not** let any destination open its own `EventSource` — one subscription, fanned out via context. `MarketScanView`'s own live-scan fetch (`liveScan` at 2827, `/api/scan`) stays local; it is a user-triggered lookup, not the shared stream.

### 3.3 `NavProvider` — DestinationTab mapping + overlay state
Owns the `DestinationTab` union and the **mapping over existing `WorkspaceTab`/`FeedTab`** (design P1). Introduce (P1, no panel moves):

```ts
type DestinationTab =
  | "dashboard" | "approvals" | "scan" | "strategy"
  | "guardrails" | "results";
// Feed/overlay sub-routes:
type ResultsSub = "outcomes" | "history" | "alerts" | "tuning";

const WORKSPACE_TO_DESTINATION: Record<WorkspaceTab, DestinationTab> = {
  decision: "dashboard",   // splits later; both Dashboard+Approvals alias to it in P1
  assistant: "dashboard",  // Assistant becomes an overlay, not a destination
  market: "scan",
  macro: "dashboard",      // folds into Dashboard macro strip
  performance: "results",
  tax: "results",
  strategy: "strategy",
};
const FEED_TO_RESULTS_SUB: Record<FeedTab, ResultsSub> = {
  activity: "history", runs: "history", notifications: "alerts", audit: "history",
};
```

Also owns `feedOpen` (881), `settingsOpen` (882)/`settingsInitialSection` (883), `studioOpen` (885, retired in §6), `nodeEditorOpen` (886, Strategy-Flow overlay), `helpOpen` (887), `cmdOpen` (909), `learnedQueueOpen` (888). Exposes `navigate(destination, sub?)` and `openSettings(section)` — the latter is where the **6 relocated-section call sites** get rewritten (§5).

### 3.4 The persistence shim — resolving Part III gap #10 (the shim trigger contradiction)
Design Part III gap #10 flags a real contradiction: the shim "deletes old keys" but Phase 2 "with the flag off, old keys still drive rendering." **Resolution (build this exactly):**

- The shim runs **flag-independently on first mount**, in a dedicated `migrateNavStorage()` called from `NavProvider` init — NOT gated on `NAV_V2`.
- It **maps and writes new keys** (`dashboard-destination-tab`, `dashboard-results-sub`) but **does NOT delete the old keys for one release**. Old keys (`WORKSPACE_TAB_KEY` 197, `FEED_TAB_KEY` 198) remain as a read-fallback so a `NAV_V2`-off render path is never stranded.
- Idempotency: if new keys already exist, `migrateNavStorage()` is a no-op. If new keys absent but old present, map+write. If both absent, default (`dashboard`).
- Old-key deletion is a **separate follow-up PR one release later**, after `NAV_V2` is defaulted on and the old render path is dead code.

This closes the "gating detail" ambiguity: **map-forward now, delete-later, read-fallback throughout**. Unit test seeds `{workspace:"tax", feed:"notifications"}` → asserts `{destination:"results", resultsSub:"alerts"}` written, old keys still present, and a second call is a no-op.

### 3.5 `AppearanceProvider`
Owns `tickerLogoDisplay` (928) + `TICKER_LOGO_DISPLAY_KEY` (187), the execution-banner mode trio (188/189/194, legacy migration already implemented — keep it), and `hideTestAccount` (931) + `HIDE_TEST_ACCOUNT_KEY` (196). Pure display; no data path. Extractable in Phase 1 with no flag.

---

## 4. Route-encoding: the thin `/a/:accountId` catch-all

Per locked decision + design §Incremental deferred milestone, adopt option (b): a thin `[accountId]` param that **seeds and validates** `ActiveAccountProvider`, with **server-side write-time `accountId` validation as the real safety boundary** (design P3). Concretely:

- Add `app/(shell)/a/[accountId]/…` mirroring the destination segments, OR (lighter) keep flat routes and read `?a=` / a path prefix in `ActiveAccountProvider`. **Recommendation:** flat routes + a `[accountId]` optional-catch-all seed, because a full `/a/:id/` restructure of every segment is the "multi-week monolith split" the design explicitly rejects.
- The param only *seeds* view-scope. It is **advisory**: `ActiveAccountProvider` validates the id against the session's account list and, for single-account users, auto-resolves; the URL is never trusted for writes.
- Every mutating API route (`app/api/profiles/*`, `app/api/connected-accounts/*`, order/approval routes) re-validates `accountId` against the session server-side. This is owned by the multi-account/execution spec, not this one — but the client contract is: **client sends explicit `accountId` in the body; server is authoritative.**

---

## 5. `openSettings` relocation + palette rewiring (§design Renames, merge gate)

`openSettings` is defined at **1133** (default `"operate"`). The **6 confirmed call sites** the design cites (`:1514, 1555, 1562, 1583, 1709, 1818`) are verified in the current tree, plus `:1819` already targets `"data"`:

| Site (verified) | Current | Rewrite target |
|---|---|---|
| 1514 | `openSettings("operate")` | `navigate("guardrails", "autonomy")` (system-state/approval-mode context) |
| 1555 | `openSettings("operate")` | `navigate("guardrails")` (execution) |
| 1562 | `openSettings("operate")` | `navigate("strategy", "signals")` (universe context) |
| 1583 (palette "Open Settings") | `openSettings("operate")` | palette entry → open **Settings tree root** (Scope-B), not a relocated section |
| 1709 (`onOpenSettings` prop) | `openSettings("operate")` | destination-dependent; pass a typed `onConfigure` callback instead of a raw section |
| 1818 (`onConfigureUniverse`) | `openSettings("operate")` | `navigate("strategy", "signals")` |
| 1819 (`onConfigureScanSettings`) | `openSettings("data")` | `navigate` to Settings·Data & Privacy (stays user-global) |

**Merge gate (CI grep-assert, design §Phase 3):** `rg 'openSettings\("(operate|risk|tax|tuning|strategy)"' app/` must return **zero** hits after Phase 3 — those five ids are relocated to Strategy/Guardrails/Results and must route to a destination, not a gutted modal. `connections|display|notifications|data` may still call `openSettings` (they stay in the Settings tree, renamed). Palette tab-jump commands (`tab-decision`…`tab-strategy`, per design near `:1576`) are rewritten to `navigate(destinationId)`; **palette "run once" inherits the chrome money-reality gating** (design §coherence E2) — the palette handler calls the same guarded `runOnce()` as `run-stop-controls.tsx`, never a raw execution path.

---

## 6. The TuningCard / Strategy-Studio merge (highest-risk extraction — §design Phase 4)

Verified: **two** `<TuningCard>` render sites — **3725** (inside `StrategyView`) and **4441** (inside `StrategyStudio`) — both passing identical props: `proposal={strategyTuning} currentPolicy={policy} currentPrompt={snapshot.strategyPrompt} onApply={applyStrategyTuning} onDiscard={discardStrategyTuning}`. Both parents read the same `snapshot` and the same `strategyTuning` state (1026). This is the design's named single-highest-risk change.

**Extraction sequence:**
1. **Precondition assertion:** `rg 'snapshot.strategyPrompt' app/dashboard-client.tsx` and confirm both parents receive the *same* `snapshot` prop instance (they do — both live in `DashboardApp`'s subtree; `StrategyView` at 3491 and `StrategyStudio` at 4290 are both children of the render tree at ~1811–1930). Assert no third consumer of `strategyTuning` before deleting.
2. **Inline Studio into Strategy:** `StrategyStudio` (4290) contents move into `strategy/page.tsx`; the `<Modal open={studioOpen}>` wrapper (near 1920) is deleted. **Part III gap #6 resolution:** the modal *container* JSX is removed outright (not flag-retained); only the **duplicate `TuningCard` render site (4441)** is kept behind the `STRATEGY_CONSOLIDATION` sub-flag for one-release rollback. The `studioOpen` state (885) and its palette/menu triggers are removed in the same PR.
3. **Single TuningCard** lives once in `strategy/page.tsx`, reading `strategyTuning` + `snapshot.strategyPrompt` from `SnapshotProvider`/Strategy-local state.
4. **Exit criteria (design-mandated):** apply/discard round-trip test (generate review → `applyStrategyTuning` → assert the patch diffs against the *live* `snapshot.strategyPrompt`, not a stale copy) + a `STRATEGY_TUNING_STORAGE_KEY` (199) localStorage-compat check (old stored proposals still deserialize via `readStoredStrategyTuning`, 313).
5. **Rollback:** flip `STRATEGY_CONSOLIDATION` off → duplicate render site returns.

The prompt auto-save (`promptSaveTimer` ref, 1029, 800ms debounce) moves with Strategy and must remain a single debounce owner — do not duplicate it across the inlined Studio content.

---

## 7. Mobile singleton-setter hazard (Part III gap #3/#11 — resolved architecturally)

`src/lib/mobile-api.ts` calls `setActiveConnectedAccount(accountId, …)` (design cites `~:648`) — mobile **writes the execution singleton directly**. If the shell's `setViewAccount` (§3.1) becomes view-only but mobile still calls the singleton, mobile is the surviving side-door that re-introduces the coercion P2 deletes. **Architectural resolution owned here:** the mobile command API must route account selection through the **same `ActiveAccountProvider` contract** — i.e. `setViewAccount` (view-scope) for "look at account X", and only the explicit arming API (data-plane spec) for "arm account X". The client-side contract this spec fixes: **there is exactly one `setViewAccount` entry point**, and both the desktop switcher and `mobile-api.ts` call it. Whether `mobile-api.ts` adopts account-scope context (design Open Q6) is confirmed by the locked decision: **mobile gets full account-scope parity** (switcher + STOP + scoped context survive), implementation later, spec now. `/mobile` is inside the shell (degraded), not deferred — this closes the gap #11 contradiction ("defer to Open Q6" vs "P0 requires switcher+STOP survive"): **survive now, deep parity later.**

---

## 8. Strangler-fig extraction order (each step keeps the app working)

Mapped onto design Part II-D's five phases, but stated as *component-extraction* steps with a green build at every commit. Each step is one PR behind `NAV_V2` (+ section sub-flags where noted).

| Step | Extract | Flag | Keeps-working guarantee |
|---|---|---|---|
| **E0** | `AppearanceProvider` + field primitives (`fields/`) + `ScopeTag`/`OriginBadge` (surfacing existing tier data) | none (Phase 1) | Pure lift; label-only relabels (Notifications→Alerts family, Halt&Flatten→STOP copy). No data path. |
| **E1** | `NavProvider` + `DestinationTab` mapping + **persistence shim (§3.4)** | none for shim; `NAV_V2` for new render | Renderer resolves destination→*current* panel; byte-identical output. Shim maps-forward, keeps old keys. |
| **E2** | `SnapshotProvider` (lift SSE 1072 + snapshot 877 + tickerScan) | `NAV_V2` | One SSE owner; destinations subscribe via context. Old inline path deleted only after all consumers migrated. |
| **E3** | Settings split: `SettingsContent` (4486) → Scope-B tree (`settings/[section]`) + Scope-A stubs; rewrite 6 `openSettings` sites (§5) | `NAV_V2` + per-section sub-flag | Old modal remains fallback render until all sections move; merge-gate grep-assert. |
| **E4** | Strategy consolidation + **TuningCard merge (§6)** | `NAV_V2` + `STRATEGY_CONSOLIDATION` | Duplicate TuningCard coexists until round-trip test green; flag deletes it. |
| **E5** | Shell `layout.tsx` + chrome components + `ActiveAccountProvider` (view-scope) + single-account-first | `NAV_V2` | Shell renders current destinations; switcher warns until P2 decouple (data-plane spec) lands. `/admin` + `/mobile` keep STOP. |
| **E6 (deferred, data-plane spec)** | P2 view/execution decouple, arming model, wash-sale provenance return-type, Fleet endpoints, `/a/:id` write-guard | `NAV_V2` | Not gated by IA extraction; owned by multi-account/execution spec. **No account-switching UI advertised as "free" ships before E6** (closes Part III gap #5 — the firewall). |

**Firewall (Part III gap #5 resolution):** the account **switcher chrome** (E5) ships in *warn/read-only* mode until E6's decouple + server-side write validation land. E1–E4 must not expose any UI that changes execution scope. CI assertion: no new call to `setActiveConnectedAccount` from client code before E6.

---

## 9. Testing strategy (~723 tests; co-update per PR)

**Key finding from the current suite (175 test files):** the tests that reference the affected vocabulary assert overwhelmingly on **data/audit-text and persistence**, *not* rendered DOM labels — which makes most of them **robust** to the relabels. The four files that matched `Notifications|Halt|Review|openSettings|workspaceTab|feedTab|Strategy Studio|Market Scan`:

| Test file | What it asserts | Breaks on IA change? | Co-update per PR |
|---|---|---|---|
| `test/dashboard-feed.test.ts` | `buildAuditFeed` output text ("Notifications Webhook Not Configured", line 91/154) — these are **audit-payload error strings**, not UI feed-tab labels | **No** — audit error text is data, untouched by the feed→Alerts rename. Leave as-is. | E0/E1: none |
| `test/dashboard-ui.test.ts` | line 33: "dedupes aliased **Market Scan** source labels" — asserts `MarketScan.source` string dedup logic | **No** — tests `src/lib` source-string logic, not the tab label. The "Market Scan"→"Scan" rename is a tab label; source attribution is unchanged. | none |
| `test/persistence-notification.test.ts` | persistence + notification delivery + `notificationSettings` scope (line 89 "activates strategy profiles without corrupting user-scoped settings") | **Partially** — the scope test (89) is exactly the `USER_LEVEL_POLICY_FIELDS` round-trip guard; it must stay green through the Scope-A/B split (E3). Add sibling round-trip tests per field. | E3 |
| `test/e2e/dashboard-smoke.spec.ts` | Playwright smoke — likely clicks tab labels / opens settings | **Yes** — DOM-label + navigation assertions. Update selectors when spine-nav replaces workspace tabs (E1/E5) and when `openSettings` targets move (E3). | E1, E3, E5 |

**Per-PR test protocol (design §Guardrails):**
- **E0 (relabels):** grep `rg '"Notifications"|"Halt & Flatten"|"Review"|"Strategy Profile"' test/` before merge; co-update any literal-label assertion in the same PR. Current grep shows the risk is small (audit strings are safe; only the e2e spec and any snapshot tests need touching).
- **E1 (shim):** add `test/nav-storage-shim.test.ts` — seed old keys → assert mapped new keys written, old keys retained, second call no-op (§3.4).
- **E3 (settings split):** the merge-gate grep-assert (`no openSettings points at a relocated section`) runs in CI; co-update any test asserting `settingsInitialSection`/`openSettings` targets or `/admin/*` routes.
- **E4 (TuningCard):** the apply/discard round-trip test + `STRATEGY_TUNING_STORAGE_KEY` compat test are the *exit criteria*, not optional (§6).
- **E5 (shell):** update `dashboard-smoke.spec.ts` selectors to the new spine-nav + switcher; assert STOP survives on `/admin` and `/mobile`.
- **Every PR:** the verify trio in CLAUDE.md order — `npx tsc --noEmit` → `npm test` → `npm run build`, plus `npm run lint`. Because `SettingsSection`/`WorkspaceTab` are used as `Record` key types, **narrowing a union is a compile-time break** — lean on `tsc` to enumerate the blast radius (this is why unions map-forward rather than shrink during E1–E4; the old ids stay as redirect aliases until E6).

**Do-not-break invariants for the FE work:** one SSE owner (E2); STOP always one click and never sells (chrome `run-stop-controls.tsx`); STOP survives shell extraction on `/admin`+`/mobile`; palette "run once" inherits chrome gating; the persistence shim keeps a one-release read-fallback so `NAV_V2`-off users are never stranded.

---

**Relevant absolute paths:** `/home/user/agentic-trading/app/dashboard-client.tsx` (source monolith), target `/home/user/agentic-trading/app/(shell)/` tree, existing precedent `/home/user/agentic-trading/app/ui/macro-panel.tsx` + `/home/user/agentic-trading/app/ui/assistant-console.tsx`, `/home/user/agentic-trading/src/lib/mobile-api.ts` (singleton-setter hazard, §7), `/home/user/agentic-trading/test/{dashboard-feed,dashboard-ui,persistence-notification}.test.ts` + `/home/user/agentic-trading/test/e2e/dashboard-smoke.spec.ts` (co-update targets, §9), and `/home/user/agentic-trading/docs/settings-navigation-redesign.md` (canonical design this decomposition serves).
