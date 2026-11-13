import XCTest
@testable import SocraticTrade

@MainActor
final class MobileStoreSessionPersistenceTests: XCTestCase {
    private final class ThrowingLoadCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        func save(cookies: [SessionCookieArchive]) throws {}

        func load() throws -> [SessionCookieArchive]? {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(-25300)
        }

        func delete() throws {}
    }

    private final class TransientKeychainCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        private(set) var deleteCallCount = 0

        func save(cookies: [SessionCookieArchive]) throws {}

        func load() throws -> [SessionCookieArchive]? {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(errSecInteractionNotAllowed)
        }

        func delete() throws { deleteCallCount += 1 }
    }

    private final class CorruptKeychainCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        private(set) var deleteCallCount = 0

        func save(cookies: [SessionCookieArchive]) throws {}

        func load() throws -> [SessionCookieArchive]? {
            throw SessionCredentialStoreError.decodingFailed
        }

        func delete() throws { deleteCallCount += 1 }
    }

    private final class FailingDeleteCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        func save(cookies: [SessionCookieArchive]) throws {}

        func load() throws -> [SessionCookieArchive]? { nil }

        func delete() throws {
            throw SessionCredentialStoreError.keychainUnexpectedStatus(-25300)
        }
    }

    private final class FailingSaveCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        func save(cookies: [SessionCookieArchive]) throws {
            throw SessionCredentialStoreError.encodingFailed
        }

        func load() throws -> [SessionCookieArchive]? { nil }

        func delete() throws {}
    }

    private final class CountingDelayedLoadCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var prepareClientSessionLoadCount = 0

        func save(cookies: [SessionCookieArchive]) throws {}

        func load() throws -> [SessionCookieArchive]? {
            lock.lock()
            prepareClientSessionLoadCount += 1
            lock.unlock()
            Thread.sleep(forTimeInterval: 0.08)
            return nil
        }

        func delete() throws {}
    }

    @MainActor
    func testConcurrentRestoreCallersShareOneRestoreTask() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let credentialStore = CountingDelayedLoadCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        async let ensure = store.ensurePersistedSessionRestoredBeforeAuthenticatedRequests()
        async let restore = store.restorePersistedSessionFromKeychainIfNeeded()
        await (ensure, restore)
        XCTAssertEqual(credentialStore.prepareClientSessionLoadCount, 1)
    }

    @MainActor
    func testLoadAwaitKeychainRestoreBeforeAuthenticatedRequests() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let coordinator = SessionCookieCoordinator(credentialStore: ThrowingLoadCredentialStore())
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        await store.ensurePersistedSessionRestoredBeforeAuthenticatedRequests()
        XCTAssertTrue(store.error?.contains("Could not restore your saved session") == true)
        XCTAssertFalse(store.isAuthenticated)
    }

    @MainActor
    func testInitDoesNotRestoreKeychainSynchronously() {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let coordinator = SessionCookieCoordinator(credentialStore: ThrowingLoadCredentialStore())
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.error)
    }

    @MainActor
    func testRestoreSurfacesPersistentFailureAndStaysSignedOut() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let coordinator = SessionCookieCoordinator(credentialStore: ThrowingLoadCredentialStore())
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        await store.restorePersistedSessionFromKeychainIfNeeded()
        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNotNil(store.error)
        XCTAssertTrue(store.error?.contains("Could not restore your saved session") == true)
    }

    @MainActor
    func testRestoreTransientKeychainFailureDoesNotDeletePersistedArchives() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let credentialStore = TransientKeychainCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        await store.restorePersistedSessionFromKeychainIfNeeded()
        XCTAssertEqual(credentialStore.deleteCallCount, 0)
        XCTAssertTrue(store.error?.contains("locked") == true)
    }

    @MainActor
    func testRestoreDecodingFailureDeletesPersistedArchives() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let credentialStore = CorruptKeychainCredentialStore()
        let coordinator = SessionCookieCoordinator(credentialStore: credentialStore)
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        await store.restorePersistedSessionFromKeychainIfNeeded()
        XCTAssertEqual(credentialStore.deleteCallCount, 1)
    }

    @MainActor
    func testSignOutDoesNotRetryIdenticalKeychainDelete() async {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let coordinator = SessionCookieCoordinator(credentialStore: FailingDeleteCredentialStore())
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        await store.signOut()
        XCTAssertNotNil(store.error)
        XCTAssertTrue(store.error?.contains("Sign-out could not clear") == true)
    }

    func testPersistAuthSessionCookiesSurfacesSaveFailure() throws {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let coordinator = SessionCookieCoordinator(
            credentialStore: FailingSaveCredentialStore()
        )
        let store = MobileStore(client: client, sessionCookieCoordinator: coordinator)
        let origin = URL(string: "https://socratictrade.com/")!
        let cookie = try XCTUnwrap(
            HTTPCookie.cookies(
                withResponseHeaderFields: [
                    "Set-Cookie": "__Secure-authjs.session-token=test; Domain=socratictrade.com; Path=/; Secure",
                ],
                for: origin
            ).first
        )
        client.sessionCookieJar.setCookie(cookie)

        store.persistAuthSessionCookies()

        XCTAssertNotNil(store.error)
        XCTAssertTrue(store.error?.contains("Could not save your session") == true)
    }
}
