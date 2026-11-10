# Panel: condense Pinecone, keep full files local (free-tier snap)

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Status | Report-only (no product-code change in this note) |
| Author | Grok (embedding / corpus pipeline / Pinecone cost panel) |
| Tree | `~/apps/trading-grok-pinecone-free-snap` |
| Owner ask | Condense/extract highlights for Pinecone; keep full files locally.  5M monthly WU this week.  Auto-snap to free/Starter on 2026-08-27 (60k WU/day, 1.6M/month, 2 GB).  Builder ($20, 10 GB, 5M WU hard cap, no overage) only later if quality is good. |
| Binding design | `docs/designs/2026-08-16-proposer-corpus-storage.md` (rev 3; PR A minimum on main via #2820) |
| Prior panel | `docs/audits/2026-08-18-pinecone-store-vs-condense.md` (Builder-as-likely).  This note **supersedes** that post-trial landing: owner now snaps **Starter first**; Builder is optional. |

This is an expert cut of what to embed **this week**, what must stay disk/SQLite, and what must **not** flip in Infisical.  It does **not** set `RAG_PINECONE_WRITE_CLASS`.  It does **not** prune.  It does **not** start a 1,000-name full-body 10-K pass.

---

## Verdict (one screen)

**Pinecone this week and after the snap is the processed keep-set only.**  Extractive highlights + form-aware signal sections + speaker-turn slices.  Full 10-K / 10-Q / transcript bodies stay in artifacts, FTS, and `earningscalls_transcripts`.  Green/Red already cannot consume a 933-chunk filing (`FTS_MIRROR_INCIDENT_CHUNKS` at `src/lib/rag/fts-mirror-bound.ts:20`).

**Do not flip `RAG_PINECONE_WRITE_CLASS`.**  PR A is on main.  PR B (local `hydrateAccession` + `assembleProposerDossier`) is **not**.  Flipping now thins the 8/1 retrieve with no local parent/1A recovery.

**Stop new full-body 10-K/10-Q/transcript upserts operationally** (pause the worker, do not raise `SEC_FILING_RAG_MAX_PER_RUN`, do not run `corpus-reembed` / `reindex-all`).  You cannot stop them with the env until B lands, because the default is still `full-body` (`src/lib/rag/pinecone-write-class.ts:3–7, 41–47`) and `ingestFiling` still `storeDocument`s the whole body after the processed writes (`src/lib/web-sources/sec-filings.ts:681–715`).

**After 2026-08-27 00:00 UTC**, runtime already snaps writes to **60k WU/day, 20k texts/day, 1.6M WU/month** even if Infisical still holds 5M (`src/lib/pinecone-trial-window.ts:17–28, 204–226`).  Storage does **not** snap itself.  The live trial index is already larger than Starter 2 GB / ~250k records.  Either prune with receipts after hydrate is proven, stay paid, or accept write-blocks on a full index.

---

## 1. This week ingest recipe

Calendar from code, not the August 16 design: trial end is **`2026-08-27T00:00:00.000Z`** (`PINECONE_CURRENT_TRIAL_ENDS_AT`, `src/lib/pinecone-trial-window.ts:17–18`; test `test/pinecone-trial-window.test.ts:56–63`).  Owner: **5M monthly WU this week**.  Code already honors a configured monthly budget `>= 5_000_000` during the trial (`src/lib/pinecone-trial-window.ts:193–197`) and Infisical daily fuse 5M (rollout `docs/rollouts/2026-08-21-pinecone-wu-no-starter-wall.md`).

### 1.1 What to embed (Pinecone)

| Keep writing | Why | Typical vectors |
| --- | --- | --- |
| Extractive `document-summary` / `10k-delta` / `10q-delta` | `generateAndStoreDocumentAbstract` + `storeDocument` (`src/lib/rag/document-summarizer.ts:30, 425–506`).  `extractive-highlights-v2`, max 8 × 1,800 chars (`:325–326`).  No ingest LLM. | 1–3 |
| Form-aware **signal sections** | `selectSignalChunks` + `storeSignalSectionDocuments` (`src/lib/rag/pinecone-write-class.ts:12–17, 151–181`; `src/lib/rag/processed-corpus-write.ts:74–107`).  10-K: 1A / 7 / 7A.  10-Q: 2 / 1A / 3.  Cap 12 chunks / 20k source chars (`:34–36`).  Item **8 stays out** (`:177`). | ≤12 |
| `8k-brief` | Default 8-K path.  `WEB_SOURCE_SEC8K_FULL_BODY` defaults **off** (`src/lib/web-sources/sec8k.ts:858–860`). | 1–3 |
| Transcript `earnings-summary` + management + first 8 QA/analyst turns | ROIC non-archive latest/deepen is already `highlight-only` except high-interest newest (`src/lib/web-sources/roic-transcripts.ts:174–191, 780–809`). | ~8 + ≤12 |
| **Latest full call for `rankHighInterestSymbols` only** | Transcript FTS still missing.  Design KD 8 / ROIC exception (`roic-transcripts.ts:175–188`). | ~20–40 |
| `socratic-decision` / `coach-note` / `lesson` / `experience-memory` / `fundamentals` | `DO_NOT_TOUCH_DOC_TYPES` (`pinecone-write-class.ts:25–32`).  Full.  Never summarize. | small |

Coverage order is already coded.  Do not invert it: latest 10-K then latest 10-Q for the universe, then deepen `rankHighInterestSymbols` (`sortBreadthFirst` levels 0–1 always, 2+ only if `deepenTickers` contains the symbol, `src/lib/web-sources/sec-filings.ts:1215–1252`).  ROIC: `phase: "latest"` then deepen then **archive = local-only** (`roic-transcripts.ts:186–191, 748`).

### 1.2 What to stop embedding (Pinecone)

Stop **new** writes of:

- Remaining 10-K / 10-Q **body** (exhibits, signatures, certifications, Item 8 tables).
- 8-K full-body pages (leave the flag off).
- EarningsCalls.dev / FMP **full transcript** vectors (`src/lib/earningscalls-transcripts.ts:868–889` still `storeDocument`s `row.content` with no write-class).  FMP is not the live budget (`docs/designs/2026-08-16-proposer-corpus-storage.md` Layer 2).
- Transcript **history** beyond latest, and latest full calls for names **not** in `rankHighInterestSymbols`.
- `corpus-reembed` walks of leftover `document_chunks_fts` body rows.  The guard exists (`processedCommitCoversAccession`, `src/lib/rag/corpus-reembed.ts:350–411`) but a highlight+signal accession is only “coverage” after the env actually writes that class.  Today full-body still re-upserts bodies.
- Any Pass C “spend the 5M on fat 10-Ks.”  Design deleted Pass C (`docs/designs/2026-08-16-proposer-corpus-storage.md` Coverage policy).

Keep fetching and **storing those pages locally**.  Stopping Pinecone is not stopping EDGAR/ROIC.

### 1.3 Smoking gun: default `full-body` already double-writes

`ingestFiling` always does local-complete + abstract + **signal sections**, then if `writesFullBodyToPinecone()` (the default) it **also** upserts the whole parsed body (`src/lib/web-sources/sec-filings.ts:621–715`).  Comment at `pinecone-write-class.ts:4–7` says the same: producers honor `highlight+signal` when set; the operational path **also** writes extractive highlights + signal sections while default remains full-body.

So every **new** 10-K this week, if the seeder/worker runs, costs **processed WU plus full-body WU**.  That is the opposite of a free-tier keep-set.  Pause the body funnel in ops.  Do not “use the 5M” on it.

ROIC is already smarter than SEC: archive never hits Pinecone; non-HI latest is summary + signal only; HI newest is the only full-body exception (`roic-transcripts.ts:174–191, 735–817`).  Copy that discipline operationally onto SEC this week.

### 1.4 WU math (use delivered ~16 / record)

Estimator: `ceil(bytes / 1024)` with 1024-dim f32 + metadata + 512 (`src/lib/vector-db.ts:345, 715–717, 2276–2297`).  Planning **~8 pending / record**.  Managed two-phase commit **×2** (`applyPineconeWriteBudget`, `src/lib/vector-db.ts:2323–2341`).  Design and the 2026-08-09 throughput note use **~16 delivered WU / record** (`docs/designs/2026-08-16-proposer-corpus-storage.md` Quantified budgets; `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md:109–110`).

| Document | Records | Delivered WU (×16) | Share of 5M month | Share of post-snap 60k/day |
| --- | --- | --- | --- | --- |
| Fat 10-K **full body** (live 933 chunks) | 933 | **~14.9k** | ~0.3% each; **336 filings = 5M** | **0.25 filings / day** |
| Planning 10-K **full body** (200 chunks) | 200 | **~3.2k** | ~1,560 filings | **18 filings / day** |
| Same 10-K **highlight + signal** (≤3 abstract + ≤12 sections) | ~15 | **~200–240** | **~20–25k documents** | **~250–300 documents / day** |
| Four latest docs / name, processed | ~60 | **~800–960 / name** | **~5–6k names** (universe is 1k) | **~60–75 names / day** |
| 8-K brief | 1–3 | **~16–48** | noise | **~30 new 8-Ks ≈ 1k WU** (fits 60k) |
| HI latest **full** transcript (~30 chunks) | ~30 | **~480** | cheap at 150 names | 8 names / day if you tried; don’t, except true latest HI |
| Fuse-skip receipt 175 items / 2,698 WU | mid-size, **not** a large 10-K | — | cited in design Overview | — |

**This week, 5M WU buys either ~300 fat full 10-Ks (storage hangover) or the entire 1,000-issuer processed Pass A plus held-name deepen, several times over.**  Spend it on the second.  You cannot get the second by leaving `ingestFiling` on `full-body`.

OpenRouter embed cost is irrelevant (~$0.0013 / 1k chunks, `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md:107–114`).  Pinecone **storage** after Thursday is the bill.

### 1.5 Concrete ops list (no Infisical write-class)

1. Leave `RAG_PINECONE_WRITE_CLASS` unset / `full-body`.
2. Do **not** enable the SEC ingest worker at scale.  Do **not** raise `SEC_FILING_RAG_MAX_PER_RUN`.  Prefer `SEC_FILING_RAG_MAX_PER_RUN=0` if a new-body pause is needed (explicit 0 is honored, `src/lib/web-sources/sec-filings.ts:810–817`).
3. Keep 8-K **brief** ingest.  Keep `WEB_SOURCE_SEC8K_FULL_BODY` off.
4. Keep ROIC: latest-then-deepen-then-archive.  Archive already local-only.  Do not expire Individual cache (`persistRoicTranscriptLocally`, `roic-transcripts.ts:615–640`).
5. Do **not** run EarningsCalls `ingestCachedTranscript` as a Pinecone backfill (it full-bodies, `earningscalls-transcripts.ts:868–889`).  The SQLite row is the keep.
6. Do **not** flip embed model / `RAG_EMBED_PROVIDER`.  Do **not** run `scripts/reindex-all.ts`.
7. Prune script stays dry-run (`scripts/prune-operational-index.ts`).  No `--apply`.
8. Land **PR B** this week if anything product-code happens.  That is the only path to a safe flip before the snap.

---

## 2. Local persistence: already there vs gaps

### 2.1 Already there (keep using; do not rebuild)

| Asset | Where | Writer | Pinecone required? |
| --- | --- | --- | --- |
| Raw filing HTML | `data/sec-artifacts/{cik}/{accession}/…` | `writeLocalArtifact` (`src/lib/web-sources/sec-filings.ts:77–84`, called from `ingestFiling` `:570`) | No |
| Artifact receipt | `sec_artifacts` | `insertSecArtifact` (`sec-filings.ts:592–610`) | No |
| Worker body | `chunks.json` / `sections.json` / `storeResult.json` | `src/lib/rag/sec-ingest-worker.ts` (~203–318, 431) | No |
| Full chunk text | `document_chunks_fts` on the **bare** SEC accession | `persistLocalComplete` (`src/lib/rag/persist-local-complete.ts:1–2, 39–41, 65–80`) **before** body `storeDocument` | No |
| Compact highlight | `document_abstracts` | `insertDocumentAbstract` inside `generateAndStoreDocumentAbstract` (`document-summarizer.ts:475–487`) | No (SQLite).  Vector copy is extra. |
| Local ledger | `ingested_accessions` + `pinecone_write_class` / `pinecone_vector_count` | `db.ts` migration; `persistLocalComplete` when `recordLedger` (`persist-local-complete.ts:26–27, 76–80`).  Full-body path ledgers **after** complete body (`sec-filings.ts:641, 695–698, 772–775`). | Body complete gates the default path |
| Transcript cache | `earningscalls_transcripts.content` (immutable once non-null) | EarningsCalls fetch-once (`earningscalls-transcripts.ts:72–76`); ROIC `upsertEarningsCallsTranscript` (`roic-transcripts.ts:615–628`) | No |
| ROIC sidecar | `data/roic-artifacts/{SYM}/` | `writeRoicTranscriptArtifact` (`roic-transcripts.ts:629–639`) | No |
| Structured cards / fills | existing SQLite | never summarized | N/A |

PR A’s local-complete seam is real: FTS + optional ledger without a body upsert (`persist-local-complete.ts:1–2, 26–27`).  On default `full-body`, `recordLedger` is false until the body commit (`sec-filings.ts:641`).  That is why flipping the env **before** B without pausing ingest is the only way to ledger-from-local — and that flip is still forbidden.

### 2.2 Gaps (do not pretend they are done)

1. **No `hydrateAccession` / `assembleProposerDossier`.**  `src/lib/rag/` has no `proposer-dossier.ts`.  Grep for those names hits **design only**.  Strategy still cosine-first into 8/1 with parent text from **vector metadata**, not local FTS (`docs/designs/2026-08-16-proposer-corpus-storage.md` Background).
2. **Transcripts have no body FTS.**  Neither `earningscalls-transcripts.ts` nor `roic-transcripts.ts` calls `insertDocumentChunkFts`.  Design: “ROIC / EarningsCalls transcripts + earnings-summary → Pinecone only (no body FTS).”  Corpus-wide lexical INNER JOIN is `sec-edgar` / `sec-8k` only.  **Dropping HI latest full-call vectors without a transcript FTS mirror goes dark on calls.**
3. **EarningsCalls Pinecone path ignores write-class.**  Cache is local-complete; ingest is still full `storeDocument` of `row.content` (`earningscalls-transcripts.ts:868–897`) then abstract (`:900–916`).
4. **Highlight `source_chunk_ids` are still synthetic `hl:…` ids**, not FTS `content_hash` (design Overview).  Hydrate cannot look them up until that is fixed in PR B’s neighborhood.
5. **Full-body FTS double copy.**  Bare accession in `persistLocalComplete`, then managed `doc_id` after body commit (`sec-filings.ts:635–642` vs `:753–763`).  Expert review already flagged this (`docs/reviews/2026-08-18-full-app-expert-review.md`).  Disk, not WU, but it inflates SQLite.
6. **Abstract FTS source is `document-summarizer`**, excluded from the live lexical join.  Fine for hybrid-after-B; not a body backstop.
7. **Coach `get_filing_body` / console filing sheet (PR C)** not required for the snap, but “reviewer can open the 10-K” is not a mitigation until it exists.

Local is good enough to **stop new body vectors** for SEC **if** the ledger/FTS path runs (it does, as of PR A) **and** Green/Red can recover a missed sentence (it cannot, until PR B).  That is the whole A → B gate.

---

## 3. PR A vs PR B vs Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`

| Piece | On main? | What it does | Flip? |
| --- | --- | --- | --- |
| **PR A** — split writer + write-class + re-embed guard | **Yes.**  #2820 squash `ea68c1fc` (`docs/EFFORT-LOG.md`; rollout `docs/rollouts/2026-08-18-hybrid-and-prune.md`).  Follow-ups: FTS bounded mirror #2885. | `pineconeWriteClass()` default **`full-body`** (`pinecone-write-class.ts:3–7, 41–47`).  `persistLocalComplete`.  `selectSignalChunks`.  Processed `storeDocument`s always.  `corpus-reembed` `processedCommitCoversAccession`.  Ledger columns. | **Inert.**  Env unset. |
| **PR B** — money-path hydrate + dossier | **No.**  No `proposer-dossier.ts`.  No `hydrateAccession`.  No `RAG_PROPOSER_DOSSIER`. | Local-only expand of winning pointers from `chunks.json` / artifact / FTS.  1,200-char scout stub.  Reserved Item 1A.  150 ms / 8-accession fail-open.  **No EDGAR under the strategy lock.** | Cannot flip without this. |
| **Infisical `RAG_PINECONE_WRITE_CLASS=highlight+signal`** | **Must not set.** | `ingestFiling` would skip the body `storeDocument` (`sec-filings.ts:695–710`) and ledger from signal counts.  Green/Red would see abstracts + ≤12 sections with **no hydrate**. | **Not this week.**  Sequence remains **A → B → Infisical** (`docs/designs/2026-08-16-proposer-corpus-storage.md:28–29, 572–592`). |

`writesProcessedToPinecone()` is true for **all three** classes including `full-body` (`pinecone-write-class.ts:56–61`).  Setting the env is the only producer switch that **stops** the body upsert.  Aliases: `highlight+signal` and `highlight-signal` (`:45`).

**What must not flip yet (explicit):**

- `RAG_PINECONE_WRITE_CLASS` (any non-default).
- Prune `--apply`.
- Embed model / provider.
- `WEB_SOURCE_SEC8K_FULL_BODY=on`.
- `PINECONE_TRIAL_ENDS_AT=off` unless the owner pays through the snap (that disables the 60k write snap, `pinecone-trial-window.ts:74–76, 208–210`).
- Raising daily fuse further.  5M is already the week budget.

STATUS/PLAN still say “do not flip write-class or prune” on gather PRs; that remains correct.

---

## 4. After 2026-08-27 Starter snap

Runtime (`assessPineconeTrialWindow` idle/free branch, `src/lib/pinecone-trial-window.ts:204–226`; test `:155–170`):

| Knob | Value |
| --- | --- |
| Write units / day | **60,000** (`PINECONE_FREE_TIER_WU_PER_DAY`) |
| Embed texts / day | **20,000** (`PINECONE_FREE_TIER_TEXTS_PER_DAY`) |
| Write units / month | **1,600,000** (`PINECONE_FREE_TIER_MONTHLY_WU`) |
| Storage (plan, not code) | Starter **2 GB ≈ 250k records ≈ ~350 full filings** (`docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md`; design storage table) |

Retrieval is **never** gated (`pinecone-trial-window.ts:11, 298–309`).

### 4.1 What still fits the **write** snap (processed only)

- Incremental day: ~30 8-K briefs + ~20 new calls as highlight+signal ≈ **6–10k WU** (~15% of 60k).  Design table.  **Fits.**
- Deepen 150 held names × ~8 extra processed docs ≈ **240k WU** ≈ **4 days** of Starter writes.  Do this **before** the snap or stretch it after.
- Universe Pass A processed (1,000 × 4 docs × ~200 WU) ≈ **800k WU** ≈ **14 Starter days**.  Do as much as possible **this week** on the 5M cap **without full bodies**.
- Rebuilding one fat 10-K (933 × 16) ≈ **15k WU** ≈ **25% of a Starter day**.  A 1k-name full-body 10-K pass at 200 chunks ≈ **53 Starter days**; at 900 chunks ≈ **240 days** (design Write units table).  **Does not fit.**

### 4.2 What must stay local-only after the snap

- Full 10-K / 10-Q bodies, Item 8 tables, exhibits.
- Transcript text except the HI latest-full exception until FTS exists.
- Worker HTML / `chunks.json`.
- ROIC archive / `earningscalls_transcripts`.
- Any re-embed of leftover FTS body rows.
- Experience-memory stays in Pinecone (do-not-touch), not “local-only.”

### 4.3 Storage vs writes (the trap)

The write snap does **not** shrink the index.  Trial spend on the order of **$62 ≈ 15.5M WU ≈ 0.5–1.0M delivered records** already **does not fit 250k / 2 GB** (design Storage table; 2026-08-18 audit §2).  Options after Thursday:

1. **Stay on paid storage** (Standard or Builder) and only live with the **write** fuse.  Honest if PR E prune cannot land.
2. **Receipt-gated prune** of non-signal `10-k` / `10-q` / `earnings-transcript` bodies whose accession is local-complete with a current abstract.  Never delete FTS, artifacts, or do-not-touch types.  **After** hydrate is proven (PR B).
3. **Hope Starter holds a 0.5–1M record index.**  It will not.  Writes then 429; retrieve may still work on whatever remains until eviction.

Owner this week: snap is **Starter**.  That makes prune **calendar-critical** *or* an explicit paid-storage fallback.  Do not evict blindly on the 27th.

---

## 5. Builder 10 GB / 5M WU (maybe after this week)

Builder is **$20 flat, 10 GB, 5M WU/month, blocked at the cap, no overage** (2026-08-18 pricing table in `docs/audits/2026-08-18-pinecone-store-vs-condense.md` §2).  It is **not** unlimited raw 10-Ks.  Quality gate: processed keep-set on Starter retrieve (Precision@k of **consumed** evidence, not record count) before paying.

### 5.1 Processed keep-set + held-name history — **fits, with room**

| Corpus | Records | vs Starter 250k | vs Builder ~1.25M (5× 2 GB heuristic) |
| --- | --- | --- | --- |
| 1,000 names × 4 latest docs × ~15 vectors | **~60k** | Yes | Yes |
| + deepen 150 HI × ~8 extra processed docs | **+~18k** | Yes | Yes |
| + 150 HI latest full transcripts × ~30 | **+~4.5k** | Yes | Yes |
| + experience / lessons / fundamentals | tens of k | Yes if bodies pruned | Yes |
| **Keep-set total** | **~80–120k** | **Yes on 2 GB if old bodies gone** | **Yes, lots of headroom** |

5M WU/month on Builder **rebuilds** that keep-set (~800k–1.2M WU) and still has ~4M for incremental + deepen.  Incremental ~10k/day × 31 ≈ 310k.  **WU is comfortable.  Storage is comfortable — if new writes stay processed.**

### 5.2 Full-body 1k-name 10-Ks — **blows Builder**

| Corpus | Records | 10 GB? |
| --- | --- | --- |
| 1,000 latest 10-Ks @ 200 chunks | ~200k | Borderline **alone**; no 10-Q, no transcripts, no trial leftovers |
| 1,000 latest 10-Ks @ **900 chunks** (live worker) | **~900k** | **No** once 10-Q + calls + trial leftovers share the 10 GB |
| 1,000 × latest four **full** docs @ 200 avg | ~800k | **No** with hangover |
| Trial already written | **~0.5–1.0M** | Already a Builder-sized (or larger) index **before** any new 10-Ks |

Vector bytes: 1024-dim f32 = 4 KiB **plus** `text` / `parent_text` metadata (soft cap 40,896 bytes, `vector-db.ts:723–726`).  Fat chunks with parent expansion are **storage-heavy**.  900k records at even ~8–12 KB payload is **7–11 GB** before indexes.  That is the Builder wall.

**Do not fill Builder with raw 10-K/Q/transcripts even if the owner upgrades after quality looks good.**  Upgrade buys **more names and more held history of the keep-set**, and slack so we do not have to prune on day one.  It does not buy Item 8 tables in ANN.

---

## 6. Citations (file:line)

Write class and matcher:

- `src/lib/rag/pinecone-write-class.ts:3–7` — default `full-body` until PR B; do not flip env in that change.
- `src/lib/rag/pinecone-write-class.ts:9–36` — classes, signal item codes, processed / do-not-touch types, 12 / 20k / 8 QA caps.
- `src/lib/rag/pinecone-write-class.ts:41–61` — env reader; `writesFullBodyToPinecone`; processed writes true for all classes.
- `src/lib/rag/pinecone-write-class.ts:74–92, 146–181` — parse `"{code}. {title}"`; Item 8 skip; transcript management + QA.

SEC local + body funnel:

- `src/lib/web-sources/sec-filings.ts:77–84` — `writeLocalArtifact`.
- `src/lib/web-sources/sec-filings.ts:512–538` — `ingestFiling`; skip if ledgered.
- `src/lib/web-sources/sec-filings.ts:565–570` — artifact then EDGAR.
- `src/lib/web-sources/sec-filings.ts:621–715` — write class, `persistLocalComplete`, abstract, **signal always**, body only if full-body.
- `src/lib/web-sources/sec-filings.ts:1215–1252` — `sortBreadthFirst` latest-then-deepen.

Local-complete and processed writes:

- `src/lib/rag/persist-local-complete.ts:1–2, 39–80, 92–131` — FTS on bare accession; ledger; `hasLocalFilingCopy` also checks abstracts / artifacts / `earningscalls_transcripts`.
- `src/lib/rag/processed-corpus-write.ts:34–71, 74–107` — one complete `storeDocument` per itemCode; `sectionDocumentKey`.
- `src/lib/rag/document-summarizer.ts:30, 325–326, 425–506` — extractive-highlights-v2; 8 × 1,800; SQLite then Pinecone abstract.

Transcripts:

- `src/lib/web-sources/roic-transcripts.ts:7–10, 174–191, 615–640, 735–817` — local-complete first; phase write-class; archive local-only; HI latest full-body; else summary + signal.
- `src/lib/earningscalls-transcripts.ts:72–76, 849–916` — immutable SQLite cache; Pinecone **full body** then earnings-summary.  No FTS.

Trial snap and WU:

- `src/lib/pinecone-trial-window.ts:17–28, 193–197, 204–226, 279–309` — end 2026-08-27; 60k / 20k / 1.6M; honor 5M monthly during trial; one `storage_warning` on snap.
- `src/lib/vector-db.ts:715–717, 2323–2341` — WU = ceil(bytes/1024); managed ×2.
- `src/lib/rag/fts-mirror-bound.ts:19–20` — 933 chunks / 279s live receipt.
- `src/lib/web-sources/sec8k.ts:858–860` — full-body 8-K default off.

Re-embed / PR A guard:

- `src/lib/rag/corpus-reembed.ts:350–411` — live full commit **or** highlight+signal commit covers leftover FTS rows.

Design / prior panel / hybrid PR:

- `docs/designs/2026-08-16-proposer-corpus-storage.md:15–29, 203–220, 371–410, 572–592` — split writer; A → B → Infisical; WU and storage tables; do not flip after A alone.
- `docs/audits/2026-08-18-pinecone-store-vs-condense.md:20–59, 229–256` — hybrid recommendation; Builder 10 GB / 5M; do not fill with raw bodies.
- `docs/rollouts/2026-08-18-hybrid-and-prune.md:9–15, 41–72` — PR A on main; PR B still required; prune dry-run.
- `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md:109–121` — ~8 WU/record, ×2 managed; 2 GB ≈ 250k records.

---

## What the next agent should do

1. **Do not Infisical-flip write-class.**  Land PR B (`hydrateAccession` local-only + `assembleProposerDossier` + scout stub) then flip.
2. **This week:** pause new SEC **body** upserts; keep 8-K briefs + ROIC processed + local archive; spend 5M WU only if a producer is actually in `highlight+signal` **or** you are writing abstracts/signals for names that will not also full-body (today they will).
3. **Before 2026-08-27:** measure live Pinecone **record count / GB** from `/api/admin/rag-coverage` + console.  Do not guess.  Pick prune-with-receipts vs paid storage **explicitly**.
4. **EarningsCalls/FMP full-body ingest** should honor the same write-class as ROIC in the same PR as any flip, plus a transcript FTS mirror before dropping the HI full-call exception.
5. **Builder** only after processed retrieve quality looks good on held names (consumed Precision@k, not “more GB”).  Even then, keep-set + history, not 1k full 10-Ks.
