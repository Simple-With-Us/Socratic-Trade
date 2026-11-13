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

    @State private var appLock = AppLockController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environment(appLock)
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
    @Environment(AppLockController.self) private var appLock
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The splash's own floor, independent of the network. Without it a warm launch (cached
    /// session, snapshot back in ~200ms) shows the wordmark for a single frame, which reads as
    /// a flicker rather than a brand moment. With it, a fast launch still gets the full
    /// animation and a slow one is never held back — the splash leaves when BOTH are done.
    @State private var minimumSplashElapsed = false
    @State private var didConfigurePush = false

    private var showSplash: Bool { !store.hasInitialized || !minimumSplashElapsed }

    /// Screenshot runs stay unlocked. Otherwise the lock covers the session until Face ID,
    /// Touch ID, or the device passcode succeeds.
    private var showsAppLock: Bool {
        !SocraticTradeApp.isScreenshotMode && appLock.requiresLockScreen
    }

    /// Blank cover while Require App Lock is on and the scene is not active, so the
    /// app-switcher snapshot is not the open session. The prompt stays on `showsAppLock`.
    private var showsSessionCover: Bool {
        !SocraticTradeApp.isScreenshotMode && AppLockPolicy.shouldCoverSession(
            isEnabled: appLock.isEnabled,
            requiresLockScreen: appLock.requiresLockScreen,
            sceneIsActive: scenePhase == .active
        )
    }

    @State private var liveResumeGate = LiveResumeGate()

    /// Set by `onOpenURL` AND by a tapped push notification, consumed (and cleared) by the tab
    /// shell.  Held here rather than inside the shell so a link that arrives before sign-in
    /// still routes: the shell exists in this ZStack the whole time and applies the
    /// destination as soon as it is set, so the right screen is already showing when
    /// authentication completes.
    @State private var pendingDeepLink: DeepLinkDestination?
    @State private var foregroundResumeTask: Task<Void, Never>?

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

            if showsSessionCover {
                // Covers this stack while the lock window attaches. Presented sheets
                // live above this stack, so AppLockCoverHost covers those.
                AppPalette.background
                    .ignoresSafeArea()
                    .zIndex(2)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityHidden(showsSessionCover)
        .animation(.easeInOut(duration: reduceMotion ? 0.2 : 0.55), value: showSplash)
        .animation(.easeInOut(duration: 0.2), value: store.isAuthenticated)
        .background {
            AppLockCoverHost(
                isPresented: showsSessionCover,
                requiresAuthentication: showsAppLock,
                controller: appLock
            )
        }
        .onChange(of: store.isAuthenticated) { _, authenticated in
            if !authenticated {
                store.stopEvents()
            }
        }
        .task {
            // Push routing is wired before unlock so a tapped notification still lands
            // in `pendingDeepLink`. Session network work waits for the unlock task below.
            guard !didConfigurePush else { return }
            didConfigurePush = true
            PushNotificationCoordinator.shared.rebindAPIClient(store.client)
            PushNotificationCoordinator.shared.configure(
                route: { destination in pendingDeepLink = destination },
                isLiveStreamConnected: { store.isStreamConnected }
            )
        }
        .task(id: appLock.isUnlocked) {
            guard SocraticTradeApp.isScreenshotMode || appLock.isUnlocked else { return }
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
        let action = AppLockSessionBootstrap.action(
            isScreenshotMode: SocraticTradeApp.isScreenshotMode,
            hasInitialized: store.hasInitialized,
            isAuthenticated: store.isAuthenticated,
            initializationCancelled: store.initializationCancelled,
            snapshotLoadFailed: store.snapshotLoadFailed
        )
        switch action {
        case .skip:
            return
        case .loadSession:
            await store.load()
            if store.isAuthenticated {
                store.startEvents()
                // Re-asserts an existing grant only — this never prompts.  APNs can hand out a
                // new device token after a restore or reinstall, and asking each launch is the
                // only way to notice.
                await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
            }
        case .resumeLiveSession:
            await resumeLiveSessionIfNeeded()
        }
    }

    private func resumeLiveSessionIfNeeded() async {
        await AppLiveSessionResume.resumeThroughGate(
            gate: liveResumeGate,
            sceneIsActive: { appLock.sceneIsActive },
            isUnlocked: { appLock.isUnlocked },
            isAuthenticated: { store.isAuthenticated }
        ) { [appLock, store] in
            await Self.performForegroundResume(appLock: appLock, store: store)
        }
    }

    @MainActor
    private static func performForegroundResume(
        appLock: AppLockController,
        store: MobileStore
    ) async -> Bool {
        let resumeID = appLock.beginForegroundResume()
        // Waits for the Keychain restore (ST-4596) before any authenticated request,
        // then resumes only while the scene is active, unlocked, and this resume is current.
        // `appLock.sceneIsActive` replaces ScenePhaseResumeGate here: it defaults to active,
        // so the first unlock can resume before SwiftUI delivers a scene phase.
        return await AppForegroundResume.resumeAfterBecomingActive(
            store: store,
            isScreenshotMode: SocraticTradeApp.isScreenshotMode,
            shouldContinue: {
                appLock.sceneIsActive
                    && appLock.isUnlocked
                    && appLock.foregroundResumeID == resumeID
            }
        )
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        if SocraticTradeApp.isScreenshotMode { return }
        switch phase {
        case .background:
            foregroundResumeTask?.cancel()
            foregroundResumeTask = nil
            appLock.noteSceneIsActive(false)
            appLock.invalidateForegroundResume()
            store.stopEvents()
            if appLock.isEnabled {
                appLock.recordDidEnterBackground()
            }
        case .inactive:
            foregroundResumeTask?.cancel()
            foregroundResumeTask = nil
        case .active:
            appLock.noteSceneIsActive(true)
            appLock.evaluateForegroundEntry()
            guard appLock.isUnlocked else { return }
            guard store.hasInitialized, store.isAuthenticated else { return }
            foregroundResumeTask?.cancel()
            foregroundResumeTask = Task { @MainActor in
                await resumeLiveSessionIfNeeded()
            }
        @unknown default:
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
