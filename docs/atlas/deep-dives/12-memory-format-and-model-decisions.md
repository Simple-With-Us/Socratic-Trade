# Deep Dive 12 — Memory, LLM Format & Model Governance (Debates + Decisions)

> A focused expert panel on the questions the product owner flagged as central: **what to remember, how to abbreviate it, and how to organize it** (the heart of the product), plus **which structure/format the LLM should use**, **whether/how the model changes over time and who controls it**, and **which model is best for which job**. Memory gets the most weight. Current Claude models: Opus 4.8, Sonnet 4.6, Haiku 4.5, Fable 5.

---

## Synthesis (read this first)

The panel debated memory hard and converged on a **"remember richly, retrieve precisely, decay aggressively"** position:

- **Remember the user's *purposes and constraints*, re-derive their *state*.** Durable things — hard constraints, goals, decisions + rationale, realized outcomes, behavioral patterns, corrections — are the product's edge and should be captured structurally. Live state (positions, balances, buying power, order status) is **never** remembered; the broker is source of truth and you fetch it. This resolves the maximalist/minimalist debate: they disagree on *what* to remember, and both agree on the failure modes (drift, contradiction, privacy, retrieval noise).
- **What to remember** is a salience-gated write decision (default: forget) that distinguishes durable/decision-relevant signals from one-off task params, with a feedback loop that archives memories that never improved an answer.
- **How to abbreviate** is a per-fact lossy-vs-lossless decision: constraints and numbers are lossless and structured; narrative is lossy prose. Compaction operates on a canonical structured core, references but never rewrites the lossless facts, and re-derives from source to avoid summary drift.
- **How to organize** is a hybrid on one Postgres+pgvector instance: a typed relational/light-graph core for entities (User, Constraint, Decision, Thesis, Outcome, Pattern…) + vectors for semantic recall, with the four memory tiers as a namespace dimension. Good structure is what makes salience and compaction tractable.
- **Format:** keep a provider-neutral typed canonical core; render it to **XML-tagged input** through a thin Claude-specific adapter (swappable), and use **structured tool-use schemas for actions/cards + markdown prose for explanation**.
- **Model governance:** pin exact versions per environment; move the pin only through an eval-gated canary/A-B rollout; expose bounded user *tiers* (Deep/Balanced/Fast) and admin allow-lists, never raw model IDs; audit which model+version produced every answer. Treat model + system-prompt + memory-format + schemas as **one versioned bundle**.
- **Routing:** a cheap Haiku router dispatches per-task; memory extraction/compaction run on Haiku with structured output + validation + escalate-on-low-confidence, because a cheap summarizer silently dropping a load-bearing constraint is the signature failure to guard against.

The detailed expert sections follow.

---

## Part A — Memory (the core of the product)

### Debate: The Case for Remembering Richly (Maximalist)

**Thesis.** For a financial assistant, memory is not a feature — it is the product. Two assistants with identical access to the same models, market data, and brokerage APIs are distinguished by exactly one thing: which one *knows the user*. Strip the memory and you have a generic chatbot that re-asks "what's your risk tolerance?" every Monday.

**1. The capture surface should be wide, because the expensive losses are the ones you didn't write down.** Every un-captured constraint is a future plausible-but-wrong recommendation. Capture richly, across distinct *kinds*, each with provenance and lifecycle:

```
PreferenceFact      { subject, value, strength: stated|inferred, source_turn, confidence, asserted_at }
HardConstraint      { type: tax|liquidity|legal|ESG|concentration, rule, scope, expires_at? }
Decision (episodic) { action, instrument, size, date, rationale[], thesis_id, expected_outcome, confidence }
Rationale           { claim, evidence_refs[], assumptions[], horizon }
Outcome             { decision_id, realized_pnl, realized_at, attribution: thesis_correct|right_for_wrong_reason|wrong }
Correction          { supersedes_fact_id, corrected_value, corrected_at, reason }
```

The non-obvious point: **constraints, rationales, and corrections are higher-value than transcripts.** A summarizer that keeps "user is conservative" and discards "user will not hold any single position above 5% after the 2021 concentration blowup in their employer's stock" threw away the load-bearing memory and kept the decoration.

**2. Schemas + a lightweight knowledge graph beat lossy summaries** — because finance is relational and adversarial to fuzzy recall. Queries are structural ("where am I within 10% of a stated concentration limit?" is a graph traversal, not a vibe match); numbers degrade under paraphrase; and relationships are the value:

```
(User)-[:HOLDS {basis, qty, acct}]->(AAPL)
(User)-[:HAS_THESIS {conviction, opened}]->(Thesis:"AI capex cycle")
(Thesis:"AI capex cycle")-[:IMPLIES]->(NVDA)-[:CORRELATED_WITH {ρ:0.7}]->(AAPL)
(Decision:#418)-[:JUSTIFIED_BY]->(Thesis:"AI capex cycle")
```

Now the assistant can say: *"You're adding NVDA on the AI-capex thesis, but you already express that thesis through AAPL and MSFT; combined that's 14% of book and 0.7-correlated — this concentrates a single thesis past your own 5%-per-name rule."* No summary produces that sentence; the graph does, because the edges were preserved.

**3. Remember the "why," not just the "what."** A decision log without rationales is a brokerage statement; you already have one. Thesis tracking enables "right for the wrong reason" detection: *"You're up 22%, but the move came from an oil-supply shock, not the rate-cut rotation you bet on — the original thesis hasn't played out."* Only possible if you stored the assumptions.

**4. Behavioral pattern detection requires a long, structured history** — *"In each of the last four 8%+ drawdowns you asked me to model selling, and each time the position recovered within 90 days."* Unreachable without retained, labeled outcomes spanning years.

**5. Storage is cheap; relevance is the real problem.** A user's multi-year history is megabytes — trivial at rest. The binding constraint is attention budget per turn, answered by *retrieval engineering, not deletion*: tier the store; retrieve structured-filter-first, semantic-second; use a cheap Haiku pass to pre-rank candidates so Opus sees a tight set. **Don't forget to control relevance — retrieve better.**

**Concessions (steelmanning the minimalist).** Stale memories cause confident wrongness (every fact carries `asserted_at` + `confidence`; soft preferences *decay* and need re-confirmation; hard constraints don't). Contradictions must *supersede*, not append. Privacy/compliance liability is real — store the *constraint*, not the sensitive *story* behind it; tier by sensitivity, encrypt, support hard delete/export. Retrieval noise is real — treat retrieval relevance as a first-class measured problem and show provenance so users can correct bad pulls.

**Where the maximalist holds the line:** never silently forget a hard constraint or a decision rationale; prefer structured/typed/provenance-stamped memory over lossy prose for anything touching money/taxes/risk; treat *retrieval relevance* (not capacity) as the binding constraint.

### Debate: The Case for Remembering Sparingly (Minimalist)

**The core claim.** In a financial assistant, the marginal stored fact is more likely to mislead than to help. State lives in the broker and the ledger; the model's job is to reason over *current* truth, not curate a private divergent copy. The default on every write should be "no."

1. **The broker is the source of truth; memory is a stale mirror.** Positions, balances, cost basis, buying power, open orders, tax lots are authoritative in the brokerage system and change without the assistant's knowledge. The canonical failure: episodic memory says "long 400 NVDA," the user closed it Tuesday from their phone, and the assistant now hedges shares that don't exist. The fix isn't smarter memory — **don't store live state at all. Fetch it.**
2. **Stale preferences are worse than no preferences.** A 14-month-old "aggressive, comfortable with leverage" silently steers position-sizing and suitability long after it stopped being true — *invisibly*, so the user never sees the assumption to correct it. Asking "still comfortable with this risk level?" costs one sentence.
3. **Contradiction accumulates and retrieval can't adjudicate it.** Append-heavy memory holds "wants dividends" and "wants growth, hates taxable distributions." Semantic retrieval surfaces whatever embeds closest, not whatever is true — so more memories means more contradictory pairs and *more* coin-flips on advice.
4. **Retrieval noise degrades answers faster than missing memory does.** A *missing* fact produces a cheap, visible, correctable clarifying question. A *wrong-but-retrieved* fact produces a confident, contaminated answer trusted *more* because it looks personalized.
5. **Hoarding financial data is a standing liability.** Every retained holding/income/balance/"saving for a divorce" widens breach blast radius, complicates deletion-on-request, and invites "why did you keep this?" The cheapest way to win a privacy argument is to not have the data.
6. **Extraction/summarization passes are a recurring tax** — an LLM write-path on every session, plus embedding, re-summarization to fight drift, and reconciliation — to maintain a store whose contents are mostly net-negative.
7. **Therefore: derive compact patterns, decay aggressively, gate hard on writes.** Store a fact only if it's *durable, decision-relevant, and not available from an authoritative source on demand.*

**Concession (steelmanning the maximalist).** The strongest point is not state; it's the **"why."** The broker tells you the user holds a muni ladder; it never tells you *they hold it because they're in a high tax bracket and retire in eight years.* Durable **intent, constraints, and goals** are high-value, low-volatility memory, and behavioral patterns let the assistant pre-empt mistakes.

**Where the minimalist holds the line:** remember *why* and *what for*; never cache *what is.* Profile/intent tier keeps goals/values-constraints/stable preferences (with decaying confidence, re-confirm on use); episodic tier keeps the *narrative why*, never a position ledger; semantic KB (user-agnostic knowledge) is fine to remember richly; short-term is dropped unless it passes the salience gate. *"A question you ask is recoverable; a stale fact you trusted is not."*

### Deciding What to Remember (Salience & Write Policy)

The product is not the chat — it's the accreting model of *this user*. Every turn, a cheap extraction pass (Haiku 4.5) proposes candidates; a write policy decides which survive. The default is **forget**.

**Taxonomy of memory-worthy signals (ranked by durability × decision-value):**

| Rank | Signal class | Example | Durability | Why it earns a slot |
|---|---|---|---|---|
| 1 | **Hard constraints** | "Never recommend options." / "ESG-only." / "specific-lot tax method" | Permanent until revoked | Violating one is a *trust-ending* error; gates every answer. |
| 2 | **Stated preferences** | "I tilt toward semis." / "Risk: moderate." / "Horizon: 10+ yrs" | Months–years | Shapes ranking/framing of every recommendation. |
| 3 | **Decisions + rationale** | "Sold NVDA to rebalance, not on thesis change." | Years (immutable) | Prevents re-litigating settled questions; explains the portfolio's *why*. |
| 4 | **Realized outcomes** | "Suggested trimming tech in Jan; user did." | Permanent | The only honest input to a self-correcting advisor. |
| 5 | **Recurring patterns** | "Panic-sells on >5% single-day drops." | Months | Inferred, lower confidence — high leverage for proactive framing. |
| 6 | **Explicit corrections** | "No, I meant my Roth." | Permanent (supersedes) | Reveals a *wrong* existing memory; always high-confidence. |
| 7 | **Goals / life events** | "Buying a house in 2 yrs — need liquidity." | Event-bounded (TTL) | Reframes horizon/liquidity; expires after the event. |
| 8 | **One-off task params** ❌ | "Show me AAPL's P/E." | Seconds | **Do NOT persist** — context, not memory. |

Rule of thumb: memory-worthy only if it would still change your answer *in a different conversation a month from now*.

**The write-decision function** (Haiku extracts candidates as structured JSON; a deterministic scorer decides — keep the decision in code, auditable and cheap):

```python
def salience(c, existing) -> float:
    durability  = DUR[c.kind]          # constraint=1.0, pref=.8, goal=.6, pattern=.5, oneoff=.0
    specificity = c.specificity        # "no options on my IRA"=.9 vs "be careful"=.2
    confidence  = c.confidence
    refines     = 1.0 if c.contradicts_or_refines(existing) else 0.0
    recency     = 1.0
    source      = SRC[c.source]        # user_stated=1.0, confirmed_action=.9, inferred=.5
    score = (0.30*durability + 0.20*specificity + 0.20*confidence + 0.15*source + 0.15*refines)
    score *= recency
    if c.pii_sensitivity >= NEEDED_FOR_ADVICE_THRESHOLD and not c.is_needed:
        return 0.0                     # PII is a GATE, not a term
    return score

def decide(c, existing):
    s = salience(c, existing)
    if s >= 0.70: return "WRITE"        # silent upsert
    if s >= 0.45: return "HOLD"         # needs corroboration OR confirm
    return "SKIP"
```

**By tier:** session (very low bar, dies at session end) → long-term profile (high bar, constraints never auto-expire) → episodic (append-only, never edit history, append a correction) → semantic (highest bar, re-derive rather than trust forever). **By asserter:** user-stated (1.0, eligible for silent write) > confirmed action (0.9, store the *decision/rationale* not the holding) > inferred (0.5, caps at HOLD until corroborated).

**Dedup & conflict at write time:** no match → APPEND; restated → UPSERT; refinement → SUPERSEDE (keep lineage); contradiction → SUPERSEDE if newer+trusted else HOLD_FOR_CONFIRM; correction → SUPERSEDE immediately and invalidate anything derived from the wrong fact. **Ask vs write silently:** write silently when user-stated + specific + non-contradictory; *ask* when it would flip a hard constraint, when an inference is about to become a long-term fact, on money-affecting ambiguity ("Roth or taxable?"), or in the HOLD band. Expose a quiet "what I remember" panel for review/deletion.

**Negative space — do NOT persist:** PII you don't need; source-of-truth-elsewhere data (positions/balances/quotes — fetch live, remember the *decision*); transient market chatter; one-off task params; sensitive inferences you wouldn't say aloud; anything stale-by-construction. *If it's queryable on demand or true only today, it's context, not memory.*

**Feedback loop:** tag each memory at retrieval; measure utility (`(helpful_uses − harmful_uses) / retrievals`); archive items that never paid off and harden proven ones; per-class, if a whole signal kind never improves answers, raise its threshold or stop extracting it (cutting Haiku cost). **Constraints and corrections are exempt from utility-based archiving** — a constraint that's never *needed* is still catastrophic to forget. The loop tunes the discretionary middle, never the safety floor.

### How to Abbreviate & Compress Memory

Compression is a per-fact decision driven by how much it costs to be wrong.

**1. Lossy vs lossless, gated on reconstructability.** Classify each memory by what happens if the detail is lost. **Lossless** = anything load-bearing for a decision or guardrail: hard constraints, numeric figures, identifiers, dates, account/legal facts. **Lossy** = conversational color, tone, hedging, re-derivable context.

```
Before (transcript, ~70 tokens):
  "Yeah so I really don't want to touch anything leveraged, got burned in
   2022 on a 3x ETF, lost like 18 grand... Keep me out of that stuff."

After — lossy for the story, lossless for the constraint (~18 tokens):
  constraint: { type: NO_LEVERAGED_INSTRUMENTS, hard: true, src: msg_8842 }
  note: "burned on 3x ETF in 2022" (rationale, lossy ok)
```

Rule: **constraints and numbers are lossless; narrative is lossy.** When unsure, treat as lossless.

**2. Structured (normalized) encoding beats prose** for anything with a shape — more token-efficient *and* more reliable:

```
Prose (~26 tokens, must be re-parsed):
  "they'd like to keep roughly a fifth of the portfolio in cash and prefer
   dividend-paying large caps."
Structured (~14 tokens, canonical, queryable):
  prefs: [ {k: cash_target_pct, v: 20}, {k: equity_style, v: [LARGE_CAP, DIVIDEND]} ]
```

Enums collapse synonyms, canonical IDs remove ambiguity, ISO dates/typed numbers sort/diff cleanly, and a validator can reject malformed constraints. **When prose is still better:** nuanced rationale that doesn't fit an enum — keep a short prose `rationale` field alongside the structured record (structure the *what*, prose the *why*).

**3. Hierarchical & temporal compaction:** rolling conversation summary (last N verbatim, older digested); episodic→pattern rollups; time-decayed granularity (recent detailed, old coarse); summary-of-summaries pyramid (day→week→month→year). **Avoid summary drift:** re-derive from *source*, not from prior summaries; never let lossless facts pass through a lossy summarizer (constraints/holdings/figures live in a structured store summaries *reference* but never rewrite); anchor with `src` pointers; use a low temperature.

**4. Canonicalization as compression:** "Apple"/"AAPL"/"$AAPL" → `AAPL`; "last Tuesday"/"2/3/26" → `2026-02-03`; "about twenty grand" → `20000`; "bought"/"picked up" → `BUY`. The deeper payoff is **dedup**: "I like Apple" (Jan) and "AAPL is my favorite" (Mar) collapse to one preference record with an updated timestamp.

**5. Token-budget-aware abbreviation for the cached prefix:**

```
Verbose (~85 tokens) →  Compact DSL (~34 tokens):
  RISK=moderate; CASH_TGT=20%; HORIZON=2045(retire)
  HARD: no_options, no_leverage, max_pos=$25k
  PREF: large_cap, dividend
```

Discipline: stable documented keys (not improvised shorthand); expand high-stakes lines (never abbreviate a number or unit; label hard constraints `HARD:`); prefer abbreviations the model already knows; round-trip-validate (have the model expand the DSL back to prose and diff against source).

**6. Preserve the "why" cheaply:** store a one-line `rationale` + a `src` pointer, not the transcript.

**Pitfalls:** over-compression dropping a load-bearing constraint; summary drift compounding; abbreviations the model misreads; compressing away numbers ("about $25k", "a fifth", "early next year" → store `25000`, `20%`, `2027-01`); stale-but-confident memory (keep `ts`, newest canonical value wins); losing auditability (keep a `src` on every derived memory).

### How to Organize Memory (Schema, Graph & Indexing)

The central question is *representation*. The wrong default is "one big vector store and hope retrieval surfaces the right chunk" — trading memory is full of typed entities with hard constraints and causal chains (thesis → decision → outcome) that semantic similarity alone mangles.

**Representation recommendation: hybrid on a single Postgres + pgvector instance.**

| Representation | Good at | Bad at (here) |
|---|---|---|
| Relational | Hard facts, constraints, joins, aggregates, integrity, audit | Fuzzy recall, free-text rationale |
| Document (JSONB) | Flexible evolving blobs, prototyping | Cross-entity queries, dedup, invariants |
| Vector (pgvector) | Semantic recall over notes, paraphrase-tolerant | Precise filtering, counting, multi-hop |
| Knowledge graph | Multi-hop traversal, entity linking, dedup | Volume of text; overkill if only single-hop |
| **Hybrid** | Each layer does what it's best at | Operational discipline to stay consistent |

- **Structured relational + light graph for entities** (source of truth + constraint enforcer).
- **Vector for semantic recall** over the *free-text* parts (rationale, preference statements, thesis narratives).
- **The four tiers as a `tier` namespace** applied across the same tables (joinable at assembly time).

**Trading-domain ontology:**

```
User ──owns──> Account ──holds──> Position ──of──> Instrument
 ├─has─> Preference
 ├─has─> Goal ◄────supports──── Decision
 └─bound by─> Constraint
        Event ──informs──> Thesis ──motivates──> Decision ──on──> Instrument
                              └──invalidated_by── (later Event)
                              Outcome ──evaluates──> Decision
                              Pattern ──generalizes──> [Decisions]
```

```sql
constraint(id, user_id, kind, spec jsonb, hard bool, active_from, active_to)
preference(id, user_id, dimension, statement text, strength, source_decision_id, embedding vector(1536))
thesis(id, user_id, summary text, scope, conviction, status, created_at, embedding vector(1536))
decision(id, user_id, account_id, instrument_id, action, size, rationale text, decided_at, embedding vector(1536))
outcome(id, decision_id, horizon, realized_pnl, vs_benchmark, label, measured_at, notes text)
pattern(id, user_id, name, description text, evidence_count, confidence, last_seen, embedding vector(1536))
edge(src_type, src_id, rel, dst_type, dst_id, weight, created_at)   -- the graph layer
```

**Why a light graph earns its keep:** multi-hop causal queries ("decisions driven by my macro thesis that later went wrong"); linking rationale to outcome (the single most valuable thing trading memory can do); entity dedup; grounding advice in connected history. Keep it light — one `edge` table, fixed relation vocabulary, no separate graph DB.

**Indexing for retrieval** — decide per field whether it's metadata-filterable (B-tree/partial indexes, never embedded), embedded (HNSW), or both:

```sql
CREATE INDEX ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON decision (user_id, tier, instrument_id, decided_at DESC);
CREATE INDEX ON constraint (user_id) WHERE hard AND active_to IS NULL;
CREATE INDEX ON edge (src_type, src_id, rel);
CREATE INDEX ON edge (dst_type, dst_id, rel);
```

**Every retrieval runs a three-stage funnel, never vector-only:** (1) metadata filter (`user_id`, `tier`, `instrument_id`, time window — cuts candidates by orders of magnitude, guarantees no cross-user leak); (2) vector rank survivors by cosine; (3) graph-expand 1–2 hops along `motivated_by`/`evaluates`/`generalizes` to pull connected rationale + outcomes.

**Namespacing:** partition by `user_id` first (leading column of every composite index; partition-drop for GDPR-erase); the four tiers (`working`/`episodic`/`semantic`/`procedural`) as a column; assembly-time merge orders by tier priority then score, **always injecting hard Semantic constraints unconditionally**.

**How organization enables the other two decisions:** *what to remember* becomes a typed routing decision (classify into the ontology — Constraint? one-off Event?); *salience* is computable from structure (`f(tier, edge-degree, recency, outcome-magnitude)`); *abbreviation* is safe because the graph preserves the *link* even when you summarize the *text*.

**Pitfalls:** over-engineering the graph too early; schema rigidity (keep the spine typed, let fuzzy content live in `jsonb`+embeddings); orphaned/duplicate entities (enforce links, run periodic dedup); retrieval that ignores structure (always pre-filter metadata, always inject hard constraints, always graph-expand).

---

## Part B — LLM Structure / Format

### Debate: Which Structure/Format for the LLM

Two coupled-but-separable decisions: (1) how standing context/memory is serialized *into* the model, and (2) how responses come *out*. The stakes are unusual — the app mixes high-stakes structured artifacts (draft orders, position sizes, risk limits), where a parse error is a *financial* error, with explanatory prose where over-structuring kills nuance. "One format for everything" is the wrong instinct.

**Debate 1 — provider-idiomatic vs provider-neutral.** Claude (Opus 4.8/Sonnet 4.6/Haiku 4.5/Fable 5) is trained to respond to XML-tagged structure — tagged sections get attended to as units, referenced reliably, and resist instruction/data bleed. But models churn; welding your *memory store* to Claude-flavored XML fragments creates lock-in. **Resolution:** these are two layers. The **canonical memory** is structured *data* (typed records — inherently portable). **Rendering** to a prompt is a thin, provider-aware, reversible adapter. The coupling cost is one module, so the quality gain (Claude's native comprehension) decisively favors idiomatic rendering over a lowest-common-denominator format.

**Debate 2 — input representation.** Verdict: **XML tags as the outer skeleton**, content inside each tag in whatever's most natural (markdown bullets for human constraints, a compact pipe/line for market data, JSON only for genuinely tabular machine payloads like positions/order book). XML carries metadata cleanly on attributes (`as_of=…` — critical for staleness), is token-efficient, and degrades gracefully under memory compression (you can drop or shrink an `<episodes>` block without breaking a parser, because nothing programmatic parses the *input* — the model does). JSON-as-input wastes tokens on quoting and truncates into *invalid* JSON under budget pressure.

**Debate 3 — output.** Route by intent, in one turn if needed. **Structured tool-use schemas** for actionable artifacts — a draft order as a schema can be **validated before a human sees it** (does it violate the no-options constraint? exceed the 5%-per-name cap?), round-trips into a confirmation card, and surfaces uncertainty as a missing required field rather than a confident guess. **This is a safety mechanism, not a formatting preference.** **Markdown prose** for explanation/judgment, where forcing JSON flattens the nuance that makes the assistant trustworthy. Keep them in separate channels (text vs tool call) — never a concatenated blob someone downstream must tease apart.

**Recommendation:** portable canonical core + thin provider adapter + asymmetric formats:
1. Canonical memory = typed, provider-neutral data (no prompt syntax in the DB).
2. Input adapter renders records → XML-tagged prompt (Claude idiom today; a future JSON-leaning model means a *second* renderer, not a data migration).
3. Output = structured tool-use schemas for actions/cards (naturally portable — the same `draft_order` schema works across providers), markdown prose for explanation. **Validate every structured artifact server-side against the user's constraints before rendering/confirming.**
4. Memory abbreviation operates on the canonical core, then re-renders (compression logic written once, provider-independent).

**Concrete assembled prompt (Claude rendering):**

```xml
<system>
You are a financial assistant. Obey <constraints> absolutely. Never place
orders; only emit draft_order tool calls for human confirmation. Treat
<market_data> as of its as_of timestamp; if stale or missing, say so.
</system>
<profile risk_tolerance="moderate" horizon="long" cash="12400.00" />
<constraints>
- No leverage, no options, no shorting.
- Max 5% of portfolio per single name.
- No trades on earnings day without explicit confirmation.
</constraints>
<positions>
[ {"symbol":"AAPL","qty":15,"avg_cost":188.20}, {"symbol":"SPY","qty":40,"avg_cost":561.00} ]
</positions>
<episodes>
- 2026-05-02: User declined a TSLA buy, cited volatility concerns.
- 2026-06-10: Asked to trim tech exposure if it exceeds 30%.
</episodes>
<market_data as_of="2026-06-19T14:30Z">
AAPL 201.40 (+0.8%) | SPY 588.10 (-0.2%) | tech_weight 31.2%
</market_data>
<user_message>Tech's drifted over my limit again — what should I do?</user_message>
```

A good response: markdown prose (tech at 31.2% vs the 30% target, referencing the 2026-06-10 instruction) **plus** a `draft_order` tool call to trim AAPL — which the server validates (5%-per-name? not earnings day? tradable symbol?) before surfacing a confirmation card.

**Pitfalls:** over-coupling to one provider (keep idiom in the adapter, core typed/neutral); JSON brittleness on input; mixing formats without signposting; unparseable output hybrids (use the native tool-use channel for structure, text channel for prose); trusting structured output as *validated* (a schema guarantees shape, not correctness — server-side constraint validation is non-negotiable).

---

## Part C — Model Governance & Routing

### Debate: Should the Model Change Over Time, and Who Decides

**The spectrum:** hard-pinned (frozen, exact build) ↔ auto-upgrade (floating `-latest`). Pinning gives reproducibility (a finance answer may be scrutinized by a client/compliance/regulator — you must know exactly which model+version produced it), eval-validated behavior (your sign-off is only valid for that artifact), coupling protection, and stability. Auto-upgrade gives capability/cost gains but **silently changes a production financial control surface** — refusal boundaries shift, tool-use discipline regresses, citation discipline changes, structured-output reliability drifts, all *without an error surfacing*. The default tilts decisively toward pinned — but the real question is the *process* by which the pin moves.

**Who controls change?** (a) **End user picks** — transparency/power, but confusion and **inconsistent safety** (users gravitate to the least restrictive model), and broken reproducibility. (b) **Admin/tenant policy** — where governance belongs (eval-gating, allow-lists, aligns control with the entity bearing regulatory liability). (c) **App auto-routes by task** — best default for quality-per-dollar, but routing is itself an eval-gated, audited artifact. **These aren't exclusive — layer them:** the app auto-routes within an admin-allow-listed, eval-gated set per tenant, and the user gets a **bounded** preference (a quality/speed/cost tier), never a raw model ID.

**Governance recommendation:**
1. **Pin exact versions per environment** (never a floating `-latest`); prod only runs models that cleared staging's gate.
2. **Promote only through an eval-gated canary/A-B rollout** — re-run the full prompt-eval + red-team suite (refusals, tool-use, citation grounding, structured-output validation, finance-safety probes); must meet-or-beat the incumbent on every gating metric; then canary a small slice, watch live metrics, A-B, then fleet-wide.
3. **Expose bounded preferences, not raw model IDs** — user-facing "Deep / Balanced / Fast" tiers mapping to models via versioned config; admin-facing per-tenant allow-list of approved (model, version) pairs.
4. **Per-tenant compliance override** (pin an older validated version, disable auto-routing, require human-in-the-loop). Compliance wins over capability.
5. **Full audit of model provenance** — every answer logged with exact model+version, prompt-template version, memory-format version, routing decision, tier/tenant policy.

**The coupling risk specific to this app:** memory-abbreviation formats, the system prompt, structured-output schemas, and guardrails are each tuned to a model's behavior — a model change can break any of them silently. **Treat model + system-prompt + memory-format + schemas as one versioned bundle**; bump and tag together; re-run the full eval + red-team suite (exercising memory round-trips and schema validation, not just answer quality) on *every* model change including provider point releases; keep prompt/format versions in the audit record.

**Cadence & rollback:** re-run the eval/red-team suite on the *pinned* prod model monthly (catch provider-side drift) and immediately on any new candidate or bundle change; promote deliberately (multi-week canary→A-B→fleet, slower for safety-sensitive tenants); keep the prior approved bundle hot with automatic rollback triggers on live signals (schema-validation rate, refusal-rate spikes, tool-error rate, advice-boundary violations).

**Pitfalls:** floating `-latest` aliases; letting users pick a model that weakens safety; upgrading without re-running evals ("it's just a newer version" is exactly how regressions ship into a system that moves money).

### Which Model for Which Job (Routing Map)

A trading assistant is a dozen sub-tasks with different intelligence/latency/cost profiles. The expensive mistakes are running everything on one model *and* running the constraint-preserving steps on a model that's too cheap. Pricing (per MTok): Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50.

| # | Aspect | Tier | Rationale |
|---|---|---|---|
| 1 | **Final advice / explanation (guardrailed)** | **Opus 4.8** (Sonnet for routine) | User-facing, liability-bearing; tone, calibrated hedging, disclosure language matter most here. |
| 2 | **Hard multi-step analysis** | **Opus 4.8**, Fable 5 for the hardest | The small fraction where correctness compounds; `effort: high/xhigh`. |
| 3 | **Strategy code generation** | **Opus 4.8** (`xhigh`) | High cost-of-error; gate behind tests/dry-run, never unreviewed to live capital. |
| 4 | **Guardrail / safety classification** | **Sonnet 4.6** floor; Opus for edge | Safety-critical — a missed "unlicensed advice" call is a compliance event. Don't put on the cheapest model; pair with deterministic rules. |
| 5 | **MEMORY EXTRACTION** | **Haiku 4.5** + validation + escalation | High-volume, latency-sensitive, structurally simple. *But* "never buy on margin" is load-bearing — use strict structured output, a confidence field, and escalate-on-low-confidence to Sonnet for hard constraints/negations/numbers; validate the fact round-trips before persisting. |
| 6 | **MEMORY SUMMARIZATION / COMPACTION** | **Haiku 4.5** routine; **Sonnet** when nuance must survive | The danger is the failure mode: a cheap summarizer can quietly drop "harvest losses in December" or "spouse is co-signer." Guards: (a) hard constraints are a **structured, never-summarized list** carried verbatim; (b) **post-compaction validation** diffs the constraint set before/after and flags drops; (c) escalate to Sonnet when many distinct constraints are present. |
| 7 | **Grounded factual answering over retrieved data** | **Sonnet 4.6** | Reading + faithfully restating retrieved context; failure mode is hallucinating a number, mitigated by grounding not a bigger model. |
| 8 | **Retrieval query gen / HyDE** | **Haiku 4.5** | Short, cheap, frequent, tolerant of imperfection (retrieval+rerank recovers). |
| 9 | **Structured draft-order generation** | **Haiku 4.5** + `strict:true`; Sonnet for multi-leg | A constrained transform once intent is clear. Draft for confirmation, never auto-execution; validate against business rules deterministically. |
| 10 | **Intent routing / classification** | **Haiku 4.5** | Runs on every turn, in front of latency; produces the confidence signal that drives escalation everywhere. |
| 11 | **Entity / ticker extraction** | **Haiku 4.5** + strict output | High-volume, narrow; keep a deterministic ticker-validation step after the model. |
| 12 | **LLM-as-judge / eval** | **Opus 4.8** (Batch API, 50% off) | Judge quality caps eval quality; offline so latency doesn't matter; don't let Haiku grade Opus. |

**Economics:** the request distribution is bottom-heavy (routing/extraction/query-gen/memory/order-drafting fire on nearly every turn; hard reasoning fires occasionally). Running that stack on Opus is a ~5× overspend on the majority of calls for no quality gain (often worse latency). Tiering + routing concentrate Opus spend where it pays; **caching compounds it** (a large stable system prompt cached once costs ~0.1× per read — keep the prefix byte-stable, inject volatile context after the last breakpoint, don't swap tools/models mid-conversation); offline evals go through the Batch API.

**Routing mechanism:** (1) a cheap Haiku front-door router emits `{intent, complexity, risk_flags, confidence}` as strict structured output; (2) **escalate on uncertainty** — low confidence, hard-constraint/negation/money touch, or a guardrail flag re-runs one tier up (Haiku→Sonnet→Opus); (3) cost/latency budgets per path; (4) **validate, don't just trust** — memory extraction/compaction and order drafting each pass a deterministic validator (schema conformance, constraint round-trip, buying-power check) before persist/show. Escalation handles the model's *uncertainty*; validation catches confident-but-wrong failures.

**Fable 5 / non-Claude:** default to Claude tiers; Fable 5 only for the genuinely hardest long-horizon autonomous work where you've measured the $10/$50 buys a real gain (and note its operational differences). Non-LLM components for non-language tasks — numerical pricing/Greeks/backtests belong in deterministic libraries, embeddings in a dedicated embedding model. The LLM orchestrates and explains; it does not do arithmetic a library does exactly.

**Pitfalls:** top model everywhere (burns budget/latency); too cheap on load-bearing steps (guardrails, constraint-preserving compaction) without a safety net; no escalation path; trusting a summarizer with constraints (compaction is for *context*, not *rules*); letting the LLM do arithmetic or auto-execute.
