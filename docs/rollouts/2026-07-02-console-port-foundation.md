# 2026-07-02 — /console parity-port foundation (Wave 1: shared primitives + nav scaffolding)

## Summary

Wave 1 of the legacy-dashboard → `/console` parity port. Landed the shared
primitives four wave-2 feature agents (scan / macro / assistant / orders) will
build on, plus the owner-requested model-attribution redesign of the approval
card:

- **`app/console/ui/ticker-logo.tsx`** — `<TickerLogo>`: company logo via
  `/api/logos/ticker?symbol=X&theme=…` with a monogram-tile fallback, themed
  with console tokens. Theme resolves the console way (data-theme on the
  closest `.console-root`, else `prefers-color-scheme`) — NOT the legacy
  `.dark` class on `<html>`. Also exports `useConsoleResolvedTheme(ref)`.
- **`app/console/ui/provider-logo.tsx`** — `<ProviderLogo provider size>`
  (AI-vendor mark from `/model-logos/<provider>.svg` on a white tile so dark
  marks read in both themes; colored-initial fallback) and
  `<ModelBadge modelId size showProvider title>` (logo + model display name).
- **`app/console/lib/models.ts`** — pure module: `providerForModel(modelId)`
  (mirrors `src/lib/usage-budget.ts` / `resolveLlmEndpoint` prefix logic),
  `providerLabel(provider)`, `modelDisplayName(modelId)` (curated humanized
  names, raw id fallback), `PROVIDER_META`, `DEFAULT_GREEN_MODEL_ID`,
  `ConsoleProviderId`.
- **`app/console/ui/symbol-drilldown.tsx`** — `<SymbolButton symbol>` (logo +
  ticker, opens the sheet; owns its own state) and
  `<SymbolDrilldownSheet symbol open onClose>`: company logo header, a
  self-contained SVG daily-close chart over `GET /api/history?symbol=X` with
  1M/6M/1Y/All ranges, price/change + sector from the snapshot's last market
  scan (`latestStrategyRun.marketScan.quotesBySymbol`), key stats (P/E, 52w
  range, scan score, your position). Honest empty states for missing history —
  never a crash.
- **`app/console/components/nav.tsx`** — four new destinations for the wave-2
  routes: `/console/scan` (Radar), `/console/macro` (Globe), `/console/orders`
  (ListChecks), `/console/assistant` (MessageSquare). Dead links until wave 2
  lands those pages (build-safe: Next doesn't validate `<Link>` targets).
  Mobile primary tabs stay Home/Approvals/Activity; everything else in More.
  Approvals red-badge logic untouched. Every destination now has a hover
  description (`title`).
- **`app/console/components/approval-card.tsx`** — owner-requested
  model-attribution redesign. A **green-team block** (faint green tint) always
  shows the proposing model's vendor logo + name (`snapshot.policy.llmModel`,
  falling back to `DEFAULT_GREEN_MODEL_ID` labeled "(policy default)") and the
  confidence score LARGE (`.con-confidence-num`, omitted gracefully when
  absent — never fabricated). The existing devil's-advocate content moved into
  a **red-team block** (faint red tint) badged with
  `snapshot.policy.redTeamLlmModel ?? llmModel` and its survived/rejected
  verdict. Company `<TickerLogo>` added next to the symbol in the header. The
  LIVE typed-confirmation contract, sizes, since-proposed, gate status, and
  three-outcomes block are unchanged.
- **`app/console/components/positions.tsx`** — each row's symbol is now a
  `<SymbolButton>` (ticker logo + drilldown); column headers gained plain-
  language tooltips. Layout/derivations otherwise unchanged.
- **`app/console/console.css`** — new: `.con-logo-tile` (neutral logo tile,
  light + dark variants), `.con-team`/`.con-team-green`/`.con-team-red` (faint
  pos/neg tinted blocks via `color-mix` on `--con-pos`/`--con-neg`, so they
  adapt to both themes), `.con-confidence-num` (34px/800 tabular numeral in
  the team hue), and the shared **row-hover/focus highlight** (auto on
  `.con-table tbody tr`, opt-in `.con-row` for non-table lists; `:hover` +
  `:focus-within` so keyboard focus highlights too).

Also baked in the owner's new cross-cutting UX standard: concise native
`title` tooltips on every interactive control/data point/badge this wave
touched (nav items, badge counts, chart timeframe buttons, drilldown stats,
positions headers, model badges, the big confidence number, team-block
headers), and the reusable row-hover treatment above for wave 2 to inherit.

## Why

Four wave-2 agents build feature routes (`/console/scan`, `/console/macro`,
`/console/assistant`, `/console/orders`) in parallel; they need one shared,
console-token-native set of logo/drilldown/model primitives so the ports don't
each re-derive (or worse, import legacy `app/ui/*` pieces styled for the old
theme system). The approval-card redesign is an explicit owner request: every
proposal card must always show WHICH model proposed it, team-styled, with the
confidence number visually load-bearing.

## Decisions

- `modelDisplayName` uses humanized curated names ("Claude Sonnet 4.6") with a
  1:1 raw-id fallback, rather than the picker catalog's descriptive labels
  ("claude-sonnet-4-6 - balanced Claude analysis") which are too long for a
  badge. The full raw id is always in the hover title.
- The drilldown chart is a self-contained SVG line (equity-chart style), not
  lightweight-charts: no new bundle weight, console-token theming for free,
  honest empty states. Wave 2 can upgrade to candles later if wanted.
- `TickerLogo.display` defaults to `"tile"` in the console (legacy default is
  `"transparent"`): the tile guarantees white/transparent marks stay readable
  on light surfaces without a per-callsite decision.

## Caveat (fast-follow, coordinate with the src/lib/strategy.ts owner)

**Model attribution on the approval card is policy-derived, not persisted.**
The card shows `snapshot.policy.llmModel` / `redTeamLlmModel` — the models
configured NOW. If the owner swaps models between proposal generation and
review, the badge is stale/wrong for older pending proposals. Fast-follow:
persist `proposedByModel` (and the red-team model actually used) on the
proposal at generation time in `src/lib/strategy.ts` + types, then read it
here. Deliberately NOT done in this PR — another agent owns `src/lib/*`
concurrently (tax.ts / policy.ts / strategy.ts) and this wave must not touch
those files. Same class of caveat applies to the "(policy default)" fallback:
the client can't see an `OPENAI_MODEL` env override, so the default label is
marked as a default in its tooltip rather than asserted as fact.

## Files

- `app/console/ui/ticker-logo.tsx` (new)
- `app/console/ui/provider-logo.tsx` (new)
- `app/console/ui/symbol-drilldown.tsx` (new)
- `app/console/lib/models.ts` (new)
- `app/console/components/nav.tsx` (edit)
- `app/console/components/positions.tsx` (edit)
- `app/console/components/approval-card.tsx` (edit)
- `app/console/console.css` (edit)
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-port-foundation.md` (docs)

## Verification

```bash
npx tsc --noEmit   # clean (exit 0)
npm run lint       # 0 errors, 284 pre-existing warnings (grandfathered)
npm test           # all files pass (see PR/STATUS for the count run this day)
npm run build      # succeeds
```

No `test/alternative-data.test.ts` mockFetcher tsc failure appeared in this run.

## Follow-ups

- **Persist `proposedByModel` per proposal** (the caveat above) — coordinates
  with the `src/lib/strategy.ts` owner.
- Wave 2 creates `app/console/scan|macro|assistant|orders/page.tsx` — the nav
  links exist and 404 until then.
- Consider surfacing intraday change in the drilldown once a live-quote source
  is exposed to the console snapshot (currently last-close vs previous-close
  from `/api/history`, labeled as such).
- If wave 2 needs richer tooltips than native `title`, promote a Tooltip
  primitive into `app/console/ui/primitives.tsx`.
