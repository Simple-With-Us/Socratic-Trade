// apps/bff/src/tools/index.mjs
// Tool registry. The model may request ONLY these. There is no execution tool —
// `draft_order` returns a ticket for human confirmation; it never places an order.

import { validate, DRAFT_ORDER_SCHEMA, canonicalTicker } from '../../../../packages/shared/types.mjs';
import { createDraft } from '../orders/registry.mjs';
import { createAlert } from '../alerts/store.mjs';
import { searchKnowledge } from '../rag/index.mjs';
import { add as addWatchlist } from '../watchlist/store.mjs';

export function buildTools({ marketData }) {
  return {
    get_quote: {
      readOnly: true,
      description: 'Get the latest quote for a ticker. Use for price/quote questions.',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['symbol'],
        properties: { symbol: { type: 'string' } },
      },
      async execute(input) {
        const symbol = canonicalTicker(input.symbol);
        return await marketData.getQuote(symbol);
      },
    },

    draft_order: {
      readOnly: false, // creates a DRAFT only — still never executes
      description:
        'Prepare a DRAFT order ticket for the user to review. Does NOT place an order. Call when the ' +
        'user clearly intends to buy/sell a specific instrument and quantity.',
      input_schema: DRAFT_ORDER_SCHEMA,
      async execute(input, { userId, marketData }) {
        // Server-side validation — the model's input is untrusted regardless of any schema claim.
        const symbol = canonicalTicker(input.symbol);
        const order_type = input.order_type ?? 'market';
        // Coerce limit to the schema's string|null shape (money is never a float on the boundary).
        const limit_usd = order_type === 'market' || input.limit_usd == null ? null : String(input.limit_usd);
        const cleaned = { ...input, symbol, order_type, tif: input.tif ?? 'day', limit_usd };
        const v = validate(cleaned, DRAFT_ORDER_SCHEMA);
        if (!v.ok) return { error: 'INVALID_DRAFT', details: v.errors };
        const ref = await marketData.getQuote(symbol).then((q) => q.price_usd).catch(() => null);
        return createDraft(userId, cleaned, ref);
      },
    },

    create_alert: {
      readOnly: false, // low-stakes + reversible — the assistant may create directly (no draft gate)
      description:
        'Create a price alert that notifies the user when a ticker crosses a threshold. Call when ' +
        'the user asks to be alerted/notified when a symbol goes below/above a price.',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['symbol', 'op', 'price'],
        properties: {
          symbol: { type: 'string' },
          op: { type: 'string', enum: ['<', '>', 'below', 'above'] },
          price: { type: 'number' },
          note: { type: 'string' },
        },
      },
      async execute(input, { userId }) {
        return createAlert(userId, input);
      },
    },

    kb_search: {
      readOnly: true,
      description:
        'Search the ingested knowledge base for filings, news, and notes. Use for research questions ' +
        'about what a document says. Answers must be grounded only in returned chunks and cite them.',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
          query: { type: 'string' },
          ticker: { type: 'string' },
          doc_type: { type: 'string' },
          as_of: { type: 'string' },
          k: { type: 'integer', minimum: 1 },
        },
      },
      async execute(input) {
        const ticker = input.ticker ? canonicalTicker(input.ticker) : undefined;
        const chunks = await searchKnowledge({
          query: input.query,
          ticker,
          doc_type: input.doc_type,
          as_of: input.as_of,
          k: input.k ?? 5,
        });
        return {
          chunks: chunks.map((c) => ({
            chunk_id: c.chunk_id,
            doc_id: c.doc_id,
            title: c.title,
            text: c.text,
            context_header: c.context_header,
            ticker: c.ticker,
            doc_type: c.doc_type,
            section: c.section,
            source: c.source,
            url: c.url,
            as_of: c.as_of,
            score: c.score,
          })),
        };
      },
    },

    watchlist_add: {
      readOnly: false,
      description:
        'Add a ticker to the user watchlist. This is reversible and does not draft or place orders. ' +
        'Call when the user asks to watch, track, follow, or add a ticker to their watchlist.',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['symbol'],
        properties: { symbol: { type: 'string' } },
      },
      async execute(input, { userId }) {
        return { ok: true, item: addWatchlist(userId, input.symbol) };
      },
    },
  };
}
