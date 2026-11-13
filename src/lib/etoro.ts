/**
 * eToro Public API gateway (official).  Demo vs Real is on the user key, not the host.
 * US accounts: long real stocks/ETFs at leverage 1.  Shorts/CFDs fail closed.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  AccountCapabilities,
  BrokerageAccount,
  BrokerGateway,
  BrokerQuote,
  EquityOrder,
  EquityOrderInput,
  EquityPosition,
  ExecutedOrder,
  Portfolio,
  ReviewedOrder
} from "./types";
import { OrderValidationError } from "./types";
import { normalizeSymbol } from "./money";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { logApiHealth } from "./db-health";
import { estimateReviewNotional } from "./alpaca";
import { providerObservationIso, selectObservedQuotePrice } from "./quote-observation";
import { isLiveOrderState } from "./broker-side";
import { ETORO_API_BASE, etoroHeaders } from "./etoro-copy";
import { brokerAbortSignal, chunkBrokerSymbols, scopeBrokerOrders } from "./inflight-deadline";
import { mergeAccountCapabilities } from "./venue-contract";

export const EtoroRateRowSchema = z.object({
  instrumentID: z.unknown().optional(),
  instrumentId: z.unknown().optional(),
  lastExecution: z.unknown().optional(),
  bid: z.unknown().optional(),
  ask: z.unknown().optional(),
  date: z.unknown().optional()
}).passthrough();

export const EtoroRatesResponseSchema = z.union([
  z.array(EtoroRateRowSchema),
  z.object({ rates: z.array(EtoroRateRowSchema).nullish() }).passthrough()
]);

export const EtoroEligibilityRowSchema = z.object({
  symbol: z.unknown().optional(),
  allowOpenPosition: z.unknown().optional(),
  unitsQuantityType: z.unknown().optional()
}).passthrough();

export const EtoroEligibilityResponseSchema = z.union([
  z.array(EtoroEligibilityRowSchema),
  z.object({ items: z.array(EtoroEligibilityRowSchema).nullish() }).passthrough()
]);

function etoroFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const caller = init.signal instanceof AbortSignal ? init.signal : undefined;
  return fetch(url, { ...init, signal: brokerAbortSignal(caller) });
}

export function getEToroGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new EToroBrokerGateway(userId, connectedAccountId);
}

function emptyCaps(over: Partial<AccountCapabilities> = {}): AccountCapabilities {
  return mergeAccountCapabilities("etoro", over);
}

class EToroBrokerGateway implements BrokerGateway {
  private readonly userId: string;
  private readonly apiKey: string;
  private readonly userKey: string;
  private readonly demo: boolean;
  private instrumentCache = new Map<string, number>();

  constructor(userId: string, connectedAccountId?: string) {
    this.userId = userId;
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const active = getActiveConnectedAccount(userId);
    const acct = targeted?.broker === "etoro" ? targeted : active?.broker === "etoro" ? active : undefined;
    if (!acct) throw new Error("No eToro account connected.");
    const apiKey = acct.apiKey?.trim() ?? "";
    const userKey = acct.apiSecret?.trim() ?? "";
    if (!apiKey || !userKey) {
      throw new Error(`eToro keys are missing for ${acct.label}.  Settings → Trading → API Key Management.`);
    }
    this.apiKey = apiKey;
    this.userKey = userKey;
    this.demo = acct.environment === "paper";
  }

  private headers(): Record<string, string> {
    return etoroHeaders({ apiKey: this.apiKey, userKey: this.userKey }, randomUUID());
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn();
      logApiHealth({ service: "etoro-broker", ok: true, latencyMs: Date.now() - start, userId: this.userId });
      return out;
    } catch (error) {
      logApiHealth({
        service: "etoro-broker",
        ok: false,
        latencyMs: Date.now() - start,
        errorText: error instanceof Error ? error.message : String(error),
        userId: this.userId
      });
      throw error;
    }
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    return this.track(async () => {
      const res = await etoroFetch(`${ETORO_API_BASE}/api/v1/me`, { headers: this.headers() });
      if (!res.ok) throw new Error(`eToro /me ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      const accountNumber = String(this.demo ? json.demoCid ?? json.gcid : json.realCid ?? json.gcid ?? json.username ?? "etoro");
      return [{
        accountNumber,
        label: String(json.username ?? "eToro"),
        agenticAllowed: true,
        capabilities: emptyCaps()
      }];
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const port = await this.ownPortfolio();
    const credit = num(port.credit) ?? 0;
    return {
      accountNumber,
      cash: credit,
      buyingPower: credit,
      equityMarketValue: credit,
      optionMarketValue: 0,
      totalMarketValue: credit
    };
  }

  async getEquityPositions(_accountNumber: string): Promise<EquityPosition[]> {
    const port = await this.ownPortfolio();
    const positions = Array.isArray(port.positions) ? port.positions : [];
    return positions.flatMap((item) => {
      const row = item as Record<string, unknown>;
      const settlement = num(row.settlementTypeID);
      if (settlement != null && settlement !== 1) return [];
      const symbol = String(row.symbol ?? row.internalSymbolFull ?? row.instrumentID ?? "");
      if (!symbol) return [];
      return [{
        symbol: normalizeSymbol(symbol),
        quantity: num(row.units) ?? 0,
        averageCost: num(row.openRate) ?? 0,
        marketValue: num(row.amount) ?? 0
      }];
    });
  }

  async getEquityOrders(_accountNumber: string, options?: import("./types").GetEquityOrdersOptions): Promise<EquityOrder[]> {
    const port = await this.ownPortfolio();
    const orders = Array.isArray(port.orders) ? port.orders : [];
    const mapped: EquityOrder[] = orders.flatMap((item) => {
      const row = item as Record<string, unknown>;
      const id = String(row.orderId ?? row.orderID ?? "");
      if (!id) return [];
      return [{
        id,
        symbol: normalizeSymbol(String(row.symbol ?? row.instrumentID ?? "")),
        side: row.isBuy === false ? "sell" : "buy",
        type: "market",
        state: String(row.status ?? "open"),
        quantity: num(row.units),
        createdAt: String(row.openTimestamp ?? new Date().toISOString())
      }];
    });
    return scopeBrokerOrders(mapped, options, (state) => isLiveOrderState(state));
  }

  async getEquityQuotes(_accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    return this.track(async () => {
      const ids: number[] = [];
      const idToSymbol = new Map<number, string>();
      for (const symbol of symbols) {
        const id = await this.resolveInstrumentId(symbol);
        if (id == null) continue;
        ids.push(id);
        idToSymbol.set(id, normalizeSymbol(symbol));
      }
      if (ids.length === 0) return {};
      const out: Record<string, BrokerQuote> = {};
      for (const chunk of chunkBrokerSymbols(ids.map(String))) {
        const res = await etoroFetch(
          `${ETORO_API_BASE}/api/v1/market-data/instruments/rates?instrumentIds=${chunk.join(",")}`,
          { headers: this.headers() }
        );
        if (!res.ok) throw new Error(`eToro rates ${res.status}`);
        const json = EtoroRatesResponseSchema.parse(await res.json());
        const rows = Array.isArray(json) ? json : json.rates ?? [];
        for (const row of rows) {
          const id = num(row.instrumentID ?? row.instrumentId);
          const symbol = id != null ? idToSymbol.get(id) : undefined;
          if (!symbol) continue;
          const quote = etoroQuoteFromRate(symbol, row);
          if (quote) out[symbol] = quote;
        }
      }
      return out;
    });
  }

  async getEquityTradability(_accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>> {
    return this.track(async () => {
      const out: Record<string, { tradable: boolean; fractional: boolean; reason?: string }> = {};
      for (const chunk of chunkBrokerSymbols(symbols)) {
        const res = await etoroFetch(`${ETORO_API_BASE}/api/v2/trading/info/eligibility`, {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: chunk.map(normalizeSymbol) })
        });
        if (!res.ok) throw new Error(`eToro eligibility ${res.status}`);
        const json = EtoroEligibilityResponseSchema.parse(await res.json());
        const rows = Array.isArray(json) ? json : json.items ?? [];
        for (const row of rows) {
          const symbol = normalizeSymbol(String(row.symbol ?? ""));
          if (!symbol) continue;
          const tradable = row.allowOpenPosition === true;
          out[symbol] = {
            tradable,
            fractional: row.unitsQuantityType === "fractional",
            reason: tradable ? undefined : "eToro eligibility denied"
          };
        }
      }
      for (const symbol of symbols) {
        const key = normalizeSymbol(symbol);
        if (!out[key]) out[key] = { tradable: false, fractional: false, reason: "not returned" };
      }
      return out;
    });
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    if (input.side === "short" || input.side === "cover") {
      throw new OrderValidationError("eToro US accounts are long-only.  Short/cover is not sent.");
    }
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const { estimatedNotional, alerts } = estimateReviewNotional(input, quotes[normalizeSymbol(input.symbol)]?.price);
    return { estimatedNotional, alerts, raw: { etoro: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    if (input.side === "short" || input.side === "cover") {
      throw new OrderValidationError("eToro US accounts are long-only.  Short/cover is not sent.");
    }
    if (input.side === "sell") {
      throw new OrderValidationError("eToro sells close a specific positionId.  Re-sync positions, then retry from the held lot.");
    }
    return this.track(async () => {
      const path = this.demo ? "/api/v2/trading/execution/demo/orders" : "/api/v2/trading/execution/orders";
      const requestId = isUuid(input.refId) ? input.refId : randomUUID();
      const body: Record<string, unknown> = {
        action: "open",
        transaction: "buy",
        symbol: normalizeSymbol(input.symbol),
        orderType: input.type === "limit" ? "mit" : "mkt",
        leverage: 1
      };
      if (input.dollarAmount != null) body.amount = input.dollarAmount;
      else if (input.quantity != null) body.units = input.quantity;
      if (input.type === "limit" && input.limitPrice != null) body.triggerRate = input.limitPrice;
      const res = await etoroFetch(`${ETORO_API_BASE}${path}`, {
        method: "POST",
        headers: { ...etoroHeaders({ apiKey: this.apiKey, userKey: this.userKey }, requestId), "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`eToro place ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      return {
        refId: input.refId,
        orderId: String(json.orderId ?? requestId),
        state: "accepted",
        raw: json
      };
    });
  }

  async cancelEquityOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.track(async () => {
      const res = await etoroFetch(`${ETORO_API_BASE}/api/v2/trading/execution/orders/${encodeURIComponent(orderId)}`, {
        method: "DELETE",
        headers: this.headers()
      });
      if (!res.ok) throw new Error(`eToro cancel ${res.status}`);
      return { refId: orderId, orderId, state: "canceled", raw: { etoro: true } };
    });
  }

  private async ownPortfolio(): Promise<Record<string, unknown>> {
    return this.track(async () => {
      const prefix = this.demo ? "/api/v1/trading/info/demo/portfolio" : "/api/v1/trading/info/portfolio";
      const res = await etoroFetch(`${ETORO_API_BASE}${prefix}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`eToro portfolio ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      return (json.clientPortfolio as Record<string, unknown> | undefined) ?? json;
    });
  }

  private async resolveInstrumentId(symbol: string): Promise<number | undefined> {
    const key = normalizeSymbol(symbol);
    const cached = this.instrumentCache.get(key);
    if (cached != null) return cached;
    const params = new URLSearchParams({ internalSymbolFull: key, fields: "instrumentId,internalSymbolFull" });
    const res = await etoroFetch(`${ETORO_API_BASE}/api/v1/market-data/search?${params.toString()}`, { headers: this.headers() });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { items?: Record<string, unknown>[] };
    const hit = (json.items ?? []).find((row) => normalizeSymbol(String(row.internalSymbolFull ?? "")) === key);
    const id = num(hit?.instrumentId ?? hit?.instrumentID);
    if (id != null) this.instrumentCache.set(key, id);
    return id;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Last execution, then a two-sided mid.  A one-sided book is not a price. */
export function etoroQuoteFromRate(symbol: string, row: Record<string, unknown>): BrokerQuote | undefined {
  const selected = selectObservedQuotePrice({ last: row.lastExecution, bid: row.bid, ask: row.ask });
  if (selected.price === undefined) return undefined;
  const asOf = providerObservationIso(row.date);
  return {
    symbol,
    price: selected.price,
    bid: num(row.bid),
    ask: num(row.ask),
    ...(asOf ? { asOf } : {}),
    provider: "etoro"
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
