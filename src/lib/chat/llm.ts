// Provider-agnostic LLM contract: run({ system, message, tools, executeTool, context }) drives a
// tool loop and returns { text, toolCalls, citations }. The model can only call the tools it is
// given (read-only get_quote/kb_search, draft-only draft_order, reversible create_alert/
// watchlist_add) — there is NO execution tool. AnthropicLLM takes an injectable transport so the
// real multi-turn tool loop is unit-testable offline; MockLLM is a deterministic offline stand-in.
// Ported from reference/atlas-public-src/bff/llm/client.mjs.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { canonicalTicker } from "../rag/chunk";
import { resolveLlmCredential } from "../db";
import { recordLlmUsage, extractLlmUsage } from "../llm-usage";
import { llmFetch, reasoningCapabilityForModel, withLlmRequestBounds } from "../llm-request";
import type { LlmReasoningEffort } from "../types";
import { DISCLAIMER, SYSTEM_PROMPT } from "./prompt";
import type { ChatLLM, Citation, LlmResult, LlmRunArgs, ToolCall } from "./types";

/** Per-user attribution for the LLM usage ledger. When `userId` is set, run() records a usage row. */
export interface LlmUsageOpts {
  userId?: string;
  keySource?: "user" | "operator";
  /** Non-secret fingerprint of the key serving this call (per-attached-key attribution). */
  keyRef?: string;
  context?: string;
}

/** The chat providers. All but Anthropic are OpenAI-compatible (chat/completions tool loop). */
export type ChatProvider = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";

/** Sum usage across the (possibly multi-step) tool loop and record one ledger row. */
function recordChatUsage(opts: LlmUsageOpts, provider: ChatProvider, model: string, prompt: number, completion: number, saw: boolean): void {
  if (!opts.userId) return;
  recordLlmUsage({
    userId: opts.userId,
    provider,
    model,
    context: opts.context ?? "chat",
    keySource: opts.keySource ?? "user",
    keyRef: opts.keyRef,
    promptTokens: saw ? prompt : undefined,
    completionTokens: saw ? completion : undefined
  });
}

const MAX_STEPS = 5;

export interface Intent {
  intent: "alert" | "order" | "watchlist_add" | "kb" | "positions" | "watchlist_view" | "alerts_view" | "advice" | "quote" | "fundamentals" | "market_signals" | "chat";
  symbol?: string;
  alert?: { symbol: string; op: "<" | ">"; price: number };
  order?: { side: string; qty: number; symbol: string; order_type: string; limit_usd: number | null };
  doc_type?: string;
}

/** Cheap deterministic intent router (also a pre-router in front of a real model). */
export function classifyIntent(message: string): Intent {
  const lc = String(message).toLowerCase();
  const EXCLUDE = ["THE", "BUY", "SELL", "USD", "PE", "AND", "FOR", "YOU"];
  // First pass: standard all-uppercase tickers (e.g. "AAPL price").
  // Second pass: phrase-pattern fallback for all-lowercase input (e.g. "how much is aapl",
  // "aapl price") — avoids false matches on ordinary English words.
  const sym = (() => {
    const upper = (String(message).match(/\b([A-Z]{2,5})\b/g) ?? []).map(canonicalTicker).find((s) => !EXCLUDE.includes(s));
    if (upper) return upper;
    const m =
      String(message).match(/\b(?:price\s+of|how\s+much\s+(?:is|for)|quote\s+for)\s+\$?([A-Za-z.]{1,10})\b/i) ??
      String(message).match(/\b\$?([A-Za-z.]{2,10})\s+(?:price|quote|stock)\b/i);
    const ticker = m ? canonicalTicker(m[1]!) : undefined;
    return ticker && !EXCLUDE.includes(ticker) ? ticker : undefined;
  })();

  if (
    /\b(alert|notify|tell me|let me know|remind me)\b/.test(lc) &&
    /\b(below|under|above|over|drops?|falls?|rises?|hits?|reaches?|<|>)\b/.test(lc)
  ) {
    const dir: "<" | ">" = /\b(below|under|drops?|falls?|<)\b/.test(lc) ? "<" : ">";
    const priceM = lc.match(/\$?\s*(\d+(?:\.\d+)?)/);
    if (sym && priceM) return { intent: "alert", alert: { symbol: sym, op: dir, price: Number(priceM[1]) } };
  }

  const orderM = String(message).match(/\b(buy|sell)\b\s+(\d+)\s+(?:shares?\s+(?:of\s+)?)?([A-Za-z.]{1,10})/i);
  if (orderM) {
    const limitM = lc.match(/(?:at|limit|@)\s*\$?(\d+(?:\.\d+)?)/);
    return {
      intent: "order",
      order: {
        side: orderM[1]!.toLowerCase(),
        qty: Number(orderM[2]),
        symbol: canonicalTicker(orderM[3]!),
        order_type: limitM ? "limit" : "market",
        limit_usd: limitM ? Number(limitM[1]) : null
      }
    };
  }

  const watchM =
    String(message).match(/\b(?:add|put|track|watch|follow)\s+\$?([A-Za-z.]{1,10})\b(?:[^.?!]{0,40}\bwatchlist\b)?/i) ||
    String(message).match(/\bwatchlist\b[^.?!]{0,40}\$?([A-Za-z.]{1,10})\b/i);
  if (watchM && /\b(watchlist|watch|track|follow)\b/.test(lc)) return { intent: "watchlist_add", symbol: canonicalTicker(watchM[1]!) };

  const docType = lc.match(/\b(10-k|10-q|8-k|filing|news|note|document|report)\b/)?.[1]?.toUpperCase();
  if (/\b(what did|say about|according to|filing|10-k|10-q|8-k|risk factors?|knowledge|research|document|source|kb)\b/.test(lc))
    return {
      intent: "kb",
      symbol: sym,
      doc_type: docType && !["FILING", "DOCUMENT", "REPORT"].includes(docType) ? docType : undefined
    };
  if (/\b(pe ratio|pe|market cap|earnings|analyst|rating|score|consensus|target|price target|beta|dividend|float|week high|week low|debt to equity|fundamentals)\b/.test(lc) && sym) {
    return { intent: "fundamentals", symbol: sym };
  }
  if (/\b(best today|market signals?|breadth|top gainers?|top losers?|market breadth|gainer|loser|movers|volatility indices|vvix|skew)\b/.test(lc)) {
    return { intent: "market_signals" };
  }
  if (
    /\b(my (positions?|portfolio|holdings)|how (?:am i|is my account|are my (?:positions|holdings)) doing|how (?:'?s|is) my [a-z. ]*position|my (?:p&l|pnl|p ?and ?l|gains?|losses?))\b/.test(lc)
  )
    return { intent: "positions" };
  if (/\b(my watchlist|what'?s on my watchlist|show (?:me )?my watchlist)\b/.test(lc)) return { intent: "watchlist_view" };
  if (/\b(my alerts?|what alerts|active alerts?|show (?:me )?my alerts?)\b/.test(lc)) return { intent: "alerts_view" };
  if (/\b(should i|is it a good (buy|time)|recommend|what should i do|allocate)\b/.test(lc)) return { intent: "advice", symbol: sym };
  if (/\b(price|quote|trading at|how much is|what'?s)\b/.test(lc) && sym) return { intent: "quote", symbol: sym };
  if (sym) return { intent: "quote", symbol: sym };
  return { intent: "chat" };
}

function narrateQuote(quote: any, advice: boolean): string {
  let lead = `${quote.symbol} is at $${quote.price_usd}`;
  if (typeof quote.change_pct === "number" && Number.isFinite(quote.change_pct)) {
    lead += `, ${quote.change_pct >= 0 ? "up" : "down"} ${Math.abs(quote.change_pct)}%`;
  }
  // Only narrate fields the source actually provided — never fabricate a 0% or a session.
  const meta = [
    quote.as_of ? `as of ${quote.as_of}` : null,
    quote.source ? `${quote.source} data` : null,
    quote.session ? `${quote.session} session` : null
  ].filter(Boolean);
  let text = meta.length ? `${lead} (${meta.join(", ")}).` : `${lead}.`;
  if (advice)
    text +=
      ` I can't tell you whether to buy or sell — that depends on your full financial picture, ` +
      `and I'm not a licensed advisor. I can lay out the trade-offs and you decide.`;
  return text;
}

function fmt(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
}

/**
 * Ensure the "not investment advice" DISCLAIMER is present exactly once. The real Anthropic
 * path used to append it only on an empty response (`text || DISCLAIMER`), so it could silently
 * vanish on a non-empty answer — every user-facing reply must carry it. Idempotent: if the model
 * already echoed the disclaimer, we don't double-append.
 */
function withDisclaimer(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return DISCLAIMER;
  if (trimmed.includes(DISCLAIMER)) return trimmed;
  return `${trimmed}\n\n${DISCLAIMER}`;
}

function groundedChat(message: string, memorySummary?: string): string {
  const lc = message.toLowerCase();
  if (/p\/?e|price.to.earnings/.test(lc))
    return "P/E (price-to-earnings) is a stock's price divided by its earnings per share — a rough valuation gauge.";
  if (/\bwhat do you remember|what do you know about me\b/.test(lc))
    return memorySummary ? `Here's what I have on file:\n${memorySummary}` : "I don't have anything on file for you yet.";
  return 'Noted. Ask me for a quote (e.g. "AAPL price") or to draft an order (e.g. "buy 10 AAPL at 200") and I\'ll help — every order is a draft you confirm.';
}

function bestSentence(text: string, query: string): string {
  const tokens = new Set(String(query).toLowerCase().match(/[a-z0-9.$%-]+/g) ?? []);
  const sentences = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  let best = sentences[0] ?? String(text).slice(0, 240);
  let bestScore = -1;
  for (const s of sentences) {
    const sc = (String(s).toLowerCase().match(/[a-z0-9.$%-]+/g) ?? []).reduce((sum, t) => sum + (tokens.has(t) ? 1 : 0), 0);
    if (sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }
  return best.trim();
}

/** Prefix marking every Mock reply so the user can never mistake it for a real model's answer. */
const MOCK_PREFIX = "Mock Response: ";
function labelMock(text: string): string {
  return text.startsWith(MOCK_PREFIX) ? text : `${MOCK_PREFIX}${text}`;
}

/** Deterministic offline stand-in, shaped exactly like a real tool-use loop. */
export class MockLLM implements ChatLLM {
  readonly modelName = "mock";
  /** Public entry: produce the deterministic answer, then label it so it's clearly a mock response. */
  async run(args: LlmRunArgs): Promise<LlmResult> {
    const result = await this.answer(args);
    return { ...result, text: labelMock(result.text) };
  }

  private async answer({ message, executeTool, context = {} }: LlmRunArgs): Promise<LlmResult> {
    const cls = classifyIntent(message);
    const toolCalls: ToolCall[] = [];

    if (cls.intent === "fundamentals" && cls.symbol) {
      const input = { symbol: cls.symbol };
      const result = await executeTool("get_fundamentals", input);
      toolCalls.push({ name: "get_fundamentals", input, result });
      if (result?.error) return { text: `I don't have fundamentals data on that.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      return {
        text: `Company: ${result.companyName ?? cls.symbol}. PE: ${result.peRatio ?? "n/a"}. Analyst rating: ${result.analystRating ?? "n/a"}.\n\n${DISCLAIMER}`,
        toolCalls,
        citations: []
      };
    }

    if (cls.intent === "market_signals") {
      const result = await executeTool("get_market_signals", {});
      toolCalls.push({ name: "get_market_signals", input: {}, result });
      if (result?.error) return { text: `I couldn't retrieve market signals.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      const gainers = result.marketTopGainers?.map((g: any) => `${g.sym} (+${g.pct}%)`).join(", ") ?? "none";
      return {
        text: `Breadth: ${result.marketBreadthPct ?? "n/a"}%. Top Gainers: ${gainers}.\n\n${DISCLAIMER}`,
        toolCalls,
        citations: []
      };
    }

    if (cls.intent === "quote" || cls.intent === "advice") {
      const input = { symbol: cls.symbol };
      const result = await executeTool("get_quote", input);
      toolCalls.push({ name: "get_quote", input, result });
      if (result?.error) return { text: `I don't have data on that.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      return {
        text: `${narrateQuote(result, cls.intent === "advice")}\n\n${DISCLAIMER}`,
        toolCalls,
        citations: [{ source: "get_quote", as_of: result.as_of }]
      };
    }

    if (cls.intent === "alert" && cls.alert) {
      const result = await executeTool("create_alert", cls.alert);
      toolCalls.push({ name: "create_alert", input: cls.alert, result });
      const text = result?.error
        ? `I couldn't set that alert (${result.error}).`
        : `Done — I'll alert you when ${result.symbol} is ${result.op === "<" ? "below" : "above"} $${result.price}.`;
      return { text: `${text}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === "order" && cls.order) {
      const input = { ...cls.order, rationale: "User requested this order." };
      const result = await executeTool("draft_order", input);
      toolCalls.push({ name: "draft_order", input, result });
      const lead = result?.blocked
        ? `I've drafted this order but it can't proceed as-is — ${(result.warnings ?? []).join("; ")}.`
        : `I've prepared a draft order for your review — it won't go through until you confirm.` +
          ` (Account: ${result.account_label}${result.is_real ? "" : " — broker paper account"}.)`;
      return { text: `${lead}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === "kb") {
      const input = { query: message, ticker: cls.symbol, doc_type: cls.doc_type, k: 5 };
      const result = await executeTool("kb_search", input);
      toolCalls.push({ name: "kb_search", input, result });
      const chunks = result?.chunks ?? [];
      if (!chunks.length) {
        return { text: `I don't have data on that in the sources available to me.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      }
      const lines = chunks.slice(0, 2).map((c: any) => `- ${bestSentence(c.text, message)} [${c.chunk_id}]`);
      return {
        text: `${lines.join("\n")}\n\n${DISCLAIMER}`,
        toolCalls,
        citations: chunks.map((c: any) => ({ source: c.source, chunk_id: c.chunk_id, evidence_ref: c.evidence_ref, as_of: c.as_of, url: c.url }))
      };
    }

    if (cls.intent === "watchlist_add") {
      const input = { symbol: cls.symbol };
      const result = await executeTool("watchlist_add", input);
      toolCalls.push({ name: "watchlist_add", input, result });
      if (result?.error) return { text: `I couldn't add that symbol to your watchlist: ${result.error}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      const tag = result.item?.deduped ? "was already" : "is now";
      return { text: `${result.item.symbol} ${tag} on your watchlist.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === "positions") {
      const positionsResult = await executeTool("get_positions", {});
      const portfolioResult = await executeTool("get_portfolio", {});
      toolCalls.push({ name: "get_positions", input: {}, result: positionsResult });
      toolCalls.push({ name: "get_portfolio", input: {}, result: portfolioResult });
      const positions = positionsResult?.positions ?? [];
      const portfolio = portfolioResult?.portfolio;
      const parts: string[] = [];
      if (portfolio) parts.push(`Account value $${fmt(portfolio.totalMarketValue)}, cash $${fmt(portfolio.cash)}.`);
      parts.push(
        positions.length
          ? `Positions: ${positions.map((p: any) => `${p.symbol} ${p.quantity} (~$${fmt(p.marketValue)})`).join(", ")}.`
          : "No open positions."
      );
      return { text: `${parts.join(" ")}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === "watchlist_view") {
      const result = await executeTool("list_watchlist", {});
      toolCalls.push({ name: "list_watchlist", input: {}, result });
      const wl = result?.watchlist ?? [];
      const text = wl.length ? `Your watchlist: ${wl.map((w: any) => w.symbol).join(", ")}.` : "Your watchlist is empty.";
      return { text: `${text}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === "alerts_view") {
      const result = await executeTool("list_alerts", {});
      toolCalls.push({ name: "list_alerts", input: {}, result });
      const al = result?.alerts ?? [];
      const text = al.length
        ? `Your armed alerts: ${al.map((a: any) => `${a.symbol} ${a.op} $${a.price}`).join(", ")}.`
        : "You have no armed alerts.";
      return { text: `${text}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    return { text: `${groundedChat(message, context.memorySummary)}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
  }
}

type Transport = (body: any, apiKey: string) => Promise<any>;

async function defaultTransport(body: any, apiKey: string): Promise<any> {
  const res = await llmFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Enable prompt-caching beta so cache_control blocks are honoured by the API.
      "anthropic-beta": "prompt-caching-2024-07-31"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  return res.json();
}

/** Real Anthropic Messages API tool loop (server-side only). */
export class AnthropicLLM implements ChatLLM {
  constructor(
    private apiKey: string,
    private model: string,
    private transport: Transport = defaultTransport,
    private usage: LlmUsageOpts = {},
    private reasoningEffort?: LlmReasoningEffort
  ) {}

  get modelName(): string {
    return this.model;
  }

  async run({ system, message, tools, executeTool, history }: LlmRunArgs): Promise<LlmResult> {
    const messages: any[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    // Replay prior turns for multi-turn context. Anthropic requires the first message to be user, so
    // drop any leading assistant turn from the (chronological) history before appending the new message.
    const prior = (history ?? []).slice();
    while (prior.length && prior[0].role !== "user") prior.shift();
    for (const h of prior) messages.push({ role: h.role, content: h.text });
    messages.push({ role: "user", content: message });
    const toolCalls: ToolCall[] = [];
    let text = "";

    // Prompt-caching: mark the stable SYSTEM_PROMPT prefix as ephemeral so Anthropic
    // can reuse the cached KV across repeated calls. Only the dynamic suffix (user memory,
    // if present) is left uncached. This is a no-op for non-Anthropic providers since they
    // receive the plain-string `system` via a different transport.
    const anthropicSystem: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> =
      system === SYSTEM_PROMPT
        ? // No dynamic suffix — entire system is stable; cache the whole thing.
          [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]
        : system.startsWith(SYSTEM_PROMPT)
          ? // Dynamic suffix present (user memory) — cache only the stable prefix.
            [
              { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
              { type: "text", text: system.slice(SYSTEM_PROMPT.length) }
            ]
          : // Unrecognised system string (custom override) — send as a single uncached block.
            [{ type: "text", text: system }];

    for (let step = 0; step < MAX_STEPS; step++) {
      const baseBody = { model: this.model, system: anthropicSystem, messages, ...(tools?.length ? { tools } : {}) };
      const requestBody = reasoningCapabilityForModel(this.model)
        ? withLlmRequestBounds(baseBody, "anthropic-messages", {
            model: this.model,
            maxOutputTokens: 1024,
            reasoningEffort: this.reasoningEffort
          })
        : { ...baseBody, max_tokens: 1024 };
      const resp = await this.transport(requestBody, this.apiKey);
      const u = extractLlmUsage(resp);
      if (u.promptTokens !== undefined || u.completionTokens !== undefined) {
        sawUsage = true;
        promptTokens += u.promptTokens ?? 0;
        completionTokens += u.completionTokens ?? 0;
      }
      const content = resp.content || [];
      messages.push({ role: "assistant", content });
      text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

      const toolUses = content.filter((b: any) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: any[] = [];
      for (const tu of toolUses) {
        let result: any;
        try {
          result = await executeTool(tu.name, tu.input);
        } catch (e) {
          result = { error: "TOOL_FAILED", message: e instanceof Error ? e.message : String(e) };
        }
        toolCalls.push({ name: tu.name, input: tu.input, result });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results }); // all results in ONE message
    }

    const citations: Citation[] = toolCalls
      .filter((c) => c.name === "get_quote" && c.result && !c.result.error)
      .map((c) => ({ source: "get_quote", as_of: c.result.as_of }));
    for (const c of toolCalls.filter((tc) => tc.name === "kb_search" && tc.result?.chunks?.length)) {
      for (const chunk of c.result.chunks) citations.push({ source: chunk.source, chunk_id: chunk.chunk_id, evidence_ref: chunk.evidence_ref, as_of: chunk.as_of, url: chunk.url });
    }
    recordChatUsage(this.usage, "anthropic", this.model, promptTokens, completionTokens, sawUsage);
    return { text: withDisclaimer(text), toolCalls, citations };
  }
}

// OpenAI Chat Completions transport — injectable for offline testing.
type OpenAITransport = (body: any, apiKey: string) => Promise<any>;

async function defaultOpenAITransport(body: any, apiKey: string): Promise<any> {
  const url = process.env.OPENAI_CHAT_URL ?? "https://api.openai.com/v1/chat/completions";
  const res = await llmFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * OpenAI Chat Completions tool loop for the chat assistant. Models the same
 * injectable-transport approach as AnthropicLLM so it is fully testable offline.
 *
 * Tool calling follows the OpenAI function-calling protocol (tools/tool_calls).
 * CHAT_LLM_MODEL is required when CHAT_LLM=openai; the app never silently chooses a model.
 */
export class OpenAILLM implements ChatLLM {
  constructor(
    private apiKey: string,
    private model: string,
    private transport: OpenAITransport = defaultOpenAITransport,
    private usage: LlmUsageOpts = {},
    // OpenAI-compatible provider serving this model (xAI/Gemini/Mistral/DeepSeek all share this tool loop),
    // recorded on the usage ledger so cost is attributed to the right provider, not always "openai".
    private provider: OpenAiCompatProvider = "openai",
    private reasoningEffort?: LlmReasoningEffort
  ) {}

  get modelName(): string {
    return this.model;
  }

  async run({ system, message, tools, executeTool, history }: LlmRunArgs): Promise<LlmResult> {
    // Build OpenAI messages array. Prior user/assistant turns first, then the current message.
    const messages: any[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    if (system) messages.push({ role: "system", content: system });
    const prior = (history ?? []).slice();
    // OpenAI requires alternating user/assistant; drop a leading assistant turn if present.
    while (prior.length && prior[0].role !== "user") prior.shift();
    for (const h of prior) messages.push({ role: h.role, content: h.text });
    messages.push({ role: "user", content: message });

    // Convert ChatLLM ToolSchema → OpenAI function-calling format.
    // The legacy deepseek-reasoner alias did not support function calling; current v4 models do.
    const supportsTools = !/^deepseek-reasoner/i.test(this.model);
    const oaiTools =
      supportsTools && tools && tools.length
        ? tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema
            }
          }))
        : undefined;

    const toolCalls: ToolCall[] = [];
    let text = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      const baseBody: Record<string, any> = {
        model: this.model,
        messages,
        ...(oaiTools ? { tools: oaiTools, tool_choice: "auto" } : {})
      };
      if (this.provider === "openrouter") {
        baseBody.metadata = {
          context: this.usage.context ?? "assistant-chat",
          ...((this.usage as any).metadata || {})
        };
        if (this.usage.userId) {
          baseBody.user = this.usage.userId;
        }
      } else if (this.usage.userId) {
        if (this.provider === "openai" || this.provider === "deepseek" || this.provider === "gemini") {
          baseBody.user = this.usage.userId;
        }
      }
      const requestBody = reasoningCapabilityForModel(this.model)
        ? withLlmRequestBounds(baseBody, "chat-completions", {
            model: this.model,
            maxOutputTokens: 1024,
            reasoningEffort: this.reasoningEffort
          })
        : { ...baseBody, max_tokens: 1024 };
      const resp = await this.transport(
        requestBody,
        this.apiKey
      );

      const u = extractLlmUsage(resp);
      if (u.promptTokens !== undefined || u.completionTokens !== undefined) {
        sawUsage = true;
        promptTokens += u.promptTokens ?? 0;
        completionTokens += u.completionTokens ?? 0;
      }
      const choice = resp.choices?.[0];
      if (!choice) break;
      const assistantMsg = choice.message ?? {};
      messages.push({ role: "assistant", content: assistantMsg.content ?? null, ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}) });
      text = typeof assistantMsg.content === "string" ? assistantMsg.content : "";

      const calls: any[] = assistantMsg.tool_calls ?? [];
      if (choice.finish_reason !== "tool_calls" || calls.length === 0) break;

      const toolResults: any[] = [];
      for (const tc of calls) {
        const name: string = tc.function?.name ?? "";
        let input: any;
        try {
          input = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          input = {};
        }
        let result: any;
        try {
          result = await executeTool(name, input);
        } catch (e) {
          result = { error: "TOOL_FAILED", message: e instanceof Error ? e.message : String(e) };
        }
        toolCalls.push({ name, input, result });
        toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      // Push all tool results as individual messages (OpenAI requires one per tool_call_id).
      for (const tr of toolResults) messages.push(tr);
    }

    const citations: Citation[] = toolCalls
      .filter((c) => c.name === "get_quote" && c.result && !c.result.error)
      .map((c) => ({ source: "get_quote", as_of: c.result.as_of }));
    for (const c of toolCalls.filter((tc) => tc.name === "kb_search" && tc.result?.chunks?.length)) {
      for (const chunk of c.result.chunks) citations.push({ source: chunk.source, chunk_id: chunk.chunk_id, evidence_ref: chunk.evidence_ref, as_of: chunk.as_of, url: chunk.url });
    }
    recordChatUsage(this.usage, this.provider, this.model, promptTokens, completionTokens, sawUsage);
    return { text: text || DISCLAIMER, toolCalls, citations };
  }
}

/**
 * Provider is derived from the model name (no separate provider flag): claude-* → Anthropic
 * (its own Messages tool loop); grok-* → xAI; gemini-* → Gemini; mistral/ministral/codestral/…
 * → Mistral; everything else (gpt-*, o-series) → OpenAI. The latter four are all OpenAI-compatible
 * and share the OpenAILLM chat/completions tool loop, differing only by base URL + key.
 */
export function chatProviderForModel(model: string): ChatProvider {
  const trimmed = model?.trim() ?? "";
  if (/^openrouter\//i.test(trimmed)) return "openrouter";

  let name = trimmed;
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  if (/^claude/i.test(name)) return "anthropic";
  if (/^grok/i.test(name)) return "xai";
  if (/^gemini/i.test(name)) return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(name)) return "mistral";
  if (/^deepseek/i.test(name)) return "deepseek";
  return "openai";
}

/** OpenAI-compatible providers (everyone except Anthropic, which has its own Messages loop). */
type OpenAiCompatProvider = Exclude<ChatProvider, "anthropic">;

/** Base chat/completions URL for an OpenAI-compatible provider (env override per provider). */
function openAiCompatChatUrl(provider: OpenAiCompatProvider): string {  if (provider === "xai") return process.env.XAI_API_URL?.trim() || "https://api.x.ai/v1/chat/completions";
  if (provider === "gemini")
    return process.env.GEMINI_API_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  if (provider === "mistral") return process.env.MISTRAL_API_URL?.trim() || "https://api.mistral.ai/v1/chat/completions";
  if (provider === "openrouter") return process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  if (provider === "deepseek") return process.env.DEEPSEEK_API_URL?.trim() || "https://api.deepseek.com/v1/chat/completions";
  return process.env.OPENAI_CHAT_URL?.trim() || "https://api.openai.com/v1/chat/completions";
}

/** Build an OpenAI-style transport bound to a specific provider base URL (Bearer auth). The thrown
 *  error names the provider so the UI can render it in plain English (see humanizeLlmError). */
function makeOpenAITransport(url: string, provider: OpenAiCompatProvider): OpenAITransport {  return async (body: any, apiKey: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://socratictrade.com";
      headers["X-Title"] = "Socratic.Trade";
    }
    const res = await llmFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${provider} ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  };
}

/**
 * Build the chat LLM for an explicitly-chosen model, routed to its provider across all five
 * supported providers. The provider's key resolves per-user-first with the operator env key as a
 * flag-gated failover (resolveLlmCredential); usage is attributed to `userId` and the resolved
 * provider. Returns MockLLM for an empty/`"mock"` model or when the model's provider has no usable
 * key — so the assistant degrades to the deterministic offline path rather than erroring.
 */
export function llmForModel(
  model: string,
  userId?: string,
  opts: { transport?: Transport; openAITransport?: OpenAITransport; reasoningEffort?: LlmReasoningEffort } = {}
): ChatLLM {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.toLowerCase() === "mock") return new MockLLM();
  const provider = chatProviderForModel(trimmed);
  const { key, source, keyRef } = resolveLlmCredential(provider, userId);
  if (!key) return new MockLLM();
  const usage: LlmUsageOpts = { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
  // Strip the `openrouter/` prefix before passing the model ID to the API; OpenRouter
  // expects the bare model name (e.g. "openai/gpt-4o"), and the strategy path already
  // normalises this (resolveLlmEndpoint in llm-provider.ts — see that file's model strip).
  const modelForApi = provider === "openrouter" ? trimmed.replace(/^openrouter\//i, "") : trimmed;
  if (provider === "anthropic") {
    return new AnthropicLLM(key, trimmed, opts.transport ?? defaultTransport, usage, opts.reasoningEffort);
  }
  const transport = opts.openAITransport ?? makeOpenAITransport(openAiCompatChatUrl(provider), provider);
  return new OpenAILLM(key, modelForApi, transport, usage, provider, opts.reasoningEffort);
}

/**
 * Build the env-default chat LLM for a user. The key resolves per-user-first with the operator
 * env key as a flag-gated failover (see resolveLlmCredential), and usage is attributed to `userId`.
 * Passing no userId resolves the operator (`local`) key — preserves single-operator behaviour.
 */
export function getLLM(userId?: string, opts: { transport?: Transport; openAITransport?: OpenAITransport; reasoningEffort?: LlmReasoningEffort } = {}): ChatLLM {
  const chatLlm = process.env.CHAT_LLM;
  // No hardcoded chat model default (owner 2026-07-07): the env-default chat path requires an
  // explicit CHAT_LLM_MODEL. Without it, fall through to MockLLM rather than silently pick a model.
  const chatModel = process.env.CHAT_LLM_MODEL?.trim();
  if (chatLlm === "anthropic" && chatModel) {
    const { key, source, keyRef } = resolveLlmCredential("anthropic", userId);
    if (key) {
      const usage: LlmUsageOpts = { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
      return new AnthropicLLM(key, chatModel, opts.transport ?? defaultTransport, usage, opts.reasoningEffort);
    }
  }
  if (chatLlm === "openai" && chatModel) {
    const { key, source, keyRef } = resolveLlmCredential("openai", userId);
    if (key) {
      const usage: LlmUsageOpts = { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
      return new OpenAILLM(key, chatModel, opts.openAITransport ?? defaultOpenAITransport, usage, "openai", opts.reasoningEffort);
    }
  }
  return new MockLLM();
}
