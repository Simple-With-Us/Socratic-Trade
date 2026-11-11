import XCTest
@testable import SocraticTrade

@MainActor
final class AppLiveSessionResumeTests: XCTestCase {
    func testResumeSkipsStartEventsWhenLoadClearsAuthentication() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true

        await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)

        XCTAssertEqual(store.callOrder, ["load"])
    }

    func testResumeStartsEventsOnlyAfterSuccessfulLoad() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true

        await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)

        XCTAssertEqual(store.callOrder, ["load", "startEvents"])
    }
}

@MainActor
private final class LiveSessionResumeTestDouble: LiveSessionResuming {
    var isAuthenticated = false
    var remainAuthenticatedAfterLoad = false
    var callOrder: [String] = []

    func load() async {
        callOrder.append("load")
        isAuthenticated = remainAuthenticatedAfterLoad
    }

    func startEvents() {
        callOrder.append("startEvents")
    }
}
