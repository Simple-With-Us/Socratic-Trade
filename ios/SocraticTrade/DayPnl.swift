import Foundation

/// Broker day-P&L hints from `PerformanceSummary.dayPnlHints` (src/lib/types.ts).  Present
/// only when the server could establish a flow basis; every field is optional because a
/// partial hint must not be treated as a complete one.
struct DayPnlHints: Decodable, Equatable {
    /// Prior session close equity from the broker when available (e.g. Alpaca
    /// `last_equity`).  When present it replaces the curve-derived baseline.
    let priorCloseEquity: Double?
    /// Net external flow on the current Central trading day from broker activities.
    let todayBrokerFlow: Double?
    /// Server-computed inferred flow for the current Central trading day, from the FULL
    /// per-mode fill ledger.  Honored only when it provably describes the render.
    let todayInferredFlow: InferredFlow?
    let cashFlowSource: String?

    struct InferredFlow: Decodable, Equatable {
        let mode: String?
        /// `nil` means timing is ambiguous, not a verified zero flow.
        let flow: Double?
        let dayKey: String?
        let baselineAt: String?
        let currentEquity: Double?
        let currentCash: Double?
    }
}

/// One day's P&L, with the provenance the tile needs to stay honest.
struct DayPnl: Equatable {
    enum Basis: Equatable {
        /// The broker's own prior close and transfer ledger.  Safe to label "broker-verified".
        case broker
        /// Server-inferred external flow over the full fill ledger.
        case inferred

        var detail: String {
            switch self {
            case .broker: return "broker-verified"
            case .inferred: return "cash flow inferred"
            }
        }
    }

    let pnl: Double
    let pct: Double
    let baselineEquity: Double
    let externalFlow: Double
    let basis: Basis

    var isBrokerVerified: Bool { basis == .broker }
}

/// Day-P&L math, ported from the console's `deriveDayPnl` (app/console/lib/derive.ts) minus
/// the client-side fill inference: the phone only uses a server-provided flow (broker
/// activities or the server's full-ledger hint), because `PerformanceSummary.fills` is a
/// display-bounded tail and inferring transfers from it would mint phantom numbers.
enum DayPnlMath {
    /// Fleet convention: the owner-facing trading day is Central Time.
    static let timeZone = TimeZone(identifier: "America/Chicago") ?? TimeZone(secondsFromGMT: 0)!

    /// `YYYY-MM-DD` for `date` in Central Time — the same key `centralTradingDayKey` builds.
    static func centralDayKey(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// Start of the Central-Time calendar day containing `now`, as an absolute instant.
    static func startOfCentralDay(_ now: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.startOfDay(for: now)
    }

    /// Server ISO timestamps may carry fractional seconds (snapshot points) or not.
    static func parseDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = ISO8601DateFormatter().date(from: value) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }

    /// The last curve point strictly before the current Central day — the console's
    /// `selectDayPnlBaseline`, including its "last one wins" scan order.
    static func baseline(in curve: [EquityCurvePoint], now: Date) -> EquityCurvePoint? {
        let todayStart = startOfCentralDay(now)
        var found: EquityCurvePoint?
        for point in curve {
            guard let timestamp = parseDate(point.date), timestamp < todayStart else { continue }
            found = point
        }
        return found
    }

    /// Today's P&L for one account mode, or nil when the cash-flow basis cannot be verified.
    ///
    /// - Parameter mode: `"live"` or `"paper"` — must match the server hint's own mode, or a
    ///   paper-account hint would be applied to a live render.
    static func derive(
        curve: [EquityCurvePoint],
        currentEquity: Double?,
        currentCash: Double?,
        hints: DayPnlHints?,
        mode: String,
        now: Date = Date()
    ) -> DayPnl? {
        guard let currentEquity, currentEquity.isFinite, currentEquity > 0 else { return nil }
        let base = baseline(in: curve, now: now)

        let priorClose = hints?.priorCloseEquity
        let hasPriorClose = priorClose.map { $0.isFinite && $0 > 0 } ?? false

        let baselineEquity: Double
        if hasPriorClose, let priorClose {
            baselineEquity = priorClose
        } else if let base, base.equity.isFinite, base.equity > 0 {
            baselineEquity = base.equity
        } else {
            return nil
        }

        let flow: Double
        let basis: DayPnl.Basis
        if let brokerFlow = hints?.todayBrokerFlow, brokerFlow.isFinite {
            flow = brokerFlow
            basis = .broker
        } else if let inferred = hints?.todayInferredFlow,
                  honors(
                    inferred,
                    mode: mode,
                    baseline: base,
                    currentEquity: currentEquity,
                    currentCash: currentCash,
                    hasPriorClose: hasPriorClose,
                    now: now
                  ),
                  let inferredFlow = inferred.flow,
                  inferredFlow.isFinite {
            flow = inferredFlow
            basis = .inferred
        } else {
            // No verified flow: either the hint is stale/mismatched or the server sent none.
            // Returning nil keeps an unexplained equity jump off the card rather than
            // presenting a deposit as P&L.
            return nil
        }

        let pnl = currentEquity - baselineEquity - flow
        let percentBase = baselineEquity + flow
        let pct = percentBase > 0 ? (pnl / percentBase) * 100 : 0
        return DayPnl(
            pnl: pnl,
            pct: pct,
            baselineEquity: baselineEquity,
            externalFlow: flow,
            basis: basis
        )
    }

    /// The server hint is only usable when it provably describes THIS render: same mode,
    /// same Central day, same baseline point, same portfolio inputs, and no broker
    /// prior-close override (the server computed its flow against the curve baseline).
    private static func honors(
        _ hint: DayPnlHints.InferredFlow,
        mode: String,
        baseline: EquityCurvePoint?,
        currentEquity: Double,
        currentCash: Double?,
        hasPriorClose: Bool,
        now: Date
    ) -> Bool {
        guard !hasPriorClose else { return false }
        guard (hint.mode ?? "").lowercased() == mode.lowercased() else { return false }
        guard hint.dayKey == centralDayKey(now) else { return false }
        // A hint bound to a baseline point must name the very point this render uses.
        if let hintBaselineAt = hint.baselineAt {
            guard let baseline,
                  let hintInstant = parseDate(hintBaselineAt),
                  let baseInstant = parseDate(baseline.date),
                  abs(hintInstant.timeIntervalSince(baseInstant)) < 1
            else { return false }
        }
        if let hintEquity = hint.currentEquity, abs(hintEquity - currentEquity) > 0.01 { return false }
        if let hintCash = hint.currentCash, let currentCash, abs(hintCash - currentCash) > 0.01 { return false }
        return true
    }
}