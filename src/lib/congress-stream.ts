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

import {
  applyCongressEvent,
  type CongressEvent,
  TradeRetractEventSchema,
  type TradeRetractEvent
} from "./congress-trade-events";
import { logApiHealth } from "./db-health";
import {
  PEER_LANE_CONGRESS_SSE,
  recordPeerLaneSample,
} from "./peer-lane-backoff";
import { CongressTradeClient, SseParser, type SseMessage, type Subscription } from "@jaywedgeworth22/congress-trading-shared";

const DEFAULT_PATH = "/api/stream";
/** Widened 2026-08-17 (#2550): 60s max + reset-on-HTTP-200 turned flaps into a reconnect storm. */
export const CONGRESS_SSE_MAX_BACKOFF_MS = 5 * 60_000;
export const CONGRESS_SSE_INITIAL_BACKOFF_MS = 2_000;
export const CONGRESS_SSE_MIN_HEALTHY_MS = 30_000;
export const CONGRESS_SSE_CONNECT_TIMEOUT_MS = 8_000;
export const CONGRESS_SSE_FLAP_CAP = 5;
export const CONGRESS_SSE_FLAP_WINDOW_MS = 10 * 60_000;

const MAX_BACKOFF_MS = CONGRESS_SSE_MAX_BACKOFF_MS;
const INITIAL_BACKOFF_MS = CONGRESS_SSE_INITIAL_BACKOFF_MS;

// Parked-loop self-poll cadence (see runLoop). 15s + the ~15s server-knob cache TTL keeps a
// flip back on effective well inside the advertised "about a minute".
const DEFAULT_PARK_POLL_MS = 15_000;
let parkPollMs = DEFAULT_PARK_POLL_MS;

/** Test hook: shrink the park self-poll so park/resume tests run in milliseconds. */
export function setCongressParkPollMsForTests(ms?: number): void {
  parkPollMs = typeof ms === "number" && ms > 0 ? ms : DEFAULT_PARK_POLL_MS;
}

interface StreamState {
  started: boolean;
  closing: boolean;
  backoffMs: number;
  lastEventId?: string;
  controller?: AbortController;
  /** Auto-created subscription cached for this process lifetime (env-provisioned ones aren't cached). */
  subscription?: Subscription;
  flapsInWindow: number;
  flapWindowStartedAt: number;
}

export interface CongressSseDisconnectInput {
  previousBackoffMs: number;
  livedMs?: number;
  connectFailed?: boolean;
  flapsInWindow: number;
  now?: number;
  flapWindowStartedAt?: number;
}

export interface CongressSseDisconnectResult {
  backoffMs: number;
  flapsInWindow: number;
  flapWindowStartedAt: number;
  resetHealthy: boolean;
  softFlap: boolean;
}

/**
 * Pure reconnect policy (#2550). A clean HTTP 200 that dies in under
 * CONGRESS_SSE_MIN_HEALTHY_MS is a flap — do not reset backoff. Five flaps in
 * the window jump straight to the 5-minute cap.
 */
export function nextCongressSseBackoff(input: CongressSseDisconnectInput): CongressSseDisconnectResult {
  const now = input.now ?? Date.now();
  const windowStart = input.flapWindowStartedAt ?? now;
  const windowExpired = now - windowStart >= CONGRESS_SSE_FLAP_WINDOW_MS;
  const flapsBase = windowExpired ? 0 : input.flapsInWindow;
  const windowStartedAt = windowExpired ? now : windowStart;
  const flap =
    input.connectFailed === true ||
    (input.livedMs !== undefined && input.livedMs < CONGRESS_SSE_MIN_HEALTHY_MS);
  if (!flap && input.livedMs !== undefined) {
    return {
      backoffMs: INITIAL_BACKOFF_MS,
      flapsInWindow: 0,
      flapWindowStartedAt: now,
      resetHealthy: true,
      softFlap: false,
    };
  }
  if (!flap) {
    return {
      backoffMs: input.previousBackoffMs,
      flapsInWindow: flapsBase,
      flapWindowStartedAt: windowStartedAt,
      resetHealthy: false,
      softFlap: false,
    };
  }
  const flaps = flapsBase + 1;
  const doubled = Math.min(
    Math.max(input.previousBackoffMs, INITIAL_BACKOFF_MS) * 2,
    MAX_BACKOFF_MS
  );
  return {
    backoffMs: flaps >= CONGRESS_SSE_FLAP_CAP ? MAX_BACKOFF_MS : doubled,
    flapsInWindow: flaps,
    flapWindowStartedAt: windowStartedAt,
    resetHealthy: false,
    softFlap: true,
  };
}

const host = globalThis as unknown as { __congressStream?: StreamState };
const state: StreamState = host.__congressStream ?? (host.__congressStream = {
  started: false,
  closing: false,
  backoffMs: INITIAL_BACKOFF_MS,
  flapsInWindow: 0,
  flapWindowStartedAt: 0,
});

function flagOn(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

// Server-knob resolver injection: this module must stay edge-bundle-safe (no static Node-only
// imports — see the module header), so it cannot read the DB-backed server-knobs store itself.
// The Node-only startup path registers a resolver (server-knob-supervisor.ts) that consults the
// CONGRESS_STREAM_ENABLED server knob; without one (unit tests, edge bundle) the env flag governs.
type CongressStreamEnabledResolver = () => boolean | undefined;
let serverEnabledResolver: CongressStreamEnabledResolver | undefined;

export function setCongressStreamEnabledResolver(fn: CongressStreamEnabledResolver | undefined): void {
  serverEnabledResolver = fn;
}

export function congressStreamEnabled(): boolean {
  try {
    const v = serverEnabledResolver?.();
    if (typeof v === "boolean") return v;
  } catch {
    // fail open to env
  }
  return flagOn(process.env.CONGRESS_STREAM_ENABLED);
}

/** True only when an injected resolver explicitly says OFF — the mid-stream park signal. Kept
 *  separate from congressStreamEnabled() so env-only unit tests of connectOnce are unaffected. */
function serverParkRequested(): boolean {
  try {
    return serverEnabledResolver?.() === false;
  } catch {
    return false;
  }
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
export function toCongressEventEnvelope(parsed: unknown, msg: SseMessage): CongressEvent | TradeRetractEvent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (msg.event === "trade.new") {
    const txId = typeof obj.id === "string" ? obj.id : msg.id;
    return { type: "congress.trade", id: txId, data: { transaction: obj } };
  }
  if (msg.event === "trade.retract") return toRetractEnvelope(obj, msg);
  const env = obj as unknown as CongressEvent;
  if (!env.type && msg.event) env.type = msg.event;
  if (!env.id && msg.id) env.id = msg.id;
  return env;
}

/** Fields that carry retraction ids directly (see TradeRetractEventSchema). */
const RETRACT_ID_KEYS = ["txId", "transactionId", "ids", "transactionIds", "transaction", "transactions", "trades", "retraction"];

/**
 * Map a `trade.retract` SSE payload to a validated retract event, or null when
 * it fails TradeRetractEventSchema (applySseMessage then reports it dropped).
 * Only a payload that names itself `trade.retract` (type or event) is taken as
 * an envelope.  Anything else is a bare frame: a `type` field there is
 * transaction data (for example "P"), not an event name.  A bare frame that
 * already carries id fields becomes `data` as is; a bare transaction row is
 * wrapped as `data.transaction`.  The event id is `ct-retract-<retractSeq>`
 * (the webhook's id for the same retraction) when the frame has a retractSeq,
 * so both channels dedupe together; otherwise the SSE id line, if any.
 */
function toRetractEnvelope(obj: Record<string, unknown>, msg: SseMessage): TradeRetractEvent | null {
  const isEnvelope = obj.type === "trade.retract" || obj.event === "trade.retract";
  const candidate: unknown = isEnvelope
    ? obj
    : { type: "trade.retract", data: RETRACT_ID_KEYS.some((k) => obj[k] !== undefined) ? obj : { transaction: obj } };
  const parsed = TradeRetractEventSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.id === undefined) {
    const seq = event.retractSeq ?? event.retraction?.retractSeq ?? event.data?.retractSeq ?? event.data?.retraction?.retractSeq;
    const id = seq !== undefined ? `ct-retract-${seq}` : msg.id;
    if (id) event.id = id;
  }
  return event;
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
  const connectTimer = setTimeout(() => controller.abort(), CONGRESS_SSE_CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(streamUrl(sub.id), {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${sub.secret}`, // App A reads the subscription secret from Bearer or ?token
        ...(state.lastEventId ? { "last-event-id": state.lastEventId } : {})
      },
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(connectTimer);
  }
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
  // Do NOT reset backoff here — a 200 that dies in seconds is a flap (#2550).
  // runLoop resets only after CONGRESS_SSE_MIN_HEALTHY_MS.
  const connectMs = Date.now() - startedAt;
  recordPeerLaneSample(PEER_LANE_CONGRESS_SSE, connectMs);
  logApiHealth({ service: "congress.trade:sse", ok: true, latencyMs: connectMs });

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
    if (state.closing || serverParkRequested()) {
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
    if (!congressStreamEnabled()) {
      // Server-knob park: mirror the alpaca streams — keep this single loop alive as a slow
      // self-poll so a flip back on resumes level-based, with no external re-invoke.  Exiting
      // the loop here raced the supervisor's 30s rising-edge poll: an off->on bounce inside one
      // window read as on->on (no edge) and left the stream parked while Admin > Operations
      // showed it on.  `closing` stays false — this is a pause, not a shutdown.
      await sleep(parkPollMs);
      continue;
    }
    const attemptStartedAt = Date.now();
    let connectFailed = false;
    let connectError = "";
    try {
      await connectOnce();
    } catch (err) {
      connectFailed = true;
      connectError = err instanceof Error ? err.message : String(err);
      console.error("[congress-stream] connection error:", connectError);

      // Do not pollute api_health_log or loop infinitely if we legitimately lack credentials
      if (connectError.includes("no subscription configured")) {
        console.warn("[congress-stream] disabling stream until credentials are provided.");
        state.closing = true;
        break;
      }

      const retryMatch = connectError.match(/HTTP 429 \(Retry-After: (\d+)\)/);
      if (retryMatch) {
        const sec = parseInt(retryMatch[1], 10);
        state.backoffMs = Math.max(state.backoffMs, sec * 1000);
      } else if (connectError.includes("HTTP 429")) {
        state.backoffMs = Math.max(state.backoffMs, 60_000);
      }
    }
    if (state.closing) break;
    const livedMs = Date.now() - attemptStartedAt;
    const parked = serverParkRequested();
    const outcome = nextCongressSseBackoff({
      previousBackoffMs: state.backoffMs,
      livedMs,
      connectFailed,
      flapsInWindow: state.flapsInWindow,
      flapWindowStartedAt: state.flapWindowStartedAt,
    });
    state.flapsInWindow = outcome.flapsInWindow;
    state.flapWindowStartedAt = outcome.flapWindowStartedAt;
    if (outcome.resetHealthy) {
      state.backoffMs = outcome.backoffMs;
    } else if (!parked) {
      // Flaps are non-fatal: soft so five short-lived 200s cannot hard-STOP the
      // lane or mint provider_degraded pages. Console stays up.
      logApiHealth({
        service: "congress.trade:sse",
        ok: false,
        latencyMs: livedMs,
        errorText: connectFailed ? connectError : "SSE flap (short-lived connection)",
        soft: true,
      });
      recordPeerLaneSample(PEER_LANE_CONGRESS_SSE, livedMs);
      // Honor Retry-After when it is already larger than the flap backoff.
      state.backoffMs = Math.max(state.backoffMs, outcome.backoffMs);
    }
    if (state.closing) break;
    await sleep(state.backoffMs);
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

/** Test-only: restore module state so stream tests do not leak backoff/flap counters. */
export function resetCongressStreamStateForTests(): void {
  state.started = false;
  state.closing = false;
  state.backoffMs = INITIAL_BACKOFF_MS;
  state.lastEventId = undefined;
  state.controller = undefined;
  state.subscription = undefined;
  state.flapsInWindow = 0;
  state.flapWindowStartedAt = 0;
}
