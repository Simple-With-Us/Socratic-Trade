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
        let client = MobileAPIClient(
            baseURL: URL(string: "https://socratictrade.com")!,
            session: MobileAPIClient.makeURLSession()
        )
        let storage = try XCTUnwrap(client.session.configuration.httpCookieStorage)
        let cookie = try makeCookie(name: "__Secure-authjs.session-token", value: "restored-value")
        storage.setCookie(cookie)

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
        let isolated = try XCTUnwrap(client.session.configuration.httpCookieStorage)
        let legacyCookie = try makeCookie(name: "__Secure-authjs.session-token", value: "legacy")
        HTTPCookieStorage.shared.setCookie(legacyCookie)

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
        let client = MobileAPIClient(
            baseURL: URL(string: "https://socratictrade.com")!,
            session: MobileAPIClient.makeURLSession()
        )
        let storage = try XCTUnwrap(client.session.configuration.httpCookieStorage)
        storage.setCookie(try makeCookie(name: "authjs.session-token", value: "gone"))
        try coordinator.persistSession(from: client)
        try coordinator.clearSession(from: client)
        XCTAssertNil(try credentialStore.load())
        XCTAssertTrue(SessionCookiePersistence.authSessionCookies(in: storage, owningHost: client.baseURL.host).isEmpty)
    }

    private func makeCookie(name: String, value: String) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .domain: "socratictrade.com",
            .path: "/",
            .name: name,
            .value: value,
            .secure: "TRUE",
        ]))
    }
}
