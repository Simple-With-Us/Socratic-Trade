# 2026-08-22 — Litestream L2/L3 unwedge, cascade last-resort, RAG hydrate

## Context & Objective

Owner: Litestream storage alerts, stock data not arriving as fast as desired, last-resort cascade spend, and RAG must process the broadened document set so Green/Red can see more names and more history than a human in seconds to ~5 minutes.  This is the highest-consequence ST money-path lane.

## Changes Made

### Litestream

Live `/api/health` was `storageDegraded` with L2 last at 2026-08-18T06:25:07Z and L3 last at 2026-08-18T07:00:11Z while L0/L1/L9 stayed healthy.  B2 listing (bucket `jays-socratic-trade-eu`, prefix `trading-live/app.db/` only) showed **L1 contiguous** (0 holes, ~13.5k files).  Compact then uploaded one L2 covering four days of L1; runtime log: `connection reset by peer` and `extract timestamp from LTX header: EOF`.  Earlier 2026-08-21 window also had `Storage class not supported on this cluster: STANDARD` on some L1 PUTs.

Ops heal (`scripts/litestream-l1-suffix-heal.py`): keep newest 48 L1 (~130MB), delete older L1 plus all L2/L3, never L0/L9, never R2.  Dry-run: delete 13971 objects / ~30.7GB of stale LTX.  L9 daily snapshot remains (last 3.3GB, 2026-08-22T00:00:08Z).

Code: `part-size: 10MB` + `concurrency: 2` on the B2 replica; inventory now measures holes/twins/catch-up span; health names mega-file catch-up, not only "L2 empty".

### Cascade

- Wave B uses `WAVE_B_GAP_FIELDS` (no bid/ask/vwap/asOf; no insiderSentiment/epsGrowth as a paid-wave trigger).
- SteadyAPI skips the quote call when price is already covered.
- `yh-finance-apidojo` and seeking-alpha RapidAPI are opt-in (live 403/429).
- FilingAPI 401 fingerprint is durable across restarts.
- One Alpaca news provider, not two.
- History: Yahoo floor before Marketstack last_resort; faster Yahoo 429 fail when Marketstack can still answer.
- `/api/quote` returns the Yahoo chart floor after a 1.5s quoteSummary grace.  It does not wait the 6s Wave C budget.  Helpers live in `src/lib/quote-cascade-budget.ts` so the route file only exports `GET`.

### RAG

PR B without flipping `RAG_PINECONE_WRITE_CLASS` (still `full-body`):

- Moveable `data/corpus/{sec,roic,eight-k,form4,thirteen-f,ark,transcripts,experience}`; reads fall back to `data/sec-artifacts` and `data/roic-artifacts`.
- `hydrateAccession` local-only (chunks.json, artifacts, FTS, ROIC/earnings SQL).  150ms fail-open.  No EDGAR.
- `assembleProposerDossier` for Green/Red (`RAG_PROPOSER_DOSSIER` default on).  Deep k=8 / scout k=1 unchanged.  24k family budget unchanged.
- Highlight ids use real content hashes when known.  Provenance prints bare SEC accession.
- EarningsCalls skips full-body Pinecone upsert when write-class is not `full-body` (inert until a later flip).  Same producer now writes management + 8 Q&A signal extras and mirrors FTS.
- Analog inject uses compact cards (situation / return_pct / holding_days / risk_exit) plus a Green analog job line (`agentic-strategy@2.17.0`).
- Red gets `reviewerFilingsPack` (proposed symbols only, 4k/name, 8k total).  Not the 24k Green hose.
- Hydrate attach capped at 4,000 chars.  Live `ingestFiling` writes `chunks.json` + `sections.json`.  8-K summary ingest writes `corpus/eight-k/{accession}/main.txt`.
- Form 4 XML + summary, 13F JSON, and ARK JSON snapshots write under `data/corpus/{form4,thirteen-f,ark}` (moveable `CORPUS_DIR`).
- Red `reviewerFilingsPack` reorders 1A/MD&A/8-K ahead of facts/Form 4/13F cards so the 4k cap cannot hide the sentences Green used.
- Deep dossier reserves Item 7 MD&A as well as 1A.  Scout hydrates a 2k 1A when local text exists.
- Default `full-body` ingest skips extra signal-section Pinecone writes (still no write-class flip).
- `runtime-health.ts` uses bare `fs`/`http`/`path` so Next webpack no longer dies on `node:` UnhandledSchemeError.

Follow-up slice (same branch, no write-class flip):

- After `extractFilingText`, `ingestEightKBody` writes `corpus/eight-k/{bareAccession}/main.txt` and optional `main.html` via `writeCorpusFile` (CORPUS_DIR-aware).  `WEB_SOURCE_SEC8K_FULL_BODY` remains default off.  SQLite `sec_artifacts.raw_uri` unchanged.
- Hydrate order: chunks.json -> sections.json -> eight-k sidecar -> FTS (filter then limit) -> transcript SQL/ROIC.
- Known CIK: `secArtifactReadPaths` only (no `listSecAccessionDirs` walk).  Unknown CIK still walks.
- FTS puts `content_hash` / item LIKE predicates in WHERE before `LIMIT 8` so Item 8 tables cannot displace a 1A hit.

### Files

- `litestream.coolify.yml`
- `scripts/litestream-l1-suffix-heal.py`
- `src/lib/litestream-remote-inventory.ts`, `src/lib/runtime-health.ts`
- `src/lib/data-providers.ts`, `src/lib/enrichment-coverage.ts`, `src/lib/filingapi-auth.ts`, `src/lib/history.ts`
- `app/api/quote/route.ts`, `src/lib/quote-cascade-budget.ts`, `next.config.mjs`
- `src/lib/rag/corpus-layout.ts`, `hydrate-accession.ts`, `proposer-dossier.ts`, `reviewer-filings-pack.ts`, `document-summarizer.ts`
- `src/lib/web-sources/sec-filings.ts`, `sec.ts`, `thirteen-f.ts`, `ark-holdings.ts`, `src/lib/roic-archive-artifacts.ts`, `src/lib/earningscalls-transcripts.ts`
- `src/lib/strategy.ts`, `src/lib/vector-db.ts`
- Tests listed in Verification State

## Decisions & Trade-offs

- Did not upgrade Litestream past 0.5.12 (tcp_mem).  Did not add `verify-compaction`.
- Did not bounce Coolify to apply `stop_grace_period`.  Documented only.
- Did not flip `RAG_PINECONE_WRITE_CLASS`.  Hydrate must prove itself on main first.
- Did not steal Claude gather-budget P0 (board 06df80cf).
- L2/L3 PITR for 2026-08-16..18 is sacrificed; L9 daily snapshots + recent L1 suffix + live L0 remain.
- Form 4 / 13F / ARK stay SQLite cards (not ANN).  Experience/coach/lesson stay DO_NOT_TOUCH vectors.

## Verification State

```bash
cd ~/apps/trading-grok-litestream-cascade
./node_modules/.bin/vitest run \
  test/litestream-remote-inventory.test.ts \
  test/runtime-health.test.ts \
  test/enrichment-coverage.test.ts \
  test/enrichment-scarce-tier-gate.test.ts \
  test/filingapi-auth.test.ts \
  test/rapidapi-providers.test.ts \
  test/history.test.ts \
  test/quote-route.test.ts \
  test/corpus-layout.test.ts \
  test/hydrate-accession.test.ts \
  test/proposer-dossier.test.ts \
  test/strategy-rag-quickwins-wiring.test.ts \
  test/document-summarizer.test.ts \
  test/vector-db-provenance.test.ts
```

8-K sidecar / hydrate miss slice (2026-08-22):

```bash
./node_modules/.bin/vitest run test/corpus-layout.test.ts test/hydrate-accession.test.ts
# 2 files / 9 tests passed
```

Heal dry-run: L1 holes 0; keep 48 L1; delete 13533 L1 + 403 L2 + 35 L3.

Follow-up slice (quote floor + corpus + Red 1A, 2026-08-22):

```bash
npx tsc --noEmit
./node_modules/.bin/vitest run \
  test/quote-route.test.ts \
  test/corpus-layout.test.ts \
  test/web-sources-sec.test.ts \
  test/reviewer-filings-pack.test.ts \
  test/proposer-dossier.test.ts
# tsc clean; 5 files / 36 tests passed
```

## Next Steps & Blockers

- Confirm L2 `fileCount >= 1` after heal + next compaction.  Mac heal python is stuck SYN_SENT to api003.backblaze.com; run heal from the Hetzner box, not this Mac.
- Coolify `stop_grace_period` on the next planned non-RTH bounce.
- After a live strategy run proves hydrate 1A from local files: operator may set Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`.  Not this week.
- Already-ledgered 10-K/Q still miss `chunks.json`/`sections.json` until worker/backfill (P1 leftover).
- Companyfacts JSON is still SQLite-only (not a corpus kind).
- Claude gather-budget P0 remains that seat's.

## Zero-Code Findings

- Last-resort RapidAPI was firing because Wave B treated bid/ask/vwap as coverage gaps, Yahoo `analystBySource` did not fill `analystRating` (ghost Wave B on every symbol), and empty Alpaca headlines counted as a WAVE_B gap.  Yahoo floor was healthy (`lastFailure: null`).
- FilingAPI public health `ok: true` with lastFailure HTTP 401 is a streak/soften artifact plus in-memory-only reject.
- ROIC archive already holds 17167 transcripts / 17162 artifact files for 946 symbols.
- Pinecone month-to-date ~12.9M WU; trial remaining ~$248 / 5 days.  Do not bulk 10-K body.
