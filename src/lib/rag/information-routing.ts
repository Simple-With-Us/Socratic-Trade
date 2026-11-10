/**
 * Declared information needs determine the data path. This is deliberately not a
 * natural-language classifier: callers state what they need, unknown values are
 * rejected, and only narrative sources can produce a semantic-retrieval plan.
 */
export const STRUCTURED_INFORMATION_NEEDS = [
  "current_market_quote",
  "portfolio_state",
  "open_orders",
  "financial_facts",
  "insider_transactions"
] as const;

export const SEMANTIC_INFORMATION_NEEDS = [
  "filing_narrative",
  "earnings_transcript_narrative",
  "lesson_narrative",
  "research_narrative"
] as const;

export type StructuredInformationNeed = (typeof STRUCTURED_INFORMATION_NEEDS)[number];
export type SemanticInformationNeed = (typeof SEMANTIC_INFORMATION_NEEDS)[number];
export type InformationNeed = StructuredInformationNeed | SemanticInformationNeed;

type StructuredSourceKind = "market" | "portfolio" | "orders" | "financial_facts" | "insider_transactions";

const INFORMATION_NEED_SPECS: Record<InformationNeed, {
  channel: "structured" | "semantic";
  structuredSource?: StructuredSourceKind;
  documentTypes?: readonly string[];
}> = {
  current_market_quote: { channel: "structured", structuredSource: "market" },
  portfolio_state: { channel: "structured", structuredSource: "portfolio" },
  open_orders: { channel: "structured", structuredSource: "orders" },
  financial_facts: { channel: "structured", structuredSource: "financial_facts" },
  insider_transactions: { channel: "structured", structuredSource: "insider_transactions" },
  // Full filings + compact document-summary abstracts (trade-relevant highlights for the LLM).
  // 2026-09-27 breadth: DEF 14A / S-1 / ownership filings / 13F holdings are now in the corpus
  // (they come in with the same lowercase form code the ingest path stores, e.g. "def 14a",
  // "s-1", plus the two dedicated doc types below), so a filing question has to be allowed to
  // reach them. doc_type is a filter, not a claim: adding a form to the corpus without adding it
  // here is exactly how the 13F positions stayed invisible.
  filing_narrative: {
    channel: "semantic",
    documentTypes: [
      "10-k",
      "10-q",
      "8-k",
      "def 14a",
      "s-1",
      "13f-holdings",
      "insider-filing",
      "document-summary"
    ]
  },
  // Full call text + earnings-summary abstracts when the document-summarizer has run.
  earnings_transcript_narrative: {
    channel: "semantic",
    documentTypes: ["earnings-transcript", "earnings-summary"]
  },
  lesson_narrative: { channel: "semantic", documentTypes: ["lesson"] },
  research_narrative: { channel: "semantic", documentTypes: ["research", "document-summary"] }
};

export interface InformationRoutingPlan {
  structured: {
    needs: StructuredInformationNeed[];
    sourceKinds: StructuredSourceKind[];
  };
  semantic: {
    needs: SemanticInformationNeed[];
    documentTypes: string[];
  };
  /** Unknown or malformed caller declarations are intentionally not routed anywhere. */
  rejected: string[];
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function hasInformationNeed(value: string): value is InformationNeed {
  return Object.hasOwn(INFORMATION_NEED_SPECS, value);
}

/**
 * Builds independent deterministic and semantic plans from caller-declared needs.
 * There is no default semantic route: an empty or unknown declaration cannot cause
 * a vector/lexical lookup.
 */
export function routeInformationNeeds(needs: readonly unknown[]): InformationRoutingPlan {
  const structuredNeeds: StructuredInformationNeed[] = [];
  const semanticNeeds: SemanticInformationNeed[] = [];
  const structuredSources: StructuredSourceKind[] = [];
  const documentTypes: string[] = [];
  const rejected: string[] = [];

  for (const rawNeed of needs) {
    if (typeof rawNeed !== "string") {
      rejected.push("<non-string>");
      continue;
    }
    const need = rawNeed.trim();
    if (!hasInformationNeed(need)) {
      rejected.push(need);
      continue;
    }
    const spec = INFORMATION_NEED_SPECS[need];
    if (spec.channel === "structured") {
      structuredNeeds.push(need as StructuredInformationNeed);
      if (spec.structuredSource) structuredSources.push(spec.structuredSource);
      continue;
    }
    semanticNeeds.push(need as SemanticInformationNeed);
    documentTypes.push(...(spec.documentTypes ?? []));
  }

  return {
    structured: { needs: unique(structuredNeeds), sourceKinds: unique(structuredSources) },
    semantic: { needs: unique(semanticNeeds), documentTypes: unique(documentTypes) },
    rejected: unique(rejected)
  };
}

/**
 * The strategy's deterministic per-symbol filings-retrieval query. Shared between the live
 * retrieval pass (strategy.ts) and the lookahead audit's truncated replay
 * (src/lib/lookahead-audit.ts), which reconstructs this exact string from a persisted decision
 * and verifies it against the candidate pool's stored queryHash — so a future wording change here
 * degrades old decisions to an honest 'unverifiable', never a silent false mismatch.
 */
export function deterministicFilingsRetrievalQuery(symbol: string): string {
  return `Significant financial events, SEC filings, and macro catalysts for ${symbol}`;
}

/** Strategy currently has explicit structured inputs plus filing/transcript narrative needs. */
export function strategyInformationRouting(includeEarningsTranscripts: boolean): InformationRoutingPlan {
  return routeInformationNeeds([
    "current_market_quote",
    "portfolio_state",
    "open_orders",
    "financial_facts",
    "insider_transactions",
    "filing_narrative",
    ...(includeEarningsTranscripts ? ["earnings_transcript_narrative"] : [])
  ]);
}
