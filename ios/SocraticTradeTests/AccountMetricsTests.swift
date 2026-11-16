import XCTest
@testable import SocraticTrade

final class AccountMetricsTests: XCTestCase {
    func testUnrealizedFromPositionsUsesMarkMinusCost() {
        let long = Position(
            symbol: "XOM",
            quantity: 10,
            marketValue: 1_200,
            averageCost: 100,
            sector: nil,
            industry: nil
        )
        let short = Position(
            symbol: "SPCX",
            quantity: -4,
            marketValue: -80,
            averageCost: 25,
            sector: nil,
            industry: nil
        )
        // long: 1200 - 10*100 = 200; short: -80 - (-4)*25 = 20
        XCTAssertEqual(AccountMetrics.unrealizedFromPositions([long, short]), 220)
    }

    func testDisplayedUnrealizedPrefersPositionsOverZeroLedger() {
        let held = Position(
            symbol: "XOM",
            quantity: 5,
            marketValue: 600,
            averageCost: 100,
            sector: nil,
            industry: nil
        )
        XCTAssertEqual(
            AccountMetrics.displayedUnrealized(positions: [held], ledger: 0),
            100
        )
    }

    func testDisplayedRealizedIsNilWithoutFillHistory() {
        XCTAssertNil(AccountMetrics.displayedRealized(ledger: 0, hasFillHistory: false))
        XCTAssertEqual(AccountMetrics.displayedRealized(ledger: 0, hasFillHistory: true), 0)
    }

    func testPaperEnvironmentIsNotLiveMetrics() {
        XCTAssertFalse(AccountMetrics.usesLiveMetrics(environment: "paper"))
        XCTAssertFalse(AccountMetrics.usesLiveMetrics(environment: "sandbox"))
        XCTAssertTrue(AccountMetrics.usesLiveMetrics(environment: "live"))
        XCTAssertTrue(AccountMetrics.usesLiveMetrics(environment: "LIVE"))
    }

    // perf-06: win rate / avg return are `0` (not nil) from the server for an account with zero
    // closed lots — a real "no data yet" state must read off the closed-lot count, not the value.
    func testDisplayedRateMetricIsNilWithZeroClosedLots() {
        XCTAssertNil(AccountMetrics.displayedRateMetric(ledger: 0, closedLotCount: 0))
        XCTAssertNil(AccountMetrics.displayedRateMetric(ledger: 0, closedLotCount: nil))
    }

    func testDisplayedRateMetricShowsRealZeroWithOneClosedLot() {
        // One break-even closed lot is a genuine 0% — must NOT be suppressed just because the
        // value is zero, only because the count is zero.
        XCTAssertEqual(AccountMetrics.displayedRateMetric(ledger: 0, closedLotCount: 1), 0)
        XCTAssertEqual(AccountMetrics.displayedRateMetric(ledger: 62.5, closedLotCount: 3), 62.5)
    }
}
