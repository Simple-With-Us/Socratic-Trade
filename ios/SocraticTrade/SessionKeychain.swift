import Foundation
import Security

// MARK: - Session cookie naming (mirrors src/lib/auth/session-cookie-names.ts)

enum AuthSessionCookie {
    static let knownBaseNames: [String] = [
        "__Secure-authjs.session-token",
        "authjs.session-token",
        "__Secure-next-auth.session-token",
        "next-auth.session-token",
    ]

    static func isSessionCookieName(_ name: String) -> Bool {
        for base in knownBaseNames {
            if name == base { return true }
            let prefix = "\(base)."
            guard name.hasPrefix(prefix) else { continue }
            let suffix = String(name.dropFirst(prefix.count))
            guard !suffix.isEmpty, suffix.allSatisfy(\.isNumber) else { continue }
            return true
        }
        return false
    }
}

// MARK: - Cookie archive (never log values)

struct SessionCookieArchive: Codable, Equatable, Sendable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let secure: Bool
    let expiresAt: Date?

    init(cookie: HTTPCookie) {
        name = cookie.name
        value = cookie.value
        domain = cookie.domain
        path = cookie.path
        secure = cookie.isSecure
        if let date = cookie.expiresDate, date.timeIntervalSince1970 > 0 {
            expiresAt = date
        } else {
            expiresAt = nil
        }
    }

    func makeHTTPCookie() -> HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]
        if secure {
            properties[.secure] = "TRUE"
        }
        if let expiresAt {
            properties[.expires] = expiresAt
        }
        return HTTPCookie(properties: properties)
    }
}

// MARK: - Storage protocol (Keychain in production, in-memory in tests)

protocol SessionCredentialStoring: Sendable {
    func save(cookies: [SessionCookieArchive]) throws
    func load() throws -> [SessionCookieArchive]?
    func delete() throws
}

enum SessionCredentialStoreError: Error, Equatable {
    case encodingFailed
    case keychainUnexpectedStatus(OSStatus)
}

// MARK: - Keychain

struct KeychainSessionStore: SessionCredentialStoring {
    let service: String
    let account: String

  init(
        service: String = Bundle.main.bundleIdentifier ?? "com.socratictrade.ios",
        account: String = "auth-session-cookies"
    ) {
        self.service = service
        self.account = account
    }

    func save(cookies: [SessionCookieArchive]) throws {
        let data = try encode(cookies)
        try delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(status)
        }
    }

    func load() throws -> [SessionCookieArchive]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(status)
        }
        return try decode(data)
    }

    func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(status)
        }
    }

    private func encode(_ cookies: [SessionCookieArchive]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(cookies) else {
            throw SessionCredentialStoreError.encodingFailed
        }
        return data
    }

    private func decode(_ data: Data) throws -> [SessionCookieArchive] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([SessionCookieArchive].self, from: data)
    }
}

/// XCTest fake — no Keychain access required.
final class InMemorySessionCredentialStore: SessionCredentialStoring, @unchecked Sendable {
    private var stored: [SessionCookieArchive]?

    func save(cookies: [SessionCookieArchive]) throws {
        stored = cookies
    }

    func load() throws -> [SessionCookieArchive]? {
        stored
    }

    func delete() throws {
        stored = nil
    }
}

// MARK: - URLSession cookie helpers

enum SessionCookiePersistence {
    static func authSessionCookies(
        in storage: HTTPCookieStorage,
        owningHost host: String?
    ) -> [HTTPCookie] {
        guard let host else { return [] }
        return (storage.cookies ?? []).filter { cookie in
            ownsDomain(cookie.domain, host: host) && AuthSessionCookie.isSessionCookieName(cookie.name)
        }
    }

    static func ownsDomain(_ cookieDomain: String, host: String) -> Bool {
        let domain = cookieDomain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        let normalizedHost = host.lowercased()
        return normalizedHost == domain || normalizedHost.hasSuffix(".\(domain)")
    }

    static func apply(
        _ archives: [SessionCookieArchive],
        to storage: HTTPCookieStorage,
        owningHost host: String?
    ) {
        clearAuthSessionCookies(in: storage, owningHost: host)
        for archive in archives {
            guard let cookie = archive.makeHTTPCookie() else { continue }
            storage.setCookie(cookie)
        }
    }

    static func clearAuthSessionCookies(in storage: HTTPCookieStorage, owningHost host: String?) {
        for cookie in authSessionCookies(in: storage, owningHost: host) {
            storage.deleteCookie(cookie)
        }
    }

    /// One-time migration from the old `URLSession.shared` persistent jar.
    static func migrateFromLegacySharedStorageIfNeeded(
        into storage: HTTPCookieStorage,
        owningHost host: String?,
        credentialStore: SessionCredentialStoring
    ) throws {
        guard (try credentialStore.load()) == nil else { return }
        let legacy = authSessionCookies(in: HTTPCookieStorage.shared, owningHost: host)
        guard !legacy.isEmpty else { return }
        let archives = legacy.map(SessionCookieArchive.init(cookie:))
        try credentialStore.save(cookies: archives)
        apply(archives, to: storage, owningHost: host)
        clearAuthSessionCookies(in: HTTPCookieStorage.shared, owningHost: host)
    }
}

struct SessionCookieCoordinator {
    let credentialStore: SessionCredentialStoring

    init(credentialStore: SessionCredentialStoring = KeychainSessionStore()) {
        self.credentialStore = credentialStore
    }

    func prepareClientSession(_ client: MobileAPIClient) throws {
        let storage = cookieStorage(for: client)
        if let archives = try credentialStore.load(), !archives.isEmpty {
            SessionCookiePersistence.apply(
                archives,
                to: storage,
                owningHost: client.baseURL.host
            )
        }
        try SessionCookiePersistence.migrateFromLegacySharedStorageIfNeeded(
            into: storage,
            owningHost: client.baseURL.host,
            credentialStore: credentialStore
        )
    }

    func persistSession(from client: MobileAPIClient) throws {
        let storage = cookieStorage(for: client)
        let cookies = SessionCookiePersistence.authSessionCookies(
            in: storage,
            owningHost: client.baseURL.host
        )
        guard !cookies.isEmpty else {
            try credentialStore.delete()
            return
        }
        try credentialStore.save(cookies: cookies.map(SessionCookieArchive.init(cookie:)))
    }

    func clearSession(from client: MobileAPIClient) throws {
        let storage = cookieStorage(for: client)
        SessionCookiePersistence.clearAuthSessionCookies(
            in: storage,
            owningHost: client.baseURL.host
        )
        SessionCookiePersistence.clearAuthSessionCookies(
            in: HTTPCookieStorage.shared,
            owningHost: client.baseURL.host
        )
        try credentialStore.delete()
    }

    func sessionCookies(for client: MobileAPIClient) -> [HTTPCookie] {
        SessionCookiePersistence.authSessionCookies(
            in: cookieStorage(for: client),
            owningHost: client.baseURL.host
        )
    }

    private func cookieStorage(for client: MobileAPIClient) -> HTTPCookieStorage {
        client.session.configuration.httpCookieStorage ?? HTTPCookieStorage.shared
    }
}
