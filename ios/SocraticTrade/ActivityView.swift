import SwiftUI
import UIKit

struct ActivityView: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Binding var selectedSection: ActivitySection
    @State private var presentedItem: PresentedMarketItem?

    init(selectedSection: Binding<ActivitySection>) {
        self._selectedSection = selectedSection
    }

    /// iPhone keeps the chip strip even in landscape; iPad and Mac get the left rail.
    private var isRegularWidth: Bool {
        horizontalSizeClass == .regular && UIDevice.current.userInterfaceIdiom != .phone
    }

    var body: some View {
        Group {
            if isRegularWidth {
                HStack(alignment: .top, spacing: 0) {
                    ActivitySectionRail(selection: $selectedSection)
                        .frame(width: 220)
                    SnapshotScaffold {
                        sectionContent(snapshot: $0)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                VStack(spacing: 0) {
                    ActivitySectionChips(selection: $selectedSection)
                    SnapshotScaffold {
                        sectionContent(snapshot: $0)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedItem) { item in
            SymbolInfoSheet(item: item)
        }
    }

    @ViewBuilder
    private func sectionContent(snapshot: MobileSnapshot) -> some View {
        switch selectedSection {
        case .alerts:
            AlertsCenterSection(
                snapshot: snapshot,
                markRead: { ids in await store.acknowledgeNotifications(ids: ids) }
            )
            .cardSpansAllColumns()
        case .notifications:
            NotificationsLedgerSection(
                snapshot: snapshot,
                markRead: { ids in await store.acknowledgeNotifications(ids: ids) }
            )
            .cardSpansAllColumns()
        case .runs:
            StrategyRunsSection(snapshot: snapshot)
                .cardSpansAllColumns()
        case .fills:
            FillActivitySection(fills: snapshot.performance?.fills ?? [], presentedItem: $presentedItem)
                .cardSpansAllColumns()
        case .audit:
            AuditLogSection(items: snapshot.unifiedFeed)
                .cardSpansAllColumns()
        }
    }
}

private struct ActivitySectionChips: View {
    @Binding var selection: ActivitySection

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ActivitySection.allCases) { section in
                    Button {
                        selection = section
                    } label: {
                        Text(section.title)
                            .font(.appCaption.weight(selection == section ? .bold : .semibold))
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(
                                selection == section ? AppPalette.accent.opacity(0.14) : Color.clear,
                                in: Capsule()
                            )
                            .foregroundStyle(selection == section ? AppPalette.accent : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selection == section ? .isSelected : [])
                    .accessibilityLabel(section.title)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(AppPalette.background)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Activity views")
    }
}

private struct ActivitySectionRail: View {
    @Binding var selection: ActivitySection

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Activity")
                .font(.appCaption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 16)
            ForEach(ActivitySection.allCases) { section in
                Button {
                    selection = section
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: section.systemImage)
                            .frame(width: 18)
                        Text(section.title)
                            .font(.appSubheadline.weight(selection == section ? .semibold : .regular))
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        selection == section ? AppPalette.accent.opacity(0.14) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .foregroundStyle(selection == section ? AppPalette.accent : .primary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == section ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .background(AppPalette.background)
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(width: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Activity views")
    }
}

private enum AlertCenterFilter: String, CaseIterable, Identifiable {
    case attention = "Attention"
    case deliveries = "Deliveries"
    case approvals = "Approvals"
    case all = "All Alerts"

    var id: String { rawValue }
}

private func matchesAlertFilter(_ item: NotificationHistoryItem, filter: AlertCenterFilter) -> Bool {
    switch filter {
    case .attention:
        guard !item.read else { return false }
        switch item.type {
        case "kill_switch", "run_failed", "budget_alert", "provider_degraded",
             "earningscalls_entitlement_blocked", "risk_advisory":
            return true
        default:
            return item.status == "failed"
        }
    case .deliveries:
        return item.status == "failed" || item.status == "skipped"
    case .approvals:
        return item.type == "pending_approval" || item.type == "block" || item.type == "proposal_withdrawn"
    case .all:
        return true
    }
}

private struct AlertsCenterSection: View {
    let snapshot: MobileSnapshot
    let markRead: ([String]) async -> Void

    @State private var filter: AlertCenterFilter = .attention
    @State private var ackingIds: Set<String> = []

    private var activeAccountId: String? {
        snapshot.readiness.activeConnectedAccount?.id ?? snapshot.policy.connectedAccountId
    }

    private var scoped: [NotificationHistoryItem] {
        snapshot.inScopeNotifications(activeAccountId: activeAccountId)
    }

    private var visible: [NotificationHistoryItem] {
        Array(scoped.filter { matchesAlertFilter($0, filter: filter) }.prefix(40))
    }

    private var attentionCount: Int {
        scoped.filter { matchesAlertFilter($0, filter: .attention) }.count
    }

    var body: some View {
        VStack(spacing: 12) {
            SectionHeading("Alerts Center", subtitle: "Problems that need a look.  Acknowledge once you have seen them.")
            filterRow
            if visible.isEmpty {
                EmptyStateCard(
                    title: filter == .attention ? "No Alerts Need Attention" : "No Matching Alerts",
                    message: filter == .attention
                        ? "No alerts need attention."
                        : "No alerts match this filter.",
                    systemImage: "bell.badge"
                )
            } else {
                ForEach(visible) { item in
                    NotificationHistoryRow(
                        item: item,
                        acking: ackingIds.contains(item.id),
                        markRead: { await markOne(item) }
                    )
                }
            }
        }
    }

    private var filterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AlertCenterFilter.allCases) { option in
                    Button {
                        filter = option
                    } label: {
                        HStack(spacing: 6) {
                            Text(option.rawValue)
                            if option == .attention {
                                Text("\(attentionCount)")
                                    .font(.appCaption2.weight(.bold))
                            }
                        }
                        .font(.appCaption.weight(filter == option ? .bold : .semibold))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(
                            filter == option ? AppPalette.accent.opacity(0.14) : Color.clear,
                            in: Capsule()
                        )
                        .foregroundStyle(filter == option ? AppPalette.accent : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(filter == option ? .isSelected : [])
                }
                if attentionCount > 0, filter == .attention {
                    Button("Mark All Read") {
                        Task { await markAllVisibleUnread() }
                    }
                    .font(.appCaption.weight(.semibold))
                    .frame(minHeight: 44)
                    .disabled(!ackingIds.isEmpty)
                }
            }
        }
    }

    private func markOne(_ item: NotificationHistoryItem) async {
        guard !item.read else { return }
        ackingIds.insert(item.id)
        defer { ackingIds.remove(item.id) }
        await markRead([item.id])
    }

    private func markAllVisibleUnread() async {
        let ids = visible.filter { !$0.read }.map(\.id)
        guard !ids.isEmpty else { return }
        ackingIds.formUnion(ids)
        defer { ackingIds.subtract(ids) }
        await markRead(ids)
    }
}

private struct NotificationsLedgerSection: View {
    let snapshot: MobileSnapshot
    let markRead: ([String]) async -> Void

    @State private var ackingIds: Set<String> = []

    private var activeAccountId: String? {
        snapshot.readiness.activeConnectedAccount?.id ?? snapshot.policy.connectedAccountId
    }

    private var visible: [NotificationHistoryItem] {
        Array(snapshot.inScopeNotifications(activeAccountId: activeAccountId).prefix(40))
    }

    var body: some View {
        VStack(spacing: 12) {
            SectionHeading("Notifications", subtitle: "Every send this app made — push, email, or otherwise.")
            if visible.isEmpty {
                EmptyStateCard(
                    title: "No Delivery Records Yet",
                    message: "No delivery records yet.",
                    systemImage: "bell"
                )
            } else {
                ForEach(visible) { item in
                    NotificationHistoryRow(
                        item: item,
                        acking: ackingIds.contains(item.id),
                        markRead: { await markOne(item) }
                    )
                }
            }
        }
    }

    private func markOne(_ item: NotificationHistoryItem) async {
        guard !item.read else { return }
        ackingIds.insert(item.id)
        defer { ackingIds.remove(item.id) }
        await markRead([item.id])
    }
}

private struct NotificationHistoryRow: View {
    let item: NotificationHistoryItem
    let acking: Bool
    let markRead: () async -> Void

    var body: some View {
        AppCard(padding: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.appHeadline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    StatusPill(
                        item.readLabel,
                        color: item.read ? .secondary : AppPalette.accent,
                        systemImage: item.read ? "envelope.open" : "envelope.badge"
                    )
                }
                if !item.body.isEmpty {
                    Text(item.body)
                        .font(.appSubheadline)
                        .foregroundStyle(item.type == "run_failed" ? AppPalette.negative : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    if let channel = item.channel, !channel.isEmpty {
                        Text(channel)
                            .font(.appFootnote)
                            .foregroundStyle(.tertiary)
                    }
                    Text(AppFormat.dateTime(item.createdAt))
                        .font(.appFootnote)
                        .foregroundStyle(.secondary)
                    if let account = item.accountLabel, !account.isEmpty {
                        Text(account)
                            .font(.appFootnote)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if !item.read {
                        Button {
                            Task { await markRead() }
                        } label: {
                            if acking {
                                ProgressView()
                            } else {
                                Text("Mark as Read")
                            }
                        }
                        .font(.appCaption.weight(.semibold))
                        .disabled(acking)
                        .accessibilityLabel("Mark as Read")
                    }
                }
            }
        }
        .opacity(item.read ? 0.72 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title), \(item.readLabel), \(AppFormat.dateTime(item.createdAt))")
    }
}

private struct StrategyRunsSection: View {
    let snapshot: MobileSnapshot

    private var accountLabelById: [String: String] {
        Dictionary(snapshot.connectedAccounts.map { ($0.id, $0.label) }, uniquingKeysWith: { _, last in last })
    }

    var body: some View {
        VStack(spacing: 12) {
            SectionHeading("Strategy Runs", subtitle: "Each evaluation of the account, newest first.")
            SchedulerActivityCard(snapshot: snapshot)
            if snapshot.strategyRuns.isEmpty {
                EmptyStateCard(
                    title: "No Strategy Runs Yet",
                    message: "No strategy runs yet.",
                    systemImage: "arrow.triangle.2.circlepath"
                )
            } else {
                ForEach(snapshot.strategyRuns) { run in
                    StrategyRunRow(
                        run: run,
                        accountLabel: run.connectedAccountId.flatMap { accountLabelById[$0] }
                    )
                }
            }
        }
    }
}

private struct SchedulerActivityCard: View {
    @EnvironmentObject private var store: MobileStore
    let snapshot: MobileSnapshot

    private var runState: RunStateWord { store.deriveRunState(for: snapshot) }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Scheduler")
                        .font(.appHeadline)
                    Spacer()
                    StatusPill(
                        runState.rawValue,
                        color: runState.pillColor,
                        systemImage: "timer"
                    )
                }
                LabeledContent("Last Run", value: AppFormat.lastRun(snapshot.scheduler.lastRunAt))
                LabeledContent(
                    "Next Run",
                    value: AppFormat.nextRun(
                        snapshot.scheduler.nextRunAt,
                        autonomyActive: snapshot.policy.systemState == "active"
                    )
                )
            }
        }
    }
}

private struct StrategyRunRow: View {
    let run: StrategyRunItem
    let accountLabel: String?

    private var statusColor: Color {
        switch run.status {
        case "failed": return AppPalette.negative
        case "running": return AppPalette.accent
        case "skipped", "skipped_budget", "skipped_market_closed", "skipped_broker_unhealthy":
            return AppPalette.warning
        default: return AppPalette.positive
        }
    }

    private var statusLabel: String {
        switch run.status {
        case "failed": return "Failed"
        case "running": return "Running"
        case "skipped": return "Skipped"
        case "skipped_budget": return "Skipped · Budget"
        case "skipped_market_closed": return "Skipped · Market Closed"
        case "skipped_broker_unhealthy": return "Skipped · Broker"
        default: return "Completed"
        }
    }

    var body: some View {
        AppCard(padding: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Strategy Run")
                        .font(.appHeadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    StatusPill(statusLabel, color: statusColor, systemImage: "arrow.triangle.2.circlepath")
                }
                Text(metaLine)
                    .font(.appFootnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(countLine)
                    .font(.appCaption)
                    .foregroundStyle(.tertiary)
                if let failure = run.failure, !failure.isEmpty {
                    Text("Failure.  \(failure)")
                        .font(.appSubheadline)
                        .foregroundStyle(AppPalette.negative)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let summary = run.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Strategy Run, \(statusLabel)")
    }

    private var metaLine: String {
        var parts = ["Started \(AppFormat.dateTime(run.startedAt))"]
        if let finished = run.finishedAt {
            parts.append("Completed \(AppFormat.dateTime(finished))")
        }
        if let accountLabel, !accountLabel.isEmpty {
            parts.append(accountLabel)
        }
        return parts.joined(separator: " · ")
    }

    private var countLine: String {
        var parts = ["\(run.proposedCount) proposed", "\(run.placedCount) placed"]
        if run.paperCount > 0 { parts.append("\(run.paperCount) paper") }
        parts.append("\(run.blockedCount) blocked")
        return parts.joined(separator: " · ")
    }
}

private struct FillActivitySection: View {
    let fills: [FillEvent]
    @Binding var presentedItem: PresentedMarketItem?

    private var recentFills: [FillEvent] {
        Array(fills.sorted { $0.filledAt > $1.filledAt }.prefix(20))
    }

    var body: some View {
        VStack(spacing: 12) {
            SectionHeading("Order Fills", subtitle: "Most recent executions.")
            if recentFills.isEmpty {
                EmptyStateCard(
                    title: "No Order Fills Yet",
                    message: "No order fills yet.",
                    systemImage: "tray"
                )
            } else {
                ForEach(recentFills) { fill in
                    FillActivityRow(fill: fill, presentedItem: $presentedItem)
                }
            }
        }
    }
}

private struct FillActivityRow: View {
    let fill: FillEvent
    @Binding var presentedItem: PresentedMarketItem?

    var body: some View {
        Button {
            presentedItem = .fill(fill)
        } label: {
            AppCard(padding: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            TickerLogo(symbol: fill.symbol, size: 30)
                            Text(fill.symbol)
                                .font(.appTitle3.weight(.bold))
                            Text(fill.side.uppercased())
                                .font(.appCaption.weight(.semibold))
                                .foregroundStyle(sideColor)
                        }
                        Text("\(AppFormat.number(fill.quantity)) @ \(AppFormat.money(fill.price))")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(AppFormat.money(fill.notional))
                            .font(.appTitle3.weight(.semibold))
                        Text(AppFormat.dateTime(fill.filledAt))
                            .font(.appFootnote)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 6)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(fill.symbol) \(fill.side) fill")
        .accessibilityHint("Opens fill and company details")
    }

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }
}

private struct AuditLogSection: View {
    let items: [ActivityAuditItem]

    var body: some View {
        VStack(spacing: 12) {
            SectionHeading("Audit Log", subtitle: "The decision journal, grouped by day.")
            if items.isEmpty {
                EmptyStateCard(
                    title: "No Audit Events Yet",
                    message: "No audit events yet.",
                    systemImage: "list.bullet.rectangle"
                )
            } else {
                ForEach(items) { item in
                    AuditLogRow(item: item)
                }
            }
        }
    }
}

private struct AuditLogRow: View {
    let item: ActivityAuditItem

    private var statusColor: Color {
        switch item.status {
        case "failed": return AppPalette.negative
        case "filled", "completed", "placed", "sent": return AppPalette.positive
        case "pending", "pending_approval", "running": return AppPalette.accent
        case "skipped", "blocked", "pending_reconciliation": return AppPalette.warning
        default: return .secondary
        }
    }

    var body: some View {
        AppCard(padding: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.appHeadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    if !item.status.isEmpty {
                        StatusPill(item.status.replacingOccurrences(of: "_", with: " ").capitalized, color: statusColor)
                    }
                }
                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let failure = item.failure, !failure.isEmpty, failure != item.detail {
                    Text("Failure.  \(failure)")
                        .font(.appSubheadline)
                        .foregroundStyle(AppPalette.negative)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text(AppFormat.dateTime(item.updatedAt))
                        .font(.appFootnote)
                        .foregroundStyle(.secondary)
                    if let account = item.accountLabel, !account.isEmpty {
                        Text(account)
                            .font(.appFootnote)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.title)
    }
}

enum NotificationHistoryFilter: String, CaseIterable, Identifiable {
    case unread = "Unread"
    case all = "All"

    var id: String { rawValue }
}

/// Header-inbox counterpart of the website `NotificationInbox`.  Same persisted rows as
/// the Activity Notifications card, presented from the bell on every tab.
struct NotificationsInboxView: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.dismiss) private var dismiss
    @State private var notificationFilter: NotificationHistoryFilter = .unread

    var body: some View {
        NavigationStack {
            Group {
                if let snapshot = store.snapshot {
                    ScrollView {
                        NotificationHistorySection(
                            snapshot: snapshot,
                            filter: $notificationFilter,
                            markRead: { ids in
                                await store.acknowledgeNotifications(ids: ids)
                            }
                        )
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                    .background(AppPalette.background)
                } else {
                    ContentUnavailableView(
                        "Notifications",
                        systemImage: "bell",
                        description: Text("Alerts you can open later will appear here after they are sent.")
                    )
                }
            }
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct NotificationHistorySection: View {
    let snapshot: MobileSnapshot
    @Binding var filter: NotificationHistoryFilter
    let markRead: ([String]) async -> Void

    @State private var ackingIds: Set<String> = []

    private var activeAccountId: String? {
        snapshot.readiness.activeConnectedAccount?.id ?? snapshot.policy.connectedAccountId
    }

    private var scoped: [NotificationHistoryItem] {
        snapshot.inScopeNotifications(activeAccountId: activeAccountId)
    }

    private var visible: [NotificationHistoryItem] {
        let rows = filter == .unread ? scoped.filter { !$0.read } : scoped
        return Array(rows.prefix(40))
    }

    private var unreadCount: Int {
        scoped.filter { !$0.read }.count
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading(
                "Notifications",
                subtitle: "Alerts you can open later.  Refresh still shows them."
            )
            filterRow
            if visible.isEmpty {
                EmptyStateCard(
                    title: filter == .unread ? "No Unread Notifications" : "No Notifications Yet",
                    message: filter == .unread
                        ? "Nothing unread for this account.  Switch to All to see earlier alerts."
                        : "Fills, blocks, and run alerts will appear here after they are sent.",
                    systemImage: "bell"
                )
            } else {
                ForEach(visible) { item in
                    NotificationHistoryRow(
                        item: item,
                        acking: ackingIds.contains(item.id),
                        markRead: { await markOne(item) }
                    )
                }
            }
        }
    }

    private var filterRow: some View {
        HStack(spacing: 8) {
            ForEach(NotificationHistoryFilter.allCases) { option in
                Button {
                    filter = option
                } label: {
                    HStack(spacing: 6) {
                        Text(option.rawValue)
                        if option == .unread {
                            Text("\(unreadCount)")
                                .font(.appCaption2.weight(.bold))
                        }
                    }
                    .font(.appCaption.weight(filter == option ? .bold : .semibold))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(
                        filter == option ? AppPalette.accent.opacity(0.14) : Color.clear,
                        in: Capsule()
                    )
                    .foregroundStyle(filter == option ? AppPalette.accent : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(filter == option ? .isSelected : [])
            }
            Spacer()
            if unreadCount > 0 {
                Button("Mark All Read") {
                    Task { await markAllVisibleUnread() }
                }
                .font(.appCaption.weight(.semibold))
                .disabled(!ackingIds.isEmpty)
            }
        }
    }

    private func markOne(_ item: NotificationHistoryItem) async {
        guard !item.read else { return }
        ackingIds.insert(item.id)
        defer { ackingIds.remove(item.id) }
        await markRead([item.id])
    }

    private func markAllVisibleUnread() async {
        let ids = visible.filter { !$0.read }.map(\.id)
        guard !ids.isEmpty else { return }
        ackingIds.formUnion(ids)
        defer { ackingIds.subtract(ids) }
        await markRead(ids)
    }
}

