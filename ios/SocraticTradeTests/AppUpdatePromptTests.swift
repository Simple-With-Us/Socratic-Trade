import XCTest
@testable import SocraticTrade

final class AppUpdatePromptTests: XCTestCase {
    private let dealDexAppleId = 6_802_474_288

    func testEvaluateReadsAppleIdAndVersionFromManifestForLiveDealDex() {
        let config = AppUpdatePrompt.Config(
            bundleId: "net.dealdex",
            appleId: nil,
            manifestURL: AppUpdatePrompt.defaultManifestURL,
            currentMarketingVersion: "1.0.1",
            currentBuild: "1"
        )
        let manifest = AppUpdatePrompt.ManifestFile(apps: [
            "net.dealdex": AppUpdatePrompt.ManifestApp(
                marketingVersion: "1.0.2",
                build: "202608230250",
                appleId: dealDexAppleId,
                testFlightURL: nil,
                appStoreURL: nil
            ),
            "online.dealdex": AppUpdatePrompt.ManifestApp(
                marketingVersion: "9.9.9",
                build: "1",
                appleId: 1,
                testFlightURL: nil,
                appStoreURL: nil
            )
        ])

        let offer = AppUpdatePrompt.evaluate(
            config: config,
            channel: .testFlight,
            manifest: manifest,
            lookup: nil
        )

        XCTAssertEqual(offer?.latestVersion, "1.0.2")
        XCTAssertEqual(offer?.currentVersion, "1.0.1")
        XCTAssertEqual(offer?.channel, .testFlight)
        XCTAssertEqual(
            offer?.storeURL.absoluteString,
            "itms-beta://beta.itunes.apple.com/v1/app/\(dealDexAppleId)"
        )
    }

    func testEvaluateDoesNotTreatStaleDealDexBundleAsTheInstalledApp() {
        let config = AppUpdatePrompt.Config(
            bundleId: "net.dealdex",
            appleId: nil,
            manifestURL: AppUpdatePrompt.defaultManifestURL,
            currentMarketingVersion: "1.0.2",
            currentBuild: "202608230250"
        )
        let manifest = AppUpdatePrompt.ManifestFile(apps: [
            "online.dealdex": AppUpdatePrompt.ManifestApp(
                marketingVersion: "9.9.9",
                build: "1",
                appleId: 1,
                testFlightURL: nil,
                appStoreURL: nil
            )
        ])

        let offer = AppUpdatePrompt.evaluate(
            config: config,
            channel: .testFlight,
            manifest: manifest,
            lookup: nil
        )

        XCTAssertNil(offer)
    }

    func testEvaluateRequiresAnAppleIdFromManifestLookupOrPlist() {
        let config = AppUpdatePrompt.Config(
            bundleId: "net.dealdex",
            appleId: nil,
            manifestURL: AppUpdatePrompt.defaultManifestURL,
            currentMarketingVersion: "1.0.0",
            currentBuild: "1"
        )
        let manifest = AppUpdatePrompt.ManifestFile(apps: [
            "net.dealdex": AppUpdatePrompt.ManifestApp(
                marketingVersion: "1.0.2",
                build: "202608230250",
                appleId: nil,
                testFlightURL: nil,
                appStoreURL: nil
            )
        ])

        let offer = AppUpdatePrompt.evaluate(
            config: config,
            channel: .testFlight,
            manifest: manifest,
            lookup: nil
        )

        XCTAssertNil(offer)
    }

    func testVersionEqualityIgnoresTrailingZeroSegments() {
        XCTAssertEqual(AppUpdatePrompt.Version("1.0"), AppUpdatePrompt.Version("1.0.0"))
        XCTAssertTrue(AppUpdatePrompt.Version("1.0.2") > AppUpdatePrompt.Version("1.0.1"))
    }
}
