# Panel synthesis: highlights in Pinecone, full files on our server

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Status | Report-only synthesis (no Infisical write-class flip, no prune) |
| Author | Grok (four-expert panel) |
| Tree | `~/apps/trading-grok-pinecone-free-snap` |
| Snap | Honor 5M WU through `2026-08-27T00:00:00.000Z`, then app snaps to 60k/day, 20k texts, 1.6M/month |
| Companions | `docs/audits/2026-08-22-panel-retrieval.md`, `panel-corpus.md`, `panel-learning.md`, `panel-prompting.md`; `docs/audits/2026-08-18-pinecone-store-vs-condense.md`; `docs/designs/2026-08-16-proposer-corpus-storage.md` |

Owner 2026-08-21: earnings calls, SEC filings, corporate data, app history, and trade performance should be embedded so Green/Red can use them wisely.  That means **condense / extract highlights into Pinecone**.  Keep full files, transcripts, and ledgers **on our server**.  Builder ($20, 10 GB / 5M WU hard cap) is maybe after this week if that processed corpus is actually better.  Undecided.

This note is the single owner-facing cut.  The four expert files keep the file:line evidence.

---

## Verdict

**Hybrid.  Pinecone is a routing layer into 8 deep / 1 scout slots and a 24,000-character filings hose.  Our server is the filing cabinet.**

Green and Red never read a 10-K.  They read a bounded dossier.  Extra raw pages in Pinecone compete for those slots and then lose to the 24k prefix.  That is precision loss, not "more evidence."

PR A (split writer) is already on main.  Default `RAG_PINECONE_WRITE_CLASS` is still `full-body`, which **already writes** extractive highlights + signal sections, then also upserts the full body.  PR B (`hydrateAccession` + `assembleProposerDossier`) is **not** on main.  **Do not flip write-class this week.**  Flipping without hydrate thins new names to abstracts with no local 1A/footnote recovery.

Spend the remaining trial week on **breadth of the processed keep-set**, not another 900-chunk body pass.  After 2026-08-27 the app snaps write fuses to Starter-shaped numbers even if Infisical still holds 5M.  Storage does not shrink itself.  Buy Builder only if the gates in section 5 pass.

---

## 1. What goes where

| Corpus | Pinecone (routing) | Our server (source of truth) | Do not |
| --- | --- | --- | --- |
| **10-K** | Extractive highlight (`extractive-highlights-v2`, ≤8 × 1,800 chars) + Item **1A / 7 / 7A** signal sections (≤12 chunks / 20k source chars) | Full parsed text in FTS + `data/sec-artifacts` | Item 8 tables, exhibits, signatures |
| **10-Q** | Highlight + Item **2 / 1A / 3** (MD&A, not 10-K Properties) | Same FTS + artifacts | Full body pages |
| **8-K** | Default **brief** already | Artifact + FTS when a body ingest runs | Full-body exhibits (`WEB_SOURCE_SEC8K_FULL_BODY` stays off) |
| **Earnings calls** | `earnings-summary` + **management** remarks + first **8** Q&A turns.  Latest **high-interest** full call only (no transcript FTS yet).  Archive = local-only | `earningscalls_transcripts.content` + `data/roic-artifacts` | Historical full-call vectors; EarningsCalls.dev dumping `row.content` |
| **Facts / Form 4 / 13F / ARK** | Not ANN trees | SQLite cards already injected (they share the 24k hose — keep them short) | Embedding XBRL |
| **App history / trade performance** | Compact analog **cards**: situation + `return_pct` / `holding_days` / `risk_exit`.  Coach-note and lesson sketches | Fills, lots, scorecards, full `SocraticDecisionCase` JSON, coach archive | Fill blotters, MAE series, full Green/Red transcripts |
| **Experience-memory / lessons / coach notes** | Keep writing.  **Do not prune.**  `DO_NOT_TOUCH_DOC_TYPES` | SQL ledger rebuilds the card | Summarizing memory into a filing abstract |

Existing live full-body vectors **stay**.  No prune this week.

---

## 2. This week's ingest recipe (through 2026-08-26)

Leave `RAG_PINECONE_WRITE_CLASS` unset / `full-body`.  Do not run `corpus-reembed` or `reindex-all`.  Do not raise `SEC_FILING_RAG_MAX_PER_RUN`.  Do not enable the SEC ingest worker at scale.

**Do spend remaining 5M WU / trial dollars on:**

1. Abstract backfill (`extractive-highlights-v2`) for accessions that lack a current highlight.  Best scout k=1 dollars (~1–3 vectors).
2. `storeSignalSectionDocuments` extras the producers already write (1A/7/7A, 10-Q 2/1A/3, transcript management + 8 Q&A).
3. Fresh **8-K briefs**.
4. ROIC **highlight-only** latest/deepen (archive already local-only).  Latest high-interest full call stays until transcript FTS exists.
5. Closed-lot experience / coach-note / lesson cards (tiny, mandatory).

**Do not spend on:** a 1,000-name full-body 10-K/Q pass (~14.9k delivered WU per 933-chunk filing; ~300 fat filings would eat 5M).  EarningsCalls full-transcript upserts.  FMP transcript resurrection.

WU math (planning ~16 delivered WU / record, managed commit ×2):

| Shape | Records | Delivered WU | 5M month | Post-snap 60k/day |
| --- | --- | --- | --- | --- |
| Fat 10-K full body (933 chunks) | 933 | ~14.9k | ~336 filings | **0.25 filings** |
| Same filing highlight + signal | ~15 | ~200–240 | ~20–25k documents | ~250–300 documents |
| Four latest processed docs / name | ~60 | ~800–960 | whole 1k universe, several times | ~60–75 names |

Processed Pass A + high-interest deepen is well under 5M.  A fat body universe pass is over 5M and then sits in the index after the snap.

**Ops tension (honest):** default `full-body` still double-writes (processed **plus** body) on every new SEC 10-K/Q.  Pausing all SEC ingest also pauses the processed extras.  So: keep incremental 8-K + ROIC + abstract/signal extras; do **not** start a bulk body backfill; do **not** set `SEC_FILING_RAG_MAX_PER_RUN=0` (owner wants ingest of **helpful** data to continue).  The only clean split is PR B, then the Infisical flip.

---

## 3. How Green/Red should see it (prompt packing)

The bottleneck is **prompt assembly**, not Pinecone GB.

- Deep k=8 / scout k=1.  Do not raise *k*.
- One 24k / 6k-token filings hose, prefix-trimmed.  Cards for ~30 scouts ride the same hose and are not in consumption receipts.
- Held names retrieve at k=8 then assemble **last**, so they are the cleanest `retrievedButNotConsumed` class.
- Red currently gets a hash manifest, not the filing pack, so it cannot dissent on a 1A sentence Green may have misread.
- SQLite `document_abstracts` exist and are unused on the money path.

**Ideal deep pack this week (~10k chars / name, two deep names + scout stubs inside 24k):**

1. One extractive highlight (1.2–1.8k).
2. Latest 8-K brief.
3. Signal items (1A/7/7A or 10-Q 2/1A/3).
4. Management + 4–8 Q&A turns.
5. A short facts/delta card.
6. Analog card in the learning family (~0.8–1.5k), not a case-file dump.

Scout k=1 is correct as a **1,200-char abstract**.  It is starving only when that slot is a random 10-K page.

Learning: pack analog at **inject time** this week (zero WU).  After the snap, overwrite decision embeds as cards from SQLite.  Scorecards stay SQL (`comboOutcomes`, etc.).  Force one COUNTEREXAMPLE analog slot.  Teach Green a job line for `closestHistoricalAnalogs` (today it is only a DATA-NOT-COMMAND fence).

---

## 4. Calendar

| When | Writes | Retrieval |
| --- | --- | --- |
| Through 2026-08-26 | Honor Infisical 5M monthly + 5M daily.  Ignore leftover vendor 2M 429s. | Unchanged 8/1 cosine |
| 2026-08-27 00:00 UTC | App snaps to 60k WU/day, 20k texts/day, 1.6M WU/month even if Infisical still says 5M.  One storage_warning.  `PINECONE_TRIAL_ENDS_AT=off` is the Builder escape hatch **after** the paid plan is on. | Live index still serves.  Writes may **block** if Starter 2 GB is already full (trial hangover). |
| After, if Builder | Set `PINECONE_TRIAL_ENDS_AT=off`, keep 5M monthly as a **hard** cap (no overage).  Fill with keep-set + held history (~80–120k records), not 900k raw 10-K chunks. | Target: highlights + signal + HI latest call + experience; hydrate footnotes locally |

Starter without prune is **write-blocked ingest**, not a free forever-index of new names.

---

## 5. Builder yes / no (quality, not vibes)

Pay $20 only if **all** of these hold.  Score `retrieveContextDetailed` (not fused-harness Recall).  Gold = `source` + `accession` + `section` / `contentHash`.

**Yes:**

1. Live GB + planned keep-set − any receipt-gated body prune still **< 10 GB**.  Measure `/api/admin/rag-coverage` + the Pinecone console.  Do not guess.
2. PR B on main, then write-class flip.
3. Highlight+signal subset **beats or ties** full-body catalyst Recall@8 on held ∪ top-3.  Floor ≥ 0.70; fail < 0.60.
4. Scout Recall@1 prefers compact types.  Pass ≥ 0.35 and summary win-rate > body-page win-rate.
5. Compact types show up in **consumed** attribution.  `retrievedButNotConsumed` mass does not rise.
6. Hydrate lifts footnote Recall@8 without dropping scout Precision@1.
7. Incremental processed WU stays under the 5M **hard** cap (~6–10k/day).  If the only way to keep coverage is another full-body wave, Builder will block mid-month — then Standard billed is the honest plan.

**No (yet):** "the trial had dollars," record count went up, PR B missing (today), highlight subset loses Recall@8, live index already > 10 GB of bodies with no proven prune, eval still scores fusion.

"No retrieval loss" means: **do not delete the live full-body index and live on abstracts alone.**  It does **not** mean fill 10 GB with more raw 10-Ks.

---

## 6. Next product code (not this PR)

This PR lands the Aug 27 fuse snap and the panel.  Next lane:

1. **PR B** — local-only `hydrateAccession` (150 ms / 8 accessions, no EDGAR) + `assembleProposerDossier` + real `content_hash` on abstracts.  Then Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`.
2. Per-symbol condensed packer with a reserved 24k prefix; inline `document_abstracts`; scout = 1,200-char stub; restore a thin Red filing pack for the name under review.
3. Analog card packing at inject time + one Green COUNTEREXAMPLE stanza.
4. Production eval on `scripts/eval/rag-production-eval.ts` with deep vs scout split.
5. Transcript FTS join so the high-interest full-call exception can retire.
6. Measure live Pinecone record count / GB before the owner is asked to pay.

Do not flip write-class.  Do not `--apply` operational prune.  Do not dump ledgers into ANN.
