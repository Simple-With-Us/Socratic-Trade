import { Alpaca } from "@alpacahq/alpaca-trade-api";
import type { AlpacaClientOptions } from "@alpacahq/alpaca-trade-api";
import { z } from "zod";
import { ALPACA_BROKER_IO_DEADLINE_MS } from "./inflight-deadline";

type AlpacaInstance = InstanceType<typeof Alpaca>;

export const AlpacaLatestTradeSchema = z.object({
  p: z.number().optional(),
  t: z.union([z.string(), z.number(), z.date()]).optional()
});
export type AlpacaLatestTrade = z.infer<typeof AlpacaLatestTradeSchema>;

export const AlpacaLatestTradesResponseSchema = z.object({
  trades: z.record(z.string(), z.unknown()).optional()
});
export type AlpacaLatestTradesResponse = z.infer<typeof AlpacaLatestTradesResponseSchema>;

function alpacaTradeTimestamp(value: AlpacaLatestTrade["t"]): string | number | undefined {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** v3-style constructor options used by {@link AlpacaBrokerGateway}. */
export type LegacyAlpacaConstructorOptions = {
  paper?: boolean;
  keyId?: string;
  secretKey?: string;
  oauth?: string;
  baseUrl?: string;
};

/** v3 SDK exposed resolved credentials on `.configuration` (tests + ops introspection). */
export type LegacyAlpacaClientConfiguration = {
  paper?: boolean;
  keyId?: string;
  oauth?: string;
  baseUrl?: string;
};

/** Minimal v3-shaped REST surface the gateway still calls. */
export type LegacyAlpacaRestClient = {
  configuration: LegacyAlpacaClientConfiguration;
  getAccount(): Promise<Record<string, unknown>>;
  getPositions(): Promise<Record<string, unknown>[]>;
  getOrders(params: {
    status?: string;
    limit?: number;
    direction?: string;
    after?: string;
    until?: string;
  }): Promise<Record<string, unknown>[]>;
  getLatestQuotes(symbols: string[]): Promise<Record<string, Record<string, unknown>>>;
  getLatestTrades?(symbols: string[]): Promise<Record<string, Record<string, unknown>>>;
  getAsset(symbol: string): Promise<Record<string, unknown>>;
  createOrder(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string): Promise<Record<string, unknown>>;
  sendRequest(
    path: string,
    query: Record<string, unknown> | null,
    body: unknown,
    method?: string
  ): Promise<unknown>;
};

export function buildAlpacaV5ClientOptions(opts: LegacyAlpacaConstructorOptions): AlpacaClientOptions & {
  basePath?: string;
} {
  const v5: AlpacaClientOptions & { basePath?: string } = {
    paper: opts.paper ?? true,
    timeoutMs: ALPACA_BROKER_IO_DEADLINE_MS,
    retry: false,
    rateLimit: false
  };
  if (opts.oauth) {
    v5.accessToken = opts.oauth;
  } else if (opts.keyId) {
    v5.keyId = opts.keyId;
    v5.secret = opts.secretKey ?? "";
  }
  if (opts.baseUrl) {
    v5.basePath = opts.baseUrl.replace(/\/+$/, "");
  }
  return v5;
}

function pick(obj: Record<string, unknown>, snake: string, camel: string): unknown {
  if (obj[snake] !== undefined) return obj[snake];
  return obj[camel];
}

/** Normalize v5 camelCase trading objects to the snake_case fields our mappers expect. */
export function toLegacyAlpacaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  const pairs: Array<[string, string]> = [
    ["account_number", "accountNumber"],
    ["portfolio_value", "portfolioValue"],
    ["buying_power", "buyingPower"],
    ["trading_blocked", "tradingBlocked"],
    ["account_blocked", "accountBlocked"],
    ["shorting_enabled", "shortingEnabled"],
    ["account_type", "accountType"],
    ["options_approved_level", "optionsApprovedLevel"],
    ["options_trading_level", "optionsTradingLevel"],
    ["avg_entry_price", "avgEntryPrice"],
    ["market_value", "marketValue"],
    ["filled_qty", "filledQty"],
    ["filled_avg_price", "filledAvgPrice"],
    ["limit_price", "limitPrice"],
    ["stop_price", "stopPrice"],
    ["time_in_force", "timeInForce"],
    ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
    ["client_order_id", "clientOrderId"],
    ["order_class", "orderClass"],
    ["trail_percent", "trailPercent"]
  ];
  for (const [snake, camel] of pairs) {
    const v = pick(o, snake, camel);
    if (v !== undefined) out[snake] = v instanceof Date ? v.toISOString() : v;
  }
  if (out.qty === undefined && o.qty !== undefined) out.qty = o.qty;
  if (out.status === undefined && o.status !== undefined) out.status = o.status;
  if (Array.isArray(o.legs)) {
    out.legs = o.legs.map((leg) => toLegacyAlpacaRecord(leg));
  }
  return out;
}

function toCreateOrderRequest(options: Record<string, unknown>) {
  const takeProfit = options.take_profit as Record<string, unknown> | undefined;
  const stopLoss = options.stop_loss as Record<string, unknown> | undefined;
  return {
    symbol: options.symbol != null ? String(options.symbol) : undefined,
    side: options.side,
    type: options.type,
    timeInForce: String(options.time_in_force ?? "day"),
    clientOrderId: options.client_order_id != null ? String(options.client_order_id) : undefined,
    qty: options.qty != null ? String(options.qty) : undefined,
    notional: options.notional != null ? String(options.notional) : undefined,
    limitPrice: options.limit_price != null ? String(options.limit_price) : undefined,
    stopPrice: options.stop_price != null ? String(options.stop_price) : undefined,
    extendedHours: options.extended_hours === true,
    orderClass: options.order_class,
    trailPercent: options.trail_percent != null ? String(options.trail_percent) : undefined,
    takeProfit: takeProfit
      ? { limitPrice: String(takeProfit.limit_price ?? takeProfit.limitPrice ?? "") }
      : undefined,
    stopLoss: stopLoss
      ? {
          stopPrice: String(stopLoss.stop_price ?? stopLoss.stopPrice ?? ""),
          ...(stopLoss.limit_price != null || stopLoss.limitPrice != null
            ? { limitPrice: String(stopLoss.limit_price ?? stopLoss.limitPrice) }
            : {})
        }
      : undefined
  };
}

type V5AlpacaSdk = {
  trading: {
    account: { getAccount: () => Promise<unknown> };
    positions: { getAllOpenPositions: () => Promise<unknown[]> };
    orders: {
      getAllOrders: (req: Record<string, unknown>) => Promise<unknown[]>;
      postOrder: (req: { createOrderRequest: unknown }) => Promise<unknown>;
      deleteOrderByOrderID: (req: { orderId: string }) => Promise<void>;
      getOrderByOrderID: (req: { orderId: string; nested?: boolean }) => Promise<unknown>;
      getOrderByClientOrderId: (req: { clientOrderId: string }) => Promise<unknown>;
    };
    assets: { getV2AssetsSymbolOrAssetId: (req: { symbolOrAssetId: string }) => Promise<unknown> };
  };
  marketData: {
    stocks: {
      stockLatestQuotes: (req: { symbols: string }) => Promise<{ quotes?: Record<string, unknown> }>;
      stockLatestTrades: (req: { symbols: string }) => Promise<{ trades?: Record<string, unknown> }>;
    };
  };
};

function legacyClientConfiguration(opts: LegacyAlpacaConstructorOptions): LegacyAlpacaClientConfiguration {
  return {
    paper: opts.paper ?? true,
    keyId: opts.keyId,
    oauth: opts.oauth,
    baseUrl: opts.baseUrl
  };
}

export function createLegacyAlpacaRestClient(
  client: AlpacaInstance,
  opts: LegacyAlpacaConstructorOptions
): LegacyAlpacaRestClient {
  const { trading, marketData } = client as V5AlpacaSdk;
  const stocks = marketData.stocks;
  const configuration = legacyClientConfiguration(opts);

  return {
    configuration,
    async getAccount() {
      const account = await trading.account.getAccount();
      return toLegacyAlpacaRecord(account);
    },
    async getPositions() {
      const positions = await trading.positions.getAllOpenPositions();
      return positions.map((p) => toLegacyAlpacaRecord(p));
    },
    async getOrders(params) {
      const orders = await trading.orders.getAllOrders({
        status: params.status as "open" | "closed" | "all" | undefined,
        limit: params.limit,
        direction: params.direction as "asc" | "desc" | undefined,
        after: params.after,
        until: params.until
      });
      return orders.map((o) => toLegacyAlpacaRecord(o));
    },
    async getLatestQuotes(symbols) {
      if (symbols.length === 0) return {};
      const resp = await stocks.stockLatestQuotes({ symbols: symbols.join(",") });
      const legacy: Record<string, Record<string, unknown>> = {};
      for (const [sym, quote] of Object.entries(resp.quotes ?? {})) {
        const q = quote as unknown as Record<string, unknown>;
        legacy[sym] = {
          ...q,
          t: q.t instanceof Date ? q.t.toISOString() : q.t
        };
      }
      return legacy;
    },
    async getLatestTrades(symbols) {
      if (symbols.length === 0) return {};
      const resp = await stocks.stockLatestTrades({ symbols: symbols.join(",") });
      const parsed = AlpacaLatestTradesResponseSchema.safeParse(resp);
      if (!parsed.success) return {};
      const book: AlpacaLatestTradesResponse = parsed.data;
      const legacy: Record<string, Record<string, unknown>> = {};
      for (const [sym, raw] of Object.entries(book.trades ?? {})) {
        const trade = AlpacaLatestTradeSchema.safeParse(raw);
        if (!trade.success) continue;
        const row: AlpacaLatestTrade = trade.data;
        legacy[sym] = {
          p: row.p,
          t: alpacaTradeTimestamp(row.t)
        };
      }
      return legacy;
    },
    async getAsset(symbol) {
      const asset = await trading.assets.getV2AssetsSymbolOrAssetId({ symbolOrAssetId: symbol });
      return toLegacyAlpacaRecord(asset);
    },
    async createOrder(options) {
      const order = await trading.orders.postOrder({
        createOrderRequest: toCreateOrderRequest(options)
      });
      return toLegacyAlpacaRecord(order);
    },
    async cancelOrder(orderId) {
      await trading.orders.deleteOrderByOrderID({ orderId });
    },
    async getOrder(orderId) {
      const order = await trading.orders.getOrderByOrderID({ orderId });
      return toLegacyAlpacaRecord(order);
    },
    async sendRequest(path, query, _body, method = "GET") {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      if (method !== "GET") {
        throw new Error(`Legacy Alpaca sendRequest only supports GET (got ${method} for ${path})`);
      }
      const clientOrderMatch = normalized.match(/^\/orders:by_client_order_id\/(.+)$/);
      if (clientOrderMatch) {
        const clientOrderId = decodeURIComponent(clientOrderMatch[1]);
        const order = await trading.orders.getOrderByClientOrderId({ clientOrderId });
        return toLegacyAlpacaRecord(order);
      }
      const orderMatch = normalized.match(/^\/orders\/([^/]+)$/);
      if (orderMatch) {
        const orderId = decodeURIComponent(orderMatch[1]);
        const nested = query?.nested === true;
        const order = await trading.orders.getOrderByOrderID({ orderId, nested });
        return toLegacyAlpacaRecord(order);
      }
      throw new Error(`Unsupported legacy Alpaca sendRequest path: ${normalized}`);
    }
  };
}

function isLegacyV3ShapedClient(value: unknown): value is LegacyAlpacaRestClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as LegacyAlpacaRestClient;
  const hasLegacyReadApi =
    typeof candidate.getAccount === "function" &&
    (typeof candidate.getLatestQuotes === "function" ||
      typeof candidate.getPositions === "function" ||
      typeof candidate.createOrder === "function" ||
      typeof candidate.sendRequest === "function");
  if (!hasLegacyReadApi) return false;
  const tradingGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "trading");
  return typeof tradingGetter?.get !== "function";
}

export function createAlpacaBrokerSdk(opts: LegacyAlpacaConstructorOptions): LegacyAlpacaRestClient {
  const client = new Alpaca(buildAlpacaV5ClientOptions(opts));
  if (isLegacyV3ShapedClient(client)) {
    return client;
  }
  return createLegacyAlpacaRestClient(client, opts);
}
