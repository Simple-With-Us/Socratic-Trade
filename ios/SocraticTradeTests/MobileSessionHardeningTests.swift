import XCTest
@testable import SocraticTrade

final class MobileSessionHardeningTests: XCTestCase {
    private let base = URL(string: "https://socratictrade.com")!
    private let issuedNonce = "server-nonce"
    private let issuedDigest = "0891992dd7ec661dc2bf5be407acf21fd557daf14f762be012caaa04c9373eb1"

    func testAppleRequestNonceIsTheSha256HexTheServerAccepts() {
        XCTAssertEqual(AppleSignInNonce.sha256Hex(issuedNonce), issuedDigest)
        XCTAssertEqual(
            AppleSignInNonce.authorizationRequestNonce(serverNonce: issuedNonce),
            issuedDigest
        )
        XCTAssertNotEqual(
            AppleSignInNonce.authorizationRequestNonce(serverNonce: issuedNonce),
            issuedNonce
        )
        XCTAssertFalse(issuedDigest.contains(MobileAuthNonce.legacyCompat))
    }

    func testWebAuthStartCarriesThePreparedNonceAndRefusesLegacyCompat() throws {
        let challenge = String(repeating: "a", count: 43)
        XCTAssertNil(
            MobileWebAuthStart.callbackURL(
                baseURL: base,
                codeChallenge: challenge,
                handoffNonce: MobileAuthNonce.legacyCompat
            )
        )
        XCTAssertNil(
            MobileWebAuthStart.callbackURL(baseURL: base, codeChallenge: challenge, handoffNonce: "  ")
        )
        let callback = try XCTUnwrap(
            MobileWebAuthStart.callbackURL(
                baseURL: base,
                codeChallenge: challenge,
                handoffNonce: "prepared-nonce"
            )
        )
        let start = try XCTUnwrap(
            MobileWebAuthStart.startURL(baseURL: base, provider: "google", callbackURL: callback)
        )
        let startItems = URLComponents(url: start, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(startItems?.first { $0.name == "provider" }?.value, "google")
        let callbackString = try XCTUnwrap(startItems?.first { $0.name == "callbackUrl" }?.value)
        let callbackItems = URLComponents(string: callbackString)?.queryItems
        XCTAssertEqual(callbackItems?.first { $0.name == "code_challenge" }?.value, challenge)
        XCTAssertEqual(callbackItems?.first { $0.name == "handoff_nonce" }?.value, "prepared-nonce")
        XCTAssertFalse(start.absoluteString.contains(MobileAuthNonce.legacyCompat))
        XCTAssertFalse(callback.absoluteString.contains(MobileAuthNonce.legacyCompat))
    }

    func testAuthRequestsCarryTheHardeningHeaderAndNonceFields() throws {
        let client = MobileAPIClient(baseURL: base)
        let handoff = try client.handoffPrepareRequest(codeChallenge: String(repeating: "b", count: 43))
        let appleNonce = client.appleNonceRequest()
        let apple = try client.appleLoginRequest(
            identityToken: "identity-token",
            name: "Owner",
            nonce: issuedNonce
        )
        let exchange = try client.webAuthExchangeRequest(code: "handoff-code", verifier: "verifier-value")

        for request in [handoff, appleNonce, apple, exchange] {
            XCTAssertEqual(
                request.value(forHTTPHeaderField: MobileAPIClient.sessionHardeningHeaderField),
                MobileAPIClient.sessionHardeningHeaderValue,
                request.url?.path ?? ""
            )
            XCTAssertFalse(
                (request.url?.absoluteString ?? "").contains(MobileAuthNonce.legacyCompat)
            )
        }

        XCTAssertEqual(handoff.httpMethod, "POST")
        XCTAssertEqual(handoff.url?.path, "/api/mobile/auth/handoff-prepare")
        let handoffBody = try XCTUnwrap(jsonObject(handoff))
        XCTAssertEqual(handoffBody["codeChallenge"] as? String, String(repeating: "b", count: 43))
        XCTAssertNil(handoffBody["code_challenge"])

        XCTAssertEqual(appleNonce.httpMethod, "GET")
        XCTAssertEqual(appleNonce.url?.path, "/api/mobile/auth/apple/nonce")

        XCTAssertEqual(apple.url?.path, "/api/mobile/auth/apple")
        let appleBody = try XCTUnwrap(jsonObject(apple))
        XCTAssertEqual(appleBody["identityToken"] as? String, "identity-token")
        XCTAssertEqual(appleBody["name"] as? String, "Owner")
        XCTAssertEqual(appleBody["nonce"] as? String, issuedNonce)
        XCTAssertNotEqual(appleBody["nonce"] as? String, issuedDigest)

        XCTAssertEqual(exchange.url?.path, "/api/mobile/auth/exchange")
        let exchangeBody = try XCTUnwrap(jsonObject(exchange))
        XCTAssertEqual(exchangeBody["code"] as? String, "handoff-code")
        XCTAssertEqual(exchangeBody["codeVerifier"] as? String, "verifier-value")
    }

    func testPrepareHandoffPostsTheChallengeAndReturnsTheServerNonce() async throws {
        let log = AuthRequestLog()
        let session = stubbedSession(log: log) { request in
            XCTAssertEqual(request.url?.path, "/api/mobile/auth/handoff-prepare")
            XCTAssertEqual(request.httpMethod, "POST")
            return (200, Data(#"{"nonce":"issued-handoff"}"#.utf8))
        }
        let client = MobileAPIClient(baseURL: base, session: session)
        let nonce = try await client.prepareHandoff(codeChallenge: String(repeating: "c", count: 43))
        XCTAssertEqual(nonce, "issued-handoff")
        XCTAssertEqual(log.snapshot().count, 1)
        XCTAssertEqual(
            log.snapshot()[0].header,
            MobileAPIClient.sessionHardeningHeaderValue
        )
    }

    func testAppleNonceFetchFailureDoesNotReturnAFallbackNonce() async {
        let session = stubbedSession(log: AuthRequestLog()) { _ in
            (503, Data(#"{"error":"unavailable"}"#.utf8))
        }
        let client = MobileAPIClient(baseURL: base, session: session)
        do {
            _ = try await client.fetchAppleSignInNonce()
            XCTFail("a failed nonce fetch must throw")
        } catch let error as MobileAPIError {
            if case .serverError(let status, _) = error {
                XCTAssertEqual(status, 503)
            } else {
                XCTFail("expected a server error, got \(error)")
            }
            XCTAssertFalse(error.localizedDescription.contains(MobileAuthNonce.legacyCompat))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testLegacyNonceFromHandoffPrepareIsRefused() async {
        let session = stubbedSession(log: AuthRequestLog()) { _ in
            (200, Data(#"{"nonce":"__legacy_compat__"}"#.utf8))
        }
        let client = MobileAPIClient(baseURL: base, session: session)
        do {
            _ = try await client.prepareHandoff(codeChallenge: String(repeating: "d", count: 43))
            XCTFail("legacy nonce must not be accepted")
        } catch {
            XCTAssertTrue(error is MobileAPIError)
        }
    }

    func testPushRegisterConflictIsASingleRequest() async {
        let log = AuthRequestLog()
        let session = stubbedSession(log: log) { _ in
            (409, Data(#"{"ok":false,"error":"other account"}"#.utf8))
        }
        let client = MobileAPIClient(baseURL: base, session: session)
        let registration = PushRegistrationRequest(
            token: "abc123",
            environment: .production,
            bundleId: "com.socratictrade.ios"
        )
        do {
            try await client.registerPushToken(try XCTUnwrap(registration))
            XCTFail("409 must throw")
        } catch let error as MobileAPIError {
            guard case .deviceTokenConflict = error else {
                return XCTFail("expected a device-token conflict, got \(error)")
            }
            XCTAssertEqual(error.localizedDescription, PushRegistrationPolicy.conflictMessage)
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertEqual(log.snapshot().count, 1)
        XCTAssertEqual(log.snapshot()[0].method, "POST")
        XCTAssertEqual(log.snapshot()[0].path, "/api/mobile/push/register")
    }

    func testConflictGateDoesNotSendTheSameTokenAgainUntilTheHoldClears() {
        var gate = PushRegistrationGate()
        let token = "device-token"
        XCTAssertTrue(gate.shouldSend(token: token))
        gate.observe(token: token, error: .deviceTokenConflict(message: nil))
        XCTAssertFalse(gate.shouldSend(token: token))
        XCTAssertFalse(gate.shouldSend(token: token))
        XCTAssertTrue(gate.shouldSend(token: "other-device"))
        gate.observeSuccess()
        XCTAssertTrue(gate.shouldSend(token: token))
        XCTAssertEqual(
            PushAlertState.failureSummary(PushRegistrationPolicy.conflictMessage),
            PushRegistrationPolicy.conflictMessage
        )
        XCTAssertFalse(PushRegistrationPolicy.conflictMessage.contains("apns"))
        XCTAssertFalse(PushRegistrationPolicy.conflictMessage.lowercased().contains("device token"))
    }

    @MainActor
    func testSignOutUnregistersPushBeforeClearingCookies() async throws {
        let log = AuthRequestLog()
        let session = stubbedSession(log: log) { request in
            (200, Data(#"{"ok":true,"removed":true}"#.utf8))
        }
        let storage = try XCTUnwrap(session.configuration.httpCookieStorage)
        let cookie = try sessionCookie()
        storage.setCookie(cookie)
        let client = MobileAPIClient(baseURL: base, session: session)
        let release = ScriptedPushRelease(client: client, token: "abc123")
        let store = MobileStore(client: client)
        store.pushTokenRelease = release

        await store.signOut()

        let events = log.snapshot()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].method, "DELETE")
        XCTAssertEqual(events[0].path, "/api/mobile/push/register")
        XCTAssertTrue(release.cookiePresentAtUnregister)
        XCTAssertFalse(storage.cookies?.contains { $0.name == cookie.name } ?? false)
    }

    @MainActor
    func testAccountChangeUnregistersBeforeTheNewAppleSignIn() async throws {
        let log = AuthRequestLog()
        let session = stubbedSession(log: log) { request in
            if request.url?.path == "/api/mobile/auth/apple" {
                return (200, Data(#"{"success":true,"email":"owner@example.com"}"#.utf8))
            }
            if request.url?.path == "/api/mobile/snapshot" {
                return (200, Data(self.minimalSnapshotJSON.utf8))
            }
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        let storage = try XCTUnwrap(session.configuration.httpCookieStorage)
        storage.setCookie(try sessionCookie())
        clearSnapshotCache()
        defer { clearSnapshotCache() }
        let client = MobileAPIClient(baseURL: base, session: session)
        let release = ScriptedPushRelease(client: client, token: "abc123")
        let store = MobileStore(client: client)
        store.opensEventStreamOnSignIn = false
        store.claimsPushOnSignIn = false
        store.pushTokenRelease = release

        await store.loginWithApple(identityToken: "identity-token", name: "Owner", nonce: issuedNonce)

        let events = log.snapshot()
        XCTAssertGreaterThanOrEqual(events.count, 2)
        XCTAssertEqual(events[0].method, "DELETE")
        XCTAssertEqual(events[0].path, "/api/mobile/push/register")
        XCTAssertTrue(release.cookiePresentAtUnregister)
        XCTAssertEqual(events[1].method, "POST")
        XCTAssertEqual(events[1].path, "/api/mobile/auth/apple")
        XCTAssertEqual(events[1].header, MobileAPIClient.sessionHardeningHeaderValue)
        XCTAssertTrue(storage.cookies?.contains { $0.name == "st-session-hardening" } ?? false)
    }

    private func jsonObject(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func sessionCookie() throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .domain: "socratictrade.com",
            .path: "/",
            .name: "st-session-hardening",
            .value: "still-signed-in",
            .secure: "TRUE"
        ]))
    }

    private func clearSnapshotCache() {
        UserDefaults.standard.removeObject(forKey: "cached_mobile_snapshot_data")
        UserDefaults.standard.removeObject(forKey: "cached_mobile_snapshot_saved_at")
    }

    private func stubbedSession(
        log: AuthRequestLog,
        handler: @escaping (URLRequest) throws -> (Int, Data)
    ) -> URLSession {
        SessionHardeningURLProtocol.log = log
        SessionHardeningURLProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionHardeningURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private let minimalSnapshotJSON = #"""
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

@MainActor
private final class ScriptedPushRelease: PushTokenReleasing {
    let client: MobileAPIClient
    var token: String?
    private(set) var cookiePresentAtUnregister = false

    init(client: MobileAPIClient, token: String?) {
        self.client = client
        self.token = token
    }

    func signOutAndForgetToken() async {
        await delete()
    }

    func relinquishTokenForAccountChange() async {
        await delete()
    }

    private func delete() async {
        let storage = client.session.configuration.httpCookieStorage
        cookiePresentAtUnregister = storage?.cookies?.contains { $0.name == "st-session-hardening" } ?? false
        guard let token else { return }
        try? await client.unregisterPushToken(token)
        self.token = nil
    }
}

private final class AuthRequestLog: @unchecked Sendable {
    struct Event {
        let method: String
        let path: String
        let header: String?
    }

    private let lock = NSLock()
    private var events: [Event] = []

    func append(_ event: Event) {
        lock.lock()
        events.append(event)
        lock.unlock()
    }

    func snapshot() -> [Event] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}

private final class SessionHardeningURLProtocol: URLProtocol {
    static var log = AuthRequestLog()
    static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.log.append(AuthRequestLog.Event(
            method: request.httpMethod ?? "",
            path: request.url?.path ?? "",
            header: request.value(forHTTPHeaderField: MobileAPIClient.sessionHardeningHeaderField)
        ))
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url ?? URL(string: "https://socratictrade.com/")!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["content-type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
