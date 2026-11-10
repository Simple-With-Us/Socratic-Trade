import SwiftUI

struct MarketsView: View {
    @EnvironmentObject private var store: MobileStore
    @Binding var selectedTab: AppTab
    @Binding private var focusedSymbol: String?

    init(
        selectedTab: Binding<AppTab> = .constant(.markets),
        focusedSymbol: Binding<String?> = .constant(nil)
    ) {
        self._selectedTab = selectedTab
        self._focusedSymbol = focusedSymbol
    }
    @State private var ticker = ""
    @State private var presentedSymbol: PresentedSymbol?
    @State private var presentedItem: PresentedMarketItem?

    var body: some View {
        SnapshotScaffold(scrollTarget: focusedSymbol) { snapshot in
            ScanShortcutCard { selectedTab = .scan }
            PositionsSection(positions: snapshot.positions, presentedItem: $presentedItem)
            OrdersSection(
                orders: snapshot.orders,
                // The account this snapshot was taken from, sent with every cancel as the
                // server's stale-view guard (see OrderCancellation).
                accountNumber: snapshot.readiness.selectedAccountNumber,
                presentedSymbol: $presentedSymbol,
                focusedSymbol: focusedSymbol
            )
            WatchlistSection(
                ticker: $ticker,
                items: snapshot.watchlist,
                presentedSymbol: $presentedSymbol,
                focusedSymbol: focusedSymbol
            )
        }
        .onChange(of: focusedSymbol) { _, symbol in
            if let symbol {
                presentedSymbol = PresentedSymbol(symbol: symbol)
            }
        }
        .navigationTitle("Assets")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
        .sheet(item: $presentedItem) { item in
            SymbolInfoSheet(item: item)
        }
    }
}

private struct ScanShortcutCard: View {
    let openScan: () -> Void

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Scan Table", subtitle: "ranked names for the current universe")
                Text("Holdings stay here.  The interactive scan — score, price, and watchlist actions — is its own desk.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: openScan) {
                    Label("Open Scan", systemImage: "tablecells")
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

private struct PositionsSection: View {
    let positions: [Position]
    @Binding var presentedItem: PresentedMarketItem?

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Positions", subtitle: "Current broker holdings")
            if positions.isEmpty {
                EmptyStateCard(
                    title: "No Open Positions",
                    message: "Holdings from the selected broker account will appear here.",
                    systemImage: "square.stack.3d.up"
                )
            } else {
                ForEach(positions) { position in
                    PositionRow(position: position, presentedItem: $presentedItem)
                }
            }
        }
    }
}

private struct PositionRow: View {
    let position: Position
    @Binding var presentedItem: PresentedMarketItem?

    var body: some View {
        Button {
            presentedItem = .position(position)
        } label: {
            AppCard {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            TickerLogo(symbol: position.symbol, size: 26)
                            Text(position.symbol)
                                .font(.appHeadline)
                            if position.quantity < 0 {
                                StatusPill("Short", color: AppPalette.negative)
                            }
                        }
                        Text("\(AppFormat.number(abs(position.quantity))) shares")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                        if let sector = position.sector, !sector.isEmpty {
                            Text(sector)
                                .font(.appCaption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 5) {
                        Text(AppFormat.money(position.marketValue))
                            .font(.appHeadline)
                        Text("Avg \(AppFormat.money(position.averageCost))")
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 4)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(position.symbol) position")
        .accessibilityHint("Opens position and company details")
    }
}

private struct OrdersSection: View {
    let orders: [EquityOrder]
    let accountNumber: String?
    @Binding var presentedSymbol: PresentedSymbol?
    var focusedSymbol: String? = nil

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Orders", subtitle: "Open and Recent Broker Orders")
            if orders.isEmpty {
                EmptyStateCard(
                    title: "No Orders Reported",
                    message: "Broker orders for the selected account will appear here.",
                    systemImage: "doc.text.magnifyingglass"
                )
            } else {
                ForEach(orders) { order in
                    OrderRow(
                        order: order,
                        accountNumber: accountNumber,
                        presentedSymbol: $presentedSymbol
                    )
                    .id(order.symbol)
                    .overlay {
                        if focusedSymbol == order.symbol {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .stroke(AppPalette.accent, lineWidth: 2)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
        }
    }
}

private struct OrderRow: View {
    @EnvironmentObject private var store: MobileStore
    @State private var confirmingCancel = false

    let order: EquityOrder
    let accountNumber: String?
    @Binding var presentedSymbol: PresentedSymbol?

    private var operationID: String { OrderCancellation.operationID(orderId: order.id) }

    /// Cancel is offered exactly where the server would accept it (working states only) and on
    /// a deployment that advertises the command.  It is otherwise ungated: cancelling is
    /// risk-reducing, so it stays available while the strategy is stopped, matching the console.
    private var showsCancel: Bool {
        OrderCancellation.isCancellable(order) && store.serverAdvertises(OrderCancellation.commandType)
    }

    private var canCancel: Bool {
        !store.isBusy(operationID) && store.canSubmit(OrderCancellation.commandType)
    }

    private var statusColor: Color {
        switch order.state.lowercased() {
        case "filled": return AppPalette.positive
        case "cancelled", "canceled", "rejected", "failed": return AppPalette.negative
        default: return AppPalette.warning
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    SymbolTapButton(symbol: order.symbol, logoSize: 24) {
                        presentedSymbol = PresentedSymbol(symbol: order.symbol)
                    }
                    StatusPill(order.side.uppercased(), color: sideColor)
                    Spacer()
                    StatusPill(order.state.capitalized, color: statusColor)
                }
                HStack {
                    Text(orderDescription)
                        .font(.appSubheadline)
                    Spacer()
                    Text(AppFormat.dateTime(order.updatedAt ?? order.createdAt))
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
                if showsCancel {
                    HStack {
                        Spacer()
                        Button {
                            AppHaptics.warning()
                            confirmingCancel = true
                        } label: {
                            HStack(spacing: 7) {
                                if store.isBusy(operationID) {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "xmark.circle")
                                }
                                Text("Cancel Order")
                                    .fontWeight(.semibold)
                            }
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .disabled(!canCancel)
                        .accessibilityLabel("Cancel \(order.symbol) \(order.side.lowercased()) order")
                    }
                }
            }
        }
        // Same ceremony as the button: the swipe opens the existing confirmation dialog, never
        // firing the cancel directly.  Mirrors swipe-to-reject on proposals.
        .swipeRevealAction(
            title: "Cancel",
            systemImage: "xmark.circle",
            tint: AppPalette.negative,
            isEnabled: showsCancel && canCancel
        ) {
            AppHaptics.warning()
            confirmingCancel = true
        }
        .confirmationDialog(
            OrderCancellation.confirmationTitle(order),
            isPresented: $confirmingCancel,
            titleVisibility: .visible
        ) {
            Button("Cancel Order", role: .destructive, action: cancelOrder)
            Button("Keep It Working", role: .cancel) {}
        } message: {
            Text(OrderCancellation.confirmationMessage(order))
        }
    }

    private func cancelOrder() {
        AppHaptics.heavy()
        Task {
            await store.submit(
                OrderCancellation.commandType,
                payload: OrderCancellation.payload(orderId: order.id, accountNumber: accountNumber),
                operationID: operationID
            )
        }
    }

    private var sideColor: Color {
        order.side == "buy" || order.side == "cover" ? AppPalette.positive : AppPalette.negative
    }

    private var orderDescription: String {
        var values = [AppFormat.orderTypeLabel(order.type)]
        if let quantity = order.quantity { values.append("\(AppFormat.number(quantity)) shares") }
        if let filled = order.filledQuantity, filled > 0 { values.append("\(AppFormat.number(filled)) filled") }
        if let limit = order.limitPrice { values.append("@ \(AppFormat.money(limit))") }
        if let stop = order.stopPrice { values.append("stop \(AppFormat.money(stop))") }
        return values.joined(separator: " · ")
    }
}

private struct WatchlistSection: View {
    @EnvironmentObject private var store: MobileStore

    @Binding var ticker: String
    let items: [WatchlistItem]
    @Binding var presentedSymbol: PresentedSymbol?
    var focusedSymbol: String? = nil

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Watchlist")
            AppCard {
                VStack(spacing: 12) {
                    HStack {
                        TextField("Ticker", text: $ticker)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit(addTicker)
                        Button("Add", action: addTicker)
                            .buttonStyle(.borderedProminent)
                            .disabled(
                                normalizedTicker.isEmpty ||
                                store.isBusy(addOperationID) ||
                                !store.canSubmit("watchlist.add")
                            )
                    }

                    if items.isEmpty {
                        Text("No symbols watched yet.")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        FlowSymbols(items: items, presentedSymbol: $presentedSymbol, focusedSymbol: focusedSymbol)
                    }
                }
            }
        }
    }

    private var normalizedTicker: String {
        ticker.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private var addOperationID: String { "watchlist.add:\(normalizedTicker)" }

    private func addTicker() {
        let symbol = normalizedTicker
        guard !symbol.isEmpty else { return }
        ticker = ""
        Task {
            await store.submit(
                "watchlist.add",
                payload: ["symbol": symbol],
                operationID: "watchlist.add:\(symbol)"
            )
        }
    }
}

private struct FlowSymbols: View {
    let items: [WatchlistItem]
    @Binding var presentedSymbol: PresentedSymbol?
    var focusedSymbol: String? = nil

    var body: some View {
        // Content-sized wrap — do not use LazyVGrid(.adaptive(minimum: 92)).
        // That cell was narrower than logo + ticker + 44pt remove, so `SPCX`
        // and `XOM` wrapped mid-symbol.  Issue #2657.
        WrappingHStack(spacing: 8, lineSpacing: 8) {
            ForEach(items) { item in
                WatchlistChip(item: item, presentedSymbol: $presentedSymbol)
                    .id(item.symbol)
                    .overlay {
                        if focusedSymbol == item.symbol {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(AppPalette.accent, lineWidth: 2)
                                .allowsHitTesting(false)
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WatchlistChip: View {
    @EnvironmentObject private var store: MobileStore

    let item: WatchlistItem
    @Binding var presentedSymbol: PresentedSymbol?

    private var operationID: String { "watchlist.remove:\(item.symbol)" }

    var body: some View {
        // Two sibling buttons, not nested: tapping the logo/symbol opens
        // company info; tapping the trailing x removes the watch.  Both stay
        // real, separately labeled buttons for VoiceOver.
        HStack(spacing: 6) {
            Button {
                presentedSymbol = PresentedSymbol(symbol: item.symbol)
            } label: {
                HStack(spacing: 6) {
                    TickerLogo(symbol: item.symbol, size: 18)
                    Text(item.symbol)
                        .font(.appSubheadline.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.symbol) company info")

            Button {
                Task {
                    await store.submit(
                        "watchlist.remove",
                        payload: ["symbol": item.symbol],
                        operationID: operationID
                    )
                }
            } label: {
                Group {
                    if store.isBusy(operationID) {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                // Icon is ~17pt — below the 44pt HIG minimum.  A fixed 44×44
                // frame keeps the hit area without the old `.padding(14)`
                // fighting the chip's intrinsic width.
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(store.isBusy(operationID) || !store.canSubmit("watchlist.remove"))
            .accessibilityLabel("Remove \(item.symbol) from watchlist")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .background(AppPalette.accent.opacity(0.1), in: Capsule())
    }
}

