import XCTest
@testable import SocraticTrade

/// ST-4687 (R2l): the Scan tab's new sort menu is pure reordering of already-loaded rows —
/// the server rank is left untouched.  These pin that contract without the view.
final class ScanSortTests: XCTestCase {
    private func rows() -> [ScanCandidate] {
        [
            ScanCandidate(symbol: "NVDA", price: 120),
            ScanCandidate(symbol: "AAPL", price: 210),
            ScanCandidate(symbol: "MSFT", price: nil),
            ScanCandidate(symbol: "TSLA", price: 210)
        ]
    }

    func testRankedLeavesServerOrderAlone() {
        XCTAssertEqual(
            ScanRowSorter.sort(rows(), by: .ranked).map(\.symbol),
            ["NVDA", "AAPL", "MSFT", "TSLA"]
        )
    }

    func testPriceSortsHighestFirstAndUnpricedSink() {
        XCTAssertEqual(
            ScanRowSorter.sort(rows(), by: .price).map(\.symbol),
            ["AAPL", "TSLA", "NVDA", "MSFT"]
        )
    }

    func testEqualPricesTieBreakBySymbol() {
        // Determinism, not sort stability: AAPL and TSLA share a price.
        let sorted = ScanRowSorter.sort(rows(), by: .price)
        XCTAssertEqual(sorted.map(\.symbol).prefix(2), ["AAPL", "TSLA"])
    }

    func testSymbolSortsAlphabetically() {
        XCTAssertEqual(
            ScanRowSorter.sort(rows(), by: .symbol).map(\.symbol),
            ["AAPL", "MSFT", "NVDA", "TSLA"]
        )
    }

    func testEmptyInputStaysEmpty() {
        for option in ScanSortOption.allCases {
            XCTAssertEqual(ScanRowSorter.sort([], by: option).count, 0)
        }
    }

    func testOptionLabelsAreTitleCaseControlCopy() {
        // Menu option labels are control copy (Title Case), and "Default" names the server rank.
        XCTAssertEqual(
            ScanSortOption.allCases.map(\.label),
            ["Default", "Price", "Symbol"]
        )
    }

    func testWeeklyOverlapLineIsOneSentenceCaseLine() {
        XCTAssertEqual(
            WeeklyScreensCopy.overlapLine(["NVDA", "AAPL"]),
            "Overlap: NVDA, AAPL"
        )
        // The caller guards on isEmpty; the helper itself stays a pure join.
        XCTAssertEqual(WeeklyScreensCopy.overlapLine([]), "Overlap: ")
    }
}
