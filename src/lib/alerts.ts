import crypto from "crypto";
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
import { isValidAppSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { fetchFreshQuotesCascade, quoteAgeSecForStalenessGate } from "./quotes-cascade";
import type { PriceAlert, PriceAlertOp } from "./types";

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
  if (!isValidAppSymbol(symbol)) return { error: "INVALID_SYMBOL" };
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
  const symbols = [...new Set(armed.map((alert) => alert.symbol))];
  let quotes: Awaited<ReturnType<typeof fetchFreshQuotesCascade>> = {};
  try {
    // Account-scoped: the cascade must run against the OPERATING account's
    // tape (Alpaca PAPER `delayed_sip`), not a process-global default.
    quotes = await fetchFreshQuotesCascade(
      symbols,
      userId,
      policy.accountNumber,
      policy.connectedAccountId
    );
  } catch (err) {
    console.error(`[alerts] quote cascade failed for ${userId}:`, err);
    audit("alert.check_error", { userId, symbols, error: String(err) }, userId);
    return [];
  }

  const nowMs = Date.now();
  const maxQuoteAgeSec = policy.maxQuoteAgeSec ?? 120;
  const triggered: PriceAlert[] = [];
  for (const alert of armed) {
    const quote = quotes[alert.symbol];
    const { ageSec, missing, excessDelaySec, marketSessionOpen } = quoteAgeSecForStalenessGate(quote, nowMs);
    // EXCESS delay on a tape with a documented expected delay (Alpaca PAPER
    // `delayed_sip`) means the observation is beyond the delayed-tape window:
    // during RTH that can be an illiquid last print OR excess tape lag.  The
    // alert must not fire off it either way.  The expected ~900s delay itself
    // is normal and is not excess.
    const excessDelayed = excessDelaySec !== undefined && excessDelaySec > 0;
    // A CLOSED session is not "broken feed" — there are simply no new prints
    // while the market is shut.  The tape is still not a fresh observation, so
    // the alert stays unfired (same fail-closed outcome as before).
    const closedSessionTape = marketSessionOpen === false;
    const isStale =
      missing || closedSessionTape || excessDelayed || (ageSec !== undefined && ageSec > maxQuoteAgeSec);
    if (isStale) continue;

    const currentPrice = quote?.price;
    if (typeof currentPrice !== "number" || currentPrice <= 0) continue;
    const hit = alert.op === "<" ? currentPrice < alert.price : currentPrice > alert.price;
    if (!hit) continue;

    try {
      const fakeTriggeredAlert = { ...alert, status: "triggered" as const, triggeredPrice: currentPrice, triggeredAt: new Date().toISOString() };
      const event = await sendNotification(
        {
          type: "price_alert",
          title: `Price alert: ${alert.symbol}`,
          payload: {
            alert: fakeTriggeredAlert,
            currentPrice
          }
        },
        {
          policy,
          userId,
          directBody: `${alert.symbol} ${alert.op} $${alert.price} — now $${currentPrice}.`
        }
      );
      if (event.status === "failed") {
        console.error(`[alerts] notification failed for alert ${alert.id}, skipping trigger:`, event.error);
        continue;
      }
    } catch (err) {
      console.error(`[alerts] notification failed for alert ${alert.id}, skipping trigger:`, err);
      continue;
    }

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
  }
  return triggered;
}

export async function checkAllUserPriceAlerts(): Promise<void> {
  for (const userId of listUsers()) {
    await checkPriceAlerts(userId).catch((err) => console.error(`[alerts] check error for ${userId}:`, err));
  }
}
