# 2026-07-09 — Filings "looked for but not found" receipts: honest copy + demand-first, faster ingestion

**Agent:** MONET (session `aapl-fundamentals-missing-e3ea01`, branch `monet/aapl-fundamentals-missing-e3ea01`)

## Summary

Owner report: "many stocks say that a document was looked for but not found since there
isn't much in the RAG yet. can we fix that or how hard would that be to fix?"

Diagnosis (2-agent recon, adversarially cross-checked against the 2026-07-08
multi-issue-troubleshoot note): the message is the run-level prompt-safety receipt
built in `src/lib/strategy.ts` (~line 966) — old title **"Requested filings doc type
never ingested"**, warning-orange — attached to EVERY decision case each run
(socratic-runtime tail-append), so every stock's card showed it. It fires because the
corpus genuinely is near-empty: SEC filings ingestion ran **at most once per week**
(7-day TTL stamp), **1 filing per run** (free-tier heuristic `VECTOR_EMBED_BATCH_DELAY_MS
> 5000` ⇒ cap 1; but the PAID-tier default cap was ALSO 1), in **alphabetical order**
over a ~515-symbol universe (~2,000-filing backlog ≈ decades at that pace; 2 filings
ever ingested). The admin backfill route (`POST /api/admin/reindex-10k`) silently
no-oped for up to 7 days after any scheduler attempt (TTL stamp) and stayed capped at 1
on free-tier env — defeating its purpose.

Changes (all landed together with the enrichment no-cap revision — same PR):

1. **Honest copy, neutral tone** (`src/lib/strategy.ts`): title is now "Filings library
   still warming up"; summary says how many filings are ingested so far and that
   ingestion is paced and fills watchlist/held names first. Tone downgraded
   warning → neutral: an advisory warm-up receipt on every card shouldn't wear the same
   orange as a real safety warning. Audit event and `data` payload unchanged.
2. **Demand-first ingestion order** (`src/lib/scheduler.ts`): the ingest symbol list is
   now user watchlists → last scan's candidate set (`getTechnicalWatchlist()`, which
   force-includes held positions) → policy-universe tail, instead of one alphabetical
   Set union. The capped per-run ingest now fills the names decisions actually retrieve
   against, instead of grinding from "A". (`getTechnicalWatchlist` newly re-exported
   from `src/lib/web-sources/index.ts`.)
3. **Ingestion pacing knobs** (`src/lib/web-sources/sec-filings.ts`):
   - `SEC_FILING_INGEST_TTL_HOURS` (default 168 = weekly, unchanged) — paid-tier
     operators set 24 to drain the backlog daily.
   - Paid-tier per-run default raised 1 → 25 (`DEFAULT_PAID_MAX_FILINGS_PER_RUN`);
     free-tier stays 1 (a bigger cap stalls the scheduler tick for hours at free embed
     pace). `SEC_FILING_RAG_MAX_PER_RUN` still wins when set.
   - `refreshFilingBodies(symbols, now, maxPerRun?, { force? })`: explicit `maxPerRun`
     is an operator decision and overrides the free-tier pin; `force: true` skips the
     TTL gate. The audit row now records `forced`.
4. **Admin backfill actually works** (`app/api/admin/reindex-10k/route.ts`): passes
   `force: true` and forwards `limit` only when provided (it used to default to
   Infinity, which the paid tier consumed as "no cap"; now omitted ⇒ tier default).

## Why

The receipts were honest but the framing read as a per-symbol lookup failure, and the
warm-up was effectively permanent: at 1 filing/week the store would never fill. The real
fix is (a) say what's actually happening, (b) make the warm-up finite and aimed at the
symbols that matter.

## Prod env to activate the faster pace (owner or announced deploy step)

In Infisical prod (Voyage key is paid-tier per /api/health):

- `VECTOR_EMBED_BATCH_DELAY_MS=0` (defeats the free-tier heuristic)
- `SEC_FILING_INGEST_TTL_HOURS=24` (daily instead of weekly)
- `SEC_FILING_RAG_MAX_PER_RUN` — leave unset (new paid default 25/run)
- optionally `RAG_INGEST_MAX_TEXTS_PER_DAY=5000` for a faster backfill (default 1000
  chunks/day ≈ 3–8 filings/day; Voyage/Pinecone spend counts toward LLM_SPEND_CEILING)

At 25/day the watchlist + held + scan-candidate head of the queue is covered in the
first days; the full ~2,000-filing universe backlog drains in ~3 months (or faster with
the daily-chunk budget raised). Receipt disappears per doc type after its first ingest.

## Files

- `src/lib/strategy.ts` — receipt copy + tone + ingested-count context
- `src/lib/scheduler.ts` — demand-first ingest ordering
- `src/lib/web-sources/sec-filings.ts` — TTL env knob, paid default 25, force flag,
  explicit-limit override, forced audit field
- `src/lib/web-sources/index.ts` — re-export `getTechnicalWatchlist`
- `app/api/admin/reindex-10k/route.ts` — force + honest limit forwarding
- `.env.example` — `SEC_FILING_INGEST_TTL_HOURS`, `SEC_FILING_RAG_MAX_PER_RUN` comments
- Tests: `test/sec-filings.test.ts` (4 new: force bypass, explicit-limit override,
  paid default >1, TTL env), `test/rag-doc-type-coverage.test.ts` (new title/tone,
  advisory-invariant phrase updated)

## Verification

- `npx vitest run test/sec-filings.test.ts` — 29/29
- `npx vitest run test/rag-doc-type-coverage.test.ts` — 14/14
- `npx vitest run test/data-providers.test.ts` — 91/91 (no-cap revision)
- Full gate (lint, tsc, full vitest, build) run pre-land — see PR.

## Landing addendum (2026-07-09, CLAUDE usage-cap pickup round 2)

MONET's session hit the usage cap with be2d611f committed and three coherent follow-on
refinements uncommitted. CLAUDE committed them as-is (bc963f84) and landed the branch:

- `src/lib/market.ts` — enrichment order now puts EVERY held position first, including
  holds ranked inside the top-N cut (which `heldExtra` deliberately excludes), then event
  outliers, then the ranked tail: an explicit `FMP_MAX_SYMBOLS` throttle or scarce
  per-scan budget starves the tail, never an owned name.
- `src/lib/web-sources/sec-filings.ts` (`ingestFiling`) — when `storeDocument` returns
  `indexed <= 0` or a `budgetSkipped`/`writeUnitBudgetSkipped` count with no error (daily
  chunk budget exhausted mid-run — an EXPECTED state during the paid backlog drain), the
  accession is NOT recorded, so a later run retries instead of marking the filing
  "ingested" with zero/partial retrievable chunks. Both fields verified present on the
  `storeDocument` result type (`src/lib/vector-db.ts`).
- `src/lib/web-sources/sec-filings.ts` (`refreshFilingBodies`) — forced runs (admin
  backfill) no longer write the attempt stamp, so a targeted backfill can't push the
  scheduled corpus-wide ingest back a full TTL window.
- `.env.example` — `SEC_FILING_RAG_MAX_PER_RUN` left unset so the tier default applies.

Full-gate catch at landing: `test/strategy-prompt-safety.test.ts` asserted every
kind-'safety' decision-case item wears tone 'warning' — stale against the deliberate
neutral warm-up receipt (which fires there because the test corpus is empty). Fixed to
assert warning tone on the two receipts that test is about (injection + evidence-age);
MONET's commit had updated `test/rag-doc-type-coverage.test.ts` for the tone change but
missed this file.

Landing: merged `origin/main` clean (no conflicts; no-cap `maxSymbols()` content verified
intact post-merge), full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`,
`npm run build`) — results recorded in the PR. PR #1272 was still OPEN at landing time;
this branch contains its content (merged at 90c55579), so GitHub shows a reduced diff
once either lands — noted in the PR body.

## Follow-ups / risks

- The receipt goes silent per doc type after ONE ingest (both-conditions check is
  pre-existing) — coverage can still be low; /admin/rag-coverage remains the honest
  coverage surface.
- Positions enter the demand queue via the last scan's candidate list (technical
  watchlist), not via a broker read — a symbol held but somehow absent from scans would
  sit in the alphabetical tail. Acceptable: scans force-include holdings.
- Free-tier operators who POST the admin backfill with a big explicit `limit` accept a
  slow request (21s/embed-batch) — that's the documented operator-decision semantics.

## Addendum (MONET, 2026-07-10): budget 5000 + stop-early — the "lower it back down" safety

Owner directives after the first full-pace run (attempted 25 / ingested 5 / skipped 20 —
the 20 skips each cost a multi-MB EDGAR body fetch + chunking and emitted the 20-event
Sentry warning burst SOCRATIC-TRADE-R):

1. `RAG_INGEST_MAX_TEXTS_PER_DAY` raised 1000 → 5000 in Infisical prod (PATCH via the
   in-box automation identity; activates on the next deploy). Also fixed en route:
   Infisical carried `SEC_FILING_RAG_MAX_PER_RUN=1`, shadowing the paid per-run default —
   updated to 25. Fleet note: docker-exec env does NOT show infisical-injected vars;
   read `/proc/<next-pid>/environ`.
2. Stop-early (`src/lib/web-sources/sec-filings.ts`, `src/lib/vector-db.ts`): new exported
   `hasIngestTextBudget()` pre-flights the daily text budget in `ingestFiling` BEFORE the
   EDGAR body fetch; `refreshFilingBodies` stops at the first capacity-exhausted filing and
   reports the cap-aware un-attempted tail in a new `deferredForBudget` result/audit field.
   Adversarial review (1 finding high, 1 low, both fixed): the store's `skipped: true` is
   ambiguous — `StoreResult` now carries distinct `unconfigured` (keys missing → capacity
   stop) and `dedupComplete` (all chunks already indexed → NOT capacity; ingestFiling now
   HEALS the crash-window state by recording the accession, so a dedup-complete filing can
   never pin the head of the demand-first queue) flags; `deferredForBudget` counts only
   filings within the run's cap, excluding the breaker.
3. Tests: 4 new in test/sec-filings.test.ts (stop-at-exhaustion with zero body fetches,
   mid-run deferral, dedup-complete heal + continue, unconfigured stop). 33/33 green under
   node 24 (note: better-sqlite3 ABI — homebrew default node is 26; rebuild for 24).
