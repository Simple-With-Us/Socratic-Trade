import { getBrokerGateway } from "./broker";
import {
  ALPACA_PAPER_DELAYED_FEED,
  isAlpacaPaperAccount,
  type AlpacaPaperAccountLike
} from "./alpaca-paper-quotes";
import { getConnectedAccount, getPolicy } from "./db";
import {
  BROKER_UNIVERSE_RECOVERY_BUDGET_MS,
  BROKER_UNIVERSE_RECOVERY_CONCURRENCY,
  brokerAbortSignal,
  chunkBrokerSymbols
} from "./inflight-deadline";
import { normalizeSymbol } from "./money";
import { isAbortOrTimeoutError } from "./network-errors";
import { cascadeFreshMaxAgeMs, isUsableBrokerQuote } from "./quotes-cascade";
import type { BrokerQuote, EquityPosition, MarketQuote } from "./types";

export type BrokerUniverseScanRecovery = {
  quotes: MarketQuote[];
  warnings: string[];
  /** When non-empty, audit + `MarketScan.universeQuoteRecoverySource`. */
  recoverySource?: string;
};

function brokerQuoteToMarketQuote(
  quote: BrokerQuote | undefined,
  positions: EquityPosition[]
): MarketQuote | undefined {
  if (!quote) return undefined;
  const symbol = normalizeSymbol(quote.symbol);
  const price = quote.price;
  if (!(typeof price === "number" && price > 0)) return undefined;
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);
  const prevClose = quote.prevClose && quote.prevClose > 0 ? quote.prevClose : undefined;
  const intradayChangePct =
    quote.changePct ??
    (prevClose !== undefined && prevClose > 0
      ? Math.round(((price - prevClose) / prevClose) * 10_000) / 100
      : 0);
  const netChange =
    quote.netChange ?? quote.change ?? (prevClose !== undefined ? Math.round((price - prevClose) * 100) / 100 : undefined);
  const provider = quote.provider ?? "broker";
  return {
    symbol,
    price,
    bid: quote.bid,
    ask: quote.ask,
    volume: quote.volume && quote.volume > 0 ? quote.volume : 0,
    ...(prevClose !== undefined ? { prevClose } : {}),
    intradayChangePct,
    netChange: netChange ?? 0,
    sector: position?.sector,
    industry: position?.industry,
    positionMarketValue: position?.marketValue ?? 0,
    score: 0,
    provider,
    asOf: quote.asOf,
    venuePriceAuthoritative: quote.venuePriceAuthoritative,
    expectedDelaySec: quote.expectedDelaySec,
    delayToleranceSec: quote.delayToleranceSec,
    fetchedAt: quote.fetchedAt,
    sources: { price: provider }
  };
}

function recoverySourceLabel(broker: string, account: AlpacaPaperAccountLike): string | undefined {
  if (broker === "alpaca" && isAlpacaPaperAccount(account)) {
    return `alpaca-${ALPACA_PAPER_DELAYED_FEED}`;
  }
  if (broker === "tradier") return "tradier";
  return undefined;
}

function brokerInScope(broker: string, account: AlpacaPaperAccountLike): boolean {
  if (broker === "tradier") return true;
  if (broker === "alpaca" && isAlpacaPaperAccount(account)) return true;
  return false;
}

/**
 * When the Nasdaq screener and Yahoo recovery both return zero quotes, fill the
 * allowed universe from the operating account's broker tape (Alpaca PAPER
 * `delayed_sip` or Tradier sandbox).  Fail-closed when the broker returns no
 * usable quotes (staleness / excess delayed-tape lag).
 */
function brokerRecoveryAbortSignal(input: {
  signal?: AbortSignal;
  deadlineAt?: number;
}): AbortSignal {
  const parts: AbortSignal[] = [AbortSignal.timeout(BROKER_UNIVERSE_RECOVERY_BUDGET_MS)];
  if (input.signal) parts.push(input.signal);
  if (input.deadlineAt != null) {
    const remaining = input.deadlineAt - Date.now();
    if (remaining > 0) parts.push(AbortSignal.timeout(remaining));
  }
  if (parts.length === 1) return parts[0]!;
  return AbortSignal.any(parts);
}

function throwIfBrokerRecoveryAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("broker universe recovery aborted");
}

export async function recoverUniverseQuotesFromBroker(input: {
  symbols: string[];
  positions: EquityPosition[];
  userId: string;
  connectedAccountId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<BrokerUniverseScanRecovery> {
  const warnings: string[] = [];
  const requested = Array.from(new Set(input.symbols.map(normalizeSymbol).filter(Boolean)));
  if (requested.length === 0) return { quotes: [], warnings };

  const policy = getPolicy(input.userId, input.connectedAccountId);
  const accountNumber = policy.accountNumber?.trim();
  if (!policy.activeBroker || !accountNumber) {
    return { quotes: [], warnings: ["Broker universe recovery skipped: no active broker account."] };
  }

  const broker = String(policy.activeBroker);
  const account =
    (input.connectedAccountId
      ? getConnectedAccount(input.connectedAccountId, input.userId)
      : undefined) ??
    (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, input.userId) : undefined);

  if (!brokerInScope(broker, account)) {
    return {
      quotes: [],
      warnings: [`Broker universe recovery skipped: ${broker} is out of scope for empty-universe fill.`]
    };
  }

  const recoverySource = recoverySourceLabel(broker, account);
  if (!recoverySource) {
    return { quotes: [], warnings: ["Broker universe recovery skipped: unknown broker tape."] };
  }

  try {
    const gateway = getBrokerGateway(policy, input.userId);
    const maxAgeMs = cascadeFreshMaxAgeMs(policy.maxQuoteAgeSec);
    const merged: Record<string, BrokerQuote> = {};
    const recoverySignal = brokerRecoveryAbortSignal(input);
    const signal = brokerAbortSignal(recoverySignal);

    const chunks = chunkBrokerSymbols(requested);
    const concurrency = Math.min(BROKER_UNIVERSE_RECOVERY_CONCURRENCY, Math.max(1, chunks.length));
    let chunkIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const index = chunkIndex++;
        if (index >= chunks.length) return;
        const chunk = chunks[index]!;
        const nowMs = Date.now();
        const batch = await gateway.getEquityQuotes(accountNumber, chunk, { signal });
        for (const [rawSymbol, quote] of Object.entries(batch)) {
          const symbol = normalizeSymbol(rawSymbol);
          if (!symbol || !isUsableBrokerQuote(quote, nowMs, maxAgeMs)) continue;
          merged[symbol] = quote;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    throwIfBrokerRecoveryAborted(signal);

    const quotes: MarketQuote[] = [];
    for (const symbol of requested) {
      const row = brokerQuoteToMarketQuote(merged[symbol], input.positions);
      if (row) quotes.push(row);
    }

    if (quotes.length > 0) {
      warnings.unshift(
        `The delayed screener and Yahoo quote fallback returned no quotes; broker universe recovery priced ${quotes.length} of ${requested.length} names from ${recoverySource}.`
      );
      return { quotes, warnings, recoverySource };
    }

    warnings.push(`Broker universe recovery returned no usable quotes from ${recoverySource}.`);
    return { quotes: [], warnings };
  } catch (error) {
    if (input.signal?.aborted || isAbortOrTimeoutError(error)) throw error;
    throwIfBrokerRecoveryAborted(
      brokerRecoveryAbortSignal({ signal: input.signal, deadlineAt: input.deadlineAt })
    );
    warnings.push(
      error instanceof Error
        ? `Broker universe recovery failed: ${error.message}`
        : "Broker universe recovery failed."
    );
    return { quotes: [], warnings };
  }
}
