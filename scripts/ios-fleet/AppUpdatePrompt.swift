//
//  AppUpdatePrompt.swift
//
//  Portable first-launch update check for every fleet iOS app.
//  Pin: scripts/ios-fleet/AppUpdatePrompt.swift
//  Copy this file into each app target.  Do not fork behavior.
//  Do not make a Swift package.
//
//  On the first scene of a cold launch the app:
//    1. Detects Xcode / TestFlight / App Store (StoreKit AppTransaction).
//    2. Reads marketing version + appleId from the public fleet manifest
//       (Simple-With-Us/AI-Fleet-Coordinator site/ios-versions.json) and the iTunes
//       Lookup API (App Store).  Apple IDs live in that manifest and in
//       scripts/ios-fleet/apps.json — not in this file.
//    3. If the installed version is older, asks whether to update.
//    4. Update opens TestFlight (itms-beta) or the App Store (itms-apps).
//
//  DEBUG / Xcode / screenshot launches stay silent.  "Not Now" skips that
//  version until a newer one appears.  Failures are silent (no network
//  error alerts).  No secrets are fetched or stored.
//

import StoreKit
import SwiftUI

enum AppUpdatePrompt {

    static let defaultManifestURL = URL(
        string: "https://raw.githubusercontent.com/Simple-With-Us/AI-Fleet-Coordinator/main/site/ios-versions.json"
    )!

    private static let skippedVersionKeyPrefix = "appUpdatePrompt.skippedVersion."

    struct Config: Equatable {
        var bundleId: String
        var appleId: Int?
        var manifestURL: URL
        var currentMarketingVersion: String
        var currentBuild: String

        static func fromBundle(_ bundle: Bundle = .main) -> Config {
            let info = bundle.infoDictionary ?? [:]
            let bundleId = bundle.bundleIdentifier ?? ""
            let plistAppleId = intValue(info["AppUpdateAppleId"])
            let manifest = (info["AppUpdateManifestURL"] as? String)
                .flatMap(URL.init(string:)) ?? AppUpdatePrompt.defaultManifestURL
            return Config(
                bundleId: bundleId,
                appleId: plistAppleId,
                manifestURL: manifest,
                currentMarketingVersion: (info["CFBundleShortVersionString"] as? String) ?? "0",
                currentBuild: (info["CFBundleVersion"] as? String) ?? "0"
            )
        }
    }

    struct Version: Comparable, Equatable, CustomStringConvertible {
        let raw: String
        let parts: [Int]

        var description: String { raw }

        init(_ raw: String) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            self.raw = trimmed
            self.parts = trimmed.split(separator: ".", omittingEmptySubsequences: true).map { segment in
                Int(segment.filter(\.isNumber)) ?? 0
            }
        }

        static func == (lhs: Version, rhs: Version) -> Bool {
            !(lhs < rhs) && !(rhs < lhs)
        }

        static func < (lhs: Version, rhs: Version) -> Bool {
            let count = max(lhs.parts.count, rhs.parts.count)
            for index in 0..<count {
                let left = index < lhs.parts.count ? lhs.parts[index] : 0
                let right = index < rhs.parts.count ? rhs.parts[index] : 0
                if left != right { return left < right }
            }
            return false
        }
    }

    enum Channel: Equatable {
        case xcode
        case testFlight
        case appStore
        case unknown
    }

    struct Offer: Equatable {
        var latestVersion: String
        var currentVersion: String
        var channel: Channel
        var storeURL: URL
        var fallbackURL: URL

        var message: String {
            "Version \(latestVersion) is available.\u{00A0} You have \(currentVersion)."
        }
    }

    static var shouldSkipLaunchChecks: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["APP_UPDATE_PROMPT_FORCE"] != "1" {
            return true
        }
        #endif
        let process = ProcessInfo.processInfo
        if process.arguments.contains("-ASCScreenshots") { return true }
        if process.arguments.contains("-ScreenshotDemo") { return true }
        if process.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if UserDefaults.standard.bool(forKey: "ascScreenshots") { return true }
        return false
    }

    static func detectChannel() async -> Channel {
        do {
            let result = try await AppTransaction.shared
            switch result {
            case .verified(let transaction):
                switch transaction.environment {
                case .xcode: return .xcode
                case .sandbox: return .testFlight
                case .production: return .appStore
                default: break
                }
            case .unverified:
                break
            }
        } catch {
            // Fall through to the receipt path.  StoreKit is unavailable in
            // some simulator / unsigned CI builds.
        }
        return receiptChannel()
    }

    static func receiptChannel() -> Channel {
        guard let receiptURL = Bundle.main.appStoreReceiptURL else { return .unknown }
        if receiptURL.lastPathComponent == "sandboxReceipt" {
            return .testFlight
        }
        if FileManager.default.fileExists(atPath: receiptURL.path) {
            return .appStore
        }
        return .unknown
    }

    static func isNewer(latestMarketing: String, latestBuild: String?, currentMarketing: String, currentBuild: String) -> Bool {
        let latest = Version(latestMarketing)
        let current = Version(currentMarketing)
        if latest > current { return true }
        if latest < current { return false }
        guard let latestBuild, !latestBuild.isEmpty else { return false }
        return Version(latestBuild) > Version(currentBuild)
    }

    static func skippedVersion(for bundleId: String, defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: skippedVersionKeyPrefix + bundleId)
    }

    static func rememberSkip(version: String, bundleId: String, defaults: UserDefaults = .standard) {
        defaults.set(version, forKey: skippedVersionKeyPrefix + bundleId)
    }

    static func storeURLs(channel: Channel, appleId: Int, testFlightURL: String?, appStoreURL: String?) -> (primary: URL, fallback: URL)? {
        switch channel {
        case .testFlight, .unknown:
            let primary = testFlightURL.flatMap(URL.init(string:))
                ?? URL(string: "itms-beta://beta.itunes.apple.com/v1/app/\(appleId)")
            let fallback = URL(string: "https://beta.itunes.apple.com/v1/app/\(appleId)")
            if let primary, let fallback { return (primary, fallback) }
            return nil
        case .appStore, .xcode:
            let primary = appStoreURL.flatMap(URL.init(string:))
                ?? URL(string: "itms-apps://itunes.apple.com/app/id\(appleId)")
            let fallback = URL(string: "https://apps.apple.com/app/id\(appleId)")
            if let primary, let fallback { return (primary, fallback) }
            return nil
        }
    }

    static func evaluate(
        config: Config,
        channel: Channel,
        manifest: ManifestFile?,
        lookup: LookupFile?
    ) -> Offer? {
        guard channel != .xcode else { return nil }

        let entry = manifest?.apps[config.bundleId]
        let lookupResult = lookup?.results.first

        let latestMarketing: String?
        switch channel {
        case .appStore:
            latestMarketing = lookupResult?.version ?? entry?.marketingVersion
        case .testFlight, .unknown:
            latestMarketing = entry?.marketingVersion ?? lookupResult?.version
        case .xcode:
            return nil
        }

        guard let latestMarketing, !latestMarketing.isEmpty else { return nil }
        let latestBuild = entry?.build
        guard isNewer(
            latestMarketing: latestMarketing,
            latestBuild: channel == .appStore ? nil : latestBuild,
            currentMarketing: config.currentMarketingVersion,
            currentBuild: config.currentBuild
        ) else { return nil }

        if let skipped = skippedVersion(for: config.bundleId), Version(skipped) >= Version(latestMarketing) {
            return nil
        }

        let appleId = entry?.appleId ?? lookupResult?.trackId ?? config.appleId
        guard let appleId else { return nil }
        guard let urls = storeURLs(
            channel: channel,
            appleId: appleId,
            testFlightURL: entry?.testFlightURL,
            appStoreURL: entry?.appStoreURL ?? lookupResult?.trackViewUrl
        ) else { return nil }

        return Offer(
            latestVersion: latestMarketing,
            currentVersion: config.currentMarketingVersion,
            channel: channel,
            storeURL: urls.primary,
            fallbackURL: urls.fallback
        )
    }

    struct ManifestFile: Decodable, Equatable {
        var apps: [String: ManifestApp]
    }

    struct ManifestApp: Decodable, Equatable {
        var marketingVersion: String
        var build: String?
        var appleId: Int?
        var testFlightURL: String?
        var appStoreURL: String?
    }

    struct LookupFile: Decodable, Equatable {
        var resultCount: Int
        var results: [LookupResult]
    }

    struct LookupResult: Decodable, Equatable {
        var version: String
        var trackId: Int
        var trackViewUrl: String?
    }

    static func fetchManifest(from url: URL) async -> ManifestFile? {
        await fetchJSON(ManifestFile.self, from: url)
    }

    static func fetchLookup(bundleId: String) async -> LookupFile? {
        guard let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(bundleId)") else {
            return nil
        }
        return await fetchJSON(LookupFile.self, from: url)
    }

    private static func fetchJSON<T: Decodable>(_ type: T.Type, from url: URL) async -> T? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        switch value {
        case let number as Int: return number
        case let number as NSNumber: return number.intValue
        case let text as String: return Int(text)
        default: return nil
        }
    }
}

extension View {
    func appUpdatePrompt(config: AppUpdatePrompt.Config = .fromBundle()) -> some View {
        modifier(AppUpdatePromptModifier(config: config))
    }
}

private struct AppUpdatePromptModifier: ViewModifier {
    let config: AppUpdatePrompt.Config
    @Environment(\.openURL) private var openURL
    @State private var offer: AppUpdatePrompt.Offer?

    func body(content: Content) -> some View {
        content
            .task { await checkOnce() }
            .alert("Update Available", isPresented: offerPresented) {
                Button("Update") { openStore() }
                Button("Not Now", role: .cancel) { skipCurrent() }
            } message: {
                Text(offer?.message ?? "")
            }
    }

    private var offerPresented: Binding<Bool> {
        Binding(
            get: { offer != nil },
            set: { if !$0 { skipCurrent() } }
        )
    }

    @MainActor
    private func checkOnce() async {
        guard !AppUpdatePrompt.shouldSkipLaunchChecks else { return }
        let channel = await AppUpdatePrompt.detectChannel()
        guard channel != .xcode else { return }
        async let manifest = AppUpdatePrompt.fetchManifest(from: config.manifestURL)
        async let lookup = AppUpdatePrompt.fetchLookup(bundleId: config.bundleId)
        offer = AppUpdatePrompt.evaluate(
            config: config,
            channel: channel,
            manifest: await manifest,
            lookup: await lookup
        )
    }

    private func skipCurrent() {
        if let offer {
            AppUpdatePrompt.rememberSkip(version: offer.latestVersion, bundleId: config.bundleId)
        }
        offer = nil
    }

    private func openStore() {
        guard let offer else { return }
        openURL(offer.storeURL) { accepted in
            if !accepted {
                openURL(offer.fallbackURL)
            }
        }
        self.offer = nil
    }
}
