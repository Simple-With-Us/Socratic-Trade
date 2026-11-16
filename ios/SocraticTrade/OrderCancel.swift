import Foundation

/// Phone-side cancel of a WORKING broker order, submitted through the `order.cancel` mobile
/// command (src/lib/mobile-api.ts -> `cancelWorkingOrder` in src/lib/order-cancel.ts — the same
/// implementation the web console's POST /api/orders/cancel runs).
///
/// **Contract this file is written against** (quoted from the server):
/// - `case "order.cancel": { const orderId = requireString(payload, "orderId", 128); … const
///   accountNumber = asOptionalString(payload.accountNumber, 64); return accountNumber ?
///   { orderId, accountNumber } : { orderId }; }`
/// - `accountNumber` is the STALE-VIEW GUARD, verified server-side: "A caller that names a
///   different account is refused outright rather than silently re-pointed."  The phone always
///   sends the account number the snapshot it is rendering was taken from, so a cancel queued
///   while looking at account A can never land on account B.
/// - The command runs immediately (it is in `IMMEDIATE_MOBILE_COMMAND_TYPES`), so the POST
///   answers with a terminal command rather than a queued one — the ordinary `store.submit`
///   path already handles both.
///
/// **Ceremony**: none beyond the confirmation dialog, which is the same weight the alert-delete
/// row already carries.  Cancelling is risk-reducing — it prevents an execution rather than
/// causing one — and the console deliberately requires no typed confirmation for it even on a
/// live brokerage account.  Do not add one here.
enum OrderCancellation {
    static let commandType = "order.cancel"

    /// Mirror of `ACTIVE_BROKER_ORDER_STATES` (src/lib/broker-held-orders.ts).  Kept as a
    /// literal set rather than a "not terminal" heuristic so a broker state nobody has seen
    /// before is treated as un-cancellable instead of being offered on a guess.
    static let activeBrokerOrderStates: Set<String> = [
        "accepted",
        "accepted_for_bidding",
        "confirmed",
        "held",
        "new",
        "open",
        "partially_filled",
        "pending",
        "pending_cancel",
        "pending_new",
        "pending_replace",
        "queued",
        "submitted",
        "suspended",
        "unconfirmed"
    ]

    /// Mirror of `EXTRA_WORKING_ORDER_STATES` (same file): states outside the active set that
    /// can still fill.  `done_for_day` is deliberately NOT here — it is a terminal day-order
    /// outcome that Alpaca returns forever in order history, and counting it as working is what
    /// made the web Orders screen once show hundreds of finished orders as pending.
    static let extraWorkingOrderStates: Set<String> = ["stopped", "calculated"]

    /// Exact mirror of the server's `isWorkingOrderState`, which is also the precondition
    /// `cancelWorkingOrder` enforces for this lane (`requireWorkingOrder: true`):
    ///
    ///     } else if (!isWorkingOrderState(lookup.order.state)) {
    ///       throw new OrderCancelPreconditionError(
    ///         `That order is no longer working (${lookup.order.state}).  There is nothing left
    ///          to cancel.`, 409);
    ///
    /// Offering the control exactly where the server would accept it is the whole point: a
    /// Cancel button on a filled order is a lie, and a missing one on a resting limit is a
    /// missing lever.
    static func isWorkingState(_ state: String?) -> Bool {
        let normalized = (state ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return activeBrokerOrderStates.contains(normalized) || extraWorkingOrderStates.contains(normalized)
    }

    /// Whether this row may offer Cancel.
    ///
    /// `/api/mobile/snapshot` already filters `orders` through the same predicate
    /// (`orders: snapshot.orders.filter(o => isWorkingOrderState(o.state))`), so on a current
    /// server every listed order passes.  The check is repeated here because the app also
    /// renders a snapshot restored from its UserDefaults cache, which can predate that filter,
    /// and because an order id is not enough to know a state is cancellable.
    ///
    /// `pending_cancel` stays cancellable on purpose, matching the console: a broker cancel that
    /// is stuck in that state is a real reason to ask again, not a reason to remove the lever.
    static func isCancellable(_ order: EquityOrder) -> Bool {
        !order.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && isWorkingState(order.state)
    }

    /// One in-flight cancel per order — the busy guard and the idempotency key are both keyed
    /// off this, so a double tap re-uses the first attempt's key instead of asking the broker
    /// twice.
    static func operationID(orderId: String) -> String {
        "\(commandType):\(orderId)"
    }

    /// `accountNumber` is omitted when the snapshot has no selected account rather than sent
    /// empty: the server treats an empty string as "no expectation" anyway, and a blank field
    /// would misrepresent a guard the phone did not actually assert.
    static func payload(orderId: String, accountNumber: String?) -> [String: Any] {
        var payload: [String: Any] = ["orderId": orderId]
        let account = (accountNumber ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !account.isEmpty {
            payload["accountNumber"] = account
        }
        return payload
    }

    /// Unfilled remainder — what a cancel would actually stop.  Mirrors `remainingQuantity`
    /// (app/console/orders/lib.ts).  Nil for a dollar-based order, which carries no share count.
    static func remainingQuantity(_ order: EquityOrder) -> Double? {
        guard let quantity = order.quantity else { return nil }
        return max(quantity - (order.filledQuantity ?? 0), 0)
    }

    static func confirmationTitle(_ order: EquityOrder) -> String {
        "Cancel \(order.symbol) \(order.side.lowercased()) order?"
    }

    /// Condensed from the console's cancel sheet, which is the source of truth for what this
    /// action honestly does.  Every clause is load-bearing: no new order is placed, fills are
    /// never undone, and the cancel is a request the broker may take a moment to honour.
    static func confirmationMessage(_ order: EquityOrder) -> String {
        var sentences: [String] = []
        if let remaining = remainingQuantity(order), remaining > 0 {
            sentences.append(
                "This asks the broker to cancel the order, so the \(AppFormat.number(remaining)) unfilled shares stop working."
            )
        } else {
            sentences.append("This asks the broker to cancel the order.  No new order is placed.")
        }
        if let filled = order.filledQuantity, filled > 0 {
            sentences.append(
                "The \(AppFormat.number(filled)) shares that already filled stand; cancelling never undoes a fill."
            )
        }
        sentences.append(
            "Cancellation is not instant — the broker may report Pending Cancel briefly, and the order can still fill in the moment before the cancel lands."
        )
        return sentences.joined(separator: "  ")
    }
}
