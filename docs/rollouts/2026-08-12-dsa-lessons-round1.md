# 2026-08-12 — Lessons from ZhuLinsen/daily_stock_analysis, round 1 (digest, relevance, receipts)

## Context & Objective

Owner request: "implement lessons you can learn from https://github.com/ZhuLinsen/daily_stock_analysis" (62k-star Python LLM daily stock-analysis system), later broadened to a moderately broad GitHub sweep (round 2, separate rollout note).  Method: a 15-agent research workflow (6 repo readers, 1 synthesis, 8 gap analysts) produced 8 candidate lessons, all recommended; the top 3 by value-per-risk were implemented in this PR, 5 deferred as Planned board rows.  Full verdicts + sketches: `docs/reviews/2026-08-12-dsa-lessons-gap-analysis.md`.

## Changes Made

Slice 1 — opt-in daily watchlist digest with tiered channel rendering (`c2b3f698`):
- `trade_proposals` gains a real `symbol` column (migration + one-time `json_extract` backfill + `(symbol, account_number, created_at)` index); `listProposalsBySymbol()` in `db-proposals.ts`.
- New `report-context.ts` (typed watchlist context: latest persisted market-scan quote + latest proposal + trailing 5-proposal trajectory per symbol; no provider calls) and `report-renderer.ts` (full/medium/brief pure renderers, CT dates, no fabricated rows).
- `notify()` learns `bodyTiers` + a per-channel `CHANNEL_CAPABILITIES.maxBodyChars` table (sms 1500 / pushover 1024 / push 4000 / email+webhook unbounded), delivering the largest tier that fits; existing single-body callers byte-for-byte unchanged.  This also retires the latent pushover/ntfy truncation gap.
- New `watchlist-digest.ts` scheduler lane (once per CT day, at/after 15:15 CT post-close, watermark-gated, modeled on the R2 digest lane) + `watchlist_digest` notification event type + a default-OFF toggle in Settings -> Delivery.
- 78 tests across 6 new/extended files.

Slice 2 — entity-relevance gating for news context (`38735f59`):
- New leaf `news-relevance.ts`: additive relevance rubric (word-boundary ticker/$TICKER, company name) with an `AMBIGUOUS_COMPANY_NAMES` denylist (apple, meta, square, target, gap, ...) that only scores when a corroborating finance-event term co-occurs; human-readable `reasons[]`.
- Alpha Vantage: `ticker_sentiment[].relevance_score` (previously discarded) now gates headline keep + sentiment folding.  Marketaux: `entities[].match_score` (previously discarded) gates aggregation; unscored entities pass through.  Finnhub + Alpaca/Benzinga stream titles are scored via the rubric; a below-threshold drop removes only that symbol's association.
- Owner knobs in the source-settings catalog (`NEWS_RELEVANCE_FILTER` default on, `NEWS_RELEVANCE_MIN_SCORE` default 0.35); knob-off is passthrough-identical.  Per-run aggregate `news_relevance.dropped` audit only.

Slice 3 — auditable proposal repair-ladder receipts (`c68746ef`, money-path):
- `TradeProposal.dataAdjustments?: string[]` — kind-prefixed machine-queryable receipts (mirrors `preVetoReasons` style).
- New `proposal-phase-guard.ts`: deterministic session-vs-phrasing check ("buy now"/"at the open" while closed/premarket; recap phrasing mid-session) appending a receipt — never rewrites, never blocks.
- New `policy.tuning.confidenceCapDataDegraded` knob (defaulting like `convictionCapUncorroborated`; 0 disables): caps the confidence contribution when the proposal's core inputs were degraded at generation time, with a receipt naming the degraded inputs.
- Existing `enrichOpeningProposal` free-text disclosures (ATR>beta>flat bracket fallback etc.) now also write matching receipts; approval card renders the receipts list.

## Decisions & Trade-offs

- The external repo's score-band-to-action conflict check was deliberately NOT ported: ST's schema makes the action the `side` itself, so the conflict cannot arise (gap analyst confirmed).
- Digest is opt-in (default OFF) and reads only already-persisted data — no new provider spend.
- Relevance filtering never drops provider-unscored entities and zero-surviving-headlines behaves exactly like today's no-coverage.
- Deferred round-1 lessons (Planned rows on the board): unified proposal scorecard, social/prediction-market sentiment (needs owner API-key decision), strategy overlay library, Bayesian trust-weight unification, chat SSE stage events.

## Verification State

- Per-slice: tsc clean + slice tests green + adversarial verify approved on all three (digest: 3 minors/3 nits; relevance: 2 minors/2 nits; receipts: 2 nits — no blockers/majors anywhere).
- Integration pass (this PR's final commit) fixed every actionable finding: Marketaux `match_score` normalized /100 so the 0-1 relevance knob actually gates (it was inert at any UI-settable threshold); the stream filter made conservative (single-symbol articles always trust Benzinga's attribution; multi-symbol drops only zero-evidence associations) because the stream payload carries no company name for the rubric; `watchlist_digest.sent` audit renamed to `.undelivered` when no channel delivered; migration backfill gained `TRIM` to match `normalizeSymbol`; the medium renderer's dead `?? -1` ranking branch removed; delivery-toggle tooltip two-spaced; `bracket_stop_invalid_discarded` wording no longer overstates; two test-hygiene fixes (temp-DB naming convention, order-independent digest assertions).
- Commands run in this worktree (2026-08-12): `npm run lint` -> 0 errors; `npx tsc --noEmit` -> clean; targeted `npx vitest run` over the six affected files -> 76/76.  `npm test` (full suite) and `npm run build` run by `scripts/land.sh` immediately before push — land.sh aborts on any failure, and the required `verify` CI gate re-runs lint/tsc/test/build before merge.

## Next Steps & Blockers

- Round 2 (broad sweep) lands separately: benchmark-alpha outcome grading, live signal-health monitor, cancel-dust advisory; 4 further wins Planned.
- Owner may enable the digest in Settings -> Delivery once deployed.
