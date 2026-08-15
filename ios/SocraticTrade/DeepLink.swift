import Foundation

/// Where an incoming link lands inside the app.
enum DeepLinkDestination: Equatable {
    case tab(AppTab)
    /// The Proposals tab, scrolled to and highlighting one proposal.
    case proposal(id: String)

    /// The tab that must be selected to show this destination.
    var tab: AppTab {
        switch self {
        case .tab(let tab): return tab
        case .proposal: return .proposals
        }
    }

    var proposalId: String? {
        if case .proposal(let id) = self { return id }
        return nil
    }
}

/// URL → destination mapping for `onOpenURL`.
///
/// Two link families reach this app and they are deliberately NOT treated alike:
/// - `https://socratictrade.com/...` universal links carry CONTENT routes.  The domain claims
///   the app through `applinks:socratictrade.com` (entitlement + the AASA file served from
///   app/.well-known/apple-app-site-association/route.ts), so only paths listed there can
///   arrive this way.
/// - `socratictrade://` stays AUTH-CALLBACK-ONLY.  That scheme is consumed inside
///   `ASWebAuthenticationSession` (LoginView), which never routes through `onOpenURL`, and any
///   app on the device can register the same scheme — so a content route arriving on it is
///   either a mistake or a spoof.  It is rejected here rather than honoured.
///
/// Pure and total: no I/O, no app state, every unrecognized input maps to nil.
enum DeepLink {
    /// The one host the app claims.  Subdomains (console./mobile.) and `www.` are not claimed
    /// in the entitlement, so accepting them here would be a lie about what iOS will deliver.
    static let universalLinkHost = "socratictrade.com"
    /// Reserved for the OAuth callback — never a content route.  See above.
    static let authCallbackScheme = "socratictrade"

    private static let maximumProposalIdLength = 64

    static func destination(for url: URL) -> DeepLinkDestination? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // https only: `http` is never a universal link, and honouring it would let a
        // downgraded link drive the app.
        guard components.scheme?.lowercased() == "https" else { return nil }
        guard components.host?.lowercased() == universalLinkHost else { return nil }

        let segments = components.percentEncodedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard segments.count >= 2, segments[0].lowercased() == "console" else { return nil }

        switch segments[1].lowercased() {
        case "approvals":
            if segments.count == 2 {
                let queryId = components.queryItems?.first(where: { $0.name.lowercased() == "proposal" })?.value
                if let id = normalizedProposalId(queryId) {
                    return .proposal(id: id)
                }
                return .tab(.proposals)
            }
            if segments.count == 3 {
                // A malformed id still belongs on the Proposals tab — landing on the list is
                // better than dropping the link.
                if let id = normalizedProposalId(segments[2].removingPercentEncoding ?? segments[2]) {
                    return .proposal(id: id)
                }
                return .tab(.proposals)
            }
            return nil
        case "orders", "watchlist":
            // Holdings, orders, watchlist, and alerts all live on the Assets tab.
            return segments.count == 2 ? .tab(.markets) : nil
        case "activity":
            return segments.count == 2 ? .tab(.activity) : nil
        case "assistant", "coach":
            return segments.count == 2 ? .tab(.coach) : nil
        case "scan":
            return segments.count == 2 ? .tab(.scan) : nil
        case "guardrails":
            return segments.count == 2 ? .tab(.guardrails) : nil
        case "results":
            return segments.count == 2 ? .tab(.results) : nil
        default:
            return nil
        }
    }

    /// Accepts only ids that could plausibly be a proposal id (the server mints UUIDs).
    private static func normalizedProposalId(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        guard trimmed.count <= maximumProposalIdLength else { return nil }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        guard trimmed.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return trimmed
    }
}
