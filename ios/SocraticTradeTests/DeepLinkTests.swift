import XCTest
@testable import SocraticTrade

/// The URL → destination mapping is the whole of the deep-link contract, so it is tested as a
/// pure function: what it accepts is exactly what the AASA file claims
/// (app/.well-known/apple-app-site-association/route.ts), and everything else is dropped.
final class DeepLinkTests: XCTestCase {
    private func destination(_ string: String) -> DeepLinkDestination? {
        guard let url = URL(string: string) else {
            XCTFail("Unparseable test URL: \(string)")
            return nil
        }
        return DeepLink.destination(for: url)
    }

    func testRoutesEveryClaimedContentPath() {
        XCTAssertEqual(destination("https://socratictrade.com/console/approvals"), .tab(.proposals))
        XCTAssertEqual(destination("https://socratictrade.com/console/orders"), .tab(.markets))
        XCTAssertEqual(destination("https://socratictrade.com/console/watchlist"), .tab(.markets))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity"), .tab(.activity))
        XCTAssertEqual(destination("https://socratictrade.com/console/assistant"), .tab(.coach))
        XCTAssertEqual(destination("https://socratictrade.com/console/scan"), .tab(.scan))
        XCTAssertEqual(destination("https://socratictrade.com/console/guardrails"), .tab(.guardrails))
        XCTAssertEqual(destination("https://socratictrade.com/console/results"), .tab(.results))
    }

    func testActivityTabQuerySelectsTheSectionWithoutInventingNewPaths() {
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=alerts"), .activity(.alerts))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=notifications"), .activity(.notifications))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=runs"), .activity(.runs))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=fills"), .activity(.fills))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=audit"), .activity(.audit))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=all"), .activity(.audit))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=ALL")?.activitySection, .audit)
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=nope"), .tab(.activity))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity")?.activitySection, nil)
        XCTAssertEqual(destination("https://socratictrade.com/console/activity?tab=notifications")?.tab, .activity)
    }

    func testExtractsAProposalIdFromPathAndQuery() {
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals/2b9f0c1e-4a77-4a1e-9f2e-7d1c8f0b3a55"),
            .proposal(id: "2b9f0c1e-4a77-4a1e-9f2e-7d1c8f0b3a55")
        )
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals?proposal=proposal-1"),
            .proposal(id: "proposal-1")
        )
        XCTAssertEqual(destination("https://socratictrade.com/console/approvals/proposal-1")?.tab, .proposals)
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals/proposal-1")?.proposalId,
            "proposal-1"
        )
    }

    func testTrailingSlashesAndCasingDoNotChangeTheDestination() {
        XCTAssertEqual(destination("https://SOCRATICTRADE.com/Console/Approvals/"), .tab(.proposals))
        XCTAssertEqual(destination("https://socratictrade.com/console/activity/"), .tab(.activity))
    }

    func testRejectsForeignHostsAndNonClaimedSubdomains() {
        XCTAssertNil(destination("https://evil.example.com/console/approvals"))
        // Lookalike hosts must not match on a suffix check.
        XCTAssertNil(destination("https://notsocratictrade.com/console/approvals"))
        XCTAssertNil(destination("https://socratictrade.com.evil.example/console/approvals"))
        // Real subdomains exist, but the entitlement claims only the apex — accepting them here
        // would describe routing iOS will never actually perform.
        XCTAssertNil(destination("https://console.socratictrade.com/console/approvals"))
        XCTAssertNil(destination("https://www.socratictrade.com/console/approvals"))
    }

    func testRejectsInsecureAndNonUniversalSchemes() {
        XCTAssertNil(destination("http://socratictrade.com/console/approvals"))
        // The custom scheme is auth-callback-only: it must never carry a content route.
        XCTAssertNil(destination("socratictrade://console/approvals"))
        XCTAssertNil(destination("socratictrade://socratictrade.com/console/approvals"))
    }

    func testRejectsPathsTheAppDoesNotHandle() {
        XCTAssertNil(destination("https://socratictrade.com/"))
        XCTAssertNil(destination("https://socratictrade.com/console"))
        XCTAssertNil(destination("https://socratictrade.com/console/settings"))
        XCTAssertNil(destination("https://socratictrade.com/console/orders/order-1"))
        XCTAssertNil(destination("https://socratictrade.com/console/approvals/proposal-1/extra"))
        XCTAssertNil(destination("https://socratictrade.com/mobile"))
        // Broker connect is a Safari handoff — claiming it here would swallow the tap
        // back into a screen the phone does not have.  Universe is the Guardrails tab.
        XCTAssertNil(destination("https://socratictrade.com/console/connections"))
        XCTAssertNil(destination("https://socratictrade.com/console/strategy"))
        XCTAssertEqual(destination("https://socratictrade.com/console/guardrails"), .tab(.guardrails))
    }

    func testConsoleHandoffUrlsAreSafariOnlyAndNotInAppRoutes() {
        XCTAssertTrue(ConsoleHandoff.isSafariOnly(ConsoleHandoff.connections))
        XCTAssertEqual(ConsoleHandoff.connections.absoluteString, "https://socratictrade.com/console/connections")
        XCTAssertNil(DeepLink.destination(for: ConsoleHandoff.connections))
        XCTAssertFalse(ConsoleHandoff.isSafariOnly(URL(string: "https://socratictrade.com/console/guardrails")!))
        XCTAssertFalse(ConsoleHandoff.isSafariOnly(URL(string: "https://socratictrade.com/console/strategy")!))
        XCTAssertFalse(ConsoleHandoff.isSafariOnly(URL(string: "https://socratictrade.com/console/approvals")!))
        XCTAssertFalse(ConsoleHandoff.isSafariOnly(URL(string: "https://socratictrade.com/console/settings")!))
        XCTAssertFalse(ConsoleHandoff.isSafariOnly(URL(string: "socratictrade://console/connections")!))
    }

    func testExtractsASymbolFromOrdersAndWatchlistQuery() {
        XCTAssertEqual(destination("https://socratictrade.com/console/orders?symbol=AAPL"), .symbol("AAPL"))
        XCTAssertEqual(destination("https://socratictrade.com/console/watchlist?symbol=tsla"), .symbol("TSLA"))
        XCTAssertEqual(destination("https://socratictrade.com/console/orders?symbol=AAPL")?.tab, .markets)
        XCTAssertEqual(destination("https://socratictrade.com/console/orders?symbol=AAPL")?.focusedSymbol, "AAPL")
        XCTAssertEqual(destination("https://socratictrade.com/console/orders"), .tab(.markets))
        XCTAssertNil(destination("https://socratictrade.com/console/orders?symbol=")?.focusedSymbol)
    }

    func testMalformedProposalIdsFallBackToTheProposalsListInsteadOfDroppingTheLink() {
        XCTAssertEqual(destination("https://socratictrade.com/console/approvals?proposal="), .tab(.proposals))
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals?proposal=not%20an%20id"),
            .tab(.proposals)
        )
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals/\(String(repeating: "a", count: 65))"),
            .tab(.proposals)
        )
        XCTAssertEqual(
            destination("https://socratictrade.com/console/approvals/..%2F..%2Fadmin"),
            .tab(.proposals)
        )
    }

    func testDestinationTabMappingCoversTheCustomizableShell() {
        // Every routed tab must be a screen the tab shell can actually show — including when
        // the owner unpinned it (MobileControlView reroutes those into the More stack).
        for destination in [
            DeepLinkDestination.tab(.proposals),
            .tab(.markets),
            .tab(.activity),
            .tab(.coach),
            .tab(.scan),
            .tab(.guardrails),
            .tab(.results),
            .proposal(id: "proposal-1"),
            .symbol("AAPL"),
            .activity(.alerts),
            .activity(.notifications)
        ] {
            XCTAssertTrue(AppTab.customizable.contains(destination.tab), "\(destination)")
        }
    }
}
