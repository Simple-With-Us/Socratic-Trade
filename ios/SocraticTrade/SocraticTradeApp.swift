import SwiftUI

@main
struct SocraticTradeApp: App {
    @StateObject private var store = MobileStore(
        client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                // Owner 2026-08-10: light is the product default (no theme
                // picker on this app yet — do not follow OS dark by default).
                .preferredColorScheme(.light)
        }
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var store: MobileStore
    /// Set by `onOpenURL`, consumed (and cleared) by the tab shell.  Held here rather than
    /// inside the shell so a link that arrives before sign-in still routes: the shell exists in
    /// this ZStack the whole time and applies the destination as soon as it is set, so the
    /// right screen is already showing when authentication completes.
    @State private var pendingDeepLink: DeepLinkDestination?

    var body: some View {
        ZStack {
            LoginView()
                .opacity(store.hasInitialized && !store.isAuthenticated ? 1 : 0)
                .allowsHitTesting(store.hasInitialized && !store.isAuthenticated)
                .accessibilityHidden(!store.hasInitialized || store.isAuthenticated)

            MobileControlView(pendingDeepLink: $pendingDeepLink)
                .opacity(store.isAuthenticated ? 1 : 0)
                .allowsHitTesting(store.isAuthenticated)
                .accessibilityHidden(!store.isAuthenticated)

            if !store.hasInitialized {
                LaunchStateView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.hasInitialized)
        .animation(.easeInOut(duration: 0.2), value: store.isAuthenticated)
        .task {
            await bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            handleScenePhase(phase)
        }
        // Universal links only reach here for paths the AASA file claims; anything else
        // (including the auth-callback scheme) maps to nil and is ignored.
        .onOpenURL { url in
            guard let destination = DeepLink.destination(for: url) else { return }
            pendingDeepLink = destination
        }
    }

    private func bootstrap() async {
        guard !store.hasInitialized else { return }
        await store.load()
        if store.isAuthenticated {
            store.startEvents()
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active where store.isAuthenticated:
            store.startEvents()
            Task { await store.load() }
        case .background:
            store.stopEvents()
        default:
            break
        }
    }
}

private struct LaunchStateView: View {
    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()
            VStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(AppPalette.accent.gradient)
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .font(.system(size: 32, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 70, height: 70)
                ProgressView()
                Text("Socratic.Trade")
                    .font(.headline)
            }
        }
    }
}
