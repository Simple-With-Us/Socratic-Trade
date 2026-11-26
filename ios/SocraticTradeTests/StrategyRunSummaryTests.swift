import XCTest
@testable import SocraticTrade

/// Home's latest-run card and Activity's run rows share these rules; the tests pin the
/// vocabulary and the count line so the two screens cannot drift.
final class StrategyRunSummaryTests: XCTestCase {
    func testStatusWordsMatchTheActivityVocabulary() {
        XCTAssertEqual(StrategyRunSummary.statusLabel("failed"), "Failed")
        XCTAssertEqual(StrategyRunSummary.statusLabel("running"), "Running")
        XCTAssertEqual(StrategyRunSummary.statusLabel("skipped"), "Skipped")
        XCTAssertEqual(StrategyRunSummary.statusLabel("skipped_budget"), "Skipped · Budget")
        XCTAssertEqual(StrategyRunSummary.statusLabel("skipped_market_closed"), "Skipped · Market Closed")
        XCTAssertEqual(StrategyRunSummary.statusLabel("skipped_broker_unhealthy"), "Skipped · Broker")
        XCTAssertEqual(StrategyRunSummary.statusLabel("completed"), "Completed")
        XCTAssertEqual(StrategyRunSummary.statusLabel("something-new"), "Completed")
    }

    func testToneMatchesTheActivityPalette() {
        XCTAssertEqual(StrategyRunSummary.tone(for: "failed"), .negative)
        XCTAssertEqual(StrategyRunSummary.tone(for: "running"), .accent)
        XCTAssertEqual(StrategyRunSummary.tone(for: "skipped"), .warning)
        XCTAssertEqual(StrategyRunSummary.tone(for: "skipped_budget"), .warning)
        XCTAssertEqual(StrategyRunSummary.tone(for: "skipped_market_closed"), .warning)
        XCTAssertEqual(StrategyRunSummary.tone(for: "skipped_broker_unhealthy"), .warning)
        XCTAssertEqual(StrategyRunSummary.tone(for: "completed"), .positive)
    }

    func testCountLineShowsPaperOnlyWhenNonZero() {
        XCTAssertEqual(
            StrategyRunSummary.countLine(proposed: 3, placed: 1, paper: 0, blocked: 2),
            "3 proposed · 1 placed · 2 blocked"
        )
        XCTAssertEqual(
            StrategyRunSummary.countLine(proposed: 3, placed: 1, paper: 1, blocked: 2),
            "3 proposed · 1 placed · 1 paper · 2 blocked"
        )
        XCTAssertEqual(
            StrategyRunSummary.countLine(proposed: 0, placed: 0, paper: 0, blocked: 0),
            "0 proposed · 0 placed · 0 blocked"
        )
    }

    func testCountLineReadsTheRunItem() throws {
        let run = try self.run(proposed: 4, placed: 2, paper: 1, blocked: 1)
        XCTAssertEqual(StrategyRunSummary.countLine(run), "4 proposed · 2 placed · 1 paper · 1 blocked")
    }

    private func run(proposed: Int, placed: Int, paper: Int, blocked: Int) throws -> StrategyRunItem {
        let json = """
        {"id":"r1","startedAt":"2026-11-24T14:00:00.000Z","status":"completed","proposedCount":\(proposed),"placedCount":\(placed),"paperCount":\(paper),"blockedCount":\(blocked),"totalCount":\(proposed)}
        """
        return try JSONDecoder().decode(StrategyRunItem.self, from: Data(json.utf8))
    }
}