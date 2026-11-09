# 2026-07-09 — Mobile nav + drawer fixes (owner phone feedback, wave 3) (MONET)

## Summary

Owner phone screenshots + redesign spec, implemented as a 4-package workflow (2 sonnet-high,
1 sonnet, 1 haiku) with session-lead integration. Branch `monet/mobile-nav-drawer-fixes-99138a`.

## What changed

1. **"LRCXwasn't" missing space — root-caused and fixed.** The JSX source has had the space
   since the drawer was built (PR #330); the space was being dropped AT RUNTIME (reproduced
   locally: "MSFTwasn't"). Fixed with the explicit-string idiom
   (`{normalized}{" wasn't …"}`) the paragraph's second sentence already used; verified
   rendering live. (`app/console/ui/symbol-drilldown.tsx`, fixed by the session lead.)
2. **Drawer no longer near-empty for symbols outside the last scan** (owner's LRCX/AAPL
   report). New read-side `GET /api/quote?symbol=` (auth + 60/min rate limit + 12s timeout)
   consumes the existing enrichment cascade for ONE symbol; the drawer fetches it on demand
   when the last scan didn't know the symbol and renders the fundamentals/analyst/derived/
   evidence sections off it with the same per-field source attribution and "-"-on-missing
   honesty. The empty-state note narrows to what is genuinely scan-only: "Factor scores and
   signals come from scan runs — run a scan that includes X for those." Factor scores +
   signal summary deliberately stay scan-only. Loading + graceful-failure states included.
   Root cause (scan universe should union held/recently-traded symbols) reported as a
   follow-up for the strategy/market lane — those files are other lanes' keepouts.
3. **Finished/open order cards compacted to the owner's sketch**: each grey stat box is now
   one line — label left, value right-aligned — with tighter padding and more gutter
   (`app/console/orders/page.tsx`). Long values truncate with full text in the tooltip.
4. **Customizable mobile bottom tabs** (`nav.tsx` + new `app/console/lib/mobile-tabs.ts`):
   - Active tab state: `aria-current="page"` + weight 800 + accent-soft icon pill (not
     color-only). (Inline font-weight because Tailwind's utility loses the cascade to the
     unlayered `.con-tab-item` rule under v4 layers.)
   - "More" → **"Tabs"** (LayoutGrid icon). Up to 4 chosen tabs + Tabs button; default
     Thesis / Proposals / Journal / Orders; persisted in localStorage
     (`console.mobileTabs.v1`, SSR-safe hook, min 2 / max 4 enforced with explained-disabled
     pins, stale hrefs dropped).
   - The Tabs menu slides up (reduced-motion-safe), lists ALL destinations including the
     Core trio, grouped **Core / Monitor / Review / Configure** (Settings last) with real
     section hierarchy (spacing + indent). Rows navigate; trailing pin toggles tab
     membership (aria-pressed, no navigation). Pending badge follows Proposals wherever it
     lives.
5. **Desktop rail parity**: same grouped order from ONE shared grouped-destinations
   constant — Core, Monitor, Review, Configure with Settings as the lowest item; small
   `con-card-title` group labels.
6. **Console page-width parity**: scout table of every page's wrapper (see workflow journal;
   summary — 3xl ×6, 5xl ×3, 6xl ×1, full-bleed ×2). New shared
   `CONSOLE_PAGE_WIDTH` (`app/console/lib/page-width.ts`) applied to every owned page.
   **Session-lead override of the scout's plurality pick:** standardized on **max-w-5xl
   (1024px)**, not the 3xl plurality — 768px would push the scan/orders/macro tables into
   constant horizontal scrolling; reading pages stretch to 1024px gracefully. Documented
   exceptions (two-column layouts whose asides have hard px floors): home dashboard
   (full-bleed within the shell's 1400px) and the decision-trace ready state (6xl).
   NAMING TRAP recorded: a lib file named `page.ts` under `app/` is treated as an App
   Router route by Next — hence `page-width.ts`.

## Verification

- Gate: `npx tsc --noEmit` clean; `npm run lint` 0 errors; full `npm test` green (3109+
  tests incl. new `test/quote-route.test.ts` + drilldown pure-fn tests); `npm run build`
  clean.
- Driven live (seeded demo DB): desktop rail groups render Core/Monitor/Review/Configure
  with Settings last; mobile bottom bar shows Thesis/Proposals(badge)/Journal/Orders/Tabs
  with Journal active (aria-current + weight 800); Tabs sheet opens with 13 pinnable
  destinations in 4 sections; live pin/unpin swap (Orders→Watchlist) updated the bar AND
  localStorage; MSFT drawer (not in any scan) fetched live fundamentals and showed the
  narrowed, correctly-spaced note; activity container measured exactly 1024px post-intro;
  orders page carries the shared width constant with no 3xl stragglers.
  Note for future drivers: the merged console intro splash hides page content on every full
  navigation — measure AFTER it completes or DOM widths read 0.
- Not drivable with seeded data: order cards with real rows (no broker orders in demo DB —
  diff-reviewed against the owner's sketch), enrichment failure path (unit-tested).

## Follow-ups

- `app/console/results/page.tsx` (CODEX efficacy lane keepout, PR #1175 in flight): one-line
  wrapper change to `CONSOLE_PAGE_WIDTH` once it lands, to match the 5xl standard.
- Scan-universe union with held/recently-traded symbols (root cause of item 2) — for the
  strategy/market lane; the on-demand fetch remains the permanent fallback either way.
- `usage` page delegates to the admin client with its own width + non-con tokens — needs its
  own design-system pass (pre-existing, noted by the scout).
- P2's agent completed its edits but failed to return its structured report (haiku,
  StructuredOutput skipped) — work verified by direct diff review; noted for workflow
  hygiene.

## Files

`app/console/components/nav.tsx`, `app/console/lib/mobile-tabs.ts` (new),
`app/console/lib/page-width.ts` (new), `app/console/orders/page.tsx`,
`app/console/ui/symbol-drilldown.tsx`, `app/console/ui/drilldown-data.ts`,
`app/api/quote/route.ts` (new), 10 console `page.tsx` wrapper-class edits,
`test/quote-route.test.ts` (new), `test/console-drilldown.test.ts`, `STATUS.md`,
`docs/EFFORT-LOG.md`, this note.
