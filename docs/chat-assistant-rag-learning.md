# Chat Assistant — RAG, NL-Finance Chat & Learning: Architecture, Issues & Roadmap

**Status:** Advisory complete (5-agent expert panel, 2026-06-21: RAG · NL-finance-chat ·
conversational-onboarding · prompt/tool engineering · LLM memory/learning). Decision below is
**accepted**; the **NOW** tranche is **approved** by the user. This doc is the durable home for the
decision, the tracked issues (incl. bugs in the shipped chat), the roadmap, and the pending
provisioning/cost calls.

Touchpoints: `src/lib/chat/*`, `app/api/chat/route.ts`, `app/api/proposals/from-draft/route.ts`,
`app/ui/assistant-console.tsx`, `src/lib/vector-db.ts`, `src/lib/rag/chunk.ts`, `src/lib/memory/*`,
`src/lib/chat-history.ts`. Related: `docs/atlas-integration-map.md`,
`docs/rollouts/2026-06-20-ai-order-drafting-assistant-tab.md`.

---

## 2026-07-13 shared evidence-consumption update

The write boundaries below remain intact, but Coach/chat, strategy tuning, and Framework review now
consume evidence through the same primitives as the trading strategy:

- retrieved, tool, provider, and persisted-LLM strings are recursively contained as untrusted data;
- each surface has one global context budget with model-visible truncation/omission receipts;
- evidence is content-addressed, hashed, and audited rather than being anonymous prompt prose;
- chat memory/learned context retrieval carries the selected account boundary;
- Coach uses the shared model catalog, exposes provider-supported reasoning effort, and requires an
  explicit model instead of silently selecting one; and
- GPT-5.6 Luna, Terra, and Sol are available alongside retained GPT-5.4 Mini/Nano.

This closes the previously tracked RAG prompt-injection gap (I8) for the active chat tool loop. It
does not give free-text chat authority to mutate strategy weights or risk policy.

## 2026-07-22 parent-context expansion boundary

Long filing sections are stored as child chunks with their source parent text. `RAG_PARENT_CONTEXT_EXPANSION`
is default-off: child text is the only recall/rerank unit, then the final survivors may receive one
deduplicated parent-context attachment under `RAG_PARENT_CONTEXT_MAX_CHARS` (default 6,000) and
`RAG_PARENT_CONTEXT_MAX_TOTAL_CHARS` (default 12,000). It never creates a candidate, inflates a score,
or changes child provenance/order. Where the selected child is verbatim inside its parent, the helper
attaches only surrounding parent prose rather than duplicating prompt text. Under an active strict
`asOf`, an undated or future parent is not attached. This is a context-quality experiment, not an
ingestion or re-embedding change; evaluate it against prompt consumption and production-path PIT results
before enabling it.

## 2026-07-22 exact retrieval-versus-consumption receipts

Retrieval is not evidence use. Strategy now derives decision-case RAG attribution only from chunks
that survived containment and the final shared prompt budget into the Bull/Red payload. It retains
the rejected retrieval candidates separately as identifier-only diagnostics, so later usefulness
learning cannot award outcomes to a chunk the model never saw. Truncated/header-only evidence stays
diagnostic and never earns outcome credit. Chat KB tool results use the same stable `rag_*` evidence
references and propagate them into citations, but are truthfully labeled tool-result assembly until
a subsequent provider request actually uses them. New receipt/audit payloads
contain identifiers, metadata, character counts, and text-free empty/error/deduplication counters
only—never raw prompts, raw retrieval queries, or error strings.

## 1. Core decision — HYBRID: separate WRITE surfaces, one shared READ substrate

The question is not "one brain or two." Decompose "separation" into **read** and **write**; the
answer differs per surface because each has a different trust model and failure mode. All five
experts converged on this independently, and the isolation boundary they want **already physically
exists** in the code (no execution tool in the chat loop; the §3.E weight-shift gate; the single
human-gated `from-draft` bridge).

| Surface | Verdict | Why |
|---|---|---|
| Execution (placing orders) | **ISOLATE** | The load-bearing safety property — no execution tool in the chat loop; orders cross only via the human-confirmed `from-draft` bridge that re-validates server-side. |
| Strategy factor-weight / risk tuning + `reflection_summary` | **ISOLATE** | Untrusted free-text chat gets **zero vote** in weights/risk rules. Letting it write here would poison an autonomous money loop — the single move that turns a chatty user into a risk event. |
| Conversation working memory (`chat_turns`) | **ISOLATE** | Chat-local, PII-sensitive, useless to the strategy engine. |
| RAG knowledge corpus | **SHARE** | One corpus, one `as_of` point-in-time guard. No double-embedding the same 10-K. |
| User preferences/constraints (`user_memory`) | **SHARE** | Already injected into the chat prompt; the legitimate personalization that honors `[HARD]` constraints. |
| Trade outcomes + app state (positions/P&L/proposals/watchlist/regime/scorecards) | **SHARE (read-only)** | The **biggest gap + cheapest win** — see I6. Zero execution risk. |

### Structured-vs-narrative retrieval boundary (2026-07-22)

RAG is only for caller-declared narrative needs: filings, entitled transcript narrative, lessons,
and research prose. Current market quotes, positions/portfolio state, open orders, and normalized
financial/insider facts remain deterministic tool or SQLite inputs. `src/lib/rag/information-routing.ts`
is fail-closed: it does not infer a route from free text, and unknown need kinds create neither a
semantic retrieval request nor a synthetic substitute. Strategy uses this contract now; chat and
evidence-consumption should adopt it before adding new retrieval callers.

**One-way data flow:** outcomes/app-state/corpus flow **into** chat as grounded context; chat
opinions **never** flow into the trading brain except through one explicit, human-confirmed path
(constraints → policy, §2).

## 2. Learning integration (user direction)

User direction: lean **toward integrated/shared learning** ("don't separate it out so it learns
more"), **gated by explicit confirmation** on anything that changes the trading brain. This is
compatible with the hybrid model and is the safe way to maximize shared learning:

- **Share, safely:** (a) user preferences/constraints → trading **policy** *after an explicit confirm*
  (§I10); (b) realized **outcomes** (incl. chat-originated trades, once provenance is restored, §I11)
  read back into chat via the existing `performance.ts` machinery; (c) the **RAG corpus**; (d) the
  **salience memory** read by both.
- **The one carve-out that stays isolated:** the strategy's **statistical** learning — moving factor
  weights / risk rules from realized closed lots behind the §3.E gate — must **not** be steerable by
  free-text chat phrasing or chat "feedback." That gate (closed-lots required, prose distrusted) is
  what keeps the autonomous loop trustworthy. Chat-side feedback (thumbs/corrections) trains **chat
  behavior** (example/prompt selection) only.
- Net: the confirmation gate **is** the integration mechanism — it lets chat and the autonomous agent
  share preference + outcome learning without a casual phrase silently changing real risk limits.

## 3. Multi-LLM requirement (new, from the user)

The chat must let the user **choose between multiple frontier LLMs**; whether keys are
**user-provided or app-provided is deferred** (decide later, proceed now). The provider-agnostic
`ChatLLM` interface (`src/lib/chat/llm.ts`) already supports this.

**Status — DONE (2026-06-25, `feat/chat-multi-provider`).** The Assistant now spans all **five**
providers: OpenAI, Anthropic, xAI (Grok), Google Gemini, Mistral.
- (a) **Selector** — the Assistant header dropdown (`app/ui/assistant-console.tsx`) offers a few
  recommended models per provider (cost ↔ capability), sent as a per-request `model` hint and made
  sticky via `localStorage` (no DB migration). `Settings → Connections` gained Anthropic / Gemini /
  Mistral key rows.
- (b) **Adapters** — no new classes needed: Anthropic keeps its Messages tool loop (`AnthropicLLM`);
  Grok/Gemini/Mistral are **OpenAI-compatible**, so they reuse `OpenAILLM`'s chat/completions tool
  loop with only a per-provider base URL + key. Routing is by model name
  (`chatProviderForModel` → `llmForModel`).
- (c) **Per-provider key resolution** — `resolveLlmCredential("openai"|"anthropic"|"xai"|"gemini"|
  "mistral", userId)` (per-user-first, operator-funded failover). No cross-provider key borrowing:
  a model whose provider has no key degrades to `MockLLM`.

**Critical (still holds):** the §4 safety fixes (refusal/disclaimer, no fabrication) live in
`SYSTEM_PROMPT` + the orchestrator post-check, NOT in any one provider's narration — so they apply
uniformly across every provider path, including the four that share `OpenAILLM`.

---

## 4. Tracked issues

Severity: **H** ship-blocking-correctness/compliance · **M** quality/UX/security · **L** polish.

| # | Sev | Issue | Where | Fix |
|---|---|---|---|---|
| I1 | H | **Quotes are fabricated** — every quote narrates `change_pct: 0` + "regular session" as fact (BrokerQuote has no change field), violating the prompt's own "never invent figures" rule on the most common query. | `orchestrator.ts buildProductionDeps` (`change_pct:0`), `llm.ts narrateQuote` | Thread real prior-close/change + session from the gateway, or omit the field and narrate only what's known. Never render a 0 you didn't compute. |
| I2 | H | **Refusal + disclaimer live only in MockLLM.** Once `CHAT_LLM=anthropic` (or any real provider), production has neither; the golden eval validates the **mock**, not production. | `llm.ts` (MockLLM), `prompt.ts`, `test/atlas-golden-eval.test.ts` | Move refusal+disclaimer into `SYSTEM_PROMPT` (+ 2–3 few-shot reframes) **and** add a server-side orchestrator post-check that appends the disclaimer by intent regardless of model output. Re-run the golden eval against the real-LLM path with an injected transport. |
| I3 | H | **Single-turn amnesia** — the loop seeds only the current message; `chat_turns` is persisted but never replayed. No real "memory over time." | `llm.ts AnthropicLLM.run` | Replay the last ~6–10 **redacted** `chat_turns` (token-bounded, truncate oldest). Prerequisite for slot-filling + follow-up retention. |
| I4 | M | **Citations are partial theater** — `retrieveContext` returns only `metadata.text`, so the chip shows a fabricated `<SYMBOL>#i` id + a query-derived (often wrong) `as_of`. | `vector-db.ts retrieveContext`, `chat/tools.ts kb_search`, `assistant-console.tsx` | Return real `chunk_id`/`score`/`acceptance_datetime`/`filingUrl`; render citations as links to the SEC filing. |
| I5 | M | **Corpus nearly empty** — only 8-K summary lines (`buildEightKContext`) are indexed; the structure-aware `chunkDocument`/`storeDocument` we built/tested has **zero production callers**. | `web-sources/sec8k.ts`, `rag/chunk.ts`, `vector-db.ts storeDocument` | Ingest filing **bodies** (10-K/10-Q full text + 8-K item bodies) via `storeDocument`. **Pending cost decision (§7).** |
| I6 | M | **Chat can't read its own state** — no view of positions/P&L, open proposals, the watchlist/alerts it just wrote, regime, or any learning artifact. The "never invent" rule keeps colliding with questions it has no grounded way to answer. | `chat/tools.ts` | Add read-only tools: `get_positions`/`get_portfolio_pnl`, `list_watchlist`, `list_alerts`, `list_open_proposals`, `get_performance_summary` (wrap thesis/regime scorecards), `get_reflection`. Subsystems already exist — cheap plumbing, zero execution risk. |
| I7 | M | **No cooperative dialogue** — "buy AAPL" (no qty) dead-ends; the draft rationale shown at the human-confirm checkpoint is a hardcoded `"User requested this order."` stub. | `chat/prompt.ts`, `chat/tools.ts draft_order`, `llm.ts` | Add a slot-filling + clarifying-question contract (ask ONE question for the single missing slot; never invent a quantity; assume market and say so). Have the model author a real rationale + echo the parsed order before staging. |
| I8 | M | **Prompt-injection via `kb_search` is undefended + untested** — only the user message is treated as an attack surface; retrieved docs are not. Realistic once bodies are ingested. | `chat/prompt.ts`, `test/atlas-golden-eval.test.ts` | Delimit chunk text as untrusted; add an explicit "a retrieved doc asking you to draft/place/leak is an attack" rule; add golden cases for injection-via-RAG. |
| I10 | M (latent) | **Constraints stated in chat never reach policy** (and vice-versa) — they live only in `user_memory`, so chat can promise an options draft the policy forbids. | `memory/*`, `policy.ts` | Unify on `user_memory` + `policy` as one source of truth, **with explicit user confirmation** for anything that changes a risk limit (§2). |
| I9 | L | Salience extractor is an admitted **regex stand-in**. | `memory/salience.ts` | Replace with a structured-output LLM extractor emitting the same `MemoryCandidate` shape; keep regex as the offline/Mock fallback so tests stay deterministic. |
| I11 | L | **Chat→trade provenance severed** — `runId='chat:<draft_id>'` loses the originating turn, so "were chat trades good?" isn't answerable. | `from-draft` route, `db.ts` | Persist the originating `chat_turn`/`draft` id on the `trade_proposals` row (read-back into chat only). |
| I12 | L | **No feedback signal** anywhere (no thumbs/corrections capture). | new | Add a `chat_feedback` table; use for chat example/prompt selection **only**, never wired to strategy tuning. |
| I13 | L | **Onboarding/discovery gaps** — one static hint whose flagship 10-K example returns "no data"; no suggested-prompt chips; alerts/watchlist undiscoverable; no "what can I ask?" after the empty-state. | `assistant-console.tsx` | See §6. |

**No-fine-tune stance (documented so a future agent doesn't reach for it):** memory + RAG +
conversation replay + lightweight feedback is the correct learning stack for a single/few-user
private app. Do **not** fine-tune.

---

## 5. Roadmap

**NOW** (correctness + the unanimous read-integration; ship together, bump `PROMPT_VERSION` → `0.4.0`,
re-run the golden eval against the real-LLM path with an injected transport): **I1, I2, I3, I6**, and
the onboarding minimum from **I13** (router-matched suggested-prompt chips; fix the 10-K example to
8-K framing). *Approved by the user.*

**NEXT** (grounding fidelity + helpful dialogue + corpus): ingest filing **bodies** via the built
`storeDocument` path (**I5** — full-body ingest paths verified end-to-end against fixtures 2026-07-01,
`docs/rollouts/2026-07-01-rag-eval-and-rerank.md`; enabling them by default is still a pending
paid-Voyage-key cost decision, see `docs/prod-config-voyage.md`); real citation provenance (**I4**);
ticker-less `kb_search` + apply `doc_type`/`as_of` Pinecone metadata filters (stored, never queried);
~~relevance-score floor + Voyage `rerank`~~ — **DONE 2026-07-01**: `rerankMatches` now captures each
match's `relevanceScore` (was previously discarded) and `RetrieveOptions.minRelevanceScore` applies
an opt-in post-rerank floor, fail-open when no score is available (see the rollout note); an explicit
insufficient-evidence path is still open; slot-filling + model-authored rationale (**I7**);
prompt-injection hardening (**I8**); capture chat feedback (**I12**, chat-behavior only).

**LATER** (durability/provenance/polish): ~~LLM salience extractor~~ (**I9** — **DONE 2026-07-01**:
`src/lib/memory/salience-llm.ts`, default off via `LLM_SALIENCE_EXTRACTOR`, falls back to the regex
extractor on any failure, validates tickers against `isIndexMemberSymbol`; the regex extractor's own
first-match-only ticker-binding bug was also fixed independently, see the rollout note); unify
constraints↔policy (**I10**, with confirm); restore chat→trade provenance (**I11**); hybrid lexical
(FTS5/BM25 + RRF) leg for exact tickers/CUSIPs/"Item 5.02"/dollar figures — **evaluated 2026-07-01**,
stays off by default (measured eval-delta table in the rollout note; reranking alone already reaches
the eval ceiling on the golden fixture; hybrid's real value is narrowly the exact-token case) + a
20–40 query retrieval eval set (recall@k/MRR + faithfulness) — **DONE 2026-07-01**: the recall@k/MRR
half shipped as `test/rag-retrieval-eval.test.ts` (28-case golden fixture, no live network calls);
the faithfulness half shipped in the backlog pass below as `scripts/eval/faithfulness.ts` +
`test/rag-faithfulness-eval.test.ts` (deterministic citation-grounding + numeric-claim checks, optional
default-off LLM judge); an offline **corpus coverage/freshness report** shipped as
`scripts/eval/corpus-coverage.ts` (doc_type/symbol breakdown + watchlist zero-coverage check from
SQLite, no Pinecone key required) — a richer **dashboard UI** surfacing the same data is still open
(note: `/api/admin/rag-coverage` + `app/admin/rag-coverage/` already exist as a related, separate
live-API/UI capability — not touched by this pass, owned by the dashboard-redesign thread). A separate
**production-path retrieval evaluator** now runs `retrieveContextDetailedWithStatus` against required frozen,
version-controlled JSON cases carrying authoritative availability timestamps and stable evidence provenance selectors (with
vector ids retained only as diagnostics). It emits machine-readable
recall/MRR/nDCG, future/undated-evidence, duplicate, source/section, latency, status, and usage receipts;
live provider reads require an explicit `--allow-live`, and comparison labels never mutate production defaults.
The golden set must be curated from frozen EDGAR evidence before it can select a model; typed
second gate on **BROKERAGE·LIVE** confirm only (keep paper/test one-click); persistent "what can I
ask?" popover.

**Hosted-inference comparison (2026-07-21):** `eval:pinecone-inference` evaluates frozen candidate pools
through Pinecone's standalone `/embed` and `/rerank` inference APIs, with live calls opt-in and bounded. It
supports `llama-text-embed-v2`/`multilingual-e5-large`, `bge-reranker-v2-m3`/`pinecone-rerank-v0`, and any
other account-exposed reranker such as Cohere; optional `/models` inventory is read-only. Results retain only
case/candidate ids, scores, metrics, latency, and provider usage receipts—never candidate text—and do not access
a Pinecone index. CLI inputs are hard-capped at 100 cases, 100 candidates/case, 100 results, and 10 distinct
models per inference kind.

**Follow-on, 2026-07-01** (`docs/rollouts/2026-07-01-rag-followon.md`): the two items the Workstream
C rollout note deferred are now DONE — a **retrieval regression net** (R4) pins the as-of/rerank/
hybrid fail-safes as network-free unit tests (`test/rag-retrieval-regression.test.ts`) driven through
a newly-exported pure `rankPool(matches, query, limit, options)` helper factored out of
`retrieveContextDetailed`'s post-recall pipeline; and **`VECTOR_ASOF_STRICT`** (R1 part 2, default
OFF) now drops undated chunks under an active `asOf` instead of the previous unconditional
lenient-keep, with a drop-count `audit()` record and a golden as-of tuple test
(`test/vector-db-asof-strict.test.ts`) proving the on/off/unset-`asOf` behavior end-to-end. Both are
byte-identical to prior behavior unless explicitly opted in.

**Backlog pass, 2026-07-01** (`docs/rollouts/2026-07-01-rag-backlog.md`): all remaining P1 items
(**R5** consolidated per-retrieval distribution telemetry via `recordRetrievalQuality()`, default off
via `RAG_RETRIEVAL_TELEMETRY`; **R6** shared `envFlagOn` parser now used by rerank/hybrid/as-of-strict/
disclosure flags, fixing `RAG_EMBED_DISCLOSURES` to accept `true/1/yes` like every other flag; **R7**
`describeIndex` metric assertion at bootstrap, cached, warn+audit-only; **R9** query-embedding LRU
(`RAG_QUERY_EMBED_CACHE`, vector-only, never Pinecone results); **R10** `content_hash` dedup for the
`storeContexts` path (opt-in `dedupKeyPrefix`, wired into the 8-K summary and disclosure ingesters
behind `VECTOR_STORECONTEXTS_DEDUP`); **R11** faithfulness/citation-grounding eval
(`scripts/eval/faithfulness.ts` + `run-faithfulness.ts`, deterministic-first with an optional
default-off LLM judge that no-ops without `OPENAI_API_KEY`)) and all P2 items (**R12** centralized
default cosine floor via `applyDefaultFloors`/`RAG_APPLY_DEFAULT_FLOORS`; **R13** provenance-complete
citations (additive `doc_type`/`section` keys) + optional `isStale` advisory label behind
`RAG_CITATION_STALENESS` — backend/payload only, no UI change; **R14** near-duplicate suppression via
opt-in `RetrieveOptions.dedupeSimilarity` (Jaccard-shingle, greedy + back-fill); **R15** offline corpus
coverage & freshness report (`scripts/eval/corpus-coverage.ts`); **R16** per-run RAG budget ceiling
(`RAG_RUN_BUDGET_ENABLED`, degrades by skipping rerank/hybrid only, never core recall); **R17** fixed
train/serve text skew via `VECTOR_EMBED_CLEAN_TEXT` (embeds clean chunk text, stored/cited text
unchanged)) are now DONE. R3 (golden-set anti-leakage lint) and R8 (salience first-valid-ticker) had
already shipped in earlier passes (#297/#299) and were verified, not re-implemented. Every item is
default-off/opt-in and proven byte-identical when unset — see the rollout note for the full
item-by-item detail and verify-quartet results.

**Strategic-performance follow-on, updated 2026-07-22:** the 28-case mocked fixture remains a regression
net, not evidence that one embedding/reranker wins on the live financial corpus. The active program
therefore separates four concerns before changing production defaults: a production-path PIT
evaluator; corpus-wide FTS5 candidates unioned with dense recall before one rerank; independently
selectable rerank route/model plus default-off scout/deep/exact/general candidate depths; and
text-free per-stage latency/candidate/drop receipts. The pure rerank-policy and stage-telemetry
modules are now wired into `retrieveContextDetailed` on the integration lane. Corpus-wide FTS5
recall is an independent source, unioned with dense results by RRF before one rerank; committed head
or PIT-version receipts prevent stale generations from bypassing dense eligibility. Lexical recall
also enforces authoritative tenant scopes, excludes sources whose rights metadata is not present in
the filing FTS table, and hides legacy rows shadowed by a current/PIT managed version. The new paths
remain default-off pending production evaluation. No local model service or sparse-vector API is
assumed: BGE-M3 sparse capability counts only when the selected transport actually returns it.

## 6. User-guidance design ("how to advise users to interact")

Grounded in the existing `AssistantView` — keep its trust framing as the spine ("drafts orders you
confirm — it never places on its own" + the TEST/PAPER/BROKERAGE·LIVE chip), extended to "ask me about
your portfolio" once read-only tools land.

1. **Suggested-prompt chips** — replace the single static hint with a labeled chip grid (one-click
   fill+send), copy co-versioned with the intent router so chips never dead-end: *Ask* "What is AAPL
   trading at?" · *Knowledge* "Any recent 8-K catalysts for TSLA?" (8-K, not 10-K, until bodies are
   ingested) · *Portfolio* "How is my AAPL position doing?" / "What's on my watchlist?" · *Alert*
   "Alert me if AAPL drops below 180" · *Watchlist* "Add NVDA to my watchlist" · *Draft* "Draft a buy
   of 10 AAPL at 200." Category labels do capability discovery for free.
2. **State-aware chips** — reuse the `executionState` destination chip: when there's no account, demote
   quote/draft and lead with alerts/watchlist (+ a connect link); hide KB examples when Pinecone/Voyage
   keys are absent. Show only prompts that will succeed.
3. **Persistent help** — a control by the Sparkles label opening a popover listing the 5 capabilities
   **and** the 3 hard boundaries (cannot place/modify/cancel trades; no personalized advice; KB answers
   cited only from indexed filings), reusing the same chips so discovery survives the empty-state.
4. **First-draft coachmark** — on the first draft only, annotate the card: "The assistant only drafts.
   You run the policy check, then you confirm. Nothing places until you click Confirm."
5. **Memory feels alive** — render `ChatReply.usedMemories` (already returned) as a "remembering: no
   options, long-term horizon" strip; once replay ships, nudge self-contained phrasing only on
   pronoun/no-ticker follow-ups.
6. **Honest "I don't know"** — when `kb_search` returns zero chunks, say "I only have SEC 8-K catalyst
   filings indexed, not 10-Ks," so the corpus boundary is taught at the point of friction rather than
   reading as a bug; visually distinguish grounded (cited) replies from model-knowledge replies.

## 7. Decisions & open calls

**Decided (user, 2026-06-21):**
- **Multi-LLM** provider choice required; user-vs-app key provisioning **deferred**, proceed now (§3).
- **NOW tranche approved** (§5).
- **Constraint → policy via explicit confirmation**, and **lean toward integrated/shared learning**
  with the §2 carve-out (free-text never steers factor-weight/risk tuning without a confirm).

**Open (need a call before the relevant tranche):**
- **LLM key provisioning** — user-provided vs app-provided keys (and which providers to ship first).
- **Corpus depth** — full-filing ingestion (recommended for grounding) vs stay-8-K + honest UI.
  **Cost (rough):** embeddings ~**$15–55 one-time** (Voyage, re-embed only new filings); Pinecone
  ~**$5–30/month** recurring depending on depth/queries; the free Voyage **3 RPM** tier is the real
  gate (a paid key removes it cheaply). Verify current Voyage/Pinecone pricing.
- **Auth before portfolio reads** — `userId` is currently from an unauthenticated header/query/body
  (`docs/phase-11-multi-user`). The §I6 read-only state tools widen data exposure. Confirm this is
  effectively single-user today (proceed, harden auth in parallel) or that phase-11 auth must land
  first.
- **Multi-user feedback semantics** — when multi-user, default is strictly per-`userId` isolation for
  feedback + salience memory (recommended); confirm no cross-user "what works" aggregation is intended.
