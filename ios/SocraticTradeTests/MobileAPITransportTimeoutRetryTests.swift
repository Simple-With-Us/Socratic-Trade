import XCTest
@testable import SocraticTrade

final class MobileAPITransportTimeoutRetryTests: XCTestCase {
    private var session: URLSession?
    private let counter = AttemptCounter()

    override func tearDown() {
        TransportTimeoutURLProtocol.handler = nil
        session?.invalidateAndCancel()
        session = nil
        counter.reset()
        super.tearDown()
    }

    func testTimedOutAndNSURLErrorMinus1001AreTransportTimeouts() {
        XCTAssertEqual(URLError.Code.timedOut.rawValue, -1001)
        XCTAssertEqual(NSURLErrorTimedOut, -1001)
        XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(URLError(.timedOut)))
        XCTAssertTrue(
            MobileAPITransportTimeoutRetry.isTransportTimeout(
                NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
            )
        )
        let cfNetwork = NSError(
            domain: String(kCFErrorDomainCFNetwork),
            code: NSURLErrorTimedOut
        )
        let wrapped = NSError(domain: "wrapper", code: 1, userInfo: [NSUnderlyingErrorKey: cfNetwork])
        XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(wrapped))
    }

    func testOtherTransportAndHTTPFailuresAreNotTimeouts() {
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isTransportTimeout(URLError(.networkConnectionLost)))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isTransportTimeout(URLError(.cancelled)))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isTransportTimeout(CancellationError()))
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.isTransportTimeout(
                NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
            )
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.isTransportTimeout(NSError(domain: "HTTP", code: 503))
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.isTransportTimeout(NSError(domain: "HTTP", code: 500))
        )
    }

    func testRetryOnlyIdempotentReadsWithinTwoAttempts() {
        let timeout = URLError(.timedOut)
        XCTAssertTrue(MobileAPITransportTimeoutRetry.isIdempotentRead(method: nil))
        XCTAssertTrue(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "get"))
        XCTAssertTrue(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "HEAD"))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "POST"))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "PUT"))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "PATCH"))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isIdempotentRead(method: "DELETE"))
        XCTAssertFalse(MobileAPITransportTimeoutRetry.isIdempotentRead(method: " "))

        XCTAssertTrue(
            MobileAPITransportTimeoutRetry.shouldRetry(error: timeout, method: "GET", attemptIndex: 0)
        )
        XCTAssertTrue(
            MobileAPITransportTimeoutRetry.shouldRetry(error: timeout, method: "HEAD", attemptIndex: 1)
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.shouldRetry(error: timeout, method: "GET", attemptIndex: 2)
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.shouldRetry(error: timeout, method: "POST", attemptIndex: 0)
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.shouldRetry(error: timeout, method: "DELETE", attemptIndex: 0)
        )
        XCTAssertFalse(
            MobileAPITransportTimeoutRetry.shouldRetry(
                error: URLError(.networkConnectionLost),
                method: "GET",
                attemptIndex: 0
            )
        )
        XCTAssertEqual(MobileAPITransportTimeoutRetry.backoffNanoseconds(attemptIndex: 0), 300_000_000)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.backoffNanoseconds(attemptIndex: 1), 600_000_000)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.backoffNanoseconds(attemptIndex: 5), 600_000_000)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.maxRetries(forTimeout: 30), 2)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.maxRetries(forTimeout: 44), 2)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.maxRetries(forTimeout: 45), 1)
        XCTAssertEqual(MobileAPITransportTimeoutRetry.maxRetries(forTimeout: 50), 1)
    }

    func testSnapshotGetRetriesNSURLErrorTimedOutThenSucceeds() async throws {
        install { [counter] request in
            let attempt = counter.next()
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/mobile/snapshot")
            if attempt < 3 {
                throw NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
            }
            return (200, Data(Self.minimalSnapshotJSON.utf8))
        }
        let (snapshot, _) = try await makeClient().snapshotData()
        XCTAssertEqual(counter.count, 3)
        XCTAssertEqual(snapshot.readiness.systemState, "halted")
    }

    func testSnapshotGetStopsAfterTwoTransportTimeoutRetries() async throws {
        install { [counter] request in
            _ = counter.next()
            XCTAssertEqual(request.url?.path, "/api/mobile/snapshot")
            throw URLError(.timedOut)
        }
        do {
            _ = try await makeClient().snapshotData()
            XCTFail("expected the third timeout to surface")
        } catch let error as MobileAPIError {
            guard case .network(let underlying) = error else {
                return XCTFail("expected a network error")
            }
            XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(underlying))
        }
        XCTAssertEqual(counter.count, 3)
    }

    func testMarketScanGetRetriesTransportTimeout() async throws {
        install { [counter] request in
            let attempt = counter.next()
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/scan")
            XCTAssertGreaterThanOrEqual(request.timeoutInterval, 45)
            if attempt < 2 {
                throw URLError(.timedOut)
            }
            return (200, Data(#"{"topCandidates":[],"warnings":[]}"#.utf8))
        }
        let scan = try await makeClient().marketScan()
        XCTAssertEqual(counter.count, 2)
        XCTAssertTrue(scan.topCandidates.isEmpty)
    }

    func testLongSnapshotTimeoutRetriesOnce() async throws {
        install { [counter] request in
            _ = counter.next()
            XCTAssertEqual(request.timeoutInterval, 45)
            XCTAssertEqual(request.url?.path, "/api/mobile/snapshot")
            throw URLError(.timedOut)
        }
        do {
            _ = try await makeClient().snapshotData(timeout: 45)
            XCTFail("expected the second timeout to surface")
        } catch let error as MobileAPIError {
            guard case .network(let underlying) = error else {
                return XCTFail("expected a network error")
            }
            XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(underlying))
        }
        XCTAssertEqual(counter.count, 2)
    }

    func testCommandPostDoesNotRetryTransportTimeout() async throws {
        install { [counter] request in
            _ = counter.next()
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/mobile/commands")
            throw URLError(.timedOut)
        }
        do {
            _ = try await makeClient().submit(commandType: "strategy.stop", idempotencyKey: "once")
            XCTFail("expected the post to fail on the first timeout")
        } catch let error as MobileAPIError {
            guard case .network(let underlying) = error else {
                return XCTFail("expected a network error")
            }
            XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(underlying))
        }
        XCTAssertEqual(counter.count, 1)
    }

    func testCommandPostDoesNotRetryHTTP500() async throws {
        install { [counter] request in
            _ = counter.next()
            XCTAssertEqual(request.httpMethod, "POST")
            return (500, Data(#"{"error":"no"}"#.utf8))
        }
        do {
            _ = try await makeClient().submit(commandType: "strategy.stop", idempotencyKey: "once")
            XCTFail("expected the post to fail")
        } catch let error as MobileAPIError {
            guard case .serverError(let statusCode, _) = error else {
                return XCTFail("expected a server error")
            }
            XCTAssertEqual(statusCode, 500)
        }
        XCTAssertEqual(counter.count, 1)
    }

    func testPolicyGetStillRetriesHTTP503() async throws {
        install { [counter] request in
            let attempt = counter.next()
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/policy")
            if attempt < 3 {
                return (503, Data(#"{"error":"unavailable"}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }
        let policy = try await makeClient().fullPolicy()
        XCTAssertEqual(counter.count, 3)
        XCTAssertNil(policy.systemState)
    }

    func testPolicyGetStopsAfterThreeTransportTimeouts() async throws {
        install { [counter] request in
            _ = counter.next()
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/policy")
            throw URLError(.timedOut)
        }
        do {
            _ = try await makeClient().fullPolicy()
            XCTFail("expected the third timeout to surface")
        } catch let error as MobileAPIError {
            guard case .network(let underlying) = error else {
                return XCTFail("expected a network error")
            }
            XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(underlying))
        }
        XCTAssertEqual(counter.count, 3)
    }

    func testPolicyGetSharesTimeoutAndServerRetryBudget() async throws {
        install { [counter] request in
            let attempt = counter.next()
            XCTAssertEqual(request.url?.path, "/api/policy")
            if attempt == 1 {
                throw URLError(.timedOut)
            }
            if attempt == 2 {
                return (503, Data(#"{"error":"unavailable"}"#.utf8))
            }
            throw URLError(.timedOut)
        }
        do {
            _ = try await makeClient().fullPolicy()
            XCTFail("expected the shared budget to stop on the third attempt")
        } catch let error as MobileAPIError {
            guard case .network(let underlying) = error else {
                return XCTFail("expected the third attempt to be a transport timeout")
            }
            XCTAssertTrue(MobileAPITransportTimeoutRetry.isTransportTimeout(underlying))
        }
        XCTAssertEqual(counter.count, 3)
    }

    @MainActor
    func testLoadUsesOneTransportTimeoutBudget() async throws {
        let defaults = UserDefaults.standard
        let dataKey = "cached_mobile_snapshot_data"
        let savedAtKey = "cached_mobile_snapshot_saved_at"
        let originalData = defaults.object(forKey: dataKey)
        let originalSavedAt = defaults.object(forKey: savedAtKey)
        defer {
            if let originalData {
                defaults.set(originalData, forKey: dataKey)
            } else {
                defaults.removeObject(forKey: dataKey)
            }
            if let originalSavedAt {
                defaults.set(originalSavedAt, forKey: savedAtKey)
            } else {
                defaults.removeObject(forKey: savedAtKey)
            }
        }
        defaults.removeObject(forKey: dataKey)
        defaults.removeObject(forKey: savedAtKey)
        install { [counter] _ in
            _ = counter.next()
            throw URLError(.timedOut)
        }
        let store = MobileStore(client: makeClient())
        await store.load()
        // load() uses a 45s timeout, so the client takes one extra try.
        // The store does not start another pass after that budget is spent.
        XCTAssertEqual(counter.count, 2)
        XCTAssertNil(store.snapshot)
        XCTAssertTrue(store.snapshotLoadFailed)
        XCTAssertFalse(store.isRefreshing)
    }

    private func makeClient() -> MobileAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransportTimeoutURLProtocol.self]
        let session = URLSession(configuration: configuration)
        self.session = session
        return MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!, session: session)
    }

    private func install(
        _ handler: @escaping (URLRequest) throws -> (Int, Data)
    ) {
        counter.reset()
        TransportTimeoutURLProtocol.handler = handler
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

private final class AttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func reset() {
        lock.lock()
        value = 0
        lock.unlock()
    }
}

private final class TransportTimeoutURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
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
