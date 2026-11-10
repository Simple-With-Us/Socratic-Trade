/**
 * Side-aware math for broker-held protective stops.
 *
 * Longs rest a SELL stop BELOW the mark.  Shorts rest a BUY-TO-COVER stop
 * ABOVE the mark.  Pure functions so the reconciler and tests share one
 * definition of "tighter", "already breached", and "implied trail extreme".
 */

import type { EquityPosition, OrderSide } from "./types";

export type ProtectiveSide = "long" | "short";

export function protectiveSideOf(pos: Pick<EquityPosition, "quantity">): ProtectiveSide {
  return pos.quantity < 0 ? "short" : "long";
}

/** Mark price.  Uses signed marketValue / signed quantity so both long and
 *  short Alpaca rows (negative qty + negative MV) resolve to a positive price. */
export function positionMarkPrice(pos: Pick<EquityPosition, "quantity" | "marketValue">): number {
  if (!(pos.quantity !== 0)) return 0;
  const mark = pos.marketValue / pos.quantity;
  return Number.isFinite(mark) && mark > 0 ? mark : 0;
}

export function protectiveExitSide(side: ProtectiveSide): Extract<OrderSide, "sell" | "cover"> {
  return side === "short" ? "cover" : "sell";
}

/** Fixed-stop trigger from entry + distance %.  Shorts sit ABOVE entry. */
export function fixedProtectiveStopPrice(avgCost: number, stopPct: number, side: ProtectiveSide): number {
  if (!(avgCost > 0) || !(stopPct > 0)) return 0;
  const raw = side === "short" ? avgCost * (1 + stopPct / 100) : avgCost * (1 - stopPct / 100);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : 0;
}

/**
 * Reconstruct the trail extreme implied by a resting trigger + trail %.
 * Long: stop = extreme * (1 - trail/100) → extreme = stop / (1 - trail/100)
 * Short: stop = extreme * (1 + trail/100) → extreme = stop / (1 + trail/100)
 */
export function impliedTrailExtreme(stopPrice: number, trailPercent: number, side: ProtectiveSide): number {
  if (!(stopPrice > 0) || !(trailPercent > 0)) return 0;
  const denom = side === "short" ? 1 + trailPercent / 100 : 1 - trailPercent / 100;
  if (!(denom > 0)) return 0;
  const extreme = stopPrice / denom;
  return Number.isFinite(extreme) && extreme > 0 ? extreme : 0;
}

/** Ratcheted (non-native) trail trigger from the tracked extreme. */
export function trailingTriggerFromExtreme(
  mark: number,
  avgCost: number,
  trackedExtreme: number,
  trailPct: number,
  side: ProtectiveSide
): number {
  if (!(trailPct > 0)) return 0;
  if (side === "short") {
    const extreme = Math.min(
      mark > 0 ? mark : Number.POSITIVE_INFINITY,
      avgCost > 0 ? avgCost : Number.POSITIVE_INFINITY,
      trackedExtreme > 0 ? trackedExtreme : Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(extreme) || !(extreme > 0)) return 0;
    return Math.round(extreme * (1 + trailPct / 100) * 100) / 100;
  }
  const extreme = Math.max(mark, avgCost, trackedExtreme);
  if (!(extreme > 0)) return 0;
  return Math.round(extreme * (1 - trailPct / 100) * 100) / 100;
}

/**
 * May we arm a broker-held trailing stop without loosening the app-defined trail?
 * Native (Alpaca REST): broker seeds from the CURRENT mark, so the mark must be
 * at/through the tracked extreme (at/above HWM for longs, at/below LWM for shorts).
 * Ratcheted: fail only when the computed trigger is already breached.
 */
export function canArmProtectiveTrail(input: {
  mark: number;
  avgCost: number;
  trackedExtreme: number;
  stopPrice: number;
  nativeTrailing: boolean;
  side: ProtectiveSide;
}): boolean {
  const { mark, avgCost, trackedExtreme, stopPrice, nativeTrailing, side } = input;
  if (!(mark > 0) || !(stopPrice > 0)) return false;
  if (side === "short") {
    if (nativeTrailing) {
      const floor = Math.min(
        avgCost > 0 ? avgCost : Number.POSITIVE_INFINITY,
        trackedExtreme > 0 ? trackedExtreme : Number.POSITIVE_INFINITY
      );
      return Number.isFinite(floor) && mark <= floor;
    }
    return stopPrice > mark;
  }
  if (nativeTrailing) return mark >= Math.max(avgCost, trackedExtreme);
  return stopPrice < mark;
}

/** True when the new ratcheted trigger is meaningfully tighter than the resting one. */
export function trailRatchetTighter(existingStopPrice: number, newStopPrice: number, side: ProtectiveSide): boolean {
  const minMove = Math.max(0.02, existingStopPrice * 0.001);
  return side === "short"
    ? existingStopPrice - newStopPrice >= minMove
    : newStopPrice - existingStopPrice >= minMove;
}

/**
 * Halted right-size floor: a same-tick replacement must not loosen the cancelled stop.
 * Longs: tighter = higher sell-stop → clamp UP.  Shorts: tighter = lower buy-stop → clamp DOWN.
 */
export function clampHaltedReplacementStop(candidate: number, floor: number | undefined, side: ProtectiveSide): number {
  if (!(floor && floor > 0)) return candidate;
  if (side === "short") return candidate < floor ? candidate : floor;
  return candidate > floor ? candidate : floor;
}
