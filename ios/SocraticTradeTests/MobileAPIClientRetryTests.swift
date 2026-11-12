import XCTest
@testable import SocraticTrade

/// Request-count checks for the ST-4611 retry budgets, driven through a stub URLProtocol.
final class MobileAPIClientRetryTests: XCTestCase {
    private let base = URL(string: "https://socratictrade.com")!

    override func tearDown() {
        RetryStubURLProtocol.reset()
        super.tearDown()
    }

    func testSnapshotGatewayErrorIsRetriedOnceThenSucceeds() async throws {
        RetryStubURLProtocol.script = [.status(503), .status(200, Self.minimalSnapshotJSON)]
        let client = MobileAPIClient(baseURL: base, session: Self.stubbedSession())
        _ = try await client.snapshotData(timeout: 5, captureFailures: false)
        XCTAssertEqual(RetryStubURLProtocol.paths, ["/api/mobile/snapshot", "/api/mobile/snapshot"])
    }

    func testSnapshotGatewayErrorStopsAfterOneRetry() async {
        RetryStubURLProtocol.script = [.status(503), .status(503), .status(503)]
        let client = MobileAPIClient(baseURL: base, session: Self.stubbedSession())
        do {
            _ = try await client.snapshotData(timeout: 5, captureFailures: false)
            XCTFail("expected serverError")
        } catch let error as MobileAPIError {
            guard case .serverError(let status, _) = error else {
                return XCTFail("expected serverError, got \(error)")
            }
            XCTAssertEqual(status, 503)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(RetryStubURLProtocol.paths.count, 2)
    }

    func testSnapshotNetworkErrorIsNotRetriedInsideTheClient() async {
        RetryStubURLProtocol.script = [.failure, .failure]
        let client = MobileAPIClient(baseURL: base, session: Self.stubbedSession())
        do {
            _ = try await client.snapshotData(timeout: 5, captureFailures: false)
            XCTFail("expected network error")
        } catch let error as MobileAPIError {
            guard case .network = error else { return XCTFail("expected network, got \(error)") }
        } catch {
            XCTFail("unexpected \(error)")
        }
        // MobileStore.fetchSnapshotWithNetworkRetry owns network retries.
        XCTAssertEqual(RetryStubURLProtocol.paths.count, 1)
    }

    func testMarketScanGatewayRetriesCapAtTwoRequests() async {
        RetryStubURLProtocol.script = [.status(502), .status(502), .status(502)]
        let client = MobileAPIClient(baseURL: base, session: Self.stubbedSession())
        do {
            _ = try await client.marketScan()
            XCTFail("expected serverError")
        } catch let error as MobileAPIError {
            guard case .serverError(let status, _) = error else {
                return XCTFail("expected serverError, got \(error)")
            }
            XCTAssertEqual(status, 502)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(RetryStubURLProtocol.paths, ["/api/scan", "/api/scan"])
    }

    private static func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RetryStubURLProtocol.self]
        return URLSession(configuration: configuration)
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

private final class RetryStubURLProtocol: URLProtocol {
    enum Step {
        case status(Int, String = "{}")
        case failure
    }

    private static let lock = NSLock()
    static var script: [Step] = []
    private static var recorded: [String] = []

    static var paths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    static func reset() {
        lock.lock()
        script = []
        recorded = []
        lock.unlock()
    }

    private static func next(path: String) -> Step {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(path)
        return script.isEmpty ? .failure : script.removeFirst()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch Self.next(path: request.url?.path ?? "") {
        case .failure:
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
        case .status(let code, let body):
            let response = HTTPURLResponse(
                url: request.url ?? URL(string: "https://socratictrade.com/")!,
                statusCode: code,
                httpVersion: nil,
                headerFields: ["content-type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
