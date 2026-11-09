# Cascade + RAG diagnosis (2026-08-22)

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Author | Grok |
| Tree | `~/apps/trading-grok-litestream-cascade` @ `grok/litestream-cascade-rag` |
| Status | Diagnosis + in-tree mitigations.  Infisical write-class flip still forbidden.  Claude gather-budget `06df80cf` keepout. |

This is the owner-facing cut of the thorough Cascade + RAG review.  PR B hydrate/dossier was already on this branch.  The review found remaining money-path holes that still made last-resort RapidAPI fire and still hid filings from Red.

## Cascade

Yahoo quoteSummary is a healthy floor for PE/EPS/div/beta/52w/sector/D/E/FCF.  Last-resort RapidAPI was still lighting up because the **Wave B gap list did not match what Yahoo actually writes**.

| Hole | Effect | Mitigation on this branch |
| --- | --- | --- |
| `analystRating` vs Yahoo `analystBySource` | Wave B treated every symbol as a gap.  Finnhub/Tiingo/ROIC/TwelveData ran the whole batch. | `collectFilledFields` aliases the two keys. |
| `headlines` / `sentiment` on WAVE_B | Empty Alpaca news forced Wave B + Wave C RapidAPI NEWS. | Dropped from WAVE_B.  RapidAPI useful-fields exclude news. |
| Wave B `suppliesFields` included bid/ask | A daysToEarnings hole dispatched Finnhub for microstructure. | `paidProviderHasUsefulWaveBGap` intersects WAVE_B only. |
| SteadyAPI quote after Yahoo price | Paid RapidAPI quote reservation. | Already skipped when `price` covered (prior commit). |
| Marketstack before Yahoo history | Last-resort OHLCV on a healthy Yahoo chart. | Yahoo first (prior commit). |
| FilingAPI 401 | In-memory only; retried forever. | Durable fingerprint (prior commit). |
| Quote sheet waits on 6s cascade | Chart floor is ready early. | `/api/quote` returns Yahoo (+ durable + 1.5s quoteSummary) without waiting Wave C. |

Keepout: do not retune gather's 8-minute wall (`06df80cf`).

## RAG

Green already runs `assembleProposerDossier` (default ON).  That is not enough for the owner goal (more names, longer time, seconds–5 minutes, Pinecone light).

| Hole | Effect | Mitigation on this branch |
| --- | --- | --- |
| Red never saw filings | `RED_TEAM_REVIEW_CONTEXT_KEYS` omitted RAG bodies on purpose.  Hash parity ≠ text.  Green can cite 1A; Red cannot read it. | Thin `reviewerFilingsPack`: proposed symbols only, 4k/name, 8k total.  Not the 24k hose. |
| Hydrate replaced chunks with unbounded FTS joins | One 1A ate the 24k filings family.  Later deep names vanished. | Cap attach at 4,000 chars. |
| Live 10-K path has no `chunks.json` | Hydrate's first sources miss unless the worker ran. | Live `ingestFiling` writes `sections.json` + `chunks.json`.  Already-ledgered accessions still miss sidecars (P1 leftover). |
| EarningsCalls no signal extras | ROIC writes management + 8 Q&A; EarningsCalls dumped full body under default write-class. | Sibling slice: `storeSignalSectionDocuments` + local FTS. |
| Analogs dumped as fat case files | Learning family crowded.  Green had no analog job line. | Sibling slice: compact analog cards + Green job. |
| Default `full-body` | New 10-K/Q still double-write processed **plus** body. | Do **not** flip this week.  Flip only after hydrate is live-proven. |

## What Green vs Red actually see (after this PR)

- Green: scout k=1 stub (1,200 chars) / deep k=8, one 24k filings hose, facts/Form 4/13F/ARK SQLite cards, analog cards, coaching.
- Red: structured `candidatesUnderReview` + **thin filings pack for proposed names** (1A/MD&A first, then cards, 4k/name, 8k total) + analogs + scorecards.  Still not the full Green hose.

The models will not "read weeks of 10-Ks."  They will read a bounded dossier, recover 1A/MD&A locally, and let Red dissent on the same sentences Green used.

## Explicitly not this PR

- Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`
- Pause / bulk 10-K body ingest
- Claude gather-budget rewrite
- Coolify bounce / `FORCE_RESTORE`
- Pinecone prune `--apply`
- New API keys / FMP market data
