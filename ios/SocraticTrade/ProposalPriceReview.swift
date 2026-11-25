import Foundation
import SwiftUI

/// Proposed / live / target / delay numbers for a pending proposal card.
struct ProposalPriceReview: Equatable {
    let proposed: Double?
    let now: Double?
    let target: Double?
    let stop: Double?
    let quantity: Double?
    let side: String
    let exitPlan: String?
    let pendingDelayedFallback: Bool
    let proposalDelayedFallback: Bool

    var hasTarget: Bool { target != nil && (target ?? 0) > 0 }

    /// Side-adjusted $ change of the proposed size from proposed → now.
    /// Positive = a better fill now.  Negative = the delay made the trade worse.
    var delayAdvantage: Double? {
        guard
            let proposed, let now, proposed > 0,
            let quantity, quantity > 0
        else { return nil }
        let delta = now - proposed
        switch side.lowercased() {
        case "buy", "cover":
            return -delta * quantity
        default:
            return delta * quantity
        }
    }

    var nameMovePct: Double? {
        guard let proposed, let now, proposed > 0 else { return nil }
        return (now - proposed) / proposed * 100
    }

    /// How much of the proposed → target move is still left (signed in the trade's favor).
    var remainingToTarget: Double? {
        guard let now, let target, target > 0 else { return nil }
        switch side.lowercased() {
        case "buy", "cover":
            return target - now
        default:
            return now - target
        }
    }

    var proposedValue: String? {
        guard let proposed, proposed > 0 else { return nil }
        return AppFormat.money(proposed)
    }

    var nowValue: String {
        guard let now, now > 0 else { return "—" }
        if let pct = nameMovePct {
            return "\(AppFormat.money(now))  (\(AppFormat.percent(pct, signed: true)))"
        }
        return AppFormat.money(now)
    }

    var targetValue: String {
        if let target, target > 0 {
            if let left = remainingToTarget {
                if left <= 0 {
                    return "\(AppFormat.money(target))  (already reached)"
                }
                return "\(AppFormat.money(target))  (\(AppFormat.money(left)) left)"
            }
            return AppFormat.money(target)
        }
        return "none"
    }

    var delayValue: String? {
        guard let advantage = delayAdvantage else {
            guard let pct = nameMovePct else { return nil }
            return AppFormat.percent(pct, signed: true)
        }
        if abs(advantage) < 0.005 {
            return "unchanged"
        }
        let amount = AppFormat.money(abs(advantage))
        if advantage > 0 {
            return "better by \(amount) since proposed"
        }
        return "worse by \(amount) since proposed"
    }

    var showsDelayedFallback: Bool {
        pendingDelayedFallback || proposalDelayedFallback
    }

    var delayedFallbackStamp: String { "Delayed Quote" }

    var delayedFallbackNote: String {
        "This price is delayed.  You can still approve the order."
    }

    var missingTargetNote: String? {
        guard !hasTarget else { return nil }
        if let exitPlan, !exitPlan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return exitPlan
        }
        return "No target was set."
    }

    static func from(_ pending: PendingProposal) -> ProposalPriceReview {
        let proposal = pending.proposal
        let target = Self.resolveTarget(proposal)
        let stop = proposal.bracketStopLoss ?? proposal.scorecard?.sniperPoints?.stopLoss
        return ProposalPriceReview(
            proposed: pending.proposalReferencePrice ?? proposal.referencePrice ?? proposal.limitPrice,
            now: pending.proposalCurrentPrice,
            target: target,
            stop: stop,
            quantity: proposal.quantity,
            side: proposal.side,
            exitPlan: proposal.exitPlan,
            pendingDelayedFallback: pending.delayedFallback == true,
            proposalDelayedFallback: proposal.quoteDelayedFallback == true
        )
    }

    static func resolveTarget(_ proposal: Proposal) -> Double? {
        if let take = proposal.bracketTakeProfit, take > 0 { return take }
        if let take = proposal.scorecard?.sniperPoints?.takeProfit, take > 0 { return take }
        return nil
    }
}

/// ISO-8601 parsing for proposal safety math.  AppFormat's parser is private to
/// AppComponents, so this mirrors its two-formatter pattern (fractional seconds first).
enum ProposalISODate {
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        return ISO8601DateFormatter().date(from: value)
    }
}

/// Estimated realized P/L for an exit proposal against the held position it would close.
struct ExitPnlEstimate: Equatable {
    let pnl: Double
    let pnlPct: Double
    let shares: Double
    let currentPrice: Double
    let basisPrice: Double
}

/// Pure safety math for the pending-proposal card, mirroring the web approval card
/// (app/console/components/approval-card.tsx).  Dates and prices are injected so tests
/// never compare a live clock against a fixed stamp.
enum ProposalSafetyMath {
    /// Expiry countdown from `policy.proposalExpiryMinutes` (web `expiryIso` + `timeUntil`).
    /// nil when the policy sets no lifetime or the creation stamp is unreadable — the card
    /// then omits the line rather than guessing.
    static func expiryNote(createdAt: String?, expiryMinutes: Int?, now: Date) -> String? {
        guard let expiryMinutes, expiryMinutes > 0,
              let created = ProposalISODate.parse(createdAt) else { return nil }
        let expiresAt = created.addingTimeInterval(TimeInterval(expiryMinutes) * 60)
        let diff = expiresAt.timeIntervalSince(now)
        if diff <= 0 {
            return "Expiry reached — nothing is traded."
        }
        let m = Int(ceil(diff / 60))
        let phrase: String
        if m < 60 {
            phrase = "in \(m)m"
        } else {
            let h = m / 60
            phrase = h < 24 ? "in \(h)h \(m % 60)m" : "in \(h / 24)d"
        }
        return "Expires \(phrase) — nothing is traded."
    }

    /// Exit estimated P/L, mirroring approval-card.tsx: only for a sell/cover whose side
    /// actually closes the matched position's sign; price prefers the proposal's own fresh
    /// quote and falls back to the position mark; a price equal to average cost is the
    /// broker's no-quote fallback and is treated as unavailable; quantity is capped to the
    /// current position size so a stale oversize exit never overstates the estimate.
    static func exitEstimatedPnl(
        proposal: Proposal,
        currentPrice: Double?,
        positions: [Position]
    ) -> ExitPnlEstimate? {
        let side = proposal.side.lowercased()
        guard side == "sell" || side == "cover" else { return nil }
        let symbol = proposal.symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard let position = positions.first(where: {
            $0.symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == symbol
        }) else { return nil }
        guard position.quantity != 0 else { return nil }
        // A long closes with a sell; a short closes with a cover (or a raw buy).
        let closes = position.quantity < 0 ? (side == "cover" || side == "buy") : side == "sell"
        guard closes else { return nil }
        guard let basis = position.averageCost, basis > 0 else { return nil }

        let mark = position.quantity != 0 ? position.marketValue / position.quantity : nil
        let candidate = currentPrice ?? (mark.flatMap { $0 > 0 ? $0 : nil })
        guard let price = candidate, price > 0 else { return nil }
        // marketValue = quantity × averageCost is the adapter's no-quote fallback: a fake $0 P/L.
        guard abs(price - basis) / basis >= 1e-9 else { return nil }

        let requested: Double?
        if let quantity = proposal.quantity {
            requested = abs(quantity)
        } else if let dollarAmount = proposal.dollarAmount,
                  let anchor = proposal.limitPrice ?? proposal.stopPrice ?? proposal.referencePrice,
                  anchor > 0 {
            requested = abs(dollarAmount / anchor)
        } else {
            requested = nil
        }
        guard let requested, requested > 0 else { return nil }
        let shares = min(requested, abs(position.quantity))
        guard shares > 0 else { return nil }

        let perShare = position.quantity < 0 ? basis - price : price - basis
        return ExitPnlEstimate(
            pnl: perShare * shares,
            pnlPct: perShare / basis * 100,
            shares: shares,
            currentPrice: price,
            basisPrice: basis
        )
    }

    /// Owner-facing hold bucket label (web HOLD_REASON_LABELS, src/lib/hold-reason.ts).
    /// Unknown wire values render nothing rather than a raw slug.
    static func holdReasonLabel(_ raw: String?) -> String? {
        switch raw {
        case "red_team_unavailable": return "Red Team review needed"
        case "funding_sell": return "Funding sell"
        case "policy_revert": return "Policy hold"
        case "other": return "Other"
        default: return nil
        }
    }
}

/// Pure marker-position math for the risk/reward ladder.  Prices are mapped into
/// trade-favorable space (positive = toward the target) so a long reads stop-left /
/// target-right and a short mirrors it, then normalized onto a 0...1 track.
struct RiskRewardLadderMath {
    let stopPosition: Double
    let entryPosition: Double
    let targetPosition: Double
    let markPosition: Double?
    /// Reward:risk multiple; nil when either leg is zero or on the wrong side.
    let rewardRisk: Double?
    /// Fill drift of the mark versus entry, in the card's Delay-row vocabulary: a buy
    /// below its proposed entry is favorable, a short above it is favorable.  nil when
    /// there is no mark or the drift is negligible.
    let markIsFavorable: Bool?

    static func layout(
        side: String,
        entry: Double?,
        stop: Double?,
        target: Double?,
        mark: Double?
    ) -> RiskRewardLadderMath? {
        guard let entry, entry > 0, let stop, stop > 0, let target, target > 0 else { return nil }
        let normalizedSide = side.lowercased()
        // Cover closes a short, so the favorable direction is short-like; only a raw buy is long.
        let isLong = normalizedSide == "buy"
        func favorable(_ price: Double) -> Double { isLong ? price - entry : entry - price }

        let fStop = favorable(stop)
        let fTarget = favorable(target)
        let fMark = mark.flatMap { $0 > 0 ? favorable($0) : nil }

        var values = [fStop, 0, fTarget]
        if let fMark { values.append(fMark) }
        let lo = values.min() ?? 0
        let hi = values.max() ?? 0
        let span = hi - lo
        func position(_ value: Double) -> Double {
            guard span > 1e-9 else { return 0.5 }
            return min(max((value - lo) / span, 0), 1)
        }

        let reward = fTarget
        let risk = -fStop
        let ratio = reward > 0 && risk > 0 ? reward / risk : nil

        var favorableDrift: Bool?
        if let fMark {
            // Fill favorability is the OPPOSITE sign of trade-direction space: paying
            // less than proposed (buy) or selling above it (short) is the better fill —
            // the same vocabulary as the card's Delay row (delayAdvantage).
            let fillDelta = -fMark
            if fillDelta > 1e-9 {
                favorableDrift = true
            } else if fillDelta < -1e-9 {
                favorableDrift = false
            }
        }

        return RiskRewardLadderMath(
            stopPosition: position(fStop),
            entryPosition: position(0),
            targetPosition: position(fTarget),
            markPosition: fMark.map(position),
            rewardRisk: ratio,
            markIsFavorable: favorableDrift
        )
    }
}

/// Compact visual ladder: Stop / Entry / Target markers proportional to price, plus the
/// current mark colored by fill drift.  Pure SwiftUI shapes; the math lives in
/// RiskRewardLadderMath so XCTest can cover it without hosting a view.
struct ProposalRiskRewardLadder: View {
    let review: ProposalPriceReview

    var body: some View {
        if let layout = RiskRewardLadderMath.layout(
            side: review.side,
            entry: review.proposed,
            stop: review.stop,
            target: review.target,
            mark: review.now
        ) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("Risk/Reward")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let ratio = layout.rewardRisk {
                        Text("\(ratio.formatted(.number.precision(.fractionLength(1))))× reward:risk")
                            .font(.appCaption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                GeometryReader { proxy in
                    let width = proxy.size.width
                    ZStack(alignment: .topLeading) {
                        Capsule()
                            .fill(Color.primary.opacity(0.10))
                            .frame(width: width, height: 3)
                            .offset(y: 5)
                        marker(width: width, position: layout.stopPosition, label: "Stop", color: AppPalette.negative)
                        marker(width: width, position: layout.entryPosition, label: "Entry", color: AppPalette.accent)
                        marker(width: width, position: layout.targetPosition, label: "Target", color: AppPalette.positive)
                        if let markPosition = layout.markPosition {
                            marker(width: width, position: markPosition, label: "Now", color: markColor(layout.markIsFavorable))
                        }
                    }
                }
                .frame(height: 30)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilitySummary(layout))
        }
    }

    private func markColor(_ favorable: Bool?) -> Color {
        switch favorable {
        case .some(true): return AppPalette.positive
        case .some(false): return AppPalette.negative
        case .none: return AppPalette.accent
        }
    }

    private func marker(width: CGFloat, position: Double, label: String, color: Color) -> some View {
        // Inset the extremes so the end labels stay inside the card instead of clipping.
        let x = min(max(width * position, 18), max(18, width - 18))
        return VStack(spacing: 2) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.appCaption2)
                .foregroundStyle(color)
        }
        .fixedSize()
        .position(x: x, y: 14)
    }

    private func accessibilitySummary(_ layout: RiskRewardLadderMath) -> String {
        var parts = [
            "Stop \(AppFormat.money(review.stop))",
            "Entry \(AppFormat.money(review.proposed))",
            "Target \(AppFormat.money(review.target))"
        ]
        if let ratio = layout.rewardRisk {
            parts.append("\(ratio.formatted(.number.precision(.fractionLength(1)))) times reward to risk")
        }
        return parts.joined(separator: ", ")
    }
}
