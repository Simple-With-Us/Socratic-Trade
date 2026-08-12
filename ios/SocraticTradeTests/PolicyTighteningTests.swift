import XCTest
@testable import SocraticTrade

/// Tighten-only is the whole safety property of the phone's guardrail controls, so it is a pure
/// function tested directly: no proposed value may ever be looser than what the snapshot says
/// the policy is today.
final class PolicyTighteningTests: XCTestCase {
    func testOnlyAutopilotHasSomewhereTighterToGo() {
        XCTAssertEqual(PolicyTightening.tightenedAuthority(current: "decide"), "propose")
        XCTAssertEqual(PolicyTightening.tightenedAuthority(current: " DECIDE "), "propose")
        // Already Ask-First: nothing to offer.  Loosening back to Autopilot is console-only.
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: "propose"))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: nil))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: ""))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: "something-new"))
    }

    func testCapReductionsAreStrictlyLowerAndRespectTheServerFloor() {
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 2500, competingPercentCap: nil, fraction: 0.5),
            1250
        )
        // Rounds DOWN, so rounding can never produce a value above the request.
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 999, competingPercentCap: nil, fraction: 0.75),
            749
        )
        // Server floor is 1 (numericFields: ["maxOrderNotional", 1, 100_000]).
        XCTAssertNil(PolicyTightening.tightenedCap(current: 1.2, competingPercentCap: nil, fraction: 0.25))
        XCTAssertNil(PolicyTightening.tightenedCap(current: 1, competingPercentCap: nil, fraction: 0.5))
    }

    func testNeverProposesAValueThatWouldRaiseOrHoldTheCap() {
        for fraction in [1.0, 1.25, 2.0, 0.0, -0.5] {
            XCTAssertNil(
                PolicyTightening.tightenedCap(current: 2500, competingPercentCap: nil, fraction: fraction),
                "fraction \(fraction) is not a reduction"
            )
        }
        for value in PolicyTightening.tightenedCapOptions(current: 2500, competingPercentCap: nil) {
            XCTAssertLessThan(value, 2500)
            XCTAssertGreaterThanOrEqual(value, PolicyTightening.minimumNotional)
        }
    }

    func testUnknownOrPercentBasedCapsOfferNothing() {
        // No value in the snapshot: "lower than unknown" is not a claim this app can make.
        XCTAssertNil(PolicyTightening.tightenedCap(current: nil, competingPercentCap: nil, fraction: 0.5))
        XCTAssertTrue(PolicyTightening.tightenedCapOptions(current: nil, competingPercentCap: nil).isEmpty)
        // A stored percent-of-NAV cap makes the notional/percent pair exclusive server-side
        // (normalizeExclusivePolicyCaps): sending a notional would DELETE the percent cap and
        // change which rule binds — possibly a loosening.  Console owns that switch.
        XCTAssertNil(PolicyTightening.tightenedCap(current: 2500, competingPercentCap: 5, fraction: 0.5))
        XCTAssertTrue(PolicyTightening.tightenedCapOptions(current: 2500, competingPercentCap: 5).isEmpty)
        XCTAssertNil(PolicyTightening.tightenedCap(current: .nan, competingPercentCap: nil, fraction: 0.5))
        XCTAssertNil(PolicyTightening.tightenedCap(current: .infinity, competingPercentCap: nil, fraction: 0.5))
    }

    func testOptionsAreOrderedMildestFirstAndDeduplicated() {
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2000, competingPercentCap: nil), [1500, 1000, 500])
        // Small caps collapse to fewer distinct whole-dollar values; no duplicates survive
        // (a $2 cap rounds 75% and 50% to the same $1, and 25% falls under the floor).
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2, competingPercentCap: nil), [1])
    }

    func testPayloadsMatchTheServerPolicyPatchContract() {
        let authority = PolicyTightening.authorityPayload()
        let patch = try? XCTUnwrap(authority["patch"] as? [String: Any])
        XCTAssertEqual(patch?["strategyAuthority"] as? String, "propose")

        let capPayload = PolicyTightening.capPayload(.maxDailyNotional, value: 1250)
        let capPatch = try? XCTUnwrap(capPayload["patch"] as? [String: Any])
        XCTAssertEqual(capPatch?["maxDailyNotional"] as? Double, 1250)
        // Field names are the server's own TradingPolicy keys, not app-invented aliases.
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.rawValue, "maxOrderNotional")
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.rawValue, "maxDailyNotional")
    }

    func testCapsReadTheirOwnFieldsFromTheSnapshotPolicy() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(policySnapshotJSON.utf8))

        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.currentValue(in: snapshot.policy), 2500)
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.currentValue(in: snapshot.policy), 10000)
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.competingPercentCap(in: snapshot.policy), 5)
        XCTAssertNil(PolicyTightening.Cap.maxDailyNotional.competingPercentCap(in: snapshot.policy))
        // maxOrderNotional carries a competing percent cap here, so only the daily cap is offerable.
        XCTAssertTrue(
            PolicyTightening.tightenedCapOptions(
                current: PolicyTightening.Cap.maxOrderNotional.currentValue(in: snapshot.policy),
                competingPercentCap: PolicyTightening.Cap.maxOrderNotional.competingPercentCap(in: snapshot.policy)
            ).isEmpty
        )
        XCTAssertFalse(
            PolicyTightening.tightenedCapOptions(
                current: PolicyTightening.Cap.maxDailyNotional.currentValue(in: snapshot.policy),
                competingPercentCap: PolicyTightening.Cap.maxDailyNotional.competingPercentCap(in: snapshot.policy)
            ).isEmpty
        )
    }

    private let policySnapshotJSON = #"""
    {
      "readiness": {
        "hasAccount": true,
        "hasUniverse": true,
        "systemState": "active",
        "strategyAuthority": "decide",
        "selectedAccountNumber": "account-number",
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {
        "systemState": "active",
        "strategyAuthority": "decide",
        "maxOrderNotional": 2500,
        "maxOrderPctOfNav": 5,
        "maxDailyNotional": 10000
      }
    }
    """#
}
