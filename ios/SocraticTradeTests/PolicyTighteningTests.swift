import XCTest
@testable import SocraticTrade

/// Bidirectional authority + cap edits.  Tightening stays one tap; loosening is a typed
/// confirm on live accounts.  Percent-of-NAV caps are editable on the phone.
final class PolicyTighteningTests: XCTestCase {
    func testAuthorityGoesBothDirections() {
        XCTAssertEqual(PolicyTightening.counterpartAuthority(current: "decide"), "propose")
        XCTAssertEqual(PolicyTightening.counterpartAuthority(current: " DECIDE "), "propose")
        XCTAssertEqual(PolicyTightening.counterpartAuthority(current: "propose"), "decide")
        XCTAssertEqual(PolicyTightening.counterpartAuthority(current: " PROPOSE "), "decide")
        XCTAssertNil(PolicyTightening.counterpartAuthority(current: nil))
        XCTAssertNil(PolicyTightening.counterpartAuthority(current: ""))
        XCTAssertNil(PolicyTightening.counterpartAuthority(current: "something-new"))
        XCTAssertTrue(PolicyTightening.isLooseningAuthority(from: "propose", to: "decide"))
        XCTAssertFalse(PolicyTightening.isLooseningAuthority(from: "decide", to: "propose"))
        XCTAssertTrue(PolicyTightening.needsAutopilotPhrase(to: "decide"))
        XCTAssertFalse(PolicyTightening.needsAutopilotPhrase(to: "propose"))
    }

    func testTypedConfirmMatchesLiveLooseningRules() {
        XCTAssertTrue(
            PolicyTightening.needsTypedConfirm(
                isLiveAccount: true,
                requireTypedConfirmation: true,
                isLoosening: true
            )
        )
        XCTAssertFalse(
            PolicyTightening.needsTypedConfirm(
                isLiveAccount: true,
                requireTypedConfirmation: true,
                isLoosening: false
            )
        )
        XCTAssertFalse(
            PolicyTightening.needsTypedConfirm(
                isLiveAccount: false,
                requireTypedConfirmation: true,
                isLoosening: true
            )
        )
        XCTAssertFalse(
            PolicyTightening.needsTypedConfirm(
                isLiveAccount: true,
                requireTypedConfirmation: false,
                isLoosening: true
            )
        )
        XCTAssertTrue(
            PolicyTightening.needsTypedConfirm(
                isLiveAccount: true,
                requireTypedConfirmation: nil,
                isLoosening: true
            )
        )
    }

    func testCapReductionsAreStrictlyLowerAndRespectTheServerFloor() {
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 2500, competingPercentCap: nil, fraction: 0.5),
            1250
        )
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 999, competingPercentCap: nil, fraction: 0.75),
            749
        )
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

    func testPercentBasedCapsAreEditableOnThePhone() throws {
        XCTAssertNil(PolicyTightening.tightenedCap(current: nil, competingPercentCap: nil, fraction: 0.5))
        XCTAssertTrue(PolicyTightening.tightenedCapOptions(current: nil, competingPercentCap: nil).isEmpty)
        // Legacy helper still refuses a notional reduction while a percent cap binds.
        XCTAssertNil(PolicyTightening.tightenedCap(current: 2500, competingPercentCap: 5, fraction: 0.5))

        let percentBased = try snapshotPolicy(
            #"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":2500,"maxOrderPctOfNav":5}"#
        )
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.bindingMode(in: percentBased), .percentOfNav)
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.displayValue(in: percentBased), "5% of NAV")
        let options = PolicyTightening.capOptions(for: .maxOrderNotional, in: percentBased)
        XCTAssertFalse(options.isEmpty)
        XCTAssertTrue(options.contains { $0.mode == .percentOfNav && $0.value == 2 && !$0.isLoosening })
        XCTAssertTrue(options.contains { $0.mode == .percentOfNav && $0.value == 10 && $0.isLoosening })
        XCTAssertTrue(options.contains { $0.mode == .notional && $0.switchesMode })
        XCTAssertFalse(PolicyTightening.Cap.maxOrderNotional.displayValue(in: percentBased).contains("console"))
    }

    func testUnsetCapsOfferPresetsInsteadOfSendingTheUserAway() throws {
        let unset = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide"}"#)
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.displayValue(in: unset), "not set")
        let options = PolicyTightening.capOptions(for: .maxDailyNotional, in: unset)
        XCTAssertTrue(options.contains { $0.mode == .notional && $0.value == 2500 && !$0.isLoosening })
        XCTAssertTrue(options.contains { $0.mode == .percentOfNav && $0.value == 5 && !$0.isLoosening })
    }

    func testOptionsAreOrderedMildestFirstAndDeduplicated() {
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2000, competingPercentCap: nil), [1500, 1000, 500])
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2, competingPercentCap: nil), [1])
    }

    func testNotionalMenuIncludesRaisesAndPercentSwitch() throws {
        let policy = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000}"#)
        let options = PolicyTightening.capOptions(for: .maxOrderNotional, in: policy)
        XCTAssertTrue(options.contains { $0.mode == .notional && $0.value == 7500 && !$0.isLoosening })
        XCTAssertTrue(options.contains { $0.mode == .notional && $0.value == 12500 && $0.isLoosening })
        XCTAssertTrue(options.contains { $0.mode == .percentOfNav && $0.switchesMode && $0.isLoosening })
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.bindingMode(in: policy), .notional)
    }

    func testAStaleOptionIsRefusedOnceTheCapHasMovedUnderIt() throws {
        let policy = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000}"#)

        XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: policy))

        let lowered = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":1000}"#)
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: lowered))
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 1000, in: lowered))
        XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: 750, in: lowered))

        let percentBased = try snapshotPolicy(
            #"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000,"maxOrderPctOfNav":5}"#
        )
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: percentBased))
        XCTAssertTrue(
            PolicyTightening.isStillExpected(
                .maxOrderNotional,
                expectedMode: .percentOfNav,
                expectedValue: 5,
                in: percentBased
            )
        )
        let unset = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide"}"#)
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: unset))
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: nil))

        let both = try snapshotPolicy(
            #"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":1000,"maxDailyNotional":10000}"#
        )
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: both))
        XCTAssertTrue(PolicyTightening.isStillATightening(.maxDailyNotional, value: 7500, in: both))

        for value in PolicyTightening.tightenedCapOptions(current: 10000, competingPercentCap: nil) {
            XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: value, in: policy))
        }
    }

    func testCustomAmountParsingAndLoosening() throws {
        XCTAssertEqual(PolicyTightening.parsedCustomValue("$1,250", mode: .notional), 1250)
        XCTAssertEqual(PolicyTightening.parsedCustomValue("7.5%", mode: .percentOfNav), 7.5)
        XCTAssertNil(PolicyTightening.parsedCustomValue("0", mode: .notional))
        XCTAssertNil(PolicyTightening.parsedCustomValue("0", mode: .percentOfNav))
        XCTAssertNil(PolicyTightening.parsedCustomValue("150", mode: .percentOfNav))

        let policy = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxDailyNotional":10000}"#)
        XCTAssertTrue(PolicyTightening.isLooseningCustom(.maxDailyNotional, mode: .notional, value: 20000, in: policy))
        XCTAssertFalse(PolicyTightening.isLooseningCustom(.maxDailyNotional, mode: .notional, value: 5000, in: policy))
        XCTAssertTrue(PolicyTightening.isLooseningCustom(.maxDailyNotional, mode: .percentOfNav, value: 10, in: policy))
    }

    private func snapshotPolicy(_ policyJSON: String) throws -> PolicySummary {
        let json = """
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
          "policy": \(policyJSON)
        }
        """
        return try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)).policy
    }

    func testPayloadsMatchTheServerPolicyPatchContract() {
        let askFirst = PolicyTightening.authorityPayload()
        let askFirstPatch = try? XCTUnwrap(askFirst["patch"] as? [String: Any])
        XCTAssertEqual(askFirstPatch?["strategyAuthority"] as? String, "propose")

        let autopilot = PolicyTightening.authorityPayload(to: PolicyTightening.autopilot, current: PolicyTightening.askFirst)
        let autopilotPatch = try? XCTUnwrap(autopilot["patch"] as? [String: Any])
        XCTAssertEqual(autopilotPatch?["strategyAuthority"] as? String, "decide")
        let autopilotGuard = try? XCTUnwrap(autopilot["expectedCurrent"] as? [String: Any])
        XCTAssertEqual(autopilotGuard?["strategyAuthority"] as? String, "propose")

        let capPayload = PolicyTightening.capPayload(.maxDailyNotional, value: 1250, current: 10000)
        let capPatch = try? XCTUnwrap(capPayload["patch"] as? [String: Any])
        XCTAssertEqual(capPatch?["maxDailyNotional"] as? Double, 1250)
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.rawValue, "maxOrderNotional")
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.rawValue, "maxDailyNotional")

        let percentPayload = PolicyTightening.capPayload(
            .maxOrderNotional,
            mode: .percentOfNav,
            value: 10,
            expectedMode: .percentOfNav,
            expectedValue: 5
        )
        let percentPatch = try? XCTUnwrap(percentPayload["patch"] as? [String: Any])
        XCTAssertEqual(percentPatch?["maxOrderPctOfNav"] as? Double, 10)
        let percentGuard = try? XCTUnwrap(percentPayload["expectedCurrent"] as? [String: Any])
        XCTAssertEqual(percentGuard?["maxOrderPctOfNav"] as? Double, 5)
    }

    func testEveryPayloadCarriesTheExpectedCurrentPrecondition() throws {
        let authority = PolicyTightening.authorityPayload()
        let authorityGuard = try XCTUnwrap(authority["expectedCurrent"] as? [String: Any])
        XCTAssertEqual(authorityGuard["strategyAuthority"] as? String, PolicyTightening.autopilot)
        XCTAssertEqual(authorityGuard.count, 1)

        let capPayload = PolicyTightening.capPayload(.maxDailyNotional, value: 1250, current: 10000)
        let capGuard = try XCTUnwrap(capPayload["expectedCurrent"] as? [String: Any])
        XCTAssertEqual(capGuard["maxDailyNotional"] as? Double, 10000)
        XCTAssertEqual(capGuard.count, 1)

        XCTAssertNil(PolicyTightening.capPayload(.maxOrderNotional, value: 1250, current: nil)["expectedCurrent"])
        XCTAssertNil(PolicyTightening.capPayload(.maxOrderNotional, value: 1250, current: Double.nan)["expectedCurrent"])

        let encoded = try JSONSerialization.data(withJSONObject: capPayload, options: [.sortedKeys])
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: [String: Double]]
        )
        XCTAssertEqual(decoded["patch"]?["maxDailyNotional"], 1250)
        XCTAssertEqual(decoded["expectedCurrent"]?["maxDailyNotional"], 10000)
    }

    func testThePreconditionCarriesTheCapTheRecheckJustApproved() throws {
        let policy = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000}"#)
        let current = try XCTUnwrap(PolicyTightening.Cap.maxOrderNotional.currentValue(in: policy))
        let option = try XCTUnwrap(PolicyTightening.tightenedCapOptions(current: current, competingPercentCap: nil).first)

        XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: option, in: policy))
        let payload = PolicyTightening.capPayload(.maxOrderNotional, value: option, current: current)
        let expected = try XCTUnwrap(payload["expectedCurrent"] as? [String: Any])
        XCTAssertEqual(expected["maxOrderNotional"] as? Double, 10000)
    }

    func testCapsReadTheirOwnFieldsFromTheSnapshotPolicy() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(policySnapshotJSON.utf8))

        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.currentValue(in: snapshot.policy), 2500)
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.currentValue(in: snapshot.policy), 10000)
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.competingPercentCap(in: snapshot.policy), 5)
        XCTAssertNil(PolicyTightening.Cap.maxDailyNotional.competingPercentCap(in: snapshot.policy))
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.bindingMode(in: snapshot.policy), .percentOfNav)
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.bindingMode(in: snapshot.policy), .notional)
        XCTAssertFalse(
            PolicyTightening.capOptions(for: .maxOrderNotional, in: snapshot.policy).isEmpty
        )
        XCTAssertFalse(
            PolicyTightening.capOptions(for: .maxDailyNotional, in: snapshot.policy).isEmpty
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
