import XCTest
@testable import SocraticTrade

@MainActor
final class AppForegroundResumeTests: XCTestCase {
    func testBackgroundMidResumeSkipsStartEvents() async {
        let store = ForegroundResumeTestDouble()
        let gate = ScenePhaseResumeGate()
        gate.phase = .active

        let resumeTask = Task {
            await AppForegroundResume.resumeAfterBecomingActive(
                store: store,
                isScreenshotMode: false,
                shouldContinue: { gate.shouldContinueResume() }
            )
        }

        try? await Task.sleep(for: .milliseconds(25))
        gate.phase = .background
        await resumeTask.value

        XCTAssertEqual(store.callOrder, ["restore", "stopEvents", "load"])
    }

    func testResumeStartsEventsWhenStillActiveAfterLoad() async {
        let store = ForegroundResumeTestDouble()
        let gate = ScenePhaseResumeGate()
        gate.phase = .active

        await AppForegroundResume.resumeAfterBecomingActive(
            store: store,
            isScreenshotMode: false,
            shouldContinue: { gate.shouldContinueResume() }
        )

        XCTAssertEqual(store.callOrder, ["restore", "stopEvents", "load", "startEvents"])
    }
}

@MainActor
private final class ForegroundResumeTestDouble: LiveSessionResuming, SessionRestoreAwaiting {
    var isAuthenticated = true
    var callOrder: [String] = []

    func ensurePersistedSessionRestoredBeforeAuthenticatedRequests() async {
        callOrder.append("restore")
    }

    func load() async {
        callOrder.append("load")
        try? await Task.sleep(for: .milliseconds(80))
    }

    func startEvents() {
        callOrder.append("startEvents")
    }

    func stopEvents() {
        callOrder.append("stopEvents")
    }
}
