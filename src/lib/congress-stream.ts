// Persistent SSE consumer for congress.trade (App A). Connects OUT to App A's text/event-stream and
// applies pushed events (see docs/push-to-app-b.md) — the streaming counterpart to the inbound
// /api/webhooks/congress route. Must run in the persistent Node process (started from
// instrumentation.register via startStreams(), NOT a per-request handler).
//
// CONTRACT (App A's live subscription model — see Congress.Trade/app/src/delivery/{rest,sse}.ts):
//   App A's GET /api/stream REQUIRES `?subscription=<id>` and authenticates the per-subscription
//   secret (Authorization: Bearer <secret>, or ?token=). It then emits, per matching trade,
//   `id:<cursorSeq>\nevent: trade.new\ndata:<raw Transaction JSON>` plus control frames
//   (`event: cursor|ping|reconnect|error`). This consumer therefore (1) resolves a subscription —
//   operator-provisioned via env, or auto-created against App A's public POST /api/subscriptions —
//   (2) connects with `?subscription=` + the secret, (3) maps App A's raw `trade.new` Transaction into
//   a canonical `congress.trade` envelope before applyCongressEvent, and (4) treats cursor/ping/
//   reconnect/error as recognized control frames (no "dropped unparseable" noise per heartbeat).
//
// Reconnects with exponential backoff and resumes via the Last-Event-ID header so events aren't lost
// across reconnects. Opt-in (CONGRESS_STREAM_ENABLED); no-op otherwise. Fully self-guarded. IMPORTANT:
// this module is on the instrumentation import chain, which Next also bundles for the edge runtime, so
// it must NOT statically import Node-only modules (crypto, better-sqlite3/db) — keep it fetch-only.

import { applyCongressEvent, type CongressEvent } from "./congress-trade-events";
import { logApiHealth } from "./db-health";
import { CongressTradeClient, SseParser, type SseMessage, type Subscription } from "@jaywedgeworth22/congress-trading-shared";

const DEFAULT_PATH = "/api/stream";
const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

interface StreamState {
  started: boolean;
  closing: boolean;
  backoffMs: number;
  lastEventId?: string;
  controller?: AbortController;
  /** Auto-created subscription cached for this process lifetime (env-provisioned ones aren't cached). */
  subscription?: Subscription;
}

const host = globalThis as unknown as { __congressStream?: StreamState };
const state: StreamState = host.__congressStream ?? (host.__congressStream = { started: false, closing: false, backoffMs: INITIAL_BACKOFF_MS });

function flagOn(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

export function congressStreamEnabled(): boolean {
  return flagOn(process.env.CONGRESS_STREAM_ENABLED);
}

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? "https://congress.trade").trim().replace(/\/+$/, "");
}

/** Build App A's stream URL with the required `?subscription=<id>` query param. */
function streamUrl(subscriptionId: string): string {
  return new CongressTradeClient({ baseUrl: baseUrl() }).streamUrl(subscriptionId);
}

function envSubscriptionId(): string | undefined {
  const v = (process.env.CONGRESS_STREAM_SUBSCRIPTION_ID ?? "").trim();
  return v.length > 0 ? v : undefined;
}

function envSubscriptionToken(): string | undefined {
  // The per-subscription secret App A validates for the stream. Falls back to CONGRESS_TRADE_READ_TOKEN
  // only for backward compatibility with an operator who reused that value as the subscription secret.
  const v = (process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN ?? process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Auto-create an SSE subscription against App A's public POST /api/subscriptions and return its
 * id + secret. Opt-in (CONGRESS_STREAM_AUTO_SUBSCRIBE); returns null on any failure so the caller
 * stays inert rather than throwing. If CONGRESS_STREAM_SUBSCRIPTION_TOKEN is set (>=16 chars) it is
 * used as the subscription secret so the same value survives a recreate.
 */
async function createSubscription(): Promise<Subscription | null> {
  const clientId = (process.env.CONGRESS_STREAM_CLIENT_ID ?? "app-b").trim() || "app-b";
  const desiredSecret = (process.env.CONGRESS_STREAM_SUBSCRIPTION_TOKEN ?? "").trim();
  try {
    const client = new CongressTradeClient({ baseUrl: baseUrl(), token: process.env.CONGRESS_TRADE_TOKEN || undefined });
    return await client.createSubscription(clientId, desiredSecret);
  } catch (err) {
    console.warn("[congress-stream] subscription create error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve the subscription to connect with: operator-provisioned env id+token (preferred), then a
 * cached auto-created one, else auto-create (opt-in). Returns null when none can be resolved — the
 * push path then stays inert (documented) instead of hammering App A's /stream with a 400.
 */
export async function resolveSubscription(): Promise<Subscription | null> {
  const id = envSubscriptionId();
  const token = envSubscriptionToken();
  if (id && token) return { id, secret: token };
  if (state.subscription) return state.subscription;
  if (!flagOn(process.env.CONGRESS_STREAM_AUTO_SUBSCRIBE)) return null;
  const created = await createSubscription();
  if (created) state.subscription = created;
  return created;
}

// ── Pure SSE frame parser (unit-tested; no network) ──────────────────────────
/** App A's non-data control frames — recognized so they never log as "dropped unparseable". */
const CONTROL_EVENTS = new Set(["cursor", "ping", "reconnect", "error"]);

/**
 * Map one parsed SSE data payload into a canonical CongressEvent envelope.
 *  - App A's `event: trade.new` carries the RAW Transaction as its data — wrap it explicitly as
 *    { type:'congress.trade', id, data:{ transaction } } (applyCongressEvent reads data.transaction).
 *  - Anything else is assumed to already be a CongressEvent envelope; fill type/id from the SSE frame
 *    lines when absent (a webhook-style envelope delivered over SSE).
 * Returns null when the payload isn't an object.
 */
export function toCongressEventEnvelope(parsed: unknown, msg: SseMessage): CongressEvent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (msg.event === "trade.new") {
    const txId = typeof obj.id === "string" ? obj.id : msg.id;
    return { type: "congress.trade", id: txId, data: { transaction: obj } };
  }
  const env = obj as unknown as CongressEvent;
  if (!env.type && msg.event) env.type = msg.event;
  if (!env.id && msg.id) env.id = msg.id;
  return env;
}

/**
 * Handle one SSE message. Control frames (cursor/ping/reconnect/error) are recognized no-ops.
 * Data frames are parsed, mapped to a CongressEvent envelope, and applied. Returns false only when a
 * DATA frame can't be parsed/mapped (so the caller can log genuinely-unexpected payloads).
 */
export function applySseMessage(msg: SseMessage): boolean {
  const event = msg.event ?? "";
  if (CONTROL_EVENTS.has(event)) {
    if (event === "error") console.warn("[congress-stream] App A error frame:", (msg.data ?? "").slice(0, 200));
    return true; // recognized control frame — nothing to ingest, no warning
  }
  if (!msg.data) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.data);
  } catch {
    return false;
  }
  const env = toCongressEventEnvelope(parsed, msg);
  if (!env) return false;
  applyCongressEvent(env);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectOnce(): Promise<void> {
  const sub = await resolveSubscription();
  if (!sub) {
    throw new Error(
      "no subscription configured — set CONGRESS_STREAM_SUBSCRIPTION_ID + CONGRESS_STREAM_SUBSCRIPTION_TOKEN, or enable CONGRESS_STREAM_AUTO_SUBSCRIBE"
    );
  }
  const controller = new AbortController();
  state.controller = controller;
  const startedAt = Date.now();
  const res = await fetch(streamUrl(sub.id), {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${sub.secret}`, // App A reads the subscription secret from Bearer or ?token
      ...(state.lastEventId ? { "last-event-id": state.lastEventId } : {})
    },
    cache: "no-store",
    signal: controller.signal
  });
  // A rejected/stale subscription (deleted, inactive, wrong secret) → drop the cached auto-created one
  // so the next attempt re-provisions; an env-provisioned subscription is left for the operator to fix.
  if (res.status === 401 || res.status === 404 || res.status === 409) {
    if (state.subscription) state.subscription = undefined;
    throw new Error(`SSE connect rejected: HTTP ${res.status} (subscription invalid?)`);
  }
  if (!res.ok || !res.body) {
    let retryMsg = "";
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) {
        // RFC 7231 §7.1.3: Retry-After can be delta-seconds or HTTP-date
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed) && parsed > 0) {
          retryMsg = ` (Retry-After: ${parsed})`;
        } else {
          // Try HTTP-date format, e.g. "Wed, 21 Oct 2015 07:28:00 GMT"
          const httpDate = Date.parse(retryAfter);
          if (!isNaN(httpDate)) {
            const seconds = Math.ceil((httpDate - Date.now()) / 1000);
            if (seconds > 0) {
              retryMsg = ` (Retry-After: ${seconds})`;
            }
          }
        }
      }
    }
    throw new Error(`SSE connect failed: HTTP ${res.status}${retryMsg}`);
  }
  state.backoffMs = INITIAL_BACKOFF_MS; // healthy connection → reset backoff
  // Connection-health signal for the admin Connections page (App B's side of the App A → App B
  // real-time link). Re-fires on each (re)connect within App A's ~25min stream lifetime.
  logApiHealth({ service: "congress.trade:sse", ok: true, latencyMs: Date.now() - startedAt });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
      if (msg.id) state.lastEventId = msg.id; // resume point — replayed via Last-Event-ID on reconnect
      if (!applySseMessage(msg)) {
        console.warn("[congress-stream] dropped unparseable SSE message", { event: msg.event, id: msg.id });
      }
    }
    if (state.closing) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
}

async function runLoop(): Promise<void> {
  while (!state.closing) {
    try {
      await connectOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[congress-stream] connection error:", msg);
      
      // Do not pollute api_health_log or loop infinitely if we legitimately lack credentials
      if (msg.includes("no subscription configured")) {
        console.warn("[congress-stream] disabling stream until credentials are provided.");
        state.closing = true;
        break;
      }

      // Record ALL failures in api_health_log so the admin dashboard shows current state.
      // logApiHealth already detects 429|rate limit in error text and suppresses Sentry
      // alerts via skipSentry (see db-health.ts line 172-174), so rate-limit backpressure
      // events are recorded without noise.
      logApiHealth({
        service: "congress.trade:sse",
        ok: false,
        errorText: msg,
      });

      // Back off on 429 explicitly, using the parsed Retry-After seconds if available
      const retryMatch = msg.match(/HTTP 429 \(Retry-After: (\d+)\)/);
      if (retryMatch) {
        const sec = parseInt(retryMatch[1], 10);
        state.backoffMs = Math.max(state.backoffMs, sec * 1000);
      } else if (msg.includes("HTTP 429")) {
        // Default to a 60s backoff if 429 but no Retry-After
        state.backoffMs = Math.max(state.backoffMs, 60_000);
      }
    }
    if (state.closing) break;
    await sleep(state.backoffMs);
    state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/** Idempotent: start the SSE consumer once if enabled. */
export function startCongressStream(): void {
  if (state.started || state.closing) return;
  if (!congressStreamEnabled()) return;
  if (typeof fetch === "undefined") {
    console.warn("[congress-stream] global fetch unavailable; not starting.");
    return;
  }
  state.started = true;
  void runLoop();
}

/** Stop the consumer (tests / graceful shutdown). */
export function stopCongressStream(): void {
  state.closing = true;
  try {
    state.controller?.abort();
  } catch {
    /* ignore */
  }
}
