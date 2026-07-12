import Alpaca from "@alpacahq/alpaca-trade-api";
import crypto from "crypto";
import type {
  AccountCapabilities,
  BrokerageAccount,
  BrokerQuote,
  EquityOrder,
  EquityPosition,
  ExecutedOrder,
  MarketHours,
  OrderSide,
  OrderType,
  Portfolio,
  ReviewedOrder,
  TimeInForce,
  BrokerGateway,
  EquityOrderInput
} from "./types";
import { fromAlpacaSymbol, normalizeSymbol, toAlpacaSymbol } from "./money";
import { toBrokerSide } from "./broker-side";
import { getActiveConnectedAccount, getConnectedAccount, resolveApiKey } from "./db";
import { logApiHealth } from "./db-health";
import { recordProviderCall, pushBrokerBalance } from "./usage-monitor-push";
import { fetchDailyOHLC } from "./history";

/**
 * Fill in a usable price for any symbol the broker didn't quote (>0). Alpaca's latest-quote feed
 * returns 0/empty bid-ask outside market hours and on the free IEX tier, which used to leave the chat
 * with no price and the pre-trade review with a MAX_SAFE_INTEGER "can't size it" sentinel (so even a
 * 0.5-share order tripped every cap). A recent daily close (keyless Yahoo, works anytime) is a fine
 * sizing/notional anchor and lets the assistant answer price questions. Exported for testing.
 */
export async function fillMissingQuotesWithClose(
  quotes: Record<string, BrokerQuote>,
  symbols: string[],
  getFallback: (symbol: string) => Promise<{ price: number; asOf?: string } | undefined>
): Promise<Record<string, BrokerQuote>> {
  const missing = symbols.filter((s) => {
    const q = quotes[s];
    return !(q && typeof q.price === "number" && q.price > 0);
  });
  await Promise.all(
    missing.map(async (symbol) => {
      const fb = await getFallback(symbol).catch(() => undefined);
      if (fb && Number.isFinite(fb.price) && fb.price > 0) {
        quotes[symbol] = { symbol, price: fb.price, asOf: fb.asOf, provider: "yahoo-finance-delayed" };
      }
    })
  );
  return quotes;
}

export function getAlpacaGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new AlpacaBrokerGateway(userId, connectedAccountId);
}

// Re-exported for existing callers/tests that import symbol conversion from this module — the
// canonical definitions now live in ./money alongside normalizeSymbol so data-providers.ts and
// the Alpaca stream workers can share them without importing this (much heavier) gateway module.
export { toAlpacaSymbol, fromAlpacaSymbol };

export function classifyAlpacaAccountType(account: Record<string, unknown>): AccountCapabilities["accountType"] {
  const rawType = String(account.account_type ?? account.accountType ?? "").toLowerCase();
  const rawSubType = String(account.account_sub_type ?? account.account_subtype ?? account.accountSubType ?? "").toLowerCase();
  const combined = `${rawType} ${rawSubType}`;
  if (combined.includes("roth")) return "roth_ira";
  if (combined.includes("traditional") || combined.includes("trad") || combined.includes("ira")) return "traditional_ira";
  return "brokerage";
}

/**
 * Estimate an order's notional for the pre-trade review. NEVER fabricates a price:
 * a wrong notional corrupts the value persisted to `trade_proposals` and the daily
 * cap accounting (a fabricated $100 made a $50k buy count as $10k). Prefers explicit
 * order prices, then the live quote; if none is available and there's no dollar
 * amount, an un-sizable OPENING order is reported as over-cap so it is blocked.
 *
 * Side matters. The over-cap sentinel is ONLY valid for opening orders (buy/short) —
 * for those, "no price" means "can't size it, so don't let it through". For an EXIT
 * (sell/cover) the sentinel is actively harmful: exits are never notional-capped, and a
 * MAX_SAFE_INTEGER value corrupts the persisted/displayed notional AND the gross/net
 * exposure projection (a 1-share sell looked like a ~$9 quadrillion short and tripped the
 * net-exposure cap, blocking a risk-reducing exit). So for exits we fall back to the
 * captured entry anchor (`referencePrice`) and, failing that, report 0 — the exit still
 * executes and exposure caps correctly exempt it.
 */
export function estimateReviewNotional(
  input: { side?: OrderSide; dollarAmount?: number; quantity?: number; limitPrice?: number; stopPrice?: number; referencePrice?: number },
  quotePrice: number | undefined
): { estimatedNotional: number; alerts: string[] } {
  if (input.dollarAmount != null) {
    return { estimatedNotional: input.dollarAmount, alerts: [] };
  }
  const isExit = input.side === "sell" || input.side === "cover";
  // Live quote / explicit order price for either side; for an exit, also fall back to the entry anchor
  // so a missing live quote doesn't corrupt the notional (exits aren't capped, so an approximation is fine).
  const estPrice =
    input.limitPrice ??
    input.stopPrice ??
    (quotePrice && quotePrice > 0 ? quotePrice : undefined) ??
    (isExit && input.referencePrice && input.referencePrice > 0 ? input.referencePrice : undefined);
  if (estPrice != null && estPrice > 0) {
    return { estimatedNotional: (input.quantity ?? 0) * estPrice, alerts: [] };
  }
  if (isExit) {
    // Never use the over-cap sentinel for an exit — exits are exempt from notional caps, and a giant value
    // would corrupt the displayed notional and the net/gross exposure projection. 0 is safe and won't block.
    return {
      estimatedNotional: 0,
      alerts: ["Price unavailable — exit notional could not be estimated; exits are not notional-capped, so this does not block the order."],
    };
  }
  return {
    estimatedNotional: Number.MAX_SAFE_INTEGER,
    alerts: ["Price unavailable — notional could not be estimated; treating as over-cap (set a limit/stop price or dollar amount)."],
  };
}

class AlpacaBrokerGateway implements BrokerGateway {
  private alpaca: Alpaca;
  private label: string;
  private isMcp: boolean;
  private mcpUrl?: string;
  // Credential lane for health logging: a per-user connected account resolves to "user",
  // the operator env fallback (local only, no stored account) to "env".
  private keySource: string;

  constructor(private userId: string, connectedAccountId?: string) {
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const activeAccount = getActiveConnectedAccount(userId);
    const brokerAccount = targeted ?? activeAccount;
    const accountKeys =
      brokerAccount?.broker === "alpaca" || brokerAccount?.broker === "alpaca-mcp"
        ? brokerAccount
        : undefined;
    this.keySource = accountKeys ? "user" : "env";
    this.isMcp = brokerAccount?.broker === "alpaca-mcp";
    this.label = accountKeys?.label || (accountKeys?.environment === "live" ? "Alpaca Brokerage" : "Alpaca Paper");
    // A connected-account key (per-user account data) wins. If an Alpaca account is explicitly
    // selected, never fall back to generic/operator Alpaca keys: those can belong to a different
    // account and surface as a misleading "Account Mismatch" instead of the real credential problem.
    // SECURITY: route through resolveApiKey so the env fallback is operator-only (alpaca keys are
    // a per-user-only tier). A non-`local` user with no stored key gets "" → broker construction
    // fails loudly instead of silently trading on the operator's Alpaca account via process.env.
    const keyId = accountKeys?.apiKey?.trim() || (!accountKeys ? resolveApiKey("alpaca_paper_api_key", userId) || "" : "");
    const secretKey = accountKeys?.apiSecret?.trim() || (!accountKeys ? resolveApiKey("alpaca_paper_secret_key", userId) || "" : "");

    let baseUrl = accountKeys?.baseUrl?.trim();
    if (this.isMcp) {
      this.mcpUrl = baseUrl || undefined;
    }

    if (accountKeys && !this.isMcp && !keyId) {
      throw new Error(
        `Alpaca credentials are missing for ${this.label}. Open Settings -> Accounts and re-save the API key.`
      );
    }
    if (accountKeys && this.isMcp && !this.mcpUrl && !keyId) {
      throw new Error(
        `Alpaca MCP credentials are missing for ${this.label}. Open Settings -> Accounts and re-save the MCP endpoint or API key.`
      );
    }

    if (baseUrl && !this.isMcp) {
      baseUrl = baseUrl.replace(/\/+$/, "");
      if (baseUrl.toLowerCase().endsWith("/v2")) {
        baseUrl = baseUrl.slice(0, -3);
      }
    }

    const options: any = {
      paper: accountKeys?.environment !== "live",
      usePolygon: false
    };

    if (keyId && !secretKey) {
      options.oauth = keyId;
    } else {
      options.keyId = keyId;
      options.secretKey = secretKey;
    }

    if (baseUrl && !this.isMcp) {
      options.baseUrl = baseUrl;
    }

    this.alpaca = new Alpaca(options);
  }

  // Wrap a raw Alpaca SDK call so the admin connections-health page can show whether the
  // broker gateway itself is reachable ("alpaca-broker"), distinct from the market-data
  // enrichment services. logApiHealth already swallows its own errors, but the timing/log
  // is still wrapped so a health-logging failure can never affect the real broker call.
  // The Alpaca SDK ships no types, so this.alpaca.* calls are already `any`; a constrained
  // generic here would collapse those returns to `unknown` at every call site.
  private async trackHealth(fn: () => Promise<any>): Promise<any> {
    const start = Date.now();
    try {
      const result = await fn();
      logApiHealth({ service: "alpaca-broker", ok: true, latencyMs: Date.now() - start, keySource: this.keySource, userId: this.userId });
      recordProviderCall("alpaca", { service: "broker", ok: true });
      return result;
    } catch (err) {
      logApiHealth({
        service: "alpaca-broker",
        ok: false,
        latencyMs: Date.now() - start,
        errorText: err instanceof Error ? err.message : String(err),
        keySource: this.keySource,
        userId: this.userId
      });
      recordProviderCall("alpaca", { service: "broker", ok: false });
      throw err;
    }
  }

  private async callMcp<T>(toolName: string, args: Record<string, unknown>, fallbackFn: () => Promise<T>): Promise<T> {
    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }
    try {
      const response = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Alpaca MCP HTTP ${response.status}`);
      }
      const body = await response.json();
      if (body.error) {
        throw new Error(body.error.message || JSON.stringify(body.error));
      }
      const content = body.result?.content;
      if (Array.isArray(content) && content[0]?.type === "text") {
        try {
          return JSON.parse(content[0].text);
        } catch {
          return content[0].text;
        }
      }
      return body.result;
    } catch (e) {
      console.warn(`Alpaca MCP tool call "${toolName}" failed, falling back to REST:`, e);
      return fallbackFn();
    }
  }


  async getAccounts(): Promise<BrokerageAccount[]> {
    const getCapabilities = (acc: any): AccountCapabilities => {
      const shortSelling = Boolean(acc.shorting_enabled);
      const rawAccountType = String(acc.account_type ?? "").toUpperCase();
      const accountType = classifyAlpacaAccountType(acc);
      const marginEnabled = accountType === "brokerage" && (shortSelling || rawAccountType === "MARGIN");
      return {
        equityTrading: true,
        shortSelling,
        optionsTrading: false,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled,
        accountType
      };
    };

    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.trackHealth(() => this.alpaca.getAccount());
      return [
        {
          accountNumber: account.account_number,
          label: this.label,
          agenticAllowed: true,
          capabilities: getCapabilities(account)
        }
      ];
    }).then((res: any) => {
      if (res && res.account_number) {
        return [
          {
            accountNumber: res.account_number,
            label: this.label,
            agenticAllowed: true,
            capabilities: getCapabilities(res)
          }
        ];
      }
      return res;
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.trackHealth(() => this.alpaca.getAccount());
      // Alpaca API credentials are scoped to exactly one account, so getAccount() always returns THE
      // account these keys belong to. Only flag a GENUINE cross-account mismatch (both numbers present
      // and actually different, ignoring case/whitespace) — a blank configured number or a mere
      // formatting difference must never block a run. The message is actionable so the operator can
      // correct the stored number in Settings → Accounts.
      const liveNum = String(account.account_number ?? "").trim();
      const wantNum = String(accountNumber ?? "").trim();
      if (wantNum && liveNum && liveNum.toLowerCase() !== wantNum.toLowerCase()) {
        throw new Error(
          `Account Mismatch: the connected Alpaca credentials are for account ${liveNum}, but this profile is configured for ${wantNum}. Update the account number in Settings → Accounts.`
        );
      }
      return {
        accountNumber,
        totalMarketValue: number(account.portfolio_value),
        buyingPower: number(account.buying_power),
        equityMarketValue: number(account.equity) - number(account.cash),
        optionMarketValue: 0,
        cash: number(account.cash)
      };
    }).then((res: any) => {
      let result: Portfolio;
      if (res && res.account_number) {
        result = {
          accountNumber,
          totalMarketValue: number(res.portfolio_value),
          buyingPower: number(res.buying_power),
          equityMarketValue: number(res.equity) - number(res.cash),
          optionMarketValue: 0,
          cash: number(res.cash)
        };
      } else {
        result = res;
      }
      if (result && result.accountNumber) {
        pushBrokerBalance({
          provider: "alpaca",
          userId: this.userId,
          accountNumber: result.accountNumber,
          cash: result.cash,
          buyingPower: result.buyingPower,
          equity: result.totalMarketValue
        });
      }
      return result;
    });
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    return this.callMcp<any>("get_positions", {}, async () => {
      const positions = await this.trackHealth(() => this.alpaca.getPositions());
      return positions.map(parseAlpacaPosition);
    }).then((res: any) => {
      if (Array.isArray(res)) {
        return res.map(parseAlpacaPosition);
      }
      return res;
    });
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
    return this.callMcp<any>("get_orders", { status: "all", limit: 500 }, async () => {
      // Paginate: Alpaca returns at most `limit` (max 500) per call, newest-first. Walk backwards via
      // `until` (the oldest created_at seen) until a short page signals the end. Without this the
      // default page silently capped history and missed older orders. Dedupe by id at page edges.
      const all: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const PAGE = 500;
      let until: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = (await this.trackHealth(() => this.alpaca.getOrders({
          status: "all",
          limit: PAGE,
          direction: "desc",
          ...(until ? { until } : {})
        } as Parameters<typeof this.alpaca.getOrders>[0]))) as Record<string, unknown>[];
        if (!Array.isArray(page) || page.length === 0) break;
        let added = 0;
        let oldest: string | undefined;
        for (const o of page) {
          const id = String(o.id);
          const createdAt = String(o.created_at);
          if (!seen.has(id)) {
            seen.add(id);
            all.push(o);
            added += 1;
          }
          if (!oldest || createdAt < oldest) oldest = createdAt;
        }
        // Stop on a short page, no forward progress, or a stuck boundary.
        if (page.length < PAGE || added === 0 || !oldest || oldest === until) break;
        until = oldest;
      }
      return all;
    }).then((res: any) => (Array.isArray(res) ? res.map((o: any) => mapAlpacaOrder(o as Record<string, unknown>)) : res));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    // Standard quotes method: fall back to REST directly to avoid multi-ticker latency
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const rawSymbol of symbols) {
      const requested = normalizeSymbol(rawSymbol);
      const canonical = fromAlpacaSymbol(toAlpacaSymbol(requested));
      if (!canonical) continue;
      const aliases = aliasesByCanonical.get(canonical) ?? new Set<string>();
      aliases.add(canonical);
      if (requested) aliases.add(requested);
      aliasesByCanonical.set(canonical, aliases);
    }
    const normalizedSymbols = Array.from(aliasesByCanonical.keys());
    const quotes: Record<string, BrokerQuote> = {};
    try {
      const response = await this.trackHealth(() => this.alpaca.getLatestQuotes(normalizedSymbols.map(toAlpacaSymbol)));
      for (const [rawSymbol, q] of Object.entries(response)) {
        const symbol = fromAlpacaSymbol(rawSymbol);
        const anyQ = q as Record<string, number | string>;
        const bid = optionalNumber(anyQ.bp);
        const ask = optionalNumber(anyQ.ap);
        quotes[symbol] = {
          symbol,
          price: ask ?? bid ?? 0,
          bid,
          ask,
          asOf: optionalIso(anyQ.t),
          provider: "alpaca"
        };
      }
    } catch (error) {
      // Don't fail silently — a swallowed quote error is what makes the review fall through to an
      // unusable price. Surface it; the keyless fallback below still tries to price the symbols.
      console.warn(`[alpaca] getLatestQuotes failed for ${normalizedSymbols.join(",")}:`, error instanceof Error ? error.message : error);
    }
    // Keyless market-data fallback for any symbol the broker left unpriced (0/empty bid-ask — common
    // outside market hours and on the free IEX tier). A recent daily close keeps the chat quote and
    // the pre-trade notional review usable instead of failing closed to the over-cap sentinel.
    await fillMissingQuotesWithClose(quotes, normalizedSymbols, async (symbol) => {
      const bars = await fetchDailyOHLC(symbol, Date.now(), this.userId);
      const last = bars && bars.length ? bars[bars.length - 1] : undefined;
      return last && typeof last.close === "number" ? { price: last.close, asOf: last.time != null ? String(last.time) : undefined } : undefined;
    });
    for (const [canonical, aliases] of aliasesByCanonical) {
      const quote = quotes[canonical];
      if (!quote) continue;
      for (const alias of aliases) {
        if (!quotes[alias]) quotes[alias] = { ...quote, symbol: alias };
      }
    }
    return quotes;
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: true }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const quotePrice = quotes[normalizeSymbol(input.symbol)]?.price;
    const { estimatedNotional, alerts } = estimateReviewNotional(input, quotePrice);
    return { estimatedNotional, alerts, raw: { alpaca: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const isBracket = !!(input.bracketTakeProfit || input.bracketStopLoss);

    // Alpaca does not support notional (dollar) bracket orders — only qty-based.
    // If a bracketed dollar order reaches this gateway, it must carry a real entry
    // anchor from review/proposal enrichment. Never fall back to 1; that can turn a
    // $500 market bracket into 500 shares.
    let bracketQty: number | undefined;
    if (isBracket && input.dollarAmount && !input.quantity) {
      const estPrice = input.limitPrice ?? input.referencePrice;
      if (estPrice == null || !(estPrice > 0)) {
        throw new Error("Alpaca bracket dollar orders require a positive limitPrice or referencePrice.");
      }
      bracketQty = Math.floor(input.dollarAmount / estPrice);
      if (bracketQty < 1) {
        throw new Error("Alpaca bracket dollar order is too small for a whole-share bracket at the reference price.");
      }
    }

    const fallbackFn = async () => {
      try {
        const orderOptions: Record<string, unknown> = {
          symbol: toAlpacaSymbol(input.symbol),
          side: toBrokerSide(input.side), // short→sell, cover→buy; Alpaca infers open/close from position
          type: input.type,
          // Bracket orders require time_in_force="day" — Alpaca rejects "gtc" entries with brackets.
          time_in_force: isBracket ? "day" : (input.timeInForce === "gfd" ? "day" : "gtc"),
          client_order_id: input.refId
        };

        if (bracketQty != null) {
          orderOptions.qty = bracketQty;
        } else if (input.quantity) {
          orderOptions.qty = input.quantity;
        } else if (input.dollarAmount && !isBracket) {
          orderOptions.notional = input.dollarAmount;
        }

        if (input.limitPrice) orderOptions.limit_price = input.limitPrice;
        if (input.stopPrice) orderOptions.stop_price = input.stopPrice;
        if (input.marketHours === "extended_hours") orderOptions.extended_hours = true;

        if (isBracket) {
          orderOptions.order_class = "bracket";
          if (input.bracketTakeProfit != null) {
            orderOptions.take_profit = { limit_price: input.bracketTakeProfit };
          }
          if (input.bracketStopLoss != null) {
            orderOptions.stop_loss = {
              stop_price: input.bracketStopLoss,
              ...(input.bracketStopLimit != null ? { limit_price: input.bracketStopLimit } : {})
            };
          }
        }

        const raw = await this.trackHealth(() => this.alpaca.createOrder(orderOptions));
        return {
          orderId: raw.id,
          refId: input.refId,
          state: raw.status,
          filledQuantity: optionalNumber(raw.filled_qty),
          averagePrice: optionalNumber(raw.filled_avg_price),
          raw
        };
      } catch (error: unknown) {
        throw new Error(`Alpaca order failed: ${formatAlpacaOrderError(error)}`);
      }
    };

    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }

    const toolName = input.type === "limit"
      ? "place_limit_order"
      : (input.type === "stop_market" || input.type === "stop_limit")
        ? "place_stop_order"
        : "place_market_order";

    const orderArgs: Record<string, any> = {
      symbol: toAlpacaSymbol(input.symbol),
      side: toBrokerSide(input.side), // short→sell, cover→buy; Alpaca infers open/close from position
      type: input.type,
      // Bracket orders require time_in_force="day" — Alpaca rejects "gtc" entries with brackets.
      time_in_force: isBracket ? "day" : (input.timeInForce === "gfd" ? "day" : "gtc"),
      client_order_id: input.refId
    };

    if (bracketQty != null) orderArgs.qty = String(bracketQty);
    else if (input.quantity) orderArgs.qty = String(input.quantity);
    else if (input.dollarAmount && !isBracket) orderArgs.notional = String(input.dollarAmount);

    if (input.limitPrice) orderArgs.limit_price = String(input.limitPrice);
    if (input.stopPrice) orderArgs.stop_price = String(input.stopPrice);

    if (isBracket) {
      orderArgs.order_class = "bracket";
      if (input.bracketTakeProfit != null) {
        orderArgs.take_profit = { limit_price: input.bracketTakeProfit };
      }
      if (input.bracketStopLoss != null) {
        orderArgs.stop_loss = {
          stop_price: input.bracketStopLoss,
          ...(input.bracketStopLimit != null ? { limit_price: input.bracketStopLimit } : {})
        };
      }
    }

    return this.callMcp<any>(toolName, orderArgs, fallbackFn).then((res: any) => {
      if (res && res.id) {
        return {
          orderId: res.id,
          refId: input.refId,
          state: res.status,
          filledQuantity: optionalNumber(res.filled_qty),
          averagePrice: optionalNumber(res.filled_avg_price),
          raw: res
        };
      }
      return res;
    });
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.callMcp<any>("cancel_order", { order_id: orderId }, async () => {
      await this.trackHealth(() => this.alpaca.cancelOrder(orderId));
      return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: {} };
    }).then((res: any) => {
      if (res && typeof res === "object") {
        return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: res };
      }
      return res;
    });
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

// Map Alpaca's raw order `type` to our OrderType union. Alpaca uses "stop" (not "stop_market") and
// "trailing_stop"; a raw `as OrderType` cast silently leaked those non-union values downstream.
export function mapAlpacaOrderType(raw: unknown): OrderType {
  switch (String(raw)) {
    case "market":
      return "market";
    case "limit":
      return "limit";
    case "stop":
      return "stop_market";
    case "stop_limit":
      return "stop_limit";
    case "trailing_stop":
      return "stop_market"; // closest representation in our union (a stop-triggered exit)
    default:
      return "market"; // unknown/absent → safe default rather than leaking an invalid value
  }
}

// Map a raw Alpaca order object (REST or MCP shape — same field names) to our EquityOrder.
export function mapAlpacaOrder(o: Record<string, unknown>): EquityOrder {
  return {
    id: String(o.id),
    symbol: fromAlpacaSymbol(String(o.symbol)),
    side: o.side as OrderSide,
    type: mapAlpacaOrderType(o.type),
    state: String(o.status),
    quantity: optionalNumber(o.qty),
    dollarAmount: optionalNumber(o.notional),
    filledQuantity: optionalNumber(o.filled_qty),
    averagePrice: optionalNumber(o.filled_avg_price),
    limitPrice: optionalNumber(o.limit_price),
    stopPrice: optionalNumber(o.stop_price),
    timeInForce: o.time_in_force ? String(o.time_in_force) : undefined,
    createdAt: String(o.created_at),
    updatedAt: o.updated_at ? String(o.updated_at) : undefined,
    clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
    placedAgent: "alpaca"
  };
}

export function parseAlpacaPosition(p: Record<string, unknown>): EquityPosition {
  return {
    symbol: fromAlpacaSymbol(String(p.symbol)),
    quantity: number(p.qty ?? p.quantity),
    averageCost: number(p.avg_entry_price ?? p.average_entry_price ?? p.averageCost),
    marketValue: number(p.market_value ?? p.marketValue),
    sector: undefined,
    industry: undefined
  };
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function formatAlpacaOrderError(error: unknown): string {
  const err = error as {
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  const status = err.response?.status;
  const data = err.response?.data;
  const body = typeof data === "string"
    ? data
    : data && typeof data === "object"
      ? JSON.stringify(data)
      : "";
  const message = err.message ?? String(error);
  const detail = [status ? `HTTP ${status}` : "", message, body].filter(Boolean).join(" — ");
  if (status === 403 && !/position|short|permission|forbidden|insufficient/i.test(body)) {
    return `${detail} — broker forbade the order; verify the account has permission and a matching open position if this was a sell/cover.`;
  }
  return detail;
}
