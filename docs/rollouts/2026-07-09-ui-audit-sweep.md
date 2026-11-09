# 2026-07-09 — UI-audit sweep: all remaining unclaimed findings + plain-English pass (MONET)

## Summary

Owner-directed ("work on all the UI related tasks not done by others; team of subagents,
lowest-cost capable model per task; MONET picks names and difficult choices") plus a
mid-flight scope addition ("make the activity log and other parts of the app show plain
english"). Executed as two workflow waves over file-disjoint packages — wave 1: ten agents
(7 sonnet, 3 haiku) on the remaining 55-findings backlog rows; wave 2: four agents on the
plain-English sweep + wave-1 follow-ups — then a single-session integration pass
(consolidation, full gate, live drive both themes at desktop + 375px).

## Decisions (MONET, owner-delegated)

- **Approvals nav label: "Decisions" → "Proposals"** — resolves the audit's noun collision
  ("Decisions" labeled the queue while `/console/decisions/[id]` is the trace route);
  branded Socratic vocabulary kept everywhere else.
- **`--brand-accent` = console teal** (`#12616f` light / `#58c7d3` dark): one shared token
  both systems derive from; the ui system's green accent was retired because an accent
  equal to gain-green muddles "highlighted" vs "profitable". Focus ring now derives from
  accent via `color-mix`.
- **Radius canon = console values** — shared `--radius-card`/`--radius-control` in
  globals.css; console vars point at them.
- **`/design/socratic-trade` showcase deleted** (audit lean).
- **Mobile primary-3 ratified deliberately**: Thesis / Proposals / Journal.
- **Manual order entry = honest note, not a feature**: "Orders originate from approved
  proposals — there is no manual order-entry here."
- **Guardrails framing template** (advisory sentence, no new confirms/blocks anywhere).
- **Plain-English label vocabulary** (see `app/console/lib/labels.ts` +
  `src/lib/dashboard-ui.ts` maps): notification types/statuses, feed/proposal/fill/broker
  statuses, evidence kinds, decision statuses, framework fields, authority, system state,
  order types, learned-context sources/kinds; short "Order 6F8A1C2E"-style references with
  full ids preserved in tooltips/raw-toggle; JSON never rendered inline (scalar "Key: value"
  fallback + existing RawToggle keeps the full payload).

## What landed (by wave-1 package)

- **A primitives:** console `Segmented` (adopted by the policy form's Dollar/Percent
  toggle), console `IconButton`, ui `RawNumInput`, ui `Switch.disabled` +
  attribute-selector thumb, Sheet `aria-labelledby` (useId), `Meter` breach state (hatched
  fill + overage tooltip + aria-valuetext), one exported `TONE_VAR` map replacing three
  drift-prone tone maps.
- **B login:** `border-border`→`border-line` (2×), Apple button → `bg-fg text-bg` tokens.
- **C nav/mobile/PWA:** "Proposals" rename in `DESTINATIONS` (single source of truth —
  rail/tabs/More/palette inherit); deliberate primary-3; More sheet clustered
  Monitor/Configure/Review with unmapped fallback; PWA PNG icons (180/192/512 via new
  `scripts/generate-pwa-icons.mjs` + sharp) wired into manifest + layout; "Open full
  console" escape link in the /mobile header (aria-labeled); offline banner
  (navigator.onLine + listeners); mobile freshness surfaced.
- **D1 approvals/trace/components:** guarded `router.back()` with Journal fallback;
  one-click inline bulk-reject confirm (no typed ritual); learned-context count chip +
  jump anchor in the approvals header; equity chart minimum ±0.5% Y-span; allocation
  concentration tint (warn/neg over cap, % text, tooltip naming the cap); positions
  mobile card-list.
- **D2 scan/orders:** per-row Watch → existing watchlist API (optimistic + toast +
  already-watched state); scan tab ARIA (tablist/tab/aria-selected); persistent quote-age
  suffix on orders; ~40px coarse row actions; scan + orders mobile card-lists; the manual
  order-entry note.
- **E guardrails:** per-cap inline utilization (Meter/sub-labels, "-" when unknown);
  consistent advisory framing sentence.
- **F capability badges:** 9-hue rainbow → info-tone chips + lucide icons; warn (with
  icon) reserved for action-needed; new `--con-info` tokens in all three theme blocks.
- **G CSS foundation:** brand-accent + radius tokens as decided; 44px coarse-pointer floor
  on `.con-btn` + compact chrome triggers; thesis-hero gradient → flat + 3px accent rule;
  showcase route deleted; visual-system.md updated. Contrast hand-verified (7.08:1 light,
  9.54:1 dark).
- **H marketing:** welcome gets a static decision-receipt illustration (honest caption);
  how-it-works gets a themed inline-SVG decision-loop diagram in product vocabulary.
- **I test:** `test/short-pnl-sign.test.ts` (short P&L sign correctness; app code verified
  correct).

## What landed (wave-2 plain-English)

- **W2-A feed/notifications:** no inline JSON ever (scalar-fields fallback + RawToggle);
  short Order/Run tags with full ids in fullText; the 4 previously-raw notification types
  labeled; fill-status/order-type/`model via Provider` fixes; exported
  `feedStatusLabel`/`notificationTypeLabel`/`notificationStatusLabel` from
  `dashboard-ui.ts`; feed tests updated + extended (25 tests).
- **W2-B console chips:** new `app/console/lib/labels.ts` (plainLabel lifted from the home
  page + evidence/decision/framework/authority/thesis-tag labels); every raw status chip
  on Journal/Alert Center/home/trace/approval-card/results/drilldown now labeled;
  drilldown broker states through `readableState`; home-page Meter un-clamped so breach
  can surface.
- **W2-C mobile/learned-context:** system-state words (Running/Stopped/Close-only/Winding
  down); order-type + Live/Paper words on proposal lines; command errors clamped w/ full
  text in tooltip; learned-context source/kind labels + "Queued because" phrasing.
- **W2-D shell/guardrails:** `MobileFreshnessBar` exported from chrome.tsx and mounted in
  shell.tsx's sticky top wrapper (no bottom duplicate); guardrails Meter un-clamped;
  remaining guardrails strings humanized.

## Integration (this session)

- De-duplicated the label maps: superset consolidated into `src/lib/dashboard-ui.ts`
  (added rejected_by_broker/paper/placing_failed/placed/completed/running);
  `app/console/lib/labels.ts` now re-exports the shared three and keeps only
  console-specific maps.
- `orderTypeLabel` Title-cased at source (`app/console/orders/lib.ts`) per the decided
  vocabulary ("Stop-market").
- Full gate: `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm test` 2983/2983;
  `npm run build` clean.
- **Driven live** (seeded demo DB, light + dark, desktop + 375px): teal accent both themes
  (#12616f / #58c7d3 verified computed); hero 3px rule; nav "Proposals 3"; Journal +
  approvals + Alert Center pages have ZERO snake_case/JSON leaks page-wide (regex-swept
  rendered text); Alert Center chips read "Budget alert · Sent", "Data provider degraded ·
  Sent", "Order filled · Delivery failed"; thesis tags read "Quality Compounder"; orders
  note present; scan tablist ARIA active; mobile shows "Stopped", "buy · Market · mode
  unknown", labeled attribution lines, aria-labeled "Open full console" link; marketing
  illustration + loop diagram render.
  Not drivable with seeded data: scan per-row Watch buttons (no scan rows in the demo DB —
  code path tsc/test-covered), offline banner (needs real offline), Meter breach visual
  (needs an over-cap value; logic unit-verified in wave 1).

## Deferred (unchanged from reservation)

Monolith extraction; `useConsoleSnapshot` hook; dark-mode dual mechanism; `console.css`
`@theme` migration; full primitive merge; React.memo pass; Vol-column semantics (needs a
data-layer check first); order-columns spread. Coordination: lands AFTER merging forward
PR #1107 (activity-feed consolidation, same `dashboard-feed.ts`) with a deliberate
hand-resolve; AG PRs #1008/#989 will need rebases (flagged on #ag***-s**c twice).

## Files

Two waves + integration touched ~40 files across `app/console/**`, `app/ui/**`,
`app/mobile/**`, `app/welcome`, `app/how-it-works`, `app/login`, `app/globals.css`,
`app/manifest.ts`, `app/layout.tsx`, `src/lib/dashboard-feed.ts`, `src/lib/dashboard-ui.ts`,
`app/console/orders/lib.ts`, `public/icons/*`, `scripts/generate-pwa-icons.mjs`,
`test/dashboard-feed.test.ts`, `test/short-pnl-sign.test.ts`, `docs/design/visual-system.md`
(exact list = the landing PR's diff).

## Verification commands

`npx tsc --noEmit` · `npm run lint` · `npm test` (2983) · `npm run build` · live drive per
above (preview server on seeded `demo.db`, DOM/computed-style probes + screenshots).
