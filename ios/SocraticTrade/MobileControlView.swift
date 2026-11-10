import SwiftUI
import UIKit

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    /// Holdings, orders, and watchlist (tab label "Assets"; same chart symbol).
    case markets
    case activity
    /// Operator portal.  Declared here so canonical bar order matches auto-fill:
    /// the first extra slot after the four defaults, not after Results.  Shown
    /// only when the session's `currentUser.isAdmin` is true.
    case admin
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

    /// Screens a non-admin can pin.  `.admin` is added only through `customizable(isAdmin:)`.
    static var customizable: [AppTab] { customizable(isAdmin: false) }

    /// Screens the owner can pin/unpin.  `.more` is fixed chrome.  `.admin` is offered
    /// only when the server marked this login as an operator — hiding-by-obscurity is not
    /// the gate; the tab is simply not in the list.
    static func customizable(isAdmin: Bool) -> [AppTab] {
        allCases.filter { tab in
            switch tab {
            case .more: return false
            case .admin: return isAdmin
            case .home, .proposals, .markets, .activity, .insights, .coach, .scan, .guardrails, .results:
                return true
            }
        }
    }

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
        case .admin: return "Admin"
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
        case .admin: return "wrench.and.screwdriver"
        case .more: return "square.grid.2x2"
        }
    }

    /// Concise purpose line for the More list (mirrors the web rail's hover desc).
    var detail: String {
        switch self {
        case .home: return "Live thesis, actions, and agent controls."
        case .proposals: return "Trade proposals awaiting your judgment."
        case .markets: return "Holdings, orders, and watchlist."
        case .activity: return "Alerts Center, Notifications, Strategy Runs, Order Fills, and the Audit Log."
        case .insights: return "Status brief and attention items."
        case .coach: return "Ask the desk — a real Coach conversation."
        case .scan: return "Ranked names with watchlist actions."
        // Not "tighten it": this screen raises caps too, which GuardrailsView itself
        // says ("Caps can go up or down").  Web's enumeration is the accurate line.
        case .guardrails: return "Autonomy, spending caps, protective stops, schedule, and the trading rulebook."
        case .results: return "P&L, benchmark, and fill receipts."
        case .admin: return "Operator tools: connections, spend, corpus, host, and transcripts."
        case .more: return "All screens and tab customization."
        }
    }

    @ViewBuilder
    var label: some View {
        Label(title, systemImage: systemImage)
    }
}

/// How many customizable tabs fit beside More at a given window width.
///
/// Pure math, kept out of the view so XCTest can cover the breakpoints without hosting
/// SwiftUI — the same split `WrappingHStackLayout` uses for the watchlist chip wrap.
enum TabBarCapacity {
    /// Any compact-width window — every iPhone, and an iPad in Slide Over — keeps the phone
    /// bar: four screens plus More.  Widening it there only shrinks the touch targets.
    static let compact = 4
    /// Never fewer than this however narrow a Mac window is dragged: Home plus one slot.
    static let minimum = 2
    /// Ceiling regardless of width.  Past eight a tab bar stops being a bar and starts being
    /// a menu, and More still has the customization list to hold.
    static let maximum = 8

    /// Width one item takes in the regular-width bar: icon, label, and its own padding.
    static let slotWidth: CGFloat = 108
    /// Width the bar spends on what is not a customizable tab — the More item plus the
    /// capsule's end insets.
    static let reservedWidth: CGFloat = 132

    /// - Parameter isRegularWidth: regular horizontal size class AND not a phone.  An iPhone
    ///   never grows the bar even if it were to report regular width in landscape.
    static func fits(width: CGFloat, isRegularWidth: Bool) -> Int {
        guard isRegularWidth else { return compact }
        guard width.isFinite, width > 0 else { return compact }
        let slots = Int(((width - reservedWidth) / slotWidth).rounded(.down))
        return min(maximum, max(minimum, slots))
    }
}

/// Persisted, owner-customizable tab-bar membership.
///
/// Three rules the bar obeys, in order:
/// 1. **Home is chrome, not a preference.**  It is always pinned, always first, never
///    toggleable — every other screen is optional.
/// 2. **Width decides how many slots exist.**  `capacity` comes from the window, so an iPad
///    or a wide Mac window shows more than the four an iPhone shows.  A window too narrow for
///    the owner's chosen set falls back to the DEFAULTS, trimmed to fit; the stored choice is
///    left untouched so widening restores it.
/// 3. **The last slot before More is borrowed, not owned.**  Opening a screen from the More
///    list hands it that slot (`dynamicTab`), displacing whatever sat there — Activity by
///    default.  Pinning that screen makes it permanent and gives the slot back.
@MainActor
final class TabPreferences: ObservableObject {
    static let minTabs = 2
    /// Ceiling on what can be PINNED.  What actually renders is bounded by `capacity`.
    static let maxTabs = TabBarCapacity.maximum
    /// Always on the bar, never toggleable.
    static let requiredTab: AppTab = .home
    /// Default pins mirror the web defaults (Home, Proposals, Activity, Orders) mapped
    /// onto this app's screens — Assets is where holdings/orders live on iOS.
    static let defaultTabs: [AppTab] = [.home, .proposals, .markets, .activity]
    private static let storageKey = "mobileTabs.v1"
    private static let dynamicStorageKey = "mobileTabs.dynamic.v1"

    @Published private(set) var pinned: [AppTab]
    /// False until the owner pins or unpins something.  Until then the bar AUTO-FILLS to
    /// whatever the window fits — the whole point of a wider bar is that an iPad shows more
    /// without anyone having to go and ask for it.  The first toggle freezes their choice.
    @Published private(set) var hasCustomSelection: Bool
    /// The screen currently borrowing the slot before More, or nil when nothing has been
    /// opened from the More list.  Persisted so the bar does not snap back on relaunch.
    @Published private(set) var dynamicTab: AppTab?
    /// How many customizable tabs the current window fits.  Set by the shell from the live
    /// width — see `TabBarCapacity.fits`.
    @Published private(set) var capacity: Int
    /// Mirrors `currentUser.isAdmin`.  Admin is a first-class tab on every device size, but
    /// it is not offered (and cannot occupy a slot) when the session is not an operator.
    @Published private(set) var showsAdminTab: Bool

    private let userDefaults: UserDefaults

    init(
        userDefaults: UserDefaults = .standard,
        capacity: Int = TabBarCapacity.compact,
        showsAdminTab: Bool = false
    ) {
        let slots = max(TabBarCapacity.minimum, min(TabBarCapacity.maximum, capacity))
        // Unknown/stale raw values (a screen renamed or removed since the value was saved) and
        // duplicates are dropped silently; a selection that fell below the minimum is treated
        // as no selection at all rather than surfaced as an error — same recovery the web does.
        let stored = Self.sanitize((userDefaults.stringArray(forKey: Self.storageKey) ?? [])
            .compactMap(AppTab.init(rawValue:)))
        // An unusable stored value is not a choice — it goes back to auto-fill rather than
        // freezing the owner onto a set they never picked.
        let isCustom = stored.count >= Self.minTabs
        var restored = stored
        if !restored.contains(Self.requiredTab) {
            restored.insert(Self.requiredTab, at: 0)
        }

        self.userDefaults = userDefaults
        self.capacity = slots
        self.showsAdminTab = showsAdminTab
        self.hasCustomSelection = isCustom
        self.pinned = isCustom
            ? Array(restored.prefix(Self.maxTabs))
            : Self.autoFill(capacity: slots, isAdmin: showsAdminTab)
        if let raw = userDefaults.string(forKey: Self.dynamicStorageKey),
           let tab = AppTab(rawValue: raw), tab != .more {
            self.dynamicTab = tab
        }
    }

    /// The bar a window gets before the owner has expressed any preference: the owner-decided
    /// defaults first, then the remaining screens in canonical order, cut to what fits.
    /// Admin, when this login is an operator, takes the first extra slot so an iPad Air 11"
    /// portrait bar (six slots) shows it without anyone pinning it.
    static func autoFill(capacity: Int, isAdmin: Bool = false) -> [AppTab] {
        let slots = max(minTabs, min(maxTabs, capacity))
        var rest = AppTab.customizable(isAdmin: false).filter { !defaultTabs.contains($0) }
        if isAdmin {
            rest.insert(.admin, at: 0)
        }
        return Array((defaultTabs + rest).prefix(slots))
    }

    /// Drops `.more`, unknown values, and duplicates while keeping the stored order.
    private static func sanitize(_ tabs: [AppTab]) -> [AppTab] {
        var seen: Set<AppTab> = []
        var result: [AppTab] = []
        for tab in tabs where tab != .more && !seen.contains(tab) {
            seen.insert(tab)
            result.append(tab)
        }
        return result
    }

    /// Pinned tabs in canonical order — the owner's chosen membership, before the window's
    /// width or the borrowed slot have any say.  (The bar renders declaration order, not the
    /// order tabs happened to be pinned in.)
    var barTabs: [AppTab] {
        AppTab.customizable(isAdmin: showsAdminTab).filter { pinned.contains($0) }
    }

    /// What the bar actually renders right now, in render order.  The borrowed occupant, when
    /// there is one, is always the last entry — the slot immediately before More.
    var visibleTabs: [AppTab] {
        let borrowed = (dynamicTab == .admin && !showsAdminTab) ? nil : dynamicTab
        return Self.resolve(barTabs: barTabs, dynamicTab: borrowed, capacity: capacity)
    }

    /// Pure resolution of (chosen membership, borrowed slot, available slots) -> rendered bar.
    static func resolve(barTabs: [AppTab], dynamicTab: AppTab?, capacity: Int) -> [AppTab] {
        let slots = max(minTabs, min(TabBarCapacity.maximum, capacity))
        var base = barTabs
        if base.count > slots {
            // Too narrow for what the owner picked: fall back to the defaults.  Nothing is
            // written to storage, so widening the window restores their choice untouched.
            base = AppTab.customizable.filter { defaultTabs.contains($0) }
        }
        base = Array(base.prefix(slots))
        guard let dynamicTab, dynamicTab != .more, !base.contains(dynamicTab) else { return base }
        // The borrowed occupant displaces the LAST slot, never Home's.
        guard base.count > 1 else { return base + [dynamicTab] }
        return Array(base.dropLast()) + [dynamicTab]
    }

    func isPinned(_ tab: AppTab) -> Bool { pinned.contains(tab) }

    /// Whether pinning/unpinning this tab right now would respect the bounds.  Home is never
    /// toggleable, and the ceiling is what this window fits — so the owner cannot pin a set
    /// the bar would immediately have to fall back from.
    func canToggle(_ tab: AppTab) -> Bool {
        guard tab != .more, tab != Self.requiredTab else { return false }
        if tab == .admin && !showsAdminTab { return false }
        if pinned.contains(tab) { return pinned.count > Self.minTabs }
        return pinned.count < pinLimit
    }

    /// The most tabs that may be pinned on this window size.
    var pinLimit: Int { min(Self.maxTabs, max(Self.minTabs, capacity)) }

    func toggle(_ tab: AppTab) {
        guard canToggle(tab) else { return }
        // Touching the bar at all is the owner taking it over: auto-fill stops here.
        hasCustomSelection = true
        if pinned.contains(tab) {
            pinned.removeAll { $0 == tab }
        } else {
            pinned.append(tab)
            // A screen that just earned a permanent slot has no use for the borrowed one.
            if dynamicTab == tab { setDynamicTab(nil) }
        }
        userDefaults.set(pinned.map(\.rawValue), forKey: Self.storageKey)
    }

    /// Hand the slot before More to a screen that is not on the bar — what happens when the
    /// owner opens one from the More list, follows a deep link, or when a window narrows far
    /// enough to drop the screen they were already looking at.  A no-op for anything already
    /// visible, so tapping a real tab never disturbs the borrowed one.
    func promote(_ tab: AppTab) {
        guard tab != .more, !visibleTabs.contains(tab) else { return }
        if tab == .admin && !showsAdminTab { return }
        setDynamicTab(tab)
    }

    /// Give the borrowed slot back to whatever the owner pinned there.
    func clearDynamicTab() { setDynamicTab(nil) }

    func setCapacity(_ value: Int) {
        let clamped = max(TabBarCapacity.minimum, min(TabBarCapacity.maximum, value))
        guard capacity != clamped else { return }
        capacity = clamped
        // Nothing is written to storage here — an auto-filled bar is still "no choice made",
        // so rotating an iPad or resizing a Mac window never counts as customizing it.
        if !hasCustomSelection {
            pinned = Self.autoFill(capacity: clamped, isAdmin: showsAdminTab)
        }
    }

    /// Called when the snapshot's `currentUser.isAdmin` flips.  An auto-filled bar re-fills
    /// so a freshly signed-in operator sees Admin on iPad without pinning; a customized bar
    /// keeps its membership and `barTabs` simply omits Admin when the flag is false.
    func setShowsAdminTab(_ value: Bool) {
        guard showsAdminTab != value else { return }
        showsAdminTab = value
        if dynamicTab == .admin && !value {
            setDynamicTab(nil)
        }
        if !hasCustomSelection {
            pinned = Self.autoFill(capacity: capacity, isAdmin: value)
        }
    }

    private func setDynamicTab(_ tab: AppTab?) {
        guard dynamicTab != tab else { return }
        dynamicTab = tab
        if let tab {
            userDefaults.set(tab.rawValue, forKey: Self.dynamicStorageKey)
        } else {
            userDefaults.removeObject(forKey: Self.dynamicStorageKey)
        }
    }
}

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @StateObject private var tabPreferences = TabPreferences()
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedTab: AppTab = MobileControlView.initialTab()
    /// Proposal id a deep link asked for, handed to whichever ProposalsView is on screen.
    @State private var focusedProposalId: String?
    /// Ticker a deep link asked for, handed to MarketsView (Assets).
    @State private var focusedSymbol: String?
    /// Activity subsection (`?tab=`).  Path-only `/console/activity` does not reset this.
    @State private var activitySection: ActivitySection = .alerts
    /// Clears the ring above once the cue has been seen (see `apply`).
    @State private var focusExpiry: Task<Void, Never>?

    @Binding private var pendingDeepLink: DeepLinkDestination?

    init(pendingDeepLink: Binding<DeepLinkDestination?> = .constant(nil)) {
        self._pendingDeepLink = pendingDeepLink
    }

    private var pendingProposalCount: Int {
        store.snapshot?.pendingProposals.count ?? 0
    }

    private var unreadNotificationCount: Int {
        store.snapshot?.unreadNotificationCount ?? 0
    }

    /// The tabs the bar renders right now, in render order.
    private var bar: [AppTab] { tabPreferences.visibleTabs }

    /// An iPhone keeps the four-tab bar even if it ever reported regular width in landscape;
    /// only an iPad or a Mac window earns extra slots.
    private var isRegularWidth: Bool {
        AppLayout.isRegularWidth(horizontalSizeClass)
    }

    private func badgeCount(for tab: AppTab) -> Int {
        switch tab {
        case .proposals: return pendingProposalCount
        case .activity: return unreadNotificationCount
        default: return 0
        }
    }

    /// More carries what the bar cannot show, so a displaced Activity's unread count is never
    /// invisible just because something borrowed its slot.
    private var moreBadgeCount: Int {
        AppTab.customizable(isAdmin: tabPreferences.showsAdminTab)
            .filter { !bar.contains($0) }
            .reduce(0) { $0 + badgeCount(for: $1) }
    }

    /// Programmatic jumps (e.g. Home's "Review Proposals") can target a screen that is not on
    /// the bar. Handing it the borrowed slot keeps every jump landing on a real tab instead of
    /// a selection with no matching tab.
    private var selection: Binding<AppTab> {
        Binding(
            get: { selectedTab },
            set: { target in
                // Any tab change ends the deep-link ring: it has either been seen or been left
                // behind.  `apply` sets the focus AFTER moving the selection, so a link's own
                // jump is not the change that clears it.
                clearFocus()
                if target == .admin && !tabPreferences.showsAdminTab { return }
                if target != .more { tabPreferences.promote(target) }
                selectedTab = target
            }
        )
    }

    var body: some View {
        // iOS 26 `Tab` builder (not legacy `.tabItem`) — this is what keeps the bar on
        // the system Liquid Glass appearance and its iPad/Mac sidebar adaptations.
        //
        // POSITIONAL, and unrolled on purpose.  Each block renders `bar[i]`, so the rendered
        // order IS `visibleTabs` order and the borrowed occupant lands in the slot before
        // More.  It stays unrolled (no ForEach) because ForEach+Tab times out the Swift 6
        // compiler ("unable to type-check this expression") on Release/archive builds, and it
        // stops at nine blocks + More because a result builder takes at most ten children.
        TabView(selection: selection) {
            if bar.count > 0 {
                let tab = bar[0]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 1 {
                let tab = bar[1]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 2 {
                let tab = bar[2]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 3 {
                let tab = bar[3]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 4 {
                let tab = bar[4]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 5 {
                let tab = bar[5]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 6 {
                let tab = bar[6]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 7 {
                let tab = bar[7]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }
            if bar.count > 8 {
                let tab = bar[8]
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack { destination(for: tab).appChrome() }
                }
                .badge(badgeCount(for: tab))
            }

            Tab(AppTab.more.title, systemImage: AppTab.more.systemImage, value: AppTab.more) {
                NavigationStack {
                    MoreView(
                        tabPreferences: tabPreferences,
                        pendingProposalCount: pendingProposalCount,
                        unreadNotificationCount: unreadNotificationCount,
                        open: { selection.wrappedValue = $0 }
                    )
                    .appChrome()
                }
            }
            .badge(moreBadgeCount)
        }
        .tint(AppPalette.accent)
        // Regular width (iPad, wide Mac window) can convert the bar into a sidebar; compact
        // width keeps the phone tab bar.  The conversion follows horizontalSizeClass, so a
        // Mac window dragged across the compact/regular boundary reflows instead of staying
        // stuck on one idiom.
        .tabViewStyle(.sidebarAdaptable)
        // The window decides how many slots exist.  A Mac window dragged narrower, or an iPad
        // rotated to portrait, re-runs this and the bar re-resolves live.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            tabPreferences.setCapacity(TabBarCapacity.fits(width: width, isRegularWidth: isRegularWidth))
        }
        .onChange(of: bar) { _, tabs in
            // A window that just got narrower can drop the screen currently on screen.  Hand
            // it the borrowed slot rather than leaving the bar with a selection it cannot show.
            if selectedTab != .more, !tabs.contains(selectedTab) {
                tabPreferences.promote(selectedTab)
            }
        }
        .onChange(of: pendingDeepLink) { _, destination in
            apply(destination)
        }
        .onAppear {
            // A link or notification tap that launched the app can arrive before this view
            // exists, and one that arrives while signed out waits here until it does.
            tabPreferences.setShowsAdminTab(store.snapshot?.currentUser?.isAdmin == true)
            if selectedTab != .more { tabPreferences.promote(selectedTab) }
            apply(pendingDeepLink)
        }
        .onChange(of: store.snapshot?.currentUser?.isAdmin) { _, isAdmin in
            tabPreferences.setShowsAdminTab(isAdmin == true)
            if isAdmin != true, selectedTab == .admin {
                selection.wrappedValue = .home
            }
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

    /// Deep links reuse the SAME `selection` binding as in-app jumps, so a link to a screen
    /// that is not on the bar hands that screen the borrowed slot instead of selecting a tab
    /// that does not exist.  Clearing `pendingDeepLink` afterwards keeps a repeat of the same
    /// link routable.
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
        focusedSymbol = destination.focusedSymbol
        if let section = destination.activitySection {
            activitySection = section
        }
        pendingDeepLink = nil
        focusExpiry?.cancel()
        guard focusedProposalId != nil || focusedSymbol != nil else { return }
        focusExpiry = Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            focusedProposalId = nil
            focusedSymbol = nil
        }
    }

    private func clearFocus() {
        focusExpiry?.cancel()
        focusExpiry = nil
        focusedProposalId = nil
        focusedSymbol = nil
    }

    @ViewBuilder
    private func destination(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView(selectedTab: selection)
        case .proposals: ProposalsView(focusedProposalId: $focusedProposalId)
        case .markets: MarketsView(selectedTab: selection, focusedSymbol: $focusedSymbol)
        case .activity: ActivityView(selectedSection: $activitySection)
        case .insights: InsightsView(selectedTab: selection)
        case .coach: CoachView()
        case .scan: ScanView()
        case .guardrails: GuardrailsView()
        case .results: ResultsView()
        case .admin:
            AdminPortalView(onBackToConsole: { selection.wrappedValue = .home })
        case .more: EmptyView()
        }
    }
}

extension Notification.Name {
    static let ascSelectTab = Notification.Name("ascSelectTab")
}

/// The overflow + customization screen: every destination stays reachable here, each row's pin
/// toggle edits the bar live, and opening a row that is not on the bar hands it the slot before
/// More — the same two jobs as the web TabsSheet, plus the borrowed slot.
private struct MoreView: View {
    @ObservedObject var tabPreferences: TabPreferences
    let pendingProposalCount: Int
    let unreadNotificationCount: Int
    let open: (AppTab) -> Void

    var body: some View {
        List {
            if tabPreferences.showsAdminTab {
                Section {
                    row(for: .admin)
                } header: {
                    Text("Admin")
                }
            }
            Section {
                ForEach(AppTab.customizable(isAdmin: false)) { tab in
                    row(for: tab)
                }
            } header: {
                Text("Screens")
            } footer: {
                Text(footerText)
            }
        }
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var footerText: String {
        let limit = tabPreferences.pinLimit
        let filled = tabPreferences.hasCustomSelection
            ? "A narrower window falls back to the default tabs and keeps your picks for when it widens again."
            : "Until you pin or unpin something, the bar fills them for you."
        return "Home always stays on the tab bar.  This window fits \(limit) screens.  \(filled)  Opening a screen from this list gives it the slot before More until you open another one."
    }

    private func row(for tab: AppTab) -> some View {
        HStack(spacing: 12) {
            Button {
                open(tab)
            } label: {
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
                            if tab == .activity && unreadNotificationCount > 0 {
                                Text("\(unreadNotificationCount)")
                                    .font(.appCaption2.weight(.bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(AppPalette.accent, in: Capsule())
                            }
                            if tabPreferences.dynamicTab == tab {
                                Text("On Bar")
                                    .font(.appCaption2.weight(.semibold))
                                    .foregroundStyle(AppPalette.accent)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(AppPalette.accent.opacity(0.12), in: Capsule())
                            }
                        }
                        Text(tab.detail)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                tabPreferences.toggle(tab)
            } label: {
                Image(systemName: tabPreferences.isPinned(tab) ? "pin.fill" : "pin")
                    .foregroundStyle(tabPreferences.canToggle(tab) ? AppPalette.accent : Color.secondary.opacity(0.4))
            }
            .buttonStyle(.borderless)
            .disabled(!tabPreferences.canToggle(tab))
            .accessibilityLabel(pinAccessibilityLabel(for: tab))
            .accessibilityHint(pinAccessibilityHint(for: tab))
        }
    }

    private func pinAccessibilityLabel(for tab: AppTab) -> String {
        if tab == TabPreferences.requiredTab { return "\(tab.title) is always on the tab bar" }
        return tabPreferences.isPinned(tab)
            ? "Remove \(tab.title) from tab bar"
            : "Add \(tab.title) to tab bar"
    }

    private func pinAccessibilityHint(for tab: AppTab) -> String {
        if tab == TabPreferences.requiredTab { return "Home cannot be removed" }
        if tabPreferences.canToggle(tab) { return "" }
        return tabPreferences.isPinned(tab)
            ? "Keep at least \(TabPreferences.minTabs) tabs"
            : "This window fits \(tabPreferences.pinLimit) tabs — remove one first"
    }
}

#if DEBUG
#Preview("Customizable tab shell") {
    MobileControlView()
        .environmentObject(MobileStore.preview)
}
#endif
