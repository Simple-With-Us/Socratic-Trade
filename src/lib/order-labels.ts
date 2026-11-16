/** Broker order ids (Alpaca/Robinhood) are ~25-36 char UUIDs — fine for audit payloads and
 *  cancel/replace calls, but too long for a human-facing label. There is no persisted orders
 *  table to assign a sequential counter against, so this is a stateless, deterministic
 *  projection of the broker id down to a short, uppercase alphanumeric tag: strip separators,
 *  take the first 8 chars, uppercase. It is NOT a lookup and NOT a counter — the same id always
 *  produces the same label with no state. Full ids remain the source of truth everywhere else
 *  (heldOrderIds, EquityOrder.id, audit payloads, cancel/replace flows) — only display strings
 *  should call this. */
export function shortOrderLabel(id: string): string {
  const cleaned = String(id ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (cleaned.length === 0) return "?";
  if (cleaned.length < 8) return cleaned;
  return cleaned.slice(0, 8);
}
