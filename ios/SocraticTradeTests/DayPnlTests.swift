import XCTest
@testable import SocraticTrade

/// R2a (ST-4688): the Home "Today's P&L" tile is driven by this math, ported from the
/// console's `deriveDayPnl`.  These tests pin the honesty rules: a number appears only when
/// the flow basis is verified, and the broker hint wins over the curve baseline.
final class DayPnlTests: XCTestCase {
    /// Thu, Nov 26, 2026, 9:00 AM Central (CST, UTC-6).
    private var now: Date {
        ISO8601DateFormatter().date(from: "2026-11-26T15:00:00Z")!
    }

    /// Decodes curve points through the same path the snapshot uses (that type has no
    /// memberwise initializer).
    private func curve(_ points: [(String, Double)]) throws -> [EquityCurvePoint] {
        let rows = points.map { #"{"timestamp":"\#($0.0)","equity":\#($0.1)}"# }
        return try JSONDecoder().decode([EquityCurvePoint].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

    private func hints(
        priorCloseEquity: Double? = nil,
        todayBrokerFlow: Double? = nil,
        inferred: DayPnlHints.InferredFlow? = nil,
        cashFlowSource: String? = nil
    ) -> DayPnlHints {
        // Decoded from JSON for the same reason as the curve: the production shape is the
        // contract under test.
        var object: [String: Any] = [:]
        if let priorCloseEquity { object["priorCloseEquity"] = priorCloseEquity }
        if let todayBrokerFlow { object["todayBrokerFlow"] = todayBrokerFlow }
        if let cashFlowSource { object["cashFlowSource"] = cashFlowSource }
        if let inferred {
            var inferredObject: [String: Any] = [:]
            if let mode = inferred.mode { inferredObject["mode"] = mode }
            if let flow = inferred.flow { inferredObject["flow"] = flow }
            if let dayKey = inferred.dayKey { inferredObject["dayKey"] = dayKey }
            if let baselineAt = inferred.baselineAt { inferredObject["baselineAt"] = baselineAt }
            if let currentEquity = inferred.currentEquity { inferredObject["currentEquity"] = currentEquity }
            if let currentCash = inferred.currentCash { inferredObject["currentCash"] = currentCash }
            object["todayInferredFlow"] = inferredObject
        }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(DayPnlHints.self, from: data)
    }

    private func inferred(
        mode: String = "live",
        flow: Double? = 50,
        dayKey: String = "2026-11-26",
        baselineAt: String? = "2026-11-25T21:00:00Z",
        currentEquity: Double? = 10_250,
        currentCash: Double? = 4_000
    ) -> DayPnlHints.InferredFlow {
        DayPnlHints.InferredFlow(
            mode: mode,
            flow: flow,
            dayKey: dayKey,
            baselineAt: baselineAt,
            currentEquity: currentEquity,
            currentCash: currentCash
        )
    }

    func testBrokerFlowProducesBrokerVerifiedPnl() throws {
        let points = try curve([
            ("2026-11-25T21:00:00Z", 9_000),
            ("2026-11-26T14:00:00Z", 10_240)
        ])
        let result = DayPnlMath.derive(
            curve: points,
            currentEquity: 10_250,
            currentCash: 4_000,
            hints: hints(priorCloseEquity: 10_000, todayBrokerFlow: 100, cashFlowSource: "broker"),
            mode: "live",
            now: now
        )
        let dayPnl = try XCTUnwrap(result)
        XCTAssertEqual(dayPnl.baselineEquity, 10_000)
        XCTAssertEqual(dayPnl.externalFlow, 100)
        XCTAssertEqual(dayPnl.pnl, 150, accuracy: 0.0001)
        XCTAssertEqual(dayPnl.pct, 150.0 / 10_100.0 * 100, accuracy: 0.0001)
        XCTAssertTrue(dayPnl.isBrokerVerified)
        XCTAssertEqual(dayPnl.basis.detail, "broker-verified")
        // The intraday point is NOT the baseline: day P&L is measured from the prior close.
        XCTAssertNotEqual(dayPnl.baselineEquity, 10_240)
    }

    func testMissingFlowBasisReturnsNilInsteadOfGuessing() throws {
        let points = try curve([("2026-11-25T21:00:00Z", 10_000)])
        XCTAssertNil(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_500,
            currentCash: 2_000,
            hints: nil,
            mode: "live",
            now: now
        ))
        // A prior close alone is not a flow basis either.
        XCTAssertNil(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_500,
            currentCash: 2_000,
            hints: hints(priorCloseEquity: 10_000),
            mode: "live",
            now: now
        ))
    }

    func testCurveBaselineUsedWhenNoBrokerPriorClose() throws {
        let points = try curve([
            ("2026-11-25T21:00:00Z", 8_000),
            ("2026-11-26T14:00:00Z", 10_100)
        ])
        let dayPnl = try XCTUnwrap(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_250,
            currentCash: 4_000,
            hints: hints(todayBrokerFlow: 100, cashFlowSource: "broker"),
            mode: "live",
            now: now
        ))
        XCTAssertEqual(dayPnl.baselineEquity, 8_000)
        XCTAssertEqual(dayPnl.pnl, 2_150, accuracy: 0.0001)
    }

    func testInferredFlowIsHonoredOnlyWhenItMatchesThisRender() throws {
        let points = try curve([("2026-11-25T21:00:00Z", 10_000)])
        let match = try XCTUnwrap(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_250,
            currentCash: 4_000,
            hints: hints(inferred: inferred(), cashFlowSource: "inferred"),
            mode: "live",
            now: now
        ))
        XCTAssertEqual(match.basis, .inferred)
        XCTAssertEqual(match.externalFlow, 50)
        XCTAssertEqual(match.pnl, 200, accuracy: 0.0001)
        XCTAssertFalse(match.isBrokerVerified)
        XCTAssertEqual(match.basis.detail, "cash flow inferred")

        // Wrong mode, stale day, and mismatched portfolio inputs each disqualify the hint.
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 10_250, currentCash: 4_000,
            hints: hints(inferred: inferred(mode: "paper")), mode: "live", now: now
        ))
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 10_250, currentCash: 4_000,
            hints: hints(inferred: inferred(dayKey: "2026-11-25")), mode: "live", now: now
        ))
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 10_250, currentCash: 4_000,
            hints: hints(inferred: inferred(currentEquity: 9_999)), mode: "live", now: now
        ))
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 10_250, currentCash: 4_000,
            hints: hints(inferred: inferred(currentCash: 1)), mode: "live", now: now
        ))
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 10_250, currentCash: 4_000,
            hints: hints(inferred: inferred(baselineAt: "2026-11-24T21:00:00Z")), mode: "live", now: now
        ))
    }

    func testAmbiguousInferredFlowIsNotAZero() throws {
        let points = try curve([("2026-11-25T21:00:00Z", 10_000)])
        XCTAssertNil(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_250,
            currentCash: 4_000,
            hints: hints(inferred: inferred(flow: nil)),
            mode: "live",
            now: now
        ))
    }

    func testBrokerFlowWinsOverInferredHint() throws {
        let points = try curve([("2026-11-25T21:00:00Z", 10_000)])
        let bothHints = hints(
            todayBrokerFlow: 0,
            inferred: inferred(flow: 900),
            cashFlowSource: "broker"
        )
        let dayPnl = try XCTUnwrap(DayPnlMath.derive(
            curve: points,
            currentEquity: 10_250,
            currentCash: 4_000,
            hints: bothHints,
            mode: "live",
            now: now
        ))
        XCTAssertEqual(dayPnl.basis, .broker)
        XCTAssertEqual(dayPnl.externalFlow, 0)
        XCTAssertEqual(dayPnl.pnl, 250, accuracy: 0.0001)
    }

    func testMissingOrNonPositiveEquityReturnsNil() throws {
        let points = try curve([("2026-11-25T21:00:00Z", 10_000)])
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: nil, currentCash: 0,
            hints: hints(todayBrokerFlow: 0), mode: "live", now: now
        ))
        XCTAssertNil(DayPnlMath.derive(
            curve: points, currentEquity: 0, currentCash: 0,
            hints: hints(todayBrokerFlow: 0), mode: "live", now: now
        ))
        // No curve and no prior close: nothing to measure from.
        XCTAssertNil(DayPnlMath.derive(
            curve: [], currentEquity: 10_000, currentCash: 0,
            hints: hints(todayBrokerFlow: 0), mode: "live", now: now
        ))
    }

    func testCentralDayBoundaryFollowsChicagoNotUTC() throws {
        // 2026-11-26T04:00Z is still Nov 25 in Chicago (10:00 PM CST).
        XCTAssertEqual(
            DayPnlMath.centralDayKey(ISO8601DateFormatter().date(from: "2026-11-26T04:00:00Z")!),
            "2026-11-25"
        )
        XCTAssertEqual(DayPnlMath.centralDayKey(now), "2026-11-26")
        // A point at 04:00Z on the 26th belongs to the PRIOR Central day, so it can be a
        // baseline for the 26th's P&L.
        let points = try curve([("2026-11-26T04:00:00Z", 9_500)])
        XCTAssertEqual(DayPnlMath.baseline(in: points, now: now)?.equity, 9_500)
        // A point after Chicago midnight today cannot.
        let todayPoint = try curve([("2026-11-26T07:00:00Z", 9_900)])
        XCTAssertNil(DayPnlMath.baseline(in: todayPoint, now: now))
    }
}