import CryptoKit
import Foundation

/// Shared checks for the ST-2599 mobile session contract.
enum MobileAuthNonce {
    /// Server legacy marker. New clients never send it.
    static let legacyCompat = "__legacy_compat__"

    static func isServerIssued(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != legacyCompat
    }
}

/// Copy shown when a strict sign-in cannot start. A failure here does not fall through
/// to a nonce-less request.
enum MobileAuthStartFailure {
    static let appleNonceUnavailable =
        "Apple sign-in could not start.\u{00A0} Check your connection, then try again."
    static let handoffUnavailable =
        "Could not securely start web sign-in.\u{00A0} Try again."
}

/// Value Apple copies into the identity token `nonce` claim.
///
/// Apple does not hash `ASAuthorizationAppleIDRequest.nonce` again. The server issued a
/// raw nonce, stores that raw value, and accepts the identity-token claim when it is the
/// SHA-256 hex of that value. The POST body still carries the raw nonce so the server can
/// consume the row it issued.
enum AppleSignInNonce {
    static func authorizationRequestNonce(serverNonce: String) -> String {
        sha256Hex(serverNonce)
    }

    static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// OAuth start URL for Google and GitHub. The callback carries the PKCE challenge and the
/// nonce from `POST /api/mobile/auth/handoff-prepare`. A legacy nonce is refused here so
/// the app cannot build that URL by accident.
enum MobileWebAuthStart {
    static func callbackURL(baseURL: URL, codeChallenge: String, handoffNonce: String) -> URL? {
        guard MobileAuthNonce.isServerIssued(handoffNonce) else { return nil }
        guard var components = URLComponents(
            url: baseURL.appending(path: "/api/mobile/auth-redirect"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "handoff_nonce", value: handoffNonce)
        ]
        return components.url
    }

    static func startURL(baseURL: URL, provider: String, callbackURL: URL) -> URL? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "/api/mobile/auth-start"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "callbackUrl", value: callbackURL.absoluteString)
        ]
        return components.url
    }
}

/// What the owner sees when push registration is refused because another account still
/// owns this device. Registration of that same token stops until a successful unregister
/// or a later successful register clears the hold.
enum PushRegistrationPolicy {
    static let conflictMessage =
        "This phone is still registered to another account.\u{00A0} Sign out of that account, then try alerts again."
}

struct PushRegistrationGate: Equatable {
    private(set) var conflictedToken: String?

    func shouldSend(token: String) -> Bool {
        conflictedToken != token
    }

    mutating func observe(token: String, error: MobileAPIError) {
        if case .deviceTokenConflict = error {
            conflictedToken = token
        }
    }

    mutating func observeSuccess() {
        conflictedToken = nil
    }
}
