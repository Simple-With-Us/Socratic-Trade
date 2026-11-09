import XCTest
@testable import SocraticTrade

/// Capability discovery from the server-advertised catalog, plus the fallbacks that keep an
/// older server (or a payload that simply omits the field) from disabling working controls.
final class ControlCatalogTests: XCTestCase {
    func testDecodesTheServerCatalogShape() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(catalogSnapshotJSON.utf8))
        let catalog = try XCTUnwrap(snapshot.catalog)

        XCTAssertEqual(catalog.version, 2)
        XCTAssertTrue(catalog.describesCommands)
        XCTAssertTrue(catalog.advertisedCommandTypes.contains("policy.patch"))
        XCTAssertTrue(catalog.advertisedCommandTypes.contains("strategy.run_once"))
        XCTAssertFalse(catalog.advertisedCommandTypes.contains("strategy.teleport"))
        // Fields the app does not act on (auth / realtime / accountDeletion) are ignored
        // rather than failing the whole snapshot decode.
        XCTAssertEqual(snapshot.readiness.systemState, "active")
    }

    func testCatalogIsOptionalAndAnEmptyCommandListAnswersNothing() throws {
        let withoutCatalog = try JSONDecoder().decode(MobileSnapshot.self, from: Data(noCatalogSnapshotJSON.utf8))
        XCTAssertNil(withoutCatalog.catalog)

        let empty = try JSONDecoder().decode(ControlCatalog.self, from: Data(#"{"version":2,"commands":[]}"#.utf8))
        XCTAssertFalse(empty.describesCommands)

        let commandsMissing = try JSONDecoder().decode(ControlCatalog.self, from: Data(#"{"version":2}"#.utf8))
        XCTAssertFalse(commandsMissing.describesCommands)
        XCTAssertTrue(commandsMissing.advertisedCommandTypes.isEmpty)
    }

    /// A catalog of the wrong SHAPE must not take the snapshot down with it.  `decodeIfPresent`
    /// returns nil only for a missing/null key, so an unguarded `try` here would throw out of
    /// `MobileSnapshot.init` and blank the whole app over an optional field.
    @MainActor
    func testAMalformedCatalogFallsBackInsteadOfFailingTheWholeSnapshot() throws {
        let malformedCatalogs = [
            #""catalog": "v2""#,
            #""catalog": 2"#,
            #""catalog": {"version":"two","commands":[{"type":"strategy.stop"}]}"#,
            #""catalog": {"version":2,"commands":"all"}"#,
            #""catalog": {"version":2,"commands":[{"type":1}]}"#,
            #""catalog": {"version":2,"commands":[{"name":"strategy.stop"}]}"#
        ]

        for catalogField in malformedCatalogs {
            let json = """
            {
              \(catalogField),
              "readiness": {
                "hasAccount": true,
                "hasUniverse": true,
                "systemState": "active",
                "strategyAuthority": "decide",
                "selectedAccountNumber": "account-number",
                "activeConnectedAccount": null,
                "commandBacklog": {"queued": 0, "running": 0}
              },
              "policy": {"systemState":"active","strategyAuthority":"decide","maxDailyNotional":10000}
            }
            """
            let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8))
            XCTAssertNil(snapshot.catalog, catalogField)
            // The rest of the payload still decoded — the snapshot is usable.
            XCTAssertEqual(snapshot.readiness.systemState, "active", catalogField)

            let store = MobileStore(
                client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
                previewSnapshot: snapshot
            )
            // Unreadable catalog == unanswered question: controls stay available, never silently
            // disabled by a payload the app could not parse.
            for commandType in ["order.cancel", "policy.patch", "alert.create", "watchlist.add"] {
                XCTAssertTrue(store.serverAdvertises(commandType), "\(commandType) — \(catalogField)")
            }
            XCTAssertTrue(store.canSubmit("strategy.stop"), catalogField)
        }
    }

    @MainActor
    func testUnadvertisedCommandsAreRefusedWhileProtectiveOnesStayAvailable() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(catalogSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )

        XCTAssertTrue(store.serverAdvertises("policy.patch"))
        XCTAssertTrue(store.canSubmit("policy.patch"))
        // Advertised by this fixture's catalog but not by the app's built-in assumptions —
        // and vice versa: alert.create is absent here, so the app must not offer it.
        XCTAssertFalse(store.serverAdvertises("alert.create"))
        XCTAssertFalse(store.canSubmit("alert.create"))
        // order.cancel is exempt from the STALENESS gate, not from capability discovery: this
        // catalog does not advertise it, so the control stays off however fresh the snapshot is.
        XCTAssertFalse(store.canSubmit("order.cancel"))
        XCTAssertFalse(store.canSubmit("order.cancel", at: Date(timeIntervalSinceNow: 181)))
        // A halt never depends on the catalog decoding correctly.
        XCTAssertTrue(store.canSubmit("strategy.stop"))
        XCTAssertTrue(store.canSubmit("proposal.reject"))
    }

    @MainActor
    func testMissingCatalogFallsBackToTheAppsBuiltInControls() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(noCatalogSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )

        for commandType in ["policy.patch", "alert.create", "watchlist.add", "strategy.run_once"] {
            XCTAssertTrue(store.serverAdvertises(commandType), commandType)
        }
        XCTAssertTrue(store.canSubmit("policy.patch"))
    }

    private let catalogSnapshotJSON = #"""
    {
      "catalog": {
        "version": 2,
        "auth": {"mode":"server-session","supported":["Cloudflare Access"],"phoneStores":"server session cookie only"},
        "realtime": {"sse":"/api/mobile/events","eventTypes":["mobile.command"]},
        "accountDeletion": {"requiredText":"DELETE MY ACCOUNT"},
        "commands": [
          {"type":"strategy.run_once"},
          {"type":"strategy.start"},
          {"type":"strategy.stop"},
          {"type":"proposal.approve"},
          {"type":"proposal.reject"},
          {"type":"account.activate"},
          {"type":"policy.patch"}
        ]
      },
      "readiness": {
        "hasAccount": true,
        "hasUniverse": true,
        "systemState": "active",
        "strategyAuthority": "decide",
        "selectedAccountNumber": "account-number",
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {"systemState":"active","strategyAuthority":"decide","maxDailyNotional":10000}
    }
    """#

    private let noCatalogSnapshotJSON = #"""
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
      "policy": {"systemState":"active","strategyAuthority":"decide","maxDailyNotional":10000}
    }
    """#
}
