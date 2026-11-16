import XCTest
@testable import SocraticTrade

/// The cancellable predicate decides whether a destructive control appears on a row, so it is
/// tested as a pure function against the server's own working-state vocabulary
/// (src/lib/broker-held-orders.ts).  Offering Cancel where the server would refuse produces a
/// button that fails; withholding it where the server would accept removes a lever the operator
/// went to the phone for.
final class OrderCancelTests: XCTestCase {
    private func order(
        id: String = "order-1",
        state: String,
        quantity: Double? = 10,
        filledQuantity: Double? = 0,
        side: String = "buy"
    ) throws -> EquityOrder {
        let quantityJSON: String = quantity == nil ? "null" : "\(quantity!)"
        let filledJSON: String = filledQuantity == nil ? "null" : "\(filledQuantity!)"
        let json = """
        {
          "id": "\(id)",
          "symbol": "AAPL",
          "side": "\(side)",
          "type": "limit",
          "state": "\(state)",
          "quantity": \(quantityJSON),
          "filledQuantity": \(filledJSON),
          "limitPrice": 180.5,
          "createdAt": "2026-08-12T14:00:00.000Z",
          "updatedAt": "2026-08-12T14:05:00.000Z"
        }
        """
        return try JSONDecoder().decode(EquityOrder.self, from: Data(json.utf8))
    }

    func testEveryServerWorkingStateIsCancellable() {
        // ACTIVE_BROKER_ORDER_STATES + EXTRA_WORKING_ORDER_STATES, verbatim.
        let working = [
            "accepted", "accepted_for_bidding", "confirmed", "held", "new", "open",
            "partially_filled", "pending", "pending_cancel", "pending_new", "pending_replace",
            "queued", "submitted", "suspended", "unconfirmed", "stopped", "calculated"
        ]
        for state in working {
            XCTAssertTrue(OrderCancellation.isWorkingState(state), "\(state) is a working state")
        }
    }

    func testFinishedOrdersNeverOfferCancel() throws {
        // `done_for_day` is the trap: Alpaca returns it forever in order history, and it is
        // deliberately excluded from the server's working set.
        let finished = [
            "filled", "cancelled", "canceled", "rejected", "expired", "failed", "error",
            "done_for_day", "replaced", "unknown-broker-word"
        ]
        for state in finished {
            let finishedOrder = try order(state: state)
            XCTAssertFalse(OrderCancellation.isWorkingState(state), "\(state) is not working")
            XCTAssertFalse(OrderCancellation.isCancellable(finishedOrder), "\(state) is not cancellable")
        }
        XCTAssertFalse(OrderCancellation.isWorkingState(nil))
        XCTAssertFalse(OrderCancellation.isWorkingState(""))
    }

    func testStateMatchingIsCaseAndWhitespaceInsensitive() throws {
        XCTAssertTrue(OrderCancellation.isWorkingState("  Partially_Filled "))
        XCTAssertTrue(OrderCancellation.isWorkingState("NEW"))
        let padded = try order(state: " Accepted ")
        XCTAssertTrue(OrderCancellation.isCancellable(padded))
        // Casing must not smuggle a terminal state back in.
        XCTAssertFalse(OrderCancellation.isWorkingState(" FILLED "))
    }

    func testAnOrderWithNoUsableIdIsNotCancellable() throws {
        let blankId = try order(id: "  ", state: "open")
        let realId = try order(id: "abc", state: "open")
        XCTAssertFalse(OrderCancellation.isCancellable(blankId))
        XCTAssertTrue(OrderCancellation.isCancellable(realId))
    }

    func testPayloadMatchesTheServerCommandContract() {
        let withAccount = OrderCancellation.payload(orderId: "order-9", accountNumber: "ACCT-1")
        XCTAssertEqual(withAccount["orderId"] as? String, "order-9")
        XCTAssertEqual(withAccount["accountNumber"] as? String, "ACCT-1")

        // No selected account means no stale-view assertion to make — the key is omitted rather
        // than sent blank, so the phone never claims a guard it did not assert.
        let empties: [String?] = [nil, "", "   "]
        for empty in empties {
            let payload = OrderCancellation.payload(orderId: "order-9", accountNumber: empty)
            XCTAssertEqual(payload["orderId"] as? String, "order-9")
            XCTAssertNil(payload["accountNumber"])
        }

        XCTAssertEqual(
            OrderCancellation.payload(orderId: "order-9", accountNumber: "  ACCT-1  ")["accountNumber"] as? String,
            "ACCT-1"
        )
    }

    func testOperationIDIsPerOrderSoOneCancelNeverBlocksAnother() {
        XCTAssertEqual(OrderCancellation.operationID(orderId: "a"), "order.cancel:a")
        XCTAssertNotEqual(
            OrderCancellation.operationID(orderId: "a"),
            OrderCancellation.operationID(orderId: "b")
        )
    }

    func testRemainingQuantityIsTheUnfilledPortion() throws {
        let partial = try order(state: "open", quantity: 10, filledQuantity: 4)
        let untouched = try order(state: "open", quantity: 10, filledQuantity: nil)
        // Never negative, even if a broker over-reports fills.
        let overfilled = try order(state: "open", quantity: 10, filledQuantity: 12)
        // Dollar-based orders carry no share count.
        let dollarBased = try order(state: "open", quantity: nil)

        XCTAssertEqual(OrderCancellation.remainingQuantity(partial), 6.0)
        XCTAssertEqual(OrderCancellation.remainingQuantity(untouched), 10.0)
        XCTAssertEqual(OrderCancellation.remainingQuantity(overfilled), 0.0)
        XCTAssertNil(OrderCancellation.remainingQuantity(dollarBased))
    }

    func testConfirmationCopyStatesWhatTheCancelActuallyDoes() throws {
        let partiallyFilled = try order(state: "partially_filled", quantity: 10, filledQuantity: 4)
        let message = OrderCancellation.confirmationMessage(partiallyFilled)

        XCTAssertTrue(message.contains("6 unfilled shares"), message)
        XCTAssertTrue(message.contains("4 shares that already filled stand"), message)
        XCTAssertTrue(message.contains("Pending Cancel"), message)
        // Fleet copy rule: two spaces between sentences.  Collapse every correct gap first, so
        // what remains is exactly the single-space violations.
        let withoutSentenceGaps = message.replacingOccurrences(of: ".  ", with: ".")
        XCTAssertTrue(message.contains(".  "), "expected sentence gaps in: \(message)")
        XCTAssertFalse(
            withoutSentenceGaps.contains(". "),
            "sentences must be separated by two spaces: \(message)"
        )

        // Nothing filled yet: no fill claim is made at all.
        let untouched = try order(state: "open", quantity: 10, filledQuantity: 0)
        XCTAssertFalse(OrderCancellation.confirmationMessage(untouched).contains("already filled"))

        let sellOrder = try order(state: "open", side: "sell")
        XCTAssertEqual(OrderCancellation.confirmationTitle(sellOrder), "Cancel AAPL sell order?")
    }
}
