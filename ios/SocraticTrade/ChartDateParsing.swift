import Foundation

/// A chart-ready point whose wire `date` string has been parsed ONCE at chart build.
/// The wire models stay untouched (`EquityCurvePoint.date` / `BenchmarkDollarPoint.date`
/// remain the server's strings, and the readout keeps showing the raw label); only this
/// value type feeds the chart's time axis.
struct PlottedChartPoint: Identifiable, Equatable {
    /// The raw wire date string — unique within a series today (the models key on it) —
    /// so it doubles as the identity and the readout label.
    let id: String
    let rawDate: String
    let date: Date
    let value: Double
    /// Per-point return/delta when the series carries one; nil for plain dollar series.
    let delta: Double?
}

/// Pure date parsing for the Swift Charts overhaul (ST-4687 / P12).  Extracted from the
/// chart views so XCTest can pin the accepted formats without SwiftUI or a calendar locale.
/// Two shapes reach the charts today: full ISO 8601 stamps and bare `yyyy-MM-dd` day keys.
enum ChartDateParsing {
    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Day-only keys are interpreted as UTC midnight so chart spacing stays deterministic.
    private static let dayOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Returns nil for empty or unrecognized strings — callers drop those points rather than
    /// guessing a position for them.
    static func date(from raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let parsed = iso8601Fractional.date(from: trimmed) { return parsed }
        if let parsed = iso8601.date(from: trimmed) { return parsed }
        return dayOnly.date(from: trimmed)
    }

    /// Equity-curve series.  `delta` prefers the percent return (what the readout signs colors)
    /// and falls back to the dollar pnl; points whose date cannot be parsed are skipped.
    static func chartPoints(from points: [EquityCurvePoint]) -> [PlottedChartPoint] {
        // Duplicate wire day-keys must not share an identity (Kody 68SluO): keep the plain date
        // as the id while it is unique, and disambiguate a repeat with its position.
        var seen = Set<String>()
        return points.compactMap { point in
            guard let date = date(from: point.date) else { return nil }
            let unique = seen.insert(point.date).inserted
            return PlottedChartPoint(
                id: unique ? point.date : "\(point.date)#repeat",
                rawDate: point.date,
                date: date,
                value: point.equity,
                delta: point.returnPct ?? point.pnl
            )
        }
    }

    /// Dollar-value series (account vs benchmark).  No per-point delta — the comparison's
    /// spread is computed against the other series at selection time.
    static func chartPoints(from points: [BenchmarkDollarPoint]) -> [PlottedChartPoint] {
        var seen = Set<String>()
        return points.compactMap { point in
            guard let date = date(from: point.date) else { return nil }
            let unique = seen.insert(point.date).inserted
            return PlottedChartPoint(
                id: unique ? point.date : "\(point.date)#repeat",
                rawDate: point.date,
                date: date,
                value: point.value,
                delta: nil
            )
        }
    }

    /// Nearest plotted point to a `chartXSelection` date (selection lands on continuous x
    /// positions, not on data points).  Deterministic: strict `<` keeps the first min on ties.
    static func nearest(_ points: [PlottedChartPoint], to selected: Date) -> PlottedChartPoint? {
        points.min { lhs, rhs in
            abs(lhs.date.timeIntervalSince(selected)) < abs(rhs.date.timeIntervalSince(selected))
        }
    }
}
