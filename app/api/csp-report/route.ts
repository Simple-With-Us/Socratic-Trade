import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * CSP report collector (report-uri / report-to compatible).
 *
 * Public + unauthenticated by design — browsers POST violation reports without cookies.
 * Body is capped and never echoed; we log a bounded summary for operators running
 * CSP_ENABLED=on in report-only mode. Returns 204 even on parse failure so browsers
 * do not retry-storm.
 */
const MAX_BODY_BYTES = 16_384;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const len = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 204 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 204 });
    }
    let report: unknown;
    try {
      report = JSON.parse(raw);
    } catch {
      return new NextResponse(null, { status: 204 });
    }
    const csp =
      report && typeof report === "object"
        ? ((report as { "csp-report"?: Record<string, unknown>; body?: Record<string, unknown> })[
            "csp-report"
          ] ??
          (report as { body?: Record<string, unknown> }).body ??
          report)
        : null;
    if (csp && typeof csp === "object") {
      const violated = String((csp as { "violated-directive"?: unknown; effectiveDirective?: unknown })["violated-directive"]
        ?? (csp as { effectiveDirective?: unknown }).effectiveDirective
        ?? "");
      const blocked = String((csp as { "blocked-uri"?: unknown; blockedURL?: unknown })["blocked-uri"]
        ?? (csp as { blockedURL?: unknown }).blockedURL
        ?? "");
      const doc = String((csp as { "document-uri"?: unknown; documentURL?: unknown })["document-uri"]
        ?? (csp as { documentURL?: unknown }).documentURL
        ?? "");
      console.info(
        "[csp-report]",
        JSON.stringify({
          violated: violated.slice(0, 120),
          blocked: blocked.slice(0, 200),
          document: doc.slice(0, 200)
        })
      );
    }
  } catch {
    // never throw to the browser
  }
  return new NextResponse(null, { status: 204 });
}

/** Browsers may probe with GET; answer empty 204. */
export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204 });
}
