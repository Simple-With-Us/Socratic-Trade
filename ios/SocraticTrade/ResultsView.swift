import SwiftUI

/// Read-only Results desk: P&L, benchmark, and tax-relevant fill receipts.
struct ResultsView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var presentedSymbol: PresentedSymbol?

    var body: some View {
        SnapshotScaffold { snapshot in
            headline(snapshot)
                .cardSpansAllColumns()
            equityCurveSection(snapshot)
            metrics(snapshot)
            benchmark(snapshot)
            taxNote(snapshot)
            receipts(snapshot)
        }
        .navigationTitle("Results")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
    }

    private func usesLiveMetrics(_ snapshot: MobileSnapshot) -> Bool {
        AccountMetrics.usesLiveMetrics(environment: store.displayedActiveAccount(in: snapshot)?.environment)
    }

    private func realized(_ snapshot: MobileSnapshot) -> Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics(snapshot) ? $0.liveRealizedPnl : $0.paperRealizedPnl
        }
        let hasFills = (snapshot.performance?.fills?.isEmpty == false)
        return AccountMetrics.displayedRealized(ledger: ledger, hasFillHistory: hasFills)
    }

    private func unrealized(_ snapshot: MobileSnapshot) -> Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics(snapshot) ? $0.liveUnrealizedPnl : $0.paperUnrealizedPnl
        }
        return AccountMetrics.displayedUnrealized(positions: snapshot.positions, ledger: ledger)
    }

    private func closedLotCount(_ snapshot: MobileSnapshot) -> Int? {
        snapshot.performance.flatMap {
            usesLiveMetrics(snapshot) ? $0.liveClosedLotCount : $0.paperClosedLotCount
        }
    }

    private func winRate(_ snapshot: MobileSnapshot) -> Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics(snapshot) ? $0.liveWinRate : $0.paperWinRate
        }
        return AccountMetrics.displayedRateMetric(ledger: ledger, closedLotCount: closedLotCount(snapshot))
    }

    private func avgReturn(_ snapshot: MobileSnapshot) -> Double? {
        let ledger = snapshot.performance.flatMap {
            usesLiveMetrics(snapshot) ? $0.liveAverageReturnPct : $0.paperAverageReturnPct
        }
        return AccountMetrics.displayedRateMetric(ledger: ledger, closedLotCount: closedLotCount(snapshot))
    }

    private func headline(_ snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading(
                    "Performance",
                    subtitle: accountLine(snapshot)
                )
                Text("Measurement only — never an estimate dressed as a result.  Paper and brokerage stay on separate books.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func metrics(_ snapshot: MobileSnapshot) -> some View {
        AppMetricGrid {
            MetricTile(
                title: "Realized P&L",
                value: AppFormat.money(realized(snapshot)),
                tint: pnlColor(realized(snapshot))
            )
            MetricTile(
                title: "Unrealized P&L",
                value: AppFormat.money(unrealized(snapshot)),
                tint: pnlColor(unrealized(snapshot))
            )
            // Win rate / avg return render "—" (not a fabricated 0%) until this bucket has
            // closed at least one lot — see AccountMetrics.displayedRateMetric.
            MetricTile(
                title: "Win Rate",
                value: AppFormat.percent(winRate(snapshot))
            )
            MetricTile(
                title: "Avg. Return",
                value: AppFormat.percent(avgReturn(snapshot), signed: true)
            )
        }
    }

    @ViewBuilder
    private func equityCurveSection(_ snapshot: MobileSnapshot) -> some View {
        let isLive = usesLiveMetrics(snapshot)
        let points = (isLive ? snapshot.performance?.liveEquityCurve : snapshot.performance?.paperEquityCurve) ?? []
        if !points.isEmpty {
            AppCard {
                EquityChartView(points: points, title: "Historical Equity", isLive: isLive)
            }
            .cardSpansAllColumns()
        }
    }

    @ViewBuilder
    private func benchmark(_ snapshot: MobileSnapshot) -> some View {
        if let benchmark = snapshot.performance?.benchmark {
            AppCard {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("vs \(benchmark.benchmarkSymbol)")
                                .font(.appCaption)
                                .foregroundStyle(.secondary)
                            Text(AppFormat.percent(benchmark.excessReturnPct, signed: true))
                                .font(.appTitle3.weight(.semibold))
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
                    Text("Same deposits and withdrawals as this account, applied at each day's cutoff.  The dashed line is what those dollars would be in \(benchmark.benchmarkSymbol).")
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
        }
    }

    private func taxNote(_ snapshot: MobileSnapshot) -> some View {
        let accountType = snapshot.readiness.activeConnectedAccount?.capabilities?.accountType
        return AppCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading("Tax-Relevant Receipts", subtitle: "not tax advice")
                if let accountType, !accountType.isEmpty {
                    LabeledContent("Account Type", value: AppFormat.accountTypeWord(accountType))
                }
                Text("Closed fills below are the tax-relevant ledger the desk already recorded.  Rates, wash-sale handling, and net-of-tax display live on Guardrails.  Figures here are broker receipts, not a filing.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func receipts(_ snapshot: MobileSnapshot) -> some View {
        let fills = snapshot.performance?.fills ?? []
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Fill Receipts", subtitle: fills.isEmpty ? "none recorded" : "\(fills.count) recorded")
            if fills.isEmpty {
                EmptyStateCard(
                    title: "No Fills Yet",
                    message: "Closed lots and taxable receipts appear here after the selected account has fills.",
                    systemImage: "doc.text"
                )
            } else {
                ForEach(fills) { fill in
                    FillReceiptRow(fill: fill, presentedSymbol: $presentedSymbol)
                }
            }
        }
    }

    private func accountLine(_ snapshot: MobileSnapshot) -> String {
        if store.pendingAccountId != nil { return "refreshing the selected account" }
        guard let account = store.displayedActiveAccount(in: snapshot) else { return "no active account" }
        if account.environment.lowercased() == "paper" {
            return AppFormat.accountBrokerEnvironmentLine(broker: account.broker, environment: account.environment)
        }
        return account.label.lowercased()
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private struct FillReceiptRow: View {
    let fill: FillEvent
    @Binding var presentedSymbol: PresentedSymbol?

    var body: some View {
        AppCard(padding: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        SymbolTapButton(symbol: fill.symbol, logoSize: 22) {
                            presentedSymbol = PresentedSymbol(symbol: fill.symbol)
                        }
                        StatusPill(fill.side.lowercased(), color: sideColor)
                    }
                    Text("\(AppFormat.number(fill.quantity)) @ \(AppFormat.money(fill.price))")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                    Text(AppFormat.dateTime(fill.filledAt))
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(AppFormat.money(fill.notional))
                        .font(.appHeadline)
                    Text(fill.status.lowercased())
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var sideColor: Color {
        fill.side.lowercased() == "buy" || fill.side.lowercased() == "cover"
            ? AppPalette.positive
            : AppPalette.negative
    }
}
