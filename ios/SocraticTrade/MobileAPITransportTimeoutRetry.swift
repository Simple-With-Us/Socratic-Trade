import Foundation

/// Retry rule for NSURLError -1001 (`URLError.timedOut`) on idempotent reads.
/// HTTP 5xx stays on its own path.  This type does not decide gateway retries.
enum MobileAPITransportTimeoutRetry {
    /// Extra tries after the first attempt (three tries total) for a short request.
    static let maxRetries = 2

    /// A per-attempt wait this long gets one extra try, not two.
    /// Snapshot load is 45s.  Two extra tries held refresh for about 136s.
    static let singleRetryTimeout: TimeInterval = 45

    static func isIdempotentRead(method: String?) -> Bool {
        let normalized = (method ?? "GET")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        return normalized == "GET" || normalized == "HEAD"
    }

    /// True for `URLError.timedOut`, `NSURLErrorDomain` -1001, or a CFNetwork -1001
    /// wrapped as the underlying error.  Cancellation and other transport codes are not timeouts.
    static func isTransportTimeout(_ error: Error) -> Bool {
        if error is CancellationError { return false }
        if let urlError = error as? URLError {
            return urlError.code == .timedOut
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
            return true
        }
        guard let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError else {
            return false
        }
        if underlying.domain == NSURLErrorDomain && underlying.code == NSURLErrorTimedOut {
            return true
        }
        return underlying.domain == String(kCFErrorDomainCFNetwork)
            && underlying.code == NSURLErrorTimedOut
    }

    static func shouldRetry(
        error: Error,
        method: String?,
        attemptIndex: Int,
        maxRetries: Int = MobileAPITransportTimeoutRetry.maxRetries
    ) -> Bool {
        guard attemptIndex >= 0, attemptIndex < maxRetries else { return false }
        guard isIdempotentRead(method: method) else { return false }
        return isTransportTimeout(error)
    }

    /// Short GETs retry twice.  A 45s snapshot or a 50s scan retries once, so a
    /// persistent timeout cannot stack three full waits.
    static func maxRetries(forTimeout timeout: TimeInterval) -> Int {
        if timeout >= singleRetryTimeout {
            return 1
        }
        return maxRetries
    }

    /// 300ms, then 600ms.  Matches the existing GET backoff and stays under one second.
    static func backoffNanoseconds(attemptIndex: Int) -> UInt64 {
        let bounded = min(max(attemptIndex, 0), 1)
        let multiplier = 1 << (bounded + 1)
        return UInt64(150_000_000 * multiplier)
    }
}
