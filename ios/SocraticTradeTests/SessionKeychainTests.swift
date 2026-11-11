import XCTest
@testable import SocraticTrade

final class SessionKeychainTests: XCTestCase {
    func testAuthSessionCookieNameRecognition() {
        XCTAssertTrue(AuthSessionCookie.isSessionCookieName("__Secure-authjs.session-token"))
        XCTAssertTrue(AuthSessionCookie.isSessionCookieName("authjs.session-token"))
        XCTAssertTrue(AuthSessionCookie.isSessionCookieName("__Secure-authjs.session-token.0"))
        XCTAssertTrue(AuthSessionCookie.isSessionCookieName("__Secure-authjs.session-token.3"))
        XCTAssertFalse(AuthSessionCookie.isSessionCookieName("st-account-scope-test"))
        XCTAssertFalse(AuthSessionCookie.isSessionCookieName("__Secure-authjs.session-token.chunk"))
    }

    func testArchivePreservesPastExpiryAndSkipsOnApply() throws {
        let past = Date(timeIntervalSince1970: 1_600_000_000)
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .originURL: origin,
            .domain: "socratictrade.com",
            .path: "/",
            .name: "__Secure-authjs.session-token",
            .value: "stale",
            .secure: "TRUE",
            .expires: past,
            .version: "0",
        ]))
        let archive = SessionCookieArchive(cookie: cookie, owningHost: "socratictrade.com")
        XCTAssertEqual(archive.expiresAt, past)
        let storage = HTTPCookieStorage()
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let applied = SessionCookiePersistence.apply(
            [archive],
            to: storage,
            owningHost: "socratictrade.com",
            now: now
        )
        XCTAssertEqual(applied, 0)
    }

    func testHostOnlyCookieStaysHostOnlyAfterArchiveRoundTrip() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try makeHostOnlyCookie(name: "__Secure-authjs.session-token", value: "tok")
        let archive = SessionCookieArchive(cookie: cookie, owningHost: "socratictrade.com")
        XCTAssertTrue(archive.hostOnly)
        let restored = try XCTUnwrap(archive.makeHTTPCookie(origin: origin))
        XCTAssertTrue(restored.isSecure)
        XCTAssertFalse(restored.domain.hasPrefix("."))

        let storage = HTTPCookieStorage()
        XCTAssertEqual(
            SessionCookiePersistence.apply([archive], to: storage, owningHost: "socratictrade.com"),
            1
        )
        XCTAssertEqual(
            SessionCookiePersistence.authSessionCookies(in: storage, owningHost: "socratictrade.com").count,
            1
        )
    }

    func testForeignDomainCookieStaysForeignAfterArchiveRoundTrip() throws {
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "evil.example",
            .path: "/",
            .name: "__Secure-authjs.session-token",
            .value: "foreign",
            .secure: "TRUE",
            .version: "0",
        ]))
        let archive = SessionCookieArchive(cookie: cookie, owningHost: "socratictrade.com")
        XCTAssertFalse(archive.hostOnly)
        XCTAssertEqual(archive.domain, "evil.example")

        let appOrigin = URL(string: "https://socratictrade.com/")!
        let restored = try XCTUnwrap(archive.makeHTTPCookie(origin: appOrigin))
        XCTAssertEqual(restored.properties?[.domain] as? String, ".evil.example")
        XCTAssertNil(restored.properties?[.originURL])

        let storage = HTTPCookieStorage()
        XCTAssertEqual(
            SessionCookiePersistence.apply([archive], to: storage, owningHost: "socratictrade.com"),
            1
        )
        XCTAssertTrue(
            SessionCookiePersistence.authSessionCookies(in: storage, owningHost: "socratictrade.com").isEmpty
        )
    }

    func testDomainScopedCookieStaysDomainScopedAfterArchiveRoundTrip() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try makeDomainScopedCookie(name: "__Secure-authjs.session-token.0", value: "chunk")
        let archive = SessionCookieArchive(cookie: cookie, owningHost: "socratictrade.com")
        XCTAssertFalse(archive.hostOnly)
        let restored = try XCTUnwrap(archive.makeHTTPCookie(origin: origin))
        let domainAttribute = restored.properties?[.domain] as? String
        XCTAssertEqual(domainAttribute, ".socratictrade.com")

        let storage = HTTPCookieStorage()
        XCTAssertEqual(
            SessionCookiePersistence.apply([archive], to: storage, owningHost: "socratictrade.com"),
            1
        )
        XCTAssertEqual(
            SessionCookiePersistence.authSessionCookies(in: storage, owningHost: "socratictrade.com").count,
            1
        )
    }

    func testApplyRestoresSecureAuthArchiveInJar() throws {
        let storage = HTTPCookieStorage()
        let archive = SessionCookieArchive(
            cookie: try makeCookie(name: "__Secure-authjs.session-token", value: "tok"),
            owningHost: "socratictrade.com"
        )
        XCTAssertEqual(
            SessionCookiePersistence.apply([archive], to: storage, owningHost: "socratictrade.com"),
            1
        )
        XCTAssertEqual(
            SessionCookiePersistence.authSessionCookies(in: storage, owningHost: "socratictrade.com").count,
            1
        )
    }

    func testMakeHTTPCookieOmitsInvalidSameSiteValue() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        let archive = SessionCookieArchive(
            name: "__Secure-authjs.session-token",
            value: "token",
            domain: "socratictrade.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "TotallyInvalid",
            expiresAt: nil
        )
        let cookie = try XCTUnwrap(archive.makeHTTPCookie(origin: origin))
        XCTAssertEqual(cookie.value, "token")
        XCTAssertNil(cookie.properties?[.sameSitePolicy])
    }

    func testMakeHTTPCookiePreservesDelimiterCharactersInValue() throws {
        let trickyValue = "a;b,c=d;e=f"
        let origin = URL(string: "https://socratictrade.com/")!
        let archive = SessionCookieArchive(
            name: "__Secure-authjs.session-token",
            value: trickyValue,
            domain: "socratictrade.com",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            expiresAt: nil
        )
        let cookie = try XCTUnwrap(archive.makeHTTPCookie(origin: origin))
        XCTAssertEqual(cookie.value, trickyValue)
        XCTAssertEqual(cookie.name, archive.name)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
    }

    func testHttpOnlyRoundTripsThroughArchive() throws {
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try makeHostOnlyCookie(name: "__Secure-authjs.session-token", value: "secret")
        let archive = SessionCookieArchive(cookie: cookie)
        XCTAssertTrue(archive.httpOnly)
        let restored = try XCTUnwrap(archive.makeHTTPCookie(origin: origin))
        XCTAssertTrue(restored.isHTTPOnly)
    }

    func testApplySkipsExpiredArchives() throws {
        let storage = HTTPCookieStorage()
        let past = Date(timeIntervalSince1970: 1_600_000_000)
        let archive = SessionCookieArchive(
            name: "__Secure-authjs.session-token",
            value: "stale",
            domain: "socratictrade.com",
            path: "/",
            secure: true,
            httpOnly: true,
            expiresAt: past
        )
        let applied = SessionCookiePersistence.apply(
            [archive],
            to: storage,
            owningHost: "socratictrade.com",
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        XCTAssertEqual(applied, 0)
        XCTAssertTrue(
            SessionCookiePersistence.authSessionCookies(in: storage, owningHost: "socratictrade.com").isEmpty
        )
    }

    func testInMemoryStoreSaveLoadDeleteRoundTrip() throws {
        let store = InMemorySessionCredentialStore()
        let archives = [
            SessionCookieArchive(cookie: try makeCookie(name: "__Secure-authjs.session-token", value: "alpha")),
            SessionCookieArchive(cookie: try makeCookie(name: "__Secure-authjs.session-token.0", value: "beta")),
        ]
        try store.save(cookies: archives)
        let loaded = try XCTUnwrap(try store.load())
        XCTAssertEqual(loaded, archives)
        try store.delete()
        XCTAssertNil(try store.load())
    }

    func testCoordinatorPersistAndRestore() throws {
        let credentialStore = InMemorySessionCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let storage = client.sessionCookieJar
        let cookie = try makeCookie(name: "__Secure-authjs.session-token", value: "restored-value")
        installInJar(cookie, storage: storage)

        try coordinator.persistSession(from: client)
        storage.deleteCookie(cookie)
        XCTAssertTrue(SessionCookiePersistence.authSessionCookies(in: storage, owningHost: client.baseURL.host).isEmpty)

        try coordinator.prepareClientSession(client)
        let restored = SessionCookiePersistence.authSessionCookies(in: storage, owningHost: client.baseURL.host)
        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(restored[0].name, cookie.name)
        XCTAssertEqual(restored[0].value, cookie.value)
    }

    func testMigrationCopiesLegacySharedJarOnce() throws {
        let credentialStore = InMemorySessionCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let client = MobileAPIClient(
            baseURL: URL(string: "https://socratictrade.com")!,
            session: MobileAPIClient.makeURLSession()
        )
        let isolated = client.sessionCookieJar
        let legacyCookie = try makeCookie(name: "__Secure-authjs.session-token", value: "legacy")
        installInJar(legacyCookie, storage: HTTPCookieStorage.shared)

        try coordinator.prepareClientSession(client)

        let migrated = SessionCookiePersistence.authSessionCookies(in: isolated, owningHost: client.baseURL.host)
        XCTAssertEqual(migrated.count, 1)
        XCTAssertEqual(try XCTUnwrap(try credentialStore.load()).count, 1)
        XCTAssertTrue(
            SessionCookiePersistence.authSessionCookies(
                in: HTTPCookieStorage.shared,
                owningHost: client.baseURL.host
            ).isEmpty
        )

        HTTPCookieStorage.shared.deleteCookie(legacyCookie)
        try coordinator.clearSession(from: client)
    }

    func testClearSessionRemovesKeychainAndJar() throws {
        let credentialStore = InMemorySessionCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let storage = client.sessionCookieJar
        installInJar(try makeCookie(name: "authjs.session-token", value: "gone"), storage: storage)
        try coordinator.persistSession(from: client)
        try coordinator.clearSession(from: client)
        XCTAssertNil(try credentialStore.load())
        XCTAssertTrue(SessionCookiePersistence.authSessionCookies(in: storage, owningHost: client.baseURL.host).isEmpty)
    }

    private func installInJar(
        _ cookie: HTTPCookie,
        storage: HTTPCookieStorage,
        host: String = "socratictrade.com"
    ) {
        let origin = URL(string: "https://\(host)/")!
        storage.setCookies([cookie], for: origin, mainDocumentURL: nil)
    }

    private func makeCookie(name: String, value: String) throws -> HTTPCookie {
        try makeHostOnlyCookie(name: name, value: value)
    }

    private func makeHostOnlyCookie(name: String, value: String) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .originURL: URL(string: "https://socratictrade.com/")!,
            .domain: "socratictrade.com",
            .path: "/",
            .name: name,
            .value: value,
            .secure: "TRUE",
            .version: "0",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]))
    }

    private func makeDomainScopedCookie(name: String, value: String) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .domain: ".socratictrade.com",
            .path: "/",
            .name: name,
            .value: value,
            .secure: "TRUE",
            .version: "0",
        ]))
    }
}
