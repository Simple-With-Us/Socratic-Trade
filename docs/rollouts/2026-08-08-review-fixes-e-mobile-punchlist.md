# 2026-08-08 — Review-fix wave E: owner mobile punch list (iPhone Safari console)

## Context & Objective

Owner annotated iPhone-Safari screenshots of the console (2026-08-08) with seven punch-list
items: copy merges with a new owner-wide "two spaces between sentences" style rule, Orders
header de-duplication, the mobile tab bar's lost labels + grey buffer, signed short weights
rendering "-0.0%" artifacts, and a useless "—" in Orders' LAST PRICE column. Branch
`monet/review-fixes-e` (isolated worktree off `origin/main`).

## Changes Made

### 1–2. Sentence-gap style rule + Proposals empty state

- New `SENTENCE_GAP = "  "` (NBSP + space — HTML collapses two plain spaces) exported
  from `app/console/lib/format.ts`; owner-wide rule, applied ONLY to this wave's copy (no
  app-wide sweep; the fleet copy doc is updated separately by the orchestrator).
- Proposals empty state (`app/console/approvals/page.tsx`) is now ONE paragraph:
  "When a run stages a trade that needs your approval, it shows up here.&nbsp; Need a cycle
  now? Use **Run once** — the ⚡ lightning button in the top bar — then return here to
  decide." The lightning reference matches the chrome: `RunOnceButton` renders icon-only
  `<Zap>` on phones, and inline-lucide-in-copy is an existing pattern
  (`assistant/draft-card.tsx`), so the copy embeds an inline `<Zap size={12}>` glyph. The
  stopped-state variant stays, folded into the same paragraph with a sentence gap.

### 3 + 6–7. Orders page

- Header: purple env chip ("PAPER · broker practice account") and the account-name chip
  REMOVED (both duplicate the top banner / account-scope switcher); Refresh sits on the same
  row as the "Orders" h1 (`flex items-center justify-between`).
- The two intro sentences merged into one `<p>` with `SENTENCE_GAP` (second sentence still
  gated on multi-account).
- Mobile card LAST PRICE label wrapped to two lines → visible label is now "Last"
  (`whitespace-nowrap`, `title="Last price"`), matching the one-line SIZE/AGE labels.
  "· held mark" tag and mechanism unchanged.
- LAST PRICE "—" gap filled: new final fallback reads the durable per-symbol store
  `symbol_field_latest` (GROK's field store, PR #2503). Server: `getSymbolLatestPrices()`
  (new, `src/lib/db-fundamentals.ts` — `field = 'price'` only, skips non-finite/non-positive
  values) feeds a new optional `DashboardSnapshot.orderPriceFallbacks` map (keyed by
  normalized symbol, each entry carrying its own `as_of`), assembled best-effort in
  `src/lib/dashboard.ts` for every order symbol. Client preference order is unchanged and
  extended: held mark → latest scan → durable store (rendered "$378.10 · 23h old" via new
  `fmtAge`) → "—". Hover titles + the column header tooltip spell out the store tier.

### 4. Mobile tab bar — labels back, grey buffer gone

- **Root cause:** nothing since GROK's 2026-08-05 change touched the bar (`nav.tsx`
  untouched since `ddc7ddf9`; later `console.css` commits touched other sections). The
  chrome-gap mechanism ITSELF is what the owner is seeing on-device: `bottom: -0.8×gap`
  shifts the whole bar down, sliding the label row (the bottom ~16px of the bar) underneath
  Safari's floating URL chrome — icons stay visible, labels vanish — while the `::after`
  underlay (`0.2×gap + max(gap, 48)` ≥ 48px of painted surface) is the "larger grey buffer"
  band under the bar. No icon-only styling was ever added; labels were always in the markup.
- **Fix (owner-prescribed):** revert to `bottom: 0` + `padding-bottom:
  env(safe-area-inset-bottom, 0px)` only. Removed `measureBottomChromeGap`, the
  shift/underlay state + listeners, the `--con-tabbar-underlay` var and `::after` rules, and
  the standalone-only media gating (env() now applies in both modes; standalone behavior is
  unchanged since it already padded env()). Near-opaque surface + blur kept so content never
  ghosts through. TabsSheet still stops flush above the bar via the measured-offset effect.

### 5. Positions weight — unsigned share of gross exposure

- Weight = |marketValue| / Σ|marketValue| (gross exposure), UNSIGNED (owner decision):
  direction is already carried by the SHORT chip; kills "-0.0%" (T dust short) and "-1.8%"
  (PG). New pure helpers `grossExposure` / `grossExposureWeightPct` in
  `app/console/lib/derive.ts`; `<th>` tooltip now says "Share of gross exposure (absolute)…".
- The over-cap cue keeps the policy cap's own basis (|value| as a share of ACCOUNT value —
  `maxSymbolExposurePct` is defined against account value, not gross exposure); its tooltip
  names that percentage, so the displayed weight and the cue each self-describe.
- `fmtPct` never renders negative zero: exact `-0` AND tiny negatives that round to "-0.0"
  normalize to "0.0%" (regex on the formatted text, so any digit count is covered).

### Files

- `app/console/lib/format.ts` — `SENTENCE_GAP`, `fmtPct` negative-zero guard
- `app/console/lib/derive.ts` — `grossExposure`, `grossExposureWeightPct`
- `app/console/approvals/page.tsx` — merged empty-state paragraph + inline Zap
- `app/console/orders/page.tsx` — header row, merged intro, "Last" label, store-fallback tier
- `app/console/orders/lib.ts` — `StoredPrice`, `storedPriceFor`, `effectiveOrderPrice` third
  fallback, `fmtAge`
- `app/console/components/positions.tsx` — unsigned gross-exposure weight + cue basis split
- `app/console/components/nav.tsx` — chrome-gap shift/underlay removed, `bottom-0`
- `app/console/console.css` — `.con-tabbar` env() padding restored; underlay rules removed
- `app/dashboard-types.ts` — `orderPriceFallbacks?` on `DashboardSnapshot`
- `src/lib/dashboard.ts` — assemble `orderPriceFallbacks` (best-effort)
- `src/lib/db-fundamentals.ts` — `getSymbolLatestPrices`
- `test/console-orders-lib.test.ts` — store-fallback precedence, `storedPriceFor`, `fmtAge`
- `test/console-format-weight.test.ts` — NEW: fmtPct -0 guard, SENTENCE_GAP, weight helpers
- `test/symbol-field-latest.test.ts` — `getSymbolLatestPrices` coverage
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- **Tab bar env() padding applies in BROWSER mode too** (owner: "keep only
  env(safe-area-inset-bottom) padding"). The 2026-07-18 note removed browser-mode env()
  because the padded band was page-colored inside a page-colored bar; the bar now paints its
  own surface, so any safe-area padding reads as bar, not wasted page. If a small band
  reappears on-device, drop the padding back behind the standalone media query — one-line
  revert, documented in `console.css`.
- **Sentence gap follows the owner's verbatim copy exactly** — one gap after "here."; the
  "now? Use" boundary keeps a single space because the owner's verbatim string wrote it that
  way.
- **Weight display vs cap cue use different denominators** (gross exposure vs account value)
  — deliberate: the displayed weight answers "how much of my book is this?", while the cap is
  defined against account value; each tooltip states its own basis.
- **Store fallback is server-assembled** (one `IN (...)` SELECT for order symbols) rather
  than a client fetch — rides the existing snapshot path, degrades to `undefined` on any
  error, and can never outrank a held mark or scan quote client-side.
- No trading-path / order-placement changes anywhere in this wave; display + copy + CSS +
  snapshot read only.

## Verification State

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx tsc --noEmit   # clean, exit 0
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx vitest run \
  test/console-orders-lib.test.ts test/console-format-weight.test.ts \
  test/symbol-field-latest.test.ts test/console-live-data-derive.test.ts \
  test/console-drilldown.test.ts test/console-readiness-checklist.test.ts \
  test/approvals-triage-model.test.ts test/console-nav-labels.test.ts \
  test/console-tabs-keyboard.test.ts test/dashboard-agentic-fallback.test.ts \
  test/dashboard-fill-batching.test.ts test/dashboard-smart-money-slice.test.ts
# 12 files, 161 tests — all passed
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run lint       # 0 errors (728 grandfathered warnings)
```

Full `npm test` + `npm run build` deliberately NOT run here (wave instruction); the landing
operator runs the full gate + `scripts/land.sh`.

## Next Steps & Blockers

- Landing operator: full gate + `land.sh` + PR (this wave is commit-only by instruction).
- Owner on-device check: (1) tab labels visible again with no grey band (browser + installed
  PWA), (2) Orders LAST PRICE shows the age-tagged stored price where "—" used to be,
  (3) Positions short weights unsigned.
- Orchestrator: fold the SENTENCE_GAP rule into `docs/FLEET-UI-COPY.md` (out of scope here).
