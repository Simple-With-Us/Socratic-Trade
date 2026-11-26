import SwiftUI

/// Snapshot-derived status brief and prioritized attention items.
/// Not the web console Coach chat — rename keeps that product distinction clear.
///
/// R2m (OD-10e): this screen is the Intelligence hub and its first card is the read-only
/// learning inbox — what the desk has actually recorded for this account — followed by the
/// status brief, attention items, and the Coach handoff.
struct InsightsView: View {
    @Environment(MobileStore.self) private var store
    @Binding var selectedTab: AppTab

    init(selectedTab: Binding<AppTab> = .constant(.insights)) {
        self._selectedTab = selectedTab
    }

    var body: some View {
        SnapshotScaffold { snapshot in
            IntelligenceLearningInbox()
                .cardSpansAllColumns()
            InsightsBriefCard(snapshot: snapshot)
                .cardSpansAllColumns()
            ForEach(insights(for: snapshot)) { insight in
                InsightCard(insight: insight)
            }
            InsightsCoachCard { selectedTab = .coach }
            InsightsActionCard(snapshot: snapshot, selectedTab: $selectedTab)
            InsightsAuthorityCard()
        }
        .navigationTitle("Intelligence")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func insights(for snapshot: MobileSnapshot) -> [StatusInsight] {
        var insights: [StatusInsight] = []

        if !snapshot.readiness.hasAccount {
            insights.append(.init(
                id: "account",
                title: "Choose an Execution Account",
                detail: "Open Account & Settings from the gear to connect or select the account the agent should use.",
                systemImage: "person.crop.circle.badge.exclamationmark",
                tone: .warning
            ))
        } else if !snapshot.readiness.hasUniverse {
            insights.append(.init(
                id: "universe",
                title: "Your Trading Universe Is Empty",
                detail: DeskCopy.universeInsightDetail,
                systemImage: "scope",
                tone: .warning
            ))
        }

        if !snapshot.pendingProposals.isEmpty {
            let n = snapshot.pendingProposals.count
            insights.append(.init(
                id: "proposals",
                title: "\(n) pending proposal\(n == 1 ? "" : "s")",
                detail: "Review rationale, size, and any confirmation in Proposals.",
                systemImage: "checklist",
                tone: .attention
            ))
        }

        if let cap = snapshot.policy.maxDailyNotional, cap > 0 {
            let utilization = min(max(snapshot.dailyStats.notional / cap, 0), 1)
            insights.append(.init(
                id: "daily-notional",
                title: "Daily Opening Notional: \(Int((utilization * 100).rounded()))% used",
                detail: "\(AppFormat.money(snapshot.dailyStats.notional)) of the \(AppFormat.money(cap)) daily cap.",
                systemImage: "gauge.with.dots.needle.50percent",
                tone: utilization >= 0.8 ? .warning : .neutral
            ))
        }

        if let benchmark = snapshot.performance?.benchmark {
            let ahead = benchmark.excessReturnPct >= 0
            insights.append(.init(
                id: "benchmark",
                title: "vs \(benchmark.benchmarkSymbol)",
                detail: "You \(AppFormat.percent(benchmark.accountReturnPct, signed: true)) · \(benchmark.benchmarkSymbol) \(AppFormat.percent(benchmark.benchmarkReturnPct, signed: true)) → excess \(AppFormat.percent(benchmark.excessReturnPct, signed: true)) across \(benchmark.points) observations.",
                systemImage: ahead ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis",
                tone: ahead ? .positive : .attention
            ))
        }

        if insights.isEmpty {
            insights.append(.init(
                id: "clear",
                title: "No Immediate Action Needed",
                detail: "The selected account is ready and the proposal queue is clear.",
                systemImage: "checkmark.seal.fill",
                tone: .positive
            ))
        }

        return insights
    }
}

/// Read-only learning inbox: every durable lesson the desk has recorded for this user, with
/// its tier and origin.  Approving, rejecting, and deleting stay on the website console —
/// this is the "what has it learned so far" view the phone was missing.
private struct IntelligenceLearningInbox: View {
    @Environment(MobileStore.self) private var store

    @State private var items: [LearnedContextItem] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var showsAll = false

    private static let collapsedCount = 6

    private var visibleItems: [LearnedContextItem] {
        showsAll ? items : Array(items.prefix(Self.collapsedCount))
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Learning Inbox")
                            .font(.appTitle3.weight(.semibold))
                        Text("What the desk has learned, newest first")
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if !isLoading {
                        Text("\(items.count)")
                            .font(.appCaption.weight(.semibold))
                            .foregroundStyle(AppPalette.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(AppPalette.accent.opacity(0.12), in: Capsule())
                    }
                }

                if isLoading {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading learned context…")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if let loadError {
                    InlineErrorBanner(
                        message: loadError,
                        retry: { Task { await load(force: true) } },
                        dismiss: { self.loadError = nil }
                    )
                } else if items.isEmpty {
                    Text("Nothing learned yet.\u{00A0} Lessons from strategy runs, chat, and research land here once the desk records them.")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(spacing: 10) {
                        ForEach(visibleItems) { item in
                            LearnedContextRow(item: item)
                        }
                    }
                    if items.count > Self.collapsedCount {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showsAll.toggle()
                            }
                        } label: {
                            Text(showsAll ? "Show Fewer" : "Show All \(items.count)")
                                .font(.appSubheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppPalette.accent)
                    }
                }
            }
        }
        .task { await load() }
        // Pull-to-refresh reloads the snapshot, not this list: follow it so a new lesson
        // recorded by a run shows up without leaving the screen.  No spinner on reload —
        // the existing rows stay put.
        .onChange(of: store.lastUpdatedAt) { _, _ in
            Task { await load(force: true) }
        }
    }

    private func load(force: Bool = false) async {
        if !force, !items.isEmpty { return }
        isLoading = items.isEmpty
        defer { isLoading = false }
        do {
            items = try await store.fetchLearnedContext()
            loadError = nil
        } catch {
            guard !MobileAPIError.isUserCancellation(error) else { return }
            loadError = error.localizedDescription
        }
    }
}

private struct LearnedContextRow: View {
    let item: LearnedContextItem

    private var tierColor: Color {
        switch (item.riskTier ?? "").lowercased() {
        case "risk", "strategy-directive": return AppPalette.warning
        default: return AppPalette.accent
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let symbol = item.symbol, !symbol.isEmpty {
                    Text(symbol.uppercased())
                        .font(.appCaption.weight(.bold))
                        .foregroundStyle(AppPalette.accent)
                }
                Text(item.subject)
                    .font(.appSubheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(AppFormat.relative(item.assertedAt))
                    .font(.appCaption2)
                    .foregroundStyle(.tertiary)
            }
            Text(item.value)
                .font(.appCaption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                StatusPill(item.tierLabel, color: tierColor)
                if let origin = item.origin, !origin.isEmpty {
                    Text(origin)
                        .font(.appCaption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(tierColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct InsightsBriefCard: View {
    @Environment(MobileStore.self) private var store
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: "lightbulb.fill")
                        .font(.appTitle2)
                        .foregroundStyle(AppPalette.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Portfolio Brief")
                            .font(.appTitle3.weight(.semibold))
                        Text("What’s going on with this account")
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(brief)
                    .font(.appBody)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var brief: String {
        let account = snapshot.readiness.activeConnectedAccount?.label ?? "No account"
        let state = snapshot.readiness.systemState.replacingOccurrences(of: "_", with: " ")
        let equity = AppFormat.money(snapshot.portfolio?.totalMarketValue)
        let n = snapshot.pendingProposals.count
        let pending = "\(n) pending proposal\(n == 1 ? "" : "s")"
        return "\(account) is \(state) with \(equity) in equity, \(snapshot.positions.count) open position\(snapshot.positions.count == 1 ? "" : "s"), and \(pending).  Session: \(AppFormat.marketSessionBannerLabel(store.displayMarketSession(for: snapshot)))."
    }
}

private struct StatusInsight: Identifiable {
    enum Tone {
        case neutral
        case positive
        case attention
        case warning
    }

    let id: String
    let title: String
    let detail: String
    let systemImage: String
    let tone: Tone

    var color: Color {
        switch tone {
        case .neutral: return AppPalette.accent
        case .positive: return AppPalette.positive
        case .attention: return AppPalette.warning
        case .warning: return AppPalette.negative
        }
    }
}

private struct InsightCard: View {
    let insight: StatusInsight

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: insight.systemImage)
                    .font(.appHeadline)
                    .foregroundStyle(insight.color)
                    .frame(width: 38, height: 38)
                    .background(insight.color.opacity(0.11), in: Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(insight.title)
                        .font(.appHeadline)
                    Text(insight.detail)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct InsightsCoachCard: View {
    let openCoach: () -> Void

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Ask Coach", subtitle: "a real conversation, not this brief")
                Text("Ask about a name, a pending proposal, or what the last scan ranked.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: openCoach) {
                    Label("Open Coach", systemImage: "bubble.left.and.bubble.right.fill")
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

/// Insights is a brief — not a third home for Run once (Home owns that primary CTA).
private struct InsightsActionCard: View {
    let snapshot: MobileSnapshot
    @Binding var selectedTab: AppTab

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(
                    "Want a Fresh Cycle?",
                    subtitle: "Run Once is on Home."
                )
                Text(
                    snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
                        ? "Open the Home tab and tap Run Once (or Review Proposals when the queue is waiting)."
                        : "Finish account + universe setup on Home first; then use Run Once there."
                )
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                Button {
                    selectedTab = .home
                } label: {
                    Label("Open Home", systemImage: "house.fill")
                        .font(.appBody.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
            }
        }
    }
}

private struct InsightsAuthorityCard: View {
    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Orders Place Through Your Broker", systemImage: "lock.shield.fill")
                    .font(.appHeadline)
                    .foregroundStyle(AppPalette.accent)
                Text("Approvals here are real.  Keys stay with your account.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
