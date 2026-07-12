import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { applyCongressEvent, applyCongressEvents, type CongressEvent } from "@/lib/congress-trade-events";
import { verifyCongressWebhookSignature } from "@/lib/congress-webhook-auth";
import { logApiHealth } from "@/lib/db-health";

export const dynamic = "force-dynamic";

// Inbound receiver for congress.trade (App A) push events (see docs/push-to-app-b.md).
// Auth: a shared secret (CONGRESS_WEBHOOK_SECRET) verified via HMAC SHA256 (X-Signature).
// Rejects all writes when no secret is configured. Accepts a single event envelope or { events: [...] } for batches.
// Always returns fast and never throws into the app; events are idempotent (deduped by id).
export async function POST(req: Request) {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  if (!verifyCongressWebhookSignature(req, text)) {
    audit("congress_webhook_rejected", { reason: "signature" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

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
