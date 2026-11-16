# Decision-evidence architecture audit

Date: 2026-07-13  
Scope: strategy generation, Green/Red review, market-data enrichment, RAG, learning,
AI strategy review, Framework review, and Coach/chat.

## Executive conclusion

The app had many strong data producers, but the decision path still lost information at five
boundaries:

1. enrichment happened after an overly narrow preselection;
2. scalar merges hid field freshness, source conflicts, and provider failures;
3. Green and Red did not receive one provably identical evidence object;
4. account-derived learning used to silo paper from live behind a transfer gate that retrieval
   no longer applies — paper and live lots now pool per user; and
5. RAG, learned prose, and tool output competed for prompt space without one global budget or a
   uniform prompt-injection boundary.

This program closes those boundaries. The canonical flow is now:

```text
universe -> wider cheap scan -> bounded enrichment -> field arbitration -> final rank
         -> exact candidate set -> immutable evidence manifest -> Green -> identical Red context
         -> deterministic policy/execution -> realized + skipped outcomes
         -> account-scoped learning + source/model value telemetry
```

The synthetic product Test Account is removed and purged. Real broker paper accounts remain because
they produce broker-realistic labeled outcomes. Owner cut 2026-08-17: paper→live pooling stays.
The 20-paper+5-live transfer gate is deleted. Structured lessons retrieve across the owner's
connected accounts; an account is an account.

## Source-use audit

| Source family | Current producers | Decision use after this program | Prior loss mode | Remaining limitation |
|---|---|---|---|---|
| Broker/account truth | Robinhood, Alpaca, Alpaca MCP, Tradier; balances, positions, orders, fills, capabilities | High-priority structured evidence; exact account scope; execution truth remains deterministic | Account-derived reflections and memories could be retrieved too broadly | Broker latency and missing broker fields still require typed partial/failure receipts outside enrichment |
| Initial market scan | Nasdaq delayed screener, broker quotes, Yahoo quote floors | Wider cheap preselection, then enrichment, then final ranking | Expensive enrichment ran only after a narrow rank and could never rescue a candidate | The cheap first pass still determines the bounded enrichment pool; measure recall as outcomes accrue |
| Quote/fundamental/news enrichment | Congress.Trade, Webull unofficial, Robinhood fundamentals, Alpaca news/snapshots, Yahoo Finance, Finnhub, FMP, Massive, Alpha Vantage, Fintech Studios, Intrinio, Tiingo, Twelve Data, SEC XBRL | Field-level observations, timestamps, availability, provenance, deterministic arbitration, provider-failure manifests | First non-null scalar won silently; failures collapsed to empty; duplicate upstream analyst consensus could be double-counted | Most legacy providers do not yet emit explicit reliability/directness scores, so registration order remains the deterministic tie-breaker when metadata ties |
| SEC/RAG | 10-K, 10-Q, 8-K and fundamentals chunks; SEC XBRL; default-off FMP earnings transcripts | Point-in-time retrieval uses one run `asOf`; retrieved text is contained, budgeted, hashed, and shared with both teams; transcripts use first-body-observed time and rights-aware global filtering | Undated or instruction-like text could enter prompts without one run-wide receipt; transcript retrieval previously had no producer | Corpus breadth and occurrence-level provenance still depend on the staged SEC backfill; transcript production remains blocked by FMP endpoint entitlement and confirmed storage/display rights |
| Web/alternative signals | SEC insider, SEC 8-K, FINRA short volume, Congress disclosures/analytics, computed technicals | Enter through structured candidate fields and evidence/source manifests; conflicts can be retained | Presence did not prove contribution; missing sources were hard to distinguish from neutral facts | Several web-source datasets still expose dataset-level rather than per-record evidence receipts |
| Macro/regime/internals | Macro cascade, derived metrics, market internals/signals | Structured macro-regime evidence with one decision timestamp, available to Green and Red | Red received a manually reconstructed subset | Upstream macro observations still vary in timestamp precision |
| Realized outcomes | Filled lots, excursions, thesis/regime/sector/factor scorecards | Exact-account performance evidence; source ablations join to closed-lot outcomes | Cross-account performance could enter tuning without a transfer contract | Source-value estimates are observational and selection-biased, not causal |
| Skipped outcomes | Matured skipped-candidate counterfactuals | Joined to decision-time source ablations; ordered by decision time, not return | Return-ordered reads could amplify survivorship/selection bias | Counterfactual prices remain market-data observations, not executable fill simulations |
| Learned context and episodic memory | Post-mortems, decision cases, owner coaching, vector analogs | Per-user retrieval for structured lessons; paper and live lots pool across the owner's connected accounts; validated research can still carry an explicit transfer state; legacy autonomous rows quarantined | Sibling-account and paper/live histories used to be siloed, then briefly gated by a 20+5 transfer contract | The 20-paper+5-live transfer gate is deleted (owner 2026-08-17). Pooling remains. |
| Owner/Coach/Framework input | Owner strategy text, Coach turns/tools, framework proposals, tuning evidence | Owner-authored strategy remains trusted; external/tool/retrieved data is recursively contained, globally budgeted, hashed, and audited | Each LLM surface had its own partial context and injection handling | Chat feedback and causal model/source experimentation remain future measurement layers |
| Provider/model operations | LLM usage, RAG usage, health and audit events | GPT-5.6 cost accounting, role-specific reasoning, model attribution, source coverage and source-value audits | Catalogs diverged and some surfaces silently selected a model | Model and source recommendations must be re-adjudicated from realized samples rather than frozen |

## Implemented invariants

### Evidence and candidate integrity

- One immutable, content-addressed evidence contract records source family, provider, status,
  observation/effective/retrieval timestamps, lineage, and content hash.
- Green and Red share the complete Green evidence object. A parity hash makes evidence drift
  inspectable instead of relying on two hand-maintained prompt builders.
- Buy/short openings are restricted twice: a structured-output symbol enum and an authoritative
  post-parse exact-candidate check. Sell/cover exits remain available for held positions.
- Variable prose uses one deterministic run-wide character/token budget with family quotas and
  model-visible truncation/omission receipts.
- Retrieved, provider, tool, and persisted LLM text is recursively treated as data. Instruction-like
  spans are quarantined and audited before model use; the owner's strategy text is preserved.

### Source use and measurement

- Enrichment uses a wider bounded preselection before final scoring so expensive data can change the
  actual candidate set.
- Scalar compatibility fields remain, but each enriched field can carry provenance, timestamps,
  availability, reliability/directness/confidence, and disagreement metadata.
- Provider failures remain visible beside successful facts. A failed source can no longer look like
  a neutral/no-data answer by omission alone.
- Analyst observations are deduplicated by upstream family before blending so redistributed
  consensus is not counted twice.
- Every candidate persists a leave-one-winning-provider-out score receipt. Closed-lot and skipped
  outcomes aggregate these into source-value telemetry with an explicit non-causal caveat.
- Per-run source coverage/failure manifests are included in strategy evidence and audits.

### Learning and account boundaries

- Structured lessons (`learned_context` + lesson vectors) are per-user. Paper and live closed lots
  pool across the owner's connected accounts (`source_accounts` + `environment_breakdown` are
  provenance, not a gate). There is no 20-paper+5-live transfer threshold.
- Research-scope rows may still carry an explicit `validated` / `rejected` transfer state. That is
  not a paper-lot count gate and does not block pooling.
- Pre-migration autonomous rows with unknowable provenance are marked `legacy` and excluded from
  decisions. User-authored and ingested rows remain portfolio context.
- The product Test Account create/UI/read paths are removed. Migration v24 purges legacy Test Account
  rows and associated simulated outcomes. `broker: "test"` remains only as unit-test infrastructure.

### LLM surfaces

- GPT-5.6 Luna, Terra, and Sol are available in Green, Red, AI strategy review, learning review,
  Framework controls, and Coach/chat through one shared catalog.
- Coach requires an explicit model; there is no hidden local-storage or server model default.
- Model-specific reasoning controls now reach the provider request on all those surfaces.
- Recommended OpenAI roles are: Terra/Medium for Green; Sol/High for Red and consequential review;
  Luna/Low for high-volume Coach use; Mini/Medium for a lower-cost Green; Nano/Low for extraction and
  classification, not as a sole trading team.
- Full GPT-5.4 and GPT-5.5 were removed from curated pickers because Terra and Sol are same-price
  current successors. Stored/custom legacy IDs remain callable. GPT-5.4 Mini and Nano remain because
  Luna is newer but more expensive than both.

## Paper-account decision

Deleting broker paper support would remove useful execution-shaped observations: broker acceptance,
order lifecycle behavior, fills, and account-specific model/source comparisons. Owner 2026-08-17:
paper→live pooling stays. The earlier 20-paper+5-live transfer contract is deleted. Paper trains
live, so retrieval pools closed lots across the owner's accounts and the paper execution-cost
default is the same 20 bps constant as OOS walk-forward. A broker paper account is an account.

## Honest residual gaps

1. Source ablation measures the effect of the provider's winning fields on the deterministic score;
   it is not randomized causal attribution and must not auto-reweight sources.
2. Some providers still need richer observed/effective timestamps and upstream-family identifiers.
3. The SEC corpus expansion, immutable artifact archive, and occurrence-level filing provenance are
   owned by the staged 1,000-issuer backfill program; this change improves consumption, not corpus
   completeness.
4. A licensed, point-in-time FMP transcript producer is wired but default off. The current Starter
   credential returns HTTP 402 and the content agreement must permit persistence, embedding,
   retrieval, and excerpt display before both gates are enabled. Speaker/Q&A segmentation and cited
   derived briefs remain deferred until an entitled endpoint supplies representative fixtures.
5. GPT-5.6 recommendation chips are provisional capability/price priors. Today's API benchmark proves
   availability and schema execution, not realized trading superiority. Rotation/model attribution
   must re-rank them from outcomes.
6. Source-value telemetry is model-visible and audited but does not yet have a dedicated operator
   dashboard. Add one after enough directional outcomes exist to avoid presenting noise as insight.

## Activation boundary

This implementation changes code and schema only. It does not write production configuration, start
a corpus backfill, merge to `main`, or claim production behavior. Outcome-linked source/model value
starts accumulating only after the change is reviewed, merged, auto-deployed, and used on real runs.
