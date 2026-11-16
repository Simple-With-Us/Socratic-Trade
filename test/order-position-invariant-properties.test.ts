/**
 * Property checks for the money-path order invariants (ST-4616).
 *
 * fast-check is not a dependency. A seeded mulberry32 generator builds positions
 * (long / short / flat, whole and fractional, BRK.B and BRK-B) and orders
 * (buy / sell / short / cover, share or dollar size, market / limit / stop /
 * stop_limit, gfd / gtc, with and without bracket legs). Each case is placed
 * through getBrokerGateway with the Alpaca SDK and Tradier HTTP mocked, so the
 * assertions read the final broker payload. No network.
 *
 * Seed 0x4616. Default 1000 cases per broker. PROPERTY_CASES overrides the count.
 * PROPERTY_ONLY=<index> reruns one case.
 *
 * Properties, on a payload that was actually submitted:
 * 1. A payload never opens or increases a short unless the order is an explicit
 *    short entry and allowedProposalSides includes "short" (policy flag and
 *    account capability). Sells of a flat or short book are refused when the
 *    position read is verified. Alpaca refuses an unverified sell/cover.
 * 2. A verified exit quantity never exceeds the held quantity. A fresh read
 *    wins over a larger stale size the order was built from.
 * 3. Closing orders carry no bracket / OTO / OTOCO legs.
 * 4. Market orders carry no limit or stop price.
 * 5. A dollar full exit (within 2% of held market value, or larger) is the
 *    exact held quantity on Alpaca. Tradier sends a whole-share quantity that
 *    does not exceed the held quantity. A Tradier partial dollar exit is that
 *    share quantity, or it is refused when the position cannot price it.
 * 6. Quantities are positive and on the broker's grid (Alpaca 1e-9, Tradier
 *    whole shares). Prices are on the broker's price increment.
 * 7. The Tradier tag is at most 255 characters of [A-Za-z0-9-]. A refId that
 *    is already in that set round-trips; any other refId is the sanitized tag.
 * 8. Alpaca time_in_force is day or gtc, never gfd. gfd, fractional qty,
 *    notional, brackets, and extended hours are day. Tradier duration is
 *    day, gtc, pre, or post. gfd never becomes gtc. An extended-hours limit
 *    uses pre/post inside those windows and day outside them.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { roundAlpacaPrice, roundCents } from "../src/lib/money";
import {
  applyPositionInvariant,
  heldPositionFor,
  holdUnpricedShortDollarProposals,
  isRetryablePositionInvariantError,
  normalizeExitSideForHeldPosition,
  OrderPositionInvariantError
} from "../src/lib/order-position-invariant";
import { allowedProposalSides } from "../src/lib/strategy-risk";
import type {
  AccountCapabilities,
  EquityOrderInput,
  OrderSide,
  OrderType,
  TimeInForce,
  TradeProposal,
  TradingPolicy
} from "../src/lib/types";
import { OrderValidationError } from "../src/lib/types";

/** One audit_events row as SQLite returns it, and its decoded JSON payload (trust boundary). */
const AuditEventRowSchema = z.object({ payload: z.string() });
const AuditPayloadSchema = z.record(z.string(), z.unknown());

const SEED = 0x4616;
const CASES = Number(process.env.PROPERTY_CASES ?? 1000);
const ONLY = process.env.PROPERTY_ONLY != null ? Number(process.env.PROPERTY_ONLY) : undefined;
const EPS = 1e-9;
const QTY_POOL = [0, 1, 2, 4, 10, 12, 50, 0.5, 1.5, 2.25, 10.5, 0.02778376];
const PRICE_POOL = [0.42, 0.42678, 1, 10, 24.865, 48, 100, 149.5, 400];
const ALPACA_ACCOUNT = "PA33IDTHMFK9";
const TRADIER_ACCOUNT = "VA1234567";
const CLOCKS = {
  regular: new Date("2026-10-14T19:00:00.000Z"),
  pre: new Date("2026-10-14T12:00:00.000Z"),
  post: new Date("2026-10-14T21:00:00.000Z")
} as const;

const shortCapable: AccountCapabilities = {
  equityTrading: true,
  shortSelling: true,
  optionsTrading: false,
  futuresTrading: false,
  cryptoTrading: false,
  marginEnabled: true,
  accountType: "brokerage"
};
const noShortCapable: AccountCapabilities = { ...shortCapable, shortSelling: false };

interface HarnessState {
  alpacaFail: boolean;
  alpacaRows: Record<string, unknown>[];
  tradierFail: boolean;
  tradierPositions: Record<string, unknown>[];
  tradierQuotes: Record<string, unknown>[];
  /** Quote batch returns 503, so Tradier positions fall back to cost basis. */
  tradierQuoteFail: boolean;
  posts: string[];
}

const harness = vi.hoisted(() => {
  const state: HarnessState = {
    alpacaFail: false,
    alpacaRows: [],
    tradierFail: false,
    tradierPositions: [],
    tradierQuotes: [],
    tradierQuoteFail: false,
    posts: []
  };
  const createOrder = vi.fn(async (opts: Record<string, unknown>) => ({
    id: "ord-1",
    status: "accepted",
    filled_qty: "0",
    filled_avg_price: null,
    ...opts
  }));
  const getPositions = vi.fn(async () => {
    if (state.alpacaFail) throw new Error("alpaca getPositions timed out");
    return state.alpacaRows;
  });
  return { state, createOrder, getPositions };
});

vi.mock("@alpacahq/alpaca-trade-api", () => {
  const MockAlpaca = vi.fn(function MockAlpaca() {
    return {
      createOrder: harness.createOrder,
      getPositions: harness.getPositions,
      getAccount: vi.fn(),
      getOrders: vi.fn(async () => [])
    };
  });
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});

type ReadMode = "fresh" | "hint" | "fail";
type Clock = keyof typeof CLOCKS;
type BrokerName = "alpaca" | "tradier";

interface GenCase {
  i: number;
  symbol: string;
  positionSymbol: string;
  freshQty: number;
  staleQty: number;
  price: number;
  marketValue: number;
  read: ReadMode;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  marketHours: "regular_hours" | "extended_hours";
  clock: Clock;
  quantity?: number;
  dollarAmount?: number;
  limitPrice?: number;
  stopPrice?: number;
  bracketTakeProfit?: number;
  bracketStopLoss?: number;
  bracketStopLimit?: number;
  refId: string;
  shortSellingEnabled: boolean;
  accountCanShort: boolean;
}

interface HitCounts {
  placed: number;
  refused: number;
  policyBlockedShort: number;
  freshClamp: number;
  fullDollar: number;
  marketNoPrice: number;
  closingNoBracket: number;
  shortEntry: number;
  shareClass: number;
  staleSmaller: number;
  readFailed: number;
  dirtyTag: number;
  extendedLimit: number;
  /** Alpaca quantity exits whose size was checked against the held position. */
  exitBound: number;
  /** Exits that carried both a positive quantity and a dollarAmount; quantity won. */
  mixedQtyWins: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[int(rng, values.length)]!;
}

function canonicalSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, "-");
}

function signedQty(rng: () => number): number {
  const mag = pick(rng, QTY_POOL);
  const sign = int(rng, 3);
  if (sign === 0 || mag === 0) return 0;
  return sign === 1 ? -Math.abs(mag) : Math.abs(mag);
}

function refFor(rng: () => number, i: number): string {
  const kind = int(rng, 5);
  if (kind === 0) return `protstop-${i.toString(16)}-ab12`;
  if (kind === 1) return `sstop_${i}_x`;
  if (kind === 2) return `${"a".repeat(280)}-${i}`;
  if (kind === 3) return `ref.${i}.id`;
  return `uuid${i.toString(16).padStart(8, "0")}abcd`;
}

function generateCase(rng: () => number, i: number): GenCase {
  const base = pick(rng, ["AAPL", "MSFT", "VZ", "PG", "BRK"] as const);
  let symbol: string;
  let positionSymbol: string;
  if (base === "BRK") {
    symbol = pick(rng, ["BRK.B", "BRK-B", "brk.b"]);
    positionSymbol = pick(rng, ["BRK.B", "BRK-B"]);
  } else if (int(rng, 8) === 0) {
    symbol = base;
    positionSymbol = pick(rng, ["AAPL", "MSFT", "VZ", "PG"].filter((s) => s !== base));
  } else {
    symbol = base;
    positionSymbol = base;
  }
  const freshQty = signedQty(rng);
  const staleQty = signedQty(rng);
  const price = pick(rng, PRICE_POOL);
  const readRoll = int(rng, 20);
  const read: ReadMode = readRoll < 14 ? "fresh" : readRoll < 17 ? "hint" : "fail";
  const side = pick(rng, ["buy", "sell", "short", "cover"] as const);
  const type = pick(rng, ["market", "limit", "stop_market", "stop_limit"] as const);
  const timeInForce = pick(rng, ["gfd", "gtc"] as const);
  const marketHours = pick(rng, ["regular_hours", "extended_hours"] as const);
  const clock = pick(rng, ["regular", "pre", "post"] as const);
  const useDollars = int(rng, 2) === 0;
  const heldAbs = Math.abs(freshQty);
  const mv = heldAbs * price;
  let quantity: number | undefined;
  let dollarAmount: number | undefined;
  if (useDollars) {
    const bias = int(rng, 5);
    if (bias === 0 && mv > 0) dollarAmount = mv;
    else if (bias === 1 && mv > 0) dollarAmount = mv * 0.5;
    else dollarAmount = pick(rng, [1.34, 10, 50, 500]);
    // Kody PRRT_kwDOS7mOVM62r3PH: ~1/5 of dollar cases also carry an explicit positive quantity.
    if (int(rng, 5) === 0) {
      if (int(rng, 5) < 2 && Math.abs(staleQty) > EPS) quantity = Math.abs(staleQty);
      else quantity = pick(rng, [1, 2, 4, 12, 50, 0.5, 1.5, 0.02778376]);
    }
  } else if (int(rng, 5) < 2 && Math.abs(staleQty) > EPS) {
    quantity = Math.abs(staleQty);
  } else {
    quantity = pick(rng, [1, 2, 4, 12, 50, 0.5, 1.5, 0.02778376]);
  }
  const limitPrice = type === "limit" || type === "stop_limit" || int(rng, 2) === 0 ? pick(rng, PRICE_POOL) : undefined;
  const stopPrice = type === "stop_market" || type === "stop_limit" || int(rng, 2) === 0 ? pick(rng, PRICE_POOL) : undefined;
  const withBracket = int(rng, 2) === 0;
  const generated: GenCase = {
    i,
    symbol,
    positionSymbol,
    freshQty,
    staleQty,
    price,
    marketValue: mv,
    read,
    side,
    type,
    timeInForce,
    marketHours,
    clock,
    quantity,
    dollarAmount,
    limitPrice,
    stopPrice,
    bracketTakeProfit: withBracket ? pick(rng, PRICE_POOL) : undefined,
    bracketStopLoss: withBracket ? pick(rng, PRICE_POOL) : undefined,
    bracketStopLimit: withBracket && int(rng, 2) === 0 ? pick(rng, PRICE_POOL) : undefined,
    refId: refFor(rng, i),
    shortSellingEnabled: int(rng, 2) === 0,
    accountCanShort: int(rng, 2) === 0
  };
  return forceCase(generated, i);
}

function forceCase(generated: GenCase, i: number): GenCase {
  if (i === 0) {
    const qty = 0.02778376;
    return {
      ...generated,
      symbol: "VZ",
      positionSymbol: "VZ",
      freshQty: qty,
      staleQty: 0.03,
      price: 48,
      marketValue: 1.3339,
      read: "fresh",
      side: "sell",
      type: "market",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: undefined,
      dollarAmount: 1.34,
      limitPrice: 48,
      stopPrice: 47,
      bracketTakeProfit: 55,
      bracketStopLoss: 40,
      bracketStopLimit: undefined,
      refId: "vz-full-exit-1",
      shortSellingEnabled: false,
      accountCanShort: false
    };
  }
  if (i === 1) {
    return {
      ...generated,
      symbol: "PG",
      positionSymbol: "PG",
      freshQty: 0,
      staleQty: 12,
      price: 150,
      marketValue: 0,
      read: "fresh",
      side: "sell",
      type: "market",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: 12,
      dollarAmount: undefined,
      limitPrice: undefined,
      stopPrice: undefined,
      bracketTakeProfit: undefined,
      bracketStopLoss: undefined,
      bracketStopLimit: undefined,
      refId: "pg-flat-sell",
      shortSellingEnabled: false,
      accountCanShort: false
    };
  }
  if (i === 2) {
    return {
      ...generated,
      symbol: "PG",
      positionSymbol: "PG",
      freshQty: -12,
      staleQty: -12,
      price: 149.75,
      marketValue: 1797,
      read: "fresh",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: 12,
      dollarAmount: undefined,
      limitPrice: 149.5,
      stopPrice: undefined,
      bracketTakeProfit: 140,
      bracketStopLoss: 160,
      bracketStopLimit: undefined,
      refId: "pg-buy-against-short",
      shortSellingEnabled: true,
      accountCanShort: true
    };
  }
  if (i === 3) {
    return {
      ...generated,
      symbol: "BRK.B",
      positionSymbol: "BRK-B",
      freshQty: 4,
      staleQty: 8,
      price: 400,
      marketValue: 1600,
      read: "fresh",
      side: "sell",
      type: "market",
      timeInForce: "gtc",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: 8,
      dollarAmount: undefined,
      limitPrice: 410,
      stopPrice: 390,
      bracketTakeProfit: 450,
      bracketStopLoss: 350,
      bracketStopLimit: undefined,
      refId: "brk-share-class",
      shortSellingEnabled: false,
      accountCanShort: false
    };
  }
  if (i === 4) {
    return {
      ...generated,
      symbol: "AAPL",
      positionSymbol: "AAPL",
      freshQty: 10,
      staleQty: 50,
      price: 100,
      marketValue: 1000,
      read: "fresh",
      side: "sell",
      type: "limit",
      timeInForce: "gtc",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: 50,
      dollarAmount: undefined,
      limitPrice: 10,
      stopPrice: undefined,
      bracketTakeProfit: undefined,
      bracketStopLoss: undefined,
      bracketStopLimit: undefined,
      refId: "aapl-stale-clamp",
      shortSellingEnabled: false,
      accountCanShort: true
    };
  }
  if (i === 5) {
    return {
      ...generated,
      symbol: "MSFT",
      positionSymbol: "MSFT",
      freshQty: 10,
      staleQty: 10,
      price: 100,
      marketValue: 1000,
      read: "fresh",
      side: "sell",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      clock: "regular",
      quantity: undefined,
      dollarAmount: 500,
      limitPrice: 10,
      stopPrice: undefined,
      bracketTakeProfit: undefined,
      bracketStopLoss: undefined,
      bracketStopLimit: undefined,
      refId: `partial.dollar_${i}`,
      shortSellingEnabled: false,
      accountCanShort: false
    };
  }
  return generated;
}

function emptyHits(): HitCounts {
  return {
    placed: 0,
    refused: 0,
    policyBlockedShort: 0,
    freshClamp: 0,
    fullDollar: 0,
    marketNoPrice: 0,
    closingNoBracket: 0,
    shortEntry: 0,
    shareClass: 0,
    staleSmaller: 0,
    readFailed: 0,
    dirtyTag: 0,
    extendedLimit: 0,
    exitBound: 0,
    mixedQtyWins: 0
  };
}

function seenBook(c: GenCase): { qty: number; mv: number; verified: boolean; shareClass: boolean } {
  const shareClass = canonicalSymbol(c.symbol) === canonicalSymbol(c.positionSymbol);
  if (c.read === "fail") return { qty: 0, mv: 0, verified: false, shareClass };
  if (c.read === "hint") return { qty: c.staleQty, mv: 0, verified: true, shareClass };
  if (!shareClass) return { qty: 0, mv: 0, verified: true, shareClass };
  return { qty: c.freshQty, mv: c.marketValue, verified: true, shareClass };
}

function orderFrom(c: GenCase, accountNumber: string): EquityOrderInput & { refId: string } {
  const order: EquityOrderInput & { refId: string } = {
    accountNumber,
    symbol: c.symbol,
    side: c.side,
    type: c.type,
    timeInForce: c.timeInForce,
    marketHours: c.marketHours,
    referencePrice: c.price,
    refId: c.refId
  };
  if (c.quantity != null) order.quantity = c.quantity;
  if (c.dollarAmount != null) order.dollarAmount = c.dollarAmount;
  if (c.limitPrice != null) order.limitPrice = c.limitPrice;
  if (c.stopPrice != null) order.stopPrice = c.stopPrice;
  if (c.bracketTakeProfit != null) order.bracketTakeProfit = c.bracketTakeProfit;
  if (c.bracketStopLoss != null) order.bracketStopLoss = c.bracketStopLoss;
  if (c.bracketStopLimit != null) order.bracketStopLimit = c.bracketStopLimit;
  if (c.read === "hint") order.verifiedPositionQuantity = c.staleQty;
  return order;
}

function policyAllowsShort(c: GenCase, broker: BrokerName): boolean {
  const policy: TradingPolicy = { ...DEFAULT_POLICY, shortSellingEnabled: c.shortSellingEnabled, activeBroker: broker };
  const sides = allowedProposalSides(policy, {
    id: "acct",
    broker,
    environment: "paper",
    accountNumber: broker === "alpaca" ? ALPACA_ACCOUNT : TRADIER_ACCOUNT,
    label: broker,
    capabilities: c.accountCanShort ? shortCapable : noShortCapable
  });
  return sides.includes("short");
}

function detail(c: GenCase, extra?: unknown): string {
  return `case ${c.i} seed 0x${SEED.toString(16)} ${JSON.stringify(c)}${extra != null ? ` payload ${JSON.stringify(extra)}` : ""}`;
}

function assertFinitePositive(value: number, label: string, c: GenCase, payload: unknown): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${label} must be a positive finite quantity (${value}). ${detail(c, payload)}`);
  }
}

function onAlpacaQtyGrid(value: number): boolean {
  const scaled = value * 1e9;
  return Math.abs(scaled - Math.round(scaled)) < 1e-3;
}

function priceOnIncrement(value: number, broker: BrokerName): boolean {
  if (!(value > 0) || !Number.isFinite(value)) return false;
  if (broker === "alpaca") return value === roundAlpacaPrice(value);
  return value === roundCents(value);
}

function sanitizedTag(refId: string): string {
  return refId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
}

interface PlaceResult {
  payload: Record<string, unknown> | null;
  error: unknown;
}

function installTradierFetch(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && u.includes("/orders")) {
      harness.state.posts.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ order: { id: 1, status: "ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (u.includes("/positions")) {
      if (harness.state.tradierFail) {
        return new Response("unavailable", { status: 503 });
      }
      const position = harness.state.tradierPositions;
      return new Response(
        JSON.stringify({
          positions: position.length === 0 ? "null" : { position: position.length === 1 ? position[0] : position }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/markets/quotes")) {
      if (harness.state.tradierQuoteFail) return new Response("unavailable", { status: 503 });
      const quote = harness.state.tradierQuotes;
      return new Response(
        JSON.stringify({ quotes: { quote: quote.length === 1 ? quote[0] : quote } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("", { status: 404 });
  });
}

function armBook(c: GenCase, broker: BrokerName): void {
  harness.state.posts = [];
  harness.state.tradierQuoteFail = false;
  harness.createOrder.mockClear();
  const flat = Math.abs(c.freshQty) <= EPS;
  if (broker === "alpaca") {
    harness.state.alpacaFail = c.read !== "fresh";
    harness.state.alpacaRows = flat
      ? []
      : [
          {
            symbol: c.positionSymbol,
            qty: String(c.freshQty),
            avg_entry_price: String(c.price),
            market_value: String(c.freshQty < 0 ? -c.marketValue : c.marketValue)
          }
        ];
    return;
  }
  harness.state.tradierFail = c.read !== "fresh";
  harness.state.tradierPositions = flat
    ? []
    : [
        {
          symbol: c.positionSymbol.includes("-") ? c.positionSymbol.replace(/-/g, ".") : c.positionSymbol,
          quantity: c.freshQty,
          cost_basis: c.marketValue
        }
      ];
  const quoteSymbol = (symbol: string) => symbol.trim().toUpperCase().replace(/-/g, ".");
  const px = c.marketValue > 0 && Math.abs(c.freshQty) > EPS ? c.marketValue / Math.abs(c.freshQty) : c.price;
  harness.state.tradierQuotes = [
    { symbol: quoteSymbol(c.positionSymbol), last: px },
    { symbol: quoteSymbol(c.symbol), last: c.price }
  ];
}

function formRecord(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function numbered(form: Record<string, string>, name: string): number[] {
  const values: number[] = [];
  if (form[name] != null && form[name] !== "") values.push(Number(form[name]));
  for (const [key, value] of Object.entries(form)) {
    if (new RegExp(`^${name}\\[\\d+\\]$`).test(key)) values.push(Number(value));
  }
  return values;
}

function assertAlpacaTif(c: GenCase, payload: Record<string, unknown>): void {
  const tif = String(payload.time_in_force);
  if (tif !== "day" && tif !== "gtc") {
    throw new Error(`Alpaca time_in_force must be day or gtc, got ${tif}. ${detail(c, payload)}`);
  }
  const qty = payload.qty != null ? Number(payload.qty) : undefined;
  const fractional = qty != null && !Number.isInteger(qty);
  const notional = payload.notional != null;
  const bracket = payload.order_class === "bracket";
  const extended = payload.extended_hours === true;
  if (c.timeInForce === "gfd" || fractional || notional || bracket || extended) {
    if (tif !== "day") throw new Error(`Alpaca TIF should be day. ${detail(c, payload)}`);
  } else if (c.timeInForce === "gtc" && tif !== "gtc") {
    throw new Error(`Whole-share regular GTC should stay gtc. ${detail(c, payload)}`);
  }
}

/** Same windows as tradierExtendedHoursDuration. That helper reads the wall clock, not the sandbox clock the generator freezes. */
function wallClockExtendedSession(now = new Date()): "pre" | "post" | undefined {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes >= 7 * 60 && totalMinutes < 9 * 60 + 24) return "pre";
  if (totalMinutes >= 16 * 60 && totalMinutes < 19 * 60 + 55) return "post";
  return undefined;
}

function assertTradierDuration(c: GenCase, form: Record<string, string>): void {
  const duration = form.duration;
  if (duration !== "day" && duration !== "gtc" && duration !== "pre" && duration !== "post") {
    throw new Error(`Tradier duration ${duration} is not a broker value. ${detail(c, form)}`);
  }
  if (c.timeInForce === "gfd" && duration === "gtc") {
    throw new Error(`gfd must not become gtc. ${detail(c, form)}`);
  }
  const extendedLimit = c.marketHours === "extended_hours" && c.type === "limit";
  if (!extendedLimit && c.timeInForce === "gtc" && duration !== "gtc") {
    throw new Error(`Tradier gtc should stay gtc off an extended limit. ${detail(c, form)}`);
  }
  if (extendedLimit) {
    const expected = wallClockExtendedSession() ?? "day";
    if (duration !== expected) {
      throw new Error(`Extended limit duration should be ${expected}. ${detail(c, form)}`);
    }
  }
  if ((duration === "pre" || duration === "post") && form.type !== "limit" && !form["type[0]"]) {
    throw new Error(`pre/post duration is only valid on a limit. ${detail(c, form)}`);
  }
}

function increasesShort(broker: BrokerName, held: number, wireSide: string, qty: number | undefined): boolean {
  if (wireSide === "sell_short") return true;
  if (broker === "alpaca" && wireSide === "sell" && held <= EPS) return true;
  if (wireSide === "sell" && qty != null && held > EPS && qty > held + 1e-6) return true;
  return false;
}

/** Requested positive quantity for a mixed dollar exit, clamped to the held position. */
function mixedExitClampedQty(c: GenCase, heldLong: number, heldShort: number): number | undefined {
  if (c.dollarAmount == null || !(c.dollarAmount > 0) || c.quantity == null || !(c.quantity > 0)) return undefined;
  if (c.side === "sell" && heldLong > 0) return Math.min(c.quantity, heldLong);
  if (c.side === "cover" && heldShort > 0) return Math.min(c.quantity, heldShort);
  if (c.side === "buy" && heldShort > 0 && c.quantity <= heldShort + 1e-6) return Math.min(c.quantity, heldShort);
  return undefined;
}

function assertPayload(broker: BrokerName, c: GenCase, payload: Record<string, unknown>, hits: HitCounts): void {
  const book = seenBook(c);
  const hadBrackets = c.bracketTakeProfit != null || c.bracketStopLoss != null || c.bracketStopLimit != null;
  if (c.read === "fail") hits.readFailed += 1;
  if (c.read === "fresh" && Math.abs(c.staleQty) > Math.abs(c.freshQty) + EPS && c.quantity != null && c.quantity > Math.abs(c.freshQty) + EPS) {
    hits.staleSmaller += 1;
  }
  if (book.shareClass && canonicalSymbol(c.symbol).startsWith("BRK")) hits.shareClass += 1;

  if (broker === "alpaca") {
    const symbol = String(payload.symbol);
    const expectedSymbol = c.symbol.trim().toUpperCase().replace(/-/g, ".");
    if (symbol !== expectedSymbol) throw new Error(`Alpaca symbol ${symbol} !== ${expectedSymbol}. ${detail(c, payload)}`);
    if (payload.client_order_id !== c.refId) {
      throw new Error(`Alpaca client_order_id must be the refId. ${detail(c, payload)}`);
    }
    const wireSide = String(payload.side);
    if (wireSide !== "buy" && wireSide !== "sell") {
      throw new Error(`Alpaca side ${wireSide} is not buy or sell. ${detail(c, payload)}`);
    }
    const qty = payload.qty != null ? Number(payload.qty) : undefined;
    const notional = payload.notional != null ? Number(payload.notional) : undefined;
    if (qty == null && notional == null) throw new Error(`Alpaca order has no size. ${detail(c, payload)}`);
    if (qty != null) {
      assertFinitePositive(qty, "Alpaca qty", c, payload);
      if (!onAlpacaQtyGrid(qty)) throw new Error(`Alpaca qty is off the 1e-9 grid. ${detail(c, payload)}`);
    }
    if (notional != null) assertFinitePositive(notional, "Alpaca notional", c, payload);
    for (const key of ["limit_price", "stop_price"] as const) {
      if (payload[key] != null && !priceOnIncrement(Number(payload[key]), "alpaca")) {
        throw new Error(`Alpaca ${key} is off increment. ${detail(c, payload)}`);
      }
    }
    const takeProfit = payload.take_profit as { limit_price?: number } | undefined;
    const stopLoss = payload.stop_loss as { stop_price?: number; limit_price?: number } | undefined;
    if (takeProfit?.limit_price != null && !priceOnIncrement(takeProfit.limit_price, "alpaca")) {
      throw new Error(`Alpaca take_profit is off increment. ${detail(c, payload)}`);
    }
    if (stopLoss?.stop_price != null && !priceOnIncrement(stopLoss.stop_price, "alpaca")) {
      throw new Error(`Alpaca stop_loss is off increment. ${detail(c, payload)}`);
    }
    if (payload.type === "market" || payload.type === "trailing_stop") {
      hits.marketNoPrice += 1;
      if (payload.limit_price != null || payload.stop_price != null) {
        throw new Error(`Market order carries a price. ${detail(c, payload)}`);
      }
    }
    if (payload.type === "limit" && payload.stop_price != null) {
      throw new Error(`Limit order carries a stop price. ${detail(c, payload)}`);
    }
    if (payload.type === "stop" && payload.limit_price != null) {
      throw new Error(`Stop order carries a limit price. ${detail(c, payload)}`);
    }
    assertAlpacaTif(c, payload);
    if (c.read === "fail") {
      if (c.side === "sell" || c.side === "cover") {
        throw new Error(`Alpaca sent an unverified ${c.side}. ${detail(c, payload)}`);
      }
      return;
    }
    const held = book.qty;
    if (increasesShort("alpaca", held, wireSide, qty)) {
      if (c.side !== "short" || !policyAllowsShort(c, broker)) {
        throw new Error(`Payload opens or increases a short. ${detail(c, payload)}`);
      }
      hits.shortEntry += 1;
    }
    const heldLong = held > EPS ? held : 0;
    const heldShort = held < -EPS ? -held : 0;
    // An explicit short is an entry even when the Alpaca wire side is "sell".
    const closingLong = c.side === "sell" && wireSide === "sell" && heldLong > 0 && (qty == null || qty <= heldLong + 1e-6);
    const closingShort =
      (c.side === "cover" || c.side === "buy") &&
      wireSide === "buy" &&
      heldShort > 0 &&
      qty != null &&
      qty <= heldShort + 1e-6;
    if (closingLong || closingShort) {
      if (payload.order_class != null || takeProfit != null || stopLoss != null) {
        throw new Error(`Closing order carries bracket legs. ${detail(c, payload)}`);
      }
      if (hadBrackets) hits.closingNoBracket += 1;
    }
    // Quantity-independent exit predicates for the size bound. closingLong/closingShort above
    // already require qty <= held, so a bound written against them could never fire.
    const exitLong = c.side === "sell" && wireSide === "sell" && heldLong > 0;
    const exitShort = c.side === "cover" && wireSide === "buy" && heldShort > 0;
    if ((exitLong || exitShort) && qty != null) hits.exitBound += 1;
    if (exitLong && qty != null && qty > heldLong + 1e-6) {
      throw new Error(`Exit qty ${qty} exceeds held long ${heldLong}. ${detail(c, payload)}`);
    }
    if (exitShort && qty != null && qty > heldShort + 1e-6) {
      throw new Error(`Cover qty ${qty} exceeds held short ${heldShort}. ${detail(c, payload)}`);
    }
    if (book.verified && c.side === "sell" && heldLong <= 0) {
      throw new Error(`Verified sell of a flat or short book was sent. ${detail(c, payload)}`);
    }
    const qtyWins = c.quantity != null && c.quantity > 0;
    const fullDollar =
      !qtyWins &&
      c.dollarAmount != null &&
      book.mv > 0 &&
      c.dollarAmount >= book.mv * 0.98 &&
      (c.side === "sell" || c.side === "cover" || (c.side === "buy" && heldShort > 0 && c.dollarAmount <= book.mv * 1.02));
    if (fullDollar && (closingLong || closingShort || (c.side === "sell" && heldLong > 0))) {
      hits.fullDollar += 1;
      if (notional != null || qty == null) throw new Error(`Dollar full exit stayed notional. ${detail(c, payload)}`);
      const target = closingShort ? heldShort : heldLong;
      if (Math.abs(qty - target) > 1e-8) {
        throw new Error(`Dollar full exit qty ${qty} !== held ${target}. ${detail(c, payload)}`);
      }
    }
    if (c.read === "fresh" && c.quantity != null && c.quantity > heldLong + 1e-6 && closingLong && heldLong > 0) {
      hits.freshClamp += 1;
      if (Math.abs(qty! - heldLong) > 1e-8) {
        throw new Error(`Fresh clamp should be the held long, got ${qty}. ${detail(c, payload)}`);
      }
    }
    const mixedExitQty = mixedExitClampedQty(c, heldLong, heldShort);
    if (mixedExitQty != null) {
      hits.mixedQtyWins += 1;
      if (notional != null) throw new Error(`Mixed qty-wins exit still carried a notional. ${detail(c, payload)}`);
      if (qty == null || Math.abs(qty - mixedExitQty) > 1e-8) {
        throw new Error(`Mixed qty-wins exit qty ${qty} !== clamped ${mixedExitQty}. ${detail(c, payload)}`);
      }
    }
    return;
  }

  if (broker === "tradier") {
    const form = payload as Record<string, string>;
    const tag = form.tag;
    if (!/^[A-Za-z0-9-]{1,255}$/.test(tag ?? "")) {
      throw new Error(`Tradier tag is outside [A-Za-z0-9-]{1,255}. ${detail(c, form)}`);
    }
    if (tag !== sanitizedTag(c.refId)) throw new Error(`Tradier tag is not the sanitized refId. ${detail(c, form)}`);
    if (/^[A-Za-z0-9-]{1,255}$/.test(c.refId) && tag !== c.refId) {
      throw new Error(`Charset-safe refId did not round-trip. ${detail(c, form)}`);
    }
    if (!/^[A-Za-z0-9-]{1,255}$/.test(c.refId)) hits.dirtyTag += 1;
    const entrySymbol = form.symbol ?? form["symbol[0]"];
    const expectedSymbol = c.symbol.trim().toUpperCase().replace(/-/g, ".");
    if (entrySymbol !== expectedSymbol) {
      throw new Error(`Tradier symbol ${entrySymbol} !== ${expectedSymbol}. ${detail(c, form)}`);
    }
    const entrySide = form.side ?? form["side[0]"] ?? "";
    const entryType = form.type ?? form["type[0]"] ?? "";
    const qtys = numbered(form, "quantity");
    if (qtys.length === 0) throw new Error(`Tradier order has no quantity. ${detail(c, form)}`);
    for (const qty of qtys) {
      assertFinitePositive(qty, "Tradier quantity", c, form);
      if (!Number.isInteger(qty)) throw new Error(`Tradier quantity ${qty} is not a whole share. ${detail(c, form)}`);
    }
    const qty = qtys[0]!;
    for (const key of Object.keys(form)) {
      if (key === "price" || key === "stop" || /^price\[\d+\]$/.test(key) || /^stop\[\d+\]$/.test(key)) {
        if (!priceOnIncrement(Number(form[key]), "tradier")) {
          throw new Error(`Tradier ${key} is off the cent grid. ${detail(c, form)}`);
        }
      }
    }
    if (entryType === "market") {
      hits.marketNoPrice += 1;
      if (form.price != null || form.stop != null || form["price[0]"] != null || form["stop[0]"] != null) {
        throw new Error(`Tradier market order carries a price. ${detail(c, form)}`);
      }
    }
    assertTradierDuration(c, form);
    if (c.marketHours === "extended_hours" && c.type === "limit") hits.extendedLimit += 1;
    const orderClass = form.class;
    if (orderClass !== "equity" && orderClass !== "oto" && orderClass !== "otoco") {
      throw new Error(`Tradier class ${orderClass} is unexpected. ${detail(c, form)}`);
    }
    if (c.read === "fail") {
      if (entrySide === "sell_short" && c.side !== "short") {
        throw new Error(`Unverified pass-through invented a short. ${detail(c, form)}`);
      }
      return;
    }
    const held = book.qty;
    if (increasesShort("tradier", held, entrySide, qty)) {
      if (c.side !== "short" || !policyAllowsShort(c, broker)) {
        throw new Error(`Payload opens or increases a short. ${detail(c, form)}`);
      }
      hits.shortEntry += 1;
    }
    const heldLong = held > EPS ? held : 0;
    const heldShort = held < -EPS ? -held : 0;
    const closingLong = c.side === "sell" && entrySide === "sell" && heldLong > 0;
    const closingShort = (c.side === "cover" || c.side === "buy") && entrySide === "buy_to_cover" && heldShort > 0;
    if (closingLong && qty > heldLong + 1e-6) {
      throw new Error(`Exit qty ${qty} exceeds held long ${heldLong}. ${detail(c, form)}`);
    }
    if (closingShort && qty > heldShort + 1e-6) {
      throw new Error(`Cover qty ${qty} exceeds held short ${heldShort}. ${detail(c, form)}`);
    }
    if ((closingLong || closingShort) && orderClass !== "equity") {
      throw new Error(`Closing order carries ${orderClass} legs. ${detail(c, form)}`);
    }
    if ((closingLong || closingShort) && hadBrackets) hits.closingNoBracket += 1;
    if (book.verified && c.side === "sell" && held <= EPS) {
      throw new Error(`Verified sell of a flat or short book was sent. ${detail(c, form)}`);
    }
    if (book.verified && c.side === "cover" && heldShort <= 0) {
      throw new Error(`Verified cover without a short was sent. ${detail(c, form)}`);
    }
    const qtyWins = c.quantity != null && c.quantity > 0;
    const fullDollar =
      !qtyWins && c.dollarAmount != null && book.mv > 0 && c.dollarAmount >= book.mv * 0.98 && (closingLong || closingShort);
    if (fullDollar && Number.isInteger(closingLong ? heldLong : heldShort)) {
      hits.fullDollar += 1;
      const target = closingShort ? heldShort : heldLong;
      if (qty !== target) throw new Error(`Dollar full exit qty ${qty} !== held ${target}. ${detail(c, form)}`);
    }
    if (c.read === "fresh" && c.quantity != null && heldLong > 0 && c.quantity > heldLong + 1e-6 && closingLong) {
      hits.freshClamp += 1;
    }
    const mixedExitQty = mixedExitClampedQty(c, heldLong, heldShort);
    if (mixedExitQty != null) {
      hits.mixedQtyWins += 1;
      if (form.notional != null || form.dollarAmount != null || form.amount != null) {
        throw new Error(`Mixed qty-wins exit still carried a dollar size. ${detail(c, form)}`);
      }
      // Tradier only accepts whole shares and floors a fractional clamped qty.
      const expected = Number.isInteger(mixedExitQty) ? mixedExitQty : Math.floor(mixedExitQty);
      if (Math.abs(qty - expected) > 1e-8) {
        throw new Error(`Mixed qty-wins exit qty ${qty} !== clamped ${expected}. ${detail(c, form)}`);
      }
    }
    return;
  }

  const unexpected: never = broker;
  throw new Error(`Unknown broker ${String(unexpected)}`);
}

function assertRefusal(broker: BrokerName, c: GenCase, error: unknown): void {
  if (error instanceof OrderValidationError) return;
  const message = error instanceof Error ? error.message : String(error);
  if (/too small for a whole share|cannot size a dollar order|bracket dollar|extended-hours orders must be limit|trailing stop/i.test(message)) {
    return;
  }
  throw new Error(`Unexpected ${broker} refusal: ${message}. ${detail(c)}`);
}

function assertMatchedExitNotFlatRefusal(c: GenCase, error: unknown): void {
  const book = seenBook(c);
  if (c.read !== "fresh" || !book.shareClass) return;
  const message = error instanceof Error ? error.message : String(error);
  if (c.side === "sell" && c.freshQty > EPS && /would open a SHORT/i.test(message)) {
    throw new Error(`Share-class sell was treated as flat. ${detail(c)} ${message}`);
  }
  if (c.side === "cover" && c.freshQty < -EPS && /would open a LONG/i.test(message)) {
    throw new Error(`Share-class cover was treated as flat. ${detail(c)} ${message}`);
  }
}

describe("money-path order invariant properties", () => {
  let placeAlpaca: (input: EquityOrderInput & { refId: string }) => Promise<unknown>;
  let placeTradier: (input: EquityOrderInput & { refId: string }) => Promise<unknown>;
  let tradierNow: Date = CLOCKS.regular;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-invariant-props-${randomUUID()}.db`)}`);
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const { getBrokerGateway } = await import("../src/lib/broker");
    const { setTradierNowForTests } = await import("../src/lib/tradier-transient");
    setTradierNowForTests(() => tradierNow);
    upsertConnectedAccount({
      id: "acct-alpaca-props",
      userId: "alpaca-props",
      broker: "alpaca",
      environment: "paper",
      accountNumber: ALPACA_ACCOUNT,
      label: "Alpaca Paper",
      apiKey: "PKPROPKEY",
      apiSecret: "alpaca-secret",
      isActive: true
    });
    upsertConnectedAccount({
      id: "acct-tradier-props",
      userId: "tradier-props",
      broker: "tradier",
      environment: "paper",
      accountNumber: TRADIER_ACCOUNT,
      label: "Tradier Sandbox",
      apiKey: "tradier-token",
      isActive: true
    });
    installTradierFetch();
    const alpacaPolicy: TradingPolicy = {
      ...DEFAULT_POLICY,
      activeBroker: "alpaca",
      accountNumber: ALPACA_ACCOUNT,
      connectedAccountId: "acct-alpaca-props"
    };
    const tradierPolicy: TradingPolicy = {
      ...DEFAULT_POLICY,
      activeBroker: "tradier",
      accountNumber: TRADIER_ACCOUNT,
      connectedAccountId: "acct-tradier-props"
    };
    const alpaca = getBrokerGateway(alpacaPolicy, "alpaca-props");
    const tradier = getBrokerGateway(tradierPolicy, "tradier-props");
    placeAlpaca = (input) => alpaca.placeEquityOrder(input);
    placeTradier = (input) => tradier.placeEquityOrder(input);
  }, 120_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function runBroker(broker: BrokerName): Promise<HitCounts> {
    const hits = emptyHits();
    const rng = mulberry32(SEED);
    const place = broker === "alpaca" ? placeAlpaca : placeTradier;
    const accountNumber = broker === "alpaca" ? ALPACA_ACCOUNT : TRADIER_ACCOUNT;
    for (let i = 0; i < CASES; i += 1) {
      const generated = generateCase(rng, i);
      if (ONLY != null && generated.i !== ONLY) continue;
      if (generated.side === "short" && !policyAllowsShort(generated, broker)) {
        hits.policyBlockedShort += 1;
        continue;
      }
      armBook(generated, broker);
      tradierNow = CLOCKS[generated.clock];
      const beforePosts = harness.state.posts.length;
      const beforeOrders = harness.createOrder.mock.calls.length;
      let result: PlaceResult;
      try {
        await place(orderFrom(generated, accountNumber));
        result = { payload: null, error: null };
      } catch (error) {
        result = { payload: null, error };
      }
      const alpacaSent = harness.createOrder.mock.calls.length > beforeOrders;
      const tradierSent = harness.state.posts.length > beforePosts;
      const sent = broker === "alpaca" ? alpacaSent : tradierSent;
      if (result.error && sent) {
        throw new Error(`Broker was contacted and then threw. ${detail(generated, result.error)}`);
      }
      if (!sent) {
        hits.refused += 1;
        assertRefusal(broker, generated, result.error);
        assertMatchedExitNotFlatRefusal(generated, result.error);
        continue;
      }
      hits.placed += 1;
      const payload =
        broker === "alpaca"
          ? (harness.createOrder.mock.calls.at(-1)?.[0] as Record<string, unknown>)
          : formRecord(harness.state.posts.at(-1) ?? "");
      assertPayload(broker, generated, payload, hits);
    }
    return hits;
  }

  it("Alpaca payloads hold the money-path invariants (seed 0x4616)", async () => {
    const hits = await runBroker("alpaca");
    expect(hits.placed).toBeGreaterThan(100);
    expect(hits.policyBlockedShort).toBeGreaterThan(20);
    expect(hits.fullDollar).toBeGreaterThan(0);
    expect(hits.closingNoBracket).toBeGreaterThan(0);
    expect(hits.marketNoPrice).toBeGreaterThan(0);
    expect(hits.freshClamp).toBeGreaterThan(0);
    expect(hits.shareClass).toBeGreaterThan(0);
    expect(hits.shortEntry + hits.policyBlockedShort).toBeGreaterThan(0);
    expect(hits.exitBound).toBeGreaterThan(0);
    expect(hits.mixedQtyWins).toBeGreaterThan(0);
  }, 180_000);

  it("Tradier payloads hold the money-path invariants (seed 0x4616)", async () => {
    const hits = await runBroker("tradier");
    expect(hits.placed).toBeGreaterThan(100);
    expect(hits.policyBlockedShort).toBeGreaterThan(20);
    expect(hits.closingNoBracket).toBeGreaterThan(0);
    expect(hits.marketNoPrice).toBeGreaterThan(0);
    expect(hits.dirtyTag).toBeGreaterThan(0);
    expect(hits.extendedLimit).toBeGreaterThan(0);
    expect(hits.shareClass).toBeGreaterThan(0);
    expect(hits.freshClamp).toBeGreaterThan(0);
    expect(hits.mixedQtyWins).toBeGreaterThan(0);
  }, 180_000);

  it("BRK.B and BRK-B are the same long", () => {
    const held = heldPositionFor(
      [{ symbol: "BRK-B", quantity: 4, averageCost: 400, marketValue: 1600 }],
      "BRK.B"
    );
    expect(held.signedQuantity).toBe(4);
    const { input } = applyPositionInvariant(
      {
        accountNumber: ALPACA_ACCOUNT,
        symbol: "BRK.B",
        side: "sell",
        type: "market",
        quantity: 8,
        timeInForce: "gfd",
        marketHours: "regular_hours"
      },
      held
    );
    expect(input.quantity).toBe(4);
  });

  it("Tradier partial dollar limit sell stays within the held shares", async () => {
    const generated = forceCase(generateCase(mulberry32(SEED), 5), 5);
    armBook(generated, "tradier");
    tradierNow = CLOCKS.regular;
    await placeTradier(orderFrom(generated, TRADIER_ACCOUNT));
    const form = new URLSearchParams(harness.state.posts.at(-1) ?? "");
    const qty = Number(form.get("quantity"));
    expect(form.get("side")).toBe("sell");
    expect(qty).toBeGreaterThan(0);
    expect(qty).toBeLessThanOrEqual(10);
    expect(qty).toBe(5);
  });

  it("Tradier dollar sell on a quantity-only hint does not exceed that quantity", async () => {
    const generated: GenCase = {
      i: 32,
      symbol: "MSFT",
      positionSymbol: "MSFT",
      freshQty: -50,
      staleQty: 10,
      price: 0.42,
      marketValue: 21,
      read: "hint",
      side: "sell",
      type: "stop_market",
      timeInForce: "gtc",
      marketHours: "regular_hours",
      clock: "regular",
      dollarAmount: 10.5,
      limitPrice: 149.5,
      stopPrice: 48,
      refId: "hint-dollar-sell",
      shortSellingEnabled: false,
      accountCanShort: true
    };
    armBook(generated, "tradier");
    tradierNow = CLOCKS.regular;
    const error = await placeTradier(orderFrom(generated, TRADIER_ACCOUNT)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OrderPositionInvariantError);
    // The hint exists because the broker read FAILED: retryable, not a terminal block.
    expect((error as OrderPositionInvariantError).code).toBe("position_unverified");
    expect(isRetryablePositionInvariantError(error)).toBe(true);
    expect(harness.state.posts).toHaveLength(0);
  });

  it("Tradier dollar exits are refused (retryable) when the quote batch fails, never sized from cost basis", async () => {
    // Live $100/share x 10 = $1000; entry cost basis is only $200. Sized from cost basis, a $500
    // partial sell reads as a FULL exit and would sell all 10 shares.
    for (const dollarAmount of [500, 1000]) {
      const generated = { ...forceCase(generateCase(mulberry32(SEED), 5), 5), dollarAmount, refId: `quote-fail-${dollarAmount}` };
      armBook(generated, "tradier");
      harness.state.tradierPositions = [{ symbol: "MSFT", quantity: 10, cost_basis: 200 }];
      harness.state.tradierQuoteFail = true;
      tradierNow = CLOCKS.regular;
      const error = await placeTradier(orderFrom(generated, TRADIER_ACCOUNT)).catch((err: unknown) => err);
      expect(harness.state.posts, `$${dollarAmount}`).toHaveLength(0);
      expect(error, `$${dollarAmount}`).toBeInstanceOf(OrderPositionInvariantError);
      expect((error as OrderPositionInvariantError).code).toBe("position_unverified");
      expect(isRetryablePositionInvariantError(error)).toBe(true);
    }
    // Control: the same order with quotes up is placed as a capped partial (5 shares).
    const generated = forceCase(generateCase(mulberry32(SEED), 5), 5);
    armBook(generated, "tradier");
    harness.state.tradierPositions = [{ symbol: "MSFT", quantity: 10, cost_basis: 200 }];
    tradierNow = CLOCKS.regular;
    await placeTradier(orderFrom(generated, TRADIER_ACCOUNT));
    expect(Number(new URLSearchParams(harness.state.posts.at(-1) ?? "").get("quantity"))).toBe(5);
  });

  it("a cost-basis position value never sizes a Tradier dollar exit; quantity exits and Alpaca are unchanged", () => {
    const held = heldPositionFor(
      [{ symbol: "MSFT", quantity: 10, averageCost: 20, marketValue: 200, marketValueSource: "cost_basis" }],
      "MSFT"
    );
    expect(held.marketValuePriced).toBe(false);
    const order: EquityOrderInput = {
      accountNumber: TRADIER_ACCOUNT,
      symbol: "MSFT",
      side: "sell",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    };
    let thrown: unknown;
    try {
      applyPositionInvariant(order, held, { resolvePartialDollarExits: true });
    } catch (error) {
      thrown = error;
    }
    expect(isRetryablePositionInvariantError(thrown)).toBe(true);
    // A quantity exit does not use the value, so it still clamps to the held shares.
    const { dollarAmount: _d, ...qtyOrder } = order;
    void _d;
    expect(applyPositionInvariant({ ...qtyOrder, quantity: 12 }, held, { resolvePartialDollarExits: true }).input.quantity).toBe(10);
    // The refusal does not depend on the Tradier option: the full-exit check reads the value too.
    expect(() => applyPositionInvariant(order, held)).toThrow(OrderPositionInvariantError);
    expect(heldPositionFor([{ symbol: "MSFT", quantity: 10, averageCost: 20, marketValue: 1000 }], "MSFT").marketValuePriced).toBeUndefined();
  });

  // Kody PRRT_kwDOS7mOVM62mTCa: a $20-basis short with a $100 market. Sized from cost basis, a
  // $100 buy-to-cover resolves to 5 shares and spends about $500.
  const unpricedShort = [
    { symbol: "MSFT", quantity: -10, averageCost: 20, marketValue: -200, marketValueSource: "cost_basis" as const }
  ];
  const pricedShort = [{ symbol: "MSFT", quantity: -10, averageCost: 20, marketValue: -1000, marketValueSource: "quote" as const }];
  function exitProposal(patch: Partial<TradeProposal>): TradeProposal {
    return {
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Close the MSFT short.",
      confidenceScore: 0.6,
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "neutral",
      ...patch
    } as TradeProposal;
  }

  it("a dollar buy against a cost-basis short is refused as retryable, never sized from cost basis", () => {
    const order: EquityOrderInput = {
      accountNumber: TRADIER_ACCOUNT,
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    };
    for (const options of [undefined, { resolvePartialDollarExits: true }]) {
      let thrown: unknown;
      try {
        applyPositionInvariant(order, heldPositionFor(unpricedShort, "MSFT"), options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OrderPositionInvariantError);
      expect((thrown as OrderPositionInvariantError).code).toBe("position_unverified");
      expect(isRetryablePositionInvariantError(thrown)).toBe(true);
    }
    // Control: priced at $100/share, the same $100 buy is a 1-share cover.
    const priced = applyPositionInvariant(order, heldPositionFor(pricedShort, "MSFT"), { resolvePartialDollarExits: true });
    expect(priced.input).toMatchObject({ side: "cover", quantity: 1 });
    expect(priced.input.dollarAmount).toBeUndefined();
  });

  function refusalOf(order: EquityOrderInput, held = heldPositionFor(unpricedShort, "MSFT")): unknown {
    try {
      applyPositionInvariant(order, held, { resolvePartialDollarExits: true });
    } catch (error) {
      return error;
    }
    return undefined;
  }
  const asOrder = (proposal: TradeProposal): EquityOrderInput => ({ ...proposal, accountNumber: TRADIER_ACCOUNT }) as EquityOrderInput;

  // Kody PRRT_kwDOS7mOVM62oAwY / -oA5v / -oBH3: an unpriced dollar order against a short is never
  // rewritten (no side flip, no leg strip, no kept quantity, so nothing unaudited), it is refused.
  it("side normalization never rewrites a dollar order against a cost-basis short; the choke point refuses it as retryable", () => {
    expect(heldPositionFor(unpricedShort, "MSFT").marketValuePriced).toBe(false);
    const cases: Array<[Partial<TradeProposal>, { convertSellToCover?: boolean }]> = [
      [{}, {}],
      [{ dollarAmount: 5000 }, {}], // oversized: an opening/reversal, not a cover
      [{ dollarAmount: 100, quantity: 0 }, {}], // a zero quantity does not make it a share order
      [{ bracketStopLoss: 140, bracketTakeProfit: 80 }, {}],
      [{ side: "sell" }, { convertSellToCover: true }]
    ];
    for (const [patch, options] of cases) {
      const proposal = exitProposal(patch);
      const label = JSON.stringify(patch);
      const result = normalizeExitSideForHeldPosition(proposal, unpricedShort, options);
      expect(result.proposal, label).toBe(proposal);
      expect(result.change, label).toBeUndefined();
    }
    // At the choke point every dollar BUY (any size, zero or negative quantity too) is refused as retryable.
    for (const patch of [{}, { dollarAmount: 5000 }, { quantity: 0 }, { quantity: -3 }]) {
      const error = refusalOf(asOrder(exitProposal(patch)));
      expect(error, JSON.stringify(patch)).toBeInstanceOf(OrderPositionInvariantError);
      expect((error as OrderPositionInvariantError).code, JSON.stringify(patch)).toBe("position_unverified");
    }
    // A dollar COVER with a zero quantity is still a dollar order: refused, not passed to the adapter.
    expect(isRetryablePositionInvariantError(refusalOf(asOrder(exitProposal({ side: "cover", quantity: 0 }))))).toBe(true);
    // Priced controls: the old paths are unchanged. A fitting dollar buy normalizes to a capped
    // cover, an oversized one is left a buy, and placement never covers more than the short.
    expect(normalizeExitSideForHeldPosition(exitProposal({}), pricedShort).proposal).toMatchObject({ side: "cover", quantity: 1 });
    const oversized = exitProposal({ dollarAmount: 5000 });
    expect(normalizeExitSideForHeldPosition(oversized, pricedShort).proposal).toBe(oversized);
    expect(
      applyPositionInvariant(asOrder(exitProposal({ side: "cover", dollarAmount: 5000 })), heldPositionFor(pricedShort, "MSFT"), {
        resolvePartialDollarExits: true
      }).input
    ).toMatchObject({ side: "cover", quantity: 10 });
    // Quantity proposals do not read the value and still normalize.
    expect(normalizeExitSideForHeldPosition(exitProposal({ dollarAmount: undefined, quantity: 4 }), unpricedShort).proposal).toMatchObject({
      side: "cover",
      quantity: 4
    });
  });

  // Kody PRRT_kwDOS7mOVM62oBQz: only a sell that could still become a cover waits for quotes.
  it("a dollar sell of an unpriced short keeps the terminal sell_against_short unless it is a long-only market exit", () => {
    const sell = exitProposal({ side: "sell" });
    // At the choke point a sell never becomes a cover: terminal, priced or not.
    for (const fixture of [unpricedShort, pricedShort]) {
      const error = refusalOf(asOrder(sell), heldPositionFor(fixture, "MSFT"));
      expect(error).toBeInstanceOf(OrderPositionInvariantError);
      expect((error as OrderPositionInvariantError).code).toBe("sell_against_short");
    }
    const context = { userId: "tradier-props", connectedAccountId: "acct-tradier-props", lane: "autopilot" as const };
    // Long-only market dollar sell: held back before normalization (retryable next run).
    expect(holdUnpricedShortDollarProposals([sell], unpricedShort, context, { convertSellToCover: true })).toEqual([]);
    // A limit sell, or any sell on a venue that allows shorting, can never become a cover: kept,
    // so the choke point refuses it with the terminal verb.
    const limitSell = exitProposal({ side: "sell", type: "limit", limitPrice: 99 });
    expect(holdUnpricedShortDollarProposals([limitSell], unpricedShort, context, { convertSellToCover: true })).toEqual([limitSell]);
    expect(holdUnpricedShortDollarProposals([sell], unpricedShort, context, { convertSellToCover: false })).toEqual([sell]);
    // Priced control: nothing is held.
    expect(holdUnpricedShortDollarProposals([sell], pricedShort, context, { convertSellToCover: true })).toEqual([sell]);
  });

  it("the autopilot holds unpriced dollar buys and covers against a short before sizing and audits each as position_unverified", async () => {
    const db = await import("../src/lib/db");
    // Kody PRRT_kwDOS7mOVM62pDYL: rows and payloads are parsed at the SQLite/JSON boundary.
    const audits = () =>
      db
        .getDb()
        .prepare("SELECT payload FROM audit_events WHERE kind = ?")
        .all("proposal_position_unverified")
        .map((row) => AuditPayloadSchema.parse(JSON.parse(AuditEventRowSchema.parse(row).payload)));
    const before = audits().length;
    const context = { userId: "tradier-props", connectedAccountId: "acct-tradier-props", lane: "autopilot" as const, runId: "run-4616" };
    const buy = exitProposal({ dollarAmount: 5000 });
    // Kody PRRT_kwDOS7mOVM62pDTK: an explicit dollar cover is held too.
    const cover = exitProposal({ side: "cover", dollarAmount: 300 });
    const qtyBuy = exitProposal({ dollarAmount: undefined, quantity: 4 });
    const other = exitProposal({ symbol: "AAPL" });
    // Kody PRRT_kwDOS7mOVM62pDIb: the console line is a fixed status; details go only to the audit row.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let kept: TradeProposal[];
    try {
      kept = holdUnpricedShortDollarProposals([buy, cover, qtyBuy, other], unpricedShort, context);
      const lines = log.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines).toEqual(["[PositionInvariant] proposal held: position_unverified", "[PositionInvariant] proposal held: position_unverified"]);
      for (const line of lines) expect(line).not.toMatch(/MSFT|5000|300|10/);
    } finally {
      log.mockRestore();
    }
    expect(kept).toEqual([qtyBuy, other]);
    expect(audits().slice(before)).toEqual([
      expect.objectContaining({ symbol: "MSFT", side: "buy", dollarAmount: 5000, heldShortQuantity: 10, code: "position_unverified", runId: "run-4616" }),
      expect.objectContaining({ symbol: "MSFT", side: "cover", dollarAmount: 300, heldShortQuantity: 10, code: "position_unverified", runId: "run-4616" })
    ]);
    // Priced control: nothing held, nothing audited.
    expect(holdUnpricedShortDollarProposals([buy, cover], pricedShort, context)).toEqual([buy, cover]);
    expect(audits().length).toBe(before + 2);
  });

  // Kody PRRT_kwDOS7mOVM62pDNf: a priced dollar order with a stale zero/negative quantity is still
  // resolved to shares (capped at the position), never sent with a share count of 0 or less.
  it("a priced dollar exit with a zero or negative quantity is resolved to capped shares", () => {
    const long = heldPositionFor([{ symbol: "MSFT", quantity: 10, averageCost: 20, marketValue: 1000, marketValueSource: "quote" }], "MSFT");
    const short = heldPositionFor(pricedShort, "MSFT");
    const base = { accountNumber: TRADIER_ACCOUNT, symbol: "MSFT", type: "market", timeInForce: "gfd", marketHours: "regular_hours" } as const;
    const tradier = { resolvePartialDollarExits: true };
    for (const quantity of [0, -3]) {
      const label = `quantity ${quantity}`;
      // Partial sell: $500 of a $1000 long -> 5 shares.
      const partial = applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500, quantity }, long, tradier).input;
      expect(partial, label).toMatchObject({ side: "sell", quantity: 5 });
      expect(partial.dollarAmount, label).toBeUndefined();
      // Over-sized sell: $5000 of a $1000 long -> the exact held 10, never more.
      expect(applyPositionInvariant({ ...base, side: "sell", dollarAmount: 5000, quantity }, long, tradier).input, label).toMatchObject({ quantity: 10 });
      // Over-sized cover: $5000 against a $1000 short -> the exact held short, 10.
      expect(applyPositionInvariant({ ...base, side: "cover", dollarAmount: 5000, quantity }, short, tradier).input, label).toMatchObject({
        side: "cover",
        quantity: 10
      });
      // A fitting buy against the short -> a 1-share cover.
      const buy = applyPositionInvariant({ ...base, side: "buy", dollarAmount: 100, quantity }, short, tradier).input;
      expect(buy, label).toMatchObject({ side: "cover", quantity: 1 });
      expect(buy.dollarAmount, label).toBeUndefined();
      // Alpaca (no option) keeps a partial dollar sell notional, without the stale quantity.
      const alpaca = applyPositionInvariant({ ...base, accountNumber: ALPACA_ACCOUNT, side: "sell", dollarAmount: 500, quantity }, long).input;
      expect(alpaca, label).toMatchObject({ dollarAmount: 500 });
      expect(alpaca.quantity, label).toBeUndefined();
    }
    // Control: the same order with no quantity resolves the same way (the priced path is unchanged).
    expect(applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500 }, long, tradier).input).toMatchObject({ quantity: 5 });
  });

  // Kody PRRT_kwDOS7mOVM62qML9: an explicit positive quantity is kept; only a stale zero/negative
  // quantity is dropped so dollar resolution (or the Alpaca notional) can run. The clamp still
  // bounds a requested count that exceeds the held position.
  it("a dollar-sized exit keeps an explicit positive quantity and still clamps to the held position", () => {
    const long = heldPositionFor([{ symbol: "MSFT", quantity: 10, averageCost: 20, marketValue: 1000, marketValueSource: "quote" }], "MSFT");
    const short = heldPositionFor(pricedShort, "MSFT");
    const base = { accountNumber: TRADIER_ACCOUNT, symbol: "MSFT", type: "market", timeInForce: "gfd", marketHours: "regular_hours" } as const;
    const tradier = { resolvePartialDollarExits: true };
    // $500 of a $1000 / 10-share long would resolve to 5 shares. A requested 3 is kept, not resized,
    // and the leftover dollarAmount is dropped so review and the broker both size by shares.
    const partial = applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500, quantity: 3 }, long, tradier);
    expect(partial.input).toMatchObject({ side: "sell", quantity: 3 });
    expect(partial.input.dollarAmount).toBeUndefined();
    expect(partial.receipts.some((receipt) => receipt.kind === "dollar_amount_dropped_qty_wins")).toBe(true);
    // Requested 8 is also kept (not resized down to 5); dollars are dropped.
    const eight = applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500, quantity: 8 }, long, tradier);
    expect(eight.input).toMatchObject({ quantity: 8 });
    expect(eight.input.dollarAmount).toBeUndefined();
    expect(eight.receipts.some((receipt) => receipt.kind === "dollar_amount_dropped_qty_wins")).toBe(true);
    // Requested 15 exceeds the held 10 and is clamped; dollars are not used to resize, and are dropped.
    const clamped = applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500, quantity: 15 }, long, tradier);
    expect(clamped.input).toMatchObject({ quantity: 10 });
    expect(clamped.input.dollarAmount).toBeUndefined();
    expect(clamped.receipts.some((receipt) => receipt.kind === "quantity_clamped_to_position")).toBe(true);
    expect(clamped.receipts.some((receipt) => receipt.kind === "dollar_amount_dropped_qty_wins")).toBe(true);
    // Cover: requested 4 of a 10-share short; $500 would also be 5 shares, but 4 is kept and dollars drop.
    const cover = applyPositionInvariant({ ...base, side: "cover", dollarAmount: 500, quantity: 4 }, short, tradier);
    expect(cover.input).toMatchObject({ side: "cover", quantity: 4 });
    expect(cover.input.dollarAmount).toBeUndefined();
    expect(cover.receipts.some((receipt) => receipt.kind === "dollar_amount_dropped_qty_wins")).toBe(true);
    // Alpaca: a positive quantity is kept and dollarAmount is dropped (not sent as notional).
    const alpaca = applyPositionInvariant({ ...base, accountNumber: ALPACA_ACCOUNT, side: "sell", dollarAmount: 500, quantity: 3 }, long);
    expect(alpaca.input).toMatchObject({ quantity: 3 });
    expect(alpaca.input.dollarAmount).toBeUndefined();
    expect(alpaca.receipts.some((receipt) => receipt.kind === "dollar_amount_dropped_qty_wins")).toBe(true);
    // Stale qty<=0 is still dropped: Tradier resolves $500 to 5 shares; Alpaca keeps the $500 notional.
    for (const quantity of [0, -3]) {
      const label = `quantity ${quantity}`;
      expect(applyPositionInvariant({ ...base, side: "sell", dollarAmount: 500, quantity }, long, tradier).input, label).toMatchObject({
        quantity: 5
      });
      const alpacaStale = applyPositionInvariant({ ...base, accountNumber: ALPACA_ACCOUNT, side: "sell", dollarAmount: 500, quantity }, long).input;
      expect(alpacaStale, label).toMatchObject({ dollarAmount: 500 });
      expect(alpacaStale.quantity, label).toBeUndefined();
      // Oversized dollars still clamp to the exact held 10.
      expect(applyPositionInvariant({ ...base, side: "sell", dollarAmount: 5000, quantity }, long, tradier).input, label).toMatchObject({
        quantity: 10
      });
    }
  });

  // Kody PRRT_kwDOS7mOVM62m-NZ: a non-positive dollar buy is invalid input, not a retryable position error.
  // Kody PRRT_kwDOS7mOVM62oBV6: the control proves the fixture reaches the unpriced branch.
  it("a zero or negative dollar buy against an unpriced short is not a retryable position refusal", () => {
    const held = heldPositionFor(unpricedShort, "MSFT");
    expect(held.marketValuePriced).toBe(false);
    const order: EquityOrderInput = {
      accountNumber: TRADIER_ACCOUNT,
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    };
    // Control: the same fixture refuses a positive $100 buy as position_unverified.
    expect(() => applyPositionInvariant(order, held, { resolvePartialDollarExits: true })).toThrow(
      expect.objectContaining({ code: "position_unverified" })
    );
    for (const dollarAmount of [0, -5]) {
      const result = applyPositionInvariant({ ...order, dollarAmount }, held, { resolvePartialDollarExits: true });
      expect(result.input, String(dollarAmount)).toMatchObject({ side: "buy", dollarAmount });
      expect(result.receipts).toHaveLength(0);
    }
  });

  it("Tradier dollar buy-to-cover on a short sends nothing when the quote batch fails", async () => {
    harness.state.posts = [];
    harness.state.tradierFail = false;
    harness.state.tradierQuoteFail = true;
    harness.state.tradierPositions = [{ symbol: "MSFT", quantity: -10, cost_basis: -200 }];
    tradierNow = CLOCKS.regular;
    const error = await placeTradier({
      accountNumber: TRADIER_ACCOUNT,
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "cover-quote-fail"
    }).catch((err: unknown) => err);
    expect(harness.state.posts).toHaveLength(0);
    expect(isRetryablePositionInvariantError(error)).toBe(true);
  });

  // Kody PRRT_kwDOS7mOVM62mTIe: the quote price is Zod-parsed before it can value a position.
  it("a Tradier quote price that is not a finite positive number leaves the position at cost basis", async () => {
    const { getTradierGateway } = await import("../src/lib/tradier");
    harness.state.tradierFail = false;
    harness.state.tradierQuoteFail = false;
    harness.state.tradierPositions = [{ symbol: "MSFT", quantity: 10, cost_basis: 200 }];
    const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, "100", null, undefined];
    for (const price of bad) {
      const gateway = getTradierGateway("tradier-props", "acct-tradier-props");
      vi.spyOn(gateway, "getEquityQuotes").mockResolvedValue({ MSFT: { symbol: "MSFT", price } } as never);
      const [row] = await gateway.getEquityPositions(TRADIER_ACCOUNT);
      expect(row.marketValueSource, String(price)).toBe("cost_basis");
      expect(row.marketValue, String(price)).toBe(200);
      expect(heldPositionFor([row], "MSFT").marketValuePriced, String(price)).toBe(false);
    }
    const gateway = getTradierGateway("tradier-props", "acct-tradier-props");
    vi.spyOn(gateway, "getEquityQuotes").mockResolvedValue({ MSFT: { symbol: "MSFT", price: 100 } } as never);
    const [row] = await gateway.getEquityPositions(TRADIER_ACCOUNT);
    expect(row).toMatchObject({ marketValueSource: "quote", marketValue: 1000 });
  });
});
