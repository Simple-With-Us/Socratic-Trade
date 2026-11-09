// Per-broker order-status CONFORMANCE TABLES (oss-lessons §7 slice 1 — freqtrade discipline:
// nothing outside the broker wrapper interprets raw status strings; here the wrappers pass raw
// statuses through and the SHARED classifiers in broker-side.ts / broker-held-orders.ts are the
// single interpretation point — these tables lock that interpretation down per broker).
//
// Each row is the broker-documented meaning of one raw status, expressed against the REAL
// classifier functions. The conformance test (test/broker-status-conformance.test.ts) executes
// `classifyOrderStatus` — which calls the actual production classifiers — against every row, so
// a vocabulary edit in either direction (a new raw status mishandled, or a classifier change that
// alters an existing mapping) is a CI-failing assertion, not a production surprise like the
// 2026-07-27 done_for_day inflation or the decline-set drift between broker-side.ts and
// broker-held-orders.ts (the latter's local copy was missing "failed"/"error" — found by this
// audit, unified to a re-export).

import { isLiveOrderState, isRejectedOrCanceledState } from "./broker-side";
import { isActiveBrokerOrderState, isWorkingOrderState } from "./broker-held-orders";

export type BrokerId = "alpaca" | "robinhood" | "tradier";

/** The canonical classification of one raw broker order status, across the four production lenses. */
export interface CanonicalOrderStatusClass {
  /** Resting/live at the broker — counts as protection/coverage (broker-side.isLiveOrderState). */
  live: boolean;
  /** Active/held for exit-availability math (broker-held-orders.isActiveBrokerOrderState). */
  active: boolean;
  /** Appears on the open/working Orders list + stale-limit scan (broker-held-orders.isWorkingOrderState). */
  working: boolean;
  /** Terminal decline without (necessarily) a fill (broker-side.isRejectedOrCanceledState — canonical set). */
  decline: boolean;
  /** Terminal successful fill (raw === "filled" after normalization — the production convention). */
  filled: boolean;
}

export interface BrokerOrderStatusRow extends CanonicalOrderStatusClass {
  /** Raw status string exactly as the broker emits it (lowercase). */
  raw: string;
  /** Why this mapping is what it is — the trap it guards, where one exists. */
  note?: string;
}

// Shorthands keep the tables readable: R = resting (live+active+working), T = terminal-inert
// (all false — terminal but neither decline nor fill; special-cased elsewhere).
const R = { live: true, active: true, working: true, decline: false, filled: false } as const;
const T = { live: false, active: false, working: false, decline: false, filled: false } as const;
const D = { live: false, active: false, working: false, decline: true, filled: false } as const;
const F = { live: false, active: false, working: false, decline: false, filled: true } as const;

/**
 * The documented raw-status vocabulary per connected broker, with the expected canonical class.
 * Alpaca vocabulary: https://alpaca.markets/docs/api-references/broker-api/trading/orders/ (and the
 * repo's own adapters); Robinhood equity order states per the gateway's get_equity_orders usage;
 * Tradier per its order-status docs. Unknown/unlisted statuses must fail CLOSED (class T) — the
 * test asserts that property separately.
 */
export const BROKER_ORDER_STATUS_CONFORMANCE: Record<BrokerId, BrokerOrderStatusRow[]> = {
  alpaca: [
    { raw: "new", ...R },
    { raw: "accepted", ...R },
    { raw: "pending_new", ...R },
    { raw: "accepted_for_bidding", ...R },
    { raw: "held", ...R },
    { raw: "partially_filled", ...R, note: "Still live: the remainder can fill — protection must not stack." },
    {
      raw: "pending_cancel",
      ...R,
      note: "Deliberately live: a REQUESTED cancel can still fill; treating it as dead is what lets a duplicate exit stack."
    },
    { raw: "pending_replace", ...R, note: "Same in-transition discipline as pending_cancel." },
    { raw: "suspended", ...R },
    {
      raw: "calculated",
      live: true, active: false, working: true, decline: false, filled: false,
      note: "Pre-accept: live protection, and on the working list via EXTRA_WORKING — but NOT active/held."
    },
    {
      raw: "stopped",
      live: false, active: false, working: true, decline: false, filled: false,
      note: "Stop triggered, fill pending: actionable on the working list, but no longer resting protection."
    },
    { raw: "filled", ...F },
    {
      raw: "done_for_day",
      ...T,
      note: "THE 2026-07-27 regression: terminal day-order outcome that persists in history forever — must NEVER count as working/live, and is NOT a decline (ops-snapshot tallies it separately)."
    },
    { raw: "canceled", ...D },
    { raw: "cancelled", ...D, note: "Spelling variant both Alpaca and humans emit." },
    { raw: "expired", ...D },
    { raw: "rejected", ...D },
    {
      raw: "replaced",
      ...T,
      note: "Superseded by a replacement order — terminal but NOT a decline; the order_replacements ledger tracks the successor."
    }
  ],
  robinhood: [
    { raw: "queued", ...R },
    { raw: "confirmed", ...R },
    { raw: "unconfirmed", ...R },
    { raw: "partially_filled", ...R },
    { raw: "filled", ...F },
    { raw: "cancelled", ...D },
    { raw: "canceled", ...D, note: "Spelling variant." },
    { raw: "rejected", ...D },
    {
      raw: "failed",
      ...D,
      note: "Present in the canonical broker-side decline set — was MISSING from broker-held-orders' drifted local copy (this audit's finding)."
    }
  ],
  tradier: [
    { raw: "open", ...R },
    { raw: "pending", ...R, note: "Bare Tradier resting state — kept in BOTH active sets by invariant." },
    { raw: "partially_filled", ...R },
    { raw: "filled", ...F },
    { raw: "canceled", ...D },
    { raw: "cancelled", ...D, note: "Spelling variant." },
    { raw: "expired", ...D },
    { raw: "rejected", ...D },
    {
      raw: "error",
      ...D,
      note: "Tradier-flavored terminal decline — also was missing from broker-held-orders' drifted copy."
    }
  ]
};

/**
 * Run the REAL production classifiers over one raw status. This is the function the conformance
 * test checks every table row against — it MUST stay wired to the same classifiers the trading
 * paths use (never a re-implementation), or the tables certify nothing.
 */
export function classifyOrderStatus(raw: string): CanonicalOrderStatusClass {
  const normalized = String(raw ?? "").trim().toLowerCase();
  return {
    live: isLiveOrderState(normalized),
    active: isActiveBrokerOrderState(normalized),
    working: isWorkingOrderState(normalized),
    decline: isRejectedOrCanceledState(normalized),
    filled: normalized === "filled"
  };
}
