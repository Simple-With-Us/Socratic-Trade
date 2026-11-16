# Panel: what Green/Red should retrieve (Pinecone vs our server)

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Status | Report-only (no product-code change, no Infisical flip) |
| Author | Grok (RAG retrieval / trading-decision quality panel) |
| Tree | `~/apps/trading-grok-pinecone-free-snap` (`grok/pinecone-free-snap`) |
| Question | Owner 2026-08-21: full filings/transcripts/history can live on **our server**, not in Pinecone.  Pinecone should hold what makes Green/Red use that corpus wisely (condensed highlights / extracted signal).  ~6 days of Standard trial remain, then the **app** auto-snaps to Starter-shaped write fuses on **2026-08-27**.  Builder ($20, 10 GB / 5M WU **hard cap**) is maybe **after** this week **if** embed quality is good enough.  Undecided. |

This panel does **not** flip `RAG_PINECONE_WRITE_CLASS`, does **not** prune the live index, does **not** implement PR B hydrate, and does **not** buy Builder.  It answers what Green/Red should retrieve **this week**, **after the Starter snap**, and **if** Builder is purchased, and what processed shape belongs in Pinecone vs local FTS.

Companions (binding, not reopened): `docs/audits/2026-08-18-pinecone-store-vs-condense.md`, `docs/designs/2026-08-16-proposer-corpus-storage.md` rev 3, `docs/audits/2026-08-17-rag-learning-recall.md`, `docs/rollouts/2026-08-21-pinecone-free-snap.md`.

---

## Verdict (one paragraph)

**Hybrid, condense-first in Pinecone, store-more on our box.**  Green and Red never read a 10-K.  They read at most **8** deep / **1** scout cosine neighbors from `retrieveContextDetailed`, then the same string again, then a **24,000-character / 6,000-token** filings family that already includes facts / Form 4 / 13F / ARK cards.  The operational Pinecone index is a **routing layer** into that hose.  The right vector is an extractive highlight, a form-aware signal section, a speaker-turn slice, or a full experience-memory sketch — not Item 8 tables, exhibits, or signatures.  Full bodies already persist locally (`persistLocalComplete`, artifacts, `earningscalls_transcripts`).  They become decision text only **after** PR B `hydrateAccession`.  Until that hydrate exists, **do not flip** `RAG_PINECONE_WRITE_CLASS` off `full-body`.  Spend remaining trial WU on **extra processed docs the producers already write while the default stays full-body**, not on another fat latest-1k body pass.  Buy Builder only if measured retrieval quality (consumed catalyst Recall@k on the production retriever, scout summary win-rate, hydrate footnote lift) beats the live full-body haystack **and** the keep-set plus leftover bodies still fit 10 GB.

---

## 0. Contract this panel uses (code, not intent)

Production Green/Red call **`retrieveContextDetailed` only**.  They do not call `retrieveFusedContext`.  Strategy:

- Deep = top-3 scan ∪ held → **k = 8**.  Scout = other scan candidates → **k = 1**.  `src/lib/strategy.ts:1418–1429`.
- Query is `deterministicFilingsRetrievalQuery` = `Significant financial events, SEC filings, and macro catalysts for $SYM`.  `src/lib/rag/information-routing.ts:118–119`.  Requested types still include full `10-k` / `10-q` / `8-k` / `earnings-transcript` plus compact `document-summary` / `earnings-summary`.  `:37–46`.
- `asOf` is `runAsOf`.  `strategy.ts:1459–1461`.
- `orderChunksForProposer` puts `document-summary` / `earnings-summary` / `*-brief` first.  `src/lib/rag/proposer-format.ts:1–16`; applied at `strategy.ts:1534`.
- Filings family budget **24,000 characters / 6,000 tokens**; global prose 48,000 / 12,000.  Cards ride the same `ragContext` hose.  `strategy.ts:5277–5288`.
- Red sees the **same** `retrievedFinancialContext`.  No second retrieve.

`retrieveContextDetailed` (`src/lib/vector-db.ts:6615+`):

- Returns `[]` **before any FTS** if Pinecone or the embed key is missing (`lookup_failed`, `:6646–6653`).
- Dense cosine first.  Corpus-wide lexical is an INNER JOIN of FTS to committed occurrences with `o.source IN ('sec-edgar','sec-8k')` (`src/lib/rag/corpus-wide-lexical.ts:320–322`).  **Transcripts have no lexical backstop.**
- Parent expansion defaults on, **6,000 chars / parent, 12,000 total**, from **vector metadata**, not FTS.  `vector-db.ts:573–583`.

Write class (`src/lib/rag/pinecone-write-class.ts`):

- Default **`full-body`**.  Do not flip until PR B.  File header `:1–7`; `pineconeWriteClass()` `:41–47`.
- Signal item codes: 10-K `1A` / `7` / `7A`; 10-Q `2` / `1A` / `3`; 8-K `2.02` / `5.02` / `1.01` / `8.01`; transcripts `management` + first **8** `qa`/`analyst` turns.  Cap **12 chunks / 20,000 source chars**.  `:12–36`, `:151–181`.
- Item 8 tables are skipped for Pinecone signal (`:177`).  They stay local.
- Do-not-touch: `socratic-decision`, `coach-note`, `lesson`, `experience-memory`, `user-memory`, `fundamentals`.  `:25–33`.

PR A is **on this tree**.  SEC ingest order is `chunkDocument` → `persistLocalComplete` (bare-accession FTS) → extractive abstract → `storeSignalSectionDocuments` → full-body `storeDocument` only if `writesFullBodyToPinecone()`.  `src/lib/web-sources/sec-filings.ts:634–715`.  `hydrateAccession` / `assembleProposerDossier` **do not exist** in `src/` (grep 2026-08-21).  Sequence remains **A (landed) → B (missing) → Infisical flip**.  Design: `docs/designs/2026-08-16-proposer-corpus-storage.md:572–592`.

Trial calendar: `PINECONE_CURRENT_TRIAL_ENDS_AT = 2026-08-27T00:00:00.000Z`.  After that, runtime snaps to **60k WU/day, 20k texts/day, 1.6M WU/month** even if Infisical still holds 5M.  Retrieval is never gated.  `src/lib/pinecone-trial-window.ts:17–28`, `:207–225`.  Builder after the week requires `PINECONE_TRIAL_ENDS_AT=off` plus a paid plan.  `docs/rollouts/2026-08-21-pinecone-free-snap.md`.

Extractive highlights: `DOCUMENT_HIGHLIGHT_MODEL = extractive-highlights-v2`, at most **8 × 1,800 chars**, Jaccard 0.55, **no ingest LLM**.  `src/lib/rag/document-summarizer.ts:29–30`, `:321–327`.  `source_chunk_ids` are still synthetic `hl:1A:0` (`:385–394`) — they cannot hydrate until that is real `content_hash`.

---

## 1. What Green/Red should retrieve: this week vs Starter snap vs Builder

### 1.1 This week (trial still open, through 2026-08-26)

**Retrieve (money path, unchanged):** `retrieveContextDetailed` with the catalyst query, k=8 deep / k=1 scout, compact types preferred by `orderChunksForProposer`.  Do not raise *k*.  Do not promote fused-harness Recall.

**What should win the 8/1 slots:**

| Depth | Want in the slot | Why |
| --- | --- | --- |
| Scout (k=1) | Latest `document-summary` / `8k-brief`/`document-summary` from 8-K / `earnings-summary` | One wrong 10-K risk-factor page occupies the only slot (`docs/audits/2026-08-17-rag-learning-recall.md` R3). |
| Deep (k=8) | Latest 10-K highlight + Item 1A/7/7A signal + latest 10-Q Item 2/1A + latest 8-K brief + latest call summary + management/Q&A-tops | Matches `selectSignalChunks` keep-set.  Fits 24k with cards. |
| Held names | Same as deep, plus full experience-memory / lesson sketches | Do-not-touch class.  Never summarize fills. |

**Index policy this week (writes):** keep `RAG_PINECONE_WRITE_CLASS=full-body`.  Producers **already** write extra processed documents as their own complete `storeDocument`s (`pinecone-write-class.ts:4–7`; `processed-corpus-write.ts:74–107`).  Spend WU on **those extra processed docs + abstracts for names that lack `extractive-highlights-v2`**, not on repeating raw 10-K bodies of names we already have.  Existing live full-body vectors **stay**.  No prune.

**Local policy this week:** keep `persistLocalComplete` and ROIC/EarningsCalls local cache as the full-corpus home.  Owner 2026-08-21 is already how PR A is shaped: our server holds the body; Pinecone holds the routing layer.

### 1.2 After Starter snap (2026-08-27, unless Builder is paid)

App write fuse becomes Starter-shaped: **60k WU/day, 20k texts/day, 1.6M WU/month**.  Starter storage is **~2 GB / ~2M WU / ~250k records**, writes **block** at the cap.  `pinecone-trial-window.ts:24–28`, `:211–225`.  Retrieval of whatever is already in the index continues.

**Retrieve:** still the same 8/1 cosine path.  Green/Red will keep seeing the live full-body haystack **plus** whatever processed extras were written this week (summaries sort first).  That is acceptable for a few days.  It is **not** a reason to flip write-class without hydrate: flipping now thins new names to abstracts + ≤12 section vectors with **no** local parent/1A hydrate (`docs/designs/2026-08-16-proposer-corpus-storage.md:29`, `:574`).

**Writes after snap, still no flip:**

- Prefer producers that are **already** cheap: 8-K brief (default path), ROIC `highlight-only` (non-high-interest latest/deepen), `generateAndStoreDocumentAbstract` upgrades, `storeSignalSectionDocuments`.
- Do **not** start a new 10-K/10-Q full-body wave.  A fat filing at ~900 chunks (`FTS_MIRROR_INCIDENT_CHUNKS`, `src/lib/rag/fts-mirror-bound.ts:20`) is ~14k delivered WU at ~16 WU/record — a large fraction of a 60k day for one name.
- If Starter **storage** is already over ~2 GB (trial full-body hangover; 2026-08-18 audit estimated ~0.5–1.0M records from spent credit), **new upserts block**.  That is a **paid-plan or receipt-gated prune** decision, not a "write more bodies" decision.  Measure live GB from `/api/admin/rag-coverage` + the Pinecone console before anyone claims we "fit Starter."

**Do not** set `PINECONE_TRIAL_ENDS_AT=off` unless the owner is actually on Builder/Standard.  Leaving 5M Infisical numbers without paying still snaps at the calendar (`pinecone-trial-window.ts:207–210`).

### 1.3 On Builder ($20, 10 GB / 5M WU hard cap) — only if §5 gates pass

**Retrieve (target, after PR B):** Pinecone returns highlights + signal sections + (until transcript FTS) latest high-interest full calls + experience-memory.  `assembleProposerDossier` inlines SQLite abstracts (scout stub 1,200 chars), suppresses duplicate compact types, reserves a deep Item 1A slot, then **local-only** `hydrateAccession` on winning pointers.  Design Layer 3: `docs/designs/2026-08-16-proposer-corpus-storage.md:319–350`.

**Fill Builder with the processed keep-set**, not unlimited raw 10-Ks.  10 GB is finite.  Latest-four-docs × 1,000 names × ~15 vectors ≈ **~60k records**, plus experience-memory, plus ~4.5k latest-HI transcript chunks.  That fits 10 GB with room.  A leftover of 900-chunk 10-Ks will race the wall.  Keep live bodies until hydrate is proven; then a **receipt-gated** prune is a calendar step if storage is tight.  Design storage table: same doc `:399–412`.  2026-08-18 fill list: `docs/audits/2026-08-18-pinecone-store-vs-condense.md` §5.

Ops if Builder is purchased: `PINECONE_TRIAL_ENDS_AT=off`, daily/monthly knobs at **5M WU/month hard** (no overage).  Do not leave the 60k free-tier snap in place.  `pinecone-trial-window.ts:193–197`; 2026-08-18 §6.4.

---

## 2. Per corpus type: Pinecone vs local FTS, processed shape

| Corpus | This week Pinecone (write-class still `full-body`) | After flip (only post-PR B) | Local (our server) — always | Exact processed shape Green/Red should consume |
| --- | --- | --- | --- | --- |
| **10-K** | Extra: `document-summary` (`extractive-highlights-v2`, ≤8×1,800) **and** signal section docs (Item **1A, 7, 7A**) via `storeSignalSectionDocuments`.  Also still writes **full body** (do not flip to stop it). | Stop **new** body pages.  Keep highlight + 1A/7/7A section docs. | Full parsed text in `document_chunks_fts` on **bare SEC accession**, HTML + `chunks.json` in `data/sec-artifacts`, ledger `ingested_accessions`.  `persist-local-complete.ts:1–80`; `sec-filings.ts:634–641`. | Highlights first.  Signal = Risk Factors + MD&A + Market Risk, ≤12 chunks / 20k source chars.  **Item 8 tables stay FTS/hydrate only** (`pinecone-write-class.ts:12–13`, `:177`). |
| **10-Q** | Same pattern.  Signal = Item **2** (MD&A), **1A**, **3**.  Form-aware: do not confuse with 10-K Item 2 Properties.  `pinecone-write-class.ts:14`. | Highlight + those three items.  No extra body. | Same FTS + artifacts. | MD&A + updated risk + defaults.  Latest 10-Q usually beats a year-old 10-K page in the 8-slot set. |
| **8-K** | Default operational write is already the extractive **`8k-brief`** / `document-summary` (SQLite `sourceType: "8k-brief"`, vector `doc_type` is `document-summary` unless earnings — `document-summarizer.ts:489–490`).  Full-body is `WEB_SOURCE_SEC8K_FULL_BODY` (code default **off**; prod has been ungated with limit 5).  `sec8k.ts:827–860`. | Brief always.  Full-body signal only for **2.02 / 5.02 / 1.01 / 8.01** if that flag stays on.  `pinecone-write-class.ts:15`. | Artifact + FTS when body ingest runs.  Summary events also live in the 8-K feed table. | Material-item brief (≤6 highlight chunks in the refresh path, `sec8k.ts:906–910`).  Do not spend WU on certifications / exhibits. |
| **Earnings transcripts** | `earnings-summary` extractive highlights from speaker sections.  Signal = every **`management`** turn + first **N=8** `qa`/`analyst` turns (`selectSignalChunks` `:163–171`).  **Latest high-interest call still full-body** (`roicPineconeWriteClass`, `roic-transcripts.ts:174–190`) because there is **no transcript FTS join** (`corpus-wide-lexical.ts:320–322`; audit S1).  Other latest/deepen = `highlight-only`.  Archive = `local-only`. | Same until a transcript FTS mirror exists.  Then latest non-HI can drop full body. | Full call in `earningscalls_transcripts.content` + ROIC artifact **before** Pinecone.  `persistRoicTranscriptLocally` `:615–640`.  Turns: `speakerSections` maps `roleOfSpeaker` → `management` / `analyst` / `operator` / `qa`.  Empty turns collapse to one `"transcript"` / "Full call" (`:604–612`; audit S3). | Processed shape = **management prepared remarks + first 8 Q&A turns**, plus an 8×1,800 earnings-summary.  Not operator boilerplate.  Persist speaker/role; do not re-ingest cache hits with `turns: []`. |
| **Experience-memory / lessons / coach notes** | **Full sketches in Pinecone.**  Do-not-touch.  `socratic-decision` closed-lot text (`experience-memory.ts:170–179`), `lesson`, `coach-note` (`socratic-memory.ts`). | Unchanged.  Never summarize.  Never prune. | SQLite learning ledger / lots remain source of truth.  Vector write still fail-open with no retry queue (audit L7) — that is a reliability hole, not a storage argument. | Compact **entry state + realized outcome** (thesis, regime, PnL, MAE/MFE).  This is the analog Green/Red should retrieve, not a 10-K page. |
| **Fundamentals** | Short vectors if a producer already writes `doc_type: fundamentals` (do-not-touch).  Coverage ledger is incomplete (`strategy.ts:264–265`). | Unchanged.  Do not LLM-summarize facts. | **Structured cards** from company-facts / insider / 13F / ARK, concatenated into `ragContext` (`strategy.ts:1473–1556`).  These **count against the 24k filings family**. | Cards, not ANN neighbors of XBRL trees.  Keep them compact so they do not starve the three deep names. |
| **Trade performance / app history** | **Not a filing corpus.**  Closed-lot experience vectors only (above). | Unchanged. | Fills, lots, activity, proposals: SQLite (`db-fills` / `db-execution`).  `performance.ts:443–458` fire-and-forget experience embed on sell/cover. | Never embed fill tapes or blotters into Pinecone.  Never condense them.  Query SQL for P&L; retrieve experience sketches for "what happened last time." |

Lexical FTS is **not** an equal sibling of Pinecone on the money path.  It cannot run without a live index/embed, and it cannot see rows without committed occurrences.  Hydrate-from-pointer is how an obscure footnote returns **after** a highlight/section hit.  Design: `docs/designs/2026-08-16-proposer-corpus-storage.md:201–202`, `:261–267`.  Do not enable a local-only FTS join on the catalyst OR-query (boilerplate magnet; Alternative D, rejected).

---

## 3. Do not flip `RAG_PINECONE_WRITE_CLASS`.  What CAN be written as extra processed docs THIS WEEK

**Do not set `RAG_PINECONE_WRITE_CLASS=highlight+signal` (or `highlight-only`) in Infisical this week.**  PR A honors the knob (`sec-filings.ts:621`, `:695–710` skips body when not full-body).  PR B hydrate is **absent**.  Flipping now means new 10-K/Q names get abstracts + ≤12 section vectors and **no** money-path parent/1A recovery.  Design gate items 1 and 4: `docs/designs/2026-08-16-proposer-corpus-storage.md:204–221`.  2026-08-18 constraint 1: `docs/audits/2026-08-18-pinecone-store-vs-condense.md` §7.

`writesProcessedToPinecone()` is true for **all** classes including `full-body` (`pinecone-write-class.ts:56–61`).  That is the intended "write extras while default remains full-body" seam.

### Allowed extra processed writes (no env flip)

These are already on the operational path.  Run them.  They compete for the 8/1 slots **and** sort ahead of body pages.

1. **`generateAndStoreDocumentAbstract` / `maybeRefreshSecFilingAbstract`** for accessions that lack a current `extractive-highlights-v2` row.  Writes SQLite `document_abstracts` **and** a small `document-summary` / `earnings-summary` `storeDocument`.  `document-summarizer.ts:425–506`; SEC call `sec-filings.ts:651–673`; 8-K upgrade `sec8k.ts:886–913`; ROIC `storeRoicEarningsSummary` `roic-transcripts.ts:702–732`.  Cheap (~1–3 vectors / 15–50 delivered WU).  Highest scout-k=1 value per WU.
2. **`storeSignalSectionDocuments`** — one complete `storeDocument` per kept itemCode (`AAPL:000…:10-K:section:1A`, etc.).  Parser revision `sec-signal-section-v1`.  `processed-corpus-write.ts:34–107`.  SEC already calls it **before** the full-body upsert (`sec-filings.ts:681–693`).  ROIC already calls it for every non-`local-only` call (`roic-transcripts.ts:796–809`).  ~130–190 delivered WU per filing.  **This is additive while full-body remains on** — it costs extra WU, and that is the correct spend versus another 900-chunk body of a name we already have.
3. **8-K briefs** for fresh material events (default writer).  Do not raise `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT` to dump bodies.
4. **ROIC `highlight-only`** for latest/deepen calls that are **not** high-interest newest (`roic-transcripts.ts:186–190`).  Archive stays local-only (`:186`).  Keep **latest HI full-body** until transcript FTS exists.
5. **Experience-memory / coach-note / lesson** full sketches on closed lots and owner notes.  Do-not-touch.  Not optional "if WU remains."
6. **Local-complete FTS** for every new SEC accession even when Pinecone body later fuse-skips.  `persistLocalComplete` with `recordLedger: writeClass !== "full-body"` (`sec-filings.ts:635–641`) — under today's default the ledger still waits on body complete, but FTS rows are already on disk.  That is the hydrate substrate PR B will need.

### Not allowed this week (even though trial dollars remain)

- Infisical flip of `RAG_PINECONE_WRITE_CLASS`.
- Pass C / leftover **full-body 10-K/Q** of names that already have bodies (`docs/designs/2026-08-16-proposer-corpus-storage.md:365–369`).
- Enabling `SecIngestWorker` at scale if it still diverges (audit I1 was a raw-HTML embed; P0 follow-up claimed `buildSecDocument` — do not re-open a second HTML writer).
- Ingest-path LLM summaries.  No Infisical LLM runtime keys.
- Prune of live full-body vectors.
- Raising deep k above 8 "to use storage."
- Transcript full-body for **non**-high-interest names once `earnings-summary` + management + Q&A-tops exist.
- FMP transcript resurrection (`fmp-transcripts` hard-blocked; audit S2).

`source_chunk_ids` remaining `hl:…` means even a perfect highlight index **cannot** hydrate a parent by hash.  PR B should persist real `content_hash` on abstracts (`docs/designs/2026-08-16-proposer-corpus-storage.md:502`).  That is a hydrate prerequisite, not a reason to stop writing highlights this week (highlights still win cosine + scout slots without hydrate).

---

## 4. What 5M WU / remaining trial dollars should buy

Owner this week: honor **5M monthly WU**, daily fuse already trial-sized, calendar end **2026-08-27**.  Retrieval ungated.  `docs/rollouts/2026-08-21-pinecone-free-snap.md`.  During the window, `assessPineconeTrialWindow` honors monthly ≥ 5M and ignores a leftover Starter 2M (`pinecone-trial-window.ts:193–197`).  Keep the **$45 reserve**.  Do not dump the last dollars on raw pages the 10 GB Builder index (or 2 GB Starter index) will not want.

**Spend on breadth of the processed keep-set.**  Not more raw bodies.

Priority order (same as 2026-08-18 §6.2, calendar tightened):

1. **Universe latest-four processed:** latest 10-K highlight+signal, latest 10-Q highlight+signal, latest 8-K brief, latest transcript summary, for `rankDemandFirstSymbols` names that still lack a current `extractive-highlights-v2` abstract or signal section docs.  Planning: ~200 delivered WU / document, ~800 WU / name for four docs, ~800k WU for 1,000 names.  Design `:379–393`.
2. **High-interest deepen as processed corpus** (`rankHighInterestSymbols`): extra 10-Qs, prior 10-K highlights, extra transcript summaries.  ~240k WU for 150 names × ~8 extra docs.
3. **Latest full transcript** for high-interest only (dense-only safety net).
4. **Abstract backfill** on accessions that already have bodies but an old/missing highlight model.  Best scout-k=1 dollars.
5. **Experience-memory** on closed lots (tiny, mandatory).

**Do not buy:** 1,000 × 900-chunk full-body 10-Ks (~14M delivered WU, ~900k records).  That is a Starter/Builder storage hangover, not "using the trial."  Design deleted Pass C.

Math check vs 5M WU: the processed Pass A + HI deepen is **well under 5M**.  A single fat full-body universe pass is **over** 5M and then sits in the index after the snap.  If local-MTD remainder logic parks large docs, that is unused retrieval — fix the deadlock, do not "spend" by raising a fuse that already full-steams.  2026-08-18 §6.3.

After 2026-08-27 without Builder, **60k/day** still covers incremental processed (~6–10k/day for ~30 new 8-K briefs + 20 new calls; design `:393`).  It does **not** cover full-body catch-up.  That is another reason this week's dollars must land as highlights/sections, not bodies.

---

## 5. Builder yes/no — retrieval quality gates, not vibes

Builder is **$20, 10 GB storage, 5M WU/month, hard cap (no overage)**.  Pay only if the **production** retriever on processed neighbors is at least as useful to Green/Red as today's full-body index, **and** storage math works.  Score `retrieveContextDetailedWithStatus`, same catalyst query, same 8/1 limits, `strictAsOf: true`.  Harness: `scripts/eval/rag-production-eval.ts` (gold = `source` + `accession` + `section` / `contentHash`, never `vectorId` — `:20–41`).  Do **not** use `retrieveFusedContext` numbers (audit R1).

### Yes — buy Builder (after this week) if **all** of these hold

1. **Storage fit:** live Pinecone GB (console + `/api/admin/rag-coverage`) **plus** planned keep-set **minus** any receipt-gated body prune still **< 10 GB**.  If leftover trial bodies alone already threaten 10 GB and prune is not proven, either stay on Standard or prune with receipts first.  Do not buy Builder to warehouse Item 8.
2. **PR B on `main`:** `hydrateAccession` local-only (150 ms / 8 accessions, no EDGAR) + `assembleProposerDossier`.  Flip write-class only then.  Design `:586–592`.
3. **Catalyst Recall@8 (deep, held ∪ top-3)** on a highlight+signal **subset** of the same accessions **beats or ties** the live full-body index.  Floor after baseline: ≥ 0.70; fail < 0.60.  2026-08-18 §4.3.A.
4. **Scout Recall@1** prefers compact types.  Pass ≥ 0.35 with **summary win-rate > body-page win-rate**.  Fail < 0.20 or body pages dominate k=1.
5. **Consumed-attribution, not retrieved-attribution.**  `derivePromptRagConsumption` / `strategy.ts:5301–5306`.  Compact-type **consumed** rate on scout is high.  `retrievedButNotConsumed` character mass does **not** rise vs today's 24k overflow.  Gold ids appear in **consumed** when the run used RAG.
6. **Hydrate ablation (PR B):** local hydrate **lifts footnote Recall@8** without dropping scout Precision@1.  If full-body still wins consumed footnotes by a wide margin **and** hydrate does not close it, do not flip, and Builder-for-bodies is the wrong product.
7. **Lookahead Jaccard** median ≥ 0.50 on persisted candidate pools (`LOOKAHEAD_AUDIT_JACCARD_MIN`).  A write-class change must not collapse replay.  `RAG_PERSIST_CANDIDATE_POOL` must be on or Jaccard is unverifiable.
8. **Incremental WU under 5M/month hard cap** at processed class (design incremental ~6–10k/day).  If the only way to keep coverage is another full-body wave, Builder 5M will **block** mid-month — then Standard (unlimited WU, billed) is the honest plan, not Builder.

### No — do not buy Builder (yet) if any of these hold

- Quality case is "the trial had dollars" or "record count went up."
- PR B missing (today).  Buying 10 GB without hydrate incentivizes filling it with the same bodies.
- Highlight+signal subset **loses** catalyst Recall@8 or scout k=1 is still a random 10-K page after abstracts exist for those names.
- Live index already **> 10 GB** of bodies and there is no receipt-gated prune.
- Transcript lexical hole is "fixed" by dumping every historical call as full vectors (storage + WU both lose).
- Eval still scores the fused harness.

### If the owner stays on Starter instead

That is coherent **only** if the keep-set is ~60–80k records **or** writes are allowed to block while we retrieve the existing index.  Trial full-body hangover likely already exceeds ~250k records (2026-08-18 §2 / §5).  Staying on Starter without prune means **write-blocked ingest**, not a free forever-index of new names.  Prefer: this week's processed extras → measure GB → then **Builder if §5 Yes**, else **Standard billed** if we refuse prune, else **receipt-gated prune + Starter** only after hydrate.

### If the owner wants "no retrieval loss"

That phrase means: **do not delete the live full-body index and live on abstracts alone.**  It does **not** mean fill 10 GB with more raw 10-Ks.  Local FTS + hydrate is the loss-recovery path.  Owner 2026-08-21 already chose the server as the body store.

---

## 6. What the next agent should do (not this file)

1. Keep ingesting **processed extras** at the trial effective pace through 2026-08-26.  Prefer abstract backfill + `storeSignalSectionDocuments` + 8-K briefs + ROIC highlight-only.  Do not start a fat body pass.
2. Implement **PR B** (`hydrateAccession` + `assembleProposerDossier` + real `content_hash` on abstracts).  Then — and only then — Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`.
3. Stand the production eval (`scripts/eval/rag-production-eval.ts`) with deep vs scout split and the two ablations in 2026-08-18 §4.3.  Merge-gate on that path, not fusion.
4. Measure live Pinecone **record count / GB** before the owner is asked to pay $20.  Do not guess.
5. Transcript FTS join (audit S1) after A+B, so the HI latest-full-body exception can retire.
6. Owner ops on 2026-08-27: default app snap to 60k/1.6M.  Builder only if §5 is green and `PINECONE_TRIAL_ENDS_AT=off` is set **after** the paid plan is on.

Zero product code was changed in this panel.
