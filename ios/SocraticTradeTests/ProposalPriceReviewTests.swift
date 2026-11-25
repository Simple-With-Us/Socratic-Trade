import XCTest
@testable import SocraticTrade

final class ProposalPriceReviewTests: XCTestCase {
    func testBuyDelayWorseWhenPriceRises() {
        let review = ProposalPriceReview(
            proposed: 200,
            now: 202.2,
            target: 220,
            stop: 190,
            quantity: 7,
            side: "buy",
            exitPlan: nil,
            pendingDelayedFallback: false,
            proposalDelayedFallback: false
        )
        XCTAssertEqual(review.delayAdvantage ?? 0, -15.4, accuracy: 0.01)
        XCTAssertEqual(review.nameMovePct ?? 0, 1.1, accuracy: 0.01)
        XCTAssertEqual(review.remainingToTarget ?? 0, 17.8, accuracy: 0.01)
        XCTAssertTrue(review.hasTarget)
        XCTAssertEqual(review.targetValue.contains("left"), true)
        XCTAssertEqual(review.delayValue?.contains("worse"), true)
        XCTAssertNil(review.missingTargetNote)
    }

    func testMissingTargetUsesExitPlanThenFallbackCopy() {
        let withPlan = ProposalPriceReview(
            proposed: 50,
            now: 50,
            target: nil,
            stop: 45,
            quantity: 2,
            side: "buy",
            exitPlan: "A single target would not help; trail 50% after +8%.",
            pendingDelayedFallback: false,
            proposalDelayedFallback: false
        )
        XCTAssertFalse(withPlan.hasTarget)
        XCTAssertEqual(withPlan.targetValue, "none")
        XCTAssertEqual(withPlan.missingTargetNote, "A single target would not help; trail 50% after +8%.")

        let blank = ProposalPriceReview(
            proposed: 50,
            now: 51,
            target: nil,
            stop: nil,
            quantity: 2,
            side: "buy",
            exitPlan: nil,
            pendingDelayedFallback: false,
            proposalDelayedFallback: false
        )
        XCTAssertTrue(blank.missingTargetNote?.contains("No target was set") == true)
    }

    func testScorecardTakeProfitIsUsedWhenBracketIsMissing() throws {
        let pending = try JSONDecoder().decode(
            PendingProposal.self,
            from: Data(#"""
            {
              "id": "p1",
              "proposalReferencePrice": 10,
              "proposalCurrentPrice": 10.5,
              "proposal": {
                "symbol": "MSFT",
                "side": "buy",
                "type": "market",
                "quantity": 3,
                "timeInForce": "day",
                "scorecard": { "sniperPoints": { "takeProfit": 12, "stopLoss": 9 } }
              }
            }
            """#.utf8)
        )
        let review = ProposalPriceReview.from(pending)
        XCTAssertEqual(review.target, 12)
        XCTAssertEqual(review.stop, 9)
        XCTAssertEqual(review.proposed, 10)
        XCTAssertEqual(review.now, 10.5)
    }

    func testShortDelayBetterWhenPriceRises() {
        let review = ProposalPriceReview(
            proposed: 100,
            now: 102,
            target: 90,
            stop: 108,
            quantity: 4,
            side: "short",
            exitPlan: nil,
            pendingDelayedFallback: false,
            proposalDelayedFallback: false
        )
        XCTAssertEqual(review.delayAdvantage ?? 0, 8, accuracy: 0.01)
        XCTAssertEqual(review.delayValue?.contains("better"), true)
        XCTAssertEqual(review.remainingToTarget ?? 0, 12, accuracy: 0.01)
    }

    func testDelayedFallbackStampOnCard() throws {
        let pending = try JSONDecoder().decode(
            PendingProposal.self,
            from: Data(#"""
            {
              "id": "p-delayed",
              "delayedFallback": true,
              "quoteProvider": "yahoo-finance-delayed",
              "proposalReferencePrice": 10,
              "proposalCurrentPrice": 10.2,
              "proposal": {
                "symbol": "XOM",
                "side": "buy",
                "type": "market",
                "quantity": 5,
                "timeInForce": "day",
                "quoteDelayedFallback": true
              }
            }
            """#.utf8)
        )
        let review = ProposalPriceReview.from(pending)
        XCTAssertTrue(review.showsDelayedFallback)
        XCTAssertEqual(review.delayedFallbackStamp, "Delayed Quote")
        XCTAssertTrue(review.delayedFallbackNote.contains("You can still approve the order"))
    }

    // MARK: - ST-4670 risk/reward ladder math

    func testLadderLongReadsStopLeftEntryMiddleTargetRight() throws {
        let layout = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 90, target: 130, mark: nil))
        // Favorable space: stop -10, entry 0, target +30 → span 40.
        XCTAssertEqual(layout.stopPosition, 0.0, accuracy: 1e-9)
        XCTAssertEqual(layout.entryPosition, 0.25, accuracy: 1e-9)
        XCTAssertEqual(layout.targetPosition, 1.0, accuracy: 1e-9)
        XCTAssertEqual(layout.rewardRisk ?? 0, 3.0, accuracy: 1e-9)
        XCTAssertNil(layout.markPosition)
        XCTAssertNil(layout.markIsFavorable)
    }

    func testLadderShortMirrorsLong() throws {
        let layout = try XCTUnwrap(RiskRewardLadderMath.layout(side: "short", entry: 100, stop: 110, target: 70, mark: nil))
        XCTAssertEqual(layout.stopPosition, 0.0, accuracy: 1e-9)
        XCTAssertEqual(layout.entryPosition, 0.25, accuracy: 1e-9)
        XCTAssertEqual(layout.targetPosition, 1.0, accuracy: 1e-9)
        XCTAssertEqual(layout.rewardRisk ?? 0, 3.0, accuracy: 1e-9)
    }

    func testLadderMarkPositionAndFillDrift() throws {
        // Buy: mark below the proposed entry is the better fill (Delay-row vocabulary).
        let buy = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 90, target: 130, mark: 95))
        XCTAssertEqual(buy.markPosition ?? 0, 0.125, accuracy: 1e-9)
        XCTAssertEqual(buy.markIsFavorable, true)
        let buyAdverse = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 90, target: 130, mark: 105))
        XCTAssertEqual(buyAdverse.markIsFavorable, false)
        // Short: mark above the proposed entry is the better fill.
        let short = try XCTUnwrap(RiskRewardLadderMath.layout(side: "short", entry: 100, stop: 110, target: 70, mark: 105))
        XCTAssertEqual(short.markIsFavorable, true)
        let shortAdverse = try XCTUnwrap(RiskRewardLadderMath.layout(side: "short", entry: 100, stop: 110, target: 70, mark: 95))
        XCTAssertEqual(shortAdverse.markIsFavorable, false)
        // Unchanged mark carries no drift verdict.
        let flat = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 90, target: 130, mark: 100))
        XCTAssertNil(flat.markIsFavorable)
    }

    func testLadderDegenerateStopEqualsEntry() throws {
        let layout = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 100, target: 120, mark: nil))
        XCTAssertEqual(layout.stopPosition, layout.entryPosition, accuracy: 1e-9)
        // Zero risk leg: no reward:risk multiple is claimed.
        XCTAssertNil(layout.rewardRisk)
        XCTAssertEqual(layout.targetPosition, 1.0, accuracy: 1e-9)
    }

    func testLadderAllPricesEqualCentersEveryMarker() throws {
        let layout = try XCTUnwrap(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 100, target: 100, mark: 100))
        XCTAssertEqual(layout.stopPosition, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout.entryPosition, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout.targetPosition, 0.5, accuracy: 1e-9)
        XCTAssertEqual(layout.markPosition ?? 0, 0.5, accuracy: 1e-9)
        XCTAssertNil(layout.rewardRisk)
    }

    func testLadderMissingOrInvalidPricesReturnsNil() {
        XCTAssertNil(RiskRewardLadderMath.layout(side: "buy", entry: nil, stop: 90, target: 130, mark: nil))
        XCTAssertNil(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: nil, target: 130, mark: nil))
        XCTAssertNil(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: 90, target: nil, mark: nil))
        XCTAssertNil(RiskRewardLadderMath.layout(side: "buy", entry: 0, stop: 90, target: 130, mark: nil))
        XCTAssertNil(RiskRewardLadderMath.layout(side: "buy", entry: 100, stop: -1, target: 130, mark: nil))
    }

    // MARK: - ST-4670 expiry countdown (injected clock)

    func testExpiryCountdownFormats() throws {
        let created = "2026-11-24T15:00:00.000Z"
        let now = try XCTUnwrap(ProposalISODate.parse("2026-11-24T15:30:00.000Z"))
        XCTAssertEqual(
            ProposalSafetyMath.expiryNote(createdAt: created, expiryMinutes: 60, now: now),
            "Expires in 30m — nothing is traded."
        )
        let later = try XCTUnwrap(ProposalISODate.parse("2026-11-24T15:55:00.000Z"))
        XCTAssertEqual(
            ProposalSafetyMath.expiryNote(createdAt: created, expiryMinutes: 180, now: later),
            "Expires in 2h 5m — nothing is traded."
        )
        let days = try XCTUnwrap(ProposalISODate.parse("2026-11-24T15:00:00.000Z"))
        XCTAssertEqual(
            ProposalSafetyMath.expiryNote(createdAt: "2026-11-21T15:00:00.000Z", expiryMinutes: 60 * 24 * 6, now: days),
            "Expires in 3d — nothing is traded."
        )
    }

    func testExpiryReachedAndMissingInputs() throws {
        let now = try XCTUnwrap(ProposalISODate.parse("2026-11-24T16:00:00.000Z"))
        XCTAssertEqual(
            ProposalSafetyMath.expiryNote(createdAt: "2026-11-24T15:00:00.000Z", expiryMinutes: 60, now: now),
            "Expiry reached — nothing is traded."
        )
        // No lifetime, zero/negative lifetime, or an unreadable stamp → no line at all.
        XCTAssertNil(ProposalSafetyMath.expiryNote(createdAt: "2026-11-24T15:00:00.000Z", expiryMinutes: nil, now: now))
        XCTAssertNil(ProposalSafetyMath.expiryNote(createdAt: "2026-11-24T15:00:00.000Z", expiryMinutes: 0, now: now))
        XCTAssertNil(ProposalSafetyMath.expiryNote(createdAt: "2026-11-24T15:00:00.000Z", expiryMinutes: -5, now: now))
        XCTAssertNil(ProposalSafetyMath.expiryNote(createdAt: nil, expiryMinutes: 60, now: now))
        XCTAssertNil(ProposalSafetyMath.expiryNote(createdAt: "not-a-date", expiryMinutes: 60, now: now))
        // Fractional-second stamps parse too.
        XCTAssertNotNil(ProposalSafetyMath.expiryNote(createdAt: "2026-11-24T15:00:00.123Z", expiryMinutes: 60, now: now))
    }

    // MARK: - ST-4670 exit estimated P/L (web approval-card parity)

    private func exitProposal(
        side: String,
        quantity: Double? = 10,
        dollarAmount: Double? = nil,
        limitPrice: Double? = nil
    ) throws -> Proposal {
        let quantityJSON = quantity.map { "\($0)" } ?? "null"
        let dollarJSON = dollarAmount.map { "\($0)" } ?? "null"
        let limitJSON = limitPrice.map { "\($0)" } ?? "null"
        let json = """
        {
          "symbol": "AAPL",
          "side": "\(side)",
          "type": "market",
          "quantity": \(quantityJSON),
          "dollarAmount": \(dollarJSON),
          "limitPrice": \(limitJSON),
          "timeInForce": "day"
        }
        """
        return try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
    }

    private func position(quantity: Double, averageCost: Double?, marketValue: Double) throws -> Position {
        let costJSON = averageCost.map { "\($0)" } ?? "null"
        let json = """
        { "symbol": "AAPL", "quantity": \(quantity), "marketValue": \(marketValue), "averageCost": \(costJSON) }
        """
        return try JSONDecoder().decode(Position.self, from: Data(json.utf8))
    }

    func testExitPnlSellAgainstLongPosition() throws {
        let estimate = try XCTUnwrap(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
        XCTAssertEqual(estimate.pnl, 100, accuracy: 1e-9)
        XCTAssertEqual(estimate.pnlPct, 10, accuracy: 1e-9)
        XCTAssertEqual(estimate.shares, 10, accuracy: 1e-9)
        XCTAssertEqual(estimate.basisPrice, 100, accuracy: 1e-9)
    }

    func testExitPnlCoverOfShortSignFlips() throws {
        let estimate = try XCTUnwrap(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "cover"),
            currentPrice: 90,
            positions: [position(quantity: -10, averageCost: 100, marketValue: -900)]
        ))
        XCTAssertEqual(estimate.pnl, 100, accuracy: 1e-9)
        XCTAssertEqual(estimate.pnlPct, 10, accuracy: 1e-9)
    }

    func testExitPnlOmittedWhenSideDoesNotCloseThePosition() throws {
        // A sell card over a now-short position opens more short exposure — no long-exit P/L.
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: 110,
            positions: [position(quantity: -10, averageCost: 100, marketValue: -1100)]
        ))
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "cover"),
            currentPrice: 90,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 900)]
        ))
        // Openings never carry an exit estimate.
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "buy"),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
    }

    func testExitPnlCapsOversizeExitToHeldShares() throws {
        let estimate = try XCTUnwrap(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell", quantity: 20),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
        XCTAssertEqual(estimate.shares, 10, accuracy: 1e-9)
        XCTAssertEqual(estimate.pnl, 100, accuracy: 1e-9)
    }

    func testExitPnlOmittedWhenPriceEqualsCostFallback() throws {
        // marketValue = quantity × averageCost is the broker's no-quote fallback: fake $0 P/L.
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: 100,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1000)]
        ))
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: nil,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1000)]
        ))
    }

    func testExitPnlFallsBackToPositionMarkAndDerivesDollarQuantity() throws {
        // No fresh quote: the position's own mark (marketValue / quantity) prices the exit.
        let fromMark = try XCTUnwrap(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: nil,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
        XCTAssertEqual(fromMark.currentPrice, 110, accuracy: 1e-9)
        XCTAssertEqual(fromMark.pnl, 100, accuracy: 1e-9)
        // Dollar-based exit: shares = dollarAmount / anchor price.
        let dollarBased = try XCTUnwrap(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell", quantity: nil, dollarAmount: 1100, limitPrice: 110),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
        XCTAssertEqual(dollarBased.shares, 10, accuracy: 1e-9)
        // No position, no basis, or no usable quantity → omitted, never fabricated.
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: 110,
            positions: []
        ))
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell"),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: nil, marketValue: 1100)]
        ))
        XCTAssertNil(ProposalSafetyMath.exitEstimatedPnl(
            proposal: exitProposal(side: "sell", quantity: nil),
            currentPrice: 110,
            positions: [position(quantity: 10, averageCost: 100, marketValue: 1100)]
        ))
    }

    func testHoldReasonLabelsMatchWebVocabulary() {
        XCTAssertEqual(ProposalSafetyMath.holdReasonLabel("red_team_unavailable"), "Red Team review needed")
        XCTAssertEqual(ProposalSafetyMath.holdReasonLabel("funding_sell"), "Funding sell")
        XCTAssertEqual(ProposalSafetyMath.holdReasonLabel("policy_revert"), "Policy hold")
        XCTAssertEqual(ProposalSafetyMath.holdReasonLabel("other"), "Other")
        XCTAssertNil(ProposalSafetyMath.holdReasonLabel("unknown_wire_slug"))
        XCTAssertNil(ProposalSafetyMath.holdReasonLabel(nil))
    }
}
