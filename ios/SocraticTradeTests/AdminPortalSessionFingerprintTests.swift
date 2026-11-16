import XCTest
import CryptoKit
@testable import SocraticTrade

final class AdminPortalSessionFingerprintTests: XCTestCase {
    func testSessionCookieFingerprintUsesSHA256NotRawValue() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try XCTUnwrap(
            HTTPCookie.cookies(
                withResponseHeaderFields: [
                    "Set-Cookie": "session=secret-token; Path=/; Secure",
                ],
                for: origin
            ).first
        )
        let fingerprint = AdminPortalWebView.sessionCookieFingerprint([cookie])
        XCTAssertFalse(fingerprint.contains("secret-token"))
        let expectedHash = SHA256.hash(data: Data("secret-token".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertTrue(fingerprint.contains(expectedHash))
    }

    func testSessionCookieFingerprintChangesWhenValueChanges() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        func cookie(value: String) throws -> HTTPCookie {
            try XCTUnwrap(
                HTTPCookie.cookies(
                    withResponseHeaderFields: [
                        "Set-Cookie": "session=\(value); Path=/; Secure",
                    ],
                    for: origin
                ).first
            )
        }
        let first = AdminPortalWebView.sessionCookieFingerprint([try cookie(value: "a")])
        let second = AdminPortalWebView.sessionCookieFingerprint([try cookie(value: "b")])
        XCTAssertNotEqual(first, second)
    }
}
