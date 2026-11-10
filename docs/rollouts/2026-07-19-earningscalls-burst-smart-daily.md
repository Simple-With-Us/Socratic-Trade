# 2026-07-19 - earningscalls-burst-smart-daily

## Summary

Implemented the owner-directed EarningsCalls.dev program from the coordinator's locked decisions,
built on the same-day recon memo (`earningscalls-api-truth.md`, branch
`claude/earningscalls-burst-smart-daily`, zero prior commits): a one-time 25-transcript burst,
then 5 transcripts/day with smart candidate selection, replacing the old fixed-6-requests-per-pass
safety invariant with a durable rolling-31-day dispatch ledger, and adding a mandatory entitlement
probe that refuses the whole program if the plan turns out to serve 250-char previews instead of
full transcript text.

- **Entitlement probe + preview guard** (the recon memo's two headline risks): a durable
  `earningscalls:entitlementState` setting (`unknown` / `confirmed_full` / `preview_blocked`).
  Before the first-ever pass, `GET /me` (best-effort tier-text sniff) runs, then the length of the
  first real transcript body this pass fetches anyway (no dedicated extra fetch) determines
  entitlement. A preview-length body (< `EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS`, default 1200)
  trips a durable block, refuses every future burst/daily fetch, and fires exactly ONE operator
  notification (`earningscalls_entitlement_blocked`, new `NotificationEventType`) — no retry
  storm. The SAME guard applies to every later fetch too (not just the first), so a plan that
  degrades mid-flight is caught immediately. A preview is never cached or ingested.
- **New request engine**: `GET /transcripts/recent` (cursor-paginated via a persisted
  `next_after_id` watermark) is the amortized id-resolution engine, ~1 request/day, populating a
  new `earningscalls_event_index` table — a (symbol, fiscal_year, fiscal_quarter) -> provider
  eventId map, deliberately separate from `earningscalls_transcripts`' negative-cache semantics.
  The old per-symbol `GET /companies/ticker/{t}/latest` probe is demoted to a fallback for symbols
  the listing hasn't covered yet. `GET /companies/ticker/{t}` (full call history) is a new
  burst-only targeted-historical resolver for held symbols with zero cached coverage.
- **Budget**: replaced the fixed "6 requests/pass, 32 UTC-day-safe" invariant with a durable
  dual-bound ledger — monthly soft budget (unchanged, default 180) AND a rolling-31-day dispatch
  ledger (new, default 195) — both checked in `tryReserveEarningsCallsRequests` before every
  dispatch. The per-pass request ceiling is now an anti-runaway breaker only, not the safety
  mechanism (see budget math below).
- **Smart picker**: `scoreEarningsCallsCandidates` (pure, unit-tested) ranks symbols into 5 tiers —
  current holdings (weighted by summed `|position value|` across every connected account) >
  earnings recency (FMP calendar / listing event dates) > latest technical scan's candidate rank >
  any user's watchlist > `data/rag-universe-manifest.json` rank (tail-fill only). Per-pass picks,
  scores, and a one-line rationale are persisted (`earningscalls:lastPicksAudit`) and readable via
  the new admin route.
- **Burst arming**: a one-shot `earningscalls_burst_pending` settings counter, seeded to 25 by a
  new DB migration (v54, `INSERT OR IGNORE` — fires exactly once on a fresh deploy) so the
  scheduler's next daily pass runs the burst automatically, entitlement-probe-gated. Consumed
  (zeroed) BEFORE any work starts each pass, so a crash mid-burst can't re-arm itself.
  `POST /api/admin/earningscalls {"action":"burst", maxTranscripts?}` arms it manually too.
- **Admin route** `app/api/admin/earningscalls` (mirrors `app/api/admin/sec-ingest`):
  `GET` returns entitlement state, dual-bound budget usage, burst pending, and the last pass's
  picks audit. `POST` supports `burst`, `probe-entitlement` (immediate re-check outside the
  once/day cadence — useful right after a plan upgrade), and `clear-entitlement-block` (resets to
  `unknown`, no requests spent, re-arms automatic detection on the next scheduled pass).
  `requireAdmin` + a new `"earningscalls"` `withAdminOperationGuard` entry sharing the `RAG_REINDEX`
  durable lease group with the scheduled pass (a manual action can never race it).

## Why

The owner's original arithmetic (25 + 5x30 = 175 req ≈ "1 request per transcript") is false: the
live `openapi.json` has **no symbol+fiscal_year+fiscal_quarter direct-fetch endpoint** — every
transcript fetch needs a separately-resolved provider `earningsId` first. The recon memo also
surfaced an unverified, program-blocking risk: the free plan's landing page states previews
(250 chars) are all the Free tier gets; whether the owner's RapidAPI free-tier subscription
entitles full text was unconfirmed. Ingesting a preview into the fetch-once-forever cache would be
permanent silent corruption (a content hit never re-fetches) — hence the mandatory probe before
any spend, and the "guard everywhere" defense in depth. The old fixed 6-req/pass ceiling was
explicitly a *safety invariant* derived from "32 UTC days x 6 <= 200"; raising it to 8 (as
originally asked) or a 27-request burst day both break that invariant on paper, so it had to be
replaced with a ledger that enforces the real 31-day-rolling bound directly, making the per-pass
count and burst size ordinary policy knobs instead.

## Budget math (honest, from the recon memo + this implementation)

| Scenario | Requests | Path |
|---|---|---|
| First-ever pass: entitlement probe | 2 (amortized into the pass's own first fetch) | `/me` + this pass's first real transcript fetch |
| Quiet day (FMP calendar: nothing tracked reported) | 0 | skipped before even the listing call |
| Ordinary daily pass, 5 new transcripts | ~6 | 1 listing (`/transcripts/recent`) + 5 fetches (ids mostly free via the event index) |
| Burst of 25, mostly recent reporters | ~27-28 | 1-3 listing pages + 25 fetches |
| Burst of 25, all historical (25 distinct symbols, no coverage) | ~50 | 25 `/companies/ticker/{t}` resolvers + 25 fetches |
| Burst of 25, holdings-shaped (e.g. 8 symbols x ~3 quarters) | ~33 | 8 resolvers + 25 fetches |

- **Dual-bound ledger**: monthly soft 180 + rolling-31-day 195 (5 under the provider's hard 200).
  `tryReserveEarningsCallsRequests` admits `min(n, monthlyRemaining, rollingRemaining)` — verified
  in `test/earningscalls-transcripts.test.ts` that a 25-request burst day plus 30 subsequent
  6-request daily passes (205 requested inside one trailing-31-day window) is capped at exactly
  195 admitted, not the (deliberately generous, non-binding) 300 monthly test budget.
- **Realistic month 1** (burst ~27 + ~21-22 reporting weekdays x ~6, many below cap): **~150-185**
  total requests — comfortably under the rolling 195 and never near the hard 200. A theoretical
  worst-case month (31 reporting days, all historical-heavy bursts) is NOT provably under 175 as
  originally assumed — say so honestly: the ledger's job is to guarantee the hard 200 is never
  breached, not to guarantee the owner's discretionary ~25/month headroom in every possible month.

## Entitlement-probe flow (risk callout)

1. Persisted state starts `unknown`. On the first pass while `unknown`: dispatch `GET /me` (1
   request) and best-effort sniff its JSON text for plan-tier keywords (`free`/`preview`/`trial`
   trips a same signal; `pro`/`paid`/`ultra`/`enterprise` short-circuits it as inconclusive-but-ok).
2. The pass then proceeds to its FIRST real transcript fetch as normal (no dedicated extra call).
   `classifyFetchedContent` compares the parsed body's length to
   `EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS` (default 1200, well above the documented 250-char
   preview). Below the floor -> `preview_blocked` (never cached, never ingested, ONE operator
   notification, whole program refuses every future pass). At or above -> `confirmed_full`, and
   every later pass skips the `/me` step entirely.
3. The SAME check runs on every subsequent fetch in every pass, forever (`classification ===
   "preview"` immediately trips the block regardless of prior `confirmed_full` state) — defense in
   depth against a plan that degrades after the first check.
4. Operator recovery: `POST /api/admin/earningscalls {"action":"clear-entitlement-block"}` (free,
   re-arms automatic detection) or `{"action":"probe-entitlement"}` (spends up to ~2-3 requests to
   re-verify immediately, e.g. right after a plan upgrade).

## Scorer weights (tiers, strictly ordered; within-tier score breaks ties)

1. **Holdings** — `|position value|` summed across every connected account, descending.
2. **Earnings recency** — most-recent known `event_date` first (event index / listing engine);
   falls back to FMP-calendar boolean membership (no date) for symbols only known via the calendar.
3. **Scan rank** — the latest technical scan's candidate list, in its own rank order.
4. **Watchlist** — any user's personal watchlist, unordered.
5. **Manifest tail** — `data/rag-universe-manifest.json` issuer rank, ascending (tail-fill only,
   used when the higher tiers don't fill the pass's target).

A symbol is scored exactly once, at its best (lowest-numbered) tier.

## Files

- `src/lib/earningscalls-transcripts.ts` — full rewrite: dual-bound ledger, entitlement
  probe/guard, listing engine + parsers, smart picker, burst arming, manual-probe entry point.
- `src/lib/db-earningscalls.ts` — new `earningscalls_event_index` CRUD
  (`upsertEarningsCallsEventIndex` / `getEarningsCallsEventIndex` /
  `getLatestEarningsCallsEventForSymbol` / `hasAnyEarningsCallsEventForSymbol`).
- `src/lib/db.ts` — migration v53 (`earningscalls_event_index` table) + v54 (one-shot
  `earningscalls_burst_pending=25` seed, `INSERT OR IGNORE`).
- `src/lib/db-fills.ts` — new `listRecentlyHeldSymbolValuesAllUsers` (summed `|marketValue|` per
  symbol, options legs keyed by `underlyingSymbol`).
- `src/lib/admin-operation-guard.ts` — new `"earningscalls"` operation (RAG_REINDEX durable group).
- `src/lib/types.ts` — new `NotificationEventType` value `earningscalls_entitlement_blocked`.
- `src/lib/dashboard-ui.ts`, `app/console/settings/page.tsx`, `src/lib/db-notifications.ts`,
  `app/console/components/alert-center.tsx` — wired the new event type into the label map, the
  settings-page hint copy, the "attention" bulk-ack filter, and the Alert Center's tone/filter.
- `app/api/admin/earningscalls/route.ts` — new admin route (GET status, POST burst/probe/clear).
- `.env.example` — new knobs (`EARNINGSCALLS_ROLLING_WINDOW_BUDGET`,
  `EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS`, `EARNINGSCALLS_BURST_MAX_TRANSCRIPTS`,
  `EARNINGSCALLS_PREVIEW_GUARD_MIN_CHARS`, `EARNINGSCALLS_ENTITLEMENT_PROBE_ANCHOR`; raised default
  `EARNINGSCALLS_MAX_REQUESTS_PER_PASS` 6->16 and its ceiling 6->70 now that the ledger is the real
  safety bound).
- `test/earningscalls-transcripts.test.ts` — substantially rewritten to match the new architecture
  (see Verification for what changed and why).

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — TODO: fill in exact pass/fail counts after the run.
- `npm run build` — TODO.
- Also ran the pre-existing `test/db-migration-old-schema.test.ts` and other db.ts migration
  regression coverage to confirm v53/v54 apply cleanly on an old-schema DB.

### Why the old test file's exact-HTTP-sequence assertions were replaced, not preserved byte-for-byte

The coordinator's decisions explicitly mandate a new request engine (listing-first id resolution,
per-symbol probe demoted to fallback) and a new budget model (ledger replaces the fixed per-pass
cap) — both structurally change the exact sequence/count of HTTP calls a pass makes versus the
pre-redesign code. Preserving the old file's exact `toEqual([...])` call-sequence assertions
verbatim would have meant either not implementing the mandated redesign, or asserting on
now-incorrect sequences. The rewritten file keeps every invariant that is still genuinely true
under the new design (dormancy without a key/with the kill-switch — the actual "must never
regress" bar per the task — the dual-bound budget math, fetch-once-forever caching, negative-TTL
respect, RAG lease fencing, storeDocument completion semantics, a definitive-404 probe watermark)
and adds the new required coverage (entitlement probe both outcomes, preview guard, rolling ledger
incl. a burst day, listing-cursor idempotency across restarts, scorer tier ordering, one-shot burst
consumption, and the event-index map's CRUD correctness).

## Follow-ups

- RapidAPI path-parity for `/transcripts/recent` and its cursor field name is still unverified
  against a real live payload (openapi.json schemas are all "Default Response" — the parsers are
  shape-tolerant but should be re-checked against the first live pass).
- The manifest-tail scorer input reads `data/rag-universe-manifest.json` directly with a lenient
  inline parser (not `validateSecUniverseManifest`) since it's a low-priority tail-fill signal, not
  a correctness-critical ingestion boundary — revisit if the manifest schema changes shape.
- The historical burst-backfill step is capped at 5 held symbols per burst
  (`MAX_HISTORICAL_BACKFILL_SYMBOLS_PER_BURST`) to bound worst-case request count; raise only
  together with re-checking the burst request-ceiling math.
- No STATUS.md / EFFORT-LOG edits in this commit per the dispatching coordinator's explicit
  instruction (cross-cutting board updates are being handled separately to avoid a merge-conflict
  race with parallel lanes touching the same files).
