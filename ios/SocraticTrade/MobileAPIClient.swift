import CryptoKit
import Foundation
import Security

enum MobileAPIError: Error, LocalizedError {
    case unauthorized(statusCode: Int)
    case serverError(statusCode: Int, message: String?)
    /// POST /api/mobile/push/register returned 409. The token still belongs to another account.
    case deviceTokenConflict(message: String?)
    case scanQuotesUnavailable(MarketScanResponse)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session expired.  Sign in again."
        case .deviceTokenConflict:
            return PushRegistrationPolicy.conflictMessage
        case .serverError(let statusCode, let message):
            // Cloudflare 521-523: origin unreachable.  Keep the reason, drop the vendor and code.
            if (521...523).contains(statusCode) {
                return "Socratic Trade is unreachable right now.  Try again in a few minutes."
            }
            if let message, !message.isEmpty {
                return message
            }
            return "Something went wrong.  Try again."
        case .scanQuotesUnavailable(let scan):
            let reasons = scan.warnings
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            if !reasons.isEmpty {
                return reasons.joined(separator: "  ")
            }
            return "Quotes were unavailable for this universe.  Refresh after the quote feed recovers."
        case .network(let underlying):
            if Self.isUserCancellation(underlying) { return nil }
            return Self.userFacingNetworkMessage(for: underlying) ?? "Couldn't reach Socratic Trade"
        case .decoding:
            return "Couldn’t load your workspace.  Try again."
        }
    }

    /// A push upload can be sent again. A 409 is not transient: another account owns the token.
    var isTransientPushRegistrationFailure: Bool {
        switch self {
        case .network, .decoding:
            return true
        case .serverError(let statusCode, _) where statusCode >= 500:
            return true
        case .serverError, .unauthorized, .deviceTokenConflict, .scanQuotesUnavailable:
            return false
        }
    }

    /// True when the failure is user- or task-initiated cancellation (no alert copy).
    static func isUserCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlError = error as? URLError, urlError.code == .cancelled { return true }
        if case MobileAPIError.network(let underlying) = error {
            return isUserCancellation(underlying)
        }
        return false
    }

    /// Maps URLSession failures to short, accurate copy.  Returns nil for user-cancelled work.
    static func userFacingNetworkMessage(for error: Error) -> String? {
        if isUserCancellation(error) { return nil }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled:
                return nil
            case .timedOut:
                return "Server is slow, still trying"
            case .notConnectedToInternet, .networkConnectionLost:
                return "Check your connection"
            default:
                return "Couldn't reach Socratic Trade"
            }
        }
        if case MobileAPIError.network(let underlying) = error {
            return userFacingNetworkMessage(for: underlying)
        }
        return nil
    }
}

struct SSEFrameAccumulator {
    private var frameHasPayload = false

    mutating func consume(line: String) -> Bool {
        if line.isEmpty {
            defer { frameHasPayload = false }
            return frameHasPayload
        }
        guard !line.hasPrefix(":") else { return false }
        if line.hasPrefix("event:") || line.hasPrefix("data:") {
            frameHasPayload = true
        }
        return false
    }
}

struct MobileAPIClient {
    /// The one origin this app talks to.  Shared so the push coordinator (which cannot be
    /// handed the store's client) targets the same host — and therefore the same
    /// in-memory cookie jar — instead of a second hardcoded string that can drift.
    static let productionBaseURL = URL(string: "https://socratictrade.com")!
    /// Sent on mobile auth requests so the server applies ST-2599 strict checks.
    static let sessionHardeningHeaderField = "x-socratic-mobile-session-hardening"
    static let sessionHardeningHeaderValue = "1"

    let baseURL: URL
    var session: URLSession
    /// Stable in-memory jar — do not read `session.configuration.httpCookieStorage` (configuration is a copy).
    let sessionCookieJar: HTTPCookieStorage
    /// Custom URL protocols for the account-change DELETE session. A live
    /// URLSession does not return `configuration.protocolClasses`, so a stub
    /// installed on `session` has to be repeated here.
    var isolatedProtocolClasses: [AnyClass]? = nil

    init(
        baseURL: URL,
        session: URLSession? = nil,
        cookieJar: HTTPCookieStorage? = nil,
        isolatedProtocolClasses: [AnyClass]? = nil
    ) {
        self.baseURL = baseURL
        self.isolatedProtocolClasses = isolatedProtocolClasses
        if let session {
            if let cookieJar {
                self.sessionCookieJar = cookieJar
                self.session = session
            } else if let existingJar = session.configuration.httpCookieStorage {
                self.sessionCookieJar = existingJar
                self.session = session
            } else {
                let jar = SessionCookiePersistence.makeInMemoryCookieStorage()
                let configuration = session.configuration.copy() as? URLSessionConfiguration
                    ?? session.configuration
                configuration.httpShouldSetCookies = true
                configuration.httpCookieAcceptPolicy = .always
                configuration.httpCookieStorage = jar
                self.sessionCookieJar = jar
                self.session = URLSession(
                    configuration: configuration,
                    delegate: session.delegate,
                    delegateQueue: session.delegateQueue
                )
            }
        } else {
            let jar = SessionCookiePersistence.makeInMemoryCookieStorage()
            self.sessionCookieJar = jar
            self.session = Self.makeURLSession(cookieJar: jar)
        }
    }

    /// In-memory cookie storage only — the durable session lives in the Keychain via `SessionCookieCoordinator`.
    static func makeURLSession(cookieJar: HTTPCookieStorage = SessionCookiePersistence.makeInMemoryCookieStorage()) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieJar
        return URLSession(configuration: configuration)
    }

    func snapshot() async throws -> MobileSnapshot {
        let (snap, _) = try await snapshotData()
        return snap
    }

    func snapshotData(
        timeout: TimeInterval = 30,
        captureFailures: Bool = true
    ) async throws -> (MobileSnapshot, Data) {
        var req = request(path: "/api/mobile/snapshot")
        // A shared URL cache can replay the previous account after a switch or sign-out.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = timeout
        // Retrying callers pass captureFailures: false and report only the terminal
        // failure, so a recovered transient does not mint a Sentry issue per attempt.
        let data = try await successfulResponseData(for: req, captureFailures: captureFailures)
        do {
            let snap = try JSONDecoder().decode(MobileSnapshot.self, from: data)
            return (snap, data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    func submit(
        commandType: String,
        payload: [String: Any] = [:],
        idempotencyKey: String = UUID().uuidString
    ) async throws -> MobileCommand {
        var request = request(path: "/api/mobile/commands", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("\(commandType):\(idempotencyKey)", forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "commandType": commandType,
            "payload": payload,
            "client": [
                "platform": "ios",
                "appVersion": Bundle.main.appVersion,
                "buildNumber": Bundle.main.buildNumber
            ]
        ])
        let envelope: CommandEnvelope = try await send(request)
        return envelope.command
    }

    func chatHistory() async throws -> [ChatTurn] {
        let envelope: ChatHistoryResponse = try await get("/api/chat-history")
        return envelope.turns
    }

    func sendChat(message: String, model: String?, clientTurnId: String) async throws -> ChatReply {
        var body: [String: Any] = [
            "message": message,
            "clientTurnId": clientTurnId
        ]
        if let model, !model.isEmpty {
            body["model"] = model
        }
        return try await sendJSON("/api/chat", method: "POST", body: body, timeout: 90)
    }

    func clearChatHistory() async throws {
        var request = request(path: "/api/chat-history", method: "DELETE")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [:])
        _ = try await successfulResponseData(for: request)
    }

    func chatProviders() async throws -> [String: Bool] {
        let envelope: ChatProvidersResponse = try await get("/api/chat/providers")
        return envelope.providers
    }

    /// Interactive market scan — GET `/api/scan`.  The server budget is 35s.
    /// Client wait is longer so a late seed/200 is not dropped as a dead table.
    /// A 503 `scan_quotes_unavailable` body still carries scanned/quotes/warnings
    /// so Scan can show the abort instead of "No Candidates."
    static let marketScanTimeout: TimeInterval = 50

    func marketScan(recoveryId: String? = nil) async throws -> MarketScanResponse {
        var req = marketScanRequest(recoveryId: recoveryId)
        req.timeoutInterval = Self.marketScanTimeout
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await dataRetryingTransportTimeout(for: req, transport: session)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            SentryTelemetry.captureAPIFailure(error: error, endpoint: req.url?.absoluteString ?? "/api/scan")
            throw MobileAPIError.network(error)
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 503 {
            if let failed = try? JSONDecoder().decode(MarketScanResponse.self, from: data),
               (failed.scannedSymbols ?? 0) > 0 || !failed.warnings.isEmpty {
                throw MobileAPIError.scanQuotesUnavailable(failed)
            }
        }
        try Self.requireSuccess(response, body: data)
        do {
            return try JSONDecoder().decode(MarketScanResponse.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    func marketScanRequest(recoveryId: String? = nil) -> URLRequest {
        var req = request(path: "/api/scan")
        if let recoveryId, !recoveryId.isEmpty,
           let url = req.url,
           var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = [URLQueryItem(name: "recovery", value: recoveryId)]
            if let next = components.url {
                req.url = next
            }
        }
        req.timeoutInterval = Self.marketScanTimeout
        return req
    }

    func fullPolicy() async throws -> FullPolicy {
        try await get("/api/policy")
    }

    func sourceFeatures() async throws -> SourceFeaturesResponse {
        try await get("/api/settings/source-features")
    }

    func patchSourceFeatures(_ settings: [String: Any]) async throws -> SourceFeaturesResponse {
        let _: SourceFeaturesPatchAck = try await sendJSON(
            "/api/settings/source-features",
            method: "PATCH",
            body: ["settings": settings]
        )
        return try await sourceFeatures()
    }

    func llmBudget() async throws -> LlmBudgetResponse {
        try await get("/api/settings/llm-budget")
    }

    func patchLlmBudget(_ body: [String: Any]) async throws -> LlmBudgetResponse {
        try await sendJSON("/api/settings/llm-budget", method: "PATCH", body: body)
    }

    /// On-demand single-symbol quote + fundamentals for `SymbolInfoSheet` — GET
    /// `/api/quote?symbol=...`, the same on-demand provider cascade the web console drilldown
    /// falls back to for a symbol outside the last market scan.
    func symbolQuote(_ symbol: String) async throws -> SymbolQuoteInfo {
        var components = URLComponents(url: baseURL.appending(path: "/api/quote"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = components?.url else {
            throw MobileAPIError.network(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return try await send(request)
    }

    /// Current-account exit contract + other-account size/direction for the ticker sheet.
    func symbolDesk(_ symbol: String) async throws -> SymbolDeskInfo {
        var components = URLComponents(url: baseURL.appending(path: "/api/symbol-desk"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = components?.url else {
            throw MobileAPIError.network(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return try await send(request)
    }

    /// Session-authed APNs token registration.  The response body is not consumed: the only
    /// thing the app needs to know is whether the server accepted the token, which is the
    /// status code.
    func registerPushToken(_ registration: PushRegistrationRequest) async throws {
        var request = request(path: "/api/mobile/push/register", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: registration.jsonBody)
        _ = try await successfulResponseData(for: request, deviceTokenConflictPath: true)
    }

    /// Sign-out counterpart.  Sends the token so the server drops the exact row rather than
    /// every token the session's user owns — signing out of one device must not silence
    /// another one the same owner is still signed in on.
    func unregisterPushToken(_ token: String) async throws {
        _ = try await successfulResponseData(for: unregisterPushRequest(token))
    }

    /// Account-change DELETE. The prior account's cookies go on this request only.
    /// The shared cookie jar is not read or written, so other in-flight calls keep
    /// the signed-in session.
    func unregisterPushToken(_ token: String, isolatedCookies: [HTTPCookie]) async throws {
        var request = try unregisterPushRequest(token)
        request.httpShouldHandleCookies = false
        let cookie = HTTPCookie.requestHeaderFields(with: isolatedCookies)["Cookie"]
        if let cookie {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.protocolClasses = isolatedProtocolClasses ?? session.configuration.protocolClasses
        let isolated = URLSession(configuration: configuration)
        defer { isolated.finishTasksAndInvalidate() }
        _ = try await successfulResponseData(for: request, transport: isolated)
    }

    private func unregisterPushRequest(_ token: String) throws -> URLRequest {
        var request = request(path: "/api/mobile/push/register", method: "DELETE")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
        return request
    }

    func acknowledgeNotifications(ids: [String]) async throws -> Int {
        let envelope: AcknowledgeNotificationsResponse = try await sendJSON(
            "/api/notifications/ack",
            method: "POST",
            body: ["ids": ids]
        )
        return envelope.acknowledged
    }

    func acceptAppConsent() async throws {
        var request = request(path: "/api/mobile/consent", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["accepted": true])
        _ = try await successfulResponseData(for: request)
    }

    func accountDeletionPreview() async throws -> AccountDeletionRequest {
        let envelope: DeletionRequestEnvelope = try await send(
            request(path: "/api/mobile/account-deletion/request")
        )
        return envelope.deletionRequest
    }

    func confirmAccountDeletion(
        typedIdentity: String,
        typedText: String
    ) async throws -> AccountDeletionResult {
        var request = request(path: "/api/mobile/account-deletion/confirm", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "typedIdentity": typedIdentity,
            "typedText": typedText
        ])
        let data = try await successfulResponseData(for: request)
        // A 2xx from this endpoint means the backend completed account deletion. Optional receipt
        // fields must never strand a locally-authenticated session if the response evolves or is
        // empty after the destructive server transaction has committed.
        return (try? JSONDecoder().decode(AccountDeletionResult.self, from: data)) ?? .successfulHTTP
    }

    func prepareHandoff(codeChallenge: String) async throws -> String {
        let response: HandoffNonceResponse = try await send(try handoffPrepareRequest(codeChallenge: codeChallenge))
        guard MobileAuthNonce.isServerIssued(response.nonce) else {
            throw MobileAPIError.serverError(
                statusCode: 502,
                message: MobileAuthStartFailure.handoffUnavailable
            )
        }
        return response.nonce
    }

    func fetchAppleSignInNonce() async throws -> String {
        let response: AppleServerNonceResponse = try await send(appleNonceRequest())
        guard MobileAuthNonce.isServerIssued(response.nonce) else {
            throw MobileAPIError.serverError(
                statusCode: 502,
                message: MobileAuthStartFailure.appleNonceUnavailable
            )
        }
        return response.nonce
    }

    func handoffPrepareRequest(codeChallenge: String) throws -> URLRequest {
        var request = authRequest(path: "/api/mobile/auth/handoff-prepare", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["codeChallenge": codeChallenge])
        return request
    }

    func appleNonceRequest() -> URLRequest {
        authRequest(path: "/api/mobile/auth/apple/nonce", method: "GET")
    }

    func appleLoginRequest(identityToken: String, name: String?, nonce: String) throws -> URLRequest {
        var request = authRequest(path: "/api/mobile/auth/apple", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["identityToken": identityToken, "nonce": nonce]
        if let name, !name.isEmpty {
            body["name"] = name
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    func webAuthExchangeRequest(code: String, verifier: String) throws -> URLRequest {
        var request = authRequest(path: "/api/mobile/auth/exchange", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "codeVerifier": verifier
        ])
        return request
    }

    func loginWithApple(identityToken: String, name: String?, nonce: String) async throws -> AppleLoginResponse {
        try await send(try appleLoginRequest(identityToken: identityToken, name: name, nonce: nonce))
    }

    func exchangeWebAuthCode(_ code: String, verifier: String) async throws {
        let _: WebAuthExchangeResponse = try await send(try webAuthExchangeRequest(code: code, verifier: verifier))
    }

    /// `onConnect` fires when the stream response is established and again on every received
    /// line — including ": ping" comment heartbeats (sent every 25s). Comment frames never reach
    /// `onEvent`, so before this hook a healthy idle stream kept the connected indicator false
    /// forever (#2559). `onEvent` still fires only for payload frames.
    func events(onConnect: @escaping () -> Void = {}, onEvent: @escaping () -> Void) async throws {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: eventsRequest())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            SentryTelemetry.captureAPIFailure(error: error, endpoint: "/api/mobile/events")
            throw MobileAPIError.network(error)
        }
        try Self.requireSuccess(response, body: nil)
        onConnect()

        var parser = SSEFrameAccumulator()
        do {
            for try await line in bytes.lines {
                try Task.checkCancellation()
                onConnect()
                if parser.consume(line: line) {
                    onEvent()
                }
            }
            } catch is CancellationError {
            throw CancellationError()
        } catch {
            SentryTelemetry.captureAPIFailure(error: error, endpoint: "/api/mobile/events")
            throw MobileAPIError.network(error)
        }
    }

    /// Long-lived SSE request. Must not reuse the JSON helper defaults:
    /// - `Accept: application/json` confuses some edge/proxy paths for `text/event-stream`
    /// - `timeoutInterval = 30` is only ~5s above the server's 25s heartbeat, so jitter or
    ///   buffering yields NSURLErrorCannotParseResponse (-1017) / connection-reset noise
    func eventsRequest() -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/events"))
        request.httpMethod = "GET"
        // Idle timeout between packets. Server heartbeats every 25s; keep generous slack.
        request.timeoutInterval = 120
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.setValue("no-cache", forHTTPHeaderField: "cache-control")
        return request
    }

    func resolvedURL(_ pathOrURL: String) -> URL? {
        if let absolute = URL(string: pathOrURL), absolute.scheme != nil {
            guard
                absolute.scheme?.lowercased() == "https",
                absolute.host?.lowercased() == baseURL.host?.lowercased(),
                absolute.port == baseURL.port
            else {
                return nil
            }
            return absolute
        }
        return baseURL.appending(path: pathOrURL)
    }

    func ownsCookie(_ cookie: HTTPCookie) -> Bool {
        guard let host = baseURL.host else { return false }
        return SessionCookiePersistence.ownsDomain(cookie, host: host)
    }

    func authSessionCookies() -> [HTTPCookie] {
        SessionCookiePersistence.authSessionCookies(in: sessionCookieJar, owningHost: baseURL.host)
    }

    private func request(path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    private func authRequest(path: String, method: String) -> URLRequest {
        var request = request(path: path, method: method)
        request.setValue(Self.sessionHardeningHeaderValue, forHTTPHeaderField: Self.sessionHardeningHeaderField)
        return request
    }

    private func get<T: Decodable>(_ path: String, retries: Int = 2, timeout: TimeInterval = 30) async throws -> T {
        // One counter covers transport timeouts and HTTP 5xx.  The inner timeout
        // loop is off here, so a 503 cannot start a fresh three-attempt timeout budget.
        let timeoutBudget = MobileAPITransportTimeoutRetry.maxRetries(forTimeout: timeout)
        var attempt = 0
        while true {
            do {
                var req = request(path: path)
                req.timeoutInterval = timeout
                return try await send(req, captureFailures: false, retryTransportTimeout: false)
            } catch let error as MobileAPIError {
                if Self.shouldRetryGet(
                    error,
                    attempt: attempt,
                    retries: retries,
                    timeoutBudget: timeoutBudget
                ) {
                    let delay = MobileAPITransportTimeoutRetry.backoffNanoseconds(attemptIndex: attempt)
                    attempt += 1
                    try await Task.sleep(nanoseconds: delay)
                    continue
                }
                if case .network(let underlying) = error {
                    SentryTelemetry.captureAPIFailure(error: underlying, endpoint: path)
                }
                throw error
            } catch {
                throw error
            }
        }
    }

    /// Timeouts, other transport failures, and HTTP 5xx share `attempt`.
    /// A long timeout still stops after `timeoutBudget` extras.  Writes do not use this.
    private static func shouldRetryGet(
        _ error: MobileAPIError,
        attempt: Int,
        retries: Int,
        timeoutBudget: Int
    ) -> Bool {
        switch error {
        case .network(let underlying):
            if MobileAPITransportTimeoutRetry.isTransportTimeout(underlying) {
                return attempt < timeoutBudget
            }
            return attempt < retries
        case .serverError(let statusCode, _):
            return statusCode >= 500 && attempt < retries
        case .unauthorized, .deviceTokenConflict, .scanQuotesUnavailable, .decoding:
            return false
        }
    }

    private func sendJSON<T: Decodable>(
        _ path: String,
        method: String,
        body: [String: Any],
        timeout: TimeInterval = 30
    ) async throws -> T {
        var request = request(path: path, method: method)
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private func send<T: Decodable>(
        _ request: URLRequest,
        captureFailures: Bool = true,
        retryTransportTimeout: Bool = true
    ) async throws -> T {
        let data = try await successfulResponseData(
            for: request,
            captureFailures: captureFailures,
            retryTransportTimeout: retryTransportTimeout
        )
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MobileAPIError.decoding(error)
        }
    }

    private func successfulResponseData(
        for request: URLRequest,
        captureFailures: Bool = true,
        deviceTokenConflictPath: Bool = false,
        transport: URLSession? = nil,
        retryTransportTimeout: Bool = true
    ) async throws -> Data {
        let data: Data
        let response: URLResponse
        let retryLimit = retryTransportTimeout
            ? MobileAPITransportTimeoutRetry.maxRetries(forTimeout: request.timeoutInterval)
            : 0
        do {
            (data, response) = try await dataRetryingTransportTimeout(
                for: request,
                transport: transport ?? session,
                maxRetries: retryLimit
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if captureFailures {
                SentryTelemetry.captureAPIFailure(error: error, endpoint: request.url?.absoluteString ?? "")
            }
            throw MobileAPIError.network(error)
        }
        if deviceTokenConflictPath,
           let http = response as? HTTPURLResponse,
           http.statusCode == 409 {
            throw MobileAPIError.deviceTokenConflict(message: Self.serverMessage(from: data))
        }
        try Self.requireSuccess(response, body: data)
        return data
    }

    /// One or two extra attempts when an idempotent read hits NSURLError -1001.
    /// A timeout of 45s or longer gets one extra attempt.  POST, PATCH, PUT, and
    /// DELETE return the first timeout.  `get` turns this loop off and owns
    /// that budget itself so a 5xx retry cannot start another one.
    private func dataRetryingTransportTimeout(
        for request: URLRequest,
        transport: URLSession,
        maxRetries: Int? = nil
    ) async throws -> (Data, URLResponse) {
        let retryLimit = maxRetries ?? MobileAPITransportTimeoutRetry.maxRetries(
            forTimeout: request.timeoutInterval
        )
        var attemptIndex = 0
        while true {
            do {
                return try await transport.data(for: request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                guard MobileAPITransportTimeoutRetry.shouldRetry(
                    error: error,
                    method: request.httpMethod,
                    attemptIndex: attemptIndex,
                    maxRetries: retryLimit
                ) else {
                    throw error
                }
                let delay = MobileAPITransportTimeoutRetry.backoffNanoseconds(attemptIndex: attemptIndex)
                attemptIndex += 1
                try await Task.sleep(nanoseconds: delay)
            }
        }
    }

    private static func requireSuccess(_ response: URLResponse, body: Data?) throws {
        guard let response = response as? HTTPURLResponse else {
            throw MobileAPIError.network(URLError(.badServerResponse))
        }
        guard 200..<300 ~= response.statusCode else {
            if response.statusCode == 401 || response.statusCode == 403 {
                throw MobileAPIError.unauthorized(statusCode: response.statusCode)
            }
            throw MobileAPIError.serverError(
                statusCode: response.statusCode,
                message: serverMessage(from: body)
            )
        }
    }

    private static func serverMessage(from data: Data?) -> String? {
        guard let data, !data.isEmpty else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object["message"] as? String ?? object["error"] as? String
        }
        // Cloudflare often returns plain text like "error code: 522" when origin is down.
        if let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty,
           text.count < 200,
           !text.hasPrefix("<") {
            return text
        }
        return nil
    }
}

struct AppleLoginResponse: Decodable {
    let success: Bool
    let email: String?
}

private struct AcknowledgeNotificationsResponse: Decodable {
    let acknowledged: Int
}

private struct WebAuthExchangeResponse: Decodable {
    let success: Bool
}

private struct HandoffNonceResponse: Decodable {
    let nonce: String
}

private struct AppleServerNonceResponse: Decodable {
    let nonce: String
}

struct WebAuthCodeVerifier {
    let value: String

    static func make() -> WebAuthCodeVerifier? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return nil
        }
        return WebAuthCodeVerifier(value: Data(bytes).base64URLEncodedString())
    }

    var challenge: String {
        Data(SHA256.hash(data: Data(value.utf8))).base64URLEncodedString()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension Bundle {
    var appVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var buildNumber: String {
        object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
    }
}
