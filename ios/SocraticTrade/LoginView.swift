import AuthenticationServices
import SwiftUI

/// Native login — visual parity with `app/login/page.tsx`:
/// candlestick wordmark, accent-dot value bullets, Google (accent) / GitHub (outline) / Apple.
struct LoginView: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var store: MobileStore

    /// Keep in sync with `LOGIN_VALUE_BULLETS` in `app/login/page.tsx`.
    private static let valueBullets = [
        "Review and approve proposals",
        "Track positions, orders, and performance",
        "Control the backend agent without moving credentials onto the device"
    ]

    var body: some View {
        ZStack {
            // Web login: plain `bg-bg` (#eef1f5 light / #0a0a0a dark) — no accent mesh.
            loginBackground
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    brand
                    valueCard
                    signIn
                    privacyNote
                }
                .frame(maxWidth: 400)
                .padding(.horizontal, 24)
                .padding(.vertical, 48)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var loginBackground: Color {
        // Match globals.css --bg light/dark
        Color(uiColor: UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return UIColor(red: 0x0a / 255, green: 0x0a / 255, blue: 0x0a / 255, alpha: 1)
            }
            return UIColor(red: 0xee / 255, green: 0xf1 / 255, blue: 0xf5 / 255, alpha: 1)
        })
    }

    private var brand: some View {
        // Web: HeaderLogo height={20}; slightly taller on phone for legibility.
        CandleWordmarkView(height: 24)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
    }

    private var valueCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Self.valueBullets, id: \.self) { text in
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(AppPalette.accent)
                        .frame(width: 6, height: 6)
                        .padding(.top, 6)
                    Text(text)
                        .font(.appSubheadline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: UIColor { traits in
                if traits.userInterfaceStyle == .dark {
                    // --surface dark ≈ rgba(22,22,22,0.78)
                    return UIColor(red: 22 / 255, green: 22 / 255, blue: 22 / 255, alpha: 0.78)
                }
                // --surface light ≈ white glass
                return UIColor(white: 1, alpha: 0.65)
            }),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.primary.opacity(colorScheme == .dark ? 0.08 : 0.06), lineWidth: 1)
        }
    }

    private var signIn: some View {
        VStack(spacing: 12) {
            if let error = store.error {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppPalette.warning)
                    Text(error)
                        .font(.appSubheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(13)
                .background(AppPalette.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            // Order matches web login: Google → GitHub → Apple
            webAuthButton(
                provider: "google",
                title: "Sign in with Google",
                style: .accent
            ) {
                GoogleMark()
            }

            webAuthButton(
                provider: "github",
                title: "Sign in with GitHub",
                style: .outline
            ) {
                GitHubMark()
            }

            SignInWithAppleButton(
                .signIn,
                onRequest: configure,
                onCompletion: complete
            )
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            // Apple's ASAuthorizationAppleIDButton hard-caps width at 375pt. Stretching the
            // UIKit host wider (e.g. 392pt after horizontal padding) trips unsatisfiable
            // NSAutoresizingMaskLayoutConstraints in the console. Do not follow this with
            // another maxWidth:.infinity — that re-expands the UIKit host and revives the conflict.
            .frame(maxWidth: 375)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .disabled(store.isSigningIn)
            .overlay {
                if store.isSigningIn {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.black.opacity(0.35))
                    ProgressView()
                        .tint(.white)
                }
            }
        }
    }

    private enum WebAuthStyle {
        case accent
        case outline
    }

    private func webAuthButton<Icon: View>(
        provider: String,
        title: String,
        style: WebAuthStyle,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        Button {
            beginWebAuth(provider: provider)
        } label: {
            HStack(spacing: 8) {
                icon()
                    .frame(width: 18, height: 18)
                Text(title)
                    .font(.appSubheadline.weight(.medium))
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
            .foregroundStyle(style == .accent ? Color.white : Color.primary)
            .background {
                switch style {
                case .accent:
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(AppPalette.accent)
                case .outline:
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(uiColor: UIColor { traits in
                            if traits.userInterfaceStyle == .dark {
                                return UIColor(red: 22 / 255, green: 22 / 255, blue: 22 / 255, alpha: 0.78)
                            }
                            return UIColor(white: 1, alpha: 0.65)
                        }))
                        .overlay {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(Color.primary.opacity(colorScheme == .dark ? 0.12 : 0.1), lineWidth: 1)
                        }
                }
            }
        }
        .disabled(store.isSigningIn)
        .accessibilityHint("Opens the secure Socratic Trade sign-in page")
    }

    private var privacyNote: some View {
        Label(
            "The app stores only your Socratic Trade session.  Broker and provider secrets stay on the backend.",
            systemImage: "lock.fill"
        )
        .font(.appCaption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.top, 4)
    }

    private func configure(_ request: ASAuthorizationAppleIDRequest) {
        store.dismissError()
        request.requestedScopes = [.fullName, .email]
    }

    private func complete(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            handleAuthorization(authorization)
        case .failure(let error):
            if let authorizationError = error as? ASAuthorizationError,
               authorizationError.code == .canceled {
                return
            }
            store.error = error.localizedDescription
        }
    }

    private func handleAuthorization(_ authorization: ASAuthorization) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8)
        else {
            store.error = "Apple did not return an identity token.  Try again."
            return
        }

        let name: String? = {
            guard let fullName = credential.fullName else { return nil }
            let components = [fullName.givenName, fullName.familyName].compactMap { $0 }
            return components.isEmpty ? nil : components.joined(separator: " ")
        }()

        Task {
            await store.loginWithApple(identityToken: identityToken, name: name)
        }
    }

    private func beginWebAuth(provider: String) {
        store.dismissError()
        guard let verifier = WebAuthCodeVerifier.make() else {
            store.error = "Could not securely start web sign-in.  Try again."
            return
        }
        guard var callbackComponents = URLComponents(string: "https://socratictrade.com/api/mobile/auth-redirect") else {
            store.error = "Could not prepare web sign-in."
            return
        }
        callbackComponents.queryItems = [
            URLQueryItem(name: "code_challenge", value: verifier.challenge)
        ]
        guard let callbackURL = callbackComponents.url,
              var components = URLComponents(string: "https://socratictrade.com/api/auth/signin/\(provider)") else {
            store.error = "Could not prepare web sign-in."
            return
        }
        components.queryItems = [
            URLQueryItem(name: "callbackUrl", value: callbackURL.absoluteString)
        ]
        guard let url = components.url else {
            store.error = "Could not start web sign-in."
            return
        }

        let contextProvider = WebAuthContextProvider()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "socratictrade") { callbackURL, error in
            if let error {
                if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    return
                }
                Task { @MainActor in store.error = error.localizedDescription }
                return
            }
            guard
                let callbackURL,
                let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
                !code.isEmpty
            else {
                Task { @MainActor in store.error = "Invalid callback URL from web sign-in." }
                return
            }
            Task { @MainActor in
                await store.loginWithWebAuthCode(code, verifier: verifier.value)
            }
        }
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = false
        WebAuthSessionManager.shared.start(session: session, provider: contextProvider)
    }
}

// MARK: - Provider marks (match web button icons)

private struct GoogleMark: View {
    var body: some View {
        // Multicolor "G" ring — Google brand colors from app/login/page.tsx GoogleIcon.
        Canvas { context, size in
            let blue = Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255)
            let green = Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255)
            let yellow = Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255)
            let red = Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width * 0.42
            let lw = size.width * 0.18

            func arc(_ start: Double, _ end: Double, _ color: Color) {
                var p = Path()
                p.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(start),
                    endAngle: .degrees(end),
                    clockwise: false
                )
                context.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: lw, lineCap: .butt))
            }
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)
            context.fill(
                Path(CGRect(
                    x: size.width * 0.48,
                    y: size.height * 0.42,
                    width: size.width * 0.42,
                    height: size.width * 0.16
                )),
                with: .color(blue)
            )
        }
        .accessibilityHidden(true)
    }
}

private struct GitHubMark: View {
    var body: some View {
        Image(systemName: "chevron.left.forwardslash.chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .accessibilityHidden(true)
    }
}

@MainActor
private final class WebAuthSessionManager {
    static let shared = WebAuthSessionManager()
    private var session: ASWebAuthenticationSession?
    private var contextProvider: WebAuthContextProvider?

    func start(session: ASWebAuthenticationSession, provider: WebAuthContextProvider) {
        self.session = session
        self.contextProvider = provider
        session.start()
    }
}

private final class WebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let keyWindow = scenes.flatMap(\.windows).first(where: \.isKeyWindow) {
            return keyWindow
        }
        if let scene = scenes.first {
            // UIWindow.init() is deprecated in iOS 26 — always anchor to a window scene.
            return scene.windows.first ?? UIWindow(windowScene: scene)
        }
        // Running app should always have a scene; avoid deprecated UIWindow().
        preconditionFailure("No UIWindowScene available for web auth presentation")
    }
}

#if DEBUG
#Preview("Login") {
    LoginView()
        .environmentObject(
            MobileStore(client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!))
        )
}
#endif
