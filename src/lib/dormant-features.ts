/**
 * Operator-facing inventory of dormant / gated features and whether each is ready to enable.
 * Used by admin RAG coverage so enablement is a checklist, not archaeology.
 *
 * Deliberately DB-/vector-db-free (envFlagOn only) so the route can import it without pulling
 * the Pinecone stack into cold admin paths.
 */
import { isAppleWebAuthConfigured } from "./auth/apple-web";
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
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: flagOn("VECTOR_ASOF_STRICT", false, env)
        ? "ON: dated retrieval is fail-closed (undated chunks drop). Live desk omits asOf and is unchanged."
        : "OFF: dated retrieval keeps undated chunks. Coverage receipt 2026-08-16 was 13076/13076 epoch'd."
    },
    {
      id: "rag-multiquery",
      flag: "RAG_MULTIQUERY",
      enabled: flagOn("RAG_MULTIQUERY", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Facet sub-queries per filings pass. Paid OpenRouter/bge-m3 + RAG_RUN_BUDGET_ENABLED is the guardrail. Settings and Infisical both drive the runtime flag."
    },
    {
      id: "rag-hyde",
      flag: "RAG_HYDE",
      enabled: flagOn("RAG_HYDE", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Requires RAG_MULTIQUERY on; adds one cheap LLM draft (gpt-5.4-mini) per pass. Enable with MULTIQUERY on paid embed."
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
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Full 8-K body ingest into RAG. Bounded by WEB_SOURCE_SEC8K_FULL_BODY_LIMIT (default 5) and WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS (default 12s, cap 60s). Uses adaptive FTS-mirror batching — do not raise the budget without watching [slow-sync] logs."
    },
    {
      id: "congress-share-outbound",
      flag: "CONGRESS_SHARE_ENABLED",
      enabled: flagOn("CONGRESS_SHARE_ENABLED", false, env),
      readyToEnable: true,
      defaultWhenUnset: "off",
      note: "Automatic outbound share to congress.trade. Also requires CONGRESS_TRADE_TOKEN (CT INGEST_TOKEN). Nightly batch + after-scan refs. Fundamentals stay on CONGRESS_SHARE_FUNDAMENTALS_ENABLED."
    },
    {
      id: "apple-web-signin",
      flag: "AUTH_APPLE_ID + AUTH_APPLE_SECRET",
      enabled: isAppleWebAuthConfigured(env),
      readyToEnable: isAppleWebAuthConfigured(env),
      defaultWhenUnset: "off",
      blocker: isAppleWebAuthConfigured(env)
        ? undefined
        : "Needs Apple Services ID + client-secret JWT (or TEAM_ID + KEY_ID + SIWA .p8 PEM) in Infisical. Not ASC/APNs keys.",
      note: "Web Sign in with Apple on /login. Code path is live; prod stays dark until AUTH_APPLE_* is set."
    },
    {
      id: "sec-ingest-worker",
      flag: "SEC_INGEST_WORKER_ENABLED",
      enabled: flagOn("SEC_INGEST_WORKER_ENABLED", false, env),
      readyToEnable: false,
      defaultWhenUnset: "off",
      blocker: "Ops: seed jobs via /api/admin/sec-ingest and confirm queue/DLQ health first.",
      note: "Background SEC backfill worker.  Default off; admin seed is the canary.  Env view only — an Admin > Operations override supersedes this; check there for the effective value."
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
