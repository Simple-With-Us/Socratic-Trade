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
    let httpOnly: Bool
    /// SameSite policy string for `HTTPCookiePropertyKey.sameSitePolicy` (`Lax`, `Strict`, `None`).
    let sameSite: String?
    /// When true, the cookie had no `Domain` attribute (host-only); restore via `.originURL`, not `.domain`.
    let hostOnly: Bool
    let expiresAt: Date?

    init(cookie: HTTPCookie, owningHost: String? = nil) {
        name = cookie.name
        value = cookie.value
        hostOnly = Self.inferHostOnly(cookie: cookie, owningHost: owningHost)
        domain = Self.normalizedDomain(cookie.domain, owningHost: owningHost)
        path = cookie.path.isEmpty ? "/" : cookie.path
        secure = cookie.isSecure || name.hasPrefix("__Secure-") || name.hasPrefix("__Host-")
        httpOnly = cookie.isHTTPOnly
        sameSite = Self.sameSitePolicyString(from: cookie)
        if let date = cookie.expiresDate, date.timeIntervalSince1970 > 0 {
            expiresAt = date
        } else {
            expiresAt = nil
        }
    }

    init(
        name: String,
        value: String,
        domain: String,
        path: String,
        secure: Bool,
        httpOnly: Bool = false,
        sameSite: String? = nil,
        hostOnly: Bool = false,
        expiresAt: Date?
    ) {
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.secure = secure
        self.httpOnly = httpOnly
        self.sameSite = sameSite
        self.hostOnly = hostOnly
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case name, value, domain, path, secure, httpOnly, sameSite, hostOnly, expiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        value = try container.decode(String.self, forKey: .value)
        domain = try container.decode(String.self, forKey: .domain)
        path = try container.decode(String.self, forKey: .path)
        secure = try container.decode(Bool.self, forKey: .secure)
        httpOnly = try container.decodeIfPresent(Bool.self, forKey: .httpOnly) ?? false
        sameSite = try container.decodeIfPresent(String.self, forKey: .sameSite)
        hostOnly = try container.decodeIfPresent(Bool.self, forKey: .hostOnly) ?? false
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
    }

    func isExpired(at date: Date) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= date
    }

    func makeHTTPCookie(origin: URL? = nil) -> HTTPCookie? {
        guard !name.isEmpty, !value.isEmpty else { return nil }
        let pathValue = path.isEmpty ? "/" : path
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .path: pathValue,
            .version: "0",
        ]
        if hostOnly {
            guard let origin else { return nil }
            properties[.originURL] = origin
        } else {
            guard !domain.isEmpty else { return nil }
            let cookieDomain = domain.hasPrefix(".") ? domain : ".\(domain)"
            properties[.domain] = cookieDomain
        }
        if secure {
            properties[.secure] = "TRUE"
        }
        if httpOnly {
            properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE"
        }
        if let expiresAt {
            properties[.expires] = expiresAt
        }
        if let normalizedSameSite = Self.normalizedSameSitePolicy(sameSite) {
            properties[.sameSitePolicy] = normalizedSameSite
        }
        return HTTPCookie(properties: properties)
    }

    private static func sameSitePolicyString(from cookie: HTTPCookie) -> String? {
        normalizedSameSitePolicy(cookie.properties?[.sameSitePolicy] as? String)
    }

    /// Foundation accepts only `Lax`, `Strict`, or `None` for `.sameSitePolicy`; omit on mismatch.
    private static func normalizedSameSitePolicy(_ raw: String?) -> String? {
        guard let raw else { return nil }
        switch raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).lowercased() {
        case "lax":
            return "Lax"
        case "strict":
            return "Strict"
        case "none":
            return "None"
        default:
            return nil
        }
    }

    private static func normalizedDomain(_ cookieDomain: String, owningHost: String?) -> String {
        let trimmed = cookieDomain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        if !trimmed.isEmpty { return trimmed }
        return owningHost?.lowercased() ?? cookieDomain
    }

    /// Host-only cookies omit a leading-dot `Domain` attribute; domain cookies include it in stored properties.
    private static func inferHostOnly(cookie: HTTPCookie, owningHost: String?) -> Bool {
        if cookie.properties?[.originURL] != nil {
            return true
        }
        if let domainAttribute = cookie.properties?[.domain] as? String {
            return !domainAttribute.hasPrefix(".")
        }
        if cookie.domain.hasPrefix(".") {
            return false
        }
        if let host = owningHost?.lowercased() {
            let normalized = cookie.domain
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                .lowercased()
            if normalized == host {
                return true
            }
        }
        return !cookie.domain.hasPrefix(".")
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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(updateStatus)
        }
        var addQuery = query
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(addStatus)
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
        let origin = URL(string: "https://\(host)/")!
        var merged: [String: HTTPCookie] = [:]
        func ingest(_ cookies: [HTTPCookie]) {
            for cookie in cookies {
                let key = "\(cookie.name)|\(cookie.domain)|\(cookie.path)"
                merged[key] = cookie
            }
        }
        ingest(storage.cookies(for: origin) ?? [])
        ingest(storage.cookies ?? [])
        return merged.values.filter { cookie in
            ownsDomain(cookie.domain, host: host) && AuthSessionCookie.isSessionCookieName(cookie.name)
        }
    }

    static func ownsDomain(_ cookieDomain: String, host: String) -> Bool {
        let normalizedHost = host.lowercased()
        let domain = cookieDomain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        if domain.isEmpty {
            return true
        }
        return normalizedHost == domain || normalizedHost.hasSuffix(".\(domain)")
    }

  static func apply(
        _ archives: [SessionCookieArchive],
        to storage: HTTPCookieStorage,
        owningHost host: String?,
        now: Date = Date()
    ) -> Int {
        clearAuthSessionCookies(in: storage, owningHost: host)
        let origin = host.flatMap { URL(string: "https://\($0)/") }
        var applied = 0
        for archive in archives {
            if archive.isExpired(at: now) { continue }
            let cookieOrigin = origin ?? URL(string: "https://\(archive.domain)/")
            guard let cookie = archive.makeHTTPCookie(origin: cookieOrigin) else { continue }
            storage.setCookie(cookie)
            applied += 1
        }
        return applied
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
        let archives = legacy.map { SessionCookieArchive(cookie: $0, owningHost: host) }
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
            let now = Date()
            if archives.allSatisfy({ $0.isExpired(at: now) }) {
                try credentialStore.delete()
            } else {
                _ = SessionCookiePersistence.apply(
                    archives,
                    to: storage,
                    owningHost: client.baseURL.host,
                    now: now
                )
            }
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
        let host = client.baseURL.host
        try credentialStore.save(cookies: cookies.map { SessionCookieArchive(cookie: $0, owningHost: host) })
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
        client.sessionCookieJar
    }
}
