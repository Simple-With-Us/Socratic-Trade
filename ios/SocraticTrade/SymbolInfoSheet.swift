import Foundation
import SwiftUI
import UIKit

/// Company / fill / position detail sheet — the mobile counterpart to the web console's
/// symbol drilldown drawer (app/console/ui/symbol-drilldown.tsx). Presented from any row
/// that shows a symbol via `PresentedMarketItem` (fill and position cards tap anywhere;
/// logo-only rows still present `.company`). Fetches the same on-demand `/api/quote`
/// cascade the web drawer uses; every field degrades honestly to "—"/"n/a" instead of
/// being fabricated. Backend remains authoritative — this reads only.
struct SymbolInfoSheet: View {
    @Environment(MobileStore.self) private var store
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
    @State private var deskFailed = false
    @State private var showsAlertComposer = false

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
                    // Identity first: the symbol/quote header leads the sheet, ahead of
                    // the fill, position, and desk cards (pure reorder of the same card).
                    if case .loaded(let info) = loadState {
                        SymbolInfoHeaderCard(symbol: normalized, info: info)
                    }
                    // R2k (ST-4688): the three desk actions that start from a symbol —
                    // watch it, price-alert it, or ask Coach about it — live here instead of
                    // being scattered across Assets, Activity, and the Coach tab.
                    SymbolActionsCard(
                        symbol: normalized,
                        isWatched: isWatched,
                        watchBusy: store.isBusy(watchOperationID),
                        watchEnabled: store.canSubmit(isWatched ? "watchlist.remove" : "watchlist.add"),
                        setAlert: { showsAlertComposer = true },
                        toggleWatch: toggleWatch,
                        coachSeed: coachSeed
                    )
                    if deskFailed {
                        InlineErrorBanner(
                            message: "Desk details could not load",
                            retry: { Task { await loadDesk() } },
                            dismiss: { deskFailed = false }
                        )
                    }
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
                        SymbolInfoStatsCard(info: info)
                        SymbolInfoAnalystCard(info: info)
                        if let asOfLine {
                            Text(asOfLine)
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    // ST-4687: alerts come from the snapshot, not the on-demand quote, so the
                    // section renders in every load state.  See PriceAlertsView.swift.
                    PriceAlertsCard(symbol: normalized)
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
        // The sheet covers the shell that normally hosts transient notices, so it hosts the
        // same overlay itself — a Set Alert confirmation must be visible where the tap was.
        .storeTransientAlerts()
        .task { await load() }
        .sheet(isPresented: $showsAlertComposer) {
            PriceAlertComposer(
                symbol: normalized,
                referencePrice: referencePrice
            )
            .environment(store)
        }
    }

    /// Whether this symbol is on the watchlist, read off the current snapshot.  A symbol
    /// added from another surface is already "watched" here — the snapshot is the source.
    private var isWatched: Bool {
        store.snapshot?.watchlist.contains {
            $0.symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == normalized
        } ?? false
    }

    private var watchOperationID: String {
        "\(isWatched ? "watchlist.remove" : "watchlist.add"):\(normalized)"
    }

    /// Price the alert composer prefills: the loaded quote, else the watchlist's batched
    /// quote, else blank (the owner types one).  Never invented.
    private var referencePrice: Double? {
        if case .loaded(let info) = loadState, let price = info.price, price > 0 { return price }
        if let price = store.watchlistQuote(for: normalized)?.price, price > 0 { return price }
        return nil
    }

    private var coachSeed: String {
        "What should I know about \(normalized) right now?"
    }

    private func toggleWatch() {
        let command = isWatched ? "watchlist.remove" : "watchlist.add"
        Task {
            await store.submit(
                command,
                payload: ["symbol": normalized],
                operationID: watchOperationID
            )
        }
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
        if info.priceDelayLabel == "15-min delayed" {
            return "Prices are generally 15-min delayed."
        }
        return "Quote data from a live fetch (\(AppFormat.dateTimeCentral(info.asOf)))."
    }

    private func load() async {
        // Cancellation (sheet dismissed or a newer load supersedes) restores the
        // previously loaded quote/desk instead of leaving a permanent spinner.
        let previousLoadState = loadState
        let previousDesk = desk
        let previousDeskFailed = deskFailed
        loadState = .loading
        desk = nil
        deskFailed = false
        do {
            async let quoteTask = store.fetchSymbolQuote(normalized)
            async let deskTask = store.fetchSymbolDesk(normalized)
            let info = try await quoteTask
            loadState = .loaded(info)
            do {
                desk = try await deskTask
                deskFailed = false
            } catch {
                guard !Task.isCancelled, !isCancelledNetworkError(error) else {
                    // The quote above already landed, so restoring only the desk would pair
                    // a fresh quote with stale desk cards as if they were current. Restore
                    // the whole previous pair when there is one; on a first load keep the
                    // fresh quote with the desk absent but retryable (banner below).
                    if case .loaded = previousLoadState {
                        desk = previousDesk
                        deskFailed = previousDeskFailed
                        loadState = previousLoadState
                    } else if Task.isCancelled {
                        // No previous pair to restore (previousLoadState is .loading, so
                        // restoring it would resurrect a permanent spinner). The sheet is
                        // going away or a newer load owns the state now, so keep the fresh
                        // quote and leave the desk silently absent - cancellation is not
                        // a load failure and must not publish an error banner.
                        desk = nil
                        deskFailed = false
                    } else {
                        // Cancelled at the network layer while this task (and sheet) is
                        // still alive: keep the fresh quote, desk absent, but surface the
                        // retry banner so the desk is recoverable.
                        desk = nil
                        deskFailed = true
                    }
                    return
                }
                deskFailed = true
            }
        } catch is CancellationError {
            desk = previousDesk
            deskFailed = previousDeskFailed
            loadState = previousLoadState
        } catch {
            // MobileAPIClient's URLSession call wraps a mid-fetch cancellation as
            // MobileAPIError.network(URLError(.cancelled)) rather than rethrowing
            // CancellationError, so a sheet dismissed while the fetch is in flight would
            // otherwise flash a real error state for a fetch nobody is waiting on anymore.
            // Treat that case — and any lingering Task cancellation — as the same silent
            // no-op as the CancellationError branch above.
            guard !Task.isCancelled, !isCancelledNetworkError(error) else {
                desk = previousDesk
                deskFailed = previousDeskFailed
                loadState = previousLoadState
                return
            }
            loadState = .failed(error.localizedDescription)
        }
    }

    /// Retry for the desk cards only — the quote already loaded.
    private func loadDesk() async {
        do {
            desk = try await store.fetchSymbolDesk(normalized)
            deskFailed = false
        } catch {
            guard !Task.isCancelled, !isCancelledNetworkError(error) else { return }
            deskFailed = true
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

private struct SymbolActionsCard: View {
    let symbol: String
    let isWatched: Bool
    let watchBusy: Bool
    let watchEnabled: Bool
    let setAlert: () -> Void
    let toggleWatch: () -> Void
    let coachSeed: String

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Actions")
                // Three equal actions.  Labels stay under their icons so the row never has
                // to truncate the symbol sheet's most useful verbs on a 5.4-inch screen.
                HStack(alignment: .top, spacing: 10) {
                    watchButton
                    alertButton
                    NavigationLink {
                        CoachView(seedDraft: coachSeed)
                    } label: {
                        actionLabel(
                            title: "Ask Coach",
                            systemImage: "bubble.left.and.bubble.right",
                            tint: AppPalette.accent
                        )
                    }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Opens Coach with a \(symbol) question in the composer")
                }
            }
        }
    }

    private var watchButton: some View {
        Button(action: toggleWatch) {
            actionLabel(
                title: isWatched ? "Watching" : "Watch",
                systemImage: isWatched ? "star.fill" : "star",
                tint: isWatched ? AppPalette.warning : AppPalette.accent,
                isBusy: watchBusy
            )
        }
        .buttonStyle(.bordered)
        .disabled(watchBusy || !watchEnabled)
        .opacity(watchEnabled ? 1 : 0.5)
        .accessibilityLabel(isWatched ? "Remove \(symbol) from watchlist" : "Add \(symbol) to watchlist")
    }

    private var alertButton: some View {
        Button(action: setAlert) {
            actionLabel(title: "Set Alert", systemImage: "bell.badge", tint: AppPalette.accent)
        }
        .buttonStyle(.bordered)
        .accessibilityHint("Opens a price alert for \(symbol)")
    }

    private func actionLabel(
        title: String,
        systemImage: String,
        tint: Color,
        isBusy: Bool = false
    ) -> some View {
        VStack(spacing: 5) {
            Group {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .font(.appBody.weight(.semibold))
                }
            }
            .frame(height: 20)
            Text(title)
                .font(.appCaption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

/// Small pushed form for `alert.create`.  The server command already exists; this is the
/// phone's first entry point to it (the full alerts list stays on the website).
private struct PriceAlertComposer: View {
    @Environment(MobileStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let symbol: String
    let referencePrice: Double?

    @State private var draft: PriceAlertDraft
    @State private var isSubmitting = false
    @State private var submitError: String?

    init(symbol: String, referencePrice: Double?) {
        self.symbol = symbol
        self.referencePrice = referencePrice
        _draft = State(initialValue: PriceAlertDraft(
            symbol: symbol,
            direction: .above,
            priceText: referencePrice.map { AppFormat.money($0) } ?? "",
            note: ""
        ))
    }

    private var operationID: String {
        "alert.create:\(draft.normalizedSymbol):\(draft.direction.op):\(draft.priceText)"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Direction", selection: $draft.direction) {
                        ForEach(PriceAlertDraft.Direction.allCases) { direction in
                            Text(direction.title).tag(direction)
                        }
                    }
                    .pickerStyle(.segmented)

                    LabeledContent("Price") {
                        TextField("0.00", text: $draft.priceText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .disabled(isSubmitting)
                    }

                    TextField("Note (optional)", text: $draft.note, axis: .vertical)
                        .lineLimit(1...3)
                        .disabled(isSubmitting)
                } header: {
                    Text(symbol)
                } footer: {
                    if let message = draft.validationMessage {
                        Text(message)
                            .foregroundStyle(AppPalette.warning)
                    } else {
                        Text(draft.confirmationLine)
                    }
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            if isSubmitting { ProgressView().controlSize(.small) }
                            Text(isSubmitting ? "Saving…" : "Set Alert")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!draft.canSubmit || isSubmitting)
                } footer: {
                    if let submitError {
                        Text(submitError)
                            .foregroundStyle(AppPalette.negative)
                    } else {
                        Text("Checked against the live quote on the snapshot cadence; a triggered alert notifies this phone.")
                    }
                }
            }
            .navigationTitle("Price Alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
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

    private func submit() {
        guard let payload = draft.payload() else { return }
        isSubmitting = true
        submitError = nil
        Task {
            let created = await store.submit(
                "alert.create",
                payload: payload,
                operationID: operationID
            )
            isSubmitting = false
            guard created else {
                // The store's error alert/toast is presented by the root shell; this sheet
                // covers it, so repeat the reason here where the owner is looking.
                submitError = store.error ?? "The alert was not created."
                return
            }
            store.presentToast(AppToast(
                title: "Alert Set",
                message: draft.confirmationLine,
                tone: .success
            ))
            dismiss()
        }
    }
}

private struct FillDetailCard: View {
    let fill: FillEvent

    private var sideColor: Color {
        fill.isLongSide ? AppPalette.positive : AppPalette.negative
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
