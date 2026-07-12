import type { OrderSide } from "./types";

// Our internal OrderSide encodes intent relative to the position: "buy"/"sell" act on a long,
// "short"/"cover" act on a short. Real equity broker order APIs (Alpaca, Robinhood) only accept
// "buy" or "sell" — the broker infers open-vs-close from the account's current position. So a
// "short" is submitted to the broker as a "sell" (sell shares you don't own → opens a short), and a
// "cover" is submitted as a "buy" (buy to close the short). Forwarding the raw 4-value side to the
// broker produces an invalid request; every broker submission must translate through this function.

/** Translate our 4-value intent side to the broker's 2-value equity order side. */
export function toBrokerSide(side: OrderSide): "buy" | "sell" {
  return side === "buy" || side === "cover" ? "buy" : "sell";
}

/** The short-side intents that a broker without equity shorting (e.g. Robinhood) must reject. */
export function isShortIntent(side: OrderSide): boolean {
  return side === "short" || side === "cover";
}

// Broker order-state vocabularies aren't normalized to one canonical enum (Alpaca and Robinhood
// each return their own raw state strings, with spelling variants like "canceled"/"cancelled").
// This is the single broker-agnostic check for "the broker declined/terminated this order without
// a fill" — used both immediately after placement (so a synchronous broker rejection isn't
// mislabeled "placed") and by the later reconciliation sweep (so both spellings/brokers match).
const TERMINAL_DECLINE_STATES = new Set(["rejected", "canceled", "cancelled", "failed", "expired"]);

export function isRejectedOrCanceledState(state: string | undefined | null): boolean {
  return TERMINAL_DECLINE_STATES.has(String(state ?? "").trim().toLowerCase());
}
