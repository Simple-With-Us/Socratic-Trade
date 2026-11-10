import XCTest
@testable import SocraticTrade

final class AgentControlPlanTests: XCTestCase {
    func testActivePausedDoesNotShowStart() {
        let plan = AgentControlPlan.from(
            systemState: "active",
            runState: .pausedMarketClosed,
            authority: "decide",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(plan.primary, .stop)
        XCTAssertFalse(plan.showStart)
        XCTAssertTrue(plan.showStop)
        XCTAssertTrue(plan.statusTitle.contains("Waiting for Open"))
        XCTAssertTrue(plan.statusDetail.contains("not the same as the agent being stopped"))
    }

    func testHaltedShowsStartNotStop() {
        let plan = AgentControlPlan.from(
            systemState: "halted",
            runState: .stopped,
            authority: "propose",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(plan.primary, .start)
        XCTAssertTrue(plan.showStart)
        XCTAssertFalse(plan.showStop)
        XCTAssertEqual(plan.startLabel, "Start Agent")
        XCTAssertTrue(plan.startEnabled)
    }

    func testActiveShowsCloseOnlyAndWindDown() {
        let plan = AgentControlPlan.from(
            systemState: "active",
            runState: .running,
            authority: "decide",
            snapshotStale: false,
            ready: true
        )
        XCTAssertTrue(plan.showCloseOnly)
        XCTAssertTrue(plan.showWindDown)
        XCTAssertTrue(plan.showStop)
        XCTAssertFalse(plan.showStart)
    }

    func testCloseOnlyHidesItsOwnButtonAndKeepsWindDown() {
        let plan = AgentControlPlan.from(
            systemState: "close_only",
            runState: .running,
            authority: "propose",
            snapshotStale: false,
            ready: true
        )
        XCTAssertFalse(plan.showCloseOnly)
        XCTAssertTrue(plan.showWindDown)
        XCTAssertEqual(plan.primary, .resume)
        XCTAssertEqual(plan.startLabel, "Resume Agent")
    }

    func testLiquidatingHidesWindDownAndKeepsCloseOnly() {
        let plan = AgentControlPlan.from(
            systemState: "liquidating",
            runState: .running,
            authority: "decide",
            snapshotStale: false,
            ready: true
        )
        XCTAssertTrue(plan.showCloseOnly)
        XCTAssertFalse(plan.showWindDown)
        // Sentence case, per FLEET-UI-COPY "Values / answers / secondary status": this
        // string renders as the Agent Controls SectionHeading SUBTITLE, not as a heading
        // or a command name.  "Wind Down" stays Title Case as the BUTTON that starts it.
        XCTAssertEqual(plan.statusTitle, "Winding down")
    }

    func testStoppedStillOffersProtectiveControls() {
        let plan = AgentControlPlan.from(
            systemState: "halted",
            runState: .stopped,
            authority: "propose",
            snapshotStale: false,
            ready: true
        )
        XCTAssertTrue(plan.showCloseOnly)
        XCTAssertTrue(plan.showWindDown)
    }

    func testStaleSnapshotDisablesStartOnly() {
        let plan = AgentControlPlan.from(
            systemState: "halted",
            runState: .stopped,
            authority: "decide",
            snapshotStale: true,
            ready: true
        )
        XCTAssertFalse(plan.startEnabled)
        XCTAssertTrue(plan.startDisabledReason?.contains("Refresh") == true)
    }
}
