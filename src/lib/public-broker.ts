/**
 * Public.com Individual Trader API gateway.
 * Live-only (no paper).  Personal-use license: owner account only.
 * Docs: https://public.com/api/docs
 */
import { randomUUID } from "crypto";
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
import { isLiveOrderState } from "./broker-side";
import { brokerAbortSignal, chunkBrokerSymbols, scopeBrokerOrders } from "./inflight-deadline";
import { mergeAccountCapabilities } from "./venue-contract";
import { resolveSourceBool } from "./source-settings";

function publicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const caller = init.signal instanceof AbortSignal ? init.signal : undefined;
  return fetch(url, { ...init, signal: brokerAbortSignal(caller) });
}

function publicExecutionEnabled(): boolean {
  return resolveSourceBool("PUBLIC_EXECUTION_ENABLED");
}

const PUBLIC_API = "https://api.public.com";

export function getPublicGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new PublicBrokerGateway(userId, connectedAccountId);
}

export async function mintPublicAccessToken(
  secret: string,
  validityInMinutes = 60,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(`${PUBLIC_API}/userapiauthservice/personal/access-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ validityInMinutes, secret }),
    signal: brokerAbortSignal()
  });
  if (!res.ok) throw new Error(`Public token mint failed (${res.status})`);
  const json = (await res.json()) as { accessToken?: string };
  if (!json.accessToken) throw new Error("Public token mint returned no accessToken");
  return json.accessToken;
}

function emptyCaps(over: Partial<AccountCapabilities> = {}): AccountCapabilities {
  return mergeAccountCapabilities("public", over);
}

class PublicBrokerGateway implements BrokerGateway {
  private readonly userId: string;
  private readonly secretValue: string;
  private readonly storedAccountId?: string;
  private token: { value: string; exp: number } | null = null;

  constructor(userId: string, connectedAccountId?: string) {
    this.userId = userId;
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const active = getActiveConnectedAccount(userId);
    const acct = targeted?.broker === "public" ? targeted : active?.broker === "public" ? active : undefined;
    if (!acct) throw new Error("No Public.com account connected.");
    const secret = acct.apiSecret?.trim() || acct.apiKey?.trim() || "";
    if (!secret) {
      throw new Error(`Public.com secret is missing for ${acct.label}.  Generate it in Account Settings → Security → API.`);
    }
    this.secretValue = secret;
    this.storedAccountId = acct.accountNumber?.trim();
  }

  private async authHeader(): Promise<Record<string, string>> {
    const now = Date.now();
    if (!this.token || this.token.exp < now + 60_000) {
      const value = await mintPublicAccessToken(this.secretValue);
      this.token = { value, exp: now + 55 * 60_000 };
    }
    return { Authorization: `Bearer ${this.token.value}`, Accept: "application/json" };
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn();
      logApiHealth({ service: "public-broker", ok: true, latencyMs: Date.now() - start, userId: this.userId });
      return out;
    } catch (error) {
      logApiHealth({
        service: "public-broker",
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
      const headers = await this.authHeader();
      const res = await publicFetch(`${PUBLIC_API}/userapigateway/trading/account`, { headers });
      if (!res.ok) throw new Error(`Public accounts ${res.status}`);
      const json = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
      const rows = Array.isArray(json) ? json : [json];
      return rows.flatMap((row) => {
        const accountNumber = String(row.accountId ?? row.account_id ?? "");
        if (!accountNumber) return [];
        const rawType = String(row.accountType ?? "").toUpperCase();
        const accountType: AccountCapabilities["accountType"] = rawType.includes("ROTH")
          ? "roth_ira"
          : rawType.includes("IRA")
            ? "traditional_ira"
            : "brokerage";
        return [{
          accountNumber,
          label: String(row.accountType ?? "Public"),
          agenticAllowed: true,
          capabilities: emptyCaps({
            accountType,
            shortSelling: true,
            optionsTrading: Boolean(row.optionsLevel),
            marginEnabled: String(row.brokerageAccountType ?? "").toUpperCase() === "MARGIN"
          })
        }];
      });
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const port = await this.portfolio(accountNumber);
    const equity = num(port.totalAccountValue) ?? num(port.equityValue) ?? 0;
    return {
      accountNumber,
      cash: num(port.cash) ?? 0,
      buyingPower: num(port.buyingPower) ?? num(port.cash) ?? 0,
      equityMarketValue: num(port.equityValue) ?? equity,
      optionMarketValue: 0,
      totalMarketValue: equity
    };
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const port = await this.portfolio(accountNumber);
    const positions = Array.isArray(port.positions) ? port.positions : [];
    return positions.flatMap((item) => {
      const row = item as Record<string, unknown>;
      const inst = (row.instrument ?? {}) as Record<string, unknown>;
      const symbol = normalizeSymbol(String(inst.symbol ?? row.symbol ?? ""));
      if (!symbol) return [];
      return [{
        symbol,
        quantity: num(row.quantity) ?? 0,
        averageCost: num(row.costBasis) ?? num(row.averagePrice) ?? 0,
        marketValue: num(row.currentValue) ?? num(row.marketValue) ?? 0
      }];
    });
  }

  async getEquityOrders(accountNumber: string, options?: import("./types").GetEquityOrdersOptions): Promise<EquityOrder[]> {
    const port = await this.portfolio(accountNumber);
    const orders = Array.isArray(port.orders) ? port.orders : [];
    const mapped: EquityOrder[] = orders.flatMap((item) => {
      const row = item as Record<string, unknown>;
      const inst = (row.instrument ?? {}) as Record<string, unknown>;
      const id = String(row.orderId ?? row.id ?? "");
      if (!id) return [];
      return [{
        id,
        symbol: normalizeSymbol(String(inst.symbol ?? "")),
        side: String(row.orderSide ?? "BUY").toLowerCase() === "sell" ? "sell" : "buy",
        type: mapPublicType(String(row.orderType ?? "MARKET")),
        state: String(row.status ?? "new").toLowerCase(),
        quantity: num(row.quantity),
        createdAt: String(row.createdAt ?? new Date().toISOString())
      }];
    });
    return scopeBrokerOrders(mapped, options, (state) => isLiveOrderState(state));
  }

  async getEquityQuotes(_accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    return this.track(async () => {
      const headers = { ...(await this.authHeader()), "Content-Type": "application/json" };
      const accountId = this.storedAccountId ?? _accountNumber;
      const out: Record<string, BrokerQuote> = {};
      for (const chunk of chunkBrokerSymbols(symbols)) {
        const res = await publicFetch(`${PUBLIC_API}/userapigateway/marketdata/${encodeURIComponent(accountId)}/quotes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            instruments: chunk.map((symbol) => ({ symbol: normalizeSymbol(symbol), type: "EQUITY" }))
          })
        });
        if (!res.ok) throw new Error(`Public quotes ${res.status}`);
        const json = (await res.json()) as { quotes?: Record<string, unknown>[] } | Record<string, unknown>[];
        const rows = Array.isArray(json) ? json : json.quotes ?? [];
        for (const row of rows) {
          const inst = (row.instrument ?? {}) as Record<string, unknown>;
          const symbol = normalizeSymbol(String(inst.symbol ?? row.symbol ?? ""));
          if (!symbol) continue;
          out[symbol] = {
            symbol,
            price: num(row.last) ?? mid(num(row.bid), num(row.ask)),
            bid: num(row.bid),
            ask: num(row.ask),
            volume: num(row.volume),
            asOf: typeof row.lastTimestamp === "string" ? row.lastTimestamp : undefined,
            provider: "public"
          };
        }
      }
      return out;
    });
  }

  async getEquityTradability(_accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>> {
    const out: Record<string, { tradable: boolean; fractional: boolean; reason?: string }> = {};
    for (const symbol of symbols) {
      const headers = await this.authHeader();
      const res = await publicFetch(
        `${PUBLIC_API}/userapigateway/trading/instruments/${encodeURIComponent(normalizeSymbol(symbol))}/EQUITY`,
        { headers }
      );
      if (!res.ok) {
        out[normalizeSymbol(symbol)] = { tradable: false, fractional: false, reason: `Public ${res.status}` };
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const trading = String(json.trading ?? "");
      const fractional = String(json.fractionalTrading ?? "");
      out[normalizeSymbol(symbol)] = {
        tradable: trading === "BUY_AND_SELL",
        fractional: fractional === "BUY_AND_SELL",
        reason: trading === "BUY_AND_SELL" ? undefined : trading || "not tradable"
      };
    }
    return out;
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    if (!publicExecutionEnabled()) {
      throw new OrderValidationError(
        "Public execution is parked until this account is funded.  Turn on Public.com Order Execution in Data Sources after funding."
      );
    }
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price;
    const { estimatedNotional, alerts } = estimateReviewNotional(input, price);
    return {
      estimatedNotional,
      alerts,
      raw: { public: true }
    };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    if (!publicExecutionEnabled()) {
      throw new OrderValidationError(
        "Public execution is parked until this account is funded.  Turn on Public.com Order Execution in Data Sources after funding."
      );
    }
    return this.track(async () => {
      const headers = { ...(await this.authHeader()), "Content-Type": "application/json" };
      const orderId = isUuid(input.refId) ? input.refId : randomUUID();
      const body: Record<string, unknown> = {
        orderId,
        instrument: { symbol: normalizeSymbol(input.symbol), type: "EQUITY" },
        orderSide: input.side === "buy" || input.side === "cover" ? "BUY" : "SELL",
        orderType: toPublicOrderType(input.type),
        expiration: { timeInForce: input.timeInForce === "gtc" ? "GTC" : "DAY" }
      };
      if (input.quantity != null) body.quantity = input.quantity;
      else if (input.dollarAmount != null) body.amount = input.dollarAmount;
      if (input.side === "short") body.openCloseIndicator = "OPEN";
      if (input.side === "cover") body.openCloseIndicator = "CLOSE";
      if (input.limitPrice != null) body.limitPrice = input.limitPrice;
      if (input.stopPrice != null) body.stopPrice = input.stopPrice;
      const res = await publicFetch(`${PUBLIC_API}/userapigateway/trading/${encodeURIComponent(input.accountNumber)}/order`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`Public place ${res.status}`);
      return { refId: input.refId, orderId, state: "accepted", raw: { public: true } };
    });
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.track(async () => {
      const headers = await this.authHeader();
      const res = await publicFetch(
        `${PUBLIC_API}/userapigateway/trading/${encodeURIComponent(accountNumber)}/order/${encodeURIComponent(orderId)}`,
        { method: "DELETE", headers }
      );
      if (!res.ok) throw new Error(`Public cancel ${res.status}`);
      return { refId: orderId, orderId, state: "canceled", raw: { public: true } };
    });
  }

  private async portfolio(accountNumber: string): Promise<Record<string, unknown>> {
    return this.track(async () => {
      const headers = await this.authHeader();
      const res = await publicFetch(`${PUBLIC_API}/userapigateway/trading/${encodeURIComponent(accountNumber)}/portfolio/v2`, {
        headers
      });
      if (!res.ok) throw new Error(`Public portfolio ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    });
  }
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function mid(bid?: number, ask?: number): number | undefined {
  if (bid && ask) return (bid + ask) / 2;
  return bid ?? ask;
}

function mapPublicType(raw: string): EquityOrder["type"] {
  const t = raw.toUpperCase();
  if (t === "LIMIT") return "limit";
  if (t === "STOP") return "stop_market";
  if (t === "STOP_LIMIT") return "stop_limit";
  return "market";
}

function toPublicOrderType(type: EquityOrderInput["type"]): string {
  if (type === "limit") return "LIMIT";
  if (type === "stop_market") return "STOP";
  if (type === "stop_limit") return "STOP_LIMIT";
  if (type === "market") return "MARKET";
  throw new OrderValidationError(`Public.com does not accept order type ${type}`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
