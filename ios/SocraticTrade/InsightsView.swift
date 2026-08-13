import SwiftUI

/// Snapshot-derived status brief and prioritized attention items.
/// Not the web console Coach chat — rename keeps that product distinction clear.
struct InsightsView: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        SnapshotScaffold { snapshot in
            InsightsBriefCard(snapshot: snapshot)
            ForEach(insights(for: snapshot)) { insight in
                InsightCard(insight: insight)
            }
            InsightsActionCard(snapshot: snapshot)
            InsightsAuthorityCard()
        }
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func insights(for snapshot: MobileSnapshot) -> [StatusInsight] {
        var insights: [StatusInsight] = []

        if !snapshot.readiness.hasAccount {
            insights.append(.init(
                id: "account",
                title: "Choose an Execution Account",
                detail: "Open Account & Settings from Home to connect or select the account the agent should use.",
                systemImage: "person.crop.circle.badge.exclamationmark",
                tone: .warning
            ))
        } else if !snapshot.readiness.hasUniverse {
            insights.append(.init(
                id: "universe",
                title: "Your Trading Universe Is Empty",
                detail: "Add an included index or symbol before asking the strategy to find opportunities.",
                systemImage: "scope",
                tone: .warning
            ))
        }

        if !snapshot.pendingProposals.isEmpty {
            let n = snapshot.pendingProposals.count
            insights.append(.init(
                id: "proposals",
                title: "\(n) pending proposal\(n == 1 ? "" : "s")",
                detail: "Review rationale, size, execution environment, and any confirmation in Proposals.",
                systemImage: "checklist",
                tone: .attention
            ))
        }

        if let cap = snapshot.policy.maxDailyNotional, cap > 0 {
            let utilization = min(max(snapshot.dailyStats.notional / cap, 0), 1)
            insights.append(.init(
                id: "daily-notional",
                title: "Daily Opening Notional: \(Int((utilization * 100).rounded()))% used",
                detail: "\(AppFormat.money(snapshot.dailyStats.notional)) of the owner-set \(AppFormat.money(cap)) daily cap.",
                systemImage: "gauge.with.dots.needle.50percent",
                tone: utilization >= 0.8 ? .warning : .neutral
            ))
        }

        if let benchmark = snapshot.performance?.benchmark {
            let ahead = benchmark.excessReturnPct >= 0
            insights.append(.init(
                id: "benchmark",
                title: "vs SPY",
                detail: "You \(AppFormat.percent(benchmark.accountReturnPct, signed: true)) · SPY \(AppFormat.percent(benchmark.benchmarkReturnPct, signed: true)) → excess \(AppFormat.percent(benchmark.excessReturnPct, signed: true)) across \(benchmark.points) observations.",
                systemImage: ahead ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis",
                tone: ahead ? .positive : .attention
            ))
        }

        let triggeredAlerts = snapshot.alerts.filter { $0.status == "triggered" }
        if !triggeredAlerts.isEmpty {
            insights.append(.init(
                id: "triggered-alerts",
                title: "\(triggeredAlerts.count) price alert\(triggeredAlerts.count == 1 ? " has" : "s have") triggered",
                detail: "Review current prices and remove alerts you no longer need under Assets.",
                systemImage: "bell.badge.fill",
                tone: .attention
            ))
        }

        if insights.isEmpty {
            insights.append(.init(
                id: "clear",
                title: "No Immediate Action Needed",
                detail: "The selected account is ready, the proposal queue is clear, and no tracked threshold needs attention.",
                systemImage: "checkmark.seal.fill",
                tone: .positive
            ))
        }

        return insights
    }
}

private struct InsightsBriefCard: View {
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
                        Text("A concise read from the latest backend snapshot")
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
        return "\(account) is \(state) with \(equity) in equity, \(snapshot.positions.count) open position\(snapshot.positions.count == 1 ? "" : "s"), and \(pending).  Session: \(AppFormat.marketSessionBannerLabel(snapshot.marketSession))."
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

/// Insights is a brief — not a third home for Run once (Home owns that primary CTA).
private struct InsightsActionCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(
                    "Want a Fresh Cycle?",
                    subtitle: "Run Once lives on Home so there is a single primary control — not a second copy here."
                )
                Text(
                    snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
                        ? "Open the Home tab and tap Run Once (or Review Proposals when the queue is waiting)."
                        : "Finish account + universe setup on Home first; then use Run Once there."
                )
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct InsightsAuthorityCard: View {
    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Backend Remains Authoritative", systemImage: "lock.shield.fill")
                    .font(.appHeadline)
                    .foregroundStyle(AppPalette.accent)
                Text("This tab summarizes server-returned facts.  Broker credentials, provider keys, policy checks, proposal validation, and order placement never move onto the phone.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
