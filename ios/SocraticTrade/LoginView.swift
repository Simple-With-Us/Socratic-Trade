import SwiftUI
import AuthenticationServices
import CryptoKit
import Security

struct LoginView: View {
    @EnvironmentObject private var store: MobileStore
    
    var body: some View {
        VStack(spacing: 40) {
            Text("Socratic.Trade")
                .font(.largeTitle)
                .bold()
            
            if let error = store.error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding()
            }
            
            SignInWithAppleButton(
                .signIn,
                onRequest: { request in
                    request.requestedScopes = [.fullName, .email]
                },
                onCompletion: { result in
                    switch result {
                    case .success(let authorization):
                        handleAuthorization(authorization)
                    case .failure(let error):
                        if let asError = error as? ASAuthorizationError, asError.code == .canceled {
                            // User canceled, ignore
                        } else {
                            store.error = error.localizedDescription
                        }
                    }
                }
            )
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .padding(.horizontal, 40)
            
            Button(action: {
                initiateWebAuth(provider: "google")
            }) {
                HStack {
                    Image(systemName: "g.circle.fill")
                    Text("Sign in with Google")
                        .bold()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
            .padding(.horizontal, 40)

            Button(action: {
                initiateWebAuth(provider: "github")
            }) {
                HStack {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                    Text("Sign in with GitHub")
                        .bold()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color.gray)
                .foregroundColor(.white)
                .cornerRadius(8)
            }
            .padding(.horizontal, 40)
            
            if store.busy {
                ProgressView()
            }
        }
        .padding()
    }
    
    private func initiateWebAuth(provider: String) {
        guard let state = secureURLSafeRandomString(),
              let codeVerifier = secureURLSafeRandomString() else {
            store.error = "Could not create a secure authentication request."
            return
        }
        let codeChallenge = pkceChallenge(for: codeVerifier)
        var components = URLComponents(string: "https://socratictrade.com/api/mobile/auth/start")
        components?.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge)
        ]
        guard let url = components?.url else {
            store.error = "Could not create the authentication URL."
            return
        }

        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "socratictrade") { callbackURL, error in
            Task { @MainActor in
                if let error = error {
                    if let asError = error as? ASWebAuthenticationSessionError, asError.code == .canceledLogin {
                        return
                    }
                    store.error = error.localizedDescription
                    return
                }

                guard let callbackURL,
                      let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                      let returnedState = callback.queryItems?.first(where: { $0.name == "state" })?.value,
                      let code = callback.queryItems?.first(where: { $0.name == "code" })?.value,
                      returnedState == state else {
                    store.error = "Invalid callback from web authentication."
                    return
                }

                await store.completeWebAuth(code: code, state: state, codeVerifier: codeVerifier)
            }
        }

        let contextProvider = ContextProvider()
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = false
        WebAuthSessionManager.shared.start(session: session, provider: contextProvider)
    }

    private func handleAuthorization(_ authorization: ASAuthorization) {
        guard let appleIDCredential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = appleIDCredential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            store.error = "Failed to extract identity token from Apple."
            return
        }
        
        let name: String? = {
            if let fullName = appleIDCredential.fullName {
                let parts = [fullName.givenName, fullName.familyName].compactMap { $0 }
                return parts.isEmpty ? nil : parts.joined(separator: " ")
            }
            return nil
        }()
        
        Task {
            await store.loginWithApple(identityToken: identityToken, name: name)
        }
    }
}

private func secureURLSafeRandomString(byteCount: Int = 32) -> String? {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    return Data(bytes).base64URLEncodedString()
}

private func pkceChallenge(for verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

class WebAuthSessionManager {
    static let shared = WebAuthSessionManager()
    private var currentSession: ASWebAuthenticationSession?
    private var currentProvider: ContextProvider?
    
    func start(session: ASWebAuthenticationSession, provider: ContextProvider) {
        self.currentSession = session
        self.currentProvider = provider
        session.start()
    }
}

class ContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
