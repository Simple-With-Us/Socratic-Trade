import XCTest
@testable import SocraticTrade

@MainActor
final class AppLiveSessionResumeTests: XCTestCase {
    func testResumeStopsEventsWhenLoadClearsAuthentication() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true

        let started = await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)

        XCTAssertFalse(started)
        XCTAssertEqual(store.callOrder, ["startEvents", "load", "stopEvents"])
    }

    func testResumeSkipsWorkWhenGateIsAlreadyClosed() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true

        let started = await AppLiveSessionResume.resumeLiveSession(
            store: store,
            isScreenshotMode: false,
            shouldStartEvents: { false }
        )

        XCTAssertFalse(started)
        XCTAssertEqual(store.callOrder, [])
    }

    func testResumeStopsEventsWhenGateClosesDuringLoad() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true
        var allowEvents = true
        store.onLoad = { allowEvents = false }

        let started = await AppLiveSessionResume.resumeLiveSession(
            store: store,
            isScreenshotMode: false,
            shouldStartEvents: { allowEvents }
        )

        XCTAssertFalse(started)
        XCTAssertEqual(store.callOrder, ["startEvents", "load", "stopEvents"])
    }

    func testResumeKeepsEventsUpDuringLoad() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true

        let started = await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)

        XCTAssertTrue(started)
        XCTAssertEqual(store.callOrder, ["startEvents", "load"])
    }

    func testResumeSkipsScreenshotMode() async {
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true

        let started = await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: true)

        XCTAssertFalse(started)
        XCTAssertEqual(store.callOrder, [])
    }

    func testJoinedResumeDoesNotLoadTwice() async {
        let gate = LiveResumeGate()
        let store = LiveSessionResumeTestDouble()
        store.isAuthenticated = true
        store.remainAuthenticatedAfterLoad = true
        store.suspendLoad = true

        let first = Task {
            await gate.run {
                await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)
            }
        }
        var spins = 0
        while store.loadCount == 0 && spins < 50 {
            spins += 1
            await Task.yield()
        }
        XCTAssertEqual(store.loadCount, 1)

        let second = Task {
            await gate.run {
                await AppLiveSessionResume.resumeLiveSession(store: store, isScreenshotMode: false)
            }
        }
        spins = 0
        while gate.joinCount == 0 && spins < 50 {
            spins += 1
            await Task.yield()
        }
        XCTAssertEqual(gate.joinCount, 1)
        store.finishLoad()

        let firstOutcome = await first.value
        let secondOutcome = await second.value
        XCTAssertEqual(store.loadCount, 1)
        XCTAssertEqual(store.callOrder, ["startEvents", "load"])
        XCTAssertFalse(firstOutcome.joinedInFlight)
        XCTAssertTrue(firstOutcome.startedEvents)
        XCTAssertTrue(secondOutcome.joinedInFlight)
        XCTAssertTrue(secondOutcome.startedEvents)
    }
}

@MainActor
private final class LiveSessionResumeTestDouble: LiveSessionResuming {
    var isAuthenticated = false
    var remainAuthenticatedAfterLoad = false
    var suspendLoad = false
    var callOrder: [String] = []
    var loadCount = 0
    var onLoad: (() -> Void)?
    private var loadWait: CheckedContinuation<Void, Never>?

    func load() async {
        callOrder.append("load")
        loadCount += 1
        onLoad?()
        if suspendLoad {
            await withCheckedContinuation { continuation in
                loadWait = continuation
            }
        }
        isAuthenticated = remainAuthenticatedAfterLoad
    }

    func startEvents() {
        callOrder.append("startEvents")
    }

    func stopEvents() {
        callOrder.append("stopEvents")
    }

    func finishLoad() {
        loadWait?.resume()
        loadWait = nil
    }
}
