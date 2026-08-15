import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    /// Holdings, orders, watchlist, alerts (tab label "Assets"; same chart symbol).
    case markets
    case activity
    /// Snapshot brief + rule-based attention items — not the web console Coach chat.
    case insights
    /// Live Coach conversation (POST /api/chat).
    case coach
    /// Interactive market scan table.
    case scan
    /// Full policy + tighten-only edits.
    case guardrails
    /// Read-only P&L and tax-relevant fill receipts.
    case results
    /// Every screen + tab customization. Always present, always last — the iOS
    /// counterpart of the web mobile bar's "More" sheet (app/console/components/nav.tsx).
    case more

    var id: String { rawValue }

    /// Screens the owner can pin/unpin. `.more` is fixed chrome, not a destination.
    static var customizable: [AppTab] { allCases.filter { $0 != .more } }

    var title: String {
        switch self {
        case .home: return "Home"
        case .proposals: return "Proposals"
        case .markets: return "Assets"
        case .activity: return "Activity"
        case .insights: return "Insights"
        case .coach: return "Coach"
        case .scan: return "Scan"
        case .guardrails: return "Guardrails"
        case .results: return "Results"
        case .more: return "More"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house.fill"
        case .proposals: return "checklist"
        case .markets: return "chart.line.uptrend.xyaxis"
        case .activity: return "clock.arrow.circlepath"
        case .insights: return "lightbulb.fill"
        case .coach: return "bubble.left.and.bubble.right.fill"
        case .scan: return "tablecells"
        case .guardrails: return "shield.checkered"
        case .results: return "chart.xyaxis.line"
        case .more: return "square.grid.2x2"
        }
    }

    /// Concise purpose line for the More list (mirrors the web rail's hover desc).
    var detail: String {
        switch self {
        case .home: return "Live thesis, actions, and agent controls."
        case .proposals: return "Trade proposals awaiting your judgment."
        case .markets: return "Holdings, orders, watchlist, and price alerts."
        case .activity: return "Everything the agent did, newest first."
        case .insights: return "Status brief and attention items."
        case .coach: return "Ask the desk — a real Coach conversation."
        case .scan: return "Ranked names with watchlist actions."
        case .guardrails: return "Read the full policy and tighten it."
        case .results: return "P&L, benchmark, and fill receipts."
        case .more: return "All screens and tab customization."
        }
    }

    @ViewBuilder
    var label: some View {
        Label(title, systemImage: systemImage)
    }
}

/// Persisted, owner-customizable tab-bar membership — the iOS counterpart of the web
/// console's pinned mobile tabs (app/console/lib/mobile-tabs.ts): same min/max bounds,
/// same membership-set semantics (the bar renders pinned tabs in canonical declaration
/// order, not pin order), and the same guarantee that every screen stays reachable
/// through More even when unpinned.
@MainActor
final class TabPreferences: ObservableObject {
    static let minTabs = 2
    static let maxTabs = 4
    /// Default pins mirror the web defaults (Home, Proposals, Activity, Orders) mapped
    /// onto this app's screens — Assets is where holdings/orders live on iOS.
    static let defaultTabs: [AppTab] = [.home, .proposals, .markets, .activity]
    private static let storageKey = "mobileTabs.v1"

    @Published private(set) var pinned: [AppTab]

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        // Unknown/stale raw values (a screen renamed or removed since the value was
        // saved) are dropped silently; a selection that fell below the minimum resets
        // to the defaults rather than surfacing an error — same recovery the web does.
        let stored = (userDefaults.stringArray(forKey: Self.storageKey) ?? [])
            .compactMap(AppTab.init(rawValue:))
            .filter { $0 != .more }
        pinned = stored.count >= Self.minTabs ? Array(stored.prefix(Self.maxTabs)) : Self.defaultTabs
    }

    /// Pinned tabs in canonical order — what the bar actually renders.
    var barTabs: [AppTab] { AppTab.customizable.filter { pinned.contains($0) } }

    func isPinned(_ tab: AppTab) -> Bool { pinned.contains(tab) }

    /// Whether pinning/unpinning this tab right now would respect the min/max bounds.
    func canToggle(_ tab: AppTab) -> Bool {
        pinned.contains(tab) ? pinned.count > Self.minTabs : pinned.count < Self.maxTabs
    }

    func toggle(_ tab: AppTab) {
        guard tab != .more else { return }
        if pinned.contains(tab) {
            guard pinned.count > Self.minTabs else { return }
            pinned.removeAll { $0 == tab }
        } else {
            guard pinned.count < Self.maxTabs else { return }
            pinned.append(tab)
        }
        userDefaults.set(pinned.map(\.rawValue), forKey: Self.storageKey)
    }
}

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @StateObject private var tabPreferences = TabPreferences()
    @State private var selectedTab: AppTab = MobileControlView.initialTab()
    @State private var morePath: [AppTab] = []
    /// Proposal id a deep link asked for, handed to whichever ProposalsView is on screen.
    @State private var focusedProposalId: String?
    /// Clears the ring above once the cue has been seen (see `apply`).
    @State private var focusExpiry: Task<Void, Never>?

    @Binding private var pendingDeepLink: DeepLinkDestination?

    init(pendingDeepLink: Binding<DeepLinkDestination?> = .constant(nil)) {
        self._pendingDeepLink = pendingDeepLink
    }

    private var pendingProposalCount: Int {
        store.snapshot?.pendingProposals.count ?? 0
    }

    /// Programmatic jumps (e.g. Home's "Review Proposals") can target a screen the
    /// owner unpinned from the bar. Rerouting those into the More stack keeps every
    /// jump landing on a real screen instead of a selection with no matching tab.
    private var selection: Binding<AppTab> {
        Binding(
            get: { selectedTab },
            set: { target in
                // Any tab change ends the deep-link ring: it has either been seen or been left
                // behind.  `apply` sets the focus AFTER moving the selection, so a link's own
                // jump is not the change that clears it.
                clearFocusedProposal()
                if target == .more || tabPreferences.barTabs.contains(target) {
                    selectedTab = target
                } else {
                    morePath = [target]
                    selectedTab = .more
                }
            }
        )
    }

    var body: some View {
        // iOS 26 `Tab` builder (not legacy `.tabItem`) — this is what keeps the bar on
        // the system Liquid Glass appearance and its iPad/Mac sidebar adaptations.
        // Unrolled (no ForEach) so Release/archive can type-check; ForEach+Tab
        // times out the Swift 6 compiler ("unable to type-check this expression").
        TabView(selection: selection) {
            if tabPreferences.isPinned(.home) {
                Tab(AppTab.home.title, systemImage: AppTab.home.systemImage, value: AppTab.home) {
                    NavigationStack { destination(for: .home) }
                }
            }
            if tabPreferences.isPinned(.proposals) {
                Tab(AppTab.proposals.title, systemImage: AppTab.proposals.systemImage, value: AppTab.proposals) {
                    NavigationStack { destination(for: .proposals) }
                }
                .badge(pendingProposalCount)
            }
            if tabPreferences.isPinned(.markets) {
                Tab(AppTab.markets.title, systemImage: AppTab.markets.systemImage, value: AppTab.markets) {
                    NavigationStack { destination(for: .markets) }
                }
            }
            if tabPreferences.isPinned(.activity) {
                Tab(AppTab.activity.title, systemImage: AppTab.activity.systemImage, value: AppTab.activity) {
                    NavigationStack { destination(for: .activity) }
                }
            }
            if tabPreferences.isPinned(.insights) {
                Tab(AppTab.insights.title, systemImage: AppTab.insights.systemImage, value: AppTab.insights) {
                    NavigationStack { destination(for: .insights) }
                }
            }
            if tabPreferences.isPinned(.coach) {
                Tab(AppTab.coach.title, systemImage: AppTab.coach.systemImage, value: AppTab.coach) {
                    NavigationStack { destination(for: .coach) }
                }
            }
            if tabPreferences.isPinned(.scan) {
                Tab(AppTab.scan.title, systemImage: AppTab.scan.systemImage, value: AppTab.scan) {
                    NavigationStack { destination(for: .scan) }
                }
            }
            if tabPreferences.isPinned(.guardrails) {
                Tab(AppTab.guardrails.title, systemImage: AppTab.guardrails.systemImage, value: AppTab.guardrails) {
                    NavigationStack { destination(for: .guardrails) }
                }
            }
            if tabPreferences.isPinned(.results) {
                Tab(AppTab.results.title, systemImage: AppTab.results.systemImage, value: AppTab.results) {
                    NavigationStack { destination(for: .results) }
                }
            }

            Tab(AppTab.more.title, systemImage: AppTab.more.systemImage, value: AppTab.more) {
                NavigationStack(path: $morePath) {
                    MoreView(
                        tabPreferences: tabPreferences,
                        pendingProposalCount: pendingProposalCount
                    )
                    .navigationDestination(for: AppTab.self) { tab in
                        destination(for: tab)
                    }
                }
            }
        }
        .tint(AppPalette.accent)
        .onChange(of: pendingDeepLink) { _, destination in
            apply(destination)
        }
        .onAppear {
            // A link or notification tap that launched the app can arrive before this view
            // exists, and one that arrives while signed out waits here until it does.
            apply(pendingDeepLink)
        }
        .onReceive(NotificationCenter.default.publisher(for: .ascSelectTab)) { note in
            if let raw = note.object as? String, let tab = AppTab(rawValue: raw) {
                selection.wrappedValue = tab
            }
        }
    }

    /// `-ASCScreenshotTab home|proposals|markets|activity|insights` or UserDefaults `ascScreenshotTab`.
    private static func initialTab() -> AppTab {
        #if DEBUG
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-ASCScreenshotTab"),
           ProcessInfo.processInfo.arguments.indices.contains(idx + 1),
           let tab = AppTab(rawValue: ProcessInfo.processInfo.arguments[idx + 1]) {
            return tab
        }
        if let raw = UserDefaults.standard.string(forKey: "ascScreenshotTab"),
           let tab = AppTab(rawValue: raw) {
            return tab
        }
        #endif
        return .home
    }

    /// Deep links reuse the SAME rerouting `selection` binding as in-app jumps, so a link to an
    /// UNPINNED screen lands in the More stack instead of selecting a tab that is not on the
    /// bar.  Clearing `pendingDeepLink` afterwards keeps a repeat of the same link routable.
    ///
    /// The focus id is set AFTER the tab move (the selection setter clears it) and expires on its
    /// own a few seconds later: the accent ring is a transient "here it is" cue for the card the
    /// link named, so once the scroll has landed and been seen it should stop marking that card
    /// out.  Leaving it set was making one proposal look permanently singled out for the rest of
    /// the session.  Clearing it does not scroll anything back — `SnapshotScaffold` only acts on a
    /// non-nil target.
    private func apply(_ destination: DeepLinkDestination?) {
        guard let destination else { return }
        selection.wrappedValue = destination.tab
        focusedProposalId = destination.proposalId
        pendingDeepLink = nil
        focusExpiry?.cancel()
        guard focusedProposalId != nil else { return }
        focusExpiry = Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            focusedProposalId = nil
        }
    }

    private func clearFocusedProposal() {
        focusExpiry?.cancel()
        focusExpiry = nil
        focusedProposalId = nil
    }

    @ViewBuilder
    private func destination(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView(selectedTab: selection)
        case .proposals: ProposalsView(focusedProposalId: $focusedProposalId)
        case .markets: MarketsView(selectedTab: selection)
        case .activity: ActivityView()
        case .insights: InsightsView(selectedTab: selection)
        case .coach: CoachView()
        case .scan: ScanView()
        case .guardrails: GuardrailsView()
        case .results: ResultsView()
        case .more: EmptyView()
        }
    }
}

extension Notification.Name {
    static let ascSelectTab = Notification.Name("ascSelectTab")
}

/// The overflow + customization screen: every destination stays reachable here, and
/// each row's pin toggle edits the bar live — the same two jobs as the web TabsSheet.
private struct MoreView: View {
    @ObservedObject var tabPreferences: TabPreferences
    let pendingProposalCount: Int

    var body: some View {
        List {
            Section {
                ForEach(AppTab.customizable) { tab in
                    row(for: tab)
                }
            } header: {
                Text("Screens")
            } footer: {
                Text("Pinned screens show in the tab bar.  Pin up to \(TabPreferences.maxTabs); keep at least \(TabPreferences.minTabs).  Everything stays reachable from here either way.")
            }
        }
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(for tab: AppTab) -> some View {
        HStack(spacing: 12) {
            NavigationLink(value: tab) {
                HStack(spacing: 12) {
                    Image(systemName: tab.systemImage)
                        .font(.appBody)
                        .foregroundStyle(AppPalette.accent)
                        .frame(width: 30, height: 30)
                        .background(AppPalette.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(tab.title)
                                .font(.appBody.weight(.medium))
                            if tab == .proposals && pendingProposalCount > 0 {
                                Text("\(pendingProposalCount)")
                                    .font(.appCaption2.weight(.bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(AppPalette.negative, in: Capsule())
                            }
                        }
                        Text(tab.detail)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            Button {
                tabPreferences.toggle(tab)
            } label: {
                Image(systemName: tabPreferences.isPinned(tab) ? "pin.fill" : "pin")
                    .foregroundStyle(tabPreferences.canToggle(tab) ? AppPalette.accent : Color.secondary.opacity(0.4))
            }
            .buttonStyle(.borderless)
            .disabled(!tabPreferences.canToggle(tab))
            .accessibilityLabel(tabPreferences.isPinned(tab) ? "Remove \(tab.title) from tab bar" : "Add \(tab.title) to tab bar")
            .accessibilityHint(
                tabPreferences.canToggle(tab)
                    ? ""
                    : tabPreferences.isPinned(tab)
                        ? "Keep at least \(TabPreferences.minTabs) tabs"
                        : "Up to \(TabPreferences.maxTabs) tabs — remove one first"
            )
        }
    }
}

#if DEBUG
#Preview("Customizable tab shell") {
    MobileControlView()
        .environmentObject(MobileStore.preview)
}
#endif
