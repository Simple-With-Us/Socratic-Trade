import XCTest
@testable import SocraticTrade

/// ST-4687 (P12): the equity / benchmark charts switched from the `DragGesture` crosshair hack
/// to `chartXSelection`, which needs real `Date` x-values parsed once at chart build.  This is
/// the whole parsing contract — formats accepted, points dropped, delta preference, and nearest
/// selection.  All fixtures are fixed strings; nothing reads `Date()`.
final class ChartDateParsingTests: XCTestCase {
    // MARK: - Accepted formats

    func testParsesFullISO8601Stamp() {
        let date = ChartDateParsing.date(from: "2026-11-25T15:30:00.000Z")
        XCTAssertNotNil(date)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 11)
        XCTAssertEqual(components.day, 25)
        XCTAssertEqual(components.hour, 15)
        XCTAssertEqual(components.minute, 30)
    }

    func testParsesISO8601WithoutFractionalSecondsAndWithOffset() {
        XCTAssertNotNil(ChartDateParsing.date(from: "2026-11-25T15:30:00Z"))
        // A +02:00 offset lands on the same instant as 08:30Z.
        let east = ChartDateParsing.date(from: "2026-11-25T10:30:00-05:00")
        let utc = ChartDateParsing.date(from: "2026-11-25T15:30:00Z")
        XCTAssertEqual(east, utc)
    }

    func testParsesDayOnlyKeysAsUtcMidnight() {
        let date = ChartDateParsing.date(from: "2026-11-25")
        XCTAssertNotNil(date)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date!)
        XCTAssertEqual(components.day, 25)
        XCTAssertEqual(components.hour, 0)
        XCTAssertEqual(components.minute, 0)
    }

    func testRejectsEmptyAndGarbage() {
        XCTAssertNil(ChartDateParsing.date(from: ""))
        XCTAssertNil(ChartDateParsing.date(from: "   "))
        XCTAssertNil(ChartDateParsing.date(from: "not a date"))
        XCTAssertNil(ChartDateParsing.date(from: "2026-13-99"))
    }

    // MARK: - Series construction

    func testEquitySeriesKeepsRawLabelAndPrefersReturnPctAsDelta() {
        let points = [
            EquityCurvePoint(date: "2026-11-24", equity: 100, cash: nil, pnl: 5, returnPct: 1.5),
            EquityCurvePoint(date: "garbage", equity: 101, cash: nil, pnl: -2, returnPct: nil),
            EquityCurvePoint(date: "2026-11-25", equity: 102, cash: nil, pnl: 2, returnPct: nil)
        ]
        let plotted = ChartDateParsing.chartPoints(from: points)
        // The unparseable middle row drops out; the rest survive in order.
        XCTAssertEqual(plotted.map(\.rawDate), ["2026-11-24", "2026-11-25"])
        XCTAssertEqual(plotted.map(\.value), [100, 102])
        // returnPct wins when present; pnl is the fallback delta.
        XCTAssertEqual(plotted[0].delta, 1.5)
        XCTAssertEqual(plotted[1].delta, 2)
    }

    func testBenchmarkSeriesHasNoPerPointDelta() {
        let points = [
            BenchmarkDollarPoint(date: "2026-11-24", value: 100),
            BenchmarkDollarPoint(date: "2026-11-25", value: 101)
        ]
        let plotted = ChartDateParsing.chartPoints(from: points)
        XCTAssertEqual(plotted.count, 2)
        XCTAssertNil(plotted[0].delta)
    }

    func testPlottedIdIsTheRawWireDate() {
        let plotted = ChartDateParsing.chartPoints(
            from: [EquityCurvePoint(date: "2026-11-25", equity: 100)]
        )
        XCTAssertEqual(plotted.first?.id, "2026-11-25")
    }

    // MARK: - Selection

    func testNearestPicksTheClosestPointToTheContinuousSelection() throws {
        let plotted = ChartDateParsing.chartPoints(
            from: [
                EquityCurvePoint(date: "2026-11-24", equity: 100),
                EquityCurvePoint(date: "2026-11-26", equity: 102)
            ]
        )
        let middle = try XCTUnwrap(ChartDateParsing.date(from: "2026-11-25"))
        XCTAssertEqual(ChartDateParsing.nearest(plotted, to: middle)?.rawDate, "2026-11-24")

        let late = try XCTUnwrap(ChartDateParsing.date(from: "2026-11-25T23:59:00Z"))
        XCTAssertEqual(ChartDateParsing.nearest(plotted, to: late)?.rawDate, "2026-11-26")

        XCTAssertNil(ChartDateParsing.nearest([], to: middle))
    }
}
