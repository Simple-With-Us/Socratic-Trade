import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Coolify / Docker / Traefik liveness.  Process-only on purpose.
 *
 * `/api/health` is the rich public/ops probe.  It can 503 when a critical
 * dependency hard-stops, and a cache miss still reads SQLite.  Pointing
 * Traefik at that probe marks a serving container `running:unhealthy` and
 * Cloudflare returns `no available server` even though Next and Litestream
 * are up (2026-08-17, after docs-only #2810).
 *
 * This route does not open `app.db`, stat the data volume, or call the
 * network.  A locked or huge database must not turn liveness into a
 * restart.  DB reachability and dependency hard-stops stay on `/api/health`
 * and `/api/ready`.  200 means the process can run a handler.  A pinned
 * event loop still cannot answer; that is the watchdog's restart signal.
 */
export async function GET() {
  return NextResponse.json({ ok: true, probe: "live" }, { status: 200 });
}
