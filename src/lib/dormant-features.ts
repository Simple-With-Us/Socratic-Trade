/**
 * Operator-facing inventory of dormant / gated features and whether each is ready to enable.
 * Used by admin RAG coverage so enablement is a checklist, not archaeology.
 *
 * Deliberately DB-/vector-db-free (envFlagOn only) so the route can import it without pulling
 * the Pinecone stack into cold admin paths.
 */
import { envFlagOn, type EnvSource } from "./rag/env-flag";
import { landingPageEnabled } from "./landing-page";

export type DormantFeatureStatus = {
  id: string;
  flag: string;
  enabled: boolean;
  readyToEnable: boolean;
  defaultWhenUnset: "on" | "off";
  blocker?: string;
  note: string;
};

function flagOn(name: string, default_: boolean, env: EnvSource): boolean {
  return envFlagOn(name, default_, env);
}

export function listDormantFeatureStatus(env: EnvSource = process.env): DormantFeatureStatus[] {
  const cleanText = flagOn("VECTOR_EMBED_CLEAN_TEXT", false, env);
  return [
    {
      id: "landing-page",
      flag: "LANDING_PAGE_ENABLED",
      enabled: landingPageEnabled(env),
      readyToEnable: true,
      defaultWhenUnset: "on",
      note: "Marketing /welcome + /how-it-works. Unset=on since 2026-07-03; set off to 404 both paths."
    },
    {
      id: "csp-report-only",
      flag: "CSP_ENABLED",
      enabled: flagOn("CSP_ENABLED", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Safe as report-only (CSP_REPORT_ONLY unset/on). Reports POST to /api/csp-report. Do not set CSP_REPORT_ONLY=off until telemetry is clean."
    },
    {
      id: "usage-budget-enforce",
      flag: "USAGE_BUDGET_ENFORCE",
      enabled: flagOn("USAGE_BUDGET_ENFORCE", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Code-ready. When on, over-budget LLM providers can downgrade/skip cycles. Fail-open on monitor outage."
    },
    {
      id: "vector-embed-clean-text",
      flag: "VECTOR_EMBED_CLEAN_TEXT",
      enabled: cleanText,
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: cleanText
        ? "ON: new vectors stamp embed_rev=2 (clean representation). Reindex/backfill before treating the corpus as one space."
        : "OFF: new vectors stamp embed_rev=1. Enabling bumps to embed_rev=2 automatically so mixed populations stay distinguishable."
    },
    {
      id: "vector-asof-strict",
      flag: "VECTOR_ASOF_STRICT",
      enabled: flagOn("VECTOR_ASOF_STRICT", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Needs as_of_epoch_ms coverage proof on the live index before fail-closed undated drops.",
      note: "Fail-closed PIT filter. Keep off until undated/un-epoch'd inventory is acceptable."
    },
    {
      id: "rag-multiquery",
      flag: "RAG_MULTIQUERY",
      enabled: flagOn("RAG_MULTIQUERY", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Paid embed/query amplification — need cost canary + run-budget headroom first.",
      note: "Facet sub-queries per filings pass. Pair with RAG_RUN_BUDGET_ENABLED (already on)."
    },
    {
      id: "rag-hyde",
      flag: "RAG_HYDE",
      enabled: flagOn("RAG_HYDE", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Requires RAG_MULTIQUERY on; adds an LLM draft call per pass.",
      note: "Highest cost retrieval tier. Enable only after MULTIQUERY value proof."
    },
    {
      id: "rag-embed-disclosures",
      flag: "RAG_EMBED_DISCLOSURES",
      enabled: flagOn("RAG_EMBED_DISCLOSURES", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Product/cost decision only — parser path is tested. Expect Voyage/Pinecone spend."
    },
    {
      id: "sec8k-full-body",
      flag: "WEB_SOURCE_SEC8K_FULL_BODY",
      enabled: flagOn("WEB_SOURCE_SEC8K_FULL_BODY", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Needs FTS/corpus budget headroom + backlog health visibility before always-on.",
      note: "Full 8-K body ingest into RAG. Limit via WEB_SOURCE_SEC8K_FULL_BODY_LIMIT."
    },
    {
      id: "sec-ingest-worker",
      flag: "SEC_INGEST_WORKER_ENABLED",
      enabled: flagOn("SEC_INGEST_WORKER_ENABLED", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Ops: seed jobs via /api/admin/sec-ingest and confirm queue/DLQ health first.",
      note: "Background SEC backfill worker. Default off; admin seed is the canary."
    },
    {
      id: "fmp-transcripts",
      flag: "WEB_SOURCE_FMP_TRANSCRIPTS + FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED",
      enabled:
        flagOn("WEB_SOURCE_FMP_TRANSCRIPTS", false, env) &&
        flagOn("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Dual gate: entitled FMP plan + owner commercial storage-rights confirmation.",
      note: "Do not enable on rights alone without plan entitlement (402 → endpoint_not_entitled)."
    },
    {
      id: "persist-candidate-pool",
      flag: "RAG_PERSIST_CANDIDATE_POOL",
      enabled: flagOn("RAG_PERSIST_CANDIDATE_POOL", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Diagnostic audit rows only. Safe for short canaries; watch DB growth. FULL variant stays off."
    }
  ];
}
