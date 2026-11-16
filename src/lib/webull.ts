/**
 * Webull OpenAPI gateway.
 * Official Trading API exists (HMAC-SHA1, separate sandbox vs prod keys, optional 2FA).
 * This adapter is connect-ready and fail-closed on writes until the owner is approved
 * and drops App Key + App Secret.  Unofficial tedchou12/webull is never used here.
 */
import type {
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
import { getActiveConnectedAccount, getConnectedAccount } from "./db";

export function getWebullGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new WebullBrokerGateway(userId, connectedAccountId);
}

class WebullBrokerGateway implements BrokerGateway {
  constructor(userId: string, connectedAccountId?: string) {
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const active = getActiveConnectedAccount(userId);
    const acct = targeted?.broker === "webull" ? targeted : active?.broker === "webull" ? active : undefined;
    if (!acct) throw new Error("No Webull account connected.");
    if (!acct.apiKey?.trim() || !acct.apiSecret?.trim()) {
      throw new Error(
        `Webull OpenAPI keys are missing for ${acct.label}.  Apply at webull.com → Developer Tool → My Application, then save App Key + App Secret.`
      );
    }
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    throw new OrderValidationError(
      "Webull OpenAPI signing is wired after owner approval.  Sandbox first: Developer Tool → Using OpenAPI service in Paper Trading."
    );
  }

  async getPortfolio(_accountNumber: string): Promise<Portfolio> {
    throw new OrderValidationError("Webull OpenAPI is not live until App Key signing is enabled.");
  }

  async getEquityPositions(_accountNumber: string): Promise<EquityPosition[]> {
    return [];
  }

  async getEquityOrders(_accountNumber: string, _options?: import("./types").GetEquityOrdersOptions): Promise<EquityOrder[]> {
    return [];
  }

  async getEquityQuotes(_accountNumber: string, _symbols: string[]): Promise<Record<string, BrokerQuote>> {
    return {};
  }

  async getEquityTradability(
    _accountNumber: string,
    symbols: string[]
  ): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>> {
    return Object.fromEntries(symbols.map((s) => [s, { tradable: false, fractional: false, reason: "Webull OpenAPI pending owner approval" }]));
  }

  async reviewEquityOrder(_input: EquityOrderInput): Promise<ReviewedOrder> {
    throw new OrderValidationError("Webull OpenAPI is not live until App Key signing is enabled.");
  }

  async placeEquityOrder(_input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    throw new OrderValidationError("Webull OpenAPI is not live until App Key signing is enabled.");
  }

  async cancelEquityOrder(_accountNumber: string, _orderId: string): Promise<ExecutedOrder> {
    throw new OrderValidationError("Webull cancel is not live until App Key signing is enabled.");
  }
}
