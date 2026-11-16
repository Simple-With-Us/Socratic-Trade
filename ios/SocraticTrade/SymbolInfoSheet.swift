import Foundation
import SwiftUI

/// Company / fill / position detail sheet — the mobile counterpart to the web console's
/// symbol drilldown drawer (app/console/ui/symbol-drilldown.tsx). Presented from any row
/// that shows a symbol via `PresentedMarketItem` (fill and position cards tap anywhere;
/// logo-only rows still present `.company`). Fetches the same on-demand `/api/quote`
/// cascade the web drawer uses; every field degrades honestly to "—"/"n/a" instead of
/// being fabricated. Backend remains authoritative — this reads only.
struct SymbolInfoSheet: View {
    @EnvironmentObject private var store: MobileStore
    @Environment(\.dismiss) private var dismiss

    let item: PresentedMarketItem

    init(symbol: String) {
        self.item = .company(symbol)
    }

    init(item: PresentedMarketItem) {
        self.item = item
    }

    private var symbol: String { item.symbol }

    @State private var loadState: LoadState = .loading
    @State private var desk: SymbolDeskInfo?

    private enum LoadState {
        case loading
        case loaded(SymbolQuoteInfo)
        case failed(String)
    }

    private var resolvedPosition: Position? {
        if let position = item.position { return position }
        return store.snapshot?.positions.first {
            $0.symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == normalized
        }
    }

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let fill = item.fill {
                        FillDetailCard(fill: fill)
                    }
                    if let position = resolvedPosition {
                        PositionDetailCard(position: position)
                    }
                    if let exit = desk?.exit {
                        ExitPlanCard(exit: exit)
                    }
                    if let pending = desk?.pending, !pending.isEmpty {
                        PendingIdeasCard(items: pending)
                    }
                    if let lastCall = desk?.lastCall {
                        LastCallCard(call: lastCall)
                    }
                    if let peers = desk?.peerAccounts, !peers.isEmpty {
                        PeerAccountsCard(peers: peers) { accountId in
                            Task {
                                await store.submit(
                                    "account.activate",
                                    payload: ["accountId": accountId],
                                    operationID: "symbol-desk-\(accountId)"
                                )
                            }
                        }
                    }
                    switch loadState {
                    case .loading:
                        loadingState
                    case .failed(let message):
                        InlineErrorBanner(
                            message: message,
                            retry: { Task { await load() } },
                            dismiss: { dismiss() }
                        )
                    case .loaded(let info):
                        SymbolInfoHeaderCard(symbol: normalized, info: info)
                        SymbolInfoStatsCard(info: info)
                        SymbolInfoAnalystCard(info: info)
                        if let asOfLine {
                            Text(asOfLine)
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .background(AppPalette.background.ignoresSafeArea())
            .navigationTitle(normalized)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // On iPad and Catalyst a plain sheet is a ~540pt form sheet, which is a keyhole for
        // a nine-card symbol screen.  `.page` is documented as having no effect in compact
        // width, so the iPhone keeps exactly the edge-to-edge bottom sheet it has today.
        // Applied in the sheet's OWN body so every presenter inherits it.
        .presentationSizing(.page)
        .task { await load() }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Loading \(normalized)…")
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    private var asOfLine: String? {
        guard case .loaded(let info) = loadState, info.asOf != nil else { return nil }
        return "Quote data from a live fetch (\(AppFormat.dateTimeCentral(info.asOf)))."
    }

    private func load() async {
        loadState = .loading
        do {
            async let quoteTask = store.fetchSymbolQuote(normalized)
            async let deskTask = store.fetchSymbolDesk(normalized)
            let info = try await quoteTask
            loadState = .loaded(info)
            desk = try? await deskTask
        } catch is CancellationError {
            // Sheet dismissed mid-fetch — nothing left to show.
        } catch {
            // MobileAPIClient's URLSession call wraps a mid-fetch cancellation as
            // MobileAPIError.network(URLError(.cancelled)) rather than rethrowing
            // CancellationError, so a sheet dismissed while the fetch is in flight would
            // otherwise flash a real error state for a fetch nobody is waiting on anymore.
            // Treat that case — and any lingering Task cancellation — as the same silent
            // no-op as the CancellationError branch above.
            guard !Task.isCancelled, !isCancelledNetworkError(error) else { return }
            loadState = .failed(error.localizedDescription)
        }
    }

    private func isCancelledNetworkError(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return urlError.code == .cancelled
        }
        if case MobileAPIError.network(let underlying) = error, let urlError = underlying as? URLError {
            return urlError.code == .cancelled
        }
        return false
    }
}

private struct FillDetailCard: View {
    let fill: FillEvent

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Fill")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        StatusPill(fill.side.uppercased(), color: sideColor)
                        Spacer()
                        Text(AppFormat.dateTime(fill.filledAt))
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Quantity", value: AppFormat.number(fill.quantity))
                    LabeledContent("Price", value: AppFormat.money(fill.price))
                    LabeledContent("Notional", value: AppFormat.money(fill.notional))
                    if !fill.status.isEmpty {
                        LabeledContent("Status", value: fill.status.capitalized)
                    }
                }
            }
        }
    }
}

private struct PositionDetailCard: View {
    let position: Position

    private var unrealized: Double? {
        guard let averageCost = position.averageCost else { return nil }
        return position.marketValue - position.quantity * averageCost
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Position")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    if position.quantity < 0 {
                        StatusPill("Short", color: AppPalette.negative)
                    }
                    LabeledContent("Quantity", value: "\(AppFormat.number(abs(position.quantity))) shares")
                    LabeledContent("Market Value", value: AppFormat.money(position.marketValue))
                    LabeledContent("Average Cost", value: AppFormat.money(position.averageCost))
                    if let unrealized {
                        LabeledContent("Open P&L", value: AppFormat.money(unrealized))
                    }
                    if let sector = position.sector, !sector.isEmpty {
                        LabeledContent("Sector", value: sector)
                    }
                    if let industry = position.industry, !industry.isEmpty, industry != position.sector {
                        LabeledContent("Industry", value: industry)
                    }
                }
            }
        }
    }
}

private struct ExitPlanCard: View {
    let exit: SymbolDeskInfo.Exit

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Exit Plan")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    if let style = exit.style, !style.isEmpty {
                        LabeledContent("Style", value: style.capitalized)
                    }
                    if let stop = exit.stopPrice {
                        LabeledContent("Stop", value: AppFormat.money(stop))
                    }
                    if let take = exit.takeProfitPrice {
                        LabeledContent("Take Profit", value: AppFormat.money(take))
                    }
                    if let trail = exit.trailPercent {
                        LabeledContent("Trail", value: AppFormat.percent(trail))
                    }
                    if let band = exit.trimBand {
                        LabeledContent("Harvested Band", value: AppFormat.number(band))
                    }
                    if let invalidation = exit.invalidation, !invalidation.isEmpty {
                        Text(invalidation)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    if let rationale = exit.rationale, !rationale.isEmpty {
                        Text(rationale)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

private struct PendingIdeasCard: View {
    let items: [SymbolDeskInfo.Pending]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Waiting For You")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(item.side.uppercased())\(item.quantity.map { " \(AppFormat.number($0)) sh" } ?? "")")
                                .font(.appSubheadline.weight(.semibold))
                            if let rationale = item.rationale, !rationale.isEmpty {
                                Text(rationale)
                                    .font(.appCaption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct LastCallCard: View {
    let call: SymbolDeskInfo.LastCall

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Last Desk Call")
            AppCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(call.side.map { "\($0) · " } ?? "")\(call.status.replacingOccurrences(of: "_", with: " "))\(call.outcome.map { " · \($0)" } ?? "")")
                        .font(.appSubheadline.weight(.semibold))
                    if let green = call.green, !green.isEmpty {
                        Text("Green: \(green)")
                            .font(.appCaption)
                    }
                    if let red = call.red, !red.isEmpty {
                        Text(red)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

private struct PeerAccountsCard: View {
    let peers: [SymbolDeskInfo.PeerAccount]
    let onSwitch: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Other Accounts")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(peers) { peer in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(peer.direction == "short" ? "Short" : "Long") \(AppFormat.number(peer.quantity)) sh")
                                    .font(.appSubheadline.weight(.semibold))
                                Text(peer.label)
                                    .font(.appCaption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Use") { onSwitch(peer.accountId) }
                                .buttonStyle(.bordered)
                        }
                    }
                    Text("Size and direction only.  Switching loads that account's full book.")
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct SymbolInfoHeaderCard: View {
    let symbol: String
    let info: SymbolQuoteInfo

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    TickerLogo(symbol: symbol, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(symbol)
                            .font(.appTitle3.weight(.bold))
                        if let companyName = info.companyName, !companyName.isEmpty {
                            Text(companyName)
                                .font(.appSubheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(AppFormat.money(info.price))
                        .font(.appLargeTitle.weight(.semibold))
                    if let changePct = info.intradayChangePct {
                        Text("\(AppFormat.percent(changePct, signed: true)) today")
                            .font(.appSubheadline.weight(.semibold))
                            .foregroundStyle(changePct >= 0 ? AppPalette.positive : AppPalette.negative)
                    }
                }

                if let sector = info.sector, !sector.isEmpty {
                    Text(industryLine(sector: sector, industry: info.industry))
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func industryLine(sector: String, industry: String?) -> String {
        guard let industry, !industry.isEmpty, industry != sector else { return sector }
        return "\(sector) · \(industry)"
    }
}

private struct SymbolInfoStatsCard: View {
    let info: SymbolQuoteInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Key Stats")
            AppMetricGrid {
                MetricTile(title: "Volume", value: AppFormat.number(info.volume))
                MetricTile(title: "P/E Ratio", value: AppFormat.peRatioDisplay(peRatio: info.peRatio, eps: info.eps))
                MetricTile(title: "EPS", value: AppFormat.money(info.eps))
                MetricTile(title: "Dividend Yield", value: AppFormat.percent(info.dividendYield))
                MetricTile(title: "Beta", value: AppFormat.number(info.beta))
                MetricTile(title: "52W High", value: AppFormat.money(info.fiftyTwoWeekHigh))
                MetricTile(title: "52W Low", value: AppFormat.money(info.fiftyTwoWeekLow))
            }
        }
    }
}

/// Only rendered when at least one field is present — an empty analyst/earnings card would
/// assert a negative ("no data") the on-demand fetch can't actually confirm.
private struct SymbolInfoAnalystCard: View {
    let info: SymbolQuoteInfo

    private var hasData: Bool {
        info.analystRating != nil || info.analystScore != nil
            || info.targetMean != nil || info.targetHigh != nil || info.targetLow != nil
            || info.daysToEarnings != nil
    }

    var body: some View {
        if hasData {
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeading("Analyst & Earnings")
                    if info.analystRating != nil || info.analystScore != nil {
                        LabeledContent("Rating", value: analystLine)
                    }
                    if info.targetMean != nil || info.targetLow != nil || info.targetHigh != nil {
                        LabeledContent("Price Target", value: targetLine)
                    }
                    if let daysToEarnings = info.daysToEarnings {
                        LabeledContent("Next Earnings", value: "In \(Int(daysToEarnings.rounded())) trading days")
                    }
                }
            }
        }
    }

    private var analystLine: String {
        let rating = info.analystRating?.isEmpty == false ? info.analystRating : nil
        let score = info.analystScore.map { "\(Int($0.rounded()))/100" }
        switch (rating, score) {
        case let (rating?, score?): return "\(rating) (\(score))"
        case let (rating?, nil): return rating
        case let (nil, score?): return score
        case (nil, nil): return "—"
        }
    }

    private var targetLine: String {
        if let mean = info.targetMean {
            if let low = info.targetLow, let high = info.targetHigh {
                return "\(AppFormat.money(mean)) (\(AppFormat.money(low))–\(AppFormat.money(high)))"
            }
            return AppFormat.money(mean)
        }
        if let low = info.targetLow, let high = info.targetHigh {
            return "\(AppFormat.money(low))–\(AppFormat.money(high))"
        }
        return "—"
    }
}
