# 2026-08-16 — 48h production error triage (Pinecone daily write fuse)

## 1. Context & Objective

Owner asked to troubleshoot every app error from the last 48 hours, including the
"Usage limit hit: Pinecone Write Unit daily fuse" notification (2,513,588 of
2,500,000 estimated WUs).  A follow-up screenshot showed the Pinecone Standard
trial still healthy ($238.05 of $300 remaining, 14 days left).  Pinecone itself
should keep working.

## 2. Changes Made

The fuse is the **app-side** rolling-24h cap `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`
(prod is at the trial value **2,500,000**, not the 200k code default).  Retrieval
was never down.  New upserts pause until the 24h window rolls.  Did **not** raise
the cap.

What burned the 2.5M: planned trial-scale ingest, not a dedup hole and not
repeated agent memory writes.  Live task journal at 2026-08-16T19:32Z showed
`roic-transcript-refresh` running, plus `web-source-refresh` and one
`filing-body-ingest` (5.5 min at 04:50Z).  The skipped batch (175 items / 2,698
estimated WUs) is one ~175-chunk document hitting an already-spent fuse.
`storeDocument` already reuses a committed generation before writing; ROIC skips
`ingested_accessions`.  `managed-vector-reconcile` is dry-run and does not upsert.

Code: park incremental lanes when the fuse is spent, and tell the truth in the
alert.

Touched files:

- `src/lib/pinecone-trial-window.ts` — trial calendar, $45 reserve, free-tier snap
- `src/lib/rag/demand-first-symbols.ts` — shared holdings-first ingest order
- `src/lib/rag/proposer-format.ts` — summary-first Green/Red dossier order
- `src/lib/vector-db.ts` — `hasPineconeWriteBudget`, honest fuse copy, early
  `storeDocument` refuse before `beginVectorCommit`, trial-aware daily WU/text caps
- `src/lib/pinecone-monthly-pace.ts` — after-trial monthly 1.6M when env is 0
- `src/lib/scheduler.ts` — one rollback advisory
- `app/api/admin/rag-coverage/route.ts` — `trialWindow` on the Pinecone card
- `.env.example` — `PINECONE_TRIAL_ENDS_AT`
- `src/lib/web-sources/roic-transcripts.ts` — skip the fetch loop when the fuse is spent
- `src/lib/web-sources/sec-filings.ts` — same preflight as the text budget
- `src/lib/web-sources/fmp-transcripts.ts` — same
- `src/lib/web-sources/sec8k.ts` — same
- `src/lib/rag/sec-ingest-worker.ts` — daily fuse / text budget skip is a 1h deferral,
  not `Ingestion budget or capacity exceeded mid-task`
- tests for the above
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

Owner follow-up: full-steam ingest is fine.  Do not throttle until about $40-50
of trial credit remains, then pace the rest so it lasts through the trial
(unless even the configured 2.5M/day fuse would leave dollars unused).  Filing
ingest now uses the same holdings-first rank as ROIC.  Green/Red dossiers put
document-summary / earnings-summary chunks first.

Second follow-up: cover the latest earnings transcript and latest 10-K/10-Q
for as many in-universe names as possible, then deepen held/watchlist history.
That is feasible on remaining trial credit (expert envelope ~$8–$85 for a
latest-only 1k-name pass).  ROIC is no longer depth-first (20 quarters per
ticker before the next name).  It now walks `latest` then `deepen`.  FMP
takes one latest call until stored, then extra history only for high-interest
names.  SEC `sortBreadthFirst` still ships latest 10-K + latest 10-Q for
everyone; levels 2+ (older 10-Qs/Ks) are held/watchlist/technical only.

Third follow-up: expert team on how proposers should store/read this data.
Consensus (not a Pinecone schema change in this PR):

- Do **not** LLM-summarize on ingest.  Extractive highlights already exist
  (`document-summarizer.ts`, `extractive-highlights-v2`) and cost ~0 LLM.
- Green/Red only see **8 chunks** (held/top-3) or **1 chunk** (scouts) inside
  a 6k-token hose.  A 10-K is ~100–400 chunks.  Full-body Pinecone vectors
  are mostly a retrieval index, not prompt text.
- Keep full bodies in SQLite FTS + `sec_artifacts` (already there).  After
  the 2026-08-30 free snap (60k WU/day), write Pinecone as
  `document-summary` + N best sections, not 400-chunk 10-Ks.  Do not delete
  existing full-body vectors until FTS coverage is proven — live
  `retrieveContextDetailed` is still Pinecone-only.
- App performance / fills / experience-memory stay full.  Never summary-only.

Design: `docs/designs/2026-08-16-proposer-corpus-storage.md`.  Expert memos
in session scratch `grok-501` (retrieval, storage, ingest, adversarial).

Adversarial critic (do not skip): today's `ingestFiling` only writes FTS,
`ingested_accessions`, and the extractive abstract **after** a complete
full-body `storeDocument`.  Live `retrieveContextDetailed` is Pinecone-only.
FTS lexical inject joins committed Pinecone occurrences and only
`sec-edgar`/`sec-8k`.  ROIC/EarningsCalls bodies are not FTS-mirrored.
`corpus-reembed` would put full bodies back.  So the write-class flip is
a later PR train (split local-complete from Pinecone, then hydrate
retrieval, then stop full-body upserts).  This PR only changes *order*
of ingest, not what is written.

## 3. Decisions & Trade-offs

- Do not raise `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`.  2.5M is the documented
  trial knob (see `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md`).
  After trial the same note recommends 60k/day.
- Daily-fuse park is a 1h deferral on the SEC worker (the monthly breaker still
  uses `wuExhaustedUntil`).  Incremental ROIC/filing/8-K lanes just skip the tick
  and retry when due.
- TestFlight CI (FLEET-INFRA-BN) is archive-lock timeout on the shared Mac runner,
  not an app runtime error.  Left to the existing hourly-ship lane.

## 4. Verification State

```bash
./node_modules/.bin/vitest run \
  test/vector-db-document-receipts.test.ts \
  test/vector-db-backlog-c-integration.test.ts \
  test/sec-filings.test.ts \
  test/fmp-transcripts.test.ts \
  test/sec8k-full-body.test.ts \
  test/usage-limit-alerts.test.ts \
  test/sec-ingest-worker.test.ts
```

Targeted: 17+20+the producer files green.  Full land.sh gate (tsc / test / build)
runs before the PR.

## 5. Next Steps & Blockers

- Land latest-first ingest on #2748 so remaining trial days buy universe
  coverage instead of 20-quarter depth on a few names.
- Next corpus PRs (design § PR Plan): FMP abstract writer; write-class
  knob; split local-complete from Pinecone; retrieve hydration; then
  post-trial `highlight+signal` default.  Do not prune existing vectors
  until FTS coverage is proven.
- After trial: drop `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` toward 60k and set
  `PINECONE_MONTHLY_WU_BUDGET` (owner/Infisical).
- Residual owner: Litestream L2/L3 wedge (rolling deploy + B2 prefix).
- Residual CI: iOS TestFlight archive.lock timeout (FLEET-INFRA-BN).
- Residual transient (now healthy): congress.trade 502 during a deploy,
  filingapi 401, OpenRouter embed 500 / rerank `fetch failed`.
- Residual: `vix-yahoo` "active but no success in 60 min" — CBOE-first VIX is ok.
- Residual: Alpaca paper 422 sub-penny `24.865` (2026-08-14).

## 6. Zero-Code Findings

Sentry last 48h (socratic-trade + related):

| Issue | What | Verdict |
|---|---|---|
| SOCRATIC-TRADE-1T | Pinecone write unit budget reached | App fuse at 2.5M.  Pinecone trial healthy.  6h Sentry cooldown working (~5 events / 48h). |
| SOCRATIC-TRADE-1X | OpenRouter embed 500 | Transient provider 500.  Last 2026-08-15.  `rag-embed` healthy now. |
| SOCRATIC-TRADE-22 | OpenRouter rerank `fetch failed` | Transient.  Last 2026-08-14.  `rag-rerank` healthy now. |
| SOCRATIC-TRADE-1V / 1W | congress.trade / SSE HTTP 502 | During a 01:01Z deploy.  Both probes ok now. |
| SOCRATIC-TRADE-21 | filingapi HTTP 401 | Last 2026-08-14.  Probe ok now. |
| SOCRATIC-TRADE-S | Downtime detected | Resolved.  Last 14h before this note. |
| FLEET-INFRA-BN | iOS TestFlight ship | Archive lock timeout on the Mac runner.  Not an app outage. |
| Health storage | Litestream L2 empty/wedged, L3 upstream-wedged | Known owner deploy/B2 issue.  App `ok: true`. |
