import XCTest
@testable import SocraticTrade

/// ST-4687 (P8): pure contract for the price-alert create form.  The UI posts `alert.create`
/// through the mobile command client; these helpers hold the only logic worth pinning —
/// symbol normalization, the price floor, the direction ↔ op token mapping, and the payload
/// shape `parseMobileCommand` (src/lib/mobile-api.ts) expects.  No view hosting, no clock.
final class PriceAlertsFormTests: XCTestCase {
    // MARK: - Symbol

    func testEmptyAndWhitespaceSymbolsAreRejected() {
        XCTAssertEqual(PriceAlertForm.validate(symbol: "", priceText: "10"), .missingSymbol)
        XCTAssertEqual(PriceAlertForm.validate(symbol: "   ", priceText: "10"), .missingSymbol)
        XCTAssertEqual(PriceAlertForm.normalizedSymbol("  aapl "), "AAPL")
    }

    func testValidSymbolPassesValidation() {
        XCTAssertNil(PriceAlertForm.validate(symbol: "aapl", priceText: "211.55"))
    }

    // MARK: - Price

    func testPriceMustBeFiniteAndStrictlyPositive() {
        XCTAssertNil(PriceAlertForm.price(from: "0"))
        XCTAssertNil(PriceAlertForm.price(from: "-5"))
        XCTAssertNil(PriceAlertForm.price(from: "abc"))
        XCTAssertNil(PriceAlertForm.price(from: ""))
        XCTAssertEqual(PriceAlertForm.price(from: "211.55"), 211.55)
        XCTAssertEqual(PriceAlertForm.price(from: " $1,234.5 "), 1234.5)
        XCTAssertEqual(PriceAlertForm.validate(symbol: "AAPL", priceText: "0"), .invalidPrice)
        XCTAssertEqual(PriceAlertForm.validate(symbol: "AAPL", priceText: "NaN"), .invalidPrice)
        XCTAssertNil(PriceAlertForm.validate(symbol: "AAPL", priceText: "0.01"))
    }

    // MARK: - Direction round-trip (Codable + server alias table)

    func testDirectionCodableRoundTrip() throws {
        for direction in PriceAlertDirection.allCases {
            let encoded = try JSONEncoder().encode(direction)
            XCTAssertEqual(String(data: encoded, encoding: .utf8), "\"\(direction.rawValue)\"")
            let decoded = try JSONDecoder().decode(PriceAlertDirection.self, from: encoded)
            XCTAssertEqual(decoded, direction)
        }
    }

    func testDirectionMapsEveryServerOpAlias() {
        // src/lib/alerts.ts normalizeAlertOp accepts these tokens; the phone must read them back.
        XCTAssertEqual(PriceAlertDirection.from(op: ">"), .above)
        XCTAssertEqual(PriceAlertDirection.from(op: "above"), .above)
        XCTAssertEqual(PriceAlertDirection.from(op: "OVER"), .above)
        XCTAssertEqual(PriceAlertDirection.from(op: "<"), .below)
        XCTAssertEqual(PriceAlertDirection.from(op: "below"), .below)
        XCTAssertEqual(PriceAlertDirection.from(op: " lt "), .below)
        XCTAssertNil(PriceAlertDirection.from(op: "="))
        XCTAssertNil(PriceAlertDirection.from(op: ""))
    }

    func testDirectionOpTokensAreWhatTheServerStores() {
        // createAlert normalizes to "<" / ">" — the phone sends the same canonical tokens.
        XCTAssertEqual(PriceAlertDirection.above.op, ">")
        XCTAssertEqual(PriceAlertDirection.below.op, "<")
    }

    // MARK: - Payload shape

    func testPayloadMatchesServerParseContract() {
        let payload = PriceAlertForm.payload(symbol: " aapl ", direction: .above, price: 211.55, note: "  ")
        XCTAssertEqual(payload["symbol"] as? String, "AAPL")
        XCTAssertEqual(payload["op"] as? String, ">")
        XCTAssertEqual(payload["price"] as? Double, 211.55)
        // The server treats an empty note as absent (asOptionalString + `...(note ? {note})`).
        XCTAssertNil(payload["note"])
    }

    func testPayloadKeepsNonEmptyNoteTrimmed() {
        let payload = PriceAlertForm.payload(symbol: "MSFT", direction: .below, price: 300, note: "  earnings  ")
        XCTAssertEqual(payload["symbol"] as? String, "MSFT")
        XCTAssertEqual(payload["op"] as? String, "<")
        XCTAssertEqual(payload["note"] as? String, "earnings")
    }
}
