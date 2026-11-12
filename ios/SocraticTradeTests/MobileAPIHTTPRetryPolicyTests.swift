import XCTest
@testable import SocraticTrade

final class MobileAPIHTTPRetryPolicyTests: XCTestCase {
    func testIdempotentReadMethods() {
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: "GET"))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: "HEAD"))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: nil))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: "POST"))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: "PATCH"))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.isIdempotentRead(method: "DELETE"))
    }

    func testRetryDecisionForTransientGatewayStatuses() {
        XCTAssertTrue(
            MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
                statusCode: 503,
                method: "GET",
                attemptIndex: 0
            )
        )
        XCTAssertTrue(
            MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
                statusCode: 502,
                method: "GET",
                attemptIndex: 1
            )
        )
        XCTAssertFalse(
            MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
                statusCode: 503,
                method: "GET",
                attemptIndex: 2
            )
        )
        XCTAssertFalse(
            MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
                statusCode: 503,
                method: "POST",
                attemptIndex: 0
            )
        )
        XCTAssertFalse(
            MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
                statusCode: 500,
                method: "GET",
                attemptIndex: 0
            )
        )
    }

    func testRetryAfterParsingCapsAtThirtySeconds() {
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.parseRetryAfterSeconds("5"), 5)
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.parseRetryAfterSeconds("120"), 30)
        XCTAssertNil(MobileAPIHTTPRetryPolicy.parseRetryAfterSeconds("not-a-number"))
        XCTAssertNil(MobileAPIHTTPRetryPolicy.parseRetryAfterSeconds(nil))
    }

    func testBackoffPrefersRetryAfterHeader() {
        let withHeader = MobileAPIHTTPRetryPolicy.backoffNanoseconds(
            attemptIndex: 0,
            retryAfterSeconds: 2
        )
        XCTAssertEqual(withHeader, 2_000_000_000)
        let withoutHeader = MobileAPIHTTPRetryPolicy.backoffNanoseconds(
            attemptIndex: 0,
            retryAfterSeconds: nil
        )
        XCTAssertEqual(withoutHeader, 300_000_000)
    }

    func testAutomaticFailedRequestCaptureFilter() {
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 502))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 503))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 504))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 500))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 501))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: 505))
    }

    func testExhaustedServerErrorCaptureFilter() {
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 404))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 502))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 503))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 504))
        // Automatic sentry-cocoa capture owns these; a manual capture would duplicate it.
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 500))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 501))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 505))
    }

    func testManualAndAutomaticCaptureNeverOverlap() {
        for status in 400...599 {
            XCTAssertFalse(
                MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: status)
                    && MobileAPIHTTPRetryPolicy.shouldReportAutomaticFailedRequest(statusCode: status),
                "status \(status) would be captured twice"
            )
        }
    }

    func testNetworkRetryOnIdempotentReads() {
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "GET", attemptIndex: 0))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "POST", attemptIndex: 0))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "GET", attemptIndex: 2))
    }

    func testSnapshotRetryBudgetIsBoundedAndGatewayRetriedOnce() {
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.snapshotStoreMaxAttempts, 2)
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.snapshotGatewayRetries(storeAttempt: 0), 1)
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.snapshotGatewayRetries(storeAttempt: 1), 0)
        XCTAssertEqual(MobileAPIHTTPRetryPolicy.snapshotMaxRequests, 3)
        // A 503 on the first store attempt is retried exactly once at the transport level.
        let first = MobileAPIHTTPRetryPolicy.snapshotGatewayRetries(storeAttempt: 0)
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
            statusCode: 503, method: "GET", attemptIndex: 0, maxRetries: first))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
            statusCode: 503, method: "GET", attemptIndex: 1, maxRetries: first))
    }

    func testMarketScanCappedAtTwoRequests() {
        let cap = MobileAPIHTTPRetryPolicy.marketScanMaxRetries
        XCTAssertEqual(cap, 1)
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
            statusCode: 502, method: "GET", attemptIndex: 0, maxRetries: cap))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryTransientGateway(
            statusCode: 502, method: "GET", attemptIndex: 1, maxRetries: cap))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(
            method: "GET", attemptIndex: 1, maxRetries: cap))
    }
    func testOutageLatchReportsFirstFailureUntilReset() {
        let latch = OutageReportLatch()
        XCTAssertTrue(latch.shouldReport())
        XCTAssertFalse(latch.shouldReport())
        XCTAssertFalse(latch.shouldReport())
        latch.reset()
        XCTAssertTrue(latch.shouldReport())
        XCTAssertEqual(latch.grantedCount, 2)
    }

    func testOutageLatchGrantsOnceUnderConcurrency() {
        let latch = OutageReportLatch()
        DispatchQueue.concurrentPerform(iterations: 200) { _ in _ = latch.shouldReport() }
        XCTAssertEqual(latch.grantedCount, 1)
    }
}
