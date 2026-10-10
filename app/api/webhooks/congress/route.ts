import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/db";
import { applyCongressEvent, applyCongressEvents, type CongressEvent } from "@/lib/congress-trade-events";
import { verifyCongressWebhookSignature } from "@jaywedgeworth22/congress-trading-shared";
import { logApiHealth } from "@/lib/db-health";
import { CONGRESS_WEBHOOK_MAX_BYTES, PayloadTooLargeError, readBodyWithLimit } from "@/lib/bounded-body";
import { enforceRateLimit, RATE_LIMITS, trustedCloudflareClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Inbound receiver for congress.trade (App A) push events (see docs/push-to-app-b.md).
// Auth: a shared secret (CONGRESS_WEBHOOK_SECRET) verified via HMAC SHA256 (X-Signature),
// with the documented legacy Authorization: Bearer fallback retained for existing senders.
// Rejects all writes when no secret is configured. Accepts a single event envelope or { events: [...] } for batches.
// Always returns fast and never throws into the app; events are idempotent (deduped by id).
function bearerSecretMatches(req: Request, expectedSecret: string): boolean {
  const authHeader = req.headers.get("authorization")?.trim() ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return false;
  const providedToken = authHeader.slice(7).trim();
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function POST(req: Request) {
  const expectedSecret = (process.env.CONGRESS_WEBHOOK_SECRET ?? "").trim();
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const hasSignature = req.headers.has("x-signature");
  const hasAuth = req.headers.has("authorization");
  if (!hasSignature && !hasAuth) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // A declared content-length is a client CLAIM, not a guarantee (absent under chunked
  // transfer, or simply wrong) — readBodyWithLimit fast-paths an honest oversized header but
  // also aborts mid-stream the moment the ACTUAL byte count exceeds the cap, so a missing or
  // understated header can't bypass the limit.
  let text: string;
  try {
    text = await readBodyWithLimit(req, CONGRESS_WEBHOOK_MAX_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const signatureHeader = req.headers.get("x-signature") ?? "";
  const isValid =
    bearerSecretMatches(req, expectedSecret) ||
    (hasSignature && await verifyCongressWebhookSignature(text, signatureHeader, expectedSecret));

  const clientIp = trustedCloudflareClientIp(req);
  if (!clientIp) {
    return NextResponse.json({ ok: false, error: "missing or invalid client ip" }, { status: 400 });
  }

  if (!isValid) {
    const unauthLimited = enforceRateLimit(
      clientIp,
      "webhooks/congress:unauth",
      RATE_LIMITS.congressWebhookUnauth
    );
    if (unauthLimited) return unauthLimited;
    audit("congress_webhook_rejected", { reason: "signature" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const limited = enforceRateLimit(
    clientIp,
    "webhooks/congress",
    RATE_LIMITS.congressWebhook
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const rec = body && typeof body === "object" ? (body as { events?: unknown }) : null;
    if (rec && Array.isArray(rec.events)) {
      const results = applyCongressEvents(rec.events);
      const failed = results.find((result) => !result.ok);
      logApiHealth({
        service: "congress.trade:webhook",
        ok: !failed,
        errorText: failed?.reason ?? (failed ? "unsupported congress webhook event" : undefined),
      });
      return NextResponse.json({ ok: true, count: results.length, results });
    }
    const result = applyCongressEvent(body as CongressEvent);
    logApiHealth({
      service: "congress.trade:webhook",
      ok: result.ok,
      errorText: result.ok ? undefined : result.reason ?? "unsupported congress webhook event",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    audit("congress_webhook_error", { error: error instanceof Error ? error.message : "unknown" });
    logApiHealth({
      service: "congress.trade:webhook",
      ok: false,
      errorText: error instanceof Error ? error.message : "ingest failed",
    });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
