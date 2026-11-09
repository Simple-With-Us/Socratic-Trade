import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { PayloadTooLargeError, readBodyWithLimit, TRADINGVIEW_WEBHOOK_MAX_BYTES } from "@/lib/bounded-body";
import {
  recordTradingViewSignal,
  technicalEnabled,
  verifyWebhookSecret,
  type TradingViewWebhookPayload
} from "@/lib/web-sources/technical";
// Relative (not "@/lib/...") import: vitest's "@/" alias only resolves specifiers that route tests
// mock; an unmocked "@/lib/*" import fails to load under vitest. A relative path resolves under both
// vitest and the Next build. submitTriggerEvent must live outside this route module because a
// Next.js route.ts may only export route handlers.
import { submitTriggerEvent } from "../../../../src/lib/tradingview-trigger";

export const dynamic = "force-dynamic";

// Inbound receiver for TradingView Pine `alert()` webhooks (the "push" technical-signal
// producer). TradingView does NOT sign payloads, so security is layered:
//   1. a shared secret embedded in the JSON body, verified constant-time server-side;
//   2. an optional IP allowlist (TRADINGVIEW_WEBHOOK_IPS) — note: behind a tunnel the
//      visible IP is the tunnel's, so this is opt-in and off by default;
//   3. dedup on (symbol|signals|bar_time) inside recordTradingViewSignal.
// Always returns fast and never throws into the app. Paper-mode safe: it only writes a
// technical signal into the cache; it places no orders and bypasses no policy gate.

function clientIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? undefined;
}

function ipAllowed(req: Request): boolean {
  const raw = process.env.TRADINGVIEW_WEBHOOK_IPS;
  if (!raw) return true; // allowlist not configured → IP check disabled
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ip = clientIp(req);
  return !!ip && allowed.includes(ip);
}

export async function POST(req: Request) {
  if (!technicalEnabled()) {
    return NextResponse.json({ ok: false, error: "technical source disabled" }, { status: 404 });
  }
  if (!ipAllowed(req)) {
    audit("tradingview_webhook_rejected", { reason: "ip", ip: clientIp(req) });
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Pine `alert()` sends the message as the raw request body; content-type is not
  // guaranteed to be application/json, so read text and parse defensively. This route had no
  // byte cap at all (unlike the congress webhook, which at least checked a declared
  // content-length); readBodyWithLimit enforces one independent of any header, streaming-abort
  // style, since a single alert payload is always tiny.
  let payload: TradingViewWebhookPayload;
  try {
    const text = await readBodyWithLimit(req, TRADINGVIEW_WEBHOOK_MAX_BYTES);
    payload = JSON.parse(text) as TradingViewWebhookPayload;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!verifyWebhookSecret(payload.secret)) {
    audit("tradingview_webhook_rejected", { reason: "secret", symbol: payload.symbol });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = recordTradingViewSignal(payload);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.warning ?? "rejected" }, { status: 422 });
    }

    // Submit a material event to the trigger engine so a fresh TV alert can kick off
    // a strategy run — mirrors the sec8k.ts pattern (dynamic import to avoid circular
    // deps; defensive catch so the signal cache write is never rolled back).
    // No-op unless TRIGGER_ENGINE=on (the engine's own gate handles it).
    if (!result.deduped && result.symbol) {
      const symbol = result.symbol;
      // sourceId is stable per unique signal instance: matches the dedupeKey written
      // by recordTradingViewSignal (symbol|signals|asOf|direction).
      const sourceId = `tradingview:${symbol}:${payload.signal ?? ""}:${payload.bar_time ?? ""}`;
      void submitTriggerEvent(symbol, sourceId);
    }

    return NextResponse.json({ ok: true, symbol: result.symbol, deduped: result.deduped ?? false });
  } catch (error) {
    audit("tradingview_webhook_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
