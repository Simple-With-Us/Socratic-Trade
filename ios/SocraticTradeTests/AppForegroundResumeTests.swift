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
        _ = await resumeTask.value

        // ST-4605: the stream starts before the reload and is stopped when the
        // scene leaves the foreground before the reload finishes.
        XCTAssertEqual(store.callOrder, ["restore", "startEvents", "load", "stopEvents"])
    }

    func testResumeStartsEventsWhenStillActiveAfterLoad() async {
        let store = ForegroundResumeTestDouble()
        let gate = ScenePhaseResumeGate()
        gate.phase = .active

        let started = await AppForegroundResume.resumeAfterBecomingActive(
            store: store,
            isScreenshotMode: false,
            shouldContinue: { gate.shouldContinueResume() }
        )

        XCTAssertTrue(started)
        XCTAssertEqual(store.callOrder, ["restore", "startEvents", "load"])
    }
}

@MainActor
private final class ForegroundResumeTestDouble: LiveSessionResuming, SessionRestoreAwaiting {
    var isAuthenticated = true
    var isLiveStreamConnected = false
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
