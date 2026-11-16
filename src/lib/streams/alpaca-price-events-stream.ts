// Alpaca real-time PRICE event-trigger producer.
//
// Subscribes to Alpaca's market-data WebSocket (minute bars) for the union of active users'
// explicit symbols (watchlist + additionalSymbols — NOT whole index universes, which would blow
// past the free IEX subscription cap), runs a cheap deterministic technical filter (prior-day-high
// break / large intraday move / volume spike), and on a hit submits a "technical" material event to
// the trigger engine for every active user who watches that symbol — firing a fresh decision cycle
// instead of waiting for the scheduled tick.
//
// One shared connection on the operator market-data key (market data is identical for every user).
// Per-user fan-out + all gating (systemState, market hours, cooldowns, caps) live in the trigger
// engine, so this producer just detects and forwards. DEFAULT OFF (STREAMS_ALPACA_PRICE_EVENTS_ENABLED);
// also inert unless TRIGGER_ENGINE is on. No-op without an Alpaca market-data key.

import { getPolicy, listUsers, listWatchlistSymbols, resolveAlpacaMarketData } from "../db";
import { fetchDailyOHLC } from "../history";
import { normalizeSymbol } from "../money";
import { serverKnobBool } from "../server-knobs";
import { submitMaterialEvent, triggerEngineEnabled } from "../triggers";

const MAX_BACKOFF_MS = 60_000;
// Free IEX plan caps concurrent symbol subscriptions; keep the watched set bounded and visible.
const DEFAULT_MAX_SYMBOLS = 30;

function dataWsUrl(): string {
  if (process.env.ALPACA_DATA_WS_URL) return process.env.ALPACA_DATA_WS_URL;
  const feed = (process.env.ALPACA_DATA_FEED || "iex").trim().toLowerCase();
  return `wss://stream.data.alpaca.markets/v2/${feed === "sip" ? "sip" : "iex"}`;
}

// ── Pure deterministic signal evaluator (unit-tested) ─────────────────────────
export interface PriceSignalRef {
  /** Prior trading day's close. */
  priorClose: number;
  /** Prior trading day's high (0 disables the breakout check). */
  priorDayHigh: number;
  /** Average daily volume baseline (0 disables the volume-spike check). */
  avgDayVolume: number;
  /** Running intraday high so far today (incl. the current bar). */
  todayHigh: number;
  /** Running cumulative volume so far today (incl. the current bar). */
  todayVolume: number;
}

export interface PriceSignalThresholds {
  movePct: number;
  volumeMult: number;
  enableBreakout: boolean;
  enableMove: boolean;
  enableVolume: boolean;
}

export function priceSignalThresholds(): PriceSignalThresholds {
  const num = (name: string, dflt: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const flag = (name: string, dflt: boolean) => {
    const v = String(process.env[name] ?? "").trim().toLowerCase();
    if (!v) return dflt;
    return ["1", "true", "on", "yes"].includes(v);
  };
  return {
    movePct: num("ALPACA_PRICE_EVENT_MOVE_PCT", 3),
    volumeMult: num("ALPACA_PRICE_EVENT_VOLUME_MULT", 1.5),
    enableBreakout: flag("ALPACA_PRICE_EVENT_BREAKOUT", true),
    enableMove: flag("ALPACA_PRICE_EVENT_MOVE", true),
    enableVolume: flag("ALPACA_PRICE_EVENT_VOLUME", true)
  };
}

/** Returns the list of triggered signal kinds for a bar close + reference data. Pure + testable. */
export function evaluatePriceSignal(close: number, ref: PriceSignalRef, t: PriceSignalThresholds): string[] {
  const hits: string[] = [];
  if (!(close > 0)) return hits;
  if (t.enableBreakout && ref.priorDayHigh > 0 && ref.todayHigh > ref.priorDayHigh) {
    hits.push("prior_day_high_break");
  }
  if (t.enableMove && ref.priorClose > 0 && (Math.abs(close - ref.priorClose) / ref.priorClose) * 100 >= t.movePct) {
    hits.push("intraday_move");
  }
  if (t.enableVolume && ref.avgDayVolume > 0 && ref.todayVolume >= ref.avgDayVolume * t.volumeMult) {
    hits.push("volume_spike");
  }
  return hits;
}

// ── Subscription-set + fan-out helpers (pure-ish; testable) ───────────────────
interface WatchEntry {
  ref?: PriceSignalRef;
  refDay?: string;        // YYYY-MM-DD the ref/intraday accumulators belong to
  refLoading?: boolean;
  firedToday: Set<string>; // signal kinds already fired today (dedup at source)
}

/** Active users → the explicit symbols they watch (watchlist + additionalSymbols), and the reverse. */
export function buildWatchedSymbolIndex(maxSymbols = DEFAULT_MAX_SYMBOLS): { symbols: string[]; symbolToUsers: Map<string, Set<string>>; truncated: number } {
  const symbolToUsers = new Map<string, Set<string>>();
  for (const userId of listUsers()) {
    const policy = getPolicy(userId);
    if (policy.systemState !== "active" || !policy.accountNumber) continue;
    const explicit = new Set<string>();
    for (const s of policy.additionalSymbols ?? []) explicit.add(normalizeSymbol(s));
    for (const w of listWatchlistSymbols(userId)) explicit.add(normalizeSymbol(w.symbol));
    for (const b of policy.blocklist ?? []) explicit.delete(normalizeSymbol(b));
    for (const sym of explicit) {
      if (!sym) continue;
      let set = symbolToUsers.get(sym);
      if (!set) { set = new Set(); symbolToUsers.set(sym, set); }
      set.add(userId);
    }
  }
  const all = [...symbolToUsers.keys()].sort();
  const symbols = all.slice(0, maxSymbols);
  const truncated = Math.max(0, all.length - symbols.length);
  // Drop truncated symbols from the reverse index so we never claim to watch what we didn't subscribe.
  for (const sym of all.slice(maxSymbols)) symbolToUsers.delete(sym);
  return { symbols, symbolToUsers, truncated };
}

// ── Stream worker ─────────────────────────────────────────────────────────────
interface StreamState {
  ws?: WebSocket;
  started: boolean;
  closing: boolean;
  backoffMs: number;
  symbolToUsers: Map<string, Set<string>>;
  watch: Map<string, WatchEntry>;
}

const globalForStream = globalThis as unknown as { __alpacaPriceStream?: StreamState };
const state: StreamState =
  globalForStream.__alpacaPriceStream ??
  (globalForStream.__alpacaPriceStream = { started: false, closing: false, backoffMs: 1000, symbolToUsers: new Map(), watch: new Map() });

export function alpacaPriceEventsEnabled(): boolean {
  // Server knob: Admin > Operations DB override > STREAMS_ALPACA_PRICE_EVENTS_ENABLED env > off.
  return serverKnobBool("STREAMS_ALPACA_PRICE_EVENTS_ENABLED");
}

function maxSymbols(): number {
  const v = Number(process.env.ALPACA_PRICE_EVENT_MAX_SYMBOLS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_SYMBOLS;
}

export function startAlpacaPriceEventProducer(): void {
  if (state.started || state.closing) return;
  if (!alpacaPriceEventsEnabled()) return;
  if (!triggerEngineEnabled()) {
    console.warn("[stream:alpaca-price] TRIGGER_ENGINE is off; price events would no-op — not starting.");
    return;
  }
  if (typeof WebSocket === "undefined") {
    console.warn("[stream:alpaca-price] global WebSocket unavailable; not starting.");
    return;
  }
  const creds = resolveAlpacaMarketData("local");
  if (!creds.apiKey || !creds.secretKey) {
    console.warn("[stream:alpaca-price] missing Alpaca market-data key; not starting.");
    return;
  }
  const { symbols, symbolToUsers, truncated } = buildWatchedSymbolIndex(maxSymbols());
  if (symbols.length === 0) {
    console.warn("[stream:alpaca-price] no active users with watched symbols; not starting.");
    return;
  }
  if (truncated > 0) {
    console.warn(`[stream:alpaca-price] watching ${symbols.length} symbols; ${truncated} dropped over the ${maxSymbols()} cap (raise ALPACA_PRICE_EVENT_MAX_SYMBOLS or use SIP).`);
  }
  state.symbolToUsers = symbolToUsers;
  state.watch = new Map(symbols.map((s) => [s, { firedToday: new Set<string>() }]));
  state.started = true;
  connect(creds.apiKey, creds.secretKey, symbols);
}

function connect(key: string, secret: string, symbols: string[]): void {
  if (state.closing) return;
  if (!alpacaPriceEventsEnabled()) {
    // Server-knob park: keep the single reconnect chain alive as a slow poll (capped by
    // MAX_BACKOFF_MS) so flipping the knob back on resumes without a redeploy.
    scheduleReconnect(key, secret, symbols);
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(dataWsUrl());
  } catch {
    scheduleReconnect(key, secret, symbols);
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ action: "auth", key, secret }));
    } catch {
      // onclose reconnects
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    if (!alpacaPriceEventsEnabled()) {
      // Server-knob park: close on the first message after a flip off; onclose reconnects into
      // the parked poll in connect().
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }
    let payload: unknown;
    try {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const items = Array.isArray(payload) ? payload : [payload];
    for (const raw of items) {
      const m = raw as Record<string, unknown>;
      const T = String(m.T ?? "");
      if (T === "success" && m.msg === "authenticated") {
        try {
          ws.send(JSON.stringify({ action: "subscribe", bars: symbols }));
          state.backoffMs = 1000;
          console.log(`[stream:alpaca-price] authenticated; subscribed to ${symbols.length} symbols' minute bars.`);
        } catch {
          // onclose reconnects
        }
      } else if (T === "error") {
        console.warn("[stream:alpaca-price] stream error:", JSON.stringify(m));
      } else if (T === "b") {
        void handleBar(m).catch((e) => console.error("[stream:alpaca-price] bar handler:", e));
      }
    }
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };
  ws.onclose = () => {
    state.ws = undefined;
    scheduleReconnect(key, secret, symbols);
  };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lazily load prior-day reference data for a symbol (once per day) from the shared history cascade. */
async function ensureRef(symbol: string, entry: WatchEntry): Promise<void> {
  const day = todayStr();
  if (entry.refDay !== day) {
    // New day: reset accumulators + fired flags.
    entry.ref = undefined;
    entry.refDay = day;
    entry.firedToday = new Set();
  }
  if (entry.ref || entry.refLoading) return;
  entry.refLoading = true;
  try {
    const bars = await fetchDailyOHLC(symbol, Date.now(), "local");
    if (bars && bars.length >= 2) {
      // Use the prior completed bar (last bar may be today's partial) as the prior-day reference.
      const prior = bars[bars.length - 2];
      const recent = bars.slice(-21, -1);
      const vols = recent.map((b) => b.volume).filter((v): v is number => typeof v === "number" && v > 0);
      const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      entry.ref = {
        priorClose: prior.close,
        priorDayHigh: typeof prior.high === "number" ? prior.high : 0,
        avgDayVolume: avgVol,
        todayHigh: 0,
        todayVolume: 0
      };
    }
  } catch {
    // leave ref undefined; we just won't emit signals for this symbol until it loads
  } finally {
    entry.refLoading = false;
  }
}

async function handleBar(m: Record<string, unknown>): Promise<void> {
  const symbol = m.S ? normalizeSymbol(String(m.S)) : undefined;
  if (!symbol) return;
  const entry = state.watch.get(symbol);
  if (!entry) return;
  await ensureRef(symbol, entry);
  if (!entry.ref) return;

  const close = Number(m.c);
  const high = Number(m.h);
  const vol = Number(m.v);
  if (!(close > 0)) return;
  if (Number.isFinite(high) && high > entry.ref.todayHigh) entry.ref.todayHigh = high;
  if (Number.isFinite(vol) && vol > 0) entry.ref.todayVolume += vol;

  const thresholds = priceSignalThresholds();
  const hits = evaluatePriceSignal(close, entry.ref, thresholds).filter((kind) => !entry.firedToday.has(kind));
  if (hits.length === 0) return;
  for (const kind of hits) entry.firedToday.add(kind);

  const users = state.symbolToUsers.get(symbol);
  if (!users || users.size === 0) return;
  const sourceId = `alpaca:price:${symbol}:${hits.sort().join(",")}:${entry.refDay}`;
  const reason = `Alpaca price signal: ${hits.join(", ")} on ${symbol}`;
  for (const userId of users) {
    submitMaterialEvent(userId, { type: "technical", symbol, sourceId, reason });
  }
}

function scheduleReconnect(key: string, secret: string, symbols: string[]): void {
  if (state.closing) return;
  const delay = Math.min(state.backoffMs, MAX_BACKOFF_MS);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(() => connect(key, secret, symbols), delay);
}

export function stopAlpacaPriceEventProducer(): void {
  state.closing = true;
  try {
    state.ws?.close();
  } catch {
    // ignore
  }
}
