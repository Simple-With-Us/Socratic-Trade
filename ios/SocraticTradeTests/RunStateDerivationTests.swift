import XCTest
@testable import SocraticTrade

/// Pins the console-shared run-state vocabulary (app/console/lib/derive.ts deriveStateInfo):
/// the app must never say "Running" while the console says "Paused · market closed".
final class RunStateDerivationTests: XCTestCase {
    func testActivePausesOutsideMarketHoursWhenExtendedHoursOff() {
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: "closed"),
            .pausedMarketClosed
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: "pre"),
            .pausedMarketClosed
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: "post"),
            .pausedMarketClosed
        )
    }

    func testActiveRunsDuringRegularSessionRegardlessOfExtendedHours() {
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: "regular"),
            .running
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: true, marketSession: "open"),
            .running
        )
    }

    func testActiveExtendedHoursAccountRunsPreAndPostButNotClosed() {
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: true, marketSession: "pre"),
            .running
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: true, marketSession: "post"),
            .running
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: true, marketSession: "closed"),
            .pausedMarketClosed
        )
    }

    func testUnknowableInputsNeverFabricateAPause() {
        // nil ≠ false: an older payload without the policy bool cannot answer the question.
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: nil, marketSession: "closed"),
            .running
        )
        // Unknown/absent market session likewise keeps the plain claim.
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: "unknown"),
            .running
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "active", runDuringExtendedHours: false, marketSession: nil),
            .running
        )
    }

    func testNonActiveStatesUseConsoleVocabulary() {
        XCTAssertEqual(
            deriveRunStateWord(systemState: "close_only", runDuringExtendedHours: false, marketSession: "regular"),
            .exitOnly
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "liquidating", runDuringExtendedHours: true, marketSession: "closed"),
            .windingDown
        )
        XCTAssertEqual(
            deriveRunStateWord(systemState: "halted", runDuringExtendedHours: nil, marketSession: "regular"),
            .stopped
        )
    }

    func testPolicyDecodesRunDuringExtendedHoursAndDefaultsToNil() throws {
        let withField = try JSONDecoder().decode(
            PolicySummary.self,
            from: Data(#"{"systemState":"active","strategyAuthority":"propose","runDuringExtendedHours":false}"#.utf8)
        )
        XCTAssertEqual(withField.runDuringExtendedHours, false)

        let withoutField = try JSONDecoder().decode(
            PolicySummary.self,
            from: Data(#"{"systemState":"active","strategyAuthority":"propose"}"#.utf8)
        )
        XCTAssertNil(withoutField.runDuringExtendedHours)
    }

    func testAdminPortalNavigationFence() {
        func allowed(_ url: String) -> Bool {
            AdminPortalWebView.Coordinator.isAllowed(URL(string: url)!)
        }

        XCTAssertTrue(allowed("https://socratictrade.com/admin"))
        XCTAssertTrue(allowed("https://socratictrade.com/admin/llm-usage"))
        XCTAssertTrue(allowed("https://socratictrade.com/login"))
        XCTAssertTrue(allowed("https://socratictrade.com/api/auth/session"))
        XCTAssertTrue(allowed("https://socratictrade.com/api/admin/llm-usage"))
        XCTAssertTrue(allowed("https://socratictrade.com/_next/static/chunks/app.js"))

        XCTAssertFalse(allowed("http://socratictrade.com/admin"))
        XCTAssertFalse(allowed("https://evil.example.com/admin"))
        XCTAssertFalse(allowed("https://socratictrade.com/console"))
        XCTAssertFalse(allowed("https://socratictrade.com/administrator"))
        XCTAssertFalse(allowed("https://sub.socratictrade.com/admin"))

        XCTAssertTrue(
            AdminPortalWebView.Coordinator.isAllowed(
                URL(string: "https://socratictrade.com/console")!,
                isMainFrame: false
            ),
            "Same-host subresources must load or the portal stays blank."
        )
        XCTAssertFalse(
            AdminPortalWebView.Coordinator.isAllowed(
                URL(string: "https://evil.example.com/_next/x.js")!,
                isMainFrame: false
            )
        )
    }

    func testAdminPortalConsoleReturnIsDetectedAndNeverAllowedAsMainFrame() {
        func consoleReturn(_ url: String) -> Bool {
            AdminPortalWebView.Coordinator.isConsoleReturn(URL(string: url)!)
        }
        XCTAssertTrue(consoleReturn("https://socratictrade.com/console"))
        XCTAssertTrue(consoleReturn("https://socratictrade.com/console/home"))
        XCTAssertTrue(consoleReturn("https://socratictrade.com/"))
        XCTAssertFalse(consoleReturn("https://socratictrade.com/admin"))
        XCTAssertFalse(consoleReturn("https://evil.example.com/console"))
        XCTAssertFalse(
            AdminPortalWebView.Coordinator.isAllowed(
                URL(string: "https://socratictrade.com/console")!,
                isMainFrame: true
            )
        )
    }

    func testAdminPortalNativePagesMatchTheWebsiteRail() {
        XCTAssertEqual(AdminPortalPage.overview.path, "/admin")
        XCTAssertEqual(AdminPortalPage.connections.path, "/admin/connections")
        XCTAssertEqual(AdminPortalPage.llmUsage.path, "/admin/llm-usage")
        XCTAssertEqual(AdminPortalPage.ragCoverage.path, "/admin/rag-coverage")
        XCTAssertEqual(AdminPortalPage.enrichmentCoverage.path, "/admin/enrichment-coverage")
        XCTAssertEqual(AdminPortalPage.dataCatalog.path, "/admin/data-catalog")
        XCTAssertEqual(AdminPortalPage.operations.path, "/admin/operations")
        XCTAssertEqual(AdminPortalPage.factorBacktest.path, "/admin/backtest-ic")
        XCTAssertEqual(AdminPortalPage.serverStats.path, "/admin/server")
        XCTAssertEqual(AdminPortalPage.backupStatus.path, "/admin/backups")
        XCTAssertEqual(AdminPortalPage.chatTranscript.path, "/admin/transcript")
        XCTAssertEqual(AdminPortalPage.allCases.count, 11)
        XCTAssertEqual(AdminPortalWebView.Coordinator.messageType(["type": "backToConsole"]), "backToConsole")
        XCTAssertNil(AdminPortalWebView.Coordinator.messageType(["nope": "x"]))
        XCTAssertTrue(AdminPortalWebView.bridgeScript.contains("backToConsole"))
        XCTAssertTrue(AdminPortalWebView.chromeHideScript.contains("a[href=\"/console\"]"))
    }
}
