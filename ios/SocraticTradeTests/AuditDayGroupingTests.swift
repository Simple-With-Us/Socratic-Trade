import XCTest
@testable import SocraticTrade

/// The Audit Log subtitle promises day grouping; these pin the helper's calendar math
/// with an injected calendar so assertions never depend on the runner's time zone.
final class AuditDayGroupingTests: XCTestCase {
    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func item(id: String, updatedAt: String) throws -> ActivityAuditItem {
        let json = """
        {"id":"\(id)","title":"Event","detail":"","status":"completed","updatedAt":"\(updatedAt)"}
        """
        return try JSONDecoder().decode(ActivityAuditItem.self, from: Data(json.utf8))
    }

    func testItemsGroupByStartOfDayPreservingFeedOrder() throws {
        let items = [
            try item(id: "a", updatedAt: "2026-11-24T15:00:00.000Z"),
            try item(id: "b", updatedAt: "2026-11-23T15:00:00.000Z"),
            try item(id: "c", updatedAt: "2026-11-24T03:00:00.000Z"),
            try item(id: "d", updatedAt: "2026-11-23T23:30:00.000Z")
        ]
        let groups = AuditDayGrouping.groups(items, calendar: utcCalendar)
        XCTAssertEqual(groups.count, 2)
        // Days appear in first-appearance order, not sorted; items keep feed order.
        XCTAssertEqual(groups[0].items.map(\.id), ["a", "c"])
        XCTAssertEqual(groups[1].items.map(\.id), ["b", "d"])
        let expectedDay = utcCalendar.startOfDay(
            for: try XCTUnwrap(AppFormat.date("2026-11-24T15:00:00.000Z"))
        )
        XCTAssertEqual(groups[0].day, expectedDay)
        XCTAssertNotEqual(groups[0].day, groups[1].day)
    }

    func testDayBoundaryFollowsTheInjectedCalendar() throws {
        // 03:00Z is still Nov 23 in Chicago (UTC-6 that day); 07:00Z is already Nov 24.
        let items = [
            try item(id: "a", updatedAt: "2026-11-24T03:00:00.000Z"),
            try item(id: "b", updatedAt: "2026-11-24T07:00:00.000Z")
        ]
        XCTAssertEqual(AuditDayGrouping.groups(items, calendar: utcCalendar).count, 1)
        var chicago = Calendar(identifier: .gregorian)
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        let centralGroups = AuditDayGrouping.groups(items, calendar: chicago)
        XCTAssertEqual(centralGroups.count, 2)
        XCTAssertEqual(centralGroups[0].items.map(\.id), ["a"])
        XCTAssertEqual(centralGroups[1].items.map(\.id), ["b"])
    }

    func testUndatedItemsCollectIntoOneTrailingGroup() throws {
        let items = [
            try item(id: "a", updatedAt: ""),
            try item(id: "b", updatedAt: "2026-11-24T15:00:00.000Z"),
            try item(id: "c", updatedAt: "not-a-date")
        ]
        let groups = AuditDayGrouping.groups(items, calendar: utcCalendar)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].items.map(\.id), ["b"])
        XCTAssertNil(groups[1].day)
        XCTAssertEqual(groups[1].items.map(\.id), ["a", "c"])
    }

    func testEmptyFeedHasNoGroups() {
        XCTAssertTrue(AuditDayGrouping.groups([], calendar: utcCalendar).isEmpty)
    }

    func testDayHeadingFormatsTheDayAndLabelsUndated() throws {
        let day = try XCTUnwrap(AppFormat.date("2026-11-24T15:00:00.000Z"))
        let heading = AppFormat.dayHeading(utcCalendar.startOfDay(for: day))
        XCTAssertFalse(heading.isEmpty)
        XCTAssertTrue(heading.contains("2026"), heading)
        XCTAssertEqual(AppFormat.dayHeading(nil), "Undated")
    }
}