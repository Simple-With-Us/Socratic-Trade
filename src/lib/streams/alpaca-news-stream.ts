// Persistent Alpaca news WebSocket worker (free Benzinga feed). Connects OUT and holds a
// long-lived socket — the inverse of the inbound TradingView webhook — so it must run in the
// persistent Node process (started from instrumentation.register, NOT a per-request handler).
//
// Flow per Alpaca's protocol: connect → server sends {T:"success",msg:"connected"} → we send
// auth → {T:"success",msg:"authenticated"} → we subscribe news:["*"] → {T:"n",...} articles.
// On each article we write headlines into the push store; the enrichment provider reads it.
// Reconnects with exponential backoff; dedups by article id. Opt-in (STREAMS_ALPACA_NEWS_ENABLED).
//
// Relevance gating (NEWS_RELEVANCE_FILTER): Alpaca/Benzinga tags each article with EVERY symbol
// it mentions, with no native per-symbol relevance score — a broad market-roundup article can
// carry a long `symbols` list where the headline text only actually names one or two of them.
// filterRelevantStreamSymbols applies news-relevance.ts's text rubric PER symbol before the
// article reaches the store, dropping only zero-evidence associations on multi-symbol articles
// (single-symbol attribution is always trusted — see the function comment for why the stream
// path cannot use the threshold knob the keyed providers use). Never drops the whole article.
// Disabled -> every tagged symbol passes through unchanged.

import { resolveAlpacaStreamAccount } from "../db";
import { scoreHeadlineRelevance } from "../news-relevance";
import { serverKnobBool } from "../server-knobs";
import { resolveSourceBool, resolveSourceNumber } from "../source-settings";
import { recordStreamedArticle } from "./news-store";

const ALPACA_NEWS_WS = process.env.ALPACA_NEWS_WS_URL || "wss://stream.data.alpaca.markets/v1beta1/news";
const MAX_BACKOFF_MS = 60_000;

// In-memory counter for observability — a persistent WS stream has no natural "run" boundary to
// attach a bounded audit_events row to (an article can arrive every few seconds during market
// hours; a DB row per drop would spam the hash-chained audit log — see audit-bounded-run.ts for
// the real production incident an unbounded per-event audit payload caused). Exposed for tests
// and a future ops-panel hook rather than written to the DB.
let droppedAssociationCount = 0;

/** Cumulative (symbol, article) associations the relevance filter has dropped since process
 *  start (or the last resetStreamRelevanceDroppedAssociationCount() call). */
export function streamRelevanceDroppedAssociationCount(): number {
  return droppedAssociationCount;
}

/** Test helper. */
export function resetStreamRelevanceDroppedAssociationCount(): void {
  droppedAssociationCount = 0;
}

/**
 * Filters a streamed article's raw (Alpaca-format) symbol tags down to the ones the headline
 * text gives at least SOME relevance evidence for (news-relevance.ts, scored against the symbol
 * AS ALPACA SENT IT). Deliberately more conservative than the keyed-provider gates: the stream
 * payload carries no company name, so the rubric only sees the ticker token — a headline saying
 * "Apple beats estimates" scores 0 for AAPL here even though Benzinga's attribution is correct.
 * Two guards keep provider attribution from being the sole casualty of that blindness:
 *   - single-symbol articles always pass (Benzinga's tag is the only signal we have — trust it);
 *   - multi-symbol articles drop only ZERO-evidence symbols (score === 0), not sub-threshold
 *     ones, so the filter prunes roundup-list noise without second-guessing scored matches.
 * Disabled (NEWS_RELEVANCE_FILTER=false) returns `symbols` unchanged.
 */
export function filterRelevantStreamSymbols(headline: string, symbols: string[]): string[] {
  if (!resolveSourceBool("NEWS_RELEVANCE_FILTER")) return symbols;
  if (symbols.length <= 1) return symbols;
  const kept: string[] = [];
  let dropped = 0;
  for (const symbol of symbols) {
    if (scoreHeadlineRelevance(headline, symbol).score > 0) kept.push(symbol);
    else dropped++;
  }
  if (dropped > 0) droppedAssociationCount += dropped;
  return kept;
}

interface StreamState {
  ws?: WebSocket;
  started: boolean;
  closing: boolean;
  backoffMs: number;
}

const globalForStream = globalThis as unknown as { __alpacaNewsStream?: StreamState };
const state: StreamState =
  globalForStream.__alpacaNewsStream ?? (globalForStream.__alpacaNewsStream = { started: false, closing: false, backoffMs: 1000 });

export function alpacaNewsStreamEnabled(): boolean {
  // Server knob: Admin > Operations DB override > STREAMS_ALPACA_NEWS_ENABLED env > off.
  return serverKnobBool("STREAMS_ALPACA_NEWS_ENABLED");
}

/** Idempotent: starts the worker once if enabled and Alpaca keys are present. */
export function startAlpacaNewsStream(): void {
  if (state.started || state.closing) return;
  if (!alpacaNewsStreamEnabled()) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[stream:alpaca-news] global WebSocket unavailable in this runtime; not starting.");
    return;
  }
  // Process-level background worker (no per-request user): keyed to the `local` operator's
  // active connected Alpaca account (falls back to the legacy standalone key pair).
  const creds = resolveAlpacaStreamAccount("local");
  if (!creds) {
    console.warn("[stream:alpaca-news] missing Alpaca key; not starting.");
    return;
  }
  state.started = true;
  connect(creds.apiKey, creds.apiSecret);
}

function connect(key: string, secret?: string): void {
  if (state.closing) return;
  if (!alpacaNewsStreamEnabled()) {
    // Server-knob park: keep the single reconnect chain alive as a slow poll (capped by
    // MAX_BACKOFF_MS) so flipping the knob back on resumes without a redeploy — and without a
    // second lifecycle chain racing this one.
    scheduleReconnect(key, secret);
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(ALPACA_NEWS_WS);
  } catch {
    scheduleReconnect(key, secret);
    return;
  }
  state.ws = ws;

  ws.onmessage = (event: MessageEvent) => {
    if (!alpacaNewsStreamEnabled()) {
      // Server-knob park: close on the first message after a flip off; onclose reconnects into
      // the parked poll in connect(). Cheap — the knob read is cached (~15s) between messages.
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }
    let messages: unknown;
    try {
      messages = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (!Array.isArray(messages)) return;
    for (const raw of messages) {
      const m = raw as Record<string, unknown>;
      const t = m.T;
      if (t === "success" && m.msg === "connected") {
        if (secret) {
          ws.send(JSON.stringify({ action: "auth", key, secret }));
        } else {
          ws.send(JSON.stringify({ action: "auth", key: "oauth", secret: key }));
        }
      } else if (t === "success" && m.msg === "authenticated") {
        ws.send(JSON.stringify({ action: "subscribe", news: ["*"] }));
        state.backoffMs = 1000; // reset after a clean auth
        console.log("[stream:alpaca-news] authenticated + subscribed to news.");
      } else if (t === "n") {
        const headline = typeof m.headline === "string" ? m.headline : "";
        const symbols = Array.isArray(m.symbols) ? (m.symbols as unknown[]).map(String) : [];
        if (headline && symbols.length > 0) {
          const relevantSymbols = filterRelevantStreamSymbols(headline, symbols);
          if (relevantSymbols.length > 0) recordStreamedArticle(relevantSymbols, headline, String(m.id ?? ""));
        }
      } else if (t === "error") {
        console.warn("[stream:alpaca-news] error frame:", m.msg ?? JSON.stringify(m));
      }
    }
  };

  ws.onerror = () => {
    // onclose fires next and handles reconnect.
  };
  ws.onclose = () => {
    state.ws = undefined;
    scheduleReconnect(key, secret);
  };
}

function scheduleReconnect(key: string, secret?: string): void {
  if (state.closing) return;
  const delay = Math.min(state.backoffMs, MAX_BACKOFF_MS);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(() => connect(key, secret), delay);
}

export function stopAlpacaNewsStream(): void {
  state.closing = true;
  try {
    state.ws?.close();
  } catch {
    // ignore
  }
}
