import XCTest
@testable import SocraticTrade

/// R2k (ST-4688): the symbol sheet's Set Alert form must build exactly the payload the
/// server's `alert.create` normalizer accepts, and must refuse what it would reject.
final class PriceAlertDraftTests: XCTestCase {
    func testAcceptsFormattedPrice() {
        var draft = PriceAlertDraft(symbol: " nvda ", direction: .below, priceText: "$1,234.50")
        XCTAssertEqual(draft.normalizedSymbol, "NVDA")
        XCTAssertEqual(draft.price, 1_234.5)
        XCTAssertNil(draft.validationMessage)
        XCTAssertTrue(draft.canSubmit)

        let payload = draft.payload()
        XCTAssertEqual(payload?["symbol"] as? String, "NVDA")
        XCTAssertEqual(payload?["op"] as? String, "<")
        XCTAssertEqual(payload?["price"] as? Double, 1_234.5)

        draft.direction = .above
        XCTAssertEqual(draft.payload()?["op"] as? String, ">")
    }

    func testRejectsBlankAndSubCentPrices() {
        var draft = PriceAlertDraft(symbol: "AAPL", direction: .above, priceText: "")
        XCTAssertEqual(draft.validationMessage, "Enter a price.")
        XCTAssertNil(draft.payload())

        draft.priceText = "0"
        XCTAssertEqual(draft.validationMessage, "Enter a price of at least $0.01.")
        XCTAssertNil(draft.payload())

        draft.priceText = "abc"
        XCTAssertEqual(draft.validationMessage, "Enter a price.")
        XCTAssertNil(draft.payload())

        draft.priceText = "0.01"
        XCTAssertNil(draft.validationMessage)
        XCTAssertEqual(draft.payload()?["price"] as? Double, 0.01)
    }

    func testRequiresASymbol() {
        let draft = PriceAlertDraft(symbol: "   ", priceText: "10")
        XCTAssertEqual(draft.validationMessage, "Enter a symbol.")
        XCTAssertNil(draft.payload())
    }

    func testNoteIsTrimmedCappedAndOmittedWhenEmpty() {
        var draft = PriceAlertDraft(
            symbol: "MSFT",
            direction: .above,
            priceText: "500",
            note: "  watch the gap  "
        )
        XCTAssertEqual(draft.payload()?["note"] as? String, "watch the gap")

        draft.note = "   "
        XCTAssertNil(draft.payload()?["note"])

        draft.note = String(repeating: "x", count: 700)
        XCTAssertEqual((draft.payload()?["note"] as? String)?.count, PriceAlertDraft.noteLimit)
    }

    func testConfirmationLineReadsLikeASentence() {
        let draft = PriceAlertDraft(symbol: "SPY", direction: .below, priceText: "610.25")
        XCTAssertEqual(draft.confirmationLine, "SPY falls below $610.25.")
    }

    // MARK: - Payload decoding

    func testWatchlistQuotesDecodeBatchedPricesAndDelayStamp() throws {
        let json = """
        {
          "items": [{"symbol": "NVDA", "addedAt": "2026-11-25T15:00:00.000Z"}],
          "quotes": {
            "NVDA": {"price": 182.5, "prevClose": 180, "changePct": null,
                     "asOf": "2026-11-26T14:55:00.000Z", "priceDelayLabel": "15-min delayed"},
            "AMD": {"prevClose": 200}
          },
          "priceDelay": {"label": "15-min delayed", "asOf": "2026-11-26T14:55:00.000Z"}
        }
        """
        let response = try JSONDecoder().decode(WatchlistQuotesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.items.map(\.symbol), ["NVDA"])
        XCTAssertEqual(response.priceDelay?.label, "15-min delayed")
        let nvda = try XCTUnwrap(response.quotes?["NVDA"])
        XCTAssertEqual(nvda.price, 182.5)
        // changePct was null on the wire: computed from price/prevClose, never invented.
        let nvdaChange = try XCTUnwrap(nvda.displayChangePct)
        XCTAssertEqual(nvdaChange, 1.388_888, accuracy: 0.0001)
        let amd = try XCTUnwrap(response.quotes?["AMD"])
        XCTAssertNil(amd.price)
        XCTAssertNil(amd.displayChangePct)
    }

    func testWatchlistQuotesToleratesEmptyAndMissingQuotes() throws {
        let empty = try JSONDecoder().decode(
            WatchlistQuotesResponse.self,
            from: Data(#"{"items":[]}"#.utf8)
        )
        XCTAssertTrue(empty.items.isEmpty)
        XCTAssertNil(empty.quotes)

        let blank = try JSONDecoder().decode(
            WatchlistQuotesResponse.self,
            from: Data(#"{"items":[],"quotes":{}}"#.utf8)
        )
        XCTAssertEqual(blank.quotes?.count, 0)
    }

    func testLearnedContextItemDecodesTierAndDisplayFields() throws {
        let json = """
        {
          "id": "lc_1",
          "userId": "u1",
          "scope": "private",
          "kind": "fact",
          "subject": "NVDA earnings reaction",
          "symbol": "nvda",
          "value": "Gaps hold when revenue beats.",
          "source": "post-mortem",
          "origin": "autonomous",
          "riskTier": "risk",
          "confidence": 0.82,
          "assertedAt": "2026-11-20T15:00:00.000Z",
          "supersededBy": null,
          "expiresAt": null
        }
        """
        let item = try JSONDecoder().decode(LearnedContextItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.id, "lc_1")
        XCTAssertEqual(item.symbol, "nvda")
        XCTAssertEqual(item.tierLabel, "Approved risk rule")
        XCTAssertEqual(item.confidence, 0.82)
        XCTAssertNil(item.expiresAt)
    }
}