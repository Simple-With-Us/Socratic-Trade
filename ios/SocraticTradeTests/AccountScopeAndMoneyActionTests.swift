import XCTest
@testable import SocraticTrade

/// Sign-out and account switch must drop every account cache, and approve, reject,
/// and cancel must each surface success, failure, and a retry.
@MainActor
final class AccountScopeAndMoneyActionTests: XCTestCase {
    private let cacheKey = "cached_mobile_snapshot_data"
    private let cacheTimestampKey = "cached_mobile_snapshot_saved_at"
    private let tabPreferenceKey = "mobileTabs.v1"
    private let coachModelKey = "console.assistant.model"

    private func makeStore(
        preview: MobileSnapshot? = nil,
        session: URLSession = .shared
    ) -> MobileStore {
        return MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!, session: session),
            previewSnapshot: preview
        )
    }

    private func makeIsolatedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = URLCache(memoryCapacity: 1_000_000, diskCapacity: 0, diskPath: nil)
        return URLSession(configuration: configuration)
    }

    private func seedAccountCaches(
        urlCache: URLCache,
        cookieStorage: HTTPCookieStorage
    ) throws -> (UserDefaults, URLRequest, HTTPCookie) {
        let defaults = UserDefaults.standard
        defaults.set(Data("{\"account\":\"A\"}".utf8), forKey: cacheKey)
        defaults.set(1_700_000_000.0, forKey: cacheTimestampKey)
        defaults.set(["home", "proposals"], forKey: tabPreferenceKey)
        defaults.set("claude-sonnet-5", forKey: coachModelKey)

        let url = try XCTUnwrap(URL(string: "https://socratictrade.com/api/mobile/snapshot"))
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let response = try XCTUnwrap(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        ))
        urlCache.storeCachedResponse(
            CachedURLResponse(response: response, data: Data("{\"account\":\"A\"}".utf8)),
            for: request
        )

        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "socratictrade.com",
            .path: "/",
            .name: "st-account-scope-test",
            .value: "account-a",
            .secure: "TRUE"
        ]))
        cookieStorage.setCookie(cookie)
        return (defaults, request, cookie)
    }

    private static func storageContains(_ cookie: HTTPCookie, in storage: HTTPCookieStorage) -> Bool {
        storage.cookies?.contains { $0.name == cookie.name && $0.value == cookie.value } ?? false
    }

    private func cleanup(
        _ defaults: UserDefaults,
        cookie: HTTPCookie,
        urlCache: URLCache,
        cookieStorage: HTTPCookieStorage
    ) {
        defaults.removeObject(forKey: cacheKey)
        defaults.removeObject(forKey: cacheTimestampKey)
        defaults.removeObject(forKey: tabPreferenceKey)
        defaults.removeObject(forKey: coachModelKey)
        cookieStorage.deleteCookie(cookie)
        urlCache.removeAllCachedResponses()
    }

    @MainActor
    func testSignOutClearsEveryAccountCacheAndStore() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(Self.minimalSnapshotJSON.utf8))
        let session = makeIsolatedSession()
        let urlCache = try XCTUnwrap(session.configuration.urlCache)
        let cookieStorage = try XCTUnwrap(session.configuration.httpCookieStorage)
        let seeded = try seedAccountCaches(urlCache: urlCache, cookieStorage: cookieStorage)
        defer { cleanup(seeded.0, cookie: seeded.2, urlCache: urlCache, cookieStorage: cookieStorage) }
        let store = makeStore(preview: snapshot, session: session)
        store.bindProposalCommand(proposalId: "proposal-1", commandId: "cmd-1")
        store.recordResolvedCommand(try Self.command(
            type: "order.cancel",
            status: "succeeded",
            resultStatus: "cancelled"
        ))
        XCTAssertEqual(store.sessionEpoch, 0)

        XCTAssertNotNil(urlCache.cachedResponse(for: seeded.1))
        XCTAssertTrue(Self.storageContains(seeded.2, in: cookieStorage))

        store.clearLocalSession()

        XCTAssertNil(seeded.0.data(forKey: cacheKey))
        XCTAssertEqual(seeded.0.double(forKey: cacheTimestampKey), 0)
        XCTAssertNil(urlCache.cachedResponse(for: seeded.1))
        XCTAssertFalse(Self.storageContains(seeded.2, in: cookieStorage))
        XCTAssertNil(store.snapshot)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.moneyActionResult)
        XCTAssertNil(store.proposalActionFeedback(proposalId: "proposal-1"))
        XCTAssertEqual(store.sessionEpoch, 1)
        XCTAssertEqual(seeded.0.stringArray(forKey: tabPreferenceKey), ["home", "proposals"])
        XCTAssertEqual(seeded.0.string(forKey: coachModelKey), "claude-sonnet-5")

        let relaunched = makeStore(session: session)
        XCTAssertNil(relaunched.snapshot)
        XCTAssertFalse(relaunched.isAuthenticated)
    }

    @MainActor
    func testAccountSwitchClearsCachesAndKeepsTheSession() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(Self.minimalSnapshotJSON.utf8))
        let session = makeIsolatedSession()
        let urlCache = try XCTUnwrap(session.configuration.urlCache)
        let cookieStorage = try XCTUnwrap(session.configuration.httpCookieStorage)
        let seeded = try seedAccountCaches(urlCache: urlCache, cookieStorage: cookieStorage)
        defer { cleanup(seeded.0, cookie: seeded.2, urlCache: urlCache, cookieStorage: cookieStorage) }
        let store = makeStore(preview: snapshot, session: session)
        store.stagePendingAccountSwitch("acct-2")
        store.bindProposalCommand(proposalId: "proposal-1", commandId: "cmd-1")
        let epoch = store.sessionEpoch

        XCTAssertNotNil(urlCache.cachedResponse(for: seeded.1))
        XCTAssertTrue(Self.storageContains(seeded.2, in: cookieStorage))

        store.clearAccountScopedCachesForAccountSwitch()

        XCTAssertNil(seeded.0.data(forKey: cacheKey))
        XCTAssertEqual(seeded.0.double(forKey: cacheTimestampKey), 0)
        XCTAssertNil(urlCache.cachedResponse(for: seeded.1))
        XCTAssertTrue(Self.storageContains(seeded.2, in: cookieStorage))
        XCTAssertNil(store.snapshot)
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertEqual(store.pendingAccountId, "acct-2")
        XCTAssertTrue(store.isRefreshing)
        XCTAssertEqual(store.sessionEpoch, epoch + 1)
        XCTAssertNil(store.proposalActionFeedback(proposalId: "proposal-1"))
        XCTAssertEqual(seeded.0.stringArray(forKey: tabPreferenceKey), ["home", "proposals"])
        XCTAssertEqual(seeded.0.string(forKey: coachModelKey), "claude-sonnet-5")

        let relaunched = makeStore(session: session)
        XCTAssertNil(relaunched.snapshot)
        XCTAssertFalse(relaunched.isAuthenticated)
    }

    @MainActor
    func testAccountSwitchReleasesTheBusyFlagAfterTheCacheWipe() throws {
        let store = makeStore()
        let operationID = "account.activate:acct-2"
        let command = try Self.command(type: "account.activate", status: "succeeded", id: "activate-1")
        store.armBusyOperation(operationID)
        store.clearAccountScopedCachesForAccountSwitch()
        XCTAssertTrue(store.isBusy(operationID))

        store.finishAccountSwitch(command, operationID: operationID, payload: ["accountId": "acct-2"])

        XCTAssertFalse(store.isBusy(operationID))
    }

    @MainActor
    func testMoneyResultDoesNotRepaintAnotherProposal() throws {
        let store = makeStore()
        store.stageProposalNotice(
            proposalId: "proposal-a",
            action: .approve,
            message: "Approve did not place an order."
        )
        store.bindProposalCommand(proposalId: "proposal-b", commandId: "cmd-b")
        store.recordResolvedCommand(try Self.command(
            type: "proposal.approve",
            status: "succeeded",
            resultStatus: "filled",
            id: "cmd-b"
        ))

        XCTAssertEqual(
            store.proposalActionFeedback(proposalId: "proposal-a"),
            .failed(action: .approve, message: "Approve did not place an order.")
        )

        store.bindProposalCommand(proposalId: "proposal-a", commandId: "cmd-a")
        store.recordResolvedCommand(try Self.command(
            type: "proposal.approve",
            status: "succeeded",
            resultStatus: "not_placed",
            id: "cmd-a"
        ))
        let own = try XCTUnwrap(store.proposalActionFeedback(proposalId: "proposal-a"))
        XCTAssertEqual(own, .retryable(action: .approve, message: "Order not placed — safe to retry."))
    }

    @MainActor
    func testApproveRejectAndCancelReportSuccessFailedAndRetryable() throws {
        let store = makeStore()
        let cases: [(MobileCommand, MoneyAction, MoneyActionResultKind, String)] = [
            (try Self.command(type: "proposal.approve", status: "succeeded", resultStatus: "filled"),
             .approve, .success, "Approved"),
            (try Self.command(type: "proposal.approve", status: "failed", resultStatus: "blocked", reasons: ["Blocked at approval time."]),
             .approve, .failed, "Approve Failed"),
            (try Self.command(type: "proposal.approve", status: "succeeded", resultStatus: "not_placed"),
             .approve, .retryable, "Try Approve Again"),
            (try Self.command(type: "proposal.reject", status: "succeeded", resultStatus: "rejected"),
             .reject, .success, "Rejected"),
            (try Self.command(type: "proposal.reject", status: "failed", error: "Proposal not found."),
             .reject, .failed, "Reject Failed"),
            (try Self.command(type: "proposal.reject", status: "failed", error: "Server is slow, still trying"),
             .reject, .retryable, "Try Reject Again"),
            (try Self.command(type: "order.cancel", status: "succeeded", resultStatus: "cancelled"),
             .cancel, .success, "Order Cancelled"),
            (try Self.command(type: "order.cancel", status: "failed", error: "That order is no longer working (filled).  There is nothing left to cancel."),
             .cancel, .failed, "Cancel Failed"),
            (try Self.command(type: "order.cancel", status: "failed", error: "Couldn't reach Socratic Trade"),
             .cancel, .retryable, "Try Cancel Again")
        ]

        for item in cases {
            let classified = try XCTUnwrap(MoneyActionResult.classify(command: item.0))
            XCTAssertEqual(classified.action, item.1, item.0.commandType)
            XCTAssertEqual(classified.kind, item.2, "\(item.0.commandType) \(item.0.status)")
            XCTAssertEqual(classified.title, item.3)
            store.recordResolvedCommand(item.0)
            XCTAssertEqual(store.moneyActionResult, classified)
        }

        let busy = try Self.command(
            type: "proposal.approve",
            status: "failed",
            resultStatus: "busy",
            reasons: ["A strategy run is in progress."]
        )
        XCTAssertEqual(MoneyActionResult.classify(command: busy)?.kind, .retryable)
        XCTAssertEqual(MoneyActionResult.classify(command: busy)?.message, "A strategy run is in progress.")

        let mismatch = try Self.command(
            type: "order.cancel",
            status: "failed",
            error: "That order belongs to a different account than the one selected now.  Switch back to it and try again."
        )
        XCTAssertEqual(MoneyActionResult.classify(command: mismatch)?.kind, .failed)

        let transport = try XCTUnwrap(MoneyActionResult.classify(
            commandType: "order.cancel",
            transportError: MobileAPIError.network(URLError(.timedOut))
        ))
        XCTAssertEqual(transport.kind, .retryable)
        XCTAssertEqual(transport.action, .cancel)
        XCTAssertNil(MoneyActionResult.classify(
            commandType: "watchlist.add",
            transportError: URLError(.timedOut)
        ))
    }

    private static func command(
        type: String,
        status: String,
        resultStatus: String? = nil,
        reasons: [String]? = nil,
        error: String? = nil,
        id: String = "cmd"
    ) throws -> MobileCommand {
        var result = ""
        if let resultStatus {
            let reasonJSON = reasons.map { list in
                let encoded = list.map { "\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" }.joined(separator: ",")
                return ",\"reasons\":[\(encoded)]"
            } ?? ""
            result = ",\"result\":{\"status\":\"\(resultStatus)\"\(reasonJSON)}"
        }
        let errorJSON = error.map { ",\"error\":\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" } ?? ""
        let json = """
        {"id":"\(id)","commandType":"\(type)","status":"\(status)"\(errorJSON)\(result),"createdAt":"2026-10-15T12:00:00.000Z","updatedAt":"2026-10-15T12:00:01.000Z"}
        """
        return try JSONDecoder().decode(MobileCommand.self, from: Data(json.utf8))
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
