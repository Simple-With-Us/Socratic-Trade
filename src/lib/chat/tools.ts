// Tool registry. The model may request ONLY these. There is no execution tool — draft_order
// returns a ticket for human confirmation; it never places an order. All tool I/O is injected via
// ToolDeps so the loop is testable offline. Ported from reference/atlas-public-src/bff/tools.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "crypto";
import { canonicalTicker } from "../rag/chunk";
import type { ChatDraft, ChatQuote, KbChunk } from "./types";
import type { EquityPosition, PendingProposal, Portfolio, PriceAlert, WatchlistItem } from "../types";

export type AlertResult = { symbol: string; op: string; price: number } | { error: string };
export type WatchlistResult = { ok: boolean; item: { symbol: string; deduped: boolean } } | { error: string };

/** Realized + unrealized P&L and win rate, live and paper buckets (field names mirror PerformanceSummary). */
export interface PortfolioPnlResult {
  liveRealizedPnl: number;
  paperRealizedPnl: number;
  liveUnrealizedPnl: number;
  paperUnrealizedPnl: number;
  liveWinRate: number;
  paperWinRate: number;
}
/** One scorecard bucket (thesis or regime). Field names mirror ThesisStat/RegimeStat. */
export interface ScorecardRow { key: string; trades: number; winRate: number; avgReturnPct: number; totalPnl: number }
export interface PerformanceSummaryResult { byThesis: ScorecardRow[]; byRegime: ScorecardRow[] }

export interface ToolDeps {
  getQuote(symbol: string, userId: string): Promise<ChatQuote>;
  getFundamentals?(symbol: string, userId: string): Promise<any>;
  getMarketSignals?(userId: string): Promise<any>;
  searchKnowledge(args: { query: string; ticker?: string; doc_type?: string; as_of?: string; k?: number }, userId: string): Promise<KbChunk[]>;
  createAlert(userId: string, input: { symbol: string; op: string; price: number; note?: string }): AlertResult;
  watchlistAdd(userId: string, symbol: string): WatchlistResult;
  // Read-only state (optional; the tool returns empty when a dep isn't wired). One-way: chat READS app state.
  getPositions?(userId: string): Promise<EquityPosition[]>;
  getPortfolio?(userId: string): Promise<Portfolio | null>;
  listWatchlist?(userId: string): WatchlistItem[];
  listAlerts?(userId: string): PriceAlert[];
  listOpenProposals?(userId: string): PendingProposal[];
  getPortfolioPnl?(userId: string): Promise<PortfolioPnlResult | null>;
  getPerformanceSummary?(userId: string): PerformanceSummaryResult | null;
  getReflection?(userId: string): string;
  // Robinhood-backed read-only research (optional; the tool returns a clear "not supported"/"not
  // connected" message when the dep isn't wired or the user has no Robinhood connection).
  getEarningsCalendar?(userId: string, args: { start_date?: string; days?: number; high_market_cap?: boolean }): Promise<any>;
  getOptionChain?(userId: string, underlyingSymbol: string): Promise<any>;
  searchInstrument?(userId: string, args: { query: string; asset_type?: string; limit?: number }): Promise<any>;
  accountLabel?: string;
}

export interface ToolDef {
  readOnly: boolean;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: any, ctx: { userId: string; deps: ToolDeps }): Promise<any>;
}

const DRAFT_ORDER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["symbol", "side", "qty"],
  properties: {
    symbol: { type: "string" },
    side: { type: "string", enum: ["buy", "sell"] },
    qty: { type: "number" },
    order_type: { type: "string", enum: ["market", "limit"] },
    limit_usd: { type: ["number", "null"] },
    rationale: { type: "string" }
  }
};

export function normalizeDraftSide(raw: unknown): "buy" | "sell" | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "buy") return "buy";
  if (value === "sell") return "sell";
  return null;
}

export function normalizeOrderType(raw: unknown): "market" | "limit" | null {
  const value = String(raw ?? "market").trim().toLowerCase();
  if (value === "market") return "market";
  if (value === "limit") return "limit";
  return null;
}

function clampKbSearchK(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5;
  return Math.min(Math.max(Math.trunc(raw), 1), 20);
}

export function buildTools(): Record<string, ToolDef> {
  return {
    get_quote: {
      readOnly: true,
      description: "Get the latest quote for a ticker. Use for price/quote questions.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        return ctx.deps.getQuote(canonicalTicker(String(input.symbol ?? "")), ctx.userId);
      }
    },

    draft_order: {
      readOnly: false, // creates a DRAFT only — still never executes
      description:
        "Prepare a DRAFT order ticket for the user to review. Does NOT place an order. Call when the " +
        "user clearly intends to buy/sell a specific instrument and quantity.",
      input_schema: DRAFT_ORDER_SCHEMA,
      async execute(input, ctx) {
        // Server-side validation — the model's input is untrusted regardless of any schema claim.
        const symbol = canonicalTicker(String(input.symbol ?? ""));
        const side = normalizeDraftSide(input.side);
        if (!side) {
          return {
            error: "INVALID_SIDE",
            details: `side must be "buy" or "sell" (got ${JSON.stringify(input.side)})`
          };
        }
        const qty = Number(input.qty);
        const order_type = normalizeOrderType(input.order_type);
        if (!order_type) {
          return {
            error: "INVALID_ORDER_TYPE",
            details: `order_type must be "market" or "limit" (got ${JSON.stringify(input.order_type)})`
          };
        }
        if (!symbol || !Number.isFinite(qty) || qty <= 0) {
          return { error: "INVALID_DRAFT", details: "symbol and positive qty required" };
        }
        let limit_usd: number | null = null;
        if (order_type === "limit") {
          const limit = Number(input.limit_usd);
          if (!Number.isFinite(limit) || limit <= 0) {
            return {
              error: "INVALID_LIMIT",
              details: `limit_usd must be a positive number for limit orders (got ${JSON.stringify(input.limit_usd)})`
            };
          }
          limit_usd = limit;
        }
        const draft: ChatDraft = {
          draft_id: randomUUID(),
          symbol,
          side,
          qty,
          order_type,
          limit_usd,
          rationale: typeof input.rationale === "string" ? input.rationale : "User requested this order.",
          account_label: ctx.deps.accountLabel ?? "Test (local)",
          is_real: false,
          blocked: false,
          warnings: [],
          executed: false
        };
        return draft;
      }
    },

    create_alert: {
      readOnly: false, // low-stakes + reversible — may create directly (no draft gate)
      description:
        "Create a price alert that notifies the user when a ticker crosses a threshold. Call when the " +
        "user asks to be alerted/notified when a symbol goes below/above a price.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "op", "price"],
        properties: {
          symbol: { type: "string" },
          op: { type: "string", enum: ["<", ">", "below", "above"] },
          price: { type: "number" },
          note: { type: "string" }
        }
      },
      async execute(input, ctx) {
        return ctx.deps.createAlert(ctx.userId, {
          symbol: String(input.symbol ?? ""),
          op: String(input.op ?? ""),
          price: Number(input.price),
          note: typeof input.note === "string" ? input.note : undefined
        });
      }
    },

    kb_search: {
      readOnly: true,
      description:
        "Search the ingested knowledge base for filings, news, and notes. Answers must be grounded only " +
        "in returned chunks and cite them.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          ticker: { type: "string" },
          doc_type: { type: "string" },
          as_of: { type: "string" },
          k: { type: "integer", minimum: 1, maximum: 20 }
        }
      },
      async execute(input, ctx) {
        const chunks = await ctx.deps.searchKnowledge(
          {
            query: String(input.query ?? ""),
            ticker: input.ticker ? canonicalTicker(String(input.ticker)) : undefined,
            doc_type: typeof input.doc_type === "string" ? input.doc_type : undefined,
            as_of: typeof input.as_of === "string" ? input.as_of : undefined,
            k: clampKbSearchK(input.k)
          },
          ctx.userId
        );
        return { chunks };
      }
    },

    watchlist_add: {
      readOnly: false,
      description:
        "Add a ticker to the user watchlist. Reversible; does not draft or place orders. Call when the " +
        "user asks to watch, track, follow, or add a ticker to their watchlist.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        return ctx.deps.watchlistAdd(ctx.userId, String(input.symbol ?? ""));
      }
    },

    get_positions: {
      readOnly: true,
      description: "List the user's current open equity positions (symbol, quantity, market value). Call for 'my positions/portfolio/holdings' questions.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { positions: ctx.deps.getPositions ? await ctx.deps.getPositions(ctx.userId) : [] };
      }
    },

    get_portfolio: {
      readOnly: true,
      description: "Get the user's account value, cash, and buying power.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { portfolio: ctx.deps.getPortfolio ? await ctx.deps.getPortfolio(ctx.userId) : null };
      }
    },

    list_watchlist: {
      readOnly: true,
      description: "List the symbols on the user's watchlist.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { watchlist: ctx.deps.listWatchlist ? ctx.deps.listWatchlist(ctx.userId) : [] };
      }
    },

    list_alerts: {
      readOnly: true,
      description: "List the user's armed price alerts.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { alerts: ctx.deps.listAlerts ? ctx.deps.listAlerts(ctx.userId) : [] };
      }
    },

    list_open_proposals: {
      readOnly: true,
      description: "List the user's open (pending-approval) trade proposals.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { proposals: ctx.deps.listOpenProposals ? ctx.deps.listOpenProposals(ctx.userId) : [] };
      }
    },

    get_fundamentals: {
      readOnly: true,
      description: "Get rich fundamentals, company profiles, analyst ratings, price targets, sector, division, peRatio, dividendYield, beta, etc. for a ticker.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        if (!ctx.deps.getFundamentals) return { error: "NOT_SUPPORTED" };
        return ctx.deps.getFundamentals(canonicalTicker(String(input.symbol ?? "")), ctx.userId);
      }
    },

    get_market_signals: {
      readOnly: true,
      description: "Get market-wide regime/sentiment signals, including top gainers, top losers, market breadth, volatility indices, CFTC futures spec positioning, etc.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        if (!ctx.deps.getMarketSignals) return { error: "NOT_SUPPORTED" };
        return ctx.deps.getMarketSignals(ctx.userId);
      }
    },

    get_portfolio_pnl: {
      readOnly: true,
      description:
        "Get the user's realized and unrealized profit/loss and win rate (live and paper). Call for " +
        "'how much have I made/lost', 'my P&L', 'am I up or down' questions.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return { pnl: ctx.deps.getPortfolioPnl ? await ctx.deps.getPortfolioPnl(ctx.userId) : null };
      }
    },

    get_performance_summary: {
      readOnly: true,
      description:
        "Get a breakdown of the user's realized trading performance by thesis and by market regime " +
        "(trades, win rate, average return %, total P&L). Call for 'how is my strategy doing', " +
        "'which theses/regimes work', 'performance summary' questions.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        return ctx.deps.getPerformanceSummary ? ctx.deps.getPerformanceSummary(ctx.userId) ?? { byThesis: [], byRegime: [] } : { byThesis: [], byRegime: [] };
      }
    },

    get_reflection: {
      readOnly: true,
      description:
        "Get the latest auto-generated post-mortem reflection summarizing what has been working and not " +
        "in the user's recent trading. Call for 'what have I learned', 'reflection', 'post-mortem', 'lessons' questions.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, ctx) {
        const reflection = ctx.deps.getReflection ? ctx.deps.getReflection(ctx.userId) : "";
        return { reflection: reflection || null };
      }
    },

    get_earnings_calendar: {
      readOnly: true,
      description:
        "List earnings reports scheduled across the market over a date window (up to 31 days), " +
        "optionally limited to high-market-cap names. Call for 'what reports this week', 'upcoming " +
        "earnings', 'who reports on <date>' questions. For a specific known ticker, prefer fundamentals.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          start_date: { type: "string" },
          days: { type: "integer", minimum: -31, maximum: 31 },
          high_market_cap: { type: "boolean" }
        }
      },
      async execute(input, ctx) {
        if (!ctx.deps.getEarningsCalendar) return { error: "NOT_SUPPORTED" };
        // Server-side validation — the model's input is untrusted regardless of any schema claim.
        const days = Number(input.days);
        return ctx.deps.getEarningsCalendar(ctx.userId, {
          start_date: typeof input.start_date === "string" ? input.start_date : undefined,
          days: Number.isInteger(days) && days !== 0 && days >= -31 && days <= 31 ? days : undefined,
          high_market_cap: input.high_market_cap === true
        });
      }
    },

    get_option_chain: {
      readOnly: true,
      description:
        "Look up the option chain (expiration dates + contract set) for an underlying ticker. Research " +
        "and discovery only — this NEVER places, modifies, or prices an option order. Call for 'what " +
        "expirations/strikes does <symbol> have', 'show me <symbol> options' questions.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        if (!ctx.deps.getOptionChain) return { error: "NOT_SUPPORTED" };
        const symbol = canonicalTicker(String(input.symbol ?? ""));
        if (!symbol) return { error: "INVALID_INPUT", details: "symbol required" };
        return ctx.deps.getOptionChain(ctx.userId, symbol);
      }
    },

    search_instrument: {
      readOnly: true,
      description:
        "Resolve a natural-language company name, ticker, crypto pair, or index to concrete instruments. " +
        "Call when the user names an asset by (partial) name rather than a ticker, or you need to " +
        "disambiguate which symbol they mean before answering.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          asset_type: { type: "string", enum: ["instrument", "currency_pair", "market_index"] },
          limit: { type: "integer", minimum: 1, maximum: 20 }
        }
      },
      async execute(input, ctx) {
        if (!ctx.deps.searchInstrument) return { error: "NOT_SUPPORTED" };
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "INVALID_INPUT", details: "query required" };
        const assetType =
          input.asset_type === "instrument" || input.asset_type === "currency_pair" || input.asset_type === "market_index"
            ? input.asset_type
            : undefined;
        const limit = Number(input.limit);
        return ctx.deps.searchInstrument(ctx.userId, {
          query,
          asset_type: assetType,
          limit: Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : undefined
        });
      }
    }
  };
}
