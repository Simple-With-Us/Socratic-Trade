# 2026-07-16 — EarningsCalls.dev transcript source (owner-directed; free-plan budget design)

## Summary

New earnings-call-transcript source for the RAG/evidence corpus, built around the owner's
chosen **free plan (HARD 200 requests/month)** on the EarningsCalls.dev RapidAPI listing.
The app's paid FMP plan does not entitle transcripts (HTTP 402 — `docs/fmp-capabilities.md`),
and FMP's RapidAPI listing gates them identically ("Exclusive Endpoint", live-probed), so
this is the only free transcript feed available.

Design (new `src/lib/earningscalls-transcripts.ts` + `earningscalls-gate.ts` +
`db-earningscalls.ts`, migration **v47**):

- **Dual transport, one source.** `EARNINGSCALLS_RAPIDAPI_KEY` (x-rapidapi-* headers @
  `earnings-call-transcripts1.p.rapidapi.com` — the owner's channel, key installed in
  Infisical prod) or `EARNINGSCALLS_API_KEY` (first-party `X-API-Key` @ earningscalls.dev,
  paid-only; wins if both set). Either key IS the opt-in; `EARNINGSCALLS_DISABLED=1` is the
  kill-switch. No key = nothing constructed, zero calls, and previously-ingested chunks stop
  being retrievable (symmetric gate, mirroring FMP rights-flag withdrawal).
- **Durable monthly budget under the hard cap.** UTC-calendar-month counter persisted in
  settings (survives restarts/deploys), default `EARNINGSCALLS_MONTHLY_BUDGET=180` (20
  requests of headroom), **reserve-before-call** (synchronous better-sqlite3 reservation —
  races cannot overspend), `retries: 0` on the transport so one reservation can never become
  two provider requests; refund ONLY on pre-dispatch circuit-open. Exhaustion = quiet skip,
  at most one audit/day.
- **Fetch-once-forever cache** keyed (symbol, fiscal_year, fiscal_quarter); a row with
  content is immutable and never re-fetched. Negative cache (`content` NULL) with
  `EARNINGSCALLS_NEGATIVE_TTL_DAYS=3` so a budget-costing miss doesn't repeat daily.
- **Holdings-first selection** on a once-per-UTC-day scheduler pass (fire-and-forget, gated
  on the monthly LLM/RAG spend ceiling): symbols held in any account's latest recent
  portfolio snapshot (broker-call-free read, new `listRecentlyHeldSymbolsAllUsers`) whose
  latest earnings call is within `EARNINGSCALLS_RECENT_DAYS=7`, then up to
  `EARNINGSCALLS_TOP_CANDIDATES=3` of the last scan's top candidates;
  `EARNINGSCALLS_MAX_REQUESTS_PER_PASS=6` (~180/30).
- **Downstream:** transcripts ingest through the existing #1586 rights-gated boundary
  (`doc_type "earnings-transcript"`, `source "earningscalls-dev"` — the shared doc type keeps
  transcript retrieval one lane; per-source enforcement in vector-db's transcript-rights
  filters). Strategy + chat request the doc type when EITHER the FMP rights claim or this
  source's gate is active. Transcript content never reaches user-facing pages.

## Why

Owner directive (2026-07-16): use the EarningsCalls.dev free plan now, possibly paid later.
The free plan exists only on the RapidAPI marketplace (no free tier direct) — confirmed by
the owner and by probes. Verified separately: FMP transcripts stay entitlement-gated on both
FMP channels (direct 402; RapidAPI 403 "Exclusive Endpoint" with an otherwise-working
subscription — 250 req/day quota headers returned).

**Access note (unresolved at land time):** live probes of the RapidAPI listing returned
HTTP 405 `"The API provider has disabled request access to the API"` on every path —
most likely the free-plan subscription hadn't been completed on the listing yet
(`rapidapi.com/earningscallsdev/api/earnings-call-transcripts1`). The source lands DORMANT
until access works; parsers are shape-tolerant and unit-tested against researched
expectations, with a documented first-live-pass verification follow-up. The first-party API
was verified live (401 handshake, /openapi.json endpoint shapes) during research.

**Build provenance:** the implementing subagent hit a usage cap after essentially completing
the build (module, db layer, gate, scheduler/strategy/chat/vector-db wiring, 20 tests, tsc
clean); MONET finished inline: dual-transport pivot (the agent had targeted the first-party
host only), RapidAPI listing/endpoint verification, Infisical key slot
(`EARNINGSCALLS_RAPIDAPI_KEY` — created, then repaired after the Infisical MCP update tool
blanked-instead-of-renamed), migration renumber v46→v47 around main's #1667, gate tests.

## Files

New: `src/lib/earningscalls-transcripts.ts`, `src/lib/earningscalls-gate.ts`,
`src/lib/db-earningscalls.ts`, `test/earningscalls-transcripts.test.ts`,
this note. Modified: `src/lib/db.ts` (migration v47 + barrel export), `src/lib/scheduler.ts`
(daily pass hook), `src/lib/strategy.ts` (doc-type request gate), `src/lib/vector-db.ts`
(per-source transcript-rights filters), `src/lib/chat/orchestrator.ts` (rights handling),
`src/lib/db-fills.ts` (`listRecentlyHeldSymbolsAllUsers`), `.env.example`,
`test/persistence-hardening.test.ts` (schema pin 47), `STATUS.md`, `docs/EFFORT-LOG.md`.

## Verification

Full gate on the final tree (branch merged with `origin/main` @ `8ada327d`, absorbing
#1667/#1674 — migration renumbered v46→v47 around #1667's deployed v46; stash-pop conflict in
`db.ts` resolved with main's v46 verified byte-identical), under node@24:

```
npm run lint       # 0 errors (507 grandfathered warnings)
npx tsc --noEmit   # clean
npm test           # 401 files, 4627 tests — all passed
npm run build      # clean
```

Reviews: two adversarial lenses, both **SAFE_TO_LAND with zero must-fix**. Budget/rights lens
failed all six refutation attempts (documented in its report: retries:0 single-dispatch proof,
pre-dispatch-only refund, synchronous reservation atomicity, symmetric retrieval gating on
both vector-db paths, FMP rights machinery untouched by namespace/id-prefix separation,
negative-cache content-preservation) and filed P2/P3 advisories (provider anniversary-window
vs calendar-month note → .env.example; late-published-transcript coverage gap; ingest-retry
head-of-line; fiscal-vs-calendar key flip — all bounded, documented). Structural lens proved a
fresh-DB migrate to v47 and per-file diff-purity vs main. Its one real finding (TZ-unsafe
event-date parsing → wrong quarter cache-key near boundaries) was fixed pre-land
(`parseEventDateUtcMs` + boundary regression tests, suite run under host TZ and Asia/Tokyo).
EarningsCalls suite: 23 tests (budget reserve/refund/race/rollover/persistence, dormancy +
channel precedence, fetch-once + negative TTL, selection bounding, parsers, TZ pins).

## Owner activation / follow-ups

- **Activation:** complete the free-plan subscription on the RapidAPI listing if not already
  ("Start Free Plan" on `rapidapi.com/earningscallsdev/api/earnings-call-transcripts1`).
  `EARNINGSCALLS_RAPIDAPI_KEY` is already in Infisical prod; the next deploy after
  subscription = live. If probes still 405 after subscribing, the provider has proxy access
  disabled — contact them, or the fallbacks are their paid direct API or API-Ninjas.
- **First-live-pass check:** verify the shape-tolerant parsers against real responses (the
  module header documents which shapes were VERIFIED vs ASSUMED); budget accounting makes
  this cost ~2-3 requests.
- Owner heads-up (accepted): the RapidAPI key appeared in this session's transcript twice
  (screenshot + Infisical MCP echo); owner deferred rotation ("fix later"). Rotating =
  regenerate on RapidAPI, update the Infisical secret, redeploy.
- Standing wave-1/2 owner decisions unchanged (autoResumeOnBoot, FMP_PRICE_TARGETS_ENABLED,
  QUIVER_API_KEY, SENTRY_CRONS, Safari-extension scaffold).
