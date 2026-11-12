import Foundation
import Security

// MARK: - Session cookie naming (mirrors src/lib/auth/session-cookie-names.ts)

private enum CookieDomain {
    /// Resolves the registrable host for a cookie (Foundation sometimes exposes only the public suffix in `cookie.domain`).
    static func effective(_ cookie: HTTPCookie, owningHost: String? = nil) -> String {
        let domainAttribute = cookie.properties?[.domain] as? String
        let originHost = originHost(from: cookie)
        let normalizedHost = normalizedLabel(owningHost)

        func push(_ raw: String?, into candidates: inout [String]) {
            guard let raw, let label = normalizedLabel(raw), !label.isEmpty else { return }
            if !candidates.contains(label) {
                candidates.append(label)
            }
        }

        var candidates: [String] = []
        push(domainAttribute, into: &candidates)
        push(originHost, into: &candidates)
        push(owningHost, into: &candidates)

        let cookieDomain = normalizedLabel(cookie.domain)
        if let cookieDomain, !cookieDomain.isEmpty {
            if cookieDomain.contains(".") {
                push(cookie.domain, into: &candidates)
            } else if cookieDomain == normalizedHost {
                push(cookie.domain, into: &candidates)
            }
        }

        if let registrable = candidates.first(where: { $0.contains(".") }) {
            return registrable
        }
        if let normalizedHost, candidates.contains(normalizedHost) {
            return normalizedHost
        }
        if let originHost, originHost.contains("."), let normalizedHost, originHost == normalizedHost {
            return originHost
        }
        let fallback = candidates.first ?? cookieDomain ?? ""
        if fallback.contains(".") { return fallback }
        if let normalizedHost, fallback == normalizedHost { return fallback }
        return ""
    }

    private static func normalizedLabel(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func originHost(from cookie: HTTPCookie) -> String? {
        if let url = cookie.properties?[.originURL] as? URL {
            return url.host
        }
        if let raw = cookie.properties?[.originURL] as? String {
            return URL(string: raw)?.host
        }
        return nil
    }
}

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
    /// HTTPS origin host recorded at archive time; used when `domain` is empty so restore never widens across hosts.
    let recordedOriginHost: String?
    let expiresAt: Date?

    init(cookie: HTTPCookie, owningHost: String? = nil) {
        name = cookie.name
        value = cookie.value
        hostOnly = Self.inferHostOnly(cookie: cookie, owningHost: owningHost)
        domain = CookieDomain.effective(cookie, owningHost: owningHost)
        recordedOriginHost = Self.recordedOriginHost(from: cookie, owningHost: owningHost, hostOnly: hostOnly)
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
        recordedOriginHost: String? = nil,
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
        self.recordedOriginHost = recordedOriginHost
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case name, value, domain, path, secure, httpOnly, sameSite, hostOnly, recordedOriginHost, expiresAt
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
        recordedOriginHost = try container.decodeIfPresent(String.self, forKey: .recordedOriginHost)
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
            guard let origin, let originHost = origin.host?.lowercased(), !originHost.isEmpty else {
                return nil
            }
            properties[.originURL] = origin
            properties[.domain] = originHost
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

    private static func recordedOriginHost(
        from cookie: HTTPCookie,
        owningHost: String?,
        hostOnly: Bool
    ) -> String? {
        guard hostOnly else { return nil }
        if let url = cookie.properties?[.originURL] as? URL {
            return url.host?.lowercased()
        }
        if let raw = cookie.properties?[.originURL] as? String {
            return URL(string: raw)?.host?.lowercased()
        }
        return owningHost?.lowercased()
    }

    /// Host-only when the cookie's domain exactly matches `owningHost` (no leading-dot `Domain` attribute).
    private static func inferHostOnly(cookie: HTTPCookie, owningHost: String?) -> Bool {
        guard let host = owningHost?.lowercased() else { return false }
        if let domainAttribute = cookie.properties?[.domain] as? String, domainAttribute.hasPrefix(".") {
            return false
        }
        let normalized = CookieDomain.effective(cookie, owningHost: owningHost)
        guard !normalized.isEmpty else { return false }
        return normalized == host
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
    case decodingFailed
    case keychainUnexpectedStatus(OSStatus)

    var isTransientKeychainFailure: Bool {
        guard case .keychainUnexpectedStatus(let status) = self else { return false }
        return status == errSecInteractionNotAllowed || status == errSecUserCanceled
    }

    var shouldDeletePersistedCredentialsOnRestoreFailure: Bool {
        switch self {
        case .encodingFailed, .decodingFailed:
            return true
        case .keychainUnexpectedStatus:
            return false
        }
    }
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
        do {
            return try decoder.decode([SessionCookieArchive].self, from: data)
        } catch {
            throw SessionCredentialStoreError.decodingFailed
        }
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

/// Private in-memory jar; each instance is isolated from other clients and from `HTTPCookieStorage.shared`.
final class IsolatedInMemoryHTTPCookieStorage: HTTPCookieStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [HTTPCookie] = []

    override init() {
        super.init()
        cookieAcceptPolicy = .always
    }

    override var cookies: [HTTPCookie]? {
        lock.lock()
        defer { lock.unlock() }
        purgeExpiredLocked(at: Date())
        return stored
    }

    override func setCookie(_ cookie: HTTPCookie) {
        lock.lock()
        defer { lock.unlock() }
        removeMatchingLocked(cookie)
        guard !Self.isLiveCookieExpired(cookie) else { return }
        stored.append(cookie)
    }

    override func deleteCookie(_ cookie: HTTPCookie) {
        lock.lock()
        defer { lock.unlock() }
        removeMatchingLocked(cookie)
    }

    override func setCookies(_ cookies: [HTTPCookie], for url: URL?, mainDocumentURL: URL?) {
        // Each HTTPCookie carries its own domain, so a nil URL only means there is
        // no request host to default a missing domain from; keep every cookie
        // that names its domain instead of dropping the whole batch.
        for cookie in cookies where url != nil || !cookie.domain.isEmpty {
            setCookie(cookie)
        }
    }

    override func storeCookies(_ cookies: [HTTPCookie], for task: URLSessionTask) {
        for cookie in cookies {
            setCookie(cookie)
        }
    }

    override func getCookiesFor(_ task: URLSessionTask, completionHandler: @escaping ([HTTPCookie]?) -> Void) {
        // Never fall back to the whole jar: with no URL to match, return nothing
        // rather than cookies for unrelated hosts.
        let url = task.currentRequest?.url ?? task.originalRequest?.url ?? task.response?.url
        completionHandler(url.map { cookies(for: $0) ?? [] } ?? [])
    }

    override func cookies(for url: URL?) -> [HTTPCookie]? {
        guard let url else { return [] }
        lock.lock()
        defer { lock.unlock() }
        purgeExpiredLocked(at: Date())
        return stored.filter { cookieMatches($0, for: url) && !Self.isLiveCookieExpired($0) }
    }

    static func isLiveCookieExpired(_ cookie: HTTPCookie, at date: Date = Date()) -> Bool {
        guard let expires = cookie.expiresDate, expires.timeIntervalSince1970 > 0 else { return false }
        return expires <= date
    }

    private func removeMatchingLocked(_ cookie: HTTPCookie) {
        stored.removeAll { existing in
            existing.name == cookie.name
                && existing.domain == cookie.domain
                && existing.path == cookie.path
        }
    }

    private func purgeExpiredLocked(at date: Date) {
        stored.removeAll { Self.isLiveCookieExpired($0, at: date) }
    }

    private func cookieMatches(_ cookie: HTTPCookie, for url: URL) -> Bool {
        if Self.isLiveCookieExpired(cookie) { return false }
        guard let host = url.host?.lowercased() else { return false }
        let requestPath = url.path.isEmpty ? "/" : url.path
        let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
        guard requestPath.hasPrefix(cookiePath) else { return false }
        if cookiePath.count > 1, requestPath.count > cookiePath.count {
            let index = requestPath.index(requestPath.startIndex, offsetBy: cookiePath.count)
            guard requestPath[index] == "/" else { return false }
        }
        if cookie.isSecure, url.scheme?.lowercased() != "https" {
            return false
        }
        let domain = cookie.domain.lowercased()
        if domain.hasPrefix(".") {
            let base = String(domain.dropFirst())
            return host == base || host.hasSuffix(".\(base)")
        }
        return host == domain
    }
}

enum SessionCookiePersistence {
    /// A bare `HTTPCookieStorage()` has no backing store and silently drops writes.
    /// Never use the persistent shared jar or `URLSessionConfiguration.ephemeral.httpCookieStorage` (nil on some platforms).
    static func makeInMemoryCookieStorage() -> HTTPCookieStorage {
        IsolatedInMemoryHTTPCookieStorage()
    }

    private static func ensureAlwaysAcceptsCookies(in storage: HTTPCookieStorage) {
        guard storage !== HTTPCookieStorage.shared else { return }
        guard storage.cookieAcceptPolicy != .always else { return }
        storage.cookieAcceptPolicy = .always
    }

    static func authSessionCookies(
        in storage: HTTPCookieStorage,
        owningHost host: String?
    ) -> [HTTPCookie] {
        guard let host, !host.isEmpty else { return [] }
        ensureAlwaysAcceptsCookies(in: storage)

        let origin = URL(string: "https://\(host)/")
        let originScoped = origin.map { storage.cookies(for: $0) ?? [] } ?? []
        var seenKeys = Set<String>()
        var matched: [HTTPCookie] = []

        func cookieKey(_ cookie: HTTPCookie) -> String {
            let domainKey = CookieDomain.effective(cookie, owningHost: host)
            return "\(cookie.name)|\(domainKey)|\(cookie.path)"
        }

        func consider(_ cookie: HTTPCookie) {
            guard AuthSessionCookie.isSessionCookieName(cookie.name) else { return }
            if IsolatedInMemoryHTTPCookieStorage.isLiveCookieExpired(cookie) {
                storage.deleteCookie(cookie)
                return
            }
            guard ownsDomain(cookie, host: host) else { return }
            let key = cookieKey(cookie)
            guard seenKeys.insert(key).inserted else { return }
            matched.append(cookie)
        }

        for cookie in originScoped {
            consider(cookie)
        }
        for cookie in storage.cookies ?? [] {
            consider(cookie)
        }
        return matched
    }

    static func ownsDomain(_ cookie: HTTPCookie, host: String) -> Bool {
        let domain = CookieDomain.effective(cookie, owningHost: host)
        return ownsDomain(domain, host: host, originURL: originURL(from: cookie.properties?[.originURL]))
    }

    private static func archiveBelongsToHost(_ archive: SessionCookieArchive, host: String) -> Bool {
        let normalizedHost = host
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        if archive.hostOnly {
            let archivedDomain = archive.domain
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                .lowercased()
            if archivedDomain.isEmpty {
                guard let recorded = archive.recordedOriginHost?
                    .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                    .lowercased(),
                    !recorded.isEmpty
                else { return false }
                return recorded == normalizedHost
            }
            return archivedDomain == normalizedHost
        }
        return ownsDomain(archive.domain, host: host)
    }

    private static func originURL(from property: Any?) -> URL? {
        if let url = property as? URL {
            return url
        }
        if let raw = property as? String {
            return URL(string: raw)
        }
        return nil
    }

    private static func isCookieBoundToHTTPSOrigin(_ cookie: HTTPCookie, host: String) -> Bool {
        let normalizedHost = host
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        guard !normalizedHost.isEmpty else { return false }
        guard let origin = originURL(from: cookie.properties?[.originURL]) else { return false }
        guard origin.scheme?.lowercased() == "https" else { return false }
        let originHost = origin.host?
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return originHost == normalizedHost
    }

    static func ownsDomain(_ cookieDomain: String, host: String, originURL: URL? = nil) -> Bool {
        let normalizedHost = host
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        guard !normalizedHost.isEmpty else { return false }

        let domain = cookieDomain
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        if domain.isEmpty {
            if let originURL {
                let originHost = originURL.host?
                    .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                    .lowercased()
                if originHost == normalizedHost { return true }
            }
            return false
        }

        if normalizedHost == domain { return true }

        // Reject bare public-suffix / TLD labels for broader domain-scoped matches only (e.g. Domain=com vs *socratictrade.com).
        if !domain.contains(".") {
            return false
        }

        return normalizedHost.hasSuffix(".\(domain)")
    }

    static func apply(
        _ archives: [SessionCookieArchive],
        to storage: HTTPCookieStorage,
        owningHost host: String?,
        now: Date = Date()
    ) -> Int {
        guard let host, !host.isEmpty else { return 0 }
        ensureAlwaysAcceptsCookies(in: storage)
        clearAuthSessionCookies(in: storage, owningHost: host)
        let origin = URL(string: "https://\(host)/")
        var applied = 0
        for archive in archives {
            if archive.isExpired(at: now) { continue }
            let cookieOrigin = origin ?? URL(string: "https://\(archive.domain)/")
            guard archiveBelongsToHost(archive, host: host) else { continue }
            guard let cookie = archive.makeHTTPCookie(origin: cookieOrigin) else { continue }
            if archive.hostOnly {
                if let cookieOrigin {
                    storage.setCookies([cookie], for: cookieOrigin, mainDocumentURL: nil)
                }
            } else {
                storage.setCookie(cookie)
            }
            applied += 1
        }
        return applied
    }

    static func clearAuthSessionCookies(in storage: HTTPCookieStorage, owningHost host: String?) {
        ensureAlwaysAcceptsCookies(in: storage)
        for cookie in authSessionCookies(in: storage, owningHost: host) {
            storage.deleteCookie(cookie)
        }
    }

    /// One-time migration from the old `URLSession.shared` persistent jar.
    static func migrateFromLegacySharedStorageIfNeeded(
        into storage: HTTPCookieStorage,
        owningHost host: String?,
        credentialStore: SessionCredentialStoring,
        hasPersistedArchives: Bool
    ) throws {
        guard !hasPersistedArchives else { return }
        let legacy = authSessionCookies(in: HTTPCookieStorage.shared, owningHost: host)
        guard !legacy.isEmpty else { return }
        let archives = legacy.map { SessionCookieArchive(cookie: $0, owningHost: host) }
        try credentialStore.save(cookies: archives)
        apply(archives, to: storage, owningHost: host)
        clearAuthSessionCookies(in: HTTPCookieStorage.shared, owningHost: host)
    }
}

struct SessionCookieCoordinator: Sendable {
    let credentialStore: SessionCredentialStoring

    init(credentialStore: SessionCredentialStoring = KeychainSessionStore()) {
        self.credentialStore = credentialStore
    }

    func prepareClientSession(_ client: MobileAPIClient) throws {
        let storage = cookieStorage(for: client)
        // Read the Keychain once per restore; the migration below reuses this result.
        var hasPersistedArchives = false
        if let archives = try credentialStore.load() {
            hasPersistedArchives = true
            let now = Date()
            if !archives.isEmpty, archives.allSatisfy({ $0.isExpired(at: now) }) {
                try credentialStore.delete()
                hasPersistedArchives = false
            } else if !archives.isEmpty {
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
            credentialStore: credentialStore,
            hasPersistedArchives: hasPersistedArchives
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

    func clearInMemorySession(from client: MobileAPIClient) {
        let storage = cookieStorage(for: client)
        SessionCookiePersistence.clearAuthSessionCookies(
            in: storage,
            owningHost: client.baseURL.host
        )
        SessionCookiePersistence.clearAuthSessionCookies(
            in: HTTPCookieStorage.shared,
            owningHost: client.baseURL.host
        )
    }

    func clearSession(from client: MobileAPIClient) throws {
        clearInMemorySession(from: client)
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
