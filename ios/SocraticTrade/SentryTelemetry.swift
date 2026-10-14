import Foundation
import Sentry

/// Native Sentry telemetry and crash reporting for Socratic Trade iOS.
///
/// DSN is read only from Info.plist (`SENTRY_DSN`). There is no hardcoded
/// fallback — missing or empty skips init so a leaked default cannot be
/// pointed at the wrong project.
///
/// Features enabled under the sponsored tier:
/// - Native crash reporting (SIGSEGV, uncaught exceptions, OOM)
/// - UI freeze / App hang detection (>2.0s main thread hang)
/// - HTTP 5xx client request failure capture
/// - Distributed tracing (0.2 sample rate)
/// - Session Replay with aggressive masking (all text, all images, no screenshots)
/// - Release health via CFBundleShortVersionString / CFBundleVersion
enum SentryTelemetry {
    private static var started = false

    static func start() {
        guard !SocraticTradeApp.isScreenshotMode else { return }

        guard let dsn = plistString("SENTRY_DSN"), !dsn.isEmpty else { return }

        let version = plistString("CFBundleShortVersionString")
        let dist = plistString("CFBundleVersion")

        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = "production"
            if let version, !version.isEmpty {
                if let dist, !dist.isEmpty {
                    options.releaseName = "com.socratictrade.ios@\(version)+\(dist)"
                } else {
                    options.releaseName = "com.socratictrade.ios@\(version)"
                }
            }
            if let dist, !dist.isEmpty {
                options.dist = dist
            }
            options.tracesSampleRate = 0.2
            // sentry-cocoa 9 removed transaction-based profilesSampleRate.
            options.configureProfiling = {
                $0.sessionSampleRate = 0.1
                $0.lifecycle = .trace
            }
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0.01
            options.sessionReplay.onErrorSampleRate = 1.0
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            started = true
            options.beforeSend = { event in
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in ["symbol", "proposal", "account", "token", "key", "secret"] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }

    /// URLSession failures.  Tags the URLError code and the API path (no query, no host).
    /// No-ops until `start()` has a real DSN, and skips cancellation.
    static func captureAPIFailure(error: Error, endpoint: String) {
        guard started else { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        let ns = error as NSError
        guard error is URLError || ns.domain == NSURLErrorDomain else { return }
        let code = String((error as? URLError)?.code.rawValue ?? ns.code)
        let path = sanitizedEndpoint(endpoint)
        SentrySDK.capture(error: error) { scope in
            scope.setTag(value: code, key: "url_error_code")
            scope.setExtra(value: path, key: "endpoint")
            scope.setFingerprint(["mobile-api", path, code])
        }
    }

    /// Path only.  Query strings can carry symbols and one-time auth codes.
    static func sanitizedEndpoint(_ raw: String) -> String {
        let withoutQuery = raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? raw
        if let url = URL(string: withoutQuery), let path = url.path.isEmpty ? nil : url.path {
            return path
        }
        if withoutQuery.hasPrefix("/") { return withoutQuery }
        return withoutQuery
    }

    /// Info.plist string, treating unsubstituted `$(VAR)` build settings as missing.
    private static func plistString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasPrefix("$(") { return nil }
        return trimmed
    }
}
