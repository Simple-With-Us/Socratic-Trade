import SwiftUI

/// Shared presentation rules for strategy runs — Activity's run rows and Home's
/// latest-run card read the same status words and count line so the two never drift.
/// The string helpers are pure and unit-tested; `Tone.pillColor` is the only view glue.
enum StrategyRunSummary {
    /// Semantic tone of a run status; views map it to the palette.
    enum Tone {
        case negative, accent, warning, positive

        var pillColor: Color {
            switch self {
            case .negative: return AppPalette.negative
            case .accent: return AppPalette.accent
            case .warning: return AppPalette.warning
            case .positive: return AppPalette.positive
            }
        }
    }

    static func tone(for status: String) -> Tone {
        switch status {
        case "failed": return .negative
        case "running": return .accent
        case "skipped", "skipped_budget", "skipped_market_closed", "skipped_broker_unhealthy":
            return .warning
        default: return .positive
        }
    }

    /// Status word shown in the pill — the Activity run row's vocabulary.
    static func statusLabel(_ status: String) -> String {
        switch status {
        case "failed": return "Failed"
        case "running": return "Running"
        case "skipped": return "Skipped"
        case "skipped_budget": return "Skipped · Budget"
        case "skipped_market_closed": return "Skipped · Market Closed"
        case "skipped_broker_unhealthy": return "Skipped · Broker"
        default: return "Completed"
        }
    }

    /// "3 proposed · 1 placed · 2 blocked" — paper only when non-zero, same as Activity.
    static func countLine(proposed: Int, placed: Int, paper: Int, blocked: Int) -> String {
        var parts = ["\(proposed) proposed", "\(placed) placed"]
        if paper > 0 { parts.append("\(paper) paper") }
        parts.append("\(blocked) blocked")
        return parts.joined(separator: " · ")
    }

    static func countLine(_ run: StrategyRunItem) -> String {
        countLine(
            proposed: run.proposedCount,
            placed: run.placedCount,
            paper: run.paperCount,
            blocked: run.blockedCount
        )
    }
}