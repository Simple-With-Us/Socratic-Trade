/**
 * Resolve the operating account and the delayed-price policy for one read.
 * Kept out of `paper-delayed-price-policy.ts` so the policy module stays free
 * of the database (the console client imports the label constant).
 */
import "server-only";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { paperDelayedPricePolicy, type PaperDelayedPricePolicy } from "./paper-delayed-price-policy";

export function paperPricePolicyForUser(
  userId: string,
  connectedAccountId?: string,
  nowMs: number = Date.now()
): PaperDelayedPricePolicy {
  const account = connectedAccountId
    ? getConnectedAccount(connectedAccountId, userId) ?? getActiveConnectedAccount(userId)
    : getActiveConnectedAccount(userId);
  return paperDelayedPricePolicy(account, nowMs);
}
