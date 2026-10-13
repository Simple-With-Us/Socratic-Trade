import XCTest
@testable import SocraticTrade

final class NYSEMarketSessionTests: XCTestCase {
    func testRegularSessionOnWeekdayMorning() throws {
        var components = DateComponents()
        components.timeZone = TimeZone(identifier: "America/New_York")
        components.year = 2026
        components.month = 10
        components.day = 13
        components.hour = 11
        components.minute = 0
        let calendar = Calendar(identifier: .gregorian)
        let date = try XCTUnwrap(calendar.date(from: components))
        XCTAssertEqual(NYSEMarketSession.sessionKey(now: date), "regular")
    }

    func testClosedOnChristmas() throws {
        var components = DateComponents()
        components.timeZone = TimeZone(identifier: "America/New_York")
        components.year = 2026
        components.month = 12
        components.day = 25
        components.hour = 11
        components.minute = 0
        let calendar = Calendar(identifier: .gregorian)
        let date = try XCTUnwrap(calendar.date(from: components))
        XCTAssertEqual(NYSEMarketSession.sessionKey(now: date), "closed")
    }

    func testStaleSnapshotUsesDeviceSessionForRunState() throws {
        var components = DateComponents()
        components.timeZone = TimeZone(identifier: "America/New_York")
        components.year = 2026
        components.month = 12
        components.day = 25
        components.hour = 11
        components.minute = 0
        let calendar = Calendar(identifier: .gregorian)
        let christmas = try XCTUnwrap(calendar.date(from: components))
        XCTAssertEqual(
            deriveRunStateWord(
                systemState: "active",
                runDuringExtendedHours: false,
                marketSession: "regular"
            ),
            .running
        )
        XCTAssertEqual(
            deriveRunStateWord(
                systemState: "active",
                runDuringExtendedHours: false,
                marketSession: NYSEMarketSession.sessionKey(now: christmas)
            ),
            .pausedMarketClosed
        )
    }
}
