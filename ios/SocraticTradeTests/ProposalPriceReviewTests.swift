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
}
