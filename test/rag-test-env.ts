
/** Pin RAG quality flags OFF so tests that assert byte-identical / topK / no-audit behavior
 *  stay independent of production defaults (owner enablement 2026-07-24: many flags default ON). */
export function pinRagQualityFlagsOff(env: NodeJS.ProcessEnv = process.env): void {
  env.RAG_ADAPTIVE_RERANK = "off";
  env.RAG_APPLY_DEFAULT_FLOORS = "off";
  env.RAG_RETRIEVAL_TELEMETRY = "off";
  env.RAG_RETRIEVAL_STAGE_TELEMETRY = "off";
  env.RAG_PARENT_CONTEXT_EXPANSION = "off";
  env.RAG_CORPUS_WIDE_LEXICAL = "off";
  env.RAG_RUN_BUDGET_ENABLED = "off";
  env.RAG_CITATION_STALENESS = "off";
  env.VECTOR_ASOF_SERVER_FILTER = "off";
  env.HYBRID_RETRIEVAL = "off";
  env.RAG_MULTIQUERY = "off";
  env.RAG_HYDE = "off";
  env.RAG_PERSIST_CANDIDATE_POOL = "off";
  env.RAG_PERSIST_CANDIDATE_POOL_FULL = "off";
}
