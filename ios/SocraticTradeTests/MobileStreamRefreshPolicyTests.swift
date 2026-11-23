import XCTest
@testable import SocraticTrade

/// Covers the phone-side refresh policy: which stream events are worth a snapshot
/// download, what the snapshot cache does on disk, and what a signed-out cold start does.
@MainActor
final class MobileStreamRefreshPolicyTests: XCTestCase {
    // MARK: - Event policy

    func testOrderAndCommandEventsRefreshTheSnapshot() {
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("mobile.command"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("ready"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.order"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.proposal"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.run-complete"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.dirty"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.market-data"))
    }

    func testEventsWithNothingToRenderDoNotCostADownload() {
        // The Coach transcript has its own transport and the learning queue is not in the
        // snapshot, so neither event can change what the app renders.
        XCTAssertFalse(MobileStore.streamEventNeedsSnapshot("dashboard.chat-turn"))
        XCTAssertFalse(MobileStore.streamEventNeedsSnapshot("dashboard.pending-learned-change"))
    }

    func testUnknownEventNamesStillRefreshTheSnapshot() {
        // A name this build does not know must not be assumed harmless.
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot("dashboard.something-new"))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot(nil))
        XCTAssertTrue(MobileStore.streamEventNeedsSnapshot(""))
    }

    // MARK: - Snapshot cache on disk

    func testLegacyUserDefaultsBlobIsMigratedIntoTheFileAndDeleted() throws {
        let url = try useTemporarySnapshotCache()
        defer { restoreDefaultSnapshotCache() }
        UserDefaults.standard.set(Data(Self.minimalSnapshotJSON.utf8), forKey: SnapshotCache.legacyDataKey)
        defer { UserDefaults.standard.removeObject(forKey: SnapshotCache.legacyDataKey) }

        XCTAssertFalse(SnapshotCache.exists())
        SnapshotCache.migrateLegacyBlobIfNeeded()

        XCTAssertTrue(SnapshotCache.exists())
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        // The old key is gone, so an upgraded install stops carrying the payload in a plist.
        XCTAssertNil(UserDefaults.standard.data(forKey: SnapshotCache.legacyDataKey))
        XCTAssertNotNil(SnapshotCache.decode(try XCTUnwrap(SnapshotCache.loadData())))
    }

    func testSnapshotCacheRoundTripsThroughTheFile() async throws {
        let url = try useTemporarySnapshotCache()
        defer { restoreDefaultSnapshotCache() }

        XCTAssertFalse(SnapshotCache.exists())
        SnapshotCache.save(Data(Self.minimalSnapshotJSON.utf8))
        // The write is off the main actor, so wait for it to land.
        let deadline = Date().addingTimeInterval(5)
        while !SnapshotCache.exists(), Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(SnapshotCache.exists())
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNotNil(SnapshotCache.loadData())
        XCTAssertNotNil(SnapshotCache.decode(try XCTUnwrap(SnapshotCache.loadData())))

        SnapshotCache.remove()
        XCTAssertFalse(SnapshotCache.exists())
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testCachedSnapshotIsDecodedOffTheMainActorAndPublished() async throws {
        let url = try useTemporarySnapshotCache()
        defer { restoreDefaultSnapshotCache() }
        try Data(Self.minimalSnapshotJSON.utf8).write(to: url, options: .atomic)

        let store = MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        // The launch path no longer decodes the cache inline, so nothing is on screen yet.
        XCTAssertNil(store.snapshot)
        await store.restoreCachedSnapshotIfNeeded()
        XCTAssertNotNil(store.snapshot)
        XCTAssertEqual(store.snapshot?.readiness.systemState ?? "", "halted")

        // A second restore is a no-op: a live snapshot is never overwritten by the cache.
        await store.restoreCachedSnapshotIfNeeded()
        XCTAssertNotNil(store.snapshot)
    }

    // MARK: - Signed-out cold start

    func testSignedOutColdStartSkipsTheSnapshotProbe() {
        let store = MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        XCTAssertFalse(store.hasSessionCookie)
        XCTAssertFalse(store.hasInitialized)

        store.markInitializedSignedOut()

        XCTAssertTrue(store.hasInitialized)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertFalse(store.isRefreshing)
        XCTAssertNil(store.error)
    }

    // MARK: - Helpers

    private lazy var temporaryCacheURL: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("socratic-snapshot-cache-\(UUID().uuidString).json")

    private func useTemporarySnapshotCache() throws -> URL {
        SnapshotCache.fileURL = temporaryCacheURL
        return temporaryCacheURL
    }

    private func restoreDefaultSnapshotCache() {
        SnapshotCache.fileURL = SnapshotCache.defaultFileURL()
        try? FileManager.default.removeItem(at: temporaryCacheURL)
    }

    private static let minimalSnapshotJSON = #"""
    {
      "readiness": {
        "hasAccount": false,
        "hasUniverse": false,
        "systemState": "halted",
        "strategyAuthority": "propose",
        "selectedAccountNumber": null,
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {
        "systemState": "halted",
        "strategyAuthority": "propose"
      }
    }
    """#
}
