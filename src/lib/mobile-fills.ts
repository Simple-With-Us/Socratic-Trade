// mobile-fills.ts — the MOBILE-scoped bound on the fill ledger (ST-4640).
//
// The CONSOLE's fill ledger is deliberately UNBOUNDED and must stay that way: FIFO lot replay
// (calculatePnl) is a STATEFUL walk from the FIRST fill, so truncating the window at either
// end corrupts realized P&L, open lots, tax, win rate and model stats.  That path
// (src/lib/dashboard.ts's liveFills/paperFills, and the unbounded `listFillEvents` default)
// is untouched by this change.
//
// The MOBILE wire has no such requirement: the phone shows a short fill list, and every SSE
// event triggers a full /api/mobile/snapshot reload.  So the mobile snapshot ships a BOUNDED
// window of the newest fills plus an explicit "there are more" flag, instead of the whole
// ledger, every time.
//
// CONTRACT (the parallel iOS lane implements the client side; it MUST work correctly whether
// or not these fields exist — the mobile lane may merge later):
//
//   fills           FillEvent[]  — the newest MOBILE_FILL_LIMIT fills, chronological order.
//   fillsTruncated  boolean      — true when the ledger holds MORE fills than were returned.
//
// The input window is the server's own newest-`PERFORMANCE_DISPLAY_FILL_CAP` display window
// (the newest fills, chronological).  Because MOBILE_FILL_LIMIT is smaller than that cap,
// "the window holds more than MOBILE_FILL_LIMIT entries" is EXACTLY "the ledger holds more
// than MOBILE_FILL_LIMIT fills" — so the flag never guesses.

import type { FillEvent } from "./types";

/** How many fills the mobile wire ships.  The phone displays ~20; 50 leaves headroom. */
export const MOBILE_FILL_LIMIT = 50;

export interface BoundedMobileFills {
  fills: FillEvent[];
  /** True when the ledger holds more fills than were returned. */
  fillsTruncated: boolean;
}

/**
 * The newest `limit` fills, in the order they were given (the server's fill window is
 * chronological).  Older fills are dropped; the flag says so.
 */
export function boundMobileFills(
  fills: FillEvent[] | undefined | null,
  limit: number = MOBILE_FILL_LIMIT
): BoundedMobileFills {
  const all = Array.isArray(fills) ? fills : [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MOBILE_FILL_LIMIT;
  if (all.length <= cap) return { fills: all, fillsTruncated: false };
  return { fills: all.slice(all.length - cap), fillsTruncated: true };
}

/**
 * Mobile-wire view of the performance summary with its display fill list bounded.
 * The console payload is NOT affected — this is only applied on the mobile route.
 */
export function withMobileFillsBound<T extends { fills?: FillEvent[] } | null | undefined>(
  performance: T,
  limit: number = MOBILE_FILL_LIMIT
): T {
  if (!performance) return performance as never;
  const bounded = boundMobileFills(performance.fills, limit);
  return { ...performance, fills: bounded.fills } as T;
}
