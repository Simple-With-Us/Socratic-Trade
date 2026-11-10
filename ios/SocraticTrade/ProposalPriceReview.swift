import Foundation

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
