# Panel: learning, analog retrieval, and what belongs in Pinecone

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Status | Report-only (no product-code change) |
| Author | Grok (strategy learning / experience-memory / analog retrieval) |
| Tree | `trading-grok-pinecone-free-snap` |
| Scope | What RAG + learning should inject into Green/Red; Pinecone vs SQLite this week and after a Starter snap; analog path liveness; packing outcomes without dumping ledgers |
| Companions | `docs/audits/2026-08-17-rag-learning-recall.md`, `docs/audits/2026-08-18-pinecone-store-vs-condense.md`, `src/lib/rag/pinecone-write-class.ts` |

This is a read-only panel.  It does **not** flip `RAG_PINECONE_WRITE_CLASS`.  It does **not** prune the live index.  It does **not** delete, thin, or archive `experience-memory`.

---

## Verdict

Learning already has two live stores and a live analog **path**.  SQLite holds the ledger of truth (fills, lots, scorecards, decision JSON, coach archive, fact-tier `learned_context`).  Pinecone holds what k-NN can retrieve.  Green/Red **do** receive analog and coaching blocks on the money path — this is not eval-only.  The path is still a weak teacher: one portfolio-level situation sketch per run, fat `socratic-decision` blobs dumped via `formatChunkWithProvenance`, an exact-account filter that can hide pooled thesis×regime lessons, fail-open vector writes with no retry, and a Green system prompt that names `closestHistoricalAnalogs` only as a DATA-NOT-COMMAND fence.

Owner constraint, restated as the storage rule: **full trade history, performance tables, and coach archives stay local; Pinecone holds only the compact cards retrieval will inject.**  That is already true for scorecards.  It is not yet true for Socratic case files.

**Do not prune experience-memory.**  Confirmed below.

---

## 1. What belongs in Pinecone vs SQLite

### 1.1 This week (write-class still `full-body`)

Do not flip write-class.  Filings stay hybrid-producer / full-body default until hydrate (PR B) is on `main`.  Learning is a **different** corpus: `DO_NOT_TOUCH_DOC_TYPES` already excludes it from operational prune.

Pinecone **this week** should keep (and keep writing) only these learning artifacts:

| Artifact | `doc_type` / source | Why it is in ANN | Shape to keep |
| --- | --- | --- | --- |
| Closed-lot experience | `doc_type=socratic-decision`, `source=experience-memory`, `memory_kind=experience` | Situation k-NN + realized sign | Already a compact state sketch + outcome line.  Keep. |
| Decision case (proposal-time + lifecycle reindex) | `doc_type=socratic-decision`, `source=socratic-memory` | Analog of "what we decided and why" | **Too fat for the prompt.**  Keep writing this week so retrieval is not empty; pack at inject time (section 3).  After snap, replace the embed text with a card (section 1.2). |
| Owner coach note (standalone) | `doc_type=coach-note` | Coaching block | One note, thesis, regime.  Keep. |
| Durable lesson | `doc_type=lesson` (decision lessons, promoted lessons, thesis×regime rollup, coach-URL lessons) | Analog pass consumes `lesson` as analog (not coaching) | One guidance sentence + tags.  Keep. |
| User memory / fundamentals | `user-memory`, `fundamentals` | Listed in do-not-touch | Out of this panel except: do not prune them as a side effect. |

SQLite **this week** is the system of record for everything analog retrieval must **not** dump:

| Artifact | Where | Injected how |
| --- | --- | --- |
| Fills, FIFO lots, MAE/MFE, PnL | fill events + `calculatePnl` | Never as ANN text.  Experience write **reads** them. |
| Thesis / regime / combo / factor / sector scorecards | performance tables | Structured JSON on Green (`thesisOutcomes`, `comboOutcomes`, …) and Red (`RED_TEAM_REVIEW_CONTEXT_KEYS`) |
| Full `SocraticDecisionCase` (evidence, dissent, RAG attributions, policy, override) | `socratic_decisions` | Desk / trace / reindex source.  Not a ledger dump into ANN. |
| Coach-note live window + `socratic_coach_note_archive` | db-socratic | Archive is local.  Standalone `coach-note` vectors survive the live cap. |
| Fact-tier learned facts | `learned_context` | `retrieveLearnedContextDetailed` → `learnedContext` string (SQL, not Pinecone) |
| Risk / strategy-directive pending | `learned_context_pending` | Approval queue.  Risk stays SQL; directives go into the owner prompt, not ANN. |
| Learning mutations, usefulness stats, candidate pools | ledger tables | Ops / eval.  Not prompt neighbors. |

Writers already match that split:

- Closed-lot embed: `buildClosedLotExperienceDocument` (`src/lib/experience-memory.ts:129-205`) puts the 8 factor scores, regime, thesis, compact rationale, and `realized_outcome` in **text**, and `return_pct` / `holding_days` / `risk_exit` / `mae` / `mfe` in **metadata**.
- Decision embed: `buildSocraticMemoryDocument` (`src/lib/socratic-memory.ts:76-96`) concatenates broker argument, critic, policy, override, RAG contribution, evidence, multi-horizon outcome, lessons, and coach notes.  That is a case file, not a retrieval card.
- Lesson / coach standalone writers: `indexLessonMemory` (`:149-193`), `indexCoachNoteMemory` (`:365-384`), `indexPromotedLessonMemory` (`:436-449`), `writeThesisRegimeLessonVectors` (`src/lib/post-mortem.ts:561-607`).
- SQL facts: `retrieveLearnedContextDetailed` (`src/lib/learned-context/store.ts:281-294`) reads `listLearnedContextForDecision` (`src/lib/db-learning.ts:954-1001`), fact-tier only.

### 1.2 After a Starter snap (2 GB / 2M WU)

Starter is a **storage and write-unit wall**, not a reason to delete memory.  Operational filings should already be moving to processed keep-set (highlights + signal sections); learning must stay small and do-not-touch.

Pinecone after snap — **cards only**:

1. **Experience card** (one per closed lot, same id key `exp:{entryProposalId}:{exitProposalId}`): embeddable text limited to situation (ticker, side, thesis, regime, sector, factor line, one-line entry rationale) plus a one-line outcome (`return_pct`, `holding_days`, `risk_exit`).  Metadata keeps the scalars.  Do not embed fill ids, account numbers, raw PnL ledgers, or the exit fill tape.
2. **Decision card** (overwrite-in-place on the existing `accession=decision.id`): `final_action`, side, thesis, regime, one-line Green claim, one-line Red objection, policy approved/blocked, outcome status + `return_pct` when known.  Drop `rag_contribution` dumps, five-evidence blobs, autonomy-override essays, and in-row `coach_notes:` windows (those already have standalone vectors).
3. **Coach-note card**: keep as written today (already short).
4. **Lesson card**: keep as written today (already short).  Thesis×regime rollups stay one living vector per `(userId, thesisTag, regime)`.

SQLite after snap — **everything else**, including the full case JSON used to rebuild a card on reindex.  Scorecards stay SQL → structured prompt fields.  Fill history stays SQL.  Coach archive stays SQL.

Reindex path already exists: `listClosedLotExperienceDocumentsForAccount` (`experience-memory.ts:340-401`) is read-only reconstruction from fills.  After snap, change **`buildClosedLotExperienceDocument` / `buildSocraticMemoryDocument` text**, not the prune classifier.  Rebuild cards from SQLite; do not delete the namespace.

What must **never** go into ANN, this week or after snap:

- Per-fill blotter rows, order ids, broker raw JSON.
- MAE/MFE *series* (scalars on the card are enough).
- Full Green/Red transcripts.
- `learned_context` fact rows (already SQL).
- Numeric policy weights (`learning_mutations`).
- News headline ledgers (enrichment-only; 2026-08-17 S6).

---

## 2. Does analog retrieval actually reach Green/Red?

**Yes.  Live money path, not eval-only.**  Tests pin the contract.  Production quality is still weak.

### 2.1 Wiring (live)

1. **Write (close):** `performance.recordFillFromProposal` fire-and-forget on sell/cover (`src/lib/performance.ts:443-464`); duplicate hook in `strategy-execution.ts` (~1705).  `recordClosedLotExperience` (`experience-memory.ts:252-325`) is best-effort, never throws.
2. **Write (decide / coach / lesson):** `indexSocraticDecisionMemory`; `writeSocraticDecisionLessons` awaits reindex + per-lesson vectors (`src/lib/db-socratic.ts:655-675`); coach append indexes a standalone note (`:424-443`).
3. **Read:** `proposeTrades` second pass, distinct from filings (`src/lib/strategy.ts:1743-1848`).  Calls `retrieveDecisionExperiences` with `EPISODIC_DOC_TYPES = ["socratic-decision","coach-note","lesson"]` (`experience-memory.ts:45, 530-573`), `matchAllSymbols: true`, `accountScope: "exact"`, `asOf: runAsOf`, `minScore: defaultMinScore()`.
4. **Green inject:** `experienceAnalogs` / `ownerCoaching` → containment → evidence budget key `analogs` priority 85 / `coaching` priority 95 (`strategy.ts:5135-5136, 5200-5256, 5725-5726`) as `closestHistoricalAnalogs` and `ownerCoaching`.
5. **Red inject:** `projectRedTeamReviewContext` copies those keys (`src/lib/red-team.ts:117-133, 140-147`).  Red Job 2 explicitly weighs them (`src/lib/strategy-prompts.ts:254`).
6. **Receipt:** `audit("experience_retrieval", …)` with analog/coaching/counterexample ids (`strategy.ts:1825-1838`).  Usefulness join later.

Default flag is **on**: `experienceMemoryEnabled` = `EXPERIENCE_MEMORY` env, default true (`experience-memory.ts:63-65`).

Eval harness (`retrieveFusedContext`) is **not** this path.  2026-08-17 R1 still applies to filings evals, not to analog injection.

### 2.2 Where it is dead or half-dead

| Gap | Evidence | Effect on Green/Red |
| --- | --- | --- |
| One sketch per **run**, not per candidate | `buildSituationSketch` top-3 + held cap 6 (`experience-memory.ts:427-461`); single `retrieveDecisionExperiences` in `strategy.ts:1806`.  2026-07-04 design asked for 5–10 priors **per candidate**. | AAPL's analog slot can be filled by an NVDA prior because the query is a portfolio paragraph. |
| Green has no analog **job** | `strategy-prompts.ts:215` lists `closestHistoricalAnalogs` only in DATA-NOT-COMMAND.  `learnedContext` gets a dedicated "how to weigh" paragraph (`:214`). | Red is told to use analogs.  Green is told not to obey them as commands.  Wisdom is asymmetric. |
| Inject dumps full `chunk.text` | `formatChunkWithProvenance` (`vector-db.ts:6103-6116`) prefixes provenance then the whole body.  Analog block maps every chunk that way (`experience-memory.ts:622-633`). | One fat `socratic-decision` can burn the 28k learning family quota (filings 24k / learning 28k, `strategy.ts:5280-5288`).  Coaching (95) and learned facts (90) outrank analogs (85). |
| Counterexamples labeled, not forced | Opposite `return_pct` → `[COUNTEREXAMPLE]` (`experience-memory.ts:506-509, 605, 631`).  No second loss-restricted query. | If the k=8 are all winners, Red never sees a losing analog. |
| `accountScope: "exact"` vs pooled lessons | Filter `connected_account_id $eq` (`vector-db.ts:6423-6425`).  Thesis×regime lessons stamp `memory_scope: "user"` and **omit** `connected_account_id` (`post-mortem.ts:591-604`) while claiming paper should help live. | Those lesson vectors can be unretrievable on the analog pass they were written for. |
| Exact-account also silos experience | Closed-lot docs **do** stamp `connected_account_id` (`experience-memory.ts:198`). | Paper analogs do not appear on a live run even though scorecards/lessons were pooled by owner directive. |
| Live close write can no-op | `recordClosedLotExperience` returns null when no matched closed lot (`:269`).  Live fills start `pending_reconciliation` (`performance.ts:265`).  Comment at `experience-memory.ts:248-250` calls this a known v1 gap. | Live lots may never enter ANN until a later path re-runs the hook. |
| Vector write fail-open | `console.warn` + `socratic_vector_write_degraded` (`experience-memory.ts:317-323`; `socratic-memory.ts:191`; 2026-08-17 L7).  No retry queue. | SQLite truth, empty analog block, status `ok_empty` / `lookup_failed`. |
| Decay / lifecycle unwired | `blendedScore` tests-only (2026-08-17 L1).  `bumpVectorDocRetrieved` updates rows that were never inserted (L2; `experience-memory.ts:660-667`). | Stale blocked-proposal twins keep full cosine weight. |
| Cosine floor on a sketch query | `minScore: defaultMinScore()` (typically 0.30) on a "Trading situation: market regime …" query vs filings-shaped embeddings. | Can legally return `ok_empty` even with a populated namespace. |

`test/strategy-episodic-injection.test.ts` proves the **injection contract** with a mocked retriever.  It does not prove production analog recall.

---

## 3. How to pack trade performance without dumping ledgers into ANN

Keep three layers.  Do not collapse them.

### 3.1 Ledger (SQLite only)

Fills, lots, MAE/MFE path, per-account PnL.  `recordClosedLotExperience` already **replays** `listFillEvents` + `calculatePnl` (`experience-memory.ts:258-264`).  That is the right read.  Never `storeContexts` the fill array.

### 3.2 Aggregate track record (SQLite → structured prompt)

`thesisOutcomes` / `regimeOutcomes` / `comboOutcomes` / `signalEfficacy` / `confidenceCalibration` (`strategy.ts:5698-5711`).  Red sees the same scorecard keys (`red-team.ts:126-129`).  These are tables, not neighbors.  They already teach Green/Red "this thesis in this regime won/lost" without Pinecone.

### 3.3 Analog card (Pinecone text + metadata → short prompt block)

Pack **at retrieve time this week** (no write-class, no re-embed required).  After snap, pack the same card at **write** time so cosine matches the prompt.

Suggested card (one analog, ~400–700 chars, not the 2–4k case file):

```
ANALOG MSFT long  thesis=Momentum-Breakout  regime=Risk-On  rel=0.77
action=PLACED  return_pct=+7.5  holding_days=11  risk_exit=false
entry: breakout vs weak breadth; size was 1.2% NAV
COUNTEREXAMPLE if return_pct < 0
```

Rules:

- Embed / inject **situation + outcome scalars**, never the FIFO tape.
- Cap rationale with the existing `compact(..., 400)` helper (`experience-memory.ts:70-74`).
- Prefer metadata for numbers (`return_pct`, `holding_days`, `mae`, `mfe`) so the prompt cannot invent them.
- Over-ask `k+4` already (`:555-558`).  After filter, **reserve one slot** for the nearest opposite-sign neighbor if any exists in the fetched set.
- Keep coaching as a separate block (already split at `:597-598`).
- Do not put scorecard tables into the analog query.  They already occupy structured fields.

That is the same hybrid the 2026-08-18 store-vs-condense audit stated for filings: **processed keep-set in Pinecone, full bodies local** — applied to memory: **cards in Pinecone, case files local**.  That audit already said "Experience-memory / lessons stay full" (`docs/audits/2026-08-18-pinecone-store-vs-condense.md:24`).  This panel tightens "full" to **full local, compact ANN**, which matches the owner's Starter-snap constraint.

---

## 4. Do not prune experience-memory.  Confirm.

**Confirmed.  Do not prune it this week.  Do not prune it after a Starter snap.**

Evidence:

- `DO_NOT_TOUCH_DOC_TYPES` includes `socratic-decision`, `coach-note`, `lesson`, `experience-memory`, `user-memory`, `fundamentals` (`src/lib/rag/pinecone-write-class.ts:25-33`).
- `isDoNotTouchDocType` (`:112-114`) → prune classifier `keep-do-not-touch` (`src/lib/rag/operational-index-prune.ts:98-100`).
- Comment at prune file: never deletes experience-memory / lessons (`operational-index-prune.ts:2`).
- Closed-lot vectors use `doc_type: "socratic-decision"` (`experience-memory.ts:178`) and `source: "experience-memory"` (`:37, 174`).  Prune keys **doc_type**, so they are protected as `socratic-decision`.  The extra `experience-memory` token in the do-not-touch set is defense in depth if a writer ever stamps it as `doc_type`.
- Corpus reembed treats experience-memory as a first-class rebuild from fills (`src/lib/rag/corpus-reembed.ts` experience-memory section), not as junk.

Starter snap pressure belongs on **raw 10-K/Q bodies and HTML junk**, which the prune classifier already targets (`raw-html`, `junk`, `low-value`).  Memory is not junk.  Thinning memory by prune would silently empty analog retrieval.

If storage must shrink after snap: **rewrite card text and overwrite in place** (stable `accession` / `vector_id`).  That is a reindex, not a prune.

---

## 5. Highest-leverage learning change in the next 6 days (no write-class flip)

**Pack analog cards at inject time, teach Green to use them, and force one counterexample slot.**

Do not flip `RAG_PINECONE_WRITE_CLASS`.  Do not prune.  Do not wait for hydrate.

Why this beats wiring decay, retry queues, or per-candidate k-NN as the 6-day move:

1. The analog **pipe is already on the money path**.  Green/Red can see the block tomorrow if the text is readable and the system prompt assigns a job.
2. Fat `socratic-decision` text is the thing that loses the 28k learning budget to coaching + SQL facts.  Retrieve-side packing needs **zero WU**.
3. Green currently has no analog stanza (`strategy-prompts.ts:214` vs `:215`).  One paragraph, mirroring `learnedContext`, is the cheapest way to make existing retrieval change decisions.
4. Forced COUNTEREXAMPLE uses metadata already on experience vectors (`return_pct`).  No second index.

Concrete 6-day slice (still advisory, still not a gate):

1. **`formatAnalogCard(chunk)`** in `experience-memory.ts` instead of `formatChunkWithProvenance` for analog lines.  Keep provenance header.  Pull ticker / thesis / regime / `return_pct` / `holding_days` / `risk_exit` from metadata; one compacted rationale line from text.  Cap ~8 cards, ~6k chars before the evidence budget.
2. **Reserve 1 of k** for the nearest `realizedSign === -1` neighbor from the over-ask set when any exists.
3. **Green system stanza** (Title Case field name already `closestHistoricalAnalogs`): treat analogs as advisory priors; a COUNTEREXAMPLE is dissent the rationale must address; do not copy size from a prior lot; paper-sourced analogs are first-class unless the card cites a paper-only mechanism (same rule as `learnedContext` at `strategy-prompts.ts:214`).
4. **Honesty receipt:** if analog status is `ok_empty` / `lookup_failed` / `budget_skipped`, keep the typed `rag_retrieval_status` PORTFOLIO row (`strategy.ts:1817-1819, 1867-1868`).  Do not invent priors.

Out of the 6-day window (still high value, still no write-class):

- Vector-write retry queue (2026-08-17 L7) so live closes actually land.
- Stamp lesson/post-mortem `timestamp` from last contributing fill, not `new Date()` (T4; `post-mortem.ts:576`, `socratic-memory.ts:175, 400`).
- Decide pooling: either drop `accountScope: "exact"` for `doc_type=lesson` / `memory_scope=user`, or stamp pooled ids with a sentinel the filter can match.  Today's exact filter fights the pooled-lesson writer.
- Per-deep-name analog query (k=3 × top-3) after card packing is proven.  That spends extra query embeds; do it after Green can read one portfolio block.
- Wire `recordVectorDocSeen` + flag-gated `blendedScore` (L1/L2).  Useful after there are cards worth decaying.

---

## 6. File:line map

| Claim | Cite |
| --- | --- |
| Experience write/read contract | `src/lib/experience-memory.ts:1-28, 45, 63-65, 129-205, 252-325, 442-462, 530-687` |
| Decision / lesson / coach writers | `src/lib/socratic-memory.ts:40-126, 149-193, 315-384, 394-449` |
| Do-not-touch / no prune | `src/lib/rag/pinecone-write-class.ts:25-33, 112-114`; `src/lib/rag/operational-index-prune.ts:2, 98-100` |
| Strategy analog pass + inject | `src/lib/strategy.ts:1743-1848, 2256-2257, 5135-5136, 5180-5300, 5722-5726` |
| Green vs Red analog instructions | `src/lib/strategy-prompts.ts:214-215, 254, 258` |
| Red context keys | `src/lib/red-team.ts:80-95, 117-133, 140-147` |
| Fill hook + live pending gap | `src/lib/performance.ts:265, 443-464` |
| Thesis×regime lesson vectors | `src/lib/post-mortem.ts:548-607` |
| Coach/lesson SQL + reindex | `src/lib/db-socratic.ts:410-448, 655-675` |
| SQL learned facts | `src/lib/learned-context/store.ts:1-16, 257-294`; `src/lib/db-learning.ts:954-1001` |
| Exact-account + cross-symbol filters | `src/lib/vector-db.ts:6103-6116, 6154-6167, 6423-6425, 6769-6771` |
| Provenance dump of full text | `src/lib/vector-db.ts:6103-6116` |
| Decay unwired | `src/lib/memory-decay.ts:57-68, 78-94`; 2026-08-17 L1/L2 |
| Prior RAG/learning audit | `docs/audits/2026-08-17-rag-learning-recall.md` §3.8 L1–L10, T4, L7 |
| Store-vs-condense (keep experience) | `docs/audits/2026-08-18-pinecone-store-vs-condense.md:20-28` |
| Injection contract test | `test/strategy-episodic-injection.test.ts:1-13, 58-80` |

---

## 7. Explicit non-goals

- Do not flip `RAG_PINECONE_WRITE_CLASS`.
- Do not `--apply` operational prune against memory types.
- Do not put fill ledgers or scorecard tables into Pinecone.
- Do not gate sizing or policy on analog similarity.
- Do not treat `retrieveFusedContext` scores as analog quality.
- Do not create provider keys.

Next agent: implement section 5 in `experience-memory.ts` + `strategy-prompts.ts` only; extend `test/experience-memory.test.ts` and `test/strategy-episodic-injection.test.ts` for card packing and the Green stanza.  Leave write-class and prune alone.
