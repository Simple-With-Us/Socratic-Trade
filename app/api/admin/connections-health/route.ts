import { NextResponse } from "next/server";
import {
  HEALTH_REASON_CONSECUTIVE_FAILURES,
  getServiceHealthSummaries,
  getServiceHealthLog,
  getAllErrorPatterns,
  isSoftHealthFailure,
  type ErrorPatternRow,
  type HealthLogRow,
  type ServiceHealthSummary,
} from "@/lib/db-health";
import { requireAdmin } from "@/lib/auth/admin";
import { listUserApiKeys, LOCAL_USER, credTierForService } from "@/lib/db-api-keys";
import { activeEmbeddingProvider, activeRerankProvider } from "@/lib/vector-db";
import {
  intentionalOffHealthReason,
  isIntentionalOffHealthService,
} from "@/lib/retired-direct-vendors";
import { pineconeWuExhaustedUntil } from "@/lib/pinecone-wu-breaker";

export const dynamic = "force-dynamic";

// "rag-embed"/"rag-rerank" (renamed 2026-07-19 from "voyage"/"voyage-rerank" — see withRagApiHealth
// in vector-db.ts) are the provider-generic RAG health lanes: whichever embed/rerank provider is
// actually active (Voyage, OpenRouter, SiliconFlow) logs under these names now.
//
// FMP is listed as an expected lane so it always appears as intentional OFF (retired product
// use — not a missing/broken key). Quiver is not expected; if historical log rows exist they
// are still annotated OFF via markIntentionalOffLanes.
const EXPECTED_BACKEND_LANES: Array<{ service: string; keySource: string | null }> = [
  { service: "pinecone", keySource: "env" },
  { service: "rag-embed", keySource: "env" },
  { service: "rag-rerank", keySource: "env" },
  { service: "openai", keySource: "user" },
  { service: "anthropic", keySource: "user" },
  { service: "gemini", keySource: "user" },
  { service: "xai", keySource: "user" },
  { service: "alpaca-broker", keySource: "user" },
  { service: "robinhood-broker", keySource: "user" },
  { service: "finnhub", keySource: "env" },
  { service: "fmp", keySource: "env" },
  { service: "alpha-vantage", keySource: "env" },
  { service: "twelvedata", keySource: "env" },
  { service: "massive", keySource: "env" },
  { service: "earningscalls-dev-rapidapi", keySource: "env" },
  { service: "roic.ai", keySource: "env" },
  { service: "congress.trade", keySource: null },
  { service: "congress-share", keySource: "env" },
  { service: "usage-monitor", keySource: null }
];

/** Health-log lane names that should render as one Connections card. */
function canonicalHealthLaneService(service: string): string {
  if (service === "earningscall" || service === "earningscalls") {
    return "earningscalls-dev-rapidapi";
  }
  if (service === "roic") return "roic.ai";
  return service;
}

function healthLaneAliases(service: string): string[] {
  const canonical = canonicalHealthLaneService(service);
  if (canonical === "earningscalls-dev-rapidapi") {
    return ["earningscalls-dev-rapidapi", "earningscalls", "earningscall"];
  }
  if (canonical === "roic.ai") return ["roic.ai", "roic"];
  return [canonical];
}

function canonicalServiceHealthLog(
  service: string,
  limit: number,
  offset: number,
  keySource?: string | null,
): HealthLogRow[] {
  const requested = Math.max(0, limit + offset);
  return healthLaneAliases(service)
    .flatMap((alias) => getServiceHealthLog(alias, requested, 0, keySource))
    // Stable sort on ts alone.  Each alias query already returns ORDER BY ts DESC, rowid
    // DESC, and Array.prototype.sort is stable, so insertion order survives within a lane.
    // Tie-breaking on the random UUID `id` would instead order same-millisecond rows
    // arbitrarily and disagree with getLaneHealth's own ts DESC, rowid DESC "last 5" window.
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(offset, offset + limit);
}

function canonicalErrorPatterns(
  patterns: Record<string, ErrorPatternRow[]>,
): Record<string, ErrorPatternRow[]> {
  const merged: Record<string, ErrorPatternRow[]> = {};
  for (const rows of Object.values(patterns)) {
    for (const row of rows) {
      const service = canonicalHealthLaneService(row.service);
      const key = `${service}:${row.key_source ?? ""}`;
      (merged[key] ??= []).push({ ...row, service });
    }
  }
  for (const rows of Object.values(merged)) {
    rows.sort((left, right) => right.last_seen.localeCompare(left.last_seen));
  }
  return merged;
}

function laterIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function mergeHealthLane(left: ServiceHealthSummary, right: ServiceHealthSummary): ServiceHealthSummary {
  const lastSuccessTs = laterIso(left.lastSuccessTs, right.lastSuccessTs);
  const lastFailureTs = laterIso(left.lastFailureTs, right.lastFailureTs);
  const callsLastHour = left.callsLastHour + right.callsLastHour;
  const recent = canonicalServiceHealthLog(left.service, 5, 0, left.keySource);
  let stoppedWorking = false;
  let stoppedReason: string | null = null;
  let stoppedReasonKind: ServiceHealthSummary["stoppedReasonKind"] = null;
  if (
    recent.length >= 5 &&
    recent.every((row) => row.ok === 0 && !isSoftHealthFailure(row.error_text))
  ) {
    stoppedWorking = true;
    stoppedReason = HEALTH_REASON_CONSECUTIVE_FAILURES;
    stoppedReasonKind = "consecutive-failures";
  } else if (callsLastHour > 0 && !lastSuccessTs) {
    stoppedWorking = true;
    stoppedReason = "Active in past hour but no successful call ever";
    stoppedReasonKind = "no-success-ever";
  } else if (
    callsLastHour > 0 &&
    lastSuccessTs &&
    lastSuccessTs < new Date(Date.now() - 60 * 60 * 1000).toISOString()
  ) {
    stoppedWorking = true;
    stoppedReason = "Active in past hour but no success in 60 min";
    stoppedReasonKind = "no-success-this-hour";
  }
  return {
    ...left,
    lastSuccessTs,
    lastSuccessLatencyMs:
      lastSuccessTs === left.lastSuccessTs ? left.lastSuccessLatencyMs : right.lastSuccessLatencyMs,
    lastFailureTs,
    lastFailureError:
      lastFailureTs === left.lastFailureTs ? left.lastFailureError : right.lastFailureError,
    callsLastHour,
    callsLast24h: left.callsLast24h + right.callsLast24h,
    stoppedWorking,
    stoppedReason,
    stoppedReasonKind,
    laneLogCap: left.laneLogCap ?? right.laneLogCap,
    intentionalOff: Boolean(left.intentionalOff || right.intentionalOff),
  };
}

function toCanonicalService(service: string): string {
  if (service === "alpha-vantage") return "alphavantage";
  if (service === "alpaca-broker") return "alpaca_paper_api_key";
  if (service === "robinhood-broker") return "robinhood";
  // "voyage-rerank" is the pre-2026-07-19 lane name (kept for back-compat with historical rows);
  // "rag-embed"/"rag-rerank" are the current provider-generic lanes. Both map to whichever
  // credential/provider is ACTUALLY active (voyage/openrouter/siliconflow) so hasUserKey/
  // credTierForService below check the real credential, not a name that no longer exists in
  // db-api-keys.ts once a non-Voyage provider is active. Falls back to "voyage" (the historical
  // default) if the active provider can't be resolved (e.g. a pinned-but-keyless
  // RAG_EMBED_PROVIDER, which throws by design) — matching /api/health's fail-safe default.
  if (service === "voyage-rerank" || service === "rag-rerank") {
    try {
      return activeRerankProvider(LOCAL_USER);
    } catch {
      return "voyage";
    }
  }
  if (service === "rag-embed") {
    try {
      return activeEmbeddingProvider(LOCAL_USER);
    } catch {
      return "voyage";
    }
  }
  return service;
}

function withExpectedBackendLanes(services: ServiceHealthSummary[]): ServiceHealthSummary[] {
  // Map producer / legacy names to canonical names before matching expectations.
  // The transcript producer logs `earningscalls`; EXPECTED_BACKEND_LANES still
  // lists `earningscalls-dev-rapidapi`.  Without this merge the dashboard
  // shows two identical EarningsCalls.dev cards.
  for (const s of services) {
    s.service = canonicalHealthLaneService(s.service);
    if (s.service === "earningscalls-dev-rapidapi") {
      s.keySource = s.keySource ?? "env";
    }
  }

  const userKeys = listUserApiKeys(LOCAL_USER);
  const servicesWithUserKeys = new Set(userKeys.map((k) => k.service));
  const loggedUserLanes = new Set(services.filter((s) => s.keySource === "user").map((s) => s.service));

  function hasUserKey(service: string) {
    const canonical = toCanonicalService(service);
    if (credTierForService(canonical) === "shared-operator-infra") {
      return false;
    }
    return servicesWithUserKeys.has(canonical) || loggedUserLanes.has(service);
  }

  const filteredServices = services.filter((s) => !(s.keySource === "env" && hasUserKey(s.service)));
  const byLane = new Map<string, ServiceHealthSummary>();
  for (const service of filteredServices) {
    const key = `${service.service}:${service.keySource ?? ""}`;
    const existing = byLane.get(key);
    byLane.set(key, existing ? mergeHealthLane(existing, service) : service);
  }

  for (const lane of EXPECTED_BACKEND_LANES) {
    const expectedKeySource = (lane.keySource === "env" && hasUserKey(lane.service)) ? "user" : lane.keySource;
    const key = `${lane.service}:${expectedKeySource ?? ""}`;
    if (byLane.has(key)) continue;
    const intentionalOff = isIntentionalOffHealthService(lane.service);
    byLane.set(key, {
      service: lane.service,
      keySource: expectedKeySource,
      lastSuccessTs: null,
      lastSuccessLatencyMs: null,
      lastFailureTs: null,
      lastFailureError: null,
      callsLastHour: 0,
      callsLast24h: 0,
      // Retired vendors never alarm as stopped — they are product-OFF by design.
      stoppedWorking: false,
      stoppedReason: intentionalOff ? intentionalOffHealthReason(lane.service) : null,
      intentionalOff: intentionalOff || undefined
    });
  }
  return markIntentionalOffLanes(Array.from(byLane.values()));
}

/** Annotate FMP / Quiver / UW (and historical log variants) as intentional OFF so the
 *  admin UI never paints them red STOPPED from leftover failure rows. */
function markIntentionalOffLanes(services: ServiceHealthSummary[]): ServiceHealthSummary[] {
  return services.map((s) => {
    if (!isIntentionalOffHealthService(s.service)) return s;
    return {
      ...s,
      intentionalOff: true,
      stoppedWorking: false,
      stoppedReason: intentionalOffHealthReason(s.service),
      stoppedReasonKind: null
    };
  });
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const service = url.searchParams.get("service");
  // ?keySource absent → undefined (no filter), ?keySource= (empty) → null (filter to NULL lane)
  const ks = url.searchParams.get("keySource");
  const keySourceParam = ks === null ? undefined : (ks === "" ? null : ks);
  const limit = Number(url.searchParams.get("limit")) || 100;
  const offset = Number(url.searchParams.get("offset")) || 0;

  // When ?service= is provided, return paginated raw log for that credential lane
  if (service) {
    const canonicalService = canonicalHealthLaneService(service);
    const log = canonicalServiceHealthLog(canonicalService, limit, offset, keySourceParam);
    return NextResponse.json({ service: canonicalService, keySource: keySourceParam ?? null, log, limit, offset });
  }

  let services = withExpectedBackendLanes(getServiceHealthSummaries());
  // While the monthly Pinecone write-unit breaker is active, the pinecone lane is inside a
  // KNOWN quota window — annotate it as a soft expected-limit state with the resume date
  // instead of letting stale failure rows read as a broken integration. Reads still work;
  // only vector WRITES are paused, and they resume automatically when the marker expires.
  const wuUntil = pineconeWuExhaustedUntil();
  if (wuUntil) {
    const resumes = wuUntil.slice(0, 10);
    services = services.map((s) =>
      s.service === "pinecone"
        ? {
            ...s,
            stoppedWorking: true,
            stoppedReasonKind: "expected-limit" as const,
            stoppedReason: `monthly write units exhausted · resumes ${resumes}`,
          }
        : s
    );
  }
  const errorPatterns = canonicalErrorPatterns(getAllErrorPatterns());

  return NextResponse.json({
    services,
    errorPatterns,
    asOf: new Date().toISOString(),
  });
}
