// Recorded fixture for the RAG retrieval-quality eval (test/rag-retrieval-eval.test.ts).
//
// Each entry simulates ONE retrieveContextDetailed() call: a query against a symbol, the pool of
// Pinecone matches that call would receive (in COSINE-DESCENDING order, i.e. what Pinecone itself
// returns before rerank/hybrid), and the set of chunk ids that are actually relevant to the query
// (goldRelevantIds). The pool intentionally buries some gold chunks below the naive cosine top-K —
// exactly the case reranking/hybrid exist to fix — so recall@k/MRR is a meaningful signal rather
// than trivially 1.0 regardless of pipeline behavior.
//
// No live Voyage/Pinecone call is involved anywhere in this file — it is pure recorded data.
//
// Ids are hand-authored stable strings, NOT derived from a real ingest run — unlike production
// chunk_ids (randomUUID-based, chunk.ts), these never regenerate, so keying goldRelevantIds on them
// is safe here. (Production callers wiring a REAL corpus into a similar eval should key on
// content_hash instead of chunk_id, since content_hash is the stable SHA-256-derived identifier —
// chunk_id/randomUUID changes on every re-chunk.)
//
// Every chunk carries acceptance_datetime so as-of point-in-time cases are exercisable (see the
// "aapl-8k-asof-guard" case below, which pins asOf and expects a look-ahead chunk excluded).

export interface FixtureMatch {
  id: string;
  /** Cosine similarity Pinecone would have returned for this (query, chunk) pair. */
  score: number;
  text: string;
  doc_type?: string;
  section?: string;
  source?: string;
  /** ISO date this chunk's underlying filing was accepted/published — required so as-of cases are meaningful. */
  acceptance_datetime: string;
}

export interface FixtureCase {
  /** Short id for failure messages. */
  id: string;
  query: string;
  symbol: string;
  /** Pool of candidate matches in cosine-descending order (what Pinecone's query() would return). */
  pool: FixtureMatch[];
  /** Ids of chunks that are actually relevant to the query (ground truth for recall@k / MRR). */
  goldRelevantIds: string[];
  /** Optional point-in-time guard to pass through to retrieveContextDetailed for this case. */
  asOf?: string;
  /**
   * Ids of chunks that are deliberately NOT relevant despite superficial similarity (same ticker,
   * different topic; or a plausible-looking but wrong doc_type) — hard negatives the pipeline must
   * not reward just because they're topically adjacent. Documentation-only (not asserted directly
   * by every test), but the fixture-shape lint below requires every case to have at least one.
   */
  hardNegativeIds?: string[];
}

const DEFAULT_ACCEPTANCE = "2026-05-15";

const mk = (id: string, score: number, text: string, extra: Partial<FixtureMatch> = {}): FixtureMatch => ({
  id,
  score,
  text,
  acceptance_datetime: DEFAULT_ACCEPTANCE,
  ...extra
});

export const RAG_EVAL_FIXTURE: FixtureCase[] = [
  // ── AAPL: supply chain / risk factor ──────────────────────────────────────
  {
    id: "aapl-supply-chain-risk",
    query: "What supply chain risks does Apple disclose in its 10-K?",
    symbol: "AAPL",
    goldRelevantIds: ["aapl-10k-riskfactors-3"],
    hardNegativeIds: ["aapl-10k-business-1", "aapl-10k-mdna-2", "aapl-8k-catalyst-1", "aapl-10k-legal-1"],
    pool: [
      mk("aapl-10k-business-1", 0.52, "Apple designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("aapl-10k-riskfactors-3", 0.47, "The Company's reliance on a limited number of contract manufacturers concentrated in Asia exposes it to supply chain disruption risk, including single-source component suppliers.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("aapl-10k-mdna-2", 0.44, "Net sales increased year over year driven by strong iPhone and Services performance across all geographic segments.", { doc_type: "10-k", section: "MD&A" }),
      mk("aapl-8k-catalyst-1", 0.4, "Catalyst: AAPL filed an 8-K (material event) on 2026-05-01. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("aapl-10k-legal-1", 0.35, "The Company is subject to various legal proceedings and claims that arise in the ordinary course of business.", { doc_type: "10-k", section: "Legal Proceedings" })
    ]
  },
  {
    id: "aapl-services-growth",
    query: "How did Apple's Services performance and net sales trend this year?",
    symbol: "AAPL",
    goldRelevantIds: ["aapl-10k-mdna-2"],
    hardNegativeIds: ["aapl-10k-riskfactors-3", "aapl-10k-business-1", "aapl-10k-generic-distractor"],
    pool: [
      mk("aapl-10k-riskfactors-3", 0.5, "The Company's reliance on a limited number of contract manufacturers concentrated in Asia exposes it to supply chain disruption risk, including single-source component suppliers.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("aapl-10k-mdna-2", 0.48, "Net sales increased year over year driven by strong iPhone and Services performance across all geographic segments.", { doc_type: "10-k", section: "MD&A" }),
      mk("aapl-10k-business-1", 0.41, "Apple designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("aapl-10k-generic-distractor", 0.3, "The Company's effective tax rate may fluctuate as a result of changes in the mix of earnings across jurisdictions.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── TSLA: executive change / 8-K ──────────────────────────────────────────
  {
    id: "tsla-exec-change",
    query: "Did Tesla report a departure of directors or certain officers?",
    symbol: "TSLA",
    goldRelevantIds: ["tsla-8k-item502-1"],
    hardNegativeIds: ["tsla-10k-production-1", "tsla-10k-riskfactors-2", "tsla-10k-mdna-1"],
    pool: [
      mk("tsla-10k-production-1", 0.5, "Vehicle production is concentrated at Gigafactory Texas, Gigafactory Shanghai, and Gigafactory Berlin-Brandenburg.", { doc_type: "10-k", section: "Business" }),
      mk("tsla-10k-riskfactors-2", 0.46, "The unavailability, reduction or elimination of government and economic incentives could materially reduce demand for our vehicles.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("tsla-8k-item502-1", 0.44, "SEC 8-K filing for TSLA. Reported item(s): Item 5.02 Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers.", { doc_type: "8-k" }),
      mk("tsla-10k-mdna-1", 0.4, "Automotive gross margin was impacted by pricing actions taken in response to competitive dynamics.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "tsla-government-incentives",
    query: "How dependent is Tesla on government EV incentives?",
    symbol: "TSLA",
    goldRelevantIds: ["tsla-10k-riskfactors-2"],
    hardNegativeIds: ["tsla-8k-item502-1", "tsla-10k-production-1", "tsla-10k-generic-distractor"],
    pool: [
      mk("tsla-8k-item502-1", 0.49, "SEC 8-K filing for TSLA. Reported item(s): Item 5.02 Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers.", { doc_type: "8-k" }),
      mk("tsla-10k-riskfactors-2", 0.45, "The unavailability, reduction or elimination of government and economic incentives could materially reduce demand for our vehicles.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("tsla-10k-production-1", 0.43, "Vehicle production is concentrated at Gigafactory Texas, Gigafactory Shanghai, and Gigafactory Berlin-Brandenburg.", { doc_type: "10-k", section: "Business" }),
      mk("tsla-10k-generic-distractor", 0.3, "Warranty reserves are estimated based on historical claims experience and expected future claims costs.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── NVDA: export controls, dominant position ──────────────────────────────
  {
    id: "nvda-export-controls",
    query: "What export control restrictions affect Nvidia's chip sales to China?",
    symbol: "NVDA",
    goldRelevantIds: ["nvda-10k-riskfactors-1"],
    hardNegativeIds: ["nvda-10k-business-2", "nvda-10k-mdna-3", "nvda-8k-catalyst-2"],
    pool: [
      mk("nvda-10k-business-2", 0.55, "Our data center platform includes GPUs, networking and software optimized for AI training and inference workloads.", { doc_type: "10-k", section: "Business" }),
      mk("nvda-10k-mdna-3", 0.5, "Data Center revenue grew significantly year over year, driven by demand for our accelerated computing platforms.", { doc_type: "10-k", section: "MD&A" }),
      mk("nvda-10k-riskfactors-1", 0.46, "U.S. government export restrictions on advanced computing products to certain countries, including China, have limited and may continue to limit our ability to sell certain products.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("nvda-8k-catalyst-2", 0.42, "Catalyst: NVDA filed an 8-K (material event) on 2026-05-20. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" })
    ]
  },
  {
    id: "nvda-datacenter-revenue",
    query: "How much of Nvidia's revenue comes from data center GPUs?",
    symbol: "NVDA",
    goldRelevantIds: ["nvda-10k-mdna-3"],
    hardNegativeIds: ["nvda-10k-riskfactors-1", "nvda-10k-business-2", "nvda-10k-generic-distractor"],
    pool: [
      mk("nvda-10k-riskfactors-1", 0.5, "U.S. government export restrictions on advanced computing products to certain countries, including China, have limited and may continue to limit our ability to sell certain products.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("nvda-10k-mdna-3", 0.47, "Data Center revenue grew significantly year over year, driven by demand for our accelerated computing platforms.", { doc_type: "10-k", section: "MD&A" }),
      mk("nvda-10k-business-2", 0.44, "Our data center platform includes GPUs, networking and software optimized for AI training and inference workloads.", { doc_type: "10-k", section: "Business" }),
      mk("nvda-10k-generic-distractor", 0.3, "Our gross margin can vary significantly based on product mix and manufacturing costs across quarters.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── MSFT: cloud + antitrust ────────────────────────────────────────────────
  {
    id: "msft-azure-growth",
    query: "What is driving Microsoft Azure's growth?",
    symbol: "MSFT",
    goldRelevantIds: ["msft-10k-mdna-1"],
    hardNegativeIds: ["msft-10k-riskfactors-4", "msft-10k-business-3", "msft-10k-generic-distractor"],
    pool: [
      mk("msft-10k-riskfactors-4", 0.48, "We face intense competition across all markets for our products and services, which may harm our business and financial performance.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("msft-10k-mdna-1", 0.45, "Intelligent Cloud revenue increased, driven by growth in Azure and other cloud services consumption-based revenue.", { doc_type: "10-k", section: "MD&A" }),
      mk("msft-10k-business-3", 0.4, "Microsoft develops, licenses and supports a wide range of software, services, devices and solutions.", { doc_type: "10-k", section: "Business" }),
      mk("msft-10k-generic-distractor", 0.3, "Foreign currency exchange rate fluctuations affect the reported value of our international operations.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "msft-antitrust-scrutiny",
    query: "Is Microsoft facing regulatory or antitrust scrutiny?",
    symbol: "MSFT",
    goldRelevantIds: ["msft-10k-legal-2"],
    hardNegativeIds: ["msft-10k-mdna-1", "msft-10k-riskfactors-4", "msft-10k-generic-distractor"],
    pool: [
      mk("msft-10k-mdna-1", 0.47, "Intelligent Cloud revenue increased, driven by growth in Azure and other cloud services consumption-based revenue.", { doc_type: "10-k", section: "MD&A" }),
      mk("msft-10k-legal-2", 0.43, "Regulatory authorities in the United States and European Union continue to scrutinize our business practices under antitrust and competition laws.", { doc_type: "10-k", section: "Legal Proceedings" }),
      mk("msft-10k-riskfactors-4", 0.41, "We face intense competition across all markets for our products and services, which may harm our business and financial performance.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("msft-10k-generic-distractor", 0.3, "Foreign currency exchange rate fluctuations affect the reported value of our international operations.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── AMZN: logistics + AWS ──────────────────────────────────────────────────
  {
    id: "amzn-aws-margin",
    query: "What are AWS operating margins like?",
    symbol: "AMZN",
    goldRelevantIds: ["amzn-10k-mdna-2"],
    hardNegativeIds: ["amzn-10k-business-1", "amzn-8k-catalyst-3", "amzn-10k-generic-distractor"],
    pool: [
      mk("amzn-10k-business-1", 0.5, "We seek to be Earth's most customer-centric company through our online and physical stores and other initiatives.", { doc_type: "10-k", section: "Business" }),
      mk("amzn-10k-mdna-2", 0.46, "AWS segment operating income and operating margin improved due to cost optimization efforts and increased sales.", { doc_type: "10-k", section: "MD&A" }),
      mk("amzn-8k-catalyst-3", 0.43, "Catalyst: AMZN filed an 8-K (material event) on 2026-04-28. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("amzn-10k-generic-distractor", 0.3, "Our capital expenditures include investments in technology infrastructure to support long-term growth.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "amzn-fulfillment-network",
    query: "How is Amazon's fulfillment network structured?",
    symbol: "AMZN",
    goldRelevantIds: ["amzn-10k-business-3"],
    hardNegativeIds: ["amzn-10k-mdna-2", "amzn-10k-riskfactors-5", "amzn-10k-generic-distractor"],
    pool: [
      mk("amzn-10k-mdna-2", 0.49, "AWS segment operating income and operating margin improved due to cost optimization efforts and increased sales.", { doc_type: "10-k", section: "MD&A" }),
      mk("amzn-10k-business-3", 0.45, "Our fulfillment network includes fulfillment centers, sortation centers, and delivery stations located across multiple regions.", { doc_type: "10-k", section: "Business" }),
      mk("amzn-10k-riskfactors-5", 0.4, "Our international operations expose us to numerous risks including foreign currency exchange rate fluctuations.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("amzn-10k-generic-distractor", 0.3, "Our capital expenditures include investments in technology infrastructure to support long-term growth.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── GOOGL: search dominance + ad revenue ──────────────────────────────────
  {
    id: "googl-ad-revenue",
    query: "What share of consolidated revenues comes from Google Search advertising?",
    symbol: "GOOGL",
    goldRelevantIds: ["googl-10k-mdna-1"],
    hardNegativeIds: ["googl-10k-business-2", "googl-10k-riskfactors-6", "googl-10k-generic-distractor"],
    pool: [
      mk("googl-10k-business-2", 0.5, "Alphabet is a collection of businesses, the largest of which is Google, organized around the goal of organizing the world's information.", { doc_type: "10-k", section: "Business" }),
      mk("googl-10k-mdna-1", 0.47, "Google Search & other advertising revenues represented the majority of consolidated revenues this fiscal year.", { doc_type: "10-k", section: "MD&A" }),
      mk("googl-10k-riskfactors-6", 0.42, "New and existing technologies may increasingly enable users to bypass online advertisements, adversely affecting revenue.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("googl-10k-generic-distractor", 0.3, "Our effective tax rate depends on the geographic distribution of our earnings and changes in tax law.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "googl-ad-blocking-risk",
    query: "Could new technologies let users bypass online advertisements and hurt revenue?",
    symbol: "GOOGL",
    goldRelevantIds: ["googl-10k-riskfactors-6"],
    hardNegativeIds: ["googl-10k-mdna-1", "googl-10k-business-2", "googl-10k-generic-distractor"],
    pool: [
      mk("googl-10k-mdna-1", 0.5, "Google Search & other advertising revenues represented the majority of consolidated revenues this fiscal year.", { doc_type: "10-k", section: "MD&A" }),
      mk("googl-10k-riskfactors-6", 0.45, "New and existing technologies may increasingly enable users to bypass online advertisements, adversely affecting revenue.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("googl-10k-business-2", 0.42, "Alphabet is a collection of businesses, the largest of which is Google, organized around the goal of organizing the world's information.", { doc_type: "10-k", section: "Business" }),
      mk("googl-10k-generic-distractor", 0.3, "Our effective tax rate depends on the geographic distribution of our earnings and changes in tax law.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── META: metaverse spend + ad targeting ──────────────────────────────────
  {
    id: "meta-reality-labs-losses",
    query: "How much is Meta losing on Reality Labs?",
    symbol: "META",
    goldRelevantIds: ["meta-10k-mdna-3"],
    hardNegativeIds: ["meta-10k-business-1", "meta-10k-riskfactors-7", "meta-10k-generic-distractor"],
    pool: [
      mk("meta-10k-business-1", 0.48, "Our mission is to give people the power to build community and bring the world closer together.", { doc_type: "10-k", section: "Business" }),
      mk("meta-10k-mdna-3", 0.44, "Reality Labs segment operating losses increased due to continued investment in augmented and virtual reality initiatives.", { doc_type: "10-k", section: "MD&A" }),
      mk("meta-10k-riskfactors-7", 0.41, "Changes to operating systems or platform policies of third parties like Apple could adversely affect our advertising business.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("meta-10k-generic-distractor", 0.3, "Headcount and infrastructure costs are the primary drivers of our total costs and expenses.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "meta-platform-policy-risk",
    query: "How do Apple's platform policies affect Meta's ad targeting?",
    symbol: "META",
    goldRelevantIds: ["meta-10k-riskfactors-7"],
    hardNegativeIds: ["meta-10k-mdna-3", "meta-10k-business-1", "meta-10k-generic-distractor"],
    pool: [
      mk("meta-10k-mdna-3", 0.47, "Reality Labs segment operating losses increased due to continued investment in augmented and virtual reality initiatives.", { doc_type: "10-k", section: "MD&A" }),
      mk("meta-10k-riskfactors-7", 0.43, "Changes to operating systems or platform policies of third parties like Apple could adversely affect our advertising business.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("meta-10k-business-1", 0.4, "Our mission is to give people the power to build community and bring the world closer together.", { doc_type: "10-k", section: "Business" }),
      mk("meta-10k-generic-distractor", 0.3, "Headcount and infrastructure costs are the primary drivers of our total costs and expenses.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── JPM: rate sensitivity + credit losses ─────────────────────────────────
  {
    id: "jpm-rate-sensitivity",
    query: "How sensitive is JPMorgan's net interest income to interest rate changes?",
    symbol: "JPM",
    goldRelevantIds: ["jpm-10k-riskfactors-8"],
    hardNegativeIds: ["jpm-10k-business-4", "jpm-10k-mdna-4", "jpm-10k-generic-distractor"],
    pool: [
      mk("jpm-10k-business-4", 0.5, "JPMorgan Chase is a leading global financial services firm with operations worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("jpm-10k-riskfactors-8", 0.46, "Our net interest income is sensitive to changes in market interest rates, and rate volatility can materially affect our results.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("jpm-10k-mdna-4", 0.42, "Provision for credit losses increased reflecting portfolio growth and a modestly less favorable macroeconomic outlook.", { doc_type: "10-k", section: "MD&A" }),
      mk("jpm-10k-generic-distractor", 0.3, "Our capital ratios remained above regulatory minimums throughout the reporting period.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "jpm-credit-loss-provision",
    query: "Did JPMorgan increase its credit loss provisions?",
    symbol: "JPM",
    goldRelevantIds: ["jpm-10k-mdna-4"],
    hardNegativeIds: ["jpm-10k-riskfactors-8", "jpm-10k-business-4", "jpm-10k-generic-distractor"],
    pool: [
      mk("jpm-10k-riskfactors-8", 0.49, "Our net interest income is sensitive to changes in market interest rates, and rate volatility can materially affect our results.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("jpm-10k-mdna-4", 0.44, "Provision for credit losses increased reflecting portfolio growth and a modestly less favorable macroeconomic outlook.", { doc_type: "10-k", section: "MD&A" }),
      mk("jpm-10k-business-4", 0.4, "JPMorgan Chase is a leading global financial services firm with operations worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("jpm-10k-generic-distractor", 0.3, "Our capital ratios remained above regulatory minimums throughout the reporting period.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── XOM: commodity price exposure ─────────────────────────────────────────
  {
    id: "xom-oil-price-exposure",
    query: "How exposed is ExxonMobil's earnings to crude oil prices?",
    symbol: "XOM",
    goldRelevantIds: ["xom-10k-riskfactors-9"],
    hardNegativeIds: ["xom-10k-business-5", "xom-8k-catalyst-4", "xom-10k-generic-distractor"],
    pool: [
      mk("xom-10k-business-5", 0.5, "ExxonMobil explores for, produces and sells crude oil and natural gas, and manufactures petroleum products.", { doc_type: "10-k", section: "Business" }),
      mk("xom-10k-riskfactors-9", 0.45, "Our results of operations and cash flows are significantly affected by crude oil and natural gas prices, which are subject to substantial volatility.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("xom-8k-catalyst-4", 0.41, "Catalyst: XOM filed an 8-K (material event) on 2026-05-10. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("xom-10k-generic-distractor", 0.3, "Capital and exploration expenditures are allocated across upstream, downstream, and chemical segments.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── Multi-doc-type: 8-K catalyst freshness ────────────────────────────────
  {
    id: "aapl-recent-catalyst",
    query: "Any recent 8-K catalysts for AAPL?",
    symbol: "AAPL",
    goldRelevantIds: ["aapl-8k-catalyst-1"],
    hardNegativeIds: ["aapl-10k-business-1", "aapl-10k-riskfactors-3", "aapl-10k-generic-distractor"],
    pool: [
      mk("aapl-10k-business-1", 0.45, "Apple designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("aapl-8k-catalyst-1", 0.43, "Catalyst: AAPL filed an 8-K (material event) on 2026-05-01. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("aapl-10k-riskfactors-3", 0.4, "The Company's reliance on a limited number of contract manufacturers concentrated in Asia exposes it to supply chain disruption risk, including single-source component suppliers.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("aapl-10k-generic-distractor", 0.3, "The Company's effective tax rate may fluctuate as a result of changes in the mix of earnings across jurisdictions.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "nvda-recent-catalyst",
    query: "Any recent 8-K catalysts for NVDA?",
    symbol: "NVDA",
    goldRelevantIds: ["nvda-8k-catalyst-2"],
    hardNegativeIds: ["nvda-10k-mdna-3", "nvda-10k-riskfactors-1", "nvda-10k-generic-distractor"],
    pool: [
      mk("nvda-10k-mdna-3", 0.46, "Data Center revenue grew significantly year over year, driven by demand for our accelerated computing platforms.", { doc_type: "10-k", section: "MD&A" }),
      mk("nvda-8k-catalyst-2", 0.44, "Catalyst: NVDA filed an 8-K (material event) on 2026-05-20. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("nvda-10k-riskfactors-1", 0.4, "U.S. government export restrictions on advanced computing products to certain countries, including China, have limited and may continue to limit our ability to sell certain products.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("nvda-10k-generic-distractor", 0.3, "Our gross margin can vary significantly based on product mix and manufacturing costs across quarters.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── Exact-term / ticker-heavy queries (favor hybrid BM25 lexical matching) ─
  {
    id: "amzn-exact-term-fulfillment",
    query: "fulfillment centers sortation centers delivery stations",
    symbol: "AMZN",
    goldRelevantIds: ["amzn-10k-business-3"],
    hardNegativeIds: ["amzn-10k-mdna-2", "amzn-10k-riskfactors-5", "amzn-10k-generic-distractor"],
    pool: [
      mk("amzn-10k-mdna-2", 0.5, "AWS segment operating income and operating margin improved due to cost optimization efforts and increased sales.", { doc_type: "10-k", section: "MD&A" }),
      mk("amzn-10k-riskfactors-5", 0.47, "Our international operations expose us to numerous risks including foreign currency exchange rate fluctuations.", { doc_type: "10-k", section: "Risk Factors" }),
      // Deliberately LOW cosine rank (3rd) despite being the exact lexical match — this is the case
      // hybrid BM25/RRF is meant to recover.
      mk("amzn-10k-business-3", 0.38, "Our fulfillment network includes fulfillment centers, sortation centers, and delivery stations located across multiple regions.", { doc_type: "10-k", section: "Business" }),
      mk("amzn-10k-generic-distractor", 0.3, "Our capital expenditures include investments in technology infrastructure to support long-term growth.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "jpm-exact-term-provision",
    query: "provision for credit losses",
    symbol: "JPM",
    goldRelevantIds: ["jpm-10k-mdna-4"],
    hardNegativeIds: ["jpm-10k-business-4", "jpm-10k-riskfactors-8", "jpm-10k-generic-distractor"],
    pool: [
      mk("jpm-10k-business-4", 0.5, "JPMorgan Chase is a leading global financial services firm with operations worldwide.", { doc_type: "10-k", section: "Business" }),
      mk("jpm-10k-riskfactors-8", 0.47, "Our net interest income is sensitive to changes in market interest rates, and rate volatility can materially affect our results.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("jpm-10k-mdna-4", 0.39, "Provision for credit losses increased reflecting portfolio growth and a modestly less favorable macroeconomic outlook.", { doc_type: "10-k", section: "MD&A" }),
      mk("jpm-10k-generic-distractor", 0.3, "Our capital ratios remained above regulatory minimums throughout the reporting period.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── Additional coverage to reach ~25-30 queries ────────────────────────────
  {
    id: "tsla-margin-pressure",
    query: "Why did Tesla's automotive gross margin decline?",
    symbol: "TSLA",
    goldRelevantIds: ["tsla-10k-mdna-1"],
    hardNegativeIds: ["tsla-10k-riskfactors-2", "tsla-10k-production-1", "tsla-10k-generic-distractor"],
    pool: [
      mk("tsla-10k-riskfactors-2", 0.48, "The unavailability, reduction or elimination of government and economic incentives could materially reduce demand for our vehicles.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("tsla-10k-mdna-1", 0.44, "Automotive gross margin was impacted by pricing actions taken in response to competitive dynamics.", { doc_type: "10-k", section: "MD&A" }),
      mk("tsla-10k-production-1", 0.41, "Vehicle production is concentrated at Gigafactory Texas, Gigafactory Shanghai, and Gigafactory Berlin-Brandenburg.", { doc_type: "10-k", section: "Business" }),
      mk("tsla-10k-generic-distractor", 0.3, "Warranty reserves are estimated based on historical claims experience and expected future claims costs.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "msft-competition-risk",
    query: "What competitive risks does Microsoft face?",
    symbol: "MSFT",
    goldRelevantIds: ["msft-10k-riskfactors-4"],
    hardNegativeIds: ["msft-10k-mdna-1", "msft-10k-legal-2", "msft-10k-generic-distractor"],
    pool: [
      mk("msft-10k-mdna-1", 0.48, "Intelligent Cloud revenue increased, driven by growth in Azure and other cloud services consumption-based revenue.", { doc_type: "10-k", section: "MD&A" }),
      mk("msft-10k-legal-2", 0.44, "Regulatory authorities in the United States and European Union continue to scrutinize our business practices under antitrust and competition laws.", { doc_type: "10-k", section: "Legal Proceedings" }),
      mk("msft-10k-riskfactors-4", 0.42, "We face intense competition across all markets for our products and services, which may harm our business and financial performance.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("msft-10k-generic-distractor", 0.3, "Foreign currency exchange rate fluctuations affect the reported value of our international operations.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "googl-business-overview",
    query: "What businesses make up Alphabet?",
    symbol: "GOOGL",
    goldRelevantIds: ["googl-10k-business-2"],
    hardNegativeIds: ["googl-10k-mdna-1", "googl-10k-riskfactors-6", "googl-10k-generic-distractor"],
    pool: [
      mk("googl-10k-mdna-1", 0.49, "Google Search & other advertising revenues represented the majority of consolidated revenues this fiscal year.", { doc_type: "10-k", section: "MD&A" }),
      mk("googl-10k-business-2", 0.45, "Alphabet is a collection of businesses, the largest of which is Google, organized around the goal of organizing the world's information.", { doc_type: "10-k", section: "Business" }),
      mk("googl-10k-riskfactors-6", 0.4, "New and existing technologies may increasingly enable users to bypass online advertisements, adversely affecting revenue.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("googl-10k-generic-distractor", 0.3, "Our effective tax rate depends on the geographic distribution of our earnings and changes in tax law.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "meta-mission-statement",
    query: "What is Meta's stated corporate mission?",
    symbol: "META",
    goldRelevantIds: ["meta-10k-business-1"],
    hardNegativeIds: ["meta-10k-mdna-3", "meta-10k-riskfactors-7", "meta-10k-generic-distractor"],
    pool: [
      mk("meta-10k-mdna-3", 0.47, "Reality Labs segment operating losses increased due to continued investment in augmented and virtual reality initiatives.", { doc_type: "10-k", section: "MD&A" }),
      mk("meta-10k-riskfactors-7", 0.43, "Changes to operating systems or platform policies of third parties like Apple could adversely affect our advertising business.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("meta-10k-business-1", 0.4, "Our mission is to give people the power to build community and bring the world closer together.", { doc_type: "10-k", section: "Business" }),
      mk("meta-10k-generic-distractor", 0.3, "Headcount and infrastructure costs are the primary drivers of our total costs and expenses.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "xom-business-overview",
    query: "What is ExxonMobil's core business?",
    symbol: "XOM",
    goldRelevantIds: ["xom-10k-business-5"],
    hardNegativeIds: ["xom-10k-riskfactors-9", "xom-8k-catalyst-4", "xom-10k-generic-distractor"],
    pool: [
      mk("xom-10k-riskfactors-9", 0.47, "Our results of operations and cash flows are significantly affected by crude oil and natural gas prices, which are subject to substantial volatility.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("xom-8k-catalyst-4", 0.43, "Catalyst: XOM filed an 8-K (material event) on 2026-05-10. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k" }),
      mk("xom-10k-business-5", 0.4, "ExxonMobil explores for, produces and sells crude oil and natural gas, and manufactures petroleum products.", { doc_type: "10-k", section: "Business" }),
      mk("xom-10k-generic-distractor", 0.3, "Capital and exploration expenditures are allocated across upstream, downstream, and chemical segments.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "aapl-legal-proceedings",
    query: "Is Apple involved in any material legal proceedings?",
    symbol: "AAPL",
    goldRelevantIds: ["aapl-10k-legal-1"],
    hardNegativeIds: ["aapl-10k-riskfactors-3", "aapl-10k-mdna-2", "aapl-10k-generic-distractor"],
    pool: [
      mk("aapl-10k-riskfactors-3", 0.46, "The Company's reliance on a limited number of contract manufacturers concentrated in Asia exposes it to supply chain disruption risk, including single-source component suppliers.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("aapl-10k-mdna-2", 0.43, "Net sales increased year over year driven by strong iPhone and Services performance across all geographic segments.", { doc_type: "10-k", section: "MD&A" }),
      mk("aapl-10k-legal-1", 0.39, "The Company is subject to various legal proceedings and claims that arise in the ordinary course of business.", { doc_type: "10-k", section: "Legal Proceedings" }),
      mk("aapl-10k-generic-distractor", 0.3, "The Company's effective tax rate may fluctuate as a result of changes in the mix of earnings across jurisdictions.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  {
    id: "tsla-8k-explicit-item",
    query: "Item 5.02 officer departure Tesla",
    symbol: "TSLA",
    goldRelevantIds: ["tsla-8k-item502-1"],
    hardNegativeIds: ["tsla-10k-mdna-1", "tsla-10k-riskfactors-2", "tsla-10k-generic-distractor-2"],
    pool: [
      mk("tsla-10k-mdna-1", 0.5, "Automotive gross margin was impacted by pricing actions taken in response to competitive dynamics.", { doc_type: "10-k", section: "MD&A" }),
      mk("tsla-10k-riskfactors-2", 0.46, "The unavailability, reduction or elimination of government and economic incentives could materially reduce demand for our vehicles.", { doc_type: "10-k", section: "Risk Factors" }),
      mk("tsla-8k-item502-1", 0.36, "SEC 8-K filing for TSLA. Reported item(s): Item 5.02 Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers.", { doc_type: "8-k" }),
      mk("tsla-10k-generic-distractor-2", 0.3, "Warranty reserves are estimated based on historical claims experience and expected future claims costs.", { doc_type: "10-k", section: "MD&A" })
    ]
  },
  // ── Explicit as-of / point-in-time guard case (C1 expert-review correction) ────────────────────
  // A dedicated case pinning `asOf` so isWithinAsOf is actually exercised by this harness: the most
  // topically relevant chunk is a LOOK-AHEAD filing (accepted after asOf) that must be excluded, so
  // the correct answer under the guard is an OLDER, still-relevant chunk instead.
  {
    id: "aapl-8k-asof-guard",
    query: "Any recent 8-K catalysts for AAPL?",
    symbol: "AAPL",
    asOf: "2026-04-15",
    goldRelevantIds: ["aapl-8k-catalyst-older"],
    hardNegativeIds: ["aapl-8k-catalyst-future", "aapl-10k-business-1"],
    pool: [
      // Cosine ranks this highest, but it is dated AFTER asOf — the guard must exclude it as
      // look-ahead, even though it would otherwise "win" on both cosine and lexical relevance.
      mk("aapl-8k-catalyst-future", 0.55, "Catalyst: AAPL filed an 8-K (material event) on 2026-05-01. Items: Item 2.02 Results of Operations and Financial Condition.", { doc_type: "8-k", acceptance_datetime: "2026-05-01" }),
      mk("aapl-8k-catalyst-older", 0.4, "Catalyst: AAPL filed an 8-K (material event) on 2026-03-20. Items: Item 5.02 Departure of Directors or Certain Officers.", { doc_type: "8-k", acceptance_datetime: "2026-03-20" }),
      mk("aapl-10k-business-1", 0.35, "Apple designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories worldwide.", { doc_type: "10-k", section: "Business", acceptance_datetime: "2026-01-15" })
    ]
  }
];
