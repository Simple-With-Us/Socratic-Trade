# Deep Dive 8 — Cache, Embeddings & Memory

> Expert panel deep-dive expanding §8 of the [Multi-Expert App Analysis](../multi-expert-app-analysis.md). Three layers — embedding economics, LLM caching, and multi-tier agent memory — all gated by one hard rule: **never serve stale market or account data.** Current Claude models referenced: Opus 4.8 (`claude-opus-4-8`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5`).

---

#### 8.1 Embedding Models, Dimensions & Vector Economics

> The model and how you measure it dominate everything; caching and metric hygiene are cheaper to fix but cause silent, hard-to-debug recall loss.

##### 1. Choosing an embedding model (highest leverage)

The only way to choose is to **measure recall@k on your own finance queries**. MTEB leaderboards are a *starting filter* — they're dominated by generic retrieval and overfit by submissions; your queries ("what was NVDA's gross-margin guidance last call?", "is my SPY position over-concentrated?") look nothing like MTEB.

Build a **golden set** of 100–300 real queries, each with the chunk(s) that *should* be retrieved, then measure:

```python
def recall_at_k(golden, retrieve, k=10):
    hits = 0
    for q, relevant_ids in golden:
        got = {c.id for c in retrieve(q, k)}
        hits += len(got & relevant_ids) > 0
    return hits / len(golden)

for name, embed in candidates.items():
    print(name, recall_at_k(golden, build_retriever(embed)))  # same set, same chunker, same k
```

Decision axes by priority:
- **General vs finance-tuned.** Finance vocab is adversarial ("call" = option vs earnings call; "short", "yield", "bps", tickers). A finance-adapted model often wins on jargon, but a strong general model with good instruction handling frequently matches it — *measure*. Cheap middle path: keep a general model and lean on a finance-aware reranker.
- **API vs self-hosted.** API = zero ops, instantly current, but per-token cost at scale, rate limits, latency, data-egress/compliance concerns, and the provider can silently change the model (pin versions). Self-hosted = fixed cost amortizes at high volume, data stays in-VPC (matters for financial PII/MNPI), full version control, at the price of GPU ops. Prototype on API; move the high-volume passage-embedding path self-hosted once you embed millions of chunks/month.
- **Asymmetric (instruction-prefixed) encoding.** Modern retrieval models encode queries and passages differently and gain meaningfully from instruction prefixes:

```python
QUERY_PREFIX   = "Represent this finance question for retrieving relevant filings and notes: "
PASSAGE_PREFIX = "Represent this finance document for retrieval: "
def embed_query(q):     return model.encode(QUERY_PREFIX + q,     normalize=True)
def embed_passage(txt): return model.encode(PASSAGE_PREFIX + txt, normalize=True)
```

Critical: query and passage must be encoded by the **same model+version into the same space**. Asymmetric ≠ different models.

##### 2. Dimensions & cost (Matryoshka + quantization)

Two orthogonal levers cut storage/compute dramatically with small recall loss, *if* you keep a full-precision rerank pass.

- **Matryoshka (MRL) truncation.** MRL-trained models pack most information into leading dimensions. **Store the full vector** (exact rerank), **search at a reduced dimension**:
  ```python
  import numpy as np
  def truncate(v, d):                  # v full-dim, L2-normalized
      t = v[:d]
      return t / np.linalg.norm(t)     # MUST re-normalize after truncation
  ```
- **Quantization.** int8 (~4× smaller, <1–2% recall loss) or binary (~32× smaller, Hamming distance, 5–15% drop) for the index; rerank the shortlist with full-precision.

Rough economics (1536-d, illustrative — measure yours):

| Representation | Bytes/vector | 10M vectors | Relative recall (w/ FP rerank) |
|---|---:|---:|---|
| fp32, full dim | ~6.1 KB | ~61 GB | 1.00 |
| fp32, MRL 256-d | ~1.0 KB | ~10 GB | ~0.97–0.99 |
| int8, MRL 256-d | 256 B | ~2.6 GB | ~0.96–0.98 |
| binary, full dim | 192 B | ~1.9 GB | ~0.95–0.98 *after rerank* |

The winning pattern: **cheap compressed first stage → exact full-precision rerank on a small shortlist** (you pay FP cost on ~100 vectors/query, not 10M):

```python
shortlist = ann.search(truncate(embed_query(q), 256), k=200)   # cheap
reranked  = sorted(shortlist, key=lambda c: dot(full_vecs[c.id], embed_query(q)), reverse=True)
return reranked[:10]                                           # exact
```

##### 3. Versioning & re-embedding discipline

Vectors are only comparable within one model+version. Treat the embedding model as a **schema** you migrate.

- **Pin `model_id` + `version` (+ prefix/dim/metric) on every vector.**
  ```python
  record = {"chunk_id": chunk_id, "text_hash": sha256(normalize(text)),
            "model_id": "fin-embed", "model_version": "2026-04-01",
            "dim": 1536, "prefix": "passage-v2", "vector": vec}
  ```
- **Re-embed only when the model OR content changes** (hash normalized chunk text; embedding is pure and cacheable).
- **Migration = dual-write / shadow index.** Never re-embed in place: stand up a new index, backfill, shadow-read (query both, compare on golden set), then cut over.
- **NEVER compare vectors across models/versions** — not for search, dedupe, or clustering. Mixed-space indexes are the most common silent corruption; the version pin makes it impossible.

##### 4. Embedding cache & dedupe

Embedding is deterministic, so most calls are avoidable.

```python
def cache_key(text, mv):  # normalize first so trivial variants collide
    return sha256((normalize(text) + "|" + mv).encode()).hexdigest()

def embed_cached(text, mv):
    k = cache_key(text, mv)
    if (v := cache.get(k)) is not None: return v
    v = embed_passage(text); cache.set(k, v); return v
```

- **Cross-user / cross-document dedupe.** The same SEC boilerplate recurs across thousands of filings — embed once, reference many.
- **Batch + coalesce in-flight duplicates** so a popular chunk isn't embedded N times in parallel:
  ```python
  async def embed_coalesced(text, mv):
      k = cache_key(text, mv)
      if k in inflight: return await inflight[k]
      fut = inflight[k] = loop.create_future()
      try:
          v = await batched_embed(text, mv); fut.set_result(v)
      finally:
          inflight.pop(k, None)
      return v
  ```
- **Near-duplicate dedupe before insert** (cosine ≥ 0.98 to an existing vector) so the index doesn't bloat with restated boilerplate (bloat hurts cost *and* ranking).

##### 5. Practical pitfalls (cheap to avoid, expensive to debug)

- **Mixing vector spaces** — querying a v3 index with a v2 vector. Symptom: recall quietly degrades, no error. Guard: assert `model_version`/`dim`/`prefix` match at query time.
- **Embedding boilerplate** — disclaimers/nav/headers embed to a dense cluster that dominates retrieval. Strip before embedding.
- **Wrong distance metric** — cosine vs dot vs L2 must match how the model was trained; most retrieval models expect cosine, some dot (don't normalize those).
- **Not normalizing (when you should)** — especially after MRL truncation. Normalize exactly once, consistently, on both query and passage.
- **Domain drift** — schedule periodic re-evaluation of recall@k on a refreshed golden set and alert on drops. Drift is gradual and invisible without the harness from §1.

---

#### 8.2 Prompt Caching, Semantic Caching & Memoization

Three layers, ordered by impact. **Prompt caching** cuts input cost ~90% per call and is nearly free. **Semantic response caching** skips the model on repeat questions. **Tool/computation memoization** skips deterministic recompute. All gated by one rule: never serve stale market/account data.

##### 8.2.1 Anthropic Prompt Caching (`cache_control: ephemeral`) — highest impact

Prompt caching is a **prefix match**: the API hashes the rendered prompt up to each `cache_control` breakpoint and reuses it on the next request with a byte-identical prefix. Render order is `tools` → `system` → `messages`. The design rule: **order context most-static-first, keep volatile market data in the uncached suffix.**

```
[tools]    tool schemas (quote lookup, place_order, run_backtest, DCF) ── stable
[system]   system prompt + compliance boilerplate                       ── stable
[system]   few-shot exemplars                                            ── stable
[messages] slow-moving user profile (risk tolerance, holdings summary)   ── per-session
─────────────── cache_control breakpoint here ───────────────
[messages] live quotes, positions, order status, "as of 14:32:05 ET"    ── UNCACHED
[messages] the user's current question                                   ── per-turn
```

```python
resp = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=TOOL_SCHEMAS,                       # rendered first — sort deterministically
    system=[
        {"type": "text", "text": SYSTEM_PROMPT + COMPLIANCE_BOILERPLATE},
        {"type": "text", "text": FEW_SHOT_EXEMPLARS,
         "cache_control": {"type": "ephemeral"}},   # caches tools + system together
    ],
    messages=[
        {"role": "user", "content": [
            {"type": "text", "text": user_profile_blob,
             "cache_control": {"type": "ephemeral", "ttl": "1h"}}]},   # 1h: high reuse
        {"role": "user", "content": [                                  # UNCACHED suffix
            {"type": "text", "text": f"Live snapshot as of {ts}: {live_quotes_json}"},
            {"type": "text", "text": user_question}]},
    ],
)
```

**TTL choice.** Default ephemeral TTL **5 minutes** (write ~1.25× base input). A **1-hour** TTL (`"ttl": "1h"`, write ~2×) for content reused across longer gaps. Break-even: 5-min cache pays off at ~2 requests; 1-hour needs ~3+ reads. Use 1h only for bursty traffic with idle gaps.

**Savings & measurement.** Cache reads cost ~0.1× base input (~90% off the cached portion) and lower TTFT. Measure via `usage`:

| Field | Meaning |
|---|---|
| `cache_creation_input_tokens` | written this call (paid ~1.25×/2×) |
| `cache_read_input_tokens` | served from cache (paid ~0.1×) |
| `input_tokens` | uncached remainder (full price) — the volatile suffix |

If `cache_read_input_tokens` is 0 across repeated identical-prefix requests, a silent invalidator is breaking the prefix. Track hit ratio `cache_read / (cache_read + input_tokens)`.

> Minimum cacheable prefix is model-dependent (Opus 4.8 / Haiku 4.5 need ≥4096 tokens; Sonnet 4.6 ≥2048); a shorter prefix silently won't cache. Max 4 breakpoints per request.

##### 8.2.2 The cardinal freshness rule

**Never cache live quotes, positions, order status, balances, or fills — at any layer.** They live only in the uncached suffix, are never keys/values in the semantic cache, and every cacheable item is tagged with a volatility class + TTL:

| Volatility class | Examples | Prompt-cache? | Response-cache TTL |
|---|---|---|---|
| `static` | system prompt, tool schemas, disclosures, definitions | yes (1h) | days |
| `slow` | user risk profile, watchlist, company fundamentals | yes (1h/5m) | hours |
| `eod` | prior-day close, daily indicators, completed backtests | suffix only | until next close |
| `live` | quotes, positions, order status, balances, intraday bars | **never** | **never** |

A request touching a `live` field bypasses every response-cache layer and goes fresh.

##### 8.2.3 Semantic response cache

Serve a prior answer when a new query is close enough — but only for freshness-safe intents. **Two-tier: exact-hash L1, semantic L2.**

```python
def answer(query, intent, freshness):
    if freshness == "live":
        return call_model_fresh(query)            # live data never touches the cache
    key = normalize_key(query, intent)             # canonicalize before hashing/embedding
    if (hit := L1.get(key)) is not None: return hit
    qvec = embed(normalize(query))
    cand, score = ann_index.nearest(qvec, intent_filter=intent)
    if cand and score >= THRESHOLDS[intent] and not_expired(cand, freshness):
        L1.set(key, cand.answer); return cand.answer
    ans = call_model_fresh(query)
    store(key, qvec, ans, intent, ttl=TTL[freshness]); return ans
```

- **Normalize the key** — canonicalize tickers (`$AAPL`, `apple` → `AAPL`), lowercase, strip punctuation, and **resolve relative dates** ("today" → absolute, part of the key).
- **Cosine threshold ~0.92–0.95, tuned per intent.** Definitional intents tolerate lower; numeric/account-specific need high or no semantic caching.
- **Gate strictly by freshness class**; the ANN filter and expiry check run *after* the freshness gate.
- **Scope keys by user** where answers are personalized, or you leak one user's answer to another.

##### 8.2.4 Tool / computation memoization

Deterministic analytics are pure functions of inputs **as of a point in time** — memoize by `(function, inputs, as-of timestamp)`:

```python
@memoize(ttl=until_market_close)
def technical_indicator(ticker, indicator, params, as_of): ...   # RSI/MACD on closed bars
@memoize(ttl="7d")
def dcf_valuation(ticker, assumptions, fundamentals_asof): ...
@memoize(ttl="30d")
def backtest(strategy, universe, start, end, params): ...        # historical → near-immutable
```

The **as-of timestamp is part of the key** — `RSI(AAPL, 14, as_of=2026-06-18-close)` is immutable/long-TTL, while `as_of=intraday-live` is a different key that shouldn't be cached. Pin to a data snapshot/version so a revised feed produces a new key rather than a stale hit.

##### 8.2.5 Observability & degradation

**First-class metrics:** prompt-cache hit ratio (alert on drops); semantic-cache hit rate + false-hit rate (sampled audit, per intent); cost-per-conversation (decompose into model in/out, cache reads/writes, tool calls); TTFT with/without cache hits.

**Keep work off the hot path:** precompute the profile prefix + its embedding on profile change; precompute common query embeddings; pre-warm the prompt cache at session start with a `max_tokens: 0` request.

**Degradation tiers under budget pressure:** (1) raise semantic-cache aggressiveness on `static`/`slow`; (2) route those intents to **Haiku 4.5**; (3) drop few-shot exemplars; (4) shed optional enrichment. Never degrade by serving stale `live` data.

##### 8.2.6 Pitfalls

- **Caching volatile data** — the cardinal sin. Enforce the freshness class at the gate, not by convention.
- **Prefix invalidation** — a `datetime.now()`, session ID, or UUID interpolated into the *system prompt* changes the prefix and zeroes the cache. Keep the system prompt frozen; inject "current time"/session state into the uncached suffix. Serialize tool schemas deterministically (`sort_keys=True`); never swap tools/models mid-session.
- **Serving stale cached answers** — bind absolute dates into keys; expire by freshness class.
- **Semantic false hits** — "P/E of AAPL" vs "P/E of MSFT" if the ticker wasn't normalized into the key. Mitigate with entity normalization, per-intent thresholds, user-scoped keys, and a sampled audit of near-threshold hits.

---

#### 8.3 Multi-Tier Memory Architecture

Treat "memory" as four independent subsystems, each with its own store, write policy, and retrieval policy. They stay physically separate at rest and are **merged only at prompt-assembly time** — so you can cache the stable parts, evict the volatile parts on different schedules, audit writes per tier, and reason about cost.

| Tier | Store / namespace | Retrieval | TTL / write | Volatility |
|---|---|---|---|---|
| 1. Short-term conversation | Per-session KV / Redis | Last-N verbatim + rolling summary | TTL ~session; written every turn | Highest |
| 2. Long-term profile | Row/doc DB | Whole record, always | Persistent; **explicit** writes only | Lowest |
| 3. Episodic decisions | Vector DB + metadata | Hybrid: metadata filter ∩ semantic top-k | Persistent; append-only | Low (append) |
| 4. Semantic KB (RAG) | Vector DB | Semantic top-k, reranked | Refreshed on ingest; shared | Static-ish |

##### Tier 2 — Long-term user profile (highest leverage, lowest volatility)

A compact, structured, slowly-changing record. Small, almost always relevant, and because it rarely changes it belongs in the **cached prompt prefix**. Write only on an explicit signal (stated preference, onboarding, confirmed change) — don't re-derive from conversation every message.

```jsonc
{
  "user_id": "u_8831", "risk_tolerance": "moderate", "time_horizon_years": 7,
  "objectives": ["retirement","income"], "watchlist": ["AAPL","MSFT","VTI"],
  "sectors_focus": ["tech","healthcare"],
  "constraints": {"no_options": true, "no_leverage": true, "max_position_pct": 5},
  "tax": {"account": "taxable", "lot_method": "SpecID", "harvest_losses": true},
  "schema_version": 3, "updated_at": "2026-05-02T14:11:00Z"
}
```

Keep it under a few hundred tokens; version the schema; carry `updated_at` so you know when the cache prefix must rebuild. Constraints are **hard rules** — surface them as imperative text at assembly, not just JSON.

##### Tier 3 — Episodic trade / decision history

The differentiator: a log of **what was decided, why, and what happened**, retrievable **two ways** — exact metadata filter ("all SELL on NVDA in Q1") *and* semantic similarity ("times we trimmed a winner into earnings").

```jsonc
{
  "event_id": "ev_4521", "ts": "2026-03-14T15:32:00Z", "instrument": "NVDA",
  "asset_class": "equity", "action": "TRIM",
  "size": {"shares": 40, "pct_of_position": 25},
  "rationale": "Trimmed 25% into earnings to de-risk; valuation stretched vs. peers.",
  "market_context": {"spx": 5123, "vix": 18.2, "regime": "risk-on"},
  "embedding": [/* vector of rationale + context */], "outcome": null,
  "links": {"session_id": "sess_77", "advice_msg_id": "m_1290"}
}
```

**Linking decisions to realized outcomes** turns a log into learning — write with `outcome: null`, back-fill once known:

```jsonc
"outcome": {"realized_at": "2026-04-11T20:00:00Z", "horizon_days": 28,
            "pnl_pct": 12.4, "vs_benchmark_pct": 4.1, "label": "good_call",
            "note": "Stock dropped 9% post-earnings; trim avoided drawdown."}
```

Hybrid retrieval (metadata pre-filter, then vector search):

```python
def recall_episodes(user_id, query_text, *, instrument=None, action=None, k=5):
    flt = {"user_id": user_id}
    if instrument: flt["instrument"] = instrument
    if action:     flt["action"] = action
    return vectordb.query(namespace=f"episodic:{user_id}", vector=embed(query_text),
                          filter=flt, top_k=k, rerank=True)
```

##### Tier 1 — Short-term conversation

Keep the most recent turns **verbatim**; for older turns **summarize-and-compact rather than truncate**, explicitly preserving decisions, constraints, numbers, and open commitments.

```jsonc
{
  "recent_turns": [/* last N message objects, verbatim */],
  "rolling_summary": "User wants to rotate 10% from cash into dividend equities; ruled out REITs; avoid energy. Pending: VYM or SCHD.",
  "pinned_facts": ["budget = $25k", "no energy", "taxable account"],
  "token_estimate": 2870
}
```

Set a per-turn budget (~3–4k tokens); over budget → fold oldest verbatim turns into `rolling_summary` (summarize, don't drop). `pinned_facts` are constraints lifted out of the dialog so they survive any compaction.

##### Tier 4 — Semantic knowledge (the RAG KB)

Shared, mostly-static reference content (definitions, regs, methodology), namespaced by corpus and versioned by ingest — **not per-user**. Standard chunk → embed → top-k + reranker; always carry `source`/`as_of` for citation and staleness filtering.

##### Blending the tiers + assembly order

Fetch in parallel: full profile (T2), relevant episodes via hybrid recall (T3), top-k KB chunks (T4), recent conversation + summary (T1). Assemble **static→volatile** so the stable prefix can be prompt-cached:

```text
┌─ CACHED PREFIX (stable across turns) ─────────────────┐
│ 1. System role + hard rules                           │
│ 2. User profile (T2) ← rebuild only on profile write  │
├─ VOLATILE SUFFIX (rebuilt each turn) ─────────────────┤
│ 3. Retrieved KB chunks (T4) — with citations          │
│ 4. Retrieved episodes (T3) — graded precedent         │
│ 5. Rolling summary + pinned facts (T1)                │
│ 6. Recent verbatim turns (T1)                         │
│ 7. Current user message                               │
└───────────────────────────────────────────────────────┘
```

Put the model's hard constraints first and last (profile constraints in the prefix, current message at the end) so they bracket the retrieved material. Keep the merge logic in one assembler function — the single point where the four namespaces meet.

---

#### 8.4 Memory Lifecycle, Personalization & Invalidation

Memory is leverage only when it stays *true*, *small*, and *retrievable for the right reason*. Get the write path and reconciliation right first; everything downstream inherits their correctness.

##### 8.4.1 Write policy — extract, don't transcribe

Run a cheap **memory-extraction pass** that proposes *candidate* memories tagged with type + durability. Stable preferences get written; one-off task params do not.

```python
EXTRACTION_SCHEMA = {
  "kind": "preference | fact | episodic | none", "subject": "risk | sectors | horizon | tax | position | ...",
  "value": "free text or normalized enum", "durability": "stable | situational | one_off",
  "confidence": 0.0, "evidence": "verbatim span"}

def extract_memories(turn):
    out = cheap_llm(EXTRACTION_PROMPT, turn, schema=EXTRACTION_SCHEMA)
    return [c for c in out if c.kind != "none" and c.durability != "one_off" and c.confidence >= 0.6]
```

"Sell 50 NVDA today" is `one_off`; "I never want to hold biotech" is `stable`; "nervous about my Tesla position this week" is `situational` (episodic, short TTL). **When in doubt, hold** — a missing memory is recoverable; a wrong one corrupts every future recommendation.

##### 8.4.2 Reconcile on write — upsert, never blind-append

The most damaging bug is *contradiction accumulation* (storing "conservative" and "aggressive" side by side). Treat memory as a **versioned KV keyed by `(user, subject)`**; on contradiction, **supersede** rather than coexist.

```python
def upsert_memory(user, cand):
    prior = store.get(user, cand.subject)
    if prior is None: return store.insert(new_record(cand, version=1))
    rel = classify(prior.value, cand.value)          # SAME | REFINES | CONTRADICTS
    if rel == "SAME":
        store.bump_last_seen(prior.id)
    else:
        store.supersede(prior.id, reason=rel, at=now())
        store.insert(new_record(cand, version=prior.version + 1, supersedes=prior.id))
```

Hard triggers that must force supersession: risk tolerance changed; position closed/opened (reconcile holdings against the broker of record); goal/horizon shift. Keep superseded rows for audit; exclude from default retrieval.

##### 8.4.3 Forget policy — TTL, decay, explicit deletion

```python
def handle_forget(user, referent):
    targets = resolve_referent(user, referent)
    store.hard_delete(targets)
    vector_index.delete([t.embedding_id for t in targets])
    audit.log("forget", user, targets, actor=user, at=now())
    return f"Deleted {len(targets)} item(s). They won't influence future advice."

def recency_weight(age_days, half_life):     # applied at retrieval, not stored
    return 0.5 ** (age_days / half_life)      # episodic: short; preference: ∞
```

TTL + decay for episodic; archive/summarize stale conversation memory; **hard-delete** on user request and for PII/compliance (real delete + tombstone, propagated to backups and the vector index); treat "forget this" as a first-class command.

##### 8.4.4 Periodic compaction — episodic → patterns

Compact clusters of episodic items into higher-level, signal-dense patterns, then retire the raw episodes:

```python
def compact(user):
    for cluster in cluster_episodes(user, by="behavior"):
        if len(cluster) >= MIN_SUPPORT:
            pattern = summarize_pattern(cluster)              # incl. support count
            store.insert(pattern, kind="derived_pattern", evidence_ids=[e.id for e in cluster])
            store.archive(cluster)                            # drop raw, keep summary
```

Good patterns are behavior-anchored: *"trims winners early (avg +4%), often ahead of catalysts," "prefers large-cap tech," "panic-sells on >5% intraday drops."* Keep support count + evidence links so a pattern can be re-evaluated if behavior changes.

##### 8.4.5 Retrieval ranking — importance × recency × relevance

Similarity-only retrieval returns the most *semantically* similar memory, often not the most *useful*. Use generative-agents scoring:

```python
def memory_score(m, query, now, w=(1.0, 1.0, 1.0)):
    relevance  = cosine(embed(query), m.embedding)
    recency    = recency_weight((now - m.last_seen).days, m.half_life)
    importance = m.importance
    wi, wr, wv = w
    return wi*importance + wr*recency + wv*relevance
```

More important than the formula: **retrieve analogous past decisions** ("last 3 times you held through earnings, you regretted it") and **personalize the ranking** by profile + history (weights and `importance` priors are per-user, learned from which retrieved memories actually changed an outcome).

##### 8.4.6 Staleness & invalidation for market data

Personal preferences age in months; a quote ages in seconds. Tier TTLs by **velocity**, invalidate on **events**, and never let either leak into a cached prefix.

```python
TTL = {"tick_quote": 2, "intraday_bar": 60, "fundamentals": 86_400,
       "corporate_action": 0, "user_preference": None}   # seconds; None = supersession-only

INVALIDATION_EVENTS = {
  "order_fill": ["positions","buying_power","pnl"], "price_band_breach": ["quote","alerts"],
  "earnings_release": ["fundamentals","estimates","quote"],
  "corporate_action": ["positions","cost_basis","quote"]}

def on_event(evt):
    for ns in INVALIDATION_EVENTS.get(evt.type, []):
        cache.invalidate(evt.symbol, ns)
```

Two non-negotiables: **always stamp injected context with `as_of`** (the model surfaces it: *"NVDA $X (as of 14:32:05 ET, 18m stale)"*), and **keep volatile data out of the cached prefix** (quotes/positions go in the uncached tail).

##### 8.4.7 Privacy & compliance

Financial memory is regulated data. Tag PII; prefer storing references (account *id*) over raw values; never extract SSNs/full account/card numbers. Encrypt at rest (field-level PII, KMS keys) and in transit; per-user key derivation. Support user-initiated **export** (machine-readable dump) and **delete** (hard-delete across primary store, vector index, backups, derived patterns) within your regulatory SLA. Log every write/supersede/delete/export immutably.

```python
def export_user_data(user):   # DSAR portability
    return {"memories": store.all(user, include_superseded=True),
            "patterns": store.derived(user), "audit": audit.for_user(user)}

def erase_user(user):         # DSAR erasure
    ids = store.all_ids(user)
    store.hard_delete(ids); vector_index.delete_user(user)
    backups.schedule_purge(user); crypto.destroy_user_key(user)
    audit.log("erase", user, ids, actor="dsar", at=now())   # audit survives
```

**Rule of thumb:** a memory you can't *explain* (audit), *correct* (supersede), *time-bound* (TTL/as-of), and *delete* (DSAR) is a liability, not a feature.
