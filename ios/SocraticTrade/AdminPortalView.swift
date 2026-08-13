import SwiftUI
import WebKit

/// Owner-only sheet hosting the web /admin console inside a locked-down WKWebView.
/// The app's URLSession cookies (HTTPCookieStorage.shared) are copied into the web view's
/// cookie store before the first load, so the existing native session signs the portal in.
/// Navigation is fenced to https://socratictrade.com under /admin (plus /login and
/// /api/auth for the session-expiry bounce); same-host subresources (/_next, /api) stay
/// allowed so the Next.js shell can actually paint.
struct AdminPortalView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var sessionExpired = false
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var portalGeneration = 0

    var body: some View {
        NavigationStack {
            ZStack {
                if sessionExpired {
                    VStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.badge.exclamationmark")
                            .font(.appLargeTitle)
                            .foregroundStyle(AppPalette.warning)
                        Text("Session Expired")
                            .font(.appHeadline)
                        Text("The web session for the admin portal has expired.  Sign in again from the app's login screen, then reopen the portal.")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Close") { dismiss() }
                            .buttonStyle(.borderedProminent)
                            .tint(AppPalette.accent)
                    }
                    .padding(28)
                } else {
                    AdminPortalWebView(
                        onSessionExpired: {
                            sessionExpired = true
                            isLoading = false
                        },
                        onFinished: {
                            isLoading = false
                            loadError = nil
                        },
                        onFailed: { message in
                            isLoading = false
                            loadError = message
                        }
                    )
                    .id(portalGeneration)
                    .opacity(isLoading || loadError != nil ? 0 : 1)
                    .ignoresSafeArea(edges: .bottom)

                    if let loadError {
                        VStack(spacing: 14) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.appLargeTitle)
                                .foregroundStyle(AppPalette.warning)
                            Text("Admin Portal Unavailable")
                                .font(.appHeadline)
                            Text(loadError)
                                .font(.appSubheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            Button("Retry") { reloadPortal() }
                                .buttonStyle(.borderedProminent)
                                .tint(AppPalette.accent)
                        }
                        .padding(28)
                    } else if isLoading {
                        VStack(spacing: 12) {
                            ProgressView()
                            Text("Loading Admin Portal")
                                .font(.appSubheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Admin Portal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func reloadPortal() {
        loadError = nil
        isLoading = true
        portalGeneration += 1
    }
}

// Internal (not private) so the unit suite can pin the navigation fence.
struct AdminPortalWebView: UIViewRepresentable {
    static let portalURL = URL(string: "https://socratictrade.com/admin")!
    static let allowedHost = "socratictrade.com"

    let onSessionExpired: () -> Void
    var onFinished: () -> Void = {}
    var onFailed: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onSessionExpired: onSessionExpired,
            onFinished: onFinished,
            onFailed: onFailed
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Ephemeral store: the session cookie is copied in fresh on every open, so persisting
        // it to disk buys nothing and would let the admin session outlive a native sign-out.
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true

        // Copy the native session cookies (the app talks to the API over URLSession.shared,
        // which persists into HTTPCookieStorage.shared) into the web view before first load.
        // Never wait forever on setCookie — a hung callback left the sheet blank.
        let cookieStore = configuration.websiteDataStore.httpCookieStore
        let sessionCookies = (HTTPCookieStorage.shared.cookies ?? []).filter { cookie in
            cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(Self.allowedHost)
        }
        let group = DispatchGroup()
        for cookie in sessionCookies {
            group.enter()
            cookieStore.setCookie(cookie) { group.leave() }
        }
        var didStartLoad = false
        let startLoad = {
            guard !didStartLoad else { return }
            didStartLoad = true
            webView.load(URLRequest(url: Self.portalURL))
        }
        group.notify(queue: .main, execute: startLoad)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: startLoad)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onSessionExpired: () -> Void
        let onFinished: () -> Void
        let onFailed: (String) -> Void

        init(
            onSessionExpired: @escaping () -> Void,
            onFinished: @escaping () -> Void,
            onFailed: @escaping (String) -> Void
        ) {
            self.onSessionExpired = onSessionExpired
            self.onFinished = onFinished
            self.onFailed = onFailed
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            // about:blank and friends appear during initial setup — harmless, allow.
            if url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            guard Self.isAllowed(url, isMainFrame: isMainFrame) else {
                decisionHandler(.cancel)
                return
            }
            if isMainFrame, url.path == "/login" || url.path.hasPrefix("/login/") {
                // The portal bounced to sign-in: the copied session is no longer valid.
                onSessionExpired()
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onFinished()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onFailed(error.localizedDescription)
        }

        /// Main-frame: https + socratictrade.com + /admin (or the session-expiry bounce).
        /// Subframes / assets: any same-host path so `/_next` and `/api/*` can load.
        static func isAllowed(_ url: URL, isMainFrame: Bool = true) -> Bool {
            guard url.scheme == "https", url.host == AdminPortalWebView.allowedHost else { return false }
            if !isMainFrame { return true }
            let path = url.path
            if path == "/admin" || path.hasPrefix("/admin/") { return true }
            if path == "/login" || path.hasPrefix("/login/") { return true }
            if path.hasPrefix("/api/auth") || path.hasPrefix("/api/admin") { return true }
            if path.hasPrefix("/_next") { return true }
            return false
        }
    }
}
