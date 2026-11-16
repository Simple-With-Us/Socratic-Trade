# 2026-08-08 — Review fixes wave A: quick correctness + copy batch (#2547 #2549 #2554 #2556 #2562)

Branch `monet/review-fixes-a` (isolated worktree). Part of the 2026-08-06 full-product-review
follow-up (`product-review-2026-08-06` issue batch).

## 1. Context & Objective

Close out the "quick correctness + copy" slice of the product review: a 404'd console route,
a run-state vocabulary split between console and PWA, silent unmanaged shorts, a suspected
lockfile drift, and a batch of copy/polish nits (#2562 a–n).

## 2. Changes Made

**#2547 — lockfile "drift" (ZERO-CODE FINDING, no change needed):** see §6.

**#2556 — All-Decisions 404:** `app/console/page.tsx:338` links to `/console/decisions`,
which had only a `[id]` segment. New index page `app/console/decisions/page.tsx`: client
page fetching `/api/socratic/decisions?limit=100` (same API family as the `[id]` trace
page; already reverse-chron by `created_at`), rendering a con-* Card list of
symbol · side · thesis tag · status chip · age, each row linking to
`/console/decisions/[id]`. Honest empty state ("No decision traces yet."). The list body is
exported as pure `DecisionsList` for the route smoke test. Not added to the shell's
`SNAPSHOT_INDEPENDENT/SELF_SKELETON` sets — it behaves exactly like the existing `[id]`
page (shell loader until snapshot, then page-owned loading/error state).

**#2549 — unmanaged shorts:** new `deriveUnmanagedShortCount(positions, policy)` +
`unmanagedShortNotice(count)` in `app/console/lib/derive.ts` (aggregates the existing
muted/unsafe per-row state in `deriveBaseProtection`; no restructure). Surfaced as an
advisory banner on the Home positions card (`positions.tsx`, with an Open Guardrails link)
and as a matching note in the Guardrails "Short selling" panel (`guardrails/page.tsx`).
Shared copy helper so the two can never drift: "N short positions are unmanaged while short
selling is off — enable shorting to resume protection, or close them." Advisory only; no
auto-action, no gating.

**#2554 — run-state vocabulary:** `StateInfo` (in `app/console/lib/derive.ts` — already the
shared module: the PWA imports from it) gains `word: RunStateWord`, the state-only
vocabulary ("Running" / "Paused · market closed" / "Exit-only" / "Winding down" /
"Stopped"); `label` is unchanged (word + authority suffix when running). The PWA's private
`systemStateLabel` map (which said "Running" while the console said "Paused · market
closed") is replaced by exported `mobileRunState()` → `deriveStateInfo(...).word`, with the
detail sentence on the header title. `/api/mobile/snapshot` now includes
`policy.runDuringExtendedHours` so the mobile derive can answer the market-closed split
(absent field keeps the console's undefined-≠-false "can't know → plain Running" rule).
Console chrome and the Guardrails Autonomy panel already consumed `deriveStateInfo`.

**#2562 — web items + copy nits:**
- (a) ROE tooltip provider-neutral (`drilldown-data.ts`: "provider-reported (trailing twelve months)").
- (b) Advanced-knobs caption names living knobs (`settings/page.tsx`): "Multi-query retrieval, HyDE passages, SEC backfill worker, transcript storage rights, etc." + sync comment pointing at `source-settings-catalog.ts`.
- (c) `preflight-live-guard.ts`: "(Paper mode is unaffected.)" → "(Paper-environment accounts are unaffected.)" (no mode framing).
- (d) Admin transcript speaker label "Assistant" → "Coach" (display only; persisted role untouched).
- (e) Deleted the dead `market-data-filled` CustomEvent dispatch (+ now-unused raw-payload parsing) in `useConsoleData.tsx` — zero listeners anywhere.
- (f) Intro canvas: chart-phase candle colors resolve from the live theme (`--con-pos`/`--con-neg` via `getComputedStyle` at animation start; hex literals remain only as SSR-safe defaults). Candles no longer draw through the readiness checklist text: the hero opts out via `data-intro-shield`, and the canvas clips those rects out of its draw region once the backdrop dissolves (candles pass visually behind the content).
- (g) Chrome budget chip "Today: $0.00" → "Deployed today: …" (all three renders: mobile healthy/unhealthy bars + desktop FreshnessStrip).
- (h) Scan freshness chip "1h ago old" → "1h ago" (Ago already says "ago").
- (i) `dashboard-feed.ts` `brokerOrderDetail`: no longer restates a state the prefix already names ("Broker reported Expired: Expired", "Filled by broker: Filled"); working states keep the state segment ("Accepted by broker…: New").
- (j) Account-switcher mask "··" (double middot, collided with the " · " separator) → bullet mask "••last4", matching the iOS `••4812` convention (chrome.tsx trigger label + switch rows).
- (k) Ticker-logo fallback shows the full base symbol ("ZTS", not "ZT"); >2-char symbols shrink-to-fit the fixed tile (`fallbackFontPx`, floored at 5px).
- (l) Readiness checklist "(one control — not duplicated here)" / "(One control — not duplicated in this checklist.)" agent-speak removed (derive.ts + readiness-checklist.tsx).
- (m) `.ac-actions` sticky approve-bar shadow literal → `var(--con-shadow-up)`, defined in the light root and BOTH twin dark blocks (dark gets a dark-tuned value mirroring `--con-shadow`).
- (n) The two console `text-[10px]` → `text-[length:var(--con-fs-2xs)]` (scan run-badge, brokers PAPER chip).

**Files touched:**
- `app/console/decisions/page.tsx` (new)
- `app/console/lib/derive.ts`
- `app/console/lib/useConsoleData.tsx`
- `app/console/components/positions.tsx`
- `app/console/components/chrome.tsx`
- `app/console/components/intro-canvas.tsx`
- `app/console/components/readiness-checklist.tsx`
- `app/console/guardrails/page.tsx`
- `app/console/scan/page.tsx`
- `app/console/settings/page.tsx`
- `app/console/settings/brokers.tsx`
- `app/console/ui/drilldown-data.ts`
- `app/console/ui/ticker-logo.tsx`
- `app/console/console.css`
- `app/admin/transcript/transcript-client.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `app/api/mobile/snapshot/route.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/preflight-live-guard.ts`
- `test/console-decisions-index.test.tsx` (new)
- `test/console-live-data-derive.test.ts`
- `test/mobile-pwa-client.test.tsx`
- docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- **#2554 helper location:** kept in `app/console/lib/derive.ts` rather than a new
  `src/lib` module — the mobile client already imports four helpers from there (the
  established sharing pattern), and the scheduler webpack pass never touches `app/`.
- **#2549** is advisory-only by design (guardrails-are-preferences philosophy): a count and
  a sentence, never a block. The count intentionally reuses the exact rule the per-row
  Protection column already applies (quantity < 0 && !shortSellingEnabled).
- **(f) shield mechanism:** clipping the canvas draw region against `[data-intro-shield]`
  rects (only after the backdrop dissolves) rather than z-order games — the canvas must
  stay above the chrome to hand off onto the header logo, and lowering it would hide the
  landing wordmark behind the opaque top bar. The attribute is generic; only the readiness
  hero opts in today.
- **(i)** dedup is case-insensitive prefix-contains, so "Filled by broker: Filled" also
  collapses (same defect class); tests assert the existing "Accepted by broker; awaiting
  fill"/"Filled by broker; awaiting local reconciliation" strings still hold.
- **(j)** scoped to the account-switcher per the review item; other `··` masks
  (settings/brokers rows, approval card, replace-market sheet, orders page) still use the
  old convention — flagged as a follow-up, not smuggled into this batch.
- **(k)** full symbol over truncation accepts very small glyphs for 5-char symbols at the
  sm tile (floored 5px) — complete-but-small beats reading as a different ticker.
- **PLAN.md untouched** — no scope/timeline/approach change.

## 4. Verification State

```
PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                      # clean (0 errors)
npx vitest run test/console-live-data-derive.test.ts test/mobile-pwa-client.test.tsx \
  test/console-decisions-index.test.tsx test/dashboard-feed.test.ts \
  test/console-readiness-checklist.test.ts
                                      # 5 files, 105 tests, all passed
npm run lint                          # 0 errors, 728 warnings (grandfathered backlog)
```

Touched files individually lint at 0 errors; the new files carry 0 warnings. Full
`npm test` + `npm run build` deliberately left to the landing operator per the wave
protocol.

**#2547 verification receipt** (Node 24):

```
NODE_AUTH_TOKEN=$(gh auth token) npm install --package-lock-only   # zero lockfile diff
gh api repos/jaywedgeworth22/congress-trading-shared/git/ref/tags/v2.5.1
  -> tag object 2efa58ea... (annotated) -> dereferences to commit b454ccb8e8fa605c1e806edaffb43c7a86f09b2e
node -e '<compare lock resolved sha vs tag commit>' ->
  manifest spec : github:jaywedgeworth22/congress-trading-shared#v2.5.1
  lock resolved : git+ssh://...#b454ccb8e8fa605c1e806edaffb43c7a86f09b2e
  lock version  : 2.5.0
  OK: lock resolved commit === v2.5.1 tag commit
```

## 5. Next Steps & Blockers

- Landing operator: full `npm test` + `npm run build`, then `land.sh`/PR referencing
  #2547 #2549 #2554 #2556 #2562.
- Follow-ups surfaced (not done here): unify the remaining `··` masks with `••` (see §3);
  upstream `congress-trading-shared` should bump its package.json `version` field when
  tagging (v2.5.1 tag still says 2.5.0 — the entire cause of #2547's false alarm).
- Noticed in passing (out of scope, worth an issue): the mobile PWA "Delete app account…"
  collapsed-state `<button>` in `app/mobile/mobile-pwa-client.tsx` (~line 1148) has no
  className/onClick, so the danger zone can never be opened from the UI.

## 6. Zero-Code Findings

**#2547 is not a real drift.** The v2.5.1 tag is an *annotated* tag whose commit is
`b454ccb8e8fa605c1e806edaffb43c7a86f09b2e` — exactly the commit the lockfile resolves. The
lock's `"version": "2.5.0"` merely mirrors the shared repo's own `package.json` version
field at that commit (upstream tagged v2.5.1 without bumping the manifest). Regenerating
the lock (`npm install --package-lock-only`, Node 24) produced a **zero diff**. The
`.github/workflows/shared-package-pin-check.yml` `check-pin` job asserts THIS repo's
manifest vs the PEER repo's (Congress.Trade) manifest at commit level (annotated-tag
aware) — it does **not** assert manifest-vs-lock agreement, so it neither catches nor
suffers this class; no workflow edit made (out of scope per wave instructions).
