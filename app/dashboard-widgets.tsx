/* Pure money/number formatters shared across the dashboard UI. */

export function money(value?: number): string {
  if (typeof value !== "number") return "$0.00";
  if (value < 0) {
    const abs = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(value));
    return `(${abs})`;
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function signedMoney(value?: number): string {
  // Zero is neutral — no leading "+" so a flat/empty account doesn't read as a gain.
  if (value === undefined || value === 0) return money(value ?? 0);
  return value > 0 ? `+${money(value)}` : money(value);
}

export function formatPct(value?: number): string {
  if (typeof value !== "number") return "0.00%";
  if (value === 0) return "0.00%";
  return value > 0 ? `+${value.toFixed(2)}%` : `(${Math.abs(value).toFixed(2)}%)`;
}

/**
 * Tone for a gain/loss value: positive → "up", negative → "down", and
 * exactly zero → "neutral" (so $0.00 / 0.00% renders in the default color,
 * not green or red). Use everywhere P&L / returns are colored.
 */
export function pnlTone(value?: number): "up" | "down" | "neutral" {
  if (typeof value !== "number" || value === 0) return "neutral";
  return value > 0 ? "up" : "down";
}

export function compactNum(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

export function compactMoney(value: number): string {
  if (value < 0) return `(${compactMoney(Math.abs(value))})`;
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}
