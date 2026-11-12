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
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 404, captureFailures: true))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 500, captureFailures: false))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 500, captureFailures: true))
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldCaptureExhaustedServerError(statusCode: 503, captureFailures: false))
    }

    func testNetworkRetryOnIdempotentReads() {
        XCTAssertTrue(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "GET", attemptIndex: 0))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "POST", attemptIndex: 0))
        XCTAssertFalse(MobileAPIHTTPRetryPolicy.shouldRetryNetworkError(method: "GET", attemptIndex: 2))
    }

}
