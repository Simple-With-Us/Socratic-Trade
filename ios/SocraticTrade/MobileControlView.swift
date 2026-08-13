import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    /// Holdings, orders, watchlist, alerts (tab label "Assets"; same chart symbol).
    case markets
    case activity
    /// Snapshot brief + rule-based attention items — not the web console Coach chat.
    case insights
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
    @State private var selectedTab: AppTab = .home
    @State private var morePath: [AppTab] = []

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
        TabView(selection: selection) {
            ForEach(tabPreferences.barTabs) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack {
                        destination(for: tab)
                    }
                }
                .badge(tab == .proposals ? pendingProposalCount : 0)
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
    }

    @ViewBuilder
    private func destination(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView(selectedTab: selection)
        case .proposals: ProposalsView()
        case .markets: MarketsView()
        case .activity: ActivityView()
        case .insights: InsightsView()
        case .more: EmptyView()
        }
    }
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
