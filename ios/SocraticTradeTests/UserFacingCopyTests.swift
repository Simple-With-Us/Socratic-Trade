import AuthenticationServices
import XCTest
@testable import SocraticTrade

/// Owner 2026-08-18: user-visible iOS copy is ordinary app language.
/// Notes for Jay stay in the PR, not the UI.
final class UserFacingCopyTests: XCTestCase {
    private let forbidden = [
        "additional fields from /api/policy",
        "values from the latest snapshot",
        "phone-safe reductions only",
        "this deployment does not advertise policy.patch",
        "console only",
        "not set — console only",
        "set as % of NAV — console only",
        "returning to autopilot or raising a cap is done in the web console",
        "production push service",
        "registered with apple",
        "/api/policy",
        "policy.patch",
        "apns",
        "__rotate__"
    ]

    func testCommandLabelsNeverShowRouteOrCommandTypes() {
        let types = [
            "strategy.run_once",
            "strategy.start",
            "strategy.stop",
            "strategy.close_only",
            "strategy.liquidating",
            "proposal.approve",
            "proposal.reject",
            "proposal.retry_red_team",
            "account.activate",
            "order.cancel",
            "watchlist.add",
            "watchlist.remove",
            "alert.create",
            "alert.delete",
            "policy.patch",
            "unknown.command_type"
        ]
        for type in types {
            let label = AppFormat.commandLabel(type)
            XCTAssertFalse(label.contains("."), "\(type) → \(label)")
            XCTAssertFalse(label.contains("_"), "\(type) → \(label)")
            XCTAssertFalse(label.lowercased().contains("policy.patch"), label)
            assertOrdinary(label)
        }
        XCTAssertEqual(AppFormat.commandLabel("policy.patch"), "Policy Change")
    }

    func testRotationSeatIsLowercaseRotateModels() {
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__"), "rotate models")
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__", fallbacks: ["x"]), "rotate models")
        assertOrdinary(DeskCopy.modelSeatValue("__rotate__"))
    }

    func testCapDisplayNeverSendsTheUserToTheConsole() {
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.displayValue(in: nil), "not set")
        assertOrdinary(PolicyTightening.Cap.maxDailyNotional.displayValue(in: nil))
    }

    func testPushFooterNeverMentionsApplePlumbing() {
        assertOrdinary(PushAlertState.registered(environment: .production).summary)
        assertOrdinary(PushAlertState.registered(environment: .sandbox).summary)
        assertOrdinary(PushAlertState.failureSummary("APNs BadDeviceToken sandbox production"))
        XCTAssertEqual(PushAlertState.registered(environment: .production).summary, "Alerts on.")
    }

    func testIndexRowsNeverShowStorageSlugs() {
        let line = DeskCopy.joinedIndexList(["sp500", "nasdaq100", "ftWilshire5000"])
        XCTAssertEqual(line, "S&P 500, Nasdaq 100, FT Wilshire 5000")
        assertOrdinary(line)
        let liveLeak = DeskCopy.joinedIndexList(["sp500", "nasdaqComposite", "dow30", "nyseComposite"])
        XCTAssertEqual(liveLeak, "S&P 500, Nasdaq Composite, Dow 30, NYSE Composite")
        for slug in ["sp100", "sp500", "nasdaq100", "nasdaqComposite", "dow30", "russell2000", "nyseComposite", "ftWilshire5000"] {
            XCTAssertFalse(line.contains(slug), "\(line) still contains \(slug)")
            XCTAssertFalse(liveLeak.contains(slug), "\(liveLeak) still contains \(slug)")
        }
    }

    func testUniverseCopyMatchesWebGuardrailsNotAMissingStrategyPage() {
        // "always-include symbols" tracks the Guardrails row label.  These names are
        // exempt from the universe floor; "extra symbols" made them sound appended.
        XCTAssertEqual(
            DeskCopy.universeNeedsIndex,
            "Choose at least one base index (e.g. S&P 500) or add always-include symbols so the strategy has names to scan."
        )
        XCTAssertEqual(
            DeskCopy.universeRefreshAfterGuardrails,
            "Add an index or always-include symbols on Guardrails, then pull to refresh here."
        )
        XCTAssertEqual(
            DeskCopy.universeInsightDetail,
            "Choose at least one base index (e.g. S&P 500) or add always-include symbols."
        )
        for text in [
            DeskCopy.universeNeedsIndex,
            DeskCopy.universeRefreshAfterGuardrails,
            DeskCopy.universeInsightDetail
        ] {
            XCTAssertFalse(text.contains("extra symbols"), text)
        }
        XCTAssertEqual(DeskCopy.openGuardrailsButton, "Open Guardrails")
        XCTAssertEqual(DeskCopy.openConnectionsButton, "Open Connections")
        XCTAssertTrue(DeskCopy.universeNeedsIndex.contains("S&P 500"))
        XCTAssertTrue(DeskCopy.universeRefreshAfterGuardrails.contains("Guardrails"))
        XCTAssertFalse(DeskCopy.openGuardrailsButton.contains("Strategy"))
        XCTAssertFalse(DeskCopy.accountNeedsConnection.contains("Alpaca"))
        XCTAssertFalse(DeskCopy.accountNeedsConnection.contains("Robinhood"))
        XCTAssertFalse(DeskCopy.accountNeedsConnection.contains("Account & Settings"))
        XCTAssertTrue(DeskCopy.accountNeedsConnection.contains(DeskCopy.openConnectionsButton))
        XCTAssertTrue(DeskCopy.accountNeedsConnectionInline.contains(DeskCopy.openConnectionsButton))
        for text in [
            DeskCopy.universeNeedsIndex,
            DeskCopy.universeRefreshAfterGuardrails,
            DeskCopy.universeInsightDetail
        ] {
            XCTAssertFalse(text.contains("Strategy page"), text)
            XCTAssertFalse(text.contains("sp500"), text)
            assertOrdinary(text)
        }
    }

    func testScanCopyDoesNotTreatWatchlistAsTheUniverse() {
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 0, scanned: 503, quotes: 0, watched: 2),
            "0 names · 503 scanned · 0 quotes · 2 watched"
        )
        XCTAssertTrue(DeskCopy.scanUniverseNote.contains("Watchlist names are not the scan universe"))
        XCTAssertEqual(
            DeskCopy.scanEmptyMessage(scanned: 0, quotes: 0, hasFilter: false),
            "This universe has no symbols.  Choose a base index or add symbols on Guardrails, then refresh."
        )
        XCTAssertEqual(
            DeskCopy.scanEmptyMessage(scanned: 503, quotes: 0, hasFilter: false),
            "The scan could not price any names.  Refresh after quotes recover."
        )
        XCTAssertFalse(
            DeskCopy.scanEmptyMessage(scanned: 505, quotes: 0, hasFilter: false)
                .localizedCaseInsensitiveContains("Guardrails")
        )
        assertOrdinary(DeskCopy.scanUniverseNote)
        assertOrdinary(DeskCopy.scanCountLine(names: 0, scanned: 503, quotes: 0, watched: 2))
        assertOrdinary(DeskCopy.scanEmptyMessage(scanned: 503, quotes: 0, hasFilter: false))
        assertOrdinary(DeskCopy.scanLoadingNote)
        XCTAssertFalse(DeskCopy.scanLoadingNote.contains("503"))
        let banner = DeskCopy.scanRefreshFailedBanner(
            reason: "The live refresh did not finish.",
            lastGoodAt: "2026-08-18T19:25:13.000Z"
        )
        assertOrdinary(banner)
        XCTAssertTrue(banner.contains("Showing the last good scan from"))
        XCTAssertFalse(banner.contains("503"))
    }

    func testScanRefreshCopyIsNotTheWorkspaceConnectionBanner() {
        XCTAssertNotEqual(
            DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage),
            DeskCopy.genericConnectionMessage
        )
        XCTAssertTrue(
            DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage)
                .localizedStandardContains("market scan")
        )
        XCTAssertEqual(
            DeskCopy.scanRefreshFailed(from: "Socratic Trade is unreachable right now.  Try again in a few minutes."),
            "Socratic Trade is unreachable right now.  Try again in a few minutes."
        )
        assertOrdinary(DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage))
        assertOrdinary(DeskCopy.scanEmptyUniverse)
        assertOrdinary(DeskCopy.scanRefreshing)
        XCTAssertTrue(DeskCopy.scanRefreshing.contains("45"))
        XCTAssertFalse(DeskCopy.shouldShowScanEmptyState(hasFilter: false, loadFailed: true))
        XCTAssertTrue(DeskCopy.shouldShowScanEmptyState(hasFilter: false, loadFailed: false))
        XCTAssertTrue(DeskCopy.shouldShowScanEmptyState(hasFilter: true, loadFailed: true))
    }

    func testPortfolioEmptyCopyNamesTheBrokerWhenAnAccountIsSelected() {
        XCTAssertEqual(
            DeskCopy.portfolioUnavailableMessage(hasConnectedAccount: true),
            DeskCopy.portfolioBrokerUnreachable
        )
        XCTAssertEqual(
            DeskCopy.portfolioUnavailableMessage(hasConnectedAccount: false),
            DeskCopy.portfolioSelectAccount
        )
        XCTAssertEqual(DeskCopy.equityWaitingOnBroker, "waiting on broker")
        assertOrdinary(DeskCopy.portfolioBrokerUnreachable)
        assertOrdinary(DeskCopy.portfolioSelectAccount)
        assertOrdinary(DeskCopy.equityWaitingOnBroker)
    }

    func testNotificationHistoryCopyStaysOrdinary() {
        let item = try! JSONDecoder().decode(
            NotificationHistoryItem.self,
            from: Data(#"{"id":"n1","createdAt":"2026-08-18T12:00:00.000Z","type":"run_failed","title":"Strategy Run Failed","body":"Sent","read":false}"#.utf8)
        )
        assertOrdinary(item.title)
        assertOrdinary(item.body)
        assertOrdinary(item.readLabel)
        XCTAssertEqual(item.readLabel, "unread")
    }

    func testWorkspaceErrorsStayOrdinary() throws {
        assertOrdinary(MobileAPIError.serverError(statusCode: 522, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.serverError(statusCode: 500, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.decoding(NSError(domain: "test", code: 1)).errorDescription ?? "")
        XCTAssertEqual(
            MobileAPIError.network(URLError(.timedOut)).errorDescription,
            "Server is slow, still trying"
        )
        XCTAssertEqual(
            MobileAPIError.network(URLError(.notConnectedToInternet)).errorDescription,
            "Check your connection"
        )
        XCTAssertEqual(
            MobileAPIError.network(URLError(.cancelled)).errorDescription,
            nil
        )
        XCTAssertEqual(
            MobileAPIError.network(URLError(.badServerResponse)).errorDescription,
            "Couldn't reach Socratic Trade"
        )
        XCTAssertNil(
            MobileAPIError.userFacingNetworkMessage(
                for: MobileAPIError.serverError(statusCode: 500, message: "DB down")
            )
        )
        XCTAssertEqual(
            MobileAPIError.serverError(statusCode: 500, message: "DB down").errorDescription,
            "DB down"
        )
        let scanJSON = Data(#"""
        {"scannedSymbols":505,"returnedQuotes":0,"warnings":["This operation was aborted"],"topCandidates":[]}
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: scanJSON)
        assertOrdinary(MobileAPIError.scanQuotesUnavailable(scan).errorDescription ?? "")
        XCTAssertEqual(
            MobileAPIError.serverError(statusCode: 500, message: nil).errorDescription,
            "Something went wrong.  Try again."
        )
    }

    // MARK: - One vocabulary for run states, another for commands

    /// Run states and the commands that reach them are different parts of speech and
    /// deliberately worded differently — "Wind Down" (button) vs "Winding down" (state).
    /// Status TITLES must use the state word, so `AgentControlPlan` may not Title-Case them.
    func testStatusTitlesUseTheStateWordNotTheCommandName() {
        let exitOnly = AgentControlPlan.from(
            systemState: "close_only",
            runState: .exitOnly,
            authority: "propose",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(exitOnly.statusTitle, RunStateWord.exitOnly.rawValue)
        XCTAssertEqual(exitOnly.statusTitle, "Exit-only")

        let windingDown = AgentControlPlan.from(
            systemState: "liquidating",
            runState: .windingDown,
            authority: "decide",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(windingDown.statusTitle, RunStateWord.windingDown.rawValue)
        XCTAssertEqual(windingDown.statusTitle, "Winding down")

        // The state sentence on Guardrails uses the same words.
        XCTAssertTrue(
            DeskCopy.authorityVersusRunState(authority: "propose", runState: .exitOnly)
                .contains(RunStateWord.exitOnly.rawValue)
        )
        XCTAssertTrue(
            DeskCopy.authorityVersusRunState(authority: "propose", runState: .exitOnly)
                .contains("Approving an opening places it anyway")
        )
        XCTAssertEqual(
            DeskCopy.exitOnlyOwnerApproveNote,
            "This account is Exit-only, so the agent will not open new risk on its own.  Approving this opening places it anyway."
        )
        for title in [exitOnly.statusTitle, windingDown.statusTitle] {
            XCTAssertFalse(title.contains("Exit-Only"), title)
            XCTAssertFalse(title.contains("Winding Down"), title)
        }

        // Commands keep their Title Case imperative names — HomeView's buttons read
        // these, so they must NOT be rewritten into the state vocabulary.
        XCTAssertEqual(AppFormat.commandLabel("strategy.close_only"), "Exit Only")
        XCTAssertEqual(AppFormat.commandLabel("strategy.liquidating"), "Wind Down")
    }

    /// Authority renders mid-sentence and inside status pills — value contexts, so it is
    /// sentence case like its siblings, and never the raw propose/decide wire word.
    func testAuthorityWordIsSentenceCaseAndNeverTheWireEnum() {
        XCTAssertEqual(AppFormat.strategyAuthorityLabel("propose"), "Ask-first")
        XCTAssertEqual(AppFormat.strategyAuthorityLabel("decide"), "Autopilot")
        let detail = AgentControlPlan.from(
            systemState: "active",
            runState: .running,
            authority: "propose",
            snapshotStale: false,
            ready: true
        ).statusDetail
        XCTAssertTrue(detail.contains("Ask-first"), detail)
        XCTAssertFalse(detail.contains("Ask-First"), detail)
        for word in ["propose", "decide"] {
            XCTAssertFalse(AppFormat.strategyAuthorityLabel(word).lowercased() == word)
        }
    }

    /// The Guardrails rows used to print the raw wire enum ("execute", "propose").
    func testGuardrailValueRowsNeverPrintTheWireEnum() {
        XCTAssertEqual(DeskCopy.socraticOverrideValue("execute"), "execute in Autopilot")
        XCTAssertEqual(DeskCopy.socraticOverrideValue("propose"), "propose only")
        XCTAssertEqual(DeskCopy.socraticOverrideValue("off"), "off")
        XCTAssertEqual(DeskCopy.socraticOverrideValue(nil), "off")
        // "Decide" is never shown to a user — Autopilot is the word for that mode.
        XCTAssertFalse(DeskCopy.socraticOverrideValue("execute").lowercased().contains("decide"))

        XCTAssertEqual(DeskCopy.sellToFundValue("suggest"), "suggest only")
        XCTAssertEqual(DeskCopy.sellToFundValue("propose"), "propose sells first")
        XCTAssertEqual(DeskCopy.sellToFundValue("automated"), "sells automatically")
        XCTAssertEqual(DeskCopy.sellToFundValue(nil), "off")
        // A bare "propose" here would read as the unrelated Ask-first authority mode.
        XCTAssertNotEqual(DeskCopy.sellToFundValue("propose"), "propose")

        for value in ["off", "suggest", "propose", "automated"] {
            assertOrdinary(DeskCopy.sellToFundValue(value))
        }
        for value in ["off", "propose", "execute"] {
            assertOrdinary(DeskCopy.socraticOverrideValue(value))
        }
    }

    /// The Guardrails screen shows each cap twice — a read-only row and an edit control.
    /// They must use the SAME name, and neither may be one of the ambiguous short forms.
    func testCapEditControlsUseTheSameNamesAsTheReadOnlyRows() {
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.title, "Max Per Order")
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.title, "Max Spend Per Day")
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.menuTitle, "Edit Max Per Order")
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.menuTitle, "Edit Max Spend Per Day")
        for cap in PolicyTightening.Cap.allCases {
            // "Max Order" reads as an order count; "Daily Cap" names none of the three
            // daily caps (spend, order count, loss stop) it could refer to.
            XCTAssertNotEqual(cap.title, "Max Order")
            XCTAssertNotEqual(cap.title, "Daily Cap")
            assertOrdinary(cap.title)
            assertOrdinary(cap.menuTitle)
        }
    }

    /// Last Run is a completed stamp.  It must never reuse the Next Run
    /// "not scheduled" empty copy — that is what made Autopilot Roth look idle.
    func testLastRunNeverSaysNotScheduled() {
        XCTAssertEqual(AppFormat.lastRun(nil), "never")
        XCTAssertFalse(AppFormat.lastRun(nil).localizedCaseInsensitiveContains("scheduled"))
        XCTAssertEqual(AppFormat.nextRun(nil, autonomyActive: false), "not scheduled")
        XCTAssertEqual(AppFormat.nextRun(nil, autonomyActive: true), "due at next session")
        XCTAssertFalse(AppFormat.nextRun(nil, autonomyActive: true).localizedCaseInsensitiveContains("not scheduled"))
        let stamp = "2026-08-21T15:02:00.000Z"
        XCTAssertNotEqual(AppFormat.lastRun(stamp), "never")
        XCTAssertNotEqual(AppFormat.lastRun(stamp), "not scheduled")
        XCTAssertNotEqual(AppFormat.nextRun(stamp, autonomyActive: true), "not scheduled")
        XCTAssertNotEqual(AppFormat.nextRun(stamp, autonomyActive: true), "due at next session")
    }

    /// The More-list line claimed the screen only tightens policy, which the screen
    /// itself contradicts ("Caps can go up or down").
    func testGuardrailsTabDetailDoesNotClaimTighteningOnly() {
        let detail = AppTab.guardrails.detail
        XCTAssertFalse(detail.lowercased().contains("tighten"), detail)
        XCTAssertTrue(detail.contains("caps"), detail)
        assertOrdinary(detail)
    }

    private func assertOrdinary(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        let lower = text.lowercased()
        for token in forbidden {
            XCTAssertFalse(lower.contains(token), "\(text) still contains \(token)", file: file, line: line)
        }
        XCTAssertFalse(text.contains("__"), "\(text) still contains a dunder token", file: file, line: line)
    }
}

/// Apple sign-in failures must read as app language, not framework language.
///
/// The regression these guard: `complete(_:)` used to assign `error.localizedDescription`
/// straight to `store.error`, which for an `ASAuthorizationError` renders as
/// "The operation couldn't be completed. (com.apple.AuthenticationServices.
/// AuthorizationError error 1000.)".  That was on screen in a real run.
extension UserFacingCopyTests {
    private func authorizationError(_ code: ASAuthorizationError.Code) -> Error {
        ASAuthorizationError(_nsError: NSError(domain: ASAuthorizationError.errorDomain, code: code.rawValue))
    }

    func testAppleFailureCopyNeverLeaksFrameworkInternals() {
        let codes: [ASAuthorizationError.Code] = [.unknown, .failed, .invalidResponse, .notHandled]
        for code in codes {
            guard let message = AppleSignInFailure.message(for: authorizationError(code)) else {
                XCTFail("\(code) should surface something")
                continue
            }
            for leak in ["com.apple", "AuthorizationError", "NSError", "error 1000", "couldn't be completed", "Domain"] {
                XCTAssertFalse(
                    message.localizedCaseInsensitiveContains(leak),
                    "\(code) leaked \(leak): \(message)"
                )
            }
            assertOrdinary(message)
            XCTAssertTrue(message.hasSuffix("."), "\(code) should read as a sentence: \(message)")
        }
    }

    func testCancellingAppleSignInSaysNothingAtAll() {
        // Backing out is not a failure, and an error banner for it reads as an accusation.
        XCTAssertNil(AppleSignInFailure.message(for: authorizationError(.canceled)))
    }

    func testAnUnrecognisedErrorStillGetsPlainLanguage() {
        let message = AppleSignInFailure.message(for: NSError(domain: "SomeOtherDomain", code: 42))
        XCTAssertNotNil(message)
        XCTAssertFalse(message!.contains("SomeOtherDomain"))
        assertOrdinary(message!)
    }

    func testAppleFailureCopyUsesTheTwoSpaceSentenceGap() {
        for code in [ASAuthorizationError.Code.unknown, .failed, .invalidResponse] {
            let message = AppleSignInFailure.message(for: authorizationError(code)) ?? ""
            // Every internal sentence boundary carries the fleet's two-space gap.
            let singleGap = message.range(of: #"\.\s[A-Z]"#, options: .regularExpression)
            XCTAssertNil(singleGap, "\(code) has a single-space sentence gap: \(message)")
        }
    }
}
