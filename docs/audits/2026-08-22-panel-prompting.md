# Panel: make Green/Red data easy to use wisely

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Status | Report-only (no product-code change) |
| Author | Grok (LLM prompting / context packing / token budget) |
| Tree | `trading-grok-pinecone-free-snap` |
| Prompt | `agentic-strategy@2.15.0` (`src/lib/strategy-prompts.ts:20`) |
| Companion | `docs/audits/2026-08-18-pinecone-store-vs-condense.md` §3 (how Green/Red see the corpus); `docs/designs/2026-08-16-proposer-corpus-storage.md` |

Owner ask: data provided to Green/Red should be easy to use wisely.  That means **condensed, labeled highlights in the prompt**, not raw 10-K pages.  Full bodies stay on the server for hydrate and chat.

This review does **not** flip `RAG_PINECONE_WRITE_CLASS`, does **not** spend more WU on bodies, and does **not** raise *k*.

---

## Verdict (one paragraph)

The money-path bottleneck is **prompt assembly**, not Pinecone GB.  Strategy already retrieves a bounded set (deep *k*=8 / scout *k*=1) and then stuffs every scan name's SQLite cards **plus** those chunks into one `retrievedFinancialContext` hose capped at **24,000 characters / 6,000 tokens**.  That hose is a prefix slice.  Cards for ~30 scouts and raw Item 8 / boilerplate 1A pages crowd out the 1A/7/7A (or 10-Q 2/1A/3) clauses and latest Q&A turns that can actually flip a vote.  SQLite abstracts exist and are unused in packing.  Red no longer receives the filing bodies at all — only a hash manifest — so it cannot dissent on a 1A sentence Green may have misread.  **This week's win is a per-symbol condensed pack + restore a thin Red filing pack for the name under review.**  Spending remaining trial WU on more raw pages cannot change what the model is allowed to read.

---

## 1. Current token/char waste: retrieved chunks that never influence the proposal

A chunk influences a proposal only if it is **consumed** after containment and the evidence budget (`derivePromptRagConsumption`, `src/lib/rag/evidence-consumption.ts:194–245`).  Retrieval is not consumption.  `strategy.ts:5301–5321` is explicit: candidates the 24k slice drops stay in `retrievedButNotConsumed` and must never enter usefulness / decision attribution.

### 1.1 The consumption gates (verified)

| Gate | Cap | Code |
| --- | --- | --- |
| Deep retrieve slots | 8 | `strategy.ts:1418–1429` |
| Scout retrieve slots | 1 | same |
| Parent expansion | 6,000 / chunk, 12,000 total | `vector-db.ts:574–584` (default **on**) |
| Serialized chunk body | ~2,400 chars default | `vector-db.ts:349`, `contextMaxChars` at `:569` |
| Extractive highlight writer | 8 × 1,800, Jaccard 0.55 | `document-summarizer.ts:325–327` |
| Filings family (RAG **plus** cards) | **24,000 chars / 6,000 tokens** | `strategy.ts:5280–5288` |
| Global prose | 48,000 / 12,000 | same |
| Truncation mechanic | Unicode code-point **prefix** of the whole family string | `evidence-budget.ts:146–147` |
| Green output cap | 4,000 tokens | `llm-request.ts:589` |
| Red output cap | 2,500 tokens | `llm-request.ts:599` |

Filings share one family with **learning** at the global 48k layer.  RAG is priority 100, so it is kept first (`strategy.ts:5180–5187`).  Inside the filings family there is **no per-symbol quota**.  One concatenated string, then a left trim.

### 1.2 What is stuffed into that 24k hose

For **every** unique scan + held symbol (`strategy.ts:1418–1420`, default scan cut **30** at `scan-settings.ts:1`, plus outlier reserve and held extras in `market.ts:564–578`):

1. Semantic retrieve: `deterministicFilingsRetrievalQuery(sym)` = `"Significant financial events, SEC filings, and macro catalysts for ${symbol}"` (`information-routing.ts:118–119`).  Doc types requested: `10-k`, `10-q`, `8-k`, `document-summary`, and when transcripts are on also `earnings-transcript`, `earnings-summary` (`information-routing.ts:37–46`, `123–132`).  Full-body types are still **asked for**, so they compete with compact types.
2. SQLite cards concatenated **into the same dossier** (`strategy.ts:1473–1557`):
   - `formatCompanyFactsEvidenceCard`: up to **50** concept lines (`sec-facts.ts:252–273`).
   - `formatInsiderTransactionsEvidenceCard`: up to **30** Form 4 lines (`sec-facts.ts:284–312`).
   - `formatThirteenFEvidenceCard`: up to **16** filer lines (`thirteen-f.ts:181–190`).
   - `formatArkEvidenceCard`: up to **12** fund lines (`ark-holdings.ts:179–188`).
3. Retrieved chunks, summaries first via `orderChunksForProposer` (`proposer-format.ts:7–16`), serialized with provenance headers (`vector-db.ts:6103–6116`).
4. Dossiers joined with `\n\n---\n\n` in **scan rank order** (`uniqueSymbols` insertion-order Set, `strategy.ts:1420`, `:1532–1564`, `:6482–6483`).  Top-3 deep names sit first (good).  Extra **held** deep names sit **last** (bad).  Scouts 4–N sit in the middle with fat cards.

Cards are **not** pushed into `ragPromptCandidates` (`strategy.ts:1536–1542` only records chunks).  They still occupy the 24k prefix.  Consumption receipts therefore under-count "what stole the hose."

### 1.3 Arithmetic: what never reaches Green

Approximate assembled mass **before** the 24k cut, typical coverage:

| Block | Chars (order of magnitude) |
| --- | --- |
| Facts card (50 lines) | ~3,500–5,000 / name |
| Form 4 (30 lines) | ~3,000–4,500 / name |
| 13F + ARK | ~1,000–2,500 / name when present |
| 1 scout chunk + header | ~1,500–2,400 |
| 8 deep chunks + headers | ~12,000–19,000 (worse if parent expansion filled 12k extra across winners) |
| Extractive 8×1,800 if those win the slots | 14,400 **for one name** |

A **single** deep name at 8 raw/highlight chunks already uses most of 24k.  Three deep names at that density cannot all fit.  Then ~27 scouts each add a card stack.  The prefix keeps rank-1 (maybe rank-2) fully, then mid-chunk-cuts rank-3, then **drops**:

- Every scout dossier after the cut (often almost all of them).  Their *k*=1 retrieve still ran.
- Every **held** name not in the top-3.  Those were retrieved at *k*=8 (`deepSymbols = top-3 ∪ held`, `strategy.ts:1419`) and then assembled last, so they are the first to die in the 24k slice.  That is the cleanest "retrieved but never influences the proposal" class.
- Trailing chunks inside a kept name (lost-in-the-middle after a mid-string trim).  `derivePromptRagConsumption` will label those `truncated` or `not_consumed`.
- Parent-expanded `parent_text` that lost to the same prefix.
- Raw 10-K Item 8 / exhibit / signature pages that cosine ranked into *k* but lose to summaries in sort **or** lose to cards in the budget.
- Boilerplate Item 1A that the generic catalyst query prefers (`information-routing.ts:118–119`) over a one-line going-concern change.  Even when consumed, it is low-leverage.

Chat is a different consumer: `searchKnowledge` default *k*=5, no 24k family (`orchestrator.ts:567–583`).  Full bodies there can still help a librarian turn.  They do not help the strategy prompt.

### 1.4 Red does not see the filing hose at all (regression vs the 2026-08-18 write-up)

The 2026-08-18 audit said Green and Red read the **same** `retrievedFinancialContext` string.  That was true of the old `...userContent` spread.  It is **false** on this tree.

`projectRedTeamReviewContext` copies only `RED_TEAM_REVIEW_CONTEXT_KEYS` (`red-team.ts:117–147`).  That list has analogs, coaching, scorecards, macro, portfolio, and `evidenceManifest` (hashes, **no bodies**).  It does **not** include `retrievedFinancialContext`, `learnedContext`, or `reflectionSummary`.  `strategy.ts:6434–6442` documents the intent: stop re-sending the 48k pack per opening.

Consequence: Red's jobs 1–2 (`strategy-prompts.ts:253–254`) fact-check structured `candidatesUnderReview` and analog memory.  They **cannot** cite Item 1A, MD&A, or a Q&A turn.  `greenRedParityHash` proves both stages hashed the same pack; it does not give Red the sentences.  Filing-conditioned dissent is structurally unavailable.

Green's own instruction for the field is one sentence of "snippets / catalyst evidence" (`strategy-prompts.ts:213`).  There is no reading order (highlights vs 1A vs transcript vs analog).  The model is not told that later `---` dossiers may be truncated, or that scout slots are stubs.

### 1.5 Abstracts already exist and are not packed

`getDocumentAbstractsForTicker` (`db-document-abstracts.ts:57–79`) is unused on the money path.  The 2026-08-16 design already specified: inline SQLite abstracts first, scout = one newest abstract truncated to **1,200** characters (Key Decision 6).  Strategy still hopes ANN will rank `document-summary` / `8k-brief` into *k*.  If a raw 10-K page wins scout *k*=1, the abstract sitting in SQLite never enters the prompt.

---

## 2. Ideal pack for one deep name this week

**Prompt pack ≠ Pinecone keep-set.**  Index can hold signal sections and latest-call slices.  The prompt should see a **labeled dossier** sized to survive 24k with room for a second deep name and a handful of scout stubs.

10-K signal items already coded: `1A`, `7`, `7A`.  10-Q equivalents already coded: `2` (MD&A), `1A`, `3` (market risk).  Transcript: `management` + first **8** Q&A/analyst turns (`pinecone-write-class.ts:12–17`, `:37`, `selectSignalChunks` at `:151–181`).

| Slot | What | Why | Approx chars | Approx tokens (÷4, matching `evidence-budget.ts:17`) |
| --- | --- | --- | --- | --- |
| A. Filing highlight | Latest 10-K **or** 10-Q `document-summary` (extractive, not 8×1,800 dumped) | Catalyst prior; scout-safe | 1,200–1,800 | 300–450 |
| B. 8-K brief | Latest `8k-brief` if any in window | Event, not boilerplate | 600–1,000 | 150–250 |
| C. Risk / MD&A / market risk | 10-K `1A` + `7` + `7A` **or** 10-Q `1A` + `2` + `3`, one slice each, already extractive-capped | The clauses that flip size/side/pass | 3 × 1,200–1,800 = 3,600–5,400 | 900–1,350 |
| D. Transcript turns | Management block + **4–8** latest Q&A (not the full call) | Guidance / tone; FTS still missing | 2,400–4,000 | 600–1,000 |
| E. Facts card | **Latest period only**, ~8–12 concepts (not 50) | Structured numbers Green already has in the scan; this is a cross-check | 400–800 | 100–200 |
| F. Positioning card | Form 4 + 13F + ARK **deltas**, not 30+16+12 dumps | Insider/13F already also live in `smartMoney` | 400–800 | 100–200 |
| G. Experience analog | **1** nearest analog + 1 counterexample if present (learning family, not filings) | Prior similar setup; `experience-memory.ts:545` already keeps 5–10 | 800–1,500 | 200–375 |

**Filings-family subtotal for one deep name: ~9,000–14,000 characters (~2,200–3,500 tokens).**  Target the low end (~10k / ~2,500 tokens) so two deep names + 8–12 scout stubs (1,200 each) fit in 24k.

Do **not** put in the prompt: Item 8 tables, exhibits, signatures, certifications, full 10-K pages, full transcript, 50-line XBRL dumps, parent_text expansion on already-selected highlights.

Keep on the server: full FTS / artifacts / `earningscalls_transcripts` for hydrate and chat (`searchKnowledge`).

Analog (G) already lives in `closestHistoricalAnalogs` under the **learning** quota (28k / 7k tokens, `strategy.ts:5286`).  Leave it there.  Do not copy it into the filings hose.

---

## 3. Scout *k*=1 vs deep *k*=8: starving or drowning?

**Both, for different names.  The shared hose is the drowning.  Scout is starving only when the one slot is the wrong type.**

| Cell | Retrieve | Typical prompt fate today | Diagnosis |
| --- | --- | --- | --- |
| Deep, top-3 | *k*=8, rerank overfetch 150 (`rerank-policy.ts:45–47`, `classifyRerankIntent` at `:125–129` via `limit >= 8`) | Rank-1 may consume 8 chunks + cards (~12–20k).  Rank-2/3 truncated. | **Drowning** if those 8 are overlapping body pages / parent expansion.  Fine if they are highlight + 1A/7/7A + transcript turns. |
| Deep, held off top-3 | *k*=8 (RU spent) | Assembled **last** → usually `not_consumed` | **Retrieve-rich, prompt-starved.**  Worst waste. |
| Scout, ranks 4–N | *k*=1, rerank overfetch 40 | One page plus a fat card stack; most of these lose the 24k prefix | **Starving of the right stub**, not of *k*.  Raising scout to 3 would add more bodies that still miss the budget. |
| Scout *k*=1 when a summary wins | 1 compact type | Correct stub **if** it survives the prefix | This is the intended design (2026-08-16 KD 6).  Not starving. |
| Scout *k*=1 when a 10-K page wins | 1 body page | A random MD&A paragraph Green cannot act on | Starving **of a catalyst**, even if the character budget is used. |

Do **not** raise deep *k* to "use more storage."  Deep *k*=8 already fights 24k (`2026-08-18` §4.2).  Rerank already over-fetches (scout 40 / deep 150).  Extra neighbors never enter the prompt unless *k* and the packer let them.

HyDE / multi-query are default **off** and deep-only (`strategy.ts:1393–1456`).  Turning them on this week would multiply embed cost without shrinking the hose.

**Rule:** scout must stay a **1,200-char abstract stub** (SQLite, not a lottery over 900 body vectors).  Deep must stay *k*≤8 of **typed** slots (A–D above), not eight cosine neighbors.  Held-off-cut names should pack like deep **and be reserved in the 24k prefix**, or they should not retrieve at *k*=8.

---

## 4. Prompt-side change this week that beats more WU on raw bodies

Ranked.  None of these require a write-class flip or a fat ingest pass.

1. **Per-symbol packer with reserved prefix (highest leverage).**  Assemble in this order, each with a hard char budget: (a) deep top-3 ∪ held, condensed pack from §2, ~10k each until filings family is full; (b) scout stubs 1,200 chars, newest abstract only; (c) **omit** 50/30/16/12 cards for scouts (scan `smartMoney` / factors already carry positioning).  Stop concatenating then left-trimming.  This converts today's `retrievedButNotConsumed` mass into consumed decision text without new WU.

2. **Inline SQLite abstracts before ANN chunks.**  `getDocumentAbstractsForTicker` is already there.  Design KD 6 is unimplemented on the money path.  If ANN returns a body page for scout, **replace** it with the abstract for the prompt.  Keep the body id for hydrate/chat.

3. **Prompt-assembly filter to compact + signal itemCodes.**  After retrieve, keep `document-summary` / `earnings-summary` / `8k-brief` and chunks whose `itemCode` is in `PINECONE_SIGNAL_ITEM_CODES`.  Drop Item 8 / exhibits from the string even if they ranked.  Bodies remain retrievable for chat.  `orderChunksForProposer` already prefers summaries; it cannot drop the rest.

4. **Restore a thin Red filing pack for the symbol under review only.**  Not the 48k Green hose.  One condensed §2 pack (or even A+C+D, ~6–8k) on `RedTeamReviewContext`.  Add the key deliberately to `RED_TEAM_REVIEW_CONTEXT_KEYS`.  Without this, Red cannot attack a Green claim that "1A is clean."  Parity of **hashes** is not parity of **sentences**.

5. **Teach Green (and Red) the dossier.**  Bump `agentic-strategy` when wording lands.  Tell the model: highlights first; 1A/7/7A (or 10-Q 2/1A/3) are the risk/MD&A substrate; transcript turns are guidance, not price; scout stubs are incomplete; a missing section is a gap, not a bullish omission; analogs are priors, not orders.  Today's one-liner at `strategy-prompts.ts:213` does not do that.

6. **Tighten the deterministic query later, not as the first patch.**  `"Significant financial events, SEC filings, and macro catalysts for $SYM"` is a boilerplate magnet.  Changing it without a lookahead/queryHash plan degrades old decisions to `unverifiable` (`information-routing.ts:111–116`).  Packing first; query rewrite with a dual-hash receipt second.

**Do not do this week:** more full-body 10-K upserts, raising *k*, turning HyDE on, dumping parent_text into the prompt, or putting 8×1,800 extractive highlights into Green for one name (that is an index product, not a prompt product).

---

## 5. Builder vs Starter — prompt perspective

The model never sees 10 GB or 2 GB.  It sees **8/1 slots and 24k filings characters**.  Storage class only changes **which neighbors cosine can pick for those slots**.

| Plan | Index shape that helps Green/Red | Index shape that hurts the prompt |
| --- | --- | --- |
| **Starter (~2 GB, ~250k records)** | Forces a **small high-precision** operational index: highlights + signal sections + latest HI transcript + experience-memory.  Matches the pack in §2.  Coverage of *names* is the scarce resource, not pages/filing. | Filling Starter with raw 10-Ks (~150–900 chunks each) evicts summaries.  Scout *k*=1 becomes a random page. |
| **Builder (10 GB, 5M WU/mo, hard cap)** | Five times the **processed keep-set**: more issuers, more history of 1A/7/7A and transcript turns, still typed.  Same prompt pack.  Better Recall@8 of the right types. | A 10 GB **haystack of raw bodies** makes the generic catalyst query worse: more near-duplicate risk-factor templates, more Item 8 tables, more lost-in-the-middle after 24k.  Extra GB cannot be "used" by Green.  Write-blocks at 10 GB then freeze ingest of the keep-set. |

**Prompt-side preference: a small high-precision index beats a large haystack.**  Builder is worth $20 if it stores **more names of the keep-set**, not more pages of names we already have.  That is the same hybrid recommendation as 2026-08-18, restated for the LLM: **condense for the prompt and the ANN; store-more locally for hydrate/chat.**

Starter is not "too small for good proposals" if packing is right.  It is too small for a full-body latest-1k.  Builder does not fix a 24k prefix of 50-line XBRL cards.

Experience-memory / coach-note / lesson stay full in either plan (`DO_NOT_TOUCH_DOC_TYPES`, `pinecone-write-class.ts:26–33`).  Do not summarize fills to save GB.  Those vectors are already small and already in the learning quota, not the filings hose.

---

## 6. File:line map (this tree)

| Topic | Location |
| --- | --- |
| Deep *k*=8 / scout *k*=1 | `src/lib/strategy.ts:1418–1429` |
| Query | `src/lib/rag/information-routing.ts:118–119` |
| Requested doc types (full + compact) | `src/lib/rag/information-routing.ts:37–46`, `:123–132` |
| Dossier assemble + cards in the same string | `src/lib/strategy.ts:1473–1564` |
| Summary-first sort | `src/lib/rag/proposer-format.ts:1–16` |
| 24k / 6k filings family | `src/lib/strategy.ts:5280–5288` |
| Prefix truncation | `src/lib/evidence-budget.ts:107–178` |
| Consumption ≠ retrieval | `src/lib/rag/evidence-consumption.ts:194–245`; `strategy.ts:5301–5321` |
| Prompt version / RAG one-liner | `src/lib/strategy-prompts.ts:20`, `:213` |
| Red projection (no RAG bodies) | `src/lib/red-team.ts:117–147`; `strategy.ts:6434–6442` |
| Signal item codes / Q&A cap | `src/lib/rag/pinecone-write-class.ts:12–17`, `:37`, `:151–181` |
| Extractive 8×1800 | `src/lib/rag/document-summarizer.ts:325–327` |
| Parent expansion | `src/lib/vector-db.ts:574–584` |
| Provenance header | `src/lib/vector-db.ts:6103–6116` |
| Lookup fails closed before FTS | `src/lib/vector-db.ts:6646–6653` |
| Chat retrieve *k* default 5 | `src/lib/chat/orchestrator.ts:567–583` |
| Analog *k* 5–10, compact 400 | `src/lib/experience-memory.ts:70–74`, `:545`, `:622–633` |
| Scan default 30 | `src/lib/scan-settings.ts:1` |
| Facts 50 / Form 4 30 | `src/lib/web-sources/sec-facts.ts:252–257`, `:284–290` |
| Unused abstracts helper | `src/lib/db-document-abstracts.ts:57–79` |
| Write class still `full-body` default | `src/lib/rag/pinecone-write-class.ts:1–7`, `:41–48` |

---

## 7. What the next agent should implement (not this note)

1. Per-symbol condensed packer + reserved 24k prefix (deep ∪ held first; scout = 1,200-char abstract).
2. Inline `document_abstracts` on the money path; suppress retrieved compact types when the same accession is inlined (design already says this).
3. Drop non-signal body pages from **prompt serialization** (keep them in the candidate pool / chat).
4. Add a per-opening condensed filing field to Red's documented key list.
5. Bump `agentic-strategy` with a dossier reading order.
6. Measure `consumed / retrieved` by `doc_type` and `retrievedButNotConsumed` character mass (`strategy_rag_prompt_consumption` audit at `strategy.ts:5439+`).  A packer win is a drop in that mass **and** a rise in compact-type + 1A/7/7A consumption on deep names.

Zero product code was changed in this audit.
