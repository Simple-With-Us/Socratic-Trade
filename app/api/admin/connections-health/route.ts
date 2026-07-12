import { NextResponse } from "next/server";
import {
  getServiceHealthSummaries,
  getServiceHealthLog,
  getAllErrorPatterns,
  type ServiceHealthSummary,
} from "@/lib/db-health";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const EXPECTED_BACKEND_LANES: Array<{ service: string; keySource: string | null }> = [
  { service: "pinecone", keySource: "env" },
  { service: "voyage", keySource: "env" },
  { service: "voyage-rerank", keySource: "env" },
  { service: "openai", keySource: "user" },
  { service: "anthropic", keySource: "user" },
  { service: "gemini", keySource: "user" },
  { service: "xai", keySource: "user" },
  { service: "alpaca-broker", keySource: "user" },
  { service: "robinhood-broker", keySource: "user" },
  { service: "finnhub", keySource: "env" },
  { service: "fmp", keySource: "env" },
  { service: "alphavantage", keySource: "env" },
  { service: "twelvedata", keySource: "env" },
  { service: "massive", keySource: "env" },
  { service: "congress.trade", keySource: null },
  { service: "usage-monitor", keySource: null }
];

function withExpectedBackendLanes(services: ServiceHealthSummary[]): ServiceHealthSummary[] {
  const byLane = new Map(services.map((service) => [`${service.service}:${service.keySource ?? ""}`, service]));
  for (const lane of EXPECTED_BACKEND_LANES) {
    const key = `${lane.service}:${lane.keySource ?? ""}`;
    if (byLane.has(key)) continue;
    byLane.set(key, {
      service: lane.service,
      keySource: lane.keySource,
      lastSuccessTs: null,
      lastSuccessLatencyMs: null,
      lastFailureTs: null,
      lastFailureError: null,
      callsLastHour: 0,
      callsLast24h: 0,
      stoppedWorking: false,
      stoppedReason: null
    });
  }
  return Array.from(byLane.values());
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
    const log = getServiceHealthLog(service, limit, offset, keySourceParam);
    return NextResponse.json({ service, keySource: keySourceParam ?? null, log, limit, offset });
  }

  const services = withExpectedBackendLanes(getServiceHealthSummaries());
  const errorPatterns = getAllErrorPatterns();

  return NextResponse.json({
    services,
    errorPatterns,
    asOf: new Date().toISOString(),
  });
}
