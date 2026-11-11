import XCTest
@testable import SocraticTrade

@MainActor
final class MobileStoreSessionPersistenceTests: XCTestCase {
    private final class FailingSaveCredentialStore: SessionCredentialStoring, @unchecked Sendable {
        func save(cookies: [SessionCookieArchive]) throws {
            throw SessionCredentialStoreError.encodingFailed
        }

        func load() throws -> [SessionCookieArchive]? { nil }

        func delete() throws {}
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
