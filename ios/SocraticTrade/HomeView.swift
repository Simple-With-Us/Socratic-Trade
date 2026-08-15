import SwiftUI

struct HomeView: View {
    @Binding var selectedTab: AppTab
    @State private var presentedSheet: HomeSheet?

    var body: some View {
        SnapshotScaffold { snapshot in
            let readinessIncomplete = !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse
            if readinessIncomplete {
                ReadinessChecklistHero(
                    snapshot: snapshot,
                    openSettings: { presentedSheet = .settings }
                )
                // Agent overview only during setup — once ready, ReadyHomeHero already
                // shows account, state, and authority (duplicate card was pure noise).
                AgentOverviewCard(snapshot: snapshot, showInlineReadiness: true)
            } else {
                ReadyHomeHero(snapshot: snapshot) {
                    selectedTab = .proposals
                }
            }
            StrategyControlsCard(snapshot: snapshot)
            PortfolioOverviewCard(snapshot: snapshot)
            PerformanceOverviewCard(snapshot: snapshot, selectedTab: $selectedTab)
            DeskShortcutsCard(selectedTab: $selectedTab)
            ScheduleOverviewCard(snapshot: snapshot)
            HomeAttentionCard(snapshot: snapshot, selectedTab: $selectedTab)
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    presentedSheet = .settings
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account and settings")
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .settings:
                AccountSettingsView()
            }
        }
    }
}

/// Incomplete setup: checklist hero with CTAs (Account & Settings / universe instructions).
private struct ReadinessChecklistHero: View {
    let snapshot: MobileSnapshot
    let openSettings: () -> Void

    private var needsAccount: Bool { !snapshot.readiness.hasAccount }
    private var needsUniverse: Bool { !snapshot.readiness.hasUniverse }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(AppPalette.accent.opacity(0.14))
                        Image(systemName: "checklist")
                            .font(.appTitle3.weight(.semibold))
                            .foregroundStyle(AppPalette.accent)
                    }
                    .frame(width: 44, height: 44)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Finish setup to trade")
                            .font(.appTitle3.weight(.bold))
                        Text("Phone is a control remote — connect an account and symbol universe, then Run Once.")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    ChecklistRow(
                        done: !needsAccount,
                        title: "Connect a broker account",
                        detail: needsAccount
                            ? "Link Alpaca or Robinhood in the full desk, then select it here."
                            : (snapshot.readiness.activeConnectedAccount?.label ?? "Account ready")
                    )
                    ChecklistRow(
                        done: !needsUniverse,
                        title: "Add a symbol universe",
                        detail: needsUniverse
                            ? "In Socratic.Trade console → Strategy, include an index or symbols."
                            : "Universe ready for strategy runs"
                    )
                }

                if needsAccount {
                    Button(action: openSettings) {
                        Label("Account & Settings", systemImage: "person.crop.circle")
                            .font(.appBody.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppPalette.accent)
                } else if needsUniverse {
                    Text("Open the desktop console to edit Strategy universe (indices + extra symbols), then pull to refresh here.")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct ChecklistRow: View {
    let done: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? AppPalette.positive : AppPalette.warning)
                .font(.appBody.weight(.semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.appSubheadline.weight(.semibold))
                Text(detail)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Ready state: equity + open P&L + agent state + primary CTA (Run once or Review N proposals).
private struct ReadyHomeHero: View {
    @EnvironmentObject private var store: MobileStore
    let snapshot: MobileSnapshot
    let onReviewProposals: () -> Void

    private var usesLiveMetrics: Bool {
        AccountMetrics.usesLiveMetrics(environment: store.displayedActiveAccount(in: snapshot)?.environment)
    }

    private var openPnl: Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics ? $0.liveUnrealizedPnl : $0.paperUnrealizedPnl
        }
        return AccountMetrics.displayedUnrealized(positions: snapshot.positions, ledger: ledger)
    }

    private var pendingCount: Int { snapshot.pendingProposals.count }

    /// Console-shared run-state word — market-aware, so this pill can never claim
    /// "Running" while the console says "Paused · market closed".
    private var runState: RunStateWord { deriveRunStateWord(snapshot: snapshot) }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            // Paper-only badge — owner does not want "Live" called out (paper is still real capital).
                            if store.displayedActiveAccount(in: snapshot)?.environment.lowercased() == "paper" {
                                StatusPill(
                                    "PAPER",
                                    color: AppPalette.accent.opacity(0.85),
                                    systemImage: "doc.text"
                                )
                            }
                            Text(store.displayedActiveAccount(in: snapshot)?.label ?? "Ready")
                                .font(.appCaption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Text(AppFormat.money(snapshot.portfolio?.totalMarketValue))
                            .font(.appLargeTitle.weight(.bold))
                            .foregroundStyle(AppPalette.accent)
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                        Text("Equity")
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        StatusPill(
                            runState.rawValue,
                            color: runState.pillColor,
                            systemImage: runState.pillSystemImage
                        )
                        Text(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority))
                            .font(.appCaption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Open P&L",
                        value: AppFormat.money(openPnl),
                        tint: pnlColor(openPnl)
                    )
                    MetricTile(
                        title: "Proposals",
                        value: "\(pendingCount)",
                        detail: pendingCount == 0 ? "none waiting" : "Awaiting Review",
                        tint: pendingCount > 0 ? AppPalette.warning : AppPalette.accent
                    )
                }

                primaryCTA
            }
        }
    }

    @ViewBuilder
    private var primaryCTA: some View {
        if pendingCount > 0 {
            Button(action: onReviewProposals) {
                Label(
                    pendingCount == 1 ? "Review 1 Proposal" : "Review \(pendingCount) Proposals",
                    systemImage: "checklist"
                )
                .font(.appBody.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppPalette.accent)
            .accessibilityHint("Opens the Proposals tab to approve or reject")
        } else {
            CommandButton(
                "Run Once",
                systemImage: "sparkles",
                isBusy: store.isBusy("strategy.run_once"),
                isDisabled: !store.canSubmit("strategy.run_once"),
                prominent: true
            ) {
                Task { await store.submit("strategy.run_once") }
            }
        }
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private enum HomeSheet: String, Identifiable {
    case settings

    var id: String { rawValue }
}

private struct AgentOverviewCard: View {
    let snapshot: MobileSnapshot
    var showInlineReadiness: Bool = true

    private var runState: RunStateWord { deriveRunStateWord(snapshot: snapshot) }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Socratic agent")
                            .font(.appTitle2.weight(.bold))
                        Text(snapshot.readiness.activeConnectedAccount?.label ?? "No active account")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(
                        runState.rawValue,
                        color: runState.pillColor,
                        systemImage: runState.pillSystemImage
                    )
                }

                Divider()

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 20) {
                        statusLabels
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        statusLabels
                    }
                }
                .font(.appCaption.weight(.medium))
                .foregroundStyle(.secondary)

                if showInlineReadiness, !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(AppPalette.warning)
                        Text(readinessMessage)
                            .font(.appSubheadline)
                    }
                }
            }
        }
    }

    private var readinessMessage: String {
        if !snapshot.readiness.hasAccount {
            return "Connect an account in Socratic.Trade, then select it in Account & Settings before running the agent."
        }
        return "Add an index or symbol universe before requesting a strategy run."
    }

    @ViewBuilder
    private var statusLabels: some View {
        Label(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority), systemImage: "person.badge.shield.checkmark")
        Label(AppFormat.marketSessionBannerLabel(snapshot.marketSession), systemImage: "chart.line.uptrend.xyaxis")
    }
}

private struct StrategyControlsCard: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot

    /// ReadyHomeHero already owns the primary "Run once" CTA when setup is complete
    /// and nothing is pending review. Duplicating it here put two identical buttons
    /// within ~1 inch (owner report). Keep Run once here only when the hero does not:
    /// incomplete setup (checklist hero) or pending proposals (hero says "Review N").
    private var heroOwnsRunOnce: Bool {
        let ready = snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        return ready && snapshot.pendingProposals.isEmpty
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeading(
                    "Agent Controls",
                    subtitle: heroOwnsRunOnce
                        ? "Start scheduled autonomy or stop broker submissions.  Run Once is the primary button above."
                        : "Every action is validated and executed by the backend."
                )

                if heroOwnsRunOnce {
                    startButton
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            runOnceButton
                            startButton
                        }
                        VStack(spacing: 10) {
                            runOnceButton
                            startButton
                        }
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        closeOnlyButton
                        windDownButton
                    }
                    VStack(spacing: 10) {
                        closeOnlyButton
                        windDownButton
                    }
                }

                CommandButton(
                    "Stop Agent",
                    systemImage: "stop.fill",
                    isBusy: store.isBusy("strategy.stop"),
                    role: .destructive
                ) {
                    submit("strategy.stop")
                }
                .tint(AppPalette.negative)

                Text("Close Only stops new buys while protective exits keep working.  Wind Down submits only sell orders until the account is in cash.  Stop immediately halts future broker submissions.  A broker request already submitted before the halt may still complete; review existing orders under Assets.")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running > 0 {
                    Text("\(snapshot.readiness.commandBacklog.queued) queued · \(snapshot.readiness.commandBacklog.running) running")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func submit(_ command: String) {
        Task { await store.submit(command) }
    }

    private var runOnceButton: some View {
        CommandButton(
            "Run Once",
            systemImage: "sparkles",
            isBusy: store.isBusy("strategy.run_once"),
            isDisabled: !store.canSubmit("strategy.run_once"),
            prominent: true
        ) {
            submit("strategy.run_once")
        }
    }

    private var startButton: some View {
        CommandButton(
            "Start Agent",
            systemImage: "play.fill",
            isBusy: store.isBusy("strategy.start"),
            isDisabled: !store.canSubmit("strategy.start")
        ) {
            submit("strategy.start")
        }
    }

    // Protective de-risk states (labels match AppFormat.commandLabels; the store always
    // allows protective commands, same as Stop — no extra ceremony beyond existing controls).
    private var closeOnlyButton: some View {
        CommandButton(
            "Close Only",
            systemImage: "arrow.down.right.circle",
            isBusy: store.isBusy("strategy.close_only")
        ) {
            submit("strategy.close_only")
        }
        .tint(AppPalette.warning)
    }

    private var windDownButton: some View {
        CommandButton(
            "Wind Down",
            systemImage: "tray.and.arrow.down",
            isBusy: store.isBusy("strategy.liquidating")
        ) {
            submit("strategy.liquidating")
        }
        .tint(AppPalette.warning)
    }
}

private struct PortfolioOverviewCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Portfolio")
            if let portfolio = snapshot.portfolio {
                LazyVGrid(columns: columns, spacing: 10) {
                    MetricTile(title: "Equity", value: AppFormat.money(portfolio.totalMarketValue))
                    MetricTile(title: "Buying Power", value: AppFormat.money(portfolio.buyingPower))
                    MetricTile(title: "Cash", value: AppFormat.money(portfolio.cash))
                    MetricTile(
                        title: "Positions",
                        value: "\(snapshot.positions.count)",
                        detail: "open holdings",
                        detailPlacement: .trailing
                    )
                }
            } else {
                EmptyStateCard(
                    title: "No portfolio available",
                    message: "Select a connected account or retry when the broker is reachable.",
                    systemImage: "briefcase"
                )
            }
        }
    }

    private var columns: [GridItem] {
        [GridItem(.flexible()), GridItem(.flexible())]
    }
}

private struct DeskShortcutsCard: View {
    @Binding var selectedTab: AppTab

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Desk", subtitle: "full surfaces, not just the remote")
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    shortcut("Coach", systemImage: "bubble.left.and.bubble.right.fill", tab: .coach)
                    shortcut("Scan", systemImage: "tablecells", tab: .scan)
                    shortcut("Guardrails", systemImage: "shield.checkered", tab: .guardrails)
                    shortcut("Results", systemImage: "chart.xyaxis.line", tab: .results)
                }
            }
        }
    }

    private func shortcut(_ title: String, systemImage: String, tab: AppTab) -> some View {
        Button {
            selectedTab = tab
        } label: {
            Label(title, systemImage: systemImage)
                .font(.appSubheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(AppPalette.accent)
    }
}

private struct PerformanceOverviewCard: View {
    @EnvironmentObject private var store: MobileStore
    let snapshot: MobileSnapshot
    @Binding var selectedTab: AppTab

    private var usesLiveMetrics: Bool {
        AccountMetrics.usesLiveMetrics(environment: store.displayedActiveAccount(in: snapshot)?.environment)
    }

    private var realized: Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics ? $0.liveRealizedPnl : $0.paperRealizedPnl
        }
        let hasFills = (snapshot.performance?.fills?.isEmpty == false)
        return AccountMetrics.displayedRealized(ledger: ledger, hasFillHistory: hasFills)
    }

    private var unrealized: Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics ? $0.liveUnrealizedPnl : $0.paperUnrealizedPnl
        }
        return AccountMetrics.displayedUnrealized(positions: snapshot.positions, ledger: ledger)
    }

    private var accountSubtitle: String? {
        if store.pendingAccountId != nil {
            return "refreshing the selected account"
        }
        guard let account = store.displayedActiveAccount(in: snapshot) else {
            return "no active account"
        }
        // Paper only — never "live account" (owner: all accounts are real; paper is the exception).
        if account.environment.lowercased() == "paper" {
            return AppFormat.accountBrokerEnvironmentLine(broker: account.broker, environment: account.environment)
        }
        return nil
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeading("Performance", subtitle: accountSubtitle)
                Spacer()
                Button("See Results") { selectedTab = .results }
                    .font(.appCaption.weight(.semibold))
            }
            if let performance = snapshot.performance {
                LazyVGrid(columns: columns, spacing: 10) {
                    MetricTile(
                        title: "Realized P&L",
                        value: AppFormat.money(realized),
                        tint: pnlColor(realized)
                    )
                    MetricTile(
                        title: "Unrealized P&L",
                        value: AppFormat.money(unrealized),
                        tint: pnlColor(unrealized)
                    )
                    MetricTile(
                        title: "Win Rate",
                        value: AppFormat.percent(usesLiveMetrics ? performance.liveWinRate : performance.paperWinRate)
                    )
                    MetricTile(
                        title: "Avg. Return",
                        value: AppFormat.percent(
                            usesLiveMetrics ? performance.liveAverageReturnPct : performance.paperAverageReturnPct,
                            signed: true
                        )
                    )
                }

                if let benchmark = performance.benchmark {
                    AppCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("vs \(benchmark.benchmarkSymbol)")
                                        .font(.appCaption)
                                        .foregroundStyle(.secondary)
                                    Text(AppFormat.percent(benchmark.excessReturnPct, signed: true))
                                        .font(.appHeadline)
                                        .foregroundStyle(pnlColor(benchmark.excessReturnPct))
                                }
                                Spacer()
                                Text("\(benchmark.points) observations")
                                    .font(.appCaption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(
                                "You \(AppFormat.percent(benchmark.accountReturnPct, signed: true)) · \(benchmark.benchmarkSymbol) \(AppFormat.percent(benchmark.benchmarkReturnPct, signed: true))"
                            )
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            Text("account return minus \(benchmark.benchmarkSymbol) over the same window (cash flows neutralized).")
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                EmptyStateCard(
                    title: "No performance history",
                    message: "Performance appears after the selected account has fills or portfolio snapshots.",
                    systemImage: "chart.xyaxis.line"
                )
            }
        }
    }

    private var columns: [GridItem] {
        [GridItem(.flexible()), GridItem(.flexible())]
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private struct ScheduleOverviewCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading("Schedule")
                LabeledContent("Last Run", value: AppFormat.relative(snapshot.scheduler.lastRunAt))
                LabeledContent("Next Run", value: AppFormat.relative(snapshot.scheduler.nextRunAt))
                LabeledContent(
                    "Cadence",
                    value: AppFormat.cadenceMinutesValue(snapshot.policy.runCadenceMinutes)
                )
            }
        }
    }
}

private struct HomeAttentionCard: View {
    let snapshot: MobileSnapshot
    @Binding var selectedTab: AppTab

    private var armedAlerts: Int {
        snapshot.alerts.filter { $0.status == "armed" }.count
    }

    private var commandsInFlight: Int {
        snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeading("Needs Attention")
                    .padding(.bottom, 8)
                AttentionRow(
                    title: "Pending Proposals",
                    value: "\(snapshot.pendingProposals.count)",
                    emphasize: snapshot.pendingProposals.count > 0
                ) {
                    selectedTab = .proposals
                }
                AttentionRow(
                    title: "Armed Price Alerts",
                    value: "\(armedAlerts)",
                    emphasize: armedAlerts > 0
                ) {
                    selectedTab = .markets
                }
                AttentionRow(
                    title: "Open Orders",
                    value: "\(snapshot.orders.count)",
                    emphasize: snapshot.orders.count > 0
                ) {
                    selectedTab = .markets
                }
                AttentionRow(
                    title: "Commands in flight",
                    value: "\(commandsInFlight)",
                    emphasize: commandsInFlight > 0
                ) {
                    selectedTab = .activity
                }
            }
        }
    }
}

private struct AttentionRow: View {
    let title: String
    let value: String
    var emphasize: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                Text(value)
                    .fontWeight(emphasize ? .semibold : .regular)
                    .foregroundStyle(emphasize ? AppPalette.accent : .secondary)
                Image(systemName: "chevron.right")
                    .font(.appCaption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the related tab")
    }
}

private struct AccountSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var store: MobileStore
    @EnvironmentObject private var push: PushNotificationCoordinator

    @State private var deleteIdentity = ""
    @State private var deletePhrase = ""
    @State private var showingAdminPortal = false

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                accountsSection
                alertsSection
                policySection
                GuardrailTighteningSection()
                DataSourcesSection()
                adminSection
                sessionSection
                deletionSection
            }
            .navigationTitle("Account & Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showingAdminPortal) {
                AdminPortalView()
            }
        }
    }

    /// Owner-only row — rendered solely when the server marks the session admin.
    @ViewBuilder
    private var adminSection: some View {
        if store.snapshot?.currentUser?.isAdmin == true {
            Section("Admin") {
                Button {
                    showingAdminPortal = true
                } label: {
                    Label("Admin Portal", systemImage: "wrench.and.screwdriver")
                }
            }
        }
    }

    @ViewBuilder
    private var identitySection: some View {
        Section("User Info") {
            LabeledContent("Name", value: store.snapshot?.currentUser?.name ?? "—")
            LabeledContent("Email", value: store.snapshot?.currentUser?.email ?? "—")
            LabeledContent(
                "Provider",
                value: store.snapshot?.currentUser?.loginProvider.map { $0.lowercased() } ?? "not reported"
            )
        }
    }

    @ViewBuilder
    private var accountsSection: some View {
        Section("Connected Accounts") {
            if store.pendingAccountId != nil {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        if store.isRefreshing || store.hasActiveCommandWork {
                            ProgressView()
                        }
                        Text("Switching accounts — portfolio reload can take a few seconds.")
                            .font(.appFootnote)
                            .foregroundStyle(.secondary)
                    }
                    if !store.isRefreshing && !store.hasActiveCommandWork {
                        Button("Retry Portfolio Refresh") {
                            Task { await store.load() }
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if let accounts = store.snapshot?.connectedAccounts, !accounts.isEmpty {
                ForEach(accounts) { account in
                    ConnectedAccountSettingsRow(account: account)
                }
            } else {
                Text("No connected accounts.  Connect one in Socratic.Trade, then return here to select it.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var policySection: some View {
        Section("Current Policy") {
            LabeledContent("Authority", value: AppFormat.strategyAuthorityValue(store.snapshot?.policy.strategyAuthority))
            LabeledContent("Horizon", value: AppFormat.policyHorizonValue(store.snapshot?.policy.holdingHorizon))
            LabeledContent("Max Order", value: AppFormat.money(store.snapshot?.policy.maxOrderNotional))
            LabeledContent("Daily Cap", value: AppFormat.money(store.snapshot?.policy.maxDailyNotional))
            LabeledContent("Daily Orders", value: store.snapshot?.policy.maxDailyOrders.map(String.init) ?? "—")
            NavigationLink {
                GuardrailsView()
            } label: {
                Label("View Full Policy", systemImage: "shield.checkered")
            }
        }
    }

    /// Push state, stated plainly.  If the prompt was denied or the registration failed, this
    /// says so — the app never implies alerts are arriving when they are not.
    @ViewBuilder
    private var alertsSection: some View {
        Section {
            LabeledContent("Push Alerts") {
                Text(push.state.isWorking ? "On" : "Off")
                    .foregroundStyle(push.state.isWorking ? AppPalette.positive : .secondary)
            }
            switch push.state {
            case .notRequested, .unknown:
                Button("Turn On Alerts") {
                    Task { await push.requestAuthorization() }
                }
            case .denied:
                Button("Open iOS Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url)
                    }
                }
            case .failed:
                Button("Try Again") {
                    Task { await push.registerIfAlreadyAuthorized() }
                }
            case .awaitingToken, .registered:
                EmptyView()
            }
        } header: {
            Text("Alerts")
        } footer: {
            Text(push.state.summary)
        }
        .task { await push.refreshState() }
    }

    private var sessionSection: some View {
        Section {
            Button("Sign Out", role: .destructive) {
                Task {
                    await store.signOut()
                    dismiss()
                }
            }
        } footer: {
            Text("Signing out clears the app’s local Socratic.Trade session.  Broker and provider credentials remain on the backend.")
        }
    }

    @ViewBuilder
    private var deletionSection: some View {
        Section {
            if let deletion = store.deletionRequest {
                ForEach(Array(deletion.steps.enumerated()), id: \.offset) { index, step in
                    Label(step, systemImage: "\(index + 1).circle")
                        .font(.appSubheadline)
                }

                TextField(deletion.email ?? deletion.userId, text: $deleteIdentity)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField(deletion.requiredText, text: $deletePhrase)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()

                Button("Delete Account and Sign Out", role: .destructive) {
                    confirmDeletion()
                }
                .disabled(deletionConfirmationDisabled(deletion))

                Button("Hide Deletion Details") {
                    store.clearAccountDeletionPreview()
                    deleteIdentity = ""
                    deletePhrase = ""
                }
            } else {
                Button("Review Account Deletion", role: .destructive) {
                    Task { await store.loadAccountDeletionPreview() }
                }
                .disabled(store.isDeletingAccount)
            }
        } header: {
            Text("Delete Account")
        } footer: {
            Text("Reviewing is read-only and does not pause the agent.  Final confirmation prepares and deletes this app account, its server-stored secrets, proposals, fills, watchlists, alerts, and learned context.  Provider-side OAuth grants must be revoked separately.")
        }
    }

    private func deletionConfirmationDisabled(_ deletion: AccountDeletionRequest) -> Bool {
        store.isDeletingAccount ||
        deleteIdentity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() !=
            (deletion.email ?? deletion.userId).lowercased() ||
        deletePhrase.trimmingCharacters(in: .whitespacesAndNewlines) != deletion.requiredText
    }

    private func confirmDeletion() {
        Task {
            if let logoutURL = await store.confirmAccountDeletion(
                typedIdentity: deleteIdentity,
                typedText: deletePhrase
            ) {
                openURL(logoutURL)
                dismiss()
            }
        }
    }
}

private struct ConnectedAccountSettingsRow: View {
    @EnvironmentObject private var store: MobileStore
    @State private var confirmingLiveActivation = false

    let account: ConnectedAccount

    private var operationID: String { "account.activate:\(account.id)" }
    private var canActivate: Bool { store.canSubmit("account.activate") }

    /// Quiet sentence-case capability summary, e.g. "cash · margin · shorting · options L2".
    private var capabilitiesLine: String? {
        guard let capabilities = account.capabilities else { return nil }
        var parts: [String] = []
        if let accountType = capabilities.accountType, !accountType.isEmpty {
            parts.append(AppFormat.accountTypeWord(accountType))
        }
        if capabilities.marginEnabled == true { parts.append("margin") }
        if capabilities.shortSelling == true { parts.append("shorting") }
        if capabilities.optionsTrading == true {
            if let level = capabilities.optionsLevel {
                parts.append("options L\(level)")
            } else {
                parts.append("options")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(account.label)
                    .font(.appBody.weight(.medium))
                Text(AppFormat.accountBrokerEnvironmentLine(broker: account.broker, environment: account.environment))
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                if let capabilitiesLine {
                    Text(capabilitiesLine)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                }
                if account.isDraining == true {
                    Text("draining — existing orders wind down before removal")
                        .font(.appCaption2)
                        .foregroundStyle(AppPalette.warning)
                }
            }
            Spacer()
            if store.isAccountActive(account) {
                if store.pendingAccountId == account.id {
                    HStack(spacing: 8) {
                        ProgressView()
                        StatusPill("Switching", color: AppPalette.accent, systemImage: "arrow.triangle.2.circlepath")
                    }
                    .accessibilityLabel("Switching to \(account.label)")
                } else {
                    StatusPill("Active", color: AppPalette.positive, systemImage: "checkmark")
                }
            } else if store.isBusy(operationID) || store.pendingAccountId == account.id {
                ProgressView()
                    .accessibilityLabel("Switching to \(account.label)")
            } else {
                Button("Use") {
                    // Still confirm before switching to a non-paper brokerage account; wording avoids "Live".
                    if account.environment.lowercased() != "paper" {
                        confirmingLiveActivation = true
                    } else {
                        activate()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppPalette.accent)
                .disabled(!canActivate)
                .opacity(canActivate ? 1 : 0.45)
                .accessibilityHint(canActivate
                    ? "Switch the active account to \(account.label)"
                    : "Unavailable until the app loads account data")
            }
        }
        .alert("Use Brokerage Account?", isPresented: $confirmingLiveActivation) {
            Button("Use Account", role: .destructive, action: activate)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Switch execution context to \(account.label) (\(AppFormat.accountBrokerEnvironmentLine(broker: account.broker, environment: account.environment))).  Future approved actions will target this account after backend validation.")
        }
    }

    private func activate() {
        Task {
            await store.submit(
                "account.activate",
                payload: ["accountId": account.id],
                operationID: operationID
            )
        }
    }
}
