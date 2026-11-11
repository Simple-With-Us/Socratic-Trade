import SwiftUI

@main
struct SocraticTradeApp: App {
    /// UIKit hands back the APNs device token nowhere else — see `PushAppDelegate`.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var store = SocraticTradeApp.makeStore()

    /// DEBUG App Store shots: `-ASCScreenshots` / `ASC_SCREENSHOTS=1` / UserDefaults `ascScreenshots`.
    static var isScreenshotMode: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ASCScreenshots") { return true }
        if ProcessInfo.processInfo.environment["ASC_SCREENSHOTS"] == "1" { return true }
        if UserDefaults.standard.bool(forKey: "ascScreenshots") { return true }
        return false
        #else
        return false
        #endif
    }

    private static func makeStore() -> MobileStore {
        #if DEBUG
        if isScreenshotMode { return MobileStore.preview }
        #endif
        return MobileStore(client: MobileAPIClient(baseURL: MobileAPIClient.productionBaseURL))
    }

    init() {
        SentryTelemetry.start()
        // Nav bars and tab items are drawn by UIKit and never see SwiftUI's .font, so the
        // Lato swap has to be installed here or the chrome stays on SF while content moves.
        AppAppearance.applyFonts()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(PushNotificationCoordinator.shared)
                // Owner 2026-08-10: light is the product default (no theme
                // picker on this app yet — do not follow OS dark by default).
                .preferredColorScheme(.light)
                // Default face for any Text that doesn't name a style of its own. The
                // .app* twins in AppTypography.swift cover the ones that do.
                .environment(\.font, .appBody)
                .appUpdatePrompt()
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: MobileStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var didRunBootstrap = false

    /// The splash's own floor, independent of the network. Without it a warm launch (cached
    /// session, snapshot back in ~200ms) shows the wordmark for a single frame, which reads as
    /// a flicker rather than a brand moment. With it, a fast launch still gets the full
    /// animation and a slow one is never held back — the splash leaves when BOTH are done.
    @State private var minimumSplashElapsed = false

    private var showSplash: Bool { !store.hasInitialized || !minimumSplashElapsed }

    /// Set by `onOpenURL` AND by a tapped push notification, consumed (and cleared) by the tab
    /// shell.  Held here rather than inside the shell so a link that arrives before sign-in
    /// still routes: the shell exists in this ZStack the whole time and applies the
    /// destination as soon as it is set, so the right screen is already showing when
    /// authentication completes.
    @State private var pendingDeepLink: DeepLinkDestination?

    var body: some View {
        ZStack {
            if store.hasInitialized && !store.isAuthenticated {
                LoginView()
                    .transition(.opacity)
            }

            if store.isAuthenticated {
                MobileControlView(pendingDeepLink: $pendingDeepLink)
                    .id(store.sessionEpoch)
                    .transition(.opacity)
                    .storeTransientAlerts()
                    .fullScreenCover(isPresented: Binding(
                        get: { store.needsAppConsent },
                        set: { _ in }
                    )) {
                        LegalConsentSheet()
                            .environmentObject(store)
                    }
            }

            if showSplash {
                LaunchStateView()
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: reduceMotion ? 0.2 : 0.55), value: showSplash)
        .animation(.easeInOut(duration: 0.2), value: store.isAuthenticated)
        .task {
            await store.restorePersistedSessionFromKeychainIfNeeded()
            await bootstrapIfNeeded()
        }
        .task {
            try? await Task.sleep(for: .seconds(1.2))
            minimumSplashElapsed = true
        }
        .onChange(of: scenePhase) { _, phase in
            handleScenePhase(phase)
        }
        .onOpenURL { url in
            guard let destination = DeepLink.destination(for: url) else { return }
            pendingDeepLink = destination
        }
    }

    private func bootstrapIfNeeded() async {
        if !didRunBootstrap {
            didRunBootstrap = true
            PushNotificationCoordinator.shared.rebindAPIClient(store.client)
            PushNotificationCoordinator.shared.configure(
                route: { destination in pendingDeepLink = destination },
                isLiveStreamConnected: { store.isStreamConnected }
            )
            if SocraticTradeApp.isScreenshotMode { return }
            if !store.hasInitialized {
                await store.load()
                if store.isAuthenticated {
                    store.startEvents()
                    await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
                }
            }
            return
        }
        await resumeLiveSessionIfNeeded()
    }

    private func resumeLiveSessionIfNeeded() async {
        await AppLiveSessionResume.resumeLiveSession(
            store: store,
            isScreenshotMode: SocraticTradeApp.isScreenshotMode
        )
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        if SocraticTradeApp.isScreenshotMode { return }
        switch phase {
        case .background:
            store.stopEvents()
        case .active where store.isAuthenticated:
            store.startEvents()
            Task { await store.load() }
        default:
            break
        }
    }
}

/// Launch screen: the candlestick "SOCRATIC TRADE" wordmark sitting at the top of the screen,
/// ticking, until the app is ready — then the whole thing slides up and away (see the
/// transition on the caller).
private struct LaunchStateView: View {
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                AppPalette.background.ignoresSafeArea()

                CandleWordmarkView(height: wordmarkHeight(forWidth: geo.size.width))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 10)
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Socratic Trade")
        .accessibilityAddTraits(.isHeader)
    }

    private func wordmarkHeight(forWidth width: CGFloat) -> CGFloat {
        let aspect: CGFloat = CandleWordmarkModel.shared.wm.ar
        return max(40, min(80, (width * 0.88) / aspect))
    }
}

struct LegalConsentSheet: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Not investment advice.  You set authority.")
                    .font(.appHeadline)

                Text("Socratic Trade is software you configure.  Using the app requires accepting the Terms and Privacy Policy, and contributing general market data — quotes, fundamentals, history, and news — to a shared pool.  Personal account data stays private.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                Text("You can delete your account yourself in Account & Settings.  Backups are kept for at most 2 weeks: short-term backups for 3 days, and weekly backups for 2 weeks, then deleted.  Fact-level research notes may join a shared research corpus; risk rules and strategy instructions stay private.")
                    .font(.appBody)
                    .foregroundStyle(.secondary)

                HStack(spacing: 16) {
                    Link("Terms", destination: URL(string: "https://socratictrade.com/terms-and-conditions")!)
                    Link("Privacy", destination: URL(string: "https://socratictrade.com/privacy-policy")!)
                }
                .font(.appSubheadline)

                Spacer()

                Button {
                    Task { await store.acceptAppConsent() }
                } label: {
                    Text(store.isAcceptingConsent ? "Saving…" : "Accept & Continue")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isAcceptingConsent)
            }
            .padding(24)
            .navigationTitle("Terms, Privacy, and Shared Data")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }
}
