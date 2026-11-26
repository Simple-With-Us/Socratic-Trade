import XCTest
@testable import SocraticTrade

/// ST-4670 triage bar: the filter buckets and sort orders are pure functions over the
/// decoded queue, so they are tested without hosting SwiftUI.  Every pending row is
/// status "proposed" server-side; the buckets split on the decision receipts.
final class ProposalTriageTests: XCTestCase {
    private func proposal(
        id: String,
        createdAt: String? = "2026-11-24T15:00:00.000Z",
        confidence: Double? = nil,
        holdReason: String? = nil,
        humanReview: Bool = false,
        redVerdict: String? = nil
    ) throws -> PendingProposal {
        var fields: [String] = [
            "\"symbol\": \"AAPL\"",
            "\"side\": \"buy\"",
            "\"type\": \"market\"",
            "\"timeInForce\": \"day\""
        ]
        if let confidence { fields.append("\"confidenceScore\": \(confidence)") }
        if let holdReason { fields.append("\"holdReason\": \"\(holdReason)\"") }
        if humanReview {
            fields.append("\"humanReviewReasons\": [{\"code\": \"policy_revert\", \"title\": \"Policy hold\", \"summary\": \"A preference needs your call.\"}]")
        }
        if let redVerdict {
            fields.append("\"redTeamVerdict\": {\"verdict\": \"\(redVerdict)\", \"rejected\": \(redVerdict == "reject"), \"available\": true, \"reason\": \"Fixture verdict.\"}")
        }
        let createdJSON = createdAt.map { "\"\($0)\"" } ?? "null"
        let json = """
        {
          "id": "\(id)",
          "createdAt": \(createdJSON),
          "proposal": { \(fields.joined(separator: ", ")) }
        }
        """
        return try JSONDecoder().decode(PendingProposal.self, from: Data(json.utf8))
    }

    func testFilterBucketsSplitOnDecisionReceipts() throws {
        let held = try proposal(id: "held", holdReason: "policy_revert")
        let humanReview = try proposal(id: "review", humanReview: true)
        let redRejected = try proposal(id: "red", redVerdict: "reject")
        let clean = try proposal(id: "clean", confidence: 80)

        XCTAssertTrue(matchesProposalFilter(held, filter: .all))
        XCTAssertTrue(matchesProposalFilter(held, filter: .needsReview))
        XCTAssertTrue(matchesProposalFilter(humanReview, filter: .needsReview))
        XCTAssertFalse(matchesProposalFilter(clean, filter: .needsReview))

        XCTAssertTrue(matchesProposalFilter(redRejected, filter: .redRejected))
        XCTAssertFalse(matchesProposalFilter(clean, filter: .redRejected))
        // An approved Red verdict is not a rejection.
        let redApproved = try proposal(id: "red-ok", redVerdict: "approve")
        XCTAssertFalse(matchesProposalFilter(redApproved, filter: .redRejected))

        XCTAssertTrue(matchesProposalFilter(clean, filter: .ready))
        XCTAssertFalse(matchesProposalFilter(held, filter: .ready))
        XCTAssertFalse(matchesProposalFilter(redRejected, filter: .ready))
        // Buckets may overlap: a held Red rejection matches both.
        let heldRed = try proposal(id: "held-red", holdReason: "red_team_unavailable", redVerdict: "reject")
        XCTAssertTrue(matchesProposalFilter(heldRed, filter: .needsReview))
        XCTAssertTrue(matchesProposalFilter(heldRed, filter: .redRejected))
        XCTAssertFalse(matchesProposalFilter(heldRed, filter: .ready))
    }

    func testSortNewestAndOldestUseCreatedAt() throws {
        let older = try proposal(id: "older", createdAt: "2026-11-24T14:00:00.000Z")
        let newer = try proposal(id: "newer", createdAt: "2026-11-24T16:00:00.000Z")
        let undated = try proposal(id: "undated", createdAt: nil)

        let newest = sortedProposals([older, undated, newer], by: .newest)
        XCTAssertEqual(newest.map(\.id), ["newer", "older", "undated"])
        let oldest = sortedProposals([newer, undated, older], by: .oldest)
        XCTAssertEqual(oldest.map(\.id), ["older", "newer", "undated"])
    }

    func testSortConfidenceDescendingWithMissingLast() throws {
        let low = try proposal(id: "low", confidence: 40)
        let high = try proposal(id: "high", confidence: 90)
        let unscored = try proposal(id: "unscored")

        let sorted = sortedProposals([low, unscored, high], by: .confidence)
        XCTAssertEqual(sorted.map(\.id), ["high", "low", "unscored"])
    }

    func testSortTiesBreakOnIdSoTheQueueNeverShuffles() throws {
        let a = try proposal(id: "a", createdAt: "2026-11-24T15:00:00.000Z", confidence: 70)
        let b = try proposal(id: "b", createdAt: "2026-11-24T15:00:00.000Z", confidence: 70)
        for order in ProposalSortOrder.allCases {
            XCTAssertEqual(sortedProposals([b, a], by: order).map(\.id), ["a", "b"])
            XCTAssertEqual(sortedProposals([a, b], by: order).map(\.id), ["a", "b"])
        }
    }

    func testFilterAndSortDefaultsKeepTheWholeQueue() throws {
        let queue = try [
            proposal(id: "1", createdAt: "2026-11-24T14:00:00.000Z"),
            proposal(id: "2", createdAt: "2026-11-24T16:00:00.000Z"),
            proposal(id: "3", createdAt: "2026-11-24T15:00:00.000Z", holdReason: "other")
        ]
        let visible = sortedProposals(queue.filter { matchesProposalFilter($0, filter: .all) }, by: .newest)
        XCTAssertEqual(visible.map(\.id), ["2", "3", "1"])
    }
}