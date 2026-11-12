import Foundation

/// Pure retry and Sentry-reporting rules for transient gateway responses (502/503/504)
/// on idempotent mobile API reads.  Keeps policy testable without URLSession.
enum MobileAPIHTTPRetryPolicy {
    static let transientGatewayStatusCodes: Set<Int> = [502, 503, 504]
    /// Retries after the first attempt (three tries total).
    static let defaultMaxRetries = 2
    static let maxRetryAfterSeconds: TimeInterval = 30
    /// /api/scan runs a 50s server-side scan per request, so allow one retry (two requests).
    static let marketScanMaxRetries = 1
    /// `MobileStore.fetchSnapshotWithNetworkRetry` attempts; it retries only `.network` errors.
    static let snapshotStoreMaxAttempts = 2

    /// 502/503/504 transport retries inside one snapshot store attempt: one on the first
    /// attempt, none after.  Network errors are never retried inside snapshotData (the store
    /// owns them), and the store never retries a `.serverError`, so the loops never compound.
    static func snapshotGatewayRetries(storeAttempt: Int) -> Int {
        storeAttempt == 0 ? 1 : 0
    }

    /// Upper bound on HTTP requests for one snapshot refresh (currently 3: 2 + 1).
    static var snapshotMaxRequests: Int {
        (0..<snapshotStoreMaxAttempts).reduce(0) { $0 + 1 + snapshotGatewayRetries(storeAttempt: $1) }
    }

    static func isIdempotentRead(method: String?) -> Bool {
        let normalized = (method ?? "GET").uppercased()
        return normalized == "GET" || normalized == "HEAD"
    }

    static func shouldRetryTransientGateway(
        statusCode: Int,
        method: String?,
        attemptIndex: Int,
        maxRetries: Int = defaultMaxRetries
    ) -> Bool {
        guard isIdempotentRead(method: method) else { return false }
        guard transientGatewayStatusCodes.contains(statusCode) else { return false }
        return attemptIndex < maxRetries
    }

    /// Parses a Retry-After value when it is a delay in seconds (not an HTTP-date).
    static func parseRetryAfterSeconds(_ headerValue: String?) -> TimeInterval? {
        guard let raw = headerValue?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        guard let seconds = Int(raw), seconds >= 0 else { return nil }
        return min(TimeInterval(seconds), maxRetryAfterSeconds)
    }

    static func backoffNanoseconds(attemptIndex: Int, retryAfterSeconds: TimeInterval?) -> UInt64 {
        if let retryAfterSeconds {
            let clamped = min(max(0, retryAfterSeconds), maxRetryAfterSeconds)
            return UInt64(clamped * 1_000_000_000)
        }
        let multiplier = 1 << (attemptIndex + 1)
        return UInt64(150_000_000 * multiplier)
    }

    /// Status codes Sentry's automatic failed-request capture should still report (excludes 502–504).
    static func shouldReportAutomaticFailedRequest(statusCode: Int) -> Bool {
        if transientGatewayStatusCodes.contains(statusCode) { return false }
        if (500...501).contains(statusCode) { return true }
        if (505...599).contains(statusCode) { return true }
        return false
    }

    static func shouldRetryNetworkError(
        method: String?,
        attemptIndex: Int,
        maxRetries: Int = defaultMaxRetries
    ) -> Bool {
        isIdempotentRead(method: method) && attemptIndex < maxRetries
    }

    /// Manual capture after retries exhaust — only the transient gateway codes (502–504).
    /// sentry-cocoa's automatic failed-request capture still reports 500–501 and 505–599
    /// (`failedRequestStatusCodes` in SentryTelemetry), so capturing those manually too would
    /// emit two events for one response.  The two sets are complementary by construction.
    static func shouldCaptureExhaustedServerError(statusCode: Int) -> Bool {
        transientGatewayStatusCodes.contains(statusCode)
    }
}

/// Per-outage dedup for a manual Sentry report on a path that reconnects on its own (the SSE
/// stream).  The first 502/503/504 of an outage is reported; later failures are not, until a
/// successful connect calls `reset()`.  Lock-guarded (same pattern as NYSEMarketSession's
/// holiday cache) because reconnects can run on any task.
final class OutageReportLatch: @unchecked Sendable {
    /// Shared by every MobileAPIClient copy so `MobileStore`'s reconnect loop sees one outage.
    static let events = OutageReportLatch()

    private let lock = NSLock()
    private var latched = false
    private var granted = 0

    /// True for the first failure of an outage; false until `reset()` after that.
    func shouldReport() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !latched else { return false }
        latched = true
        granted += 1
        return true
    }

    /// A successful connect ends the outage.
    func reset() {
        lock.lock()
        latched = false
        lock.unlock()
    }

    /// Reports granted so far (tests).
    var grantedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return granted
    }
}
