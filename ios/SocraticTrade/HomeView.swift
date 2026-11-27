import SwiftUI
import UIKit

struct HomeView: View {
    @Binding var selectedTab: AppTab
    @State private var presentedSheet: HomeSheet?

    var body: some View {
        SnapshotScaffold { snapshot in
            let readinessIncomplete = !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse
            if readinessIncomplete {
                ReadinessChecklistHero(
                    snapshot: snapshot,
                    openSettings: { presentedSheet = .settings },
                    openGuardrails: { selectedTab = .guardrails }
                )
                .cardSpansAllColumns()
                // Agent overview only during setup — once ready, ReadyHomeHero already
                // shows account, state, and authority (duplicate card was pure noise).
                AgentOverviewCard(snapshot: snapshot, showInlineReadiness: true)
            } else {
                ReadyHomeHero(snapshot: snapshot) {
                    selectedTab = .proposals
                }
                .cardSpansAllColumns()
            }
            StrategyControlsCard(snapshot: snapshot)
            PortfolioOverviewCard(snapshot: snapshot)
            PerformanceOverviewCard(snapshot: snapshot, selectedTab: $selectedTab)
            DeskShortcutsCard(selectedTab: $selectedTab)
            ScheduleOverviewCard(snapshot: snapshot)
            LatestStrategyRunCard(snapshot: snapshot)
            HomeAttentionCard(snapshot: snapshot, selectedTab: $selectedTab)
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .settings:
                AccountSettingsView()
                    .adaptiveWideSheet(phoneDetents: [.large])
            }
        }
    }
}

/// Incomplete setup: checklist hero with CTAs (Open Connections / Open Guardrails).
private struct ReadinessChecklistHero: View {
    let snapshot: MobileSnapshot
    let openSettings: () -> Void
    let openGuardrails: () -> Void

    private var needsAccount: Bool { !snapshot.readiness.hasAccount }
    private var needsUniverse: Bool { !snapshot.readiness.hasUniverse }
    private var needsLlmKey: Bool { !(snapshot.readiness.hasLlmKey ?? true) }

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
                        Text("Connect an account and a symbol universe, then tap Run Once.")
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
                            ? DeskCopy.accountNeedsConnection
                            : (snapshot.readiness.activeConnectedAccount?.label ?? "Account ready")
                    )
                    ChecklistRow(
                        done: !needsUniverse,
                        title: "Add a symbol universe",
                        detail: needsUniverse
                            ? DeskCopy.universeNeedsIndex
                            : "Universe ready for strategy runs"
                    )
                    if needsLlmKey {
                        ChecklistRow(
                            done: false,
                            title: "Add an LLM API key",
                            detail: "Use the website to provide an API key for the strategy agent."
                        )
                    }
                }

                if needsAccount {
                    Text("Broker connections must be configured on the website.")
                        .font(.appBody)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ConsoleHandoffButton(
                        title: DeskCopy.openConnectionsButton,
                        systemImage: "link",
                        url: ConsoleHandoff.connections
                    )
                } else if needsUniverse {
                    Text(DeskCopy.universeRefreshAfterGuardrails)
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(action: openGuardrails) {
                        Label(DeskCopy.openGuardrailsButton, systemImage: "shield.checkered")
                            .font(.appBody.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppPalette.accent)
                }
            }
        }
    }
}

/// Opens a website console page that the phone cannot edit.  Those URLs are not AASA-claimed,
/// so the tap leaves the app instead of looping back to a missing screen.
private struct ConsoleHandoffButton: View {
    @Environment(\.openURL) private var openURL
    let title: String
    let systemImage: String
    let url: URL

    var body: some View {
        Button {
            openURL(url)
        } label: {
            Label(title, systemImage: systemImage)
                .font(.appBody.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(AppPalette.accent)
        .accessibilityHint("Opens the website in Safari")
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
    @Environment(MobileStore.self) private var store
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

    /// `live` / `paper` — the same split every performance figure on this screen uses.
    private var accountMode: String {
        usesLiveMetrics ? "live" : "paper"
    }

    /// Broker-verified day P&L (R2a, OD-10e).  The tile is driven by the server's own
    /// prior-close/flow basis; when that is absent the value is "—" and the tile says why,
    /// rather than presenting an unexplained equity jump as profit.
    private var dayPnl: DayPnl? {
        DayPnlMath.derive(
            curve: usesLiveMetrics
                ? (snapshot.performance?.liveEquityCurve ?? [])
                : (snapshot.performance?.paperEquityCurve ?? []),
            currentEquity: snapshot.portfolio?.totalMarketValue,
            currentCash: snapshot.portfolio?.cash,
            hints: snapshot.performance?.dayPnlHints,
            mode: accountMode
        )
    }

    /// Console-shared run-state word — market-aware, so this pill can never claim
    /// "Running" while the console says "Paused · market closed".
    private var runState: RunStateWord { store.deriveRunState(for: snapshot) }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            // Paper-only badge — owner does not want "Live" called out (paper is still real capital).
                            if store.displayedActiveAccount(in: snapshot)?.environment.lowercased() == "paper" {
                                StatusPill(
                                    DeskCopy.paperAccountWord,
                                    color: AppPalette.accent.opacity(0.75),
                                    systemImage: "doc.text"
                                )
                            }
                            if snapshot.connectedAccounts.count > 1 {
                                AccountSwitcherMenu(snapshot: snapshot)
                            } else {
                                Text(store.displayedActiveAccount(in: snapshot)?.label ?? "Ready")
                                    .font(.appCaption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        if snapshot.portfolio != nil {
                            Text(AppFormat.money(snapshot.portfolio?.totalMarketValue))
                                .font(.appLargeTitle.weight(.bold))
                                .foregroundStyle(AppPalette.accent)
                                .minimumScaleFactor(0.7)
                                .lineLimit(1)
                        } else {
                            // A large-title em-dash reads as a stray bar when the broker
                            // timed out.  Spell the wait instead.
                            Text(DeskCopy.equityWaitingOnBroker)
                                .font(.appTitle3.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .minimumScaleFactor(0.8)
                                .lineLimit(2)
                        }
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

                // Three tiles in one grid: two money figures plus the queue count.  The grid keeps
                // a two-up phone row and widens to three on an iPad instead of squeezing.
                AppMetricGrid(minimumTileWidth: 150) {
                    MetricTile(
                        title: "Open P&L",
                        value: AppFormat.money(openPnl),
                        tint: pnlColor(openPnl)
                    )
                    MetricTile(
                        title: "Today's P&L",
                        value: dayPnl.map { AppFormat.money($0.pnl) } ?? "—",
                        detail: dayPnl?.basis.detail ?? "cash flow not verified",
                        tint: pnlColor(dayPnl?.pnl)
                    )
                    MetricTile(
                        title: "Proposals for Review",
                        value: "\(pendingCount)",
                        tint: pendingCount > 0 ? AppPalette.warning : AppPalette.accent
                    )
                }

                primaryCTA
            }
        }
    }

    /// The hero spans every column, so its action would otherwise be drawn a full window wide.
    /// The cap never binds on a phone — 520pt is wider than any phone card — so nothing about
    /// the iPhone layout moves.
    @ViewBuilder
    private var primaryCTA: some View {
        cta
            .frame(maxWidth: ContentColumns.maximumActionWidth)
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var cta: some View {
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

/// Compact account picker for the Home hero.
///
/// The website console has a one-tap scope picker in its header.  On the phone the only
/// way to switch accounts was gear → sheet → scroll down to Connected Accounts, which is
/// the native parity gap.  It appears only when more than one account is connected, and it
/// switches through the same account-activate command the settings rows use.
private struct AccountSwitcherMenu: View {
    @Environment(MobileStore.self) private var store
    let snapshot: MobileSnapshot

    private var activeAccount: ConnectedAccount? {
        store.displayedActiveAccount(in: snapshot)
    }

    /// Active account first, then the rest — the same order the website picker reads.
    private var orderedAccounts: [ConnectedAccount] {
        let accounts = snapshot.connectedAccounts
        guard let active = activeAccount else { return accounts }
        return [active] + accounts.filter { $0.id != active.id }
    }

    private var isSwitching: Bool { store.pendingAccountId != nil }

    var body: some View {
        Menu {
            ForEach(orderedAccounts) { account in
                Button {
                    Task { await store.activateAccount(account) }
                } label: {
                    Label {
                        Text(label(for: account))
                    } icon: {
                        Image(systemName: store.isAccountActive(account) ? "checkmark" : "circle")
                    }
                }
                .disabled(isSwitching)
            }
        } label: {
            HStack(spacing: 4) {
                Text(triggerLabel)
                    .font(.appCaption.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.appCaption2.weight(.semibold))
            }
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Switch account, \(triggerLabel)")
        .accessibilityHint("Switches which account this app shows")
    }

    private var triggerLabel: String {
        guard let account = activeAccount else { return "Ready" }
        return label(for: account)
    }

    /// "Alpaca Paper — MFK9": the account label plus the last four of the account number,
    /// matching the website console's scope picker.
    private func label(for account: ConnectedAccount) -> String {
        let number = account.accountNumber ?? ""
        guard number.count >= 4 else { return account.label }
        return "\(account.label) — \(number.suffix(4))"
    }
}

private struct AgentOverviewCard: View {
    @Environment(MobileStore.self) private var store
    let snapshot: MobileSnapshot
    var showInlineReadiness: Bool = true

    private var runState: RunStateWord { store.deriveRunState(for: snapshot) }

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
            return DeskCopy.accountNeedsConnectionInline
        }
        return "Add an index or symbol universe before requesting a strategy run."
    }

    @ViewBuilder
    private var statusLabels: some View {
        Label(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority), systemImage: "person.badge.shield.checkmark")
        Label(AppFormat.marketSessionBannerLabel(store.displayMarketSession(for: snapshot)), systemImage: "chart.line.uptrend.xyaxis")
    }
}

private struct StrategyControlsCard: View {
    @Environment(MobileStore.self) private var store

    let snapshot: MobileSnapshot

    /// ReadyHomeHero already owns the primary "Run once" CTA when setup is complete
    /// and nothing is pending review. Duplicating it here put two identical buttons
    /// within ~1 inch (owner report). Keep Run once here only when the hero does not:
    /// incomplete setup (checklist hero) or pending proposals (hero says "Review N").
    private var heroOwnsRunOnce: Bool {
        let ready = snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        return ready && snapshot.pendingProposals.isEmpty
    }

    private var plan: AgentControlPlan {
        AgentControlPlan.from(
            systemState: snapshot.readiness.systemState,
            runState: store.deriveRunState(for: snapshot),
            authority: snapshot.readiness.strategyAuthority,
            snapshotStale: store.isSnapshotStale(),
            ready: snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        )
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeading("Agent Controls", subtitle: plan.statusTitle)

                Text(plan.statusDetail)
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if !heroOwnsRunOnce {
                    runOnceButton
                }

                if plan.primary == .stop {
                    stopButton
                    if plan.showStart {
                        startButton
                    }
                    if plan.showCloseOnly || plan.showWindDown {
                        DisclosureGroup("More Postures") {
                            VStack(spacing: 10) {
                                if plan.showCloseOnly { closeOnlyButton }
                                if plan.showWindDown { windDownButton }
                            }
                            .padding(.top, 8)
                        }
                        .font(.appSubheadline.weight(.semibold))
                    }
                } else if plan.showStart {
                    startButton
                    if let reason = plan.startDisabledReason, !plan.startEnabled {
                        Text(reason)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            if plan.showCloseOnly { closeOnlyButton }
                            if plan.showWindDown { windDownButton }
                        }
                        VStack(spacing: 10) {
                            if plan.showCloseOnly { closeOnlyButton }
                            if plan.showWindDown { windDownButton }
                        }
                    }
                    if plan.showStop {
                        stopButton
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            if plan.showCloseOnly { closeOnlyButton }
                            if plan.showWindDown { windDownButton }
                        }
                        VStack(spacing: 10) {
                            if plan.showCloseOnly { closeOnlyButton }
                            if plan.showWindDown { windDownButton }
                        }
                    }
                    if plan.showStop {
                        stopButton
                    }
                }

                Text("Exit Only stops the agent from opening new risk.  Protective exits keep working.  Approving an opening places it anyway.  Wind Down submits only sell orders until the account is in cash.  Stop Agent turns scheduled autonomy off without selling anything.")
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
            plan.startLabel,
            systemImage: "play.fill",
            isBusy: store.isBusy("strategy.start"),
            isDisabled: !plan.startEnabled || !store.canSubmit("strategy.start"),
            prominent: plan.primary != .stop
        ) {
            submit("strategy.start")
        }
    }

    private var stopButton: some View {
        CommandButton(
            "Stop Agent",
            systemImage: "stop.fill",
            isBusy: store.isBusy("strategy.stop"),
            role: .destructive,
            prominent: plan.primary == .stop
        ) {
            submit("strategy.stop")
        }
        .tint(AppPalette.negative)
    }

    // Protective de-risk states (labels match AppFormat.commandLabels; the store always
    // allows protective commands, same as Stop — no extra ceremony beyond existing controls).
    private var closeOnlyButton: some View {
        CommandButton(
            "Exit Only",
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
    @Environment(MobileStore.self) private var store
    let snapshot: MobileSnapshot

    private var isLive: Bool {
        AccountMetrics.usesLiveMetrics(environment: store.displayedActiveAccount(in: snapshot)?.environment)
    }

    private var equityPoints: [EquityCurvePoint] {
        if isLive {
            return snapshot.performance?.liveEquityCurve ?? []
        } else {
            return snapshot.performance?.paperEquityCurve ?? []
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Portfolio")
            if let portfolio = snapshot.portfolio {
                // R2a (OD-10e): equity lives once, on the Home hero ("Account card").
                // This card keeps the flows equity cannot tell you — buying power, cash,
                // and how many positions — plus the trend chart.
                AppMetricGrid {
                    MetricTile(title: "Buying Power", value: AppFormat.money(portfolio.buyingPower))
                    MetricTile(title: "Cash", value: AppFormat.money(portfolio.cash))
                    MetricTile(
                        title: "Positions",
                        value: "\(snapshot.positions.count)",
                        detail: "open holdings",
                        detailPlacement: .trailing
                    )
                }

                if !equityPoints.isEmpty {
                    EquityChartView(points: equityPoints, title: "Performance Trend", isLive: isLive)
                        .padding(.top, 4)
                }
            } else {
                EmptyStateCard(
                    title: "No portfolio available",
                    message: DeskCopy.portfolioUnavailableMessage(
                        hasConnectedAccount: snapshot.readiness.hasAccount
                            || snapshot.readiness.activeConnectedAccount != nil
                    ),
                    systemImage: "briefcase"
                )
            }
        }
    }
}

private struct DeskShortcutsCard: View {
    @Environment(MobileStore.self) private var store
    @Binding var selectedTab: AppTab

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Desk")
                AppMetricGrid(minimumTileWidth: 150) {
                    shortcut("Coach", systemImage: "bubble.left.and.bubble.right.fill", tab: .coach)
                    shortcut("Scan", systemImage: "tablecells", tab: .scan)
                    shortcut("Guardrails", systemImage: "shield.checkered", tab: .guardrails)
                    shortcut("Results", systemImage: "chart.xyaxis.line", tab: .results)
                    if store.snapshot?.currentUser?.isAdmin == true {
                        shortcut("Admin", systemImage: "wrench.and.screwdriver", tab: .admin)
                    }
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
    @Environment(MobileStore.self) private var store
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
                // R2a (OD-10e): unrealized ("open") P&L lives once, on the Home hero.
                // This card keeps the realized/quality side of the ledger.
                AppMetricGrid {
                    MetricTile(
                        title: "Realized P&L",
                        value: AppFormat.money(realized),
                        tint: pnlColor(realized)
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
                        VStack(alignment: .leading, spacing: 8) {
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
                            if let shadowValue = benchmark.shadowValue, let dollarExcess = benchmark.dollarExcess {
                                Text(
                                    "Same cash in \(benchmark.benchmarkSymbol) \(AppFormat.money(shadowValue)).  You vs that \(dollarExcess > 0 ? "+" : "")\(AppFormat.money(dollarExcess))."
                                )
                                .font(.appCaption)
                                .foregroundStyle(pnlColor(dollarExcess))
                            }
                            Text("Same deposits and withdrawals as this account, counted from the start of the day they land.  The dashed line is what those dollars would be in \(benchmark.benchmarkSymbol).")
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                            if let accountSeries = benchmark.accountEquitySeries,
                               let shadowSeries = benchmark.shadowBenchmarkSeries,
                               accountSeries.count >= 2,
                               shadowSeries.count >= 2 {
                                BenchmarkCompareChart(
                                    account: accountSeries,
                                    shadow: shadowSeries,
                                    accountLabel: "You",
                                    benchmarkLabel: benchmark.benchmarkSymbol
                                )
                                .padding(.top, 4)
                            }
                        }
                    }
                } else if let unavailable = performance.benchmarkUnavailable {
                    AppCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("vs SPY")
                                .font(.appCaption)
                                .foregroundStyle(.secondary)
                            Text(unavailable.userCopy)
                                .font(.appCaption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if let cause = unavailable.causeLine {
                                Text(cause)
                                    .font(.appCaption2)
                                    .foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            } else {
                EmptyStateCard(
                    title: "No performance history",
                    message: "Performance appears after the selected account has fills or portfolio history.",
                    systemImage: "chart.xyaxis.line"
                )
            }
        }
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private struct ScheduleOverviewCard: View {
    let snapshot: MobileSnapshot

    private var autonomyActive: Bool {
        snapshot.policy.systemState == "active" || snapshot.readiness.systemState == "active"
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading("Schedule")
                LabeledContent("Last Run", value: AppFormat.lastRun(snapshot.scheduler.lastRunAt))
                LabeledContent("Next Run", value: AppFormat.nextRun(snapshot.scheduler.nextRunAt, autonomyActive: autonomyActive))
                LabeledContent(
                    "Cadence",
                    value: AppFormat.cadenceMinutesValue(snapshot.policy.runCadenceMinutes)
                )
            }
        }
    }
}

/// Compact newest-run summary — the same status words and counts as Activity's run rows
/// (StrategyRunSummary).  `strategyRuns` arrives newest first from the server, the same
/// order StrategyRunsSection renders, so the first element is the latest run.
private struct LatestStrategyRunCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading("Latest Strategy Run")
                if let run = snapshot.strategyRuns.first {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(whenLine(run))
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        StatusPill(
                            StrategyRunSummary.statusLabel(run.status),
                            color: StrategyRunSummary.tone(for: run.status).pillColor,
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                    }
                    Text(StrategyRunSummary.countLine(run))
                        .font(.appCaption)
                        .foregroundStyle(.tertiary)
                } else {
                    Text("No strategy runs yet.")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func whenLine(_ run: StrategyRunItem) -> String {
        if let finished = run.finishedAt {
            // Neutral verb: failed and skipped runs also carry finishedAt, and the
            // adjacent status pill already says which outcome this was.
            return "Finished \(AppFormat.dateTime(finished))"
        }
        return "Started \(AppFormat.dateTime(run.startedAt))"
    }
}

private struct HomeAttentionCard: View {
    let snapshot: MobileSnapshot
    @Binding var selectedTab: AppTab

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
                    title: "Open Orders",
                    value: "\(snapshot.orders.count)",
                    emphasize: snapshot.orders.count > 0
                ) {
                    selectedTab = .markets
                }
                AttentionRow(
                    title: "In Progress",
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

struct AccountSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(MobileStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                // R2e (OD-10e): settings is a short index, and each group is a pushed
                // subpage.  The old single form stacked eleven sections into one scroll,
                // so finding Alerts meant scrolling past policy, budget, and data sources.
                Section("Account") {
                    NavigationLink {
                        AccountProfileSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Profile & Accounts",
                            detail: "Your login and the broker accounts this app can use",
                            systemImage: "person.crop.circle"
                        )
                    }
                    NavigationLink {
                        TradingSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Trading",
                            detail: "Current policy and the guardrail caps you can change here",
                            systemImage: "shield.checkered"
                        )
                    }
                }

                Section("Alerts & Data") {
                    NavigationLink {
                        AlertsSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Alerts",
                            detail: "Push permission and delivery state",
                            systemImage: "bell.badge"
                        )
                    }
                    NavigationLink {
                        AiBudgetSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Daily AI Budget",
                            detail: "Optional model and research spend cap",
                            systemImage: "gauge.with.dots.needle.50percent"
                        )
                    }
                    NavigationLink {
                        DataSourcesSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Data Sources",
                            detail: "Which quote, fundamentals, and research feeds are on",
                            systemImage: "antenna.radiowaves.left.and.right"
                        )
                    }
                }

                Section("Security") {
                    NavigationLink {
                        SecuritySettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "App Lock",
                            detail: "Face ID, Touch ID, or passcode after launch",
                            systemImage: "lock.shield"
                        )
                    }
                }

                Section("Legal") {
                    NavigationLink {
                        LegalSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Terms, Privacy, and Shared Data",
                            detail: "The notice, both documents, and what stays private",
                            systemImage: "doc.text"
                        )
                    }
                    NavigationLink {
                        DeleteAccountSettingsPage()
                    } label: {
                        SettingsIndexRow(
                            title: "Delete Account",
                            detail: "Review and confirm permanent deletion",
                            systemImage: "trash",
                            tint: AppPalette.negative
                        )
                    }
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        Task {
                            await store.signOut()
                            dismiss()
                        }
                    }
                } footer: {
                    Text("Signing out only leaves this phone.  Broker and provider keys stay with your account.")
                }
            }
            .navigationTitle("Account & Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .storeTransientAlerts()
        }
    }
}

/// One row of the settings index.  Kept in one place so every subpage entry looks the same.
private struct SettingsIndexRow: View {
    let title: String
    let detail: String
    let systemImage: String
    var tint: Color = AppPalette.accent

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.appBody)
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.appBody.weight(.medium))
                Text(detail)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Settings subpages

/// Every subpage reuses ONE keyboard accessory: number pads have no Return key, so
/// resigning first responder is the only commit point those fields have.
private struct SettingsKeyboardDone: ViewModifier {
    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil
                        )
                    }
                }
            }
    }
}

private extension View {
    func settingsKeyboardDone() -> some View {
        modifier(SettingsKeyboardDone())
    }
}

private struct AccountProfileSettingsPage: View {
    @Environment(\.openURL) private var openURL
    @Environment(MobileStore.self) private var store

    var body: some View {
        Form {
            Section("User Info") {
                LabeledContent("Name", value: store.snapshot?.currentUser?.name ?? "—")
                LabeledContent("Email", value: store.snapshot?.currentUser?.email ?? "—")
                LabeledContent(
                    "Provider",
                    value: store.snapshot?.currentUser?.loginProvider.map { $0.lowercased() } ?? "not reported"
                )
            }
            accountsSection
        }
        .navigationTitle("Profile & Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .storeTransientAlerts()
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
                Text("No connected accounts.  Connect one on the website, then return here to select it.")
                    .foregroundStyle(.secondary)
                Button {
                    openURL(ConsoleHandoff.connections)
                } label: {
                    Label("Open Connections", systemImage: "link")
                }
                .accessibilityHint("Opens the website in Safari")
            }
            Link("Open Connections", destination: URL(string: "https://socratictrade.com/console/connections")!)
        }
    }
}

private struct TradingSettingsPage: View {
    @Environment(MobileStore.self) private var store

    var body: some View {
        Form {
            policySection
            GuardrailTighteningSection()
        }
        .navigationTitle("Trading")
        .navigationBarTitleDisplayMode(.inline)
        .settingsKeyboardDone()
        .storeTransientAlerts()
    }

    @ViewBuilder
    private var policySection: some View {
        Section("Current Policy") {
            LabeledContent("Authority", value: AppFormat.strategyAuthorityValue(store.snapshot?.policy.strategyAuthority))
            LabeledContent("Horizon", value: AppFormat.policyHorizonValue(store.snapshot?.policy.holdingHorizon))
            LabeledContent("Indices", value: DeskCopy.joinedIndexList(store.snapshot?.policy.includedIndices))
            LabeledContent("Max Order", value: PolicyTightening.Cap.maxOrderNotional.displayValue(in: store.snapshot?.policy))
            LabeledContent("Daily Cap", value: PolicyTightening.Cap.maxDailyNotional.displayValue(in: store.snapshot?.policy))
            LabeledContent("Daily Orders", value: store.snapshot?.policy.maxDailyOrders.map(String.init) ?? "—")
            NavigationLink {
                GuardrailsView()
            } label: {
                Label("View Guardrails", systemImage: "shield.checkered")
            }
        }
    }
}

private struct AlertsSettingsPage: View {
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var push: PushNotificationCoordinator

    var body: some View {
        Form {
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
        .navigationTitle("Alerts")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AiBudgetSettingsPage: View {
    var body: some View {
        Form {
            LlmBudgetSection()
        }
        .navigationTitle("Daily AI Budget")
        .navigationBarTitleDisplayMode(.inline)
        .settingsKeyboardDone()
        .storeTransientAlerts()
    }
}

private struct DataSourcesSettingsPage: View {
    var body: some View {
        Form {
            DataSourcesSection()
        }
        .navigationTitle("Data Sources")
        .navigationBarTitleDisplayMode(.inline)
        .settingsKeyboardDone()
        .storeTransientAlerts()
    }
}

private struct SecuritySettingsPage: View {
    @Environment(AppLockController.self) private var appLock

    var body: some View {
        Form {
            Section {
                Toggle("Require App Lock", isOn: Binding(
                    get: { appLock.isEnabled },
                    set: { appLock.isEnabled = $0 }
                ))
            } header: {
                Text("Security")
            } footer: {
                if !appLock.isEnabled, let message = appLock.lastErrorMessage {
                    Text(message)
                } else {
                    Text("When on, Face ID, Touch ID, or your device passcode is required after launch and after the app has been in the background for more than one minute.")
                }
            }
        }
        .navigationTitle("App Lock")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct LegalSettingsPage: View {
    var body: some View {
        Form {
            Section {
                LabeledContent("Notice", value: "Not investment advice.  You set authority.")
                Link("Terms", destination: URL(string: "https://socratictrade.com/terms-and-conditions")!)
                Link("Privacy", destination: URL(string: "https://socratictrade.com/privacy-policy")!)
            } header: {
                Text("Legal")
            } footer: {
                Text("After you accept, this notice stays dismissed until the terms change.  You can delete your account from Account & Settings.")
            }
        }
        .navigationTitle("Legal")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct DeleteAccountSettingsPage: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(MobileStore.self) private var store

    @State private var deleteIdentity = ""
    @State private var deletePhrase = ""

    var body: some View {
        Form {
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
                Text("Reviewing is read-only and does not pause the agent.  Final confirmation deletes this app account, saved keys, proposals, fills, watchlists, alerts, and learned context.  Revoke broker logins separately if you want those gone too.")
            }
        }
        .navigationTitle("Delete Account")
        .navigationBarTitleDisplayMode(.inline)
        .storeTransientAlerts()
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
    @Environment(MobileStore.self) private var store

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
                    activate()
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
    }

    private func activate() {
        Task {
            // Same path as the Home hero picker: one command, one operation id.
            await store.activateAccount(account)
        }
    }
}

struct LlmBudgetSection: View {
    @Environment(MobileStore.self) private var store

    /// Named so the field that just LOST focus can be committed by name — `onChange` on a
    /// `@FocusState` hands back the previous value, which is the one worth saving.
    private enum BudgetField: String, Hashable {
        case tokens = "tokenBudget"
        case cost = "costBudgetUsd"
    }

    @State private var response: LlmBudgetResponse?
    @State private var tokenText = ""
    @State private var costText = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var loadError: String?
    @FocusState private var focusedField: BudgetField?

    var body: some View {
        Section {
            if isLoading && response == nil {
                HStack {
                    ProgressView()
                    Text("loading your daily AI budget")
                        .foregroundStyle(.secondary)
                }
            } else if let loadError, response == nil {
                Text(loadError)
                    .foregroundStyle(AppPalette.negative)
                Button("Retry") { Task { await load() } }
            } else {
                LabeledContent("Daily Token Cap") {
                    TextField("blank = no cap", text: $tokenText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .disabled(isSaving)
                        .focused($focusedField, equals: .tokens)
                        // Same dead `.onSubmit` as the data-source rows: neither .numberPad
                        // nor .decimalPad has a Return key.  Here an explicit Save Caps
                        // button meant nothing was actually lost, but the field still
                        // behaved differently from every other settings field in the app.
                        .onSubmit { Task { await commit(.tokens) } }
                }
                LabeledContent("Daily Cost Cap") {
                    TextField("blank = no cap", text: $costText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .disabled(isSaving)
                        .focused($focusedField, equals: .cost)
                        .onSubmit { Task { await commit(.cost) } }
                }
                if let response {
                    LabeledContent("Today") {
                        Text("\(Int(response.today.tokens)) tokens · \(AppFormat.money(response.today.costUsd))")
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Cap") {
                        Text(response.enforced ? "on" : "no cap")
                            .foregroundStyle(.secondary)
                    }
                }
                Button("Save Caps") {
                    Task { await saveBoth() }
                }
                .disabled(isSaving)
                if let loadError, response != nil {
                    Text(loadError)
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.negative)
                }
            }
        } header: {
            Text("Daily AI Budget")
        } footer: {
            Text("Optional daily limit for model and research spend.  Leave a field blank for no cap.  When a cap is set, strategy, chat, and research pause for the rest of the day once spend reaches it.")
        }
        .task { await load() }
        // Commit whichever field just lost focus.  Moving between the two fields commits
        // the first, and the Form's keyboard "Done" resigns focus, which lands here too.
        .onChange(of: focusedField) { previous, _ in
            guard let previous else { return }
            Task { await commit(previous) }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await store.fetchLlmBudget())
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func saveBoth() async {
        await commit(.tokens)
        await commit(.cost)
    }

    private func text(for field: BudgetField) -> String {
        field == .tokens ? tokenText : costText
    }

    private func serverValue(for field: BudgetField) -> Double? {
        field == .tokens ? response?.tokenBudget : response?.costBudgetUsd
    }

    private func restore(_ field: BudgetField) {
        let shown = NumberFieldEditor.display(serverValue(for: field))
        if field == .tokens { tokenText = shown } else { costText = shown }
    }

    private func commit(_ field: BudgetField) async {
        switch NumberFieldEditor.decide(
            text: text(for: field),
            serverValue: serverValue(for: field),
            allowsEmpty: true
        ) {
        case .unchanged:
            // Already what the server has.  This is what keeps Save Caps from re-sending
            // a value a blur just saved, now that both paths exist.
            return
        case .revert:
            loadError = "Enter a non-negative number, or leave the field blank."
            restore(field)
            return
        case .patch(let parsed):
            // `nil` is meaningful here — the placeholder says "blank = no cap" — so it has
            // to reach the API as JSON null, not be skipped.
            let payload: Any = parsed.map { $0 as Any } ?? NSNull()
            isSaving = true
            defer { isSaving = false }
            do {
                apply(try await store.patchLlmBudget([field.rawValue: payload]))
                loadError = nil
            } catch {
                loadError = error.localizedDescription
            }
        }
    }

    private func apply(_ next: LlmBudgetResponse) {
        response = next
        // Never overwrite a field the owner is currently in.  Committing one field applies
        // the whole response, and without this guard saving the token cap would wipe an
        // unsaved cost cap out from under the cursor.
        if focusedField != .tokens { tokenText = NumberFieldEditor.display(next.tokenBudget) }
        if focusedField != .cost { costText = NumberFieldEditor.display(next.costBudgetUsd) }
    }
}
