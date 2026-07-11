import crypto from "crypto";
import { getBrokerGateway } from "./broker";
import {
  audit,
  createPriceAlert,
  deletePriceAlert,
  getPolicy,
  listArmedPriceAlerts,
  listPriceAlerts,
  listUsers,
  markPriceAlertTriggered
} from "./db";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import type { PriceAlert, PriceAlertOp } from "./types";

const SYMBOL_RE = /^[A-Z.]{1,10}$/;

export function normalizeAlertOp(op: string): PriceAlertOp | null {
  const value = op.trim().toLowerCase();
  if (["<", "below", "under", "lt", "less"].includes(value)) return "<";
  if ([">", "above", "over", "gt", "greater"].includes(value)) return ">";
  return null;
}

export function createAlert(
  userId: string,
  input: { symbol: string; op: string; price: number; note?: string }
): PriceAlert | { error: string } {
  const symbol = normalizeSymbol(input.symbol);
  const op = normalizeAlertOp(input.op);
  const price = Number(input.price);
  if (!SYMBOL_RE.test(symbol)) return { error: "INVALID_SYMBOL" };
  if (!op) return { error: "INVALID_OP" };
  if (!Number.isFinite(price) || price <= 0) return { error: "INVALID_PRICE" };

  const alert = createPriceAlert({
    id: crypto.randomUUID(),
    userId,
    symbol,
    op,
    price,
    note: input.note?.trim() ?? "",
    status: "armed",
    createdAt: new Date().toISOString(),
    triggeredAt: null,
    triggeredPrice: null
  });
  audit("alert.create", { userId, id: alert.id, symbol, op, price });
  return alert;
}

export function listAlerts(userId: string, status: "all" | "armed" | "triggered" = "all"): PriceAlert[] {
  return listPriceAlerts(userId, status);
}

export function removeAlert(userId: string, id: string): boolean {
  const removed = deletePriceAlert(userId, id);
  if (removed) audit("alert.delete", { userId, id });
  return removed;
}

export async function checkPriceAlerts(userId: string): Promise<PriceAlert[]> {
  const armed = listArmedPriceAlerts(userId);
  if (armed.length === 0) return [];

  const policy = getPolicy(userId);
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return [];

  const symbols = [...new Set(armed.map((alert) => alert.symbol))];
  const gateway = getBrokerGateway(policy, userId);
  let quotes: Record<string, { price?: number }> = {};
  try {
    quotes = await gateway.getEquityQuotes(accountNumber, symbols);
  } catch {
    return [];
  }

  const triggered: PriceAlert[] = [];
  for (const alert of armed) {
    const quote = quotes[alert.symbol];
    const currentPrice = quote?.price;
    if (typeof currentPrice !== "number" || currentPrice <= 0) continue;
    const hit = alert.op === "<" ? currentPrice < alert.price : currentPrice > alert.price;
    if (!hit) continue;

    const updated = markPriceAlertTriggered(alert.id, userId, currentPrice);
    if (!updated) continue;
    triggered.push(updated);
    audit("alert.triggered", {
      userId,
      id: alert.id,
      symbol: alert.symbol,
      op: alert.op,
      threshold: alert.price,
      atPrice: currentPrice
    });
    await sendNotification(
      {
        type: "price_alert",
        title: `Price alert: ${alert.symbol}`,
        payload: {
          alert: updated,
          currentPrice
        }
      },
      {
        policy,
        userId,
        directBody: `${alert.symbol} ${alert.op} $${alert.price} — now $${currentPrice}.`
      }
    );
  }
  return triggered;
}

export async function checkAllUserPriceAlerts(): Promise<void> {
  for (const userId of listUsers()) {
    await checkPriceAlerts(userId).catch((err) => console.error(`[alerts] check error for ${userId}:`, err));
  }
}
