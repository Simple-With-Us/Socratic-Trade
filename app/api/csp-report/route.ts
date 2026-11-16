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

/**
 * Read at most MAX_BODY_BYTES *bytes* off the request stream, then stop.
 *
 * Three things this deliberately does NOT do, each of which was a real hole:
 *   - It does not trust `content-length`. That header is optional (chunked
 *     transfer encoding omits it) and attacker-controlled, so it can only ever
 *     be a cheap early-out, never the enforcement point.
 *   - It does not buffer first and measure second. `await request.text()`
 *     materializes the WHOLE body before any cap can be applied, so a large
 *     POST to this unauthenticated endpoint was bounded only by available
 *     memory. We stop pulling from the stream the moment the cap is crossed.
 *   - It does not measure `String.length`. That counts UTF-16 code units, so a
 *     16k-"character" cap admits up to ~4x that many bytes of multi-byte UTF-8.
 *
 * Returns null when the body is absent or exceeds the cap — callers treat that
 * the same as unparseable and answer 204.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const body = request.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // fatal:false — a truncated/invalid sequence becomes U+FFFD rather than
  // throwing, so a malformed body still lands on the JSON.parse 204 path.
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/** Classic report-uri object, a report-to `{ body }` wrapper, or a Reporting API array. */
function cspReportRecords(report: unknown): Record<string, unknown>[] {
  if (Array.isArray(report)) {
    const records: Record<string, unknown>[] = [];
    for (const item of report) {
      records.push(...cspReportRecords(item));
      if (records.length >= 20) break;
    }
    return records;
  }
  if (!report || typeof report !== "object") return [];
  const record = report as Record<string, unknown>;
  const nested = record["csp-report"] ?? record.body;
  if (nested && typeof nested === "object") return cspReportRecords(nested);
  return [record];
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const raw = await readCappedBody(request);
    if (raw === null) {
      return new NextResponse(null, { status: 204 });
    }
    let report: unknown;
    try {
      report = JSON.parse(raw);
    } catch {
      return new NextResponse(null, { status: 204 });
    }
    // report-uri posts one object.  report-to (Reporting API) posts an array of
    // { type, body } records.  Cap the log lines so a stuffed array cannot flood.
    for (const csp of cspReportRecords(report).slice(0, 20)) {
      const violated = String(csp["violated-directive"] ?? csp.effectiveDirective ?? "");
      const blocked = String(csp["blocked-uri"] ?? csp.blockedURL ?? "");
      const doc = String(csp["document-uri"] ?? csp.documentURL ?? "");
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
