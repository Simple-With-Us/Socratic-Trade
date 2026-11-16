# 2026-07-10 - pricing-doc-all-sources

## Summary

- Extended `docs/market-data-provider-pricing.md` (kept the existing core-seven table,
  traps list, "what we run today", and "where the dials live" sections intact — added
  new sections, did not rewrite) to cover every other external data source the app
  touches, not just the seven quote/fundamentals/history vendors already documented.
- New "Secondary / fallback sources" table: marketstack, tradier, intrinio, logo.dev,
  Fintech Studios/PowerIntell, FRED — all verified live and wired-in via code
  (`file:line` citations), then priced from live vendor pages fetched today. Six new
  numbered traps (continuing the doc's existing trap numbering at #7).
- New "Keyless & broker-bundled sources" section: yahoo-finance, nasdaq-delayed-screener,
  webull-unofficial, SEC XBRL, SEC EDGAR, alpaca-news/alpaca-snapshot,
  robinhood-quotes/robinhood-fundamentals, stooq — plus a short callout that
  congress.trade (App A) is the owner's own sibling app, not a commercial vendor.
- New "Usage-billed (not subscription) providers" section: one paragraph pointing at
  API-Usage-Monitor for LLM/RAG spend (OpenAI/Anthropic/DeepSeek/Gemini/Mistral/xAI,
  Pinecone, Voyage) — deliberately no price tables, since that app is already the
  source of truth for those rates.
- New "Cheap alternatives — evaluated, not integrated" section (owner scope addition
  mid-task): alphastocks.app (owner-named — turned out to be a consumer
  scoring/screener web app with no developer API surface, not a candidate), EODHD,
  marketdata.app, Finazon, Finage, StockData.org, Databento, financialdatasets.ai, and
  Alpaca's Algo Trader Plus ($99/mo SIP+OPRA upgrade, the one genuine near-term
  candidate since it's additive to Alpaca infra we already hold rather than a new
  vendor). Confirmed IEX Cloud is defunct (shut down permanently August 2024) so it
  stops getting re-suggested. Section ends with a "switch calculus" paragraph: a new
  provider needs a full `SymbolEnrichment` wiring pass per this repo's own
  AGENTS.md per-field-enrichment checklist, so it has to beat an incumbent by a real
  margin, not $5/mo — none of the surveyed alternatives clear that bar today.
- Flagged a real gap in "Where the dials live": `src/lib/provider-rate-limit.ts`'s
  `HARD_DEFAULTS` map has entries for exactly four providers (finnhub, alpha-vantage,
  yahoo-finance, twelvedata) — marketstack, tradier, intrinio, fred, fintechstudios,
  and logodev have NO hard-coded pacing/concurrency default. Documented this
  explicitly as a known gap rather than inventing a knob that doesn't exist.

## Why

- Owner: "consider all the other data sources we have too, not just those few —
  marketstack, and any others." The 2026-07-10 canonical pricing doc (PR #1368) only
  covered the seven vendors already in the market-scan/enrichment cascade's main
  quote/fundamentals/history path; the app touches several more paid/rate-limited
  sources (marketstack, tradier, intrinio, FRED, Fintech Studios, logo.dev) plus a
  larger set of keyless/broker-bundled sources that were undocumented anywhere as a
  single reference.
- Mid-task, the owner separately asked to fold in a survey of cheap/budget
  alternatives not currently integrated, including a specific ask to investigate
  alphastocks.app by name. Rather than opening a second PR, this landed in the same
  branch/PR since it's the same doc and the same research pass.

## Files

- `docs/market-data-provider-pricing.md` (extended — new sections, existing content
  unchanged except two small additions: a "Scope, extended 2026-07-10" paragraph in
  the intro, and a "Known gap" paragraph + one cheat-sheet row in "Where the dials
  live")
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-07-10-pricing-doc-all-sources.md` (this note)

## Verification

- Code-verification method: grepped `src/lib/*.ts` and `app/**/*.ts` for every env
  var / provider name named in the task brief (MARKETSTACK_API_KEY, TRADIER_API_KEY,
  INTRINIO_API_KEY, FRED_API_KEY, FINTECH_STUDIOS_API_KEY, LOGO_DEV_TOKEN,
  CONGRESS_TRADE_TOKEN, plus the keyless/broker sources) before writing any pricing
  claim, to confirm each is actually live/wired-in (none turned out dead — all are
  either in `KEYED_HISTORY_SERVICES`, pushed into the enrichment cascade in
  `getEnrichmentProvider`, or an active keyless fetch path). Citations are
  `file:line` throughout the new sections.
- Pricing research: two parallel background research agents (marketstack/
  tradier/intrinio/logo.dev/fintechstudios/FRED; and the cheap-alternatives survey)
  plus direct `WebFetch`/`WebSearch` calls made in this session as a cross-check —
  the two sources corroborated on every overlapping number (marketstack tiers,
  Tradier sandbox-vs-production behavior, Intrinio's three tiers, logo.dev's four
  tiers, Fintech Studios ambiguity, FRED being free with an undocumented rate limit).
  Where a page would not render live (`fred.stlouisfed.org` 403'd every fetch
  attempt except `curl --http1.1`; Finage's cheaper tiers referenced by third-party
  summaries did not appear on the live pricing page), the doc says so explicitly
  instead of asserting a number.
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- (exact pass/fail results and any re-runs: see the commit this note ships with —
  `scripts/land.sh` runs `tsc --noEmit` -> `npm test` -> `npm run build` and aborts
  on any failure, so a landed commit implies all three passed)

## Follow-ups

- Fintech Studios pricing for the actual `studio.fintechstudios.com/api/v1` endpoint
  this app calls is still unconfirmed — the published self-serve numbers are for a
  different (consumer PowerIntell) product surface. Worth a direct vendor contact if
  that provider's cost ever needs to be known precisely (e.g. for a renewal
  decision), rather than re-deriving from the marketing site again.
- `provider-rate-limit.ts` has no `HARD_DEFAULTS` entry for marketstack, tradier,
  intrinio, fred, fintechstudios, or logodev. Not fixed here (out of scope for a
  docs-only pricing pass) — flagged as a known gap for whoever picks up rate-limit
  hardening next; the generic `PROVIDER_RATE_LIMIT_<NAME>_*` env override already
  works if 429s appear before a hard default is wired.
- Finage's pricing page may have a JS-gated tier toggle that a raw-HTML/headless
  fetch didn't render — the ~$599/mo floor is confirmed, but a cheaper historical
  tier referenced only in third-party AI summaries was not independently confirmed.
  Worth a manual browser check if Finage is ever seriously considered.
- No code changes in this PR — purely documentation. The related "Provider-knob
  sync: API-Usage-Monitor -> Infisical" effort (branch `claude/provider-knob-sync`,
  PR #1370, in progress concurrently) is the natural next step for turning any of
  these newly-documented facts into real automated knobs.
