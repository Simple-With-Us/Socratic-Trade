// Shared Central-Time trading-day boundaries — dependency-free so client and server modules
// can agree on "today" without importing the db barrel or console format helpers.

/** Owner-facing calendar day for trading metrics (Day P&L, daily caps, drawdown breaker). */
export const CENTRAL_TRADING_DAY_ZONE = "America/Chicago";

/** YYYY-MM-DD for `date` in Central Time — DST-safe calendar-day key. */
export function centralTradingDayKey(date: Date | string | number): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL_TRADING_DAY_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

/** Start of the Central-Time calendar day containing `now`, as an absolute instant. */
export function startOfCentralTradingDay(now: Date = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CENTRAL_TRADING_DAY_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const wallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  const offsetMs = wallAsUTC - now.getTime();
  const midnightWallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  return new Date(midnightWallAsUTC - offsetMs);
}
