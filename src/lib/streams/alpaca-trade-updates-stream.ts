// Persistent Alpaca trade_updates (account/fill) WebSocket worker. Mirrors the news worker, but
// hits the TRADING host with a different auth/subscribe handshake and BINARY frames (whose payload
// is still JSON — no msgpack — and a single object, not the array the news stream sends).
//
// On a fill / partial_fill it runs the deterministic fill handler (reconcile + dashboard refresh).
// Opt-in (STREAMS_ALPACA_TRADE_UPDATES_ENABLED); no-op without Alpaca keys.

import { resolveAlpacaStreamAccount } from "../db";
import { onBrokerFill } from "../fills";
import { fromAlpacaSymbol } from "../money";
import { serverKnobBool } from "../server-knobs";

// Paper and live Alpaca accounts authenticate against DIFFERENT trade_updates hosts — a live
// key gets HTTP 401 against the paper host and vice versa. An explicit env override always
// wins; otherwise the host is picked per-connection from the resolved account's environment
// (see resolveAlpacaStreamAccount), not hardcoded to paper.
function tradeWsUrl(environment: "paper" | "live"): string {
  if (process.env.ALPACA_TRADE_WS_URL) return process.env.ALPACA_TRADE_WS_URL;
  return environment === "live" ? "wss://api.alpaca.markets/stream" : "wss://paper-api.alpaca.markets/stream";
}
const MAX_BACKOFF_MS = 60_000;

interface StreamState {
  ws?: WebSocket;
  started: boolean;
  closing: boolean;
  backoffMs: number;
  seen: Set<string>;
}

const globalForStream = globalThis as unknown as { __alpacaTradeStream?: StreamState };
const state: StreamState =
  globalForStream.__alpacaTradeStream ?? (globalForStream.__alpacaTradeStream = { started: false, closing: false, backoffMs: 1000, seen: new Set() });

export function alpacaTradeUpdatesEnabled(): boolean {
  // Server knob: Admin > Operations DB override > STREAMS_ALPACA_TRADE_UPDATES_ENABLED env > off.
  return serverKnobBool("STREAMS_ALPACA_TRADE_UPDATES_ENABLED");
}

export function startAlpacaTradeUpdatesStream(): void {
  if (state.started || state.closing) return;
  if (!alpacaTradeUpdatesEnabled()) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[stream:alpaca-trades] global WebSocket unavailable; not starting.");
    return;
  }
  // Process-level background worker (no per-request user): keyed to the `local` operator's
  // active connected Alpaca account (falls back to the legacy standalone key pair).
  // Multi-user fill streaming is a deferred refactor — fills observed here are the operator's.
  const creds = resolveAlpacaStreamAccount("local");
  if (!creds) {
    console.warn("[stream:alpaca-trades] missing Alpaca API key; not starting.");
    return;
  }
  state.started = true;
  connect(creds.apiKey, creds.apiSecret, creds.environment);
}

function connect(key: string, secret: string | undefined, environment: "paper" | "live"): void {
  if (state.closing) return;
  if (!alpacaTradeUpdatesEnabled()) {
    // Server-knob park: keep the single reconnect chain alive as a slow poll (capped by
    // MAX_BACKOFF_MS) so flipping the knob back on resumes without a redeploy.
    scheduleReconnect(key, secret, environment);
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(tradeWsUrl(environment));
  } catch {
    scheduleReconnect(key, secret, environment);
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    try {
      if (secret) {
        ws.send(JSON.stringify({ action: "auth", key, secret }));
      } else {
        ws.send(JSON.stringify({ action: "auth", key: "oauth", secret: key }));
      }
    } catch {
      // onclose will reconnect
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    if (!alpacaTradeUpdatesEnabled()) {
      // Server-knob park: close on the first message after a flip off; onclose reconnects into
      // the parked poll in connect().
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const stream = msg.stream;
    if (stream === "authorization") {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      if (data.status === "authorized") {
        ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
        state.backoffMs = 1000;
        console.log("[stream:alpaca-trades] authorized + listening to trade_updates.");
      } else {
        console.warn("[stream:alpaca-trades] auth not authorized:", JSON.stringify(data));
      }
    } else if (stream === "trade_updates") {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      const ev = String(data.event ?? "");
      if (ev !== "fill" && ev !== "partial_fill") return;
      const order = (data.order ?? {}) as Record<string, unknown>;
      const orderId = String(order.id ?? "");
      const symbol = order.symbol ? fromAlpacaSymbol(String(order.symbol)) : undefined;
      const dedup = `${orderId}:${ev}:${String(data.timestamp ?? "")}`;
      if (state.seen.has(dedup)) return;
      state.seen.add(dedup);
      if (state.seen.size > 500) state.seen = new Set(Array.from(state.seen).slice(-250));
      void onBrokerFill({ orderId, symbol, event: ev }).catch((e) => console.error("[stream:alpaca-trades] fill handler:", e));
    }
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };
  ws.onclose = () => {
    state.ws = undefined;
    scheduleReconnect(key, secret, environment);
  };
}

function scheduleReconnect(key: string, secret: string | undefined, environment: "paper" | "live"): void {
  if (state.closing) return;
  const delay = Math.min(state.backoffMs, MAX_BACKOFF_MS);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(() => connect(key, secret, environment), delay);
}

export function stopAlpacaTradeUpdatesStream(): void {
  state.closing = true;
  try {
    state.ws?.close();
  } catch {
    // ignore
  }
}
