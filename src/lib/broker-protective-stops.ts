// True broker-held protective stops — two kinds, one reconciler:
//
//  - FIXED (Robinhood, opt-in `robinhoodBrokerStops`): Robinhood's MCP cannot hold a native OCO
//    bracket (unlike Alpaca), so a held position is otherwise protected only by the app's synthetic
//    scheduler-tick monitor — a single point of failure if the app is offline. This lane places a
//    resting broker-side stop-market SELL (GTC) at stopLossPct below entry for each open Robinhood
//    LIVE long, and cancels it when the position closes or a synthetic exit fires (so an orphaned
//    stop can't sell shares we no longer hold).
//
//  - TRAILING (`brokerTrailingStops`, default on; inert until riskRules.trailingStopPct > 0):
//     * Alpaca REST (paper or live): a TRUE native `trailing_stop` order (trail_percent) — the
//       broker trails the high-water mark itself, so the trail keeps moving even while the app is
//       down.
//     * Alpaca MCP: the ratcheted emulation below, through the account's own MCP transport — an
//       MCP-endpoint-only account has no REST keys for the native lane.
//     * Robinhood (live, additionally gated on `robinhoodBrokerStops` — the "resting stops at RH
//       are live-verified" opt-in): the RH MCP exposes no verified native trailing parameter, so
//       this lane places a resting GTC stop-market at trailingStopPct below the high-water mark and
//       RATCHETS it upward (cancel-replace) each tick as the price rises. Between ticks the broker
//       holds a real fixed stop — protection survives app downtime; the trail catches up on the
//       app's cadence.
//    Trailing takes precedence over fixed when both lanes apply: shares can only back ONE resting
//    sell order at the broker, so a position carries either the trailing or the fixed broker stop,
//    never both (the synthetic monitor still layers the other rule on its tick, as always).
//
// Reconciliation runs from the synthetic-stop monitor each tick: it CANCELS stops for closed
// positions every time (risk-reducing, always safe) and PLACES missing stops only when the system is
// running. This self-heals — a restart re-places any missing stops for still-open positions. The
// enabling flags gate only PLACEMENT: when no lane is enabled any more, reconcile still CANCELS
// every stop the feature previously placed for the account, so disabling tears its resting stops
// down instead of orphaning them. Placement is coverage-aware when the caller supplies its order
// list: a position whose shares are already backed by another live exit-side order (an Alpaca OCO
// bracket stop leg, a manual GTC sell) is skipped/right-sized instead of provoking a broker
// rejection. The always-on synthetic monitor remains the fallback, so this is purely additive
// protection.
//
// A pending_cancel row whose cancel call keeps failing (e.g. "order not found" after an earlier
// attempt actually landed broker-side) would otherwise retry forever and permanently block
// re-placement for that symbol. The caller's freshly fetched order list (`orders`, optional) lets
// section 1 recover: if the order shows up there already done resting (filled/rejected/canceled/
// expired), the row is deleted instead of retried again. Absent-from-list or still-live stays
// ambiguous and keeps retrying — never assume terminal without positive evidence. A rejected/
// canceled/expired recovery never moved the position, so section 4 may re-place in the SAME call;
// a FILLED recovery did move it, and the caller fetches `positions` before `orders`, so that one
// case defers re-placement to the next call rather than risk sizing off a stale pre-fill quantity.

import {
  audit,
  deleteBrokerProtectiveStop,
  insertFillEvent,
  listBrokerProtectiveStops,
  upsertBrokerProtectiveStop,
  type BrokerProtectiveStop
} from "./db";
import { isRejectedOrCanceledState, liveExitOrderCoverage } from "./broker-side";
import { normalizeSymbol } from "./money";
import { livePreflightBlocks } from "./preflight-live-guard";
import type { BrokerGateway, EquityOrder, EquityPosition, ExecutionMode, FillSource, StopPlanStyle, TradingPolicy } from "./types";

/**
 * True when a broker order is done resting for reasons other than an app-issued cancel actually
 * landing — either the broker declined/terminated it (rejected/canceled/expired/failed, both
 * spellings) or it already FILLED. Both are terminal from a "should we keep retrying the cancel"
 * standpoint: a filled stop can never be cancelled (the broker will just keep erroring), and a
 * declined/expired one never rested to begin with. Deliberately narrower than "not live" — an
 * UNRECOGNIZED state must NOT count as terminal here, or a still-resting order in an unfamiliar
 * state would get its local row deleted while the broker-side stop keeps resting, letting a later
 * tick place a second stop over it (two resting sell stops, one invisible — the same failure mode
 * the section-4 placement guard exists to avoid).
 */
function isDoneRestingState(state: string | undefined | null): boolean {
  return isRejectedOrCanceledState(state) || String(state ?? "").trim().toLowerCase() === "filled";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function brokerProtectiveStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  if ((policy.riskRules?.stopLossPct ?? 0) <= 0) return false;
  
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return executionMode === "broker/live" || executionMode === "broker/paper";
  }
  
  if (policy.activeBroker === "robinhood") {
    return executionMode === "broker/live" && policy.robinhoodBrokerStops === true;
  }
  
  return false;
}

/**
 * True when broker-held TRAILING stops should be maintained. Requires a configured trailing % and
 * the `brokerTrailingStops` preference (default on — `false` opts out). Alpaca supports native
 * trailing_stop orders in both environments; Robinhood only gets the ratcheted emulation on LIVE,
 * and only under the existing `robinhoodBrokerStops` opt-in (the flag that says "resting stops at
 * Robinhood have been live-verified").
 */
export function brokerTrailingStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  if ((policy.riskRules?.trailingStopPct ?? 0) <= 0) return false;
  if (policy.brokerTrailingStops === false) return false;
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") return true;
  if (policy.activeBroker === "robinhood") {
    return executionMode === "broker/live" && policy.robinhoodBrokerStops === true;
  }
  return false;
}

/**
 * Which kind of broker-held protective stop this account should carry per open long. Trailing wins
 * when both lanes apply — a position's shares can only back one resting sell order at the broker.
 */
export function desiredBrokerStopKind(policy: TradingPolicy, executionMode: ExecutionMode): "fixed" | "trailing" | null {
  if (brokerTrailingStopsEnabled(policy, executionMode)) return "trailing";
  if (brokerProtectiveStopsEnabled(policy, executionMode)) return "fixed";
  return null;
}

/**
 * Cancel + forget the resting protective stop(s) for one symbol (best-effort). Safe to call
 * unconditionally — used when a synthetic exit fires so the resting stop can't double-sell.
 */
export async function cancelBrokerProtectiveStop(
  userId: string,
  accountNumber: string,
  symbol: string,
  gateway: BrokerGateway,
  connectedAccountId?: string
): Promise<void> {
  const sym = normalizeSymbol(symbol);
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (normalizeSymbol(row.symbol) !== sym) continue;
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      deleteBrokerProtectiveStop(row.id, userId);
    } catch (err) {
      audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId, connectedAccountId);
      // Mark as pending_cancel in DB instead of deleting immediately, to retry later
      upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
    }
  }
}

export interface ReconcileResult {
  placed: number;
  cancelled: number;
  /**
   * Broker order ids this reconcile successfully cancelled (one per `cancelled` count). The caller
   * fetched its order list BEFORE reconcile ran, so these orders still look live in that list —
   * it must drop them before deciding whether a symbol is already protected, or a just-torn-down
   * stop suppresses synthetic registration and leaves the position with neither protection.
   */
  cancelledOrderIds: string[];
  /**
   * Normalized symbols this reconcile successfully PLACED a resting broker stop for (one per
   * `placed` count) — the mirror image of `cancelledOrderIds` for the same pre-reconcile-fetch
   * staleness: the caller's order list CANNOT contain these just-placed orders, so quantity-aware
   * coverage would undercount them. On a mismatch cancel/REPLACE tick that undercount is what let
   * the synthetic monitor register + fire against the pruned pre-replace coverage and then cancel
   * the fresh full-size replacement. The caller must treat these symbols as broker-covered for
   * THIS tick — both synthetic REGISTRATION and the FIRE path of already-registered rows (a fire
   * would sell shares the just-placed full-size stop covers, then cancel that stop after booking
   * the fill); the next tick's fresh order fetch sees the real resting order. ONLY full-position
   * placements are listed here — a PARTIAL placement goes in `partiallyPlacedStopSymbols` instead,
   * so suppressing registration can never leave the uncovered remainder stop-less for a tick.
   */
  placedStopSymbols: string[];
  /**
   * Symbols this reconcile placed a broker stop for covering only PART of the position (a
   * fractional remainder the native trailing lane floored away, or shares partially covered by
   * another live exit order). The caller's stale (pre-reconcile) order/coverage list can't see this
   * fresh order, so it must add `partiallyPlacedStopQuantities[symbol]` as KNOWN additional coverage
   * — never simply skip the synthetic fire path outright, or the uncovered remainder (e.g. the
   * fractional share a whole-share-only native trail floored away) is left completely unprotected
   * for the rest of this tick if a fresh quote already breaches the trail (Codex review, PR #1331).
   */
  partiallyPlacedStopSymbols: string[];
  /**
   * The exact quantity `reconcileBrokerProtectiveStops` just placed a resting stop for, keyed by
   * symbol, for every entry in `partiallyPlacedStopSymbols` — lets the caller treat that quantity as
   * known coverage THIS tick (on top of whatever `liveExitOrderCoverage` sees from the stale order
   * list) instead of blindly skipping the fire path for the whole position.
   */
  partiallyPlacedStopQuantities: Record<string, number>;
  /**
   * Symbols whose broker-held protective stop row was recovered THIS call specifically because the
   * tracked order was found already FILLED (not merely rejected/canceled/expired) — a fill that
   * actually reduced the position. The caller's `positions` snapshot was captured BEFORE `orders`
   * (synthetic-stops.ts fetches positions first), so it can still reflect the pre-fill quantity on
   * THIS same call. The caller must treat these symbols the same as `placedStopSymbols` — skip BOTH
   * synthetic registration and the fire path this tick — rather than auto-registering or firing a
   * market exit against a stale, larger-than-actual position (Codex review, PR #1331).
   */
  filledRecoverySymbols: string[];
}

/**
 * Reconcile broker-held protective stops against current positions. Cancels stops whose position has
 * closed (always), then — only when `running` — places a resting stop for each open long that lacks
 * one, of the kind `desiredBrokerStopKind` resolves for this account. No-op unless a lane is enabled.
 */
export async function reconcileBrokerProtectiveStops(args: {
  userId: string;
  policy: TradingPolicy;
  accountNumber: string;
  gateway: BrokerGateway;
  positions: EquityPosition[];
  executionMode: ExecutionMode;
  running: boolean;
  /**
   * The caller's freshly fetched broker order list (e.g. the synthetic-stop monitor's
   * `gateway.getEquityOrders` call earlier in the same tick). Two uses:
   *  - Section-1 pending_cancel recovery: a row whose cancel call keeps failing is cleared when
   *    the order shows up here already done resting (filled/rejected/canceled/expired) — "order
   *    not found" after an earlier cancel actually landed would otherwise retry forever and block
   *    re-placement. Absent-from-list or still-live stays ambiguous and keeps retrying.
   *  - Placement coverage: a position whose shares are already backed by another live exit-side
   *    order (an Alpaca OCO bracket stop leg, a manual GTC sell) gets its broker stop skipped or
   *    right-sized to the uncovered remainder — a second full-size sell for the same shares is at
   *    best a broker rejection and at worst a double-sell. Orders cancelled by THIS reconcile are
   *    pruned before the coverage check, so a just-replaced stop can't suppress its own
   *    replacement.
   * Optional and defaults to empty — a caller that omits it keeps the conservative behavior: rows
   * keep retrying, and placement sizes to the full position (protection over dedup — no coverage
   * info was ever meant to be available from this caller).
   */
  orders?: EquityOrder[];
  /**
   * Whether `orders` reflects a call to `gateway.getEquityOrders` that actually SUCCEEDED this
   * tick, as opposed to a caller that tried and failed (passing `orders: []` because the fetch
   * threw, not because the account genuinely has no open orders). Defaults to `true` so a caller
   * that never fetched at all (and so never had real coverage info to begin with) keeps the
   * original protection-over-dedup behavior. Set to `false` ONLY when a real fetch attempt failed
   * THIS tick: a failed fetch is not evidence of "nothing is resting" — full-size bracket legs or
   * another exit order could easily be live and simply invisible this tick. Placing (or resizing)
   * a broker-held stop against that blind spot risks stacking a second sell on shares another
   * order already commits, so coverage-dependent sizing (`uncoveredQuantity`) returns `null`
   * ("unknown, don't touch") instead of assuming full coverage-free, and BOTH section 3 (mismatch/
   * cancel) and section 4 (new placement) skip a symbol entirely rather than act on a guess
   * (Codex review, PR #1331).
   */
  ordersListed?: boolean;
  /**
   * The synthetic monitor's own already-tracked high-water mark per symbol (its
   * `synthetic_trailing_stops.extreme_price`), fetched by the caller BEFORE this reconcile. The
   * ratchet lane's trigger and the native lane's already-breached guard both anchor to
   * `max(mark, entry)` when this is absent — but if price rallied and pulled back, the app's own
   * trail already tracked the TRUE (higher, tighter) extreme, and reconstructing only from the
   * CURRENT mark silently arms a broker-held trail LOOSER than the one already protecting the
   * position (Codex review, PR #1331: avg 100, synthetic extreme 130, mark 120, 5% trail — the
   * app trigger is 123.50, but recomputing from max(120,100) would arm a broker stop around 114).
   * Optional; a symbol with no row yet (freshly registering) falls back to `max(mark, entry)`.
   */
  extremePriceBySymbol?: Record<string, number>;
  /**
   * Per-position stop PLANS (LLM-chosen stop TYPE, persisted at fill time), keyed by symbol —
   * fetched by the caller (synthetic-stops.ts, which already self-loads them). A plan can only
   * NARROW which of the account's own enabled lane(s) apply to that one symbol — it never invents
   * a broker capability the account doesn't otherwise have: "trailing" excludes the fixed lane for
   * that symbol; "fixed"/"atr" exclude the trailing lane; "none" excludes both (any existing
   * resting row for that symbol is torn down, mirroring the account-wide disabled teardown, so a
   * broker-held stop can never keep resting in silent contradiction of an owner/LLM "no stop"
   * choice). A symbol excluded from every kind the account has falls back to the always-on
   * synthetic monitor, which separately honors "trailing"/"none" unconditionally. Absent/"default"
   * → the account's own precedence for that symbol, unchanged from before this param existed.
   */
  stopPlanBySymbol?: Record<string, StopPlanStyle>;
}): Promise<ReconcileResult> {
  const { userId, policy, accountNumber, gateway, positions, executionMode, running, orders = [], ordersListed = true, extremePriceBySymbol = {}, stopPlanBySymbol = {} } = args;
  const out: ReconcileResult = { placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [], partiallyPlacedStopSymbols: [], partiallyPlacedStopQuantities: {}, filledRecoverySymbols: [] };

  const kind = desiredBrokerStopKind(policy, executionMode);
  const source: FillSource = executionMode === "broker/live" ? "live" : "paper";
  // Narrow the account-wide kind for one symbol per its own stop plan (never widen/invent beyond
  // what the account already has enabled — see the stopPlanBySymbol param doc above). An "atr" plan
  // deliberately never maps to the fixed lane here: this reconciler only knows the account's flat
  // `stopLossPct`, not the pinned per-symbol ATR distance (that's computed and applied entirely
  // within generateProactiveRiskProposals/enrichOpeningProposal in strategy.ts) — resting a
  // broker-held stop at the flat % would silently contradict the ATR distance the plan actually
  // pins. Narrowing to "never invent a mispriced broker stop" leaves the ATR plan's protection to
  // the always-on, correctly-priced synthetic monitor instead (Codex review, PR #1371).
  const kindForSymbol = (sym: string): "fixed" | "trailing" | null => {
    const plan = stopPlanBySymbol[sym] ?? "default";
    if (plan === "none" || plan === "atr") return null;
    // `kind` picks TRAILING first when an account has both lanes enabled (desiredBrokerStopKind's
    // own precedence) — so `kind === "trailing"` already correctly reflects trailing-lane
    // availability regardless of whether fixed is ALSO enabled. But that same precedence means an
    // account with BOTH lanes on reports `kind === "trailing"`, which would wrongly make a "fixed"
    // plan's `kind === "fixed"` check fail even though the fixed lane is independently enabled and
    // available — check that lane's own enablement directly instead of going through the
    // precedence-resolved `kind` (Codex review, PR #1371).
    if (plan === "trailing") return kind === "trailing" ? "trailing" : null;
    if (plan === "fixed") return brokerProtectiveStopsEnabled(policy, executionMode) ? "fixed" : null;
    return kind;
  };

  // A broker-held protective stop's tracked order was found FILLED at the broker (native trail or
  // ratcheted stop-market closing the position) before our own reconciliation ever saw it as a
  // pending exit — book the fill now, from the row's own recorded terms, so realized P&L/learning/
  // activity see this exit at all. Without this the row was simply deleted and the fill vanished
  // (Codex review, PR #1331).
  const bookBrokerHeldStopFill = (row: BrokerProtectiveStop, order: EquityOrder): void => {
    const qty = order.filledQuantity ?? row.quantity;
    const price = order.averagePrice ?? row.stopPrice;
    insertFillEvent({
      userId,
      accountNumber,
      source,
      executionMode,
      symbol: normalizeSymbol(row.symbol),
      side: "sell",
      quantity: qty,
      price,
      notional: qty * price,
      status: "filled",
      brokerOrderId: row.brokerOrderId,
      raw: { brokerHeldProtectiveStop: true, kind: row.kind }
    });
  };
  // A terminal order can still carry a positive filledQuantity even when its OVERALL state is
  // "canceled"/"expired"/"rejected", not literally "filled" — a stop that partially executes and
  // then dies (e.g. a canceled remainder) DID move some shares. Book on EITHER signal: the literal
  // "filled" state (kept for a mapper/mock that reports a full fill without ever populating
  // filledQuantity) OR a positive filledQuantity regardless of state — either alone missing the
  // other must still book, or an unbooked fill vanishes from P&L/learning/activity (Codex review,
  // PR #1331).
  const hadExecutedFill = (order: EquityOrder): boolean =>
    String(order.state ?? "").trim().toLowerCase() === "filled" || (order.filledQuantity ?? 0) > 0;

  // Symbols whose pending_cancel row section 1 just recovered THIS call specifically because the
  // order was found FILLED (not merely rejected/canceled/expired). A fill actually reduces the
  // position, but `positions` was captured by the caller (synthetic-stops.ts fetches it BEFORE
  // `orders`) — so if the fill lands broker-side in the gap between those two reads, `positions`
  // can still show the pre-fill quantity on THIS same call. Letting section 4 re-place immediately
  // would then use that stale quantity, resting a fresh sell stop sized for shares that are already
  // gone. Rejected/canceled/expired recoveries don't have this problem (the position never moved),
  // so only "filled" recoveries defer — placement resumes next call once a fresh position read is
  // in hand (the synthetic monitor still protects the position in the meantime).
  const filledRecoverySymbols = new Set<string>();

  // The flags gate only PLACEMENT of new stops — never CANCELLATION. When no lane is enabled any
  // more (flags off / not the applicable broker/environment / no configured %), any stop previously
  // placed is still resting live at the broker. Turning the feature off must TEAR THOSE DOWN, not
  // strand them: an orphaned GTC stop-market SELL would rest forever with no app-side cleanup and
  // could later sell shares the user no longer intends to protect this way. This teardown is pure
  // risk reduction (it never places a replacement), so the `liveReplaceBlocked` "never leave a
  // position unprotected" guard — which only matters when we cancel WITH intent to re-place — does
  // not apply here. If no rows exist, this is a true no-op (the common disabled/default case).
  if (kind === null) {
    for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
        // A successful cancel doesn't mean nothing filled first — a GTC stop can partially execute
        // before the cancel reaches the broker, and the broker still accepts the cancel for the
        // remainder. The caller's pre-reconcile order snapshot (`orders`) can still show that
        // partial fill; book it before the row disappears, or the executed shares never reach
        // fill_events/P&L/learning, and the caller isn't told the position may be stale (Codex
        // review, PR #1331, round 10).
        const preCancelOrder = orders.find((o) => o.id === row.brokerOrderId);
        if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
          const s = normalizeSymbol(row.symbol);
          out.filledRecoverySymbols.push(s);
          bookBrokerHeldStopFill(row, preCancelOrder);
        }
      } catch (err) {
        // The cancel failed — but that doesn't necessarily mean the order is still resting
        // broker-side. Mirror section 1's recovery: if the caller's freshly fetched order list shows
        // this order already done resting (most commonly FILLED — the stop did its job before our
        // own cancel attempt reached the broker), the row is stale bookkeeping, not a stuck cancel.
        // Without this check, a filled broker-held stop while the feature stays disabled would retry
        // its cancel FOREVER (kind stays null every tick) and its fill would never reach
        // fill_events/P&L/learning at all (Codex review, PR #1331).
        const found = orders.find((o) => o.id === row.brokerOrderId);
        if (found && isDoneRestingState(found.state)) {
          deleteBrokerProtectiveStop(row.id, userId);
          if (hadExecutedFill(found)) {
            // Signal this recovery to the caller the same way section 1/3 do: `positions` was
            // captured before `orders` this tick, so a fill discovered only here can still leave
            // the caller holding a stale (pre-fill) position snapshot for the rest of THIS tick —
            // it must skip synthetic registration/fire for the symbol, same as a live-lane fill
            // recovery (Codex review, PR #1331, round 10 — this branch previously booked the fill
            // but never told the caller).
            const s = normalizeSymbol(row.symbol);
            out.filledRecoverySymbols.push(s);
            bookBrokerHeldStopFill(row, found);
          }
          audit("broker_protective_stop_cancel_recovered", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "disabled_teardown" }, userId, policy.connectedAccountId);
        } else {
          audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err), context: "disabled_teardown" }, userId, policy.connectedAccountId);
          // Keep it as pending_cancel so a later tick retries the cancel rather than orphaning the
          // resting broker stop (listBrokerProtectiveStops returns pending_cancel rows, so the next
          // disabled reconcile re-attempts it).
          upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
        }
      }
    }
    return out;
  }

  const stopPct = policy.riskRules?.stopLossPct ?? 0;
  const trailPct = policy.riskRules?.trailingStopPct ?? 0;
  // Native trailing_stop orders exist only on the Alpaca REST lane. An `alpaca-mcp` account can be
  // configured with ONLY an MCP endpoint (no REST keys), and the gateway's trailing branch goes
  // REST-direct — so alpaca-mcp deliberately takes the ratcheted stop-market emulation through its
  // own MCP transport instead of failing placement every tick (Codex review, PR #1331).
  const nativeTrailing = policy.activeBroker === "alpaca";

  // Coverage-aware target quantity for a symbol's broker stop: the shares NOT already covered by
  // some OTHER live exit order (a bracket leg, a manual GTC sell, a resting take-profit trim).
  // Placing a stop for already-covered shares stacks more exit quantity than the account holds —
  // if both orders fill, the position is over-sold. Mirrors the synthetic fire path's
  // uncovered-remainder rule. `excludeOrderId` drops our OWN resting stop (the order a mismatch
  // replacement is about to cancel) from the count; orders this reconcile already cancelled are
  // dropped too. An unknowable order quantity counts as full coverage (failing toward
  // no-duplicate-sell). Without a caller-supplied order list, the full position quantity is used
  // (pre-coverage behavior — protection over dedup). Returns `null` — coverage genuinely UNKNOWN,
  // not "known to be zero" — when the caller attempted a real fetch this tick and it failed
  // (`ordersListed: false`): callers must treat `null` as "don't touch this symbol's broker-held
  // sizing at all", never as 0 or as full.
  const uncoveredQuantity = (pos: EquityPosition, sym: string, excludeOrderId?: string): number | null => {
    const full = Math.abs(pos.quantity);
    if (orders.length === 0) return ordersListed ? full : null;
    const cancelled = new Set(out.cancelledOrderIds);
    const cov = liveExitOrderCoverage(
      orders.filter((o) => !cancelled.has(o.id) && o.id !== excludeOrderId),
      sym,
      "long"
    );
    if (cov.unknownQty) return 0;
    return Math.max(full - cov.coveredQty, 0);
  };

  // Any Alpaca-family broker (REST native trailing_stop, or MCP's ratcheted stop_market emulation) —
  // both submit real Alpaca orders at gtc time-in-force. Alpaca's own fractional-trading docs require
  // time_in_force=day for a fractional stop/stop-limit order; this reconciler always sends gtc, so a
  // fractional quantity risks a broker rejection that would leave even the whole-share portion with
  // no broker-held protection (Codex review, PR #1331/#1371). Flooring to whole shares on EITHER
  // Alpaca transport — not just the native REST lane — sidesteps that entirely; the fractional
  // remainder still gets synthetic monitor coverage, same as the native lane already relied on.
  const isAlpacaFamily = policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp";

  // The share quantity a broker-held stop of this kind should cover: the uncovered remainder,
  // floored to whole shares on any Alpaca trailing lane — the synthetic monitor's quantity-aware
  // coverage picks up any remainder. `null` propagates from uncoveredQuantity unchanged — "coverage
  // unknown this tick", not "zero".
  const desiredStopQuantity = (pos: EquityPosition, sym: string, forKind: "fixed" | "trailing", excludeOrderId?: string): number | null => {
    const qty = uncoveredQuantity(pos, sym, excludeOrderId);
    if (qty === null) return null;
    return forKind === "trailing" && isAlpacaFamily ? Math.floor(qty) : qty;
  };

  // Trailing trigger for the ratcheted (non-native) lane: trailingStopPct below the high-water
  // mark. The observable extreme is max(current mark, entry, the synthetic monitor's OWN
  // already-tracked extreme for this symbol) — falling back to max(mark, entry) only when no
  // synthetic row exists yet. Using the real tracked extreme (not reconstructing from the current
  // mark alone) means enabling broker-held trailing can never arm a LOOSER trigger than the trail
  // already protecting the position after a rally-then-pullback. Only ever ratchets UP (section 3).
  const trailingTriggerPrice = (pos: EquityPosition, sym: string): number => {
    const mark = pos.marketValue / pos.quantity;
    const trackedExtreme = extremePriceBySymbol[sym] ?? 0;
    return round2(Math.max(mark, pos.averageCost, trackedExtreme) * (1 - trailPct / 100));
  };

  // Whether a broker-held TRAILING stop at `stopPrice` may be armed for this symbol right now
  // without being LOOSER than the app-defined trail already protecting the position (Codex review,
  // PR #1331, three rounds):
  //  - Native lane (Alpaca): the broker seeds its trail from the CURRENT mark, not from history —
  //    so it may only be placed when the mark is at/above BOTH entry and the app's own tracked
  //    high-water mark (a pullback from either would make the native trail's starting point, and
  //    therefore its trigger, looser than the app's).
  //  - Ratcheted lane: the trigger is an explicit price computed from the SAME tracked extreme, so
  //    it only fails when actually already breached (trigger at/above the mark).
  // Shared by section 3 (must not cancel an existing stop into a replacement that would be refused
  // here — that would strand the position with neither) and section 4 (the actual placement gate).
  const canArmTrailingNow = (pos: EquityPosition, sym: string, stopPrice: number): boolean => {
    const mark = pos.marketValue / pos.quantity;
    const trackedExtreme = extremePriceBySymbol[sym] ?? 0;
    return nativeTrailing ? mark >= Math.max(pos.averageCost, trackedExtreme) : stopPrice < mark;
  };

  // Long positions only: Robinhood is long-only, and the trailing lane deliberately starts with
  // longs too — Alpaca shorts keep the synthetic monitor's trailing coverage (a short's broker-held
  // trail is a follow-up; note it in the rollout doc before extending). Computed UP FRONT
  // (before any cancel) so the guards below know which positions are still open.
  const liveLongs = new Map<string, EquityPosition>();
  for (const p of positions) {
    if (p.quantity > 0.000001) liveLongs.set(normalizeSymbol(p.symbol), p);
  }
  // Would a live REPLACEMENT stop be blocked (broker/live without ALLOW_LIVE_TRADING)? If so, we must
  // not cancel an OPEN position's only stop with no replacement — that would leave it unprotected.
  // Cancels for CLOSED positions stay risk-reducing and are never blocked.
  const liveReplaceBlocked = livePreflightBlocks({ mode: executionMode });

  // 1. Retry pending cancellations first — but for a STILL-OPEN position, skip the retry when a
  //    replacement can't be placed (keep its existing stop rather than orphaning the position).
  //    EXCEPT when the symbol's CURRENT plan excludes every lane the account has (kindForSymbol
  //    returns null, e.g. "none", or a scale-in that switched lanes) — that row was never going to
  //    be replaced regardless of liveReplaceBlocked (section 2b tears it down unconditionally), so
  //    blocking its retry here just leaves a plan-contradicting stop resting indefinitely while live
  //    placement happens to be disabled (Codex review, PR #1371).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") {
      const rowSym = normalizeSymbol(row.symbol);
      if (liveReplaceBlocked && liveLongs.has(rowSym) && kindForSymbol(rowSym) !== null) continue;
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        // The cancel call itself failed — but that doesn't necessarily mean the order is still
        // resting broker-side (e.g. a prior cancel attempt actually landed and this one is just
        // "order not found", or the stop simply filled before the cancel reached the broker).
        // Check the caller's freshly fetched order list: if the order shows up there in a state
        // that's done resting (filled/rejected/canceled/expired), the row is stale bookkeeping —
        // delete it so section 4 can re-place for the symbol. A rejected/canceled/expired order
        // never moved the position, so that re-place resumes in THIS SAME call; a filled order DID
        // move the position, so filledRecoverySymbols below makes section 4 defer that one case to
        // the next call instead (see its comment). If the order is ABSENT from the list or still
        // live, stay conservative and keep retrying next tick
        // (an absent order is ambiguous, not confirmed dead — see broker-protective-stops.ts's
        // module doc and the section-4 "never orphan a possibly-still-live stop" guard).
        const found = orders.find((o) => o.id === row.brokerOrderId);
        if (found && isDoneRestingState(found.state)) {
          deleteBrokerProtectiveStop(row.id, userId);
          // A partial fill DID move shares even when the order's overall terminal state is
          // canceled/expired/rejected (not literally "filled") — book it, and defer section 4's
          // replacement sizing to the next call the same way a full fill does (Codex review, PR
          // #1331).
          if (hadExecutedFill(found)) {
            const s = normalizeSymbol(row.symbol);
            filledRecoverySymbols.add(s);
            out.filledRecoverySymbols.push(s);
            bookBrokerHeldStopFill(row, found);
          }
          audit(
            "broker_protective_stop_cancel_recovered",
            { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err) },
            userId,
            policy.connectedAccountId
          );
        } else {
          // Keep it in DB as pending_cancel to retry on the next tick
          console.error(`[protective-stops] retry cancel failed for ${row.symbol} order ${row.brokerOrderId}:`, err);
        }
      }
    }
  }

  // 2. Cancel-on-close (runs regardless of `running` — cancelling is always risk-reducing).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    if (!liveLongs.has(normalizeSymbol(row.symbol))) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
        // Mark as pending_cancel to retry later
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  // 2b. Per-symbol plan-excluded teardown (still cancel-only — runs regardless of `running` or
  // `liveReplaceBlocked`, same as section 2). Sections 3/4 below are gated behind `running` because
  // they PLACE/replace orders, but a position whose plan now excludes every lane the account has
  // enabled — via `kindForSymbol` returning null, e.g. "none", or a scale-in switching a resting
  // Robinhood fixed stop to "trailing"/"atr" — must not keep that old broker-held stop resting while
  // the system is Stopped or live placement is disabled. That contradicts the newly selected plan
  // regardless of whether the app happens to be running this tick (Codex review, PR #1371 — this
  // originally only checked literal "none"; broadened to match section 3's `symKind === null` gate).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    const sym = normalizeSymbol(row.symbol);
    if (!liveLongs.has(sym)) continue; // already torn down above (position closed)
    if (kindForSymbol(sym) !== null) continue;
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      deleteBrokerProtectiveStop(row.id, userId);
      out.cancelled++;
      out.cancelledOrderIds.push(row.brokerOrderId);
      // A successful cancel doesn't mean nothing filled first — mirror every other cancel path in
      // this reconciler: check the caller's pre-reconcile order snapshot for an executed fill before
      // this row disappears (Codex review, PR #1371).
      const preCancelOrder = orders.find((o) => o.id === row.brokerOrderId);
      if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
        filledRecoverySymbols.add(sym);
        out.filledRecoverySymbols.push(sym);
        bookBrokerHeldStopFill(row, preCancelOrder);
      }
    } catch (err) {
      // The cancel failed — check whether the broker already terminated the order (most likely it
      // FILLED before our cancel reached the broker), same recovery as every other cancel path here.
      const found = orders.find((o) => o.id === row.brokerOrderId);
      if (found && isDoneRestingState(found.state)) {
        deleteBrokerProtectiveStop(row.id, userId);
        if (hadExecutedFill(found)) {
          filledRecoverySymbols.add(sym);
          out.filledRecoverySymbols.push(sym);
          bookBrokerHeldStopFill(row, found);
        }
        audit("broker_protective_stop_cancel_recovered", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "plan_excluded_teardown" }, userId, policy.connectedAccountId);
      } else {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err), context: "plan_excluded_teardown" }, userId, policy.connectedAccountId);
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  if (!running) return out;

  // Live placement explicitly disabled (ALLOW_LIVE_TRADING=false escape hatch): sections 3 and 4
  // both exist to (re)place broker orders, which the preflight guard would refuse — mismatch
  // replacement already no-ops via `liveReplaceBlocked`, and NEW placements must not slip through
  // either (the default-on Alpaca trailing lane made this reachable; Codex review, PR #1331).
  // Sections 1–2 above are pure risk-reducing cancels and deliberately still ran.
  if (liveReplaceBlocked) return out;

  // 3. Mismatch detection: if the stop's KIND no longer matches the account's desired kind, or its
  // quantity / price / trail has drifted, cancel the existing stop. On the same pass, section 4
  // re-places it with correct values. This is a cancel-THEN-place: if the re-place would be blocked
  // (`liveReplaceBlocked`, computed above), skip the cancel so we KEEP the existing
  // (slightly-mismatched) protective stop rather than orphaning the position.
  //
  // Kind-specific drift rules:
  //  - fixed: entry-anchored target stop price (as before).
  //  - trailing, native (Alpaca): the broker moves the trigger itself — only a changed trail % or
  //    quantity forces a replace; never reprice from here.
  //  - trailing, ratcheted (Robinhood): recompute the trigger from the current mark each tick and
  //    replace only when it moved UP meaningfully (≥ $0.02 and ≥ 0.1% of the resting trigger — a
  //    churn guard, so a flat tape doesn't cancel-replace every tick). A falling mark never lowers
  //    the trigger: that is the ratchet.
  const existingStops = listBrokerProtectiveStops(accountNumber, userId);
  // Backfill a missing tracked extreme from the resting stop's OWN recorded terms, for any symbol
  // the synthetic monitor never independently tracked. This is the common case for a NATIVE trailing
  // stop that covers the WHOLE position: full broker coverage suppresses synthetic registration
  // entirely (by design — the position is already protected), so `extremePriceBySymbol[sym]` is
  // simply absent, not genuinely zero. Without this, a later mismatch (trail % or quantity change)
  // would seed a REPLACEMENT trail from today's current mark — potentially far looser than the
  // broker's own already-ratcheted-up trigger if price rallied and pulled back since the original
  // placement (e.g. entry 100, rallied to 130, pulled back to 126, trail 5% — canArmTrailingNow with
  // trackedExtreme=0 wrongly allows a reseed at 126 instead of keeping the 123.50 the broker's real
  // peak implies). `stopPrice` records the trigger the trail STARTED (or last ratcheted) from, which
  // only ever moves UP — inverting `stopPrice = startPeak * (1 - trailPercent/100)` yields a
  // mathematically sound LOWER BOUND on the broker's true current high-water mark (Codex review, PR
  // #1331). A synthetic row's OWN tracked extreme, when present, is trusted as-is (it's independently
  // observed, not derived).
  for (const stop of existingStops) {
    if (stop.kind !== "trailing" || !(stop.trailPercent && stop.trailPercent > 0)) continue;
    const sym = normalizeSymbol(stop.symbol);
    if (extremePriceBySymbol[sym]) continue;
    let impliedExtreme = stop.stopPrice / (1 - stop.trailPercent / 100);
    // The DB row's `stopPrice` is written ONCE at placement for a NATIVE trailing stop (it records
    // the trigger the trail STARTED from) and is never repriced while the broker silently ratchets
    // its own trigger upward — so a stop placed at entry and then left alone through a rally pins
    // this reconstruction at ~entry while the broker's real high-water mark has climbed far above.
    // The caller's freshly fetched order list carries the broker's CURRENT reported trigger for the
    // still-resting order (`EquityOrder.stopPrice` — "Stop trigger price as the broker reports it",
    // Alpaca `stop_price`); invert THAT the same way and take the max, so the reconstructed extreme
    // reflects the broker's true, continuously-updated peak instead of only the placement-time mark.
    // Max-only: it can only make canArmTrailingNow MORE restrictive (keep the tighter stop), never
    // loosen protection; it falls back cleanly to the row-derived bound when the order is absent
    // (e.g. a failed fetch left `orders` empty). Codex review, PR #1331.
    const liveOrder = orders.find((o) => o.id === stop.brokerOrderId);
    if (liveOrder && typeof liveOrder.stopPrice === "number" && liveOrder.stopPrice > 0) {
      const orderImpliedExtreme = liveOrder.stopPrice / (1 - stop.trailPercent / 100);
      if (Number.isFinite(orderImpliedExtreme) && orderImpliedExtreme > 0) {
        impliedExtreme = Math.max(impliedExtreme, orderImpliedExtreme);
      }
    }
    if (Number.isFinite(impliedExtreme) && impliedExtreme > 0) extremePriceBySymbol[sym] = impliedExtreme;
  }
  for (const [sym, pos] of liveLongs) {
    const existingStop = existingStops.find((r) => normalizeSymbol(r.symbol) === sym);
    const symKind = kindForSymbol(sym);
    if (symKind === null) {
      // This symbol's own stop plan excludes every lane the account currently has enabled (a
      // "none" plan, or a plan — e.g. "trailing" — that doesn't match the account's only active
      // lane). Any existing resting row for it is torn down unconditionally, the same as the
      // account-wide disabled teardown: it must never keep resting in silent contradiction of the
      // owner/LLM's own choice for this position. The always-on synthetic monitor (which honors
      // "trailing"/"none" per-symbol directly) remains this position's actual protection.
      if (existingStop && existingStop.status === "resting") {
        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          deleteBrokerProtectiveStop(existingStop.id, userId);
          out.cancelled++;
          out.cancelledOrderIds.push(existingStop.brokerOrderId);
          // A successful cancel doesn't mean nothing filled first — mirror the account-wide disabled
          // teardown's handling: check the caller's pre-reconcile order snapshot for an executed fill
          // before this row disappears, or the executed shares never reach fill_events/P&L/learning,
          // and the caller isn't told the position snapshot may be stale (Codex review, PR #1371).
          const preCancelOrder = orders.find((o) => o.id === existingStop.brokerOrderId);
          if (preCancelOrder && hadExecutedFill(preCancelOrder)) {
            filledRecoverySymbols.add(sym);
            out.filledRecoverySymbols.push(sym);
            bookBrokerHeldStopFill(existingStop, preCancelOrder);
          }
          audit("broker_protective_stop_mismatch", { symbol: sym, note: "per-position stop plan excludes this account's enabled broker-held lane(s)", kind: null }, userId, policy.connectedAccountId);
        } catch (err) {
          // The cancel failed — check whether the broker already terminated the order (most likely
          // it FILLED before our cancel reached the broker), same recovery as every other cancel path
          // in this reconciler (Codex review, PR #1371).
          const found = orders.find((o) => o.id === existingStop.brokerOrderId);
          if (found && isDoneRestingState(found.state)) {
            deleteBrokerProtectiveStop(existingStop.id, userId);
            if (hadExecutedFill(found)) {
              filledRecoverySymbols.add(sym);
              out.filledRecoverySymbols.push(sym);
              bookBrokerHeldStopFill(existingStop, found);
            }
            audit("broker_protective_stop_cancel_recovered", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, brokerState: found.state, error: errMsg(err), context: "per_symbol_plan_teardown" }, userId, policy.connectedAccountId);
          } else {
            audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err), context: "per_symbol_plan_teardown" }, userId, policy.connectedAccountId);
            upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
          }
        }
      }
      continue;
    }
    if (existingStop && existingStop.status === "resting") {
      // The broker order this row tracks may already be done resting (filled naturally, or
      // rejected/canceled/expired outside our own cancel path) without the row ever going through
      // section 1's cancel-recovery — e.g. a partial stop that FILLS on its own while the position
      // stays open. Treating a "resting" row as still live when the tracked order is actually gone
      // means a coincidental non-mismatch (recomputed qty/price happen to still match the stale
      // row) never gets caught, and the ghost row then blocks section 4 from placing a real
      // replacement for the (now differently-covered) remaining shares (Codex review, PR #1331).
      // Only ACT on positive evidence from a real fetch — an order absent from the list, or
      // `orders` empty from a failed fetch, stays ambiguous and falls through to the mismatch
      // checks below unchanged.
      const trackedOrder = orders.find((o) => o.id === existingStop.brokerOrderId);
      if (trackedOrder && isDoneRestingState(trackedOrder.state)) {
        deleteBrokerProtectiveStop(existingStop.id, userId);
        // A partial fill DID move shares even when the tracked order's overall terminal state is
        // canceled/expired/rejected, not literally "filled" (Codex review, PR #1331).
        if (hadExecutedFill(trackedOrder)) {
          filledRecoverySymbols.add(sym);
          out.filledRecoverySymbols.push(sym);
          bookBrokerHeldStopFill(existingStop, trackedOrder);
        }
        audit(
          "broker_protective_stop_recovered",
          { symbol: sym, brokerOrderId: existingStop.brokerOrderId, brokerState: trackedOrder.state, context: "stale_resting_row" },
          userId,
          policy.connectedAccountId
        );
        continue;
      }
      // The tracked order is actively EXECUTING at the broker right now (partial fill in
      // progress) — never cancel it into a quantity-drift "replacement": the broker may refuse
      // the cancel outright (order already filling), or accept it and abort the remainder of an
      // exit that was already correctly working, leaving those shares covered only by whatever
      // the (possibly stale) synthetic monitor can see until conditions recover (Codex review, PR
      // #1331). The row is left exactly as-is; once the fill settles to a terminal state this
      // same check on a later tick either recovers it (isDoneRestingState, above) or the drift
      // check runs cleanly against the final position size.
      if (trackedOrder && String(trackedOrder.state ?? "").trim().toLowerCase() === "partially_filled") {
        audit("broker_protective_stop_skipped", {
          symbol: sym, kind: symKind, note: "tracked order is partially filled and actively executing at the broker — leaving it resting rather than cancelling into an uncertain in-flight state"
        }, userId, policy.connectedAccountId);
        continue;
      }
      const qty = desiredStopQuantity(pos, sym, symKind, existingStop.brokerOrderId);
      // Coverage from OTHER live exit orders is unknown this tick (a real order-list fetch
      // failed) — do not treat that as evidence of drift on its own. But whether the row's OWN
      // recorded quantity now exceeds the CURRENT position size needs no order-list data at all:
      // if the position has shrunk (e.g. a partial exit filled elsewhere) below the resting stop's
      // quantity, firing it could sell more shares than the account holds (or open an unintended
      // short) — a risk that doesn't wait for the next successful order fetch to resolve. Cancel
      // that oversized row now (letting the always-on synthetic monitor cover the gap until a
      // later tick can size a proper replacement); only a resize that would depend on OTHER
      // orders' coverage stays deferred (Codex review, PR #1331).
      if (qty === null) {
        const posQty = Math.abs(pos.quantity);
        if (existingStop.quantity > posQty + 0.000001 && !liveReplaceBlocked) {
          try {
            await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
            deleteBrokerProtectiveStop(existingStop.id, userId);
            out.cancelled++;
            out.cancelledOrderIds.push(existingStop.brokerOrderId);
            audit("broker_protective_stop_mismatch", {
              symbol: sym,
              note: "existing stop quantity exceeds current position size (other-order coverage unknown this tick)",
              kind: symKind,
              oldQty: existingStop.quantity,
              newQty: posQty
            }, userId, policy.connectedAccountId);
          } catch (err) {
            audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
            upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
          }
        } else {
          audit("broker_protective_stop_skipped", { symbol: sym, kind: symKind, note: "order list unavailable this tick — leaving the existing broker-held stop untouched rather than resizing on unknown coverage" }, userId, policy.connectedAccountId);
        }
        continue;
      }
      // Where section 4 would place this stop's trigger today (informational for native trailing —
      // the broker moves that trigger itself).
      const newStopPrice = symKind === "fixed" ? round2(pos.averageCost * (1 - stopPct / 100)) : trailingTriggerPrice(pos, sym);

      let mismatchNote: string | undefined;
      if (existingStop.kind !== symKind) {
        mismatchNote = `stop kind ${existingStop.kind} -> ${symKind}`;
      } else if (Math.abs(existingStop.quantity - qty) > 0.000001) {
        mismatchNote = "quantity drift";
      } else if (symKind === "fixed") {
        if (Math.abs(existingStop.stopPrice - newStopPrice) > 0.02) mismatchNote = "stop price drift";
      } else if (Math.abs((existingStop.trailPercent ?? 0) - trailPct) > 0.0001) {
        mismatchNote = `trail % ${existingStop.trailPercent ?? 0} -> ${trailPct}`;
      } else if (!nativeTrailing && newStopPrice - existingStop.stopPrice >= Math.max(0.02, existingStop.stopPrice * 0.001)) {
        mismatchNote = `trail ratchet ${existingStop.stopPrice} -> ${newStopPrice}`;
      }

      // A trailing mismatch must not be cancelled unless section 4 would actually be able to
      // replace it THIS pass — otherwise the cancel succeeds, the replacement guard then refuses
      // (mark below entry/tracked extreme, or already breached), and the position is left with NO
      // broker-held stop until conditions recover (Codex review, PR #1331). Keep the
      // slightly-mismatched stop resting instead; it's still real protection. EXCEPT a pure
      // quantity SHRINK: the row is oversized relative to what's actually still uncovered (e.g.
      // another known live exit order now covers part of the position), so the old full-size stop
      // is not just non-ideal but actively stacks on top of that other order — if both can fill,
      // the account gets over-sold. Cancelling never needs to "arm" anything (it only removes
      // exposure), so this case bypasses the arm-gate and cancels below regardless; section 4's own
      // canArmTrailingNow gate still decides, independently, whether a resize replacement can be
      // placed this same tick (Codex review, PR #1331).
      const isQuantityShrink = mismatchNote === "quantity drift" && qty < existingStop.quantity;
      if (mismatchNote && symKind === "trailing" && !isQuantityShrink && !canArmTrailingNow(pos, sym, newStopPrice)) {
        audit("broker_protective_stop_skipped", {
          symbol: sym, kind: symKind, note: `mismatch (${mismatchNote}) detected but the replacement would be refused this tick — keeping the existing stop rather than cancelling into no protection`
        }, userId, policy.connectedAccountId);
        mismatchNote = undefined;
      }

      if (mismatchNote && !liveReplaceBlocked) {
        audit("broker_protective_stop_mismatch", {
          symbol: sym,
          note: mismatchNote,
          kind: symKind,
          oldQty: existingStop.quantity,
          newQty: qty,
          oldStopPrice: existingStop.stopPrice,
          newStopPrice
        }, userId, policy.connectedAccountId);

        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          deleteBrokerProtectiveStop(existingStop.id, userId);
          out.cancelled++;
          out.cancelledOrderIds.push(existingStop.brokerOrderId);
        } catch (err) {
          audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId, policy.connectedAccountId);
          upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
        }
      }
    }
  }

  // 4. Place-if-missing for each open long without a stop row. A pending_cancel row BLOCKS
  // placement for its symbol: its broker order may still be live (the cancel keeps failing), and
  // placing a replacement would upsert a new broker_order_id over the row (UNIQUE
  // user/account/symbol), orphaning the old still-live full-size GTC stop with no tracking and no
  // retry — two resting sell stops, one invisible. The section-1 retry keeps re-attempting the
  // cancel; placement resumes on the tick after it succeeds (and until then the old stop itself is
  // still protecting the position).
  const currentStops = listBrokerProtectiveStops(accountNumber, userId);
  const existing = new Set(currentStops.map((r) => normalizeSymbol(r.symbol)));

  for (const [sym, pos] of liveLongs) {
    if (existing.has(sym)) continue;
    const symKind = kindForSymbol(sym);
    // This symbol's own stop plan excludes every lane the account currently has enabled (a "none"
    // plan, or a plan that doesn't match the account's only active lane) — never place a
    // broker-held stop for it; the synthetic monitor is this position's actual protection.
    if (symKind === null) continue;
    // Section 1 just recovered this symbol's row THIS call via a FILLED order — `positions` may not
    // yet reflect that fill (see the filledRecoverySymbols comment above). Defer to the next call's
    // fresh position read rather than risk sizing a replacement off a stale (pre-fill) quantity.
    if (filledRecoverySymbols.has(sym)) continue;
    if (!(pos.averageCost > 0)) continue;
    // The uncovered remainder (coverage-aware — never stack exit quantity on top of a live bracket
    // leg / manual sell; the just-cancelled replacement's own order is pruned inside), floored to
    // whole shares on the native trailing lane. `null` means a real order-list fetch failed this
    // tick — coverage is UNKNOWN, not zero; placing here could double up on shares another,
    // invisible-this-tick order already commits, so skip entirely and let the synthetic monitor
    // (which is quantity-aware against whatever it CAN see, and fails safe otherwise) cover the
    // tick (Codex review, PR #1331). Zero (list fetched fine, just fully covered/sub-share) is a
    // normal, confident skip.
    const qty = desiredStopQuantity(pos, sym, symKind);
    if (qty === null) {
      audit("broker_protective_stop_skipped", { symbol: sym, kind: symKind, note: "order list unavailable this tick — coverage unknown, deferring placement to the synthetic monitor rather than guessing" }, userId, policy.connectedAccountId);
      continue;
    }
    if (!(qty > 0)) {
      audit("broker_protective_stop_skipped", {
        symbol: sym,
        kind: symKind,
        note: "no uncovered whole shares — other live exit orders (or sub-share size) cover this position; the synthetic monitor covers any remainder"
      }, userId, policy.connectedAccountId);
      continue;
    }
    const stopPrice = symKind === "fixed" ? round2(pos.averageCost * (1 - stopPct / 100)) : trailingTriggerPrice(pos, sym);
    if (!(stopPrice > 0)) continue;
    // Never arm a broker trail that would be LOOSER than the app-defined one (Codex review, PR
    // #1331, three rounds — see canArmTrailingNow's doc comment for the native-vs-ratcheted logic).
    if (symKind === "trailing" && !canArmTrailingNow(pos, sym, stopPrice)) {
      const mark = pos.marketValue / pos.quantity;
      audit("broker_protective_stop_skipped", {
        symbol: sym,
        kind: symKind,
        stopPrice,
        mark,
        trackedExtreme: extremePriceBySymbol[sym],
        note: nativeTrailing
          ? "mark below entry or the app's tracked high-water mark — a native broker trail would seed from the depressed market and be looser than the app's own trail; the synthetic monitor keeps covering until the mark recovers"
          : "trail already breached at placement — leaving the exit to the synthetic monitor instead of arming a fresh, lower broker trail"
      }, userId, policy.connectedAccountId);
      continue;
    }
    const refId = `protstop-${userId}-${accountNumber}-${sym}-${Date.now()}`;
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: sym,
        side: "sell",
        type: "stop_market",
        quantity: qty,
        // Native trailing (Alpaca): the gateway translates trailPercent to a trailing_stop order
        // and the broker computes/moves the trigger itself — sending a stopPrice would be rejected.
        // Ratcheted trailing (Robinhood) and fixed stops rest at an explicit trigger.
        stopPrice: symKind === "trailing" && nativeTrailing ? undefined : stopPrice,
        trailPercent: symKind === "trailing" && nativeTrailing ? trailPct : undefined,
        timeInForce: "gtc",
        marketHours: "regular_hours",
        refId
      });
      if (isRejectedOrCanceledState(exec.state)) {
        // A non-throwing placement can still be a synchronous rejection/cancellation (same trap as
        // the synthetic exit path in synthetic-stops.ts). No stop is resting at the broker: don't
        // record a row (a dead "resting" row would block re-placement here on every later tick —
        // section 3 sees no qty/price mismatch on it, and `existing` above blocks section 4) and
        // don't advertise the symbol via placedStopSymbols (that would suppress this tick's
        // synthetic registration for protection that doesn't exist).
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, orderId: exec.orderId, error: `broker declined the protective stop (state: ${exec.state})` }, userId, policy.connectedAccountId);
        continue;
      }
      if (!exec.orderId) {
        // No broker order id means we couldn't later cancel it — don't record an untrackable stop.
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: "broker returned no order id" }, userId, policy.connectedAccountId);
        continue;
      }
      upsertBrokerProtectiveStop({
        id: `protstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        brokerOrderId: exec.orderId,
        quantity: qty,
        // For native trailing this records the trigger the trail STARTED from (the broker moves the
        // real one); for fixed/ratcheted stops it is the actual resting trigger.
        stopPrice,
        status: "resting",
        kind: symKind,
        trailPercent: symKind === "trailing" ? trailPct : undefined
      });
      out.placed++;
      if (qty >= Math.abs(pos.quantity) - 0.000001) out.placedStopSymbols.push(sym);
      else {
        out.partiallyPlacedStopSymbols.push(sym);
        out.partiallyPlacedStopQuantities[sym] = qty;
      }
      audit("broker_protective_stop_placed", { symbol: sym, kind: symKind, stopPrice, trailPercent: symKind === "trailing" ? trailPct : undefined, quantity: qty, positionQuantity: Math.abs(pos.quantity), brokerOrderId: exec.orderId }, userId, policy.connectedAccountId);
    } catch (err) {
      audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: errMsg(err) }, userId, policy.connectedAccountId);
    }
  }
  return out;
}
