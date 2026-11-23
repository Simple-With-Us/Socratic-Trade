import type { AlpacaAccountActivity } from "./alpaca-account-insights";

/**
 * Tradier GET /accounts/{id}/history event types that move EXTERNAL capital. Dividends, interest,
 * fees, taxes, trades and adjustments are account performance, never a transfer, so they are not
 * listed here and never become benchmark flows. A journal is not listed either: it can be an internal
 * corporate-action entry, so the reader treats any journal as an incomplete ledger (see tradier.ts).
 */
const TRADIER_CAPITAL_EVENT_TYPES = new Set(["ach", "wire", "check", "transfer"]);

/**
 * Map Tradier history events to the broker-activity shape the benchmark already consumes
 * (CSD = money in, CSW = money out). Zero or non-numeric amounts and every non-capital event are
 * dropped; nothing is estimated.
 */
export function tradierHistoryToActivities(events: Record<string, unknown>[]): AlpacaAccountActivity[] {
  const out: AlpacaAccountActivity[] = [];
  const seen = new Map<string, number>();
  for (const event of events) {
    const type = String(event.type ?? "").trim().toLowerCase();
    if (!TRADIER_CAPITAL_EVENT_TYPES.has(type)) continue;
    const amount = Number(event.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const rawDate = typeof event.date === "string" ? event.date : "";
    const day = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : undefined;
    const base = `tradier-${type}-${rawDate}-${amount}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({
      id: n === 1 ? base : `${base}-${n}`,
      activity_type: amount > 0 ? "CSD" : "CSW",
      net_amount: String(amount),
      ...(day ? { date: day } : {}),
      ...(rawDate ? { transaction_time: rawDate } : {}),
      type
    });
  }
  return out;
}

export interface TradierTransferLedger {
  /** True only when the whole history was read and it held at least one event of any kind. */
  ok: boolean;
  activities: AlpacaAccountActivity[];
  error?: string;
}
