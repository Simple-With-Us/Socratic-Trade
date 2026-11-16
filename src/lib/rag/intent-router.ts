export type SearchIntent = "lexical" | "semantic" | "hybrid";

/**
 * Heuristically classifies a financial retrieval query into a retrieval intent:
 * - 'lexical': Match via FTS5 keyword index only (good for exact GAAP metrics, numbers, sections).
 * - 'semantic': Match via Pinecone dense vectors only (good for conceptual, narrative, strategic queries).
 * - 'hybrid': Match via both lexical and vector, fusing the results (default).
 */
export function routeRetrievalIntent(query: string): SearchIntent {
  const clean = query.trim().toLowerCase();
  if (!clean) return "hybrid";

  // Lexical triggers (exact metrics, table values, GAAP codes, reporting periods)
  const lexicalKeywords = [
    "revenue",
    "profit",
    "income",
    "ebitda",
    "gaap",
    "eps",
    "dividend",
    "liabilities",
    "assets",
    "debt",
    "cash flow",
    "footnote",
    "item 1a",
    "item 7",
    "item 8",
    "q1",
    "q2",
    "q3",
    "q4",
    "10-k",
    "10-q",
    "exdoc",
    "exhibit",
    "$",
    "million",
    "billion",
    "percent",
    "%"
  ];

  // Semantic triggers (narrative strategy, risk descriptions, industry context)
  const semanticKeywords = [
    "strategy",
    "outlook",
    "competitor",
    "competitors",
    "competition",
    "trend",
    "trends",
    "risk factors",
    "supply chain",
    "macro",
    "growth opportunities",
    "management view",
    "culture",
    "regulatory impact",
    "geopolitical",
    "climate change"
  ];

  // Check if query contains year numbers (like 2024, 2025)
  const hasYear = /\b20\d{2}\b/.test(clean);
  const hasLexical = lexicalKeywords.some((kw) => clean.includes(kw)) || hasYear;
  const hasSemantic = semanticKeywords.some((kw) => clean.includes(kw));

  if (hasLexical && !hasSemantic) {
    return "lexical";
  }
  if (hasSemantic && !hasLexical) {
    return "semantic";
  }
  return "hybrid";
}
