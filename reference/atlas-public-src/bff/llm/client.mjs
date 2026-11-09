// apps/bff/src/llm/client.mjs
// Provider-agnostic LLM contract: `run({ system, message, tools, executeTool, context })`
// drives a tool loop and returns { text, toolCalls:[{name,input,result}], citations }.
// Both providers share this shape so the orchestrator is identical for either.
//
// The model can only call the tools it is given (read-only get_quote + draft-only draft_order).
// There is no execution tool. AnthropicLLM takes an injectable `transport` so the real
// multi-turn tool loop is unit-testable offline.

import { config } from '../config.mjs';
import { canonicalTicker } from '../../../../packages/shared/types.mjs';
import { DISCLAIMER } from './prompt.mjs';

const MAX_STEPS = 5;

// --- Intent parsing (also a cheap pre-router in front of a real model) ---
export function classifyIntent(message) {
  const lc = String(message).toLowerCase();
  // Candidate tickers: 2-5 uppercase letters, excluding common words. Single letters (I, P, E,
  // A) are not treated as tickers to avoid false positives like "P/E ratio".
  const EXCLUDE = ['THE', 'BUY', 'SELL', 'USD', 'PE', 'AND', 'FOR', 'YOU'];
  const sym = (String(message).match(/\b([A-Z]{2,5})\b/g) || []).map(canonicalTicker)
    .find((s) => !EXCLUDE.includes(s));

  // Alert intent: "alert/notify me when AAPL drops below 190" / "tell me if TSLA goes above 250".
  if (/\b(alert|notify|tell me|let me know|remind me)\b/.test(lc) && /\b(below|under|above|over|drops?|falls?|rises?|hits?|reaches?|<|>)\b/.test(lc)) {
    const dir = /\b(below|under|drops?|falls?|<)\b/.test(lc) ? '<' : '>';
    const priceM = lc.match(/\$?\s*(\d+(?:\.\d+)?)/);
    if (sym && priceM) {
      return { intent: 'alert', alert: { symbol: sym, op: dir, price: Number(priceM[1]) } };
    }
  }

  const orderM = String(message).match(/\b(buy|sell)\b\s+(\d+)\s+(?:shares?\s+(?:of\s+)?)?([A-Za-z.]{1,10})/i);
  if (orderM) {
    const limitM = lc.match(/(?:at|limit|@)\s*\$?(\d+(?:\.\d+)?)/);
    return {
      intent: 'order',
      order: {
        side: orderM[1].toLowerCase(),
        qty: Number(orderM[2]),
        symbol: canonicalTicker(orderM[3]),
        order_type: limitM ? 'limit' : 'market',
        limit_usd: limitM ? Number(limitM[1]) : null,
      },
    };
  }
  const watchM = String(message).match(/\b(?:add|put|track|watch|follow)\s+\$?([A-Za-z.]{1,10})\b(?:[^.?!]{0,40}\bwatchlist\b)?/i) ||
    String(message).match(/\bwatchlist\b[^.?!]{0,40}\$?([A-Za-z.]{1,10})\b/i);
  if (watchM && /\b(watchlist|watch|track|follow)\b/.test(lc))
    return { intent: 'watchlist_add', symbol: canonicalTicker(watchM[1]) };
  const docType = lc.match(/\b(10-k|10-q|8-k|filing|news|note|document|report)\b/)?.[1]?.toUpperCase();
  if (/\b(what did|say about|according to|filing|10-k|10-q|8-k|risk factors?|knowledge|research|document|source|kb)\b/.test(lc))
    return {
      intent: 'kb',
      symbol: sym,
      doc_type: docType && !['FILING', 'DOCUMENT', 'REPORT'].includes(docType) ? docType : undefined,
    };
  if (/\b(should i|is it a good (buy|time)|recommend|what should i do|allocate)\b/.test(lc))
    return { intent: 'advice', symbol: sym };
  if (/\b(price|quote|trading at|how much is|what'?s)\b/.test(lc) && sym) return { intent: 'quote', symbol: sym };
  if (sym) return { intent: 'quote', symbol: sym };
  return { intent: 'chat' };
}

function narrateQuote(quote, advice) {
  const dir = quote.change_pct >= 0 ? 'up' : 'down';
  let text = `${quote.symbol} is at $${quote.price_usd}, ${dir} ${Math.abs(quote.change_pct)}% ` +
    `(as of ${quote.as_of}, ${quote.source} data, ${quote.session} session).`;
  if (advice)
    text += ` I can't tell you whether to buy or sell — that depends on your full financial picture, ` +
      `and I'm not a licensed advisor. I can lay out the trade-offs and you decide.`;
  return text;
}

function groundedChat(message, memorySummary) {
  const lc = message.toLowerCase();
  if (/p\/?e|price.to.earnings/.test(lc))
    return 'P/E (price-to-earnings) is a stock’s price divided by its earnings per share — a rough valuation gauge.';
  if (/\bwhat do you remember|what do you know about me\b/.test(lc))
    return memorySummary ? `Here’s what I have on file:\n${memorySummary}` : 'I don’t have anything on file for you yet.';
  return 'Noted. Ask me for a quote (e.g. "AAPL price") or to draft an order (e.g. "buy 10 AAPL at 200") and I’ll help — every order is a draft you confirm.';
}

function bestSentence(text, query) {
  const tokens = new Set(String(query).toLowerCase().match(/[a-z0-9.$%-]+/g) ?? []);
  const sentences = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  let best = sentences[0] ?? String(text).slice(0, 240);
  let bestScore = -1;
  for (const s of sentences) {
    const score = (String(s).toLowerCase().match(/[a-z0-9.$%-]+/g) ?? [])
      .reduce((sum, t) => sum + (tokens.has(t) ? 1 : 0), 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best.trim();
}

// --- Deterministic offline stand-in, shaped like a real tool-use loop ---
class MockLLM {
  async run({ message, executeTool, context = {} }) {
    const cls = classifyIntent(message);
    const toolCalls = [];

    if (cls.intent === 'quote' || cls.intent === 'advice') {
      const input = { symbol: cls.symbol };
      const result = await executeTool('get_quote', input);
      toolCalls.push({ name: 'get_quote', input, result });
      if (result?.error) return { text: `I don't have data on that.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      return {
        text: `${narrateQuote(result, cls.intent === 'advice')}\n\n${DISCLAIMER}`,
        toolCalls,
        citations: [{ source: 'get_quote', as_of: result.as_of }],
      };
    }

    if (cls.intent === 'alert') {
      const result = await executeTool('create_alert', cls.alert);
      toolCalls.push({ name: 'create_alert', input: cls.alert, result });
      const text = result?.error
        ? `I couldn't set that alert (${result.error}).`
        : `Done — I'll alert you when ${result.symbol} is ${result.op === '<' ? 'below' : 'above'} $${result.price}.`;
      return { text: `${text}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === 'order') {
      const input = { ...cls.order, rationale: 'User requested this order.' };
      const result = await executeTool('draft_order', input);
      toolCalls.push({ name: 'draft_order', input, result });
      const lead = result?.blocked
        ? `I've drafted this order but it can't proceed as-is — ${result.warnings.join('; ')}.`
        : `I've prepared a draft order for your review — it won't go through until you confirm.` +
          ` (Account: ${result.account_label}${result.is_real ? '' : ' — simulated, not a real broker'}.)`;
      return { text: `${lead}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    if (cls.intent === 'kb') {
      const input = { query: message, ticker: cls.symbol, doc_type: cls.doc_type, k: 5 };
      const result = await executeTool('kb_search', input);
      toolCalls.push({ name: 'kb_search', input, result });
      const chunks = result?.chunks ?? [];
      if (!chunks.length) {
        return { text: `I don't have data on that in the sources available to me.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      }
      const lines = chunks.slice(0, 2).map((c) => `- ${bestSentence(c.text, message)} [${c.chunk_id}]`);
      return {
        text: `${lines.join('\n')}\n\n${DISCLAIMER}`,
        toolCalls,
        citations: chunks.map((c) => ({ source: c.source, chunk_id: c.chunk_id, as_of: c.as_of })),
      };
    }

    if (cls.intent === 'watchlist_add') {
      const input = { symbol: cls.symbol };
      const result = await executeTool('watchlist_add', input);
      toolCalls.push({ name: 'watchlist_add', input, result });
      if (result?.error) return { text: `I couldn't add that symbol to your watchlist: ${result.error}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
      const tag = result.item?.deduped ? 'was already' : 'is now';
      return { text: `${result.item.symbol} ${tag} on your watchlist.\n\n${DISCLAIMER}`, toolCalls, citations: [] };
    }

    return { text: `${groundedChat(message, context.memorySummary)}\n\n${DISCLAIMER}`, toolCalls, citations: [] };
  }
}

// --- Real Anthropic Messages API tool loop (server-side only) ---
async function defaultTransport(body, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  return res.json();
}

class AnthropicLLM {
  constructor(apiKey, model, transport = defaultTransport) {
    this.apiKey = apiKey; this.model = model; this.transport = transport;
  }

  async run({ system, message, tools, executeTool }) {
    const messages = [{ role: 'user', content: message }];
    const toolCalls = [];
    let text = '';

    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await this.transport({
        model: this.model, max_tokens: 1024, system,
        messages, ...(tools?.length ? { tools } : {}),
      }, this.apiKey);

      const content = resp.content || [];
      messages.push({ role: 'assistant', content });
      text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const results = [];
      for (const tu of toolUses) {
        let result;
        try { result = await executeTool(tu.name, tu.input); }
        catch (e) { result = { error: 'TOOL_FAILED', message: String(e.message ?? e) }; }
        toolCalls.push({ name: tu.name, input: tu.input, result });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results }); // all results in ONE message
    }

    // Citations from any grounded quote lookups.
    const citations = toolCalls
      .filter((c) => c.name === 'get_quote' && c.result && !c.result.error)
      .map((c) => ({ source: 'get_quote', as_of: c.result.as_of }));
    for (const c of toolCalls.filter((tc) => tc.name === 'kb_search' && tc.result?.chunks?.length)) {
      for (const chunk of c.result.chunks) citations.push({ source: chunk.source, chunk_id: chunk.chunk_id, as_of: chunk.as_of });
    }
    return { text: text || DISCLAIMER, toolCalls, citations };
  }
}

export function getLLM({ transport } = {}) {
  if (config.llm === 'anthropic' && config.anthropicApiKey)
    return new AnthropicLLM(config.anthropicApiKey, config.models.answer, transport ?? defaultTransport);
  return new MockLLM();
}

export { MockLLM, AnthropicLLM, DISCLAIMER };
